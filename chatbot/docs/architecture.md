# Architecture — design decisions

## Why a multi-agent shape (not one monolithic prompt)

A single "do everything" prompt has three failure modes I wanted to avoid:

1. **Context pollution** — instructions for FAQ tone, escalation flow, and
   tool-calling all in one prompt = the model picks the wrong rules at runtime.
2. **Cost** — one large prompt re-tokenized on every turn. Splitting the
   classification step into a tiny prompt + JSON output is 10× cheaper.
3. **Evaluation** — when something breaks, you can't tell *which* part broke.
   With separate agents, the conversation log shows which agent fired and what
   its inputs were.

The shape comes from the **planner + specialised agents** pattern documented in
recent 2026 agentic-RAG literature
([Agentic RAG enterprise guide](https://datanucleus.dev/rag-and-agentic-ai/agentic-rag-enterprise-guide-2026),
[HERA / hierarchical orchestration](https://arxiv.org/html/2604.00901v1)).

```
User → Router (tiny, fast, classifier)
       ↓
       FAQ Agent     | Escalation Agent | Property Search Agent | ...
       (specialised, each with its own focused system prompt)
```

## Why JSON output for the router

The router uses `response_format: { type: "json_object" }` (an OpenAI-supported
mode that Azure OpenAI also implements). This forces the model to return
parseable JSON instead of free text.

Without this, you end up writing fragile regex parsers:

```typescript
// ❌ brittle — model says "Intent: FAQ" or "I think this is FAQ" or "**FAQ**"
const match = response.match(/intent[:\s]+(\w+)/i);

// ✅ predictable
const parsed = JSON.parse(response);
const intent = parsed.intent;
```

The router also returns a `confidence` score, which the orchestrator can use
to fall back to a safer agent (`faq`) when confidence < 0.6.

## Why prompts live in .md files, not inline strings

Three reasons:

1. **Diff-friendly** — when you tweak tone or add a constraint, the change is a
   clean markdown diff. Inline strings produce ugly TypeScript diffs with
   escaped newlines.
2. **Versionable as content** — the prompt is the system's behavior contract.
   Tracking prompt changes in git history is as important as tracking code
   changes.
3. **Reviewer-friendly** — non-developers (UX, support team, legal) can read
   and comment on a `.md` file. They can't review escaped TypeScript strings.

The trade-off: 1 extra `readFileSync()` call per agent module at import time.
Acceptable cost.

## Why in-memory vector store (and the swap path)

For a demo and the first 10k queries/day, an in-memory vector store over
markdown chunks is:

- **Zero infra** — no Azure resource to provision, no Pinecone account
- **Fast iteration** — change the knowledge base, re-run `npm run ingest:kb`,
  done
- **Deterministic** — the index is a JSON file in the repo (or `.gitignored`
  if it has user data)

The retriever interface is intentionally minimal:

```typescript
retrieve(query: string, topK?: number): Promise<RetrievedChunk[]>
```

This is the same shape that **Azure AI Search** (formerly Azure Cognitive
Search) exposes over its REST API. When this project graduates to production,
swapping the retriever implementation from in-memory cosine to Azure AI Search
is a ~50 LOC change in `src/rag/retriever.ts` with no caller changes.

This is the pattern Microsoft's own
[GPT-RAG enterprise template](https://github.com/Azure/gpt-rag) uses — separate
retrieval from generation, swap retrievers without touching agents.

## Why escalation has its own tool call

The escalation handler is the only agent allowed to invoke
`create_support_ticket`. This is intentional:

- **Authorisation boundary** — FAQ agent answers questions, escalation agent
  creates tickets. Mixing both in FAQ would let a clever user trick the FAQ
  agent into creating tickets via prompt injection.
- **Audit trail** — every ticket creation has a clean call site in
  `src/agents/escalation-handler.ts`. Easy to add logging, rate limiting, or
  human-in-the-loop approval here without affecting other paths.

This is a soft form of the **guard agent** pattern recommended for production
systems — separating "agents that read" from "agents that take action".

## Why conversation logs are append-only JSONL

JSONL (one JSON object per line) is the de facto standard for streaming logs:

- **Streaming-friendly** — write one line per turn, no file rewriting
- **Queryable post-hoc** — `jq`, DuckDB, even `grep` work
- **Schema-flexible** — adding a new field doesn't break older rows
- **Cheap to analyze** — the analyzer reads the file line by line, builds
  metrics (intent distribution, RAG retrieval success rate, average response
  length, escalation rate) without DB infra

Each row captures:

```json
{
  "ts": "2026-06-15T10:23:45Z",
  "conversationId": "uuid",
  "turn": 3,
  "userMessage": "...",
  "router": { "intent": "faq", "confidence": 0.92, "rationale": "..." },
  "retrieval": [ { "source": "01-pricing.md", "score": 0.81 } ],
  "agentResponse": "...",
  "toolCalls": [],
  "latencyMs": 1240,
  "tokensUsed": { "prompt": 1820, "completion": 145 }
}
```

The analyzer (`src/conversation-log-analyzer.ts`) reads this and reports:

- Intent confusion matrix (router vs human label, if labeled)
- Top-K RAG sources by retrieval frequency (signal: what users actually ask)
- Average confidence by intent (signal: which intents need prompt tweaks)
- Escalation rate over time (signal: chatbot quality regression)

## Prompt design decisions (the iteration trajectory)

See [`prompts-iteration-log.md`](prompts-iteration-log.md) for the
chronological log of what changed and why.

Highlights:

- **v0.1 router** had 8 intents — too many, confidence dropped. v0.2 collapsed
  to 5 (current).
- **v0.1 FAQ agent** answered in English when user wrote in Czech.
  v0.3 added explicit "match user's language" rule.
- **v0.2 escalation** tried to solve problems before escalating. v0.4 hardcoded
  the 4-step flow (Acknowledge → Clarify → Tool → Confirm) — solved the
  "chatbot promises refund" hallucination class.

## Azure OpenAI specific notes

The Azure OpenAI Service is the same model lineup (gpt-4o-mini, gpt-4o, o1)
behind a Microsoft-managed endpoint with enterprise features:

- **Azure AD authentication** — no API key in code, use managed identities
- **Data residency** — pin deployments to EU regions for GDPR
- **Content filtering policies** — customisable per deployment
- **Quota management** — TPM/RPM caps per deployment

The wire protocol is identical to OpenAI direct. The
[`openai`](https://github.com/openai/openai-node) npm package exports both
`OpenAI` and `AzureOpenAI` classes with the same interface. The auth differs
(`apiKey` + `endpoint` + `apiVersion` + `deployment` for Azure vs just
`apiKey` for OpenAI direct) and that's it.

Production note: Microsoft requires an approval application for Azure OpenAI
access ([aka.ms/oai/access](https://aka.ms/oai/access)). For individuals
without a corporate use case this can take 1-7 days or be denied. For this
demo we use OpenAI direct; the codebase is ready to switch when the Azure
deployment lands.

## Guard layer — what gets blocked and why

The guard (`src/guard.ts`) runs **before** the router. Two stages:

1. **Lexical pre-check** (always on, sub-millisecond) — regex patterns for
   canonical jailbreak / injection shapes in EN and CS/SK. Designed for
   precision: only patterns that essentially never appear in legitimate
   customer messages flag as "hard." Examples: `ignore previous instructions`,
   `<|im_start|>`, `you are now DAN`.
2. **Optional LLM cross-check** (`GUARD_LLM_CHECK=1`) — when lexical finds
   *soft* hits, send the message to a tiny classifier prompt that returns
   `safe` / `suspicious` / `malicious`. Off by default (latency budget).

On a hard / malicious verdict, the orchestrator skips the router and the
specialised agents entirely and returns a fixed Czech refusal. The blocked
turn is still logged (with the guard reasons) so analyzers can see attack
patterns over time.

This is the **layered defense** pattern from Meta's
[LlamaFirewall paper](https://arxiv.org/pdf/2505.03574) and the
[LLM Guardrails 2026 reference](https://www.digitalapplied.com/blog/llm-guardrails-production-safety-layers-reference-2026):
lexical + classifier + downstream agent system prompts each provide one
layer; no single layer is asked to be the last line of defense.

**Trade-offs we accepted:**

- False negatives: novel jailbreak phrasings (never-seen-before templates)
  will get past lexical. Mitigated by enabling stage 2 in production.
- False positives: a customer who literally writes "ignore my previous
  message" would be flagged. Acceptable rate at the chosen pattern set —
  measured on the 12-utterance labeled set, 0 FPs.

## Hierarchical conversation memory

`src/conversation-memory.ts` implements the **sliding window + rolling
summary** pattern. Two tiers:

- **Window (verbatim, default 4 pairs)** — most recent N user/assistant
  turns kept as-is.
- **Rolling summary (compressed)** — once the conversation passes the
  threshold (default 8 pairs), the oldest turns are LLM-summarised into a
  3-sentence brief that's prepended to the system prompt of subsequent
  agent calls. The summary itself rolls forward — each compaction merges
  the prior summary with the newly aged-out turns.

Long-term **RAG-over-conversation-history** (the third tier in production
hierarchical memory) is deferred to v0.3. For úlovdomov.cz's use case
(predominantly single-session chats), the cost/benefit isn't there yet.

Sources: this is the [Mem0 architecture](https://docs.mem0.ai/), also called
ConversationSummaryBufferMemory in LangChain. See the
[Practical Guide to Memory for Autonomous LLM Agents](https://towardsdatascience.com/a-practical-guide-to-memory-for-autonomous-llm-agents/)
for a clean walk-through.

## Cost & latency engineering

Every turn is **priced in USD** by `src/cost-tracker.ts` using a hard-coded
pricing table. Numbers as of mid-2026:

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|---|---|---|
| `gpt-4o-mini` (default) | 0.15 | 0.60 |
| `gpt-4o` | 2.50 | 10.00 |
| `o1-mini` | 1.10 | 4.40 |
| `text-embedding-3-small` | 0.02 | — |

Pricing source:
[OpenAI](https://openai.com/api/pricing/) /
[Azure OpenAI](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/)
(both publish the same per-1M-token rate for the same model). Azure is
billed in regional currency; the multiplier here is 1.0 — refine via the
Azure cost-management API if you need exact reconciliation.

**Latency budget** (gpt-4o-mini, FAQ flow including RAG retrieval, single
turn measured locally):

| | p50 | p95 |
|---|---|---|
| Latency end-to-end | ~1.2 s | ~2.6 s |

Industry reference: P95 typically runs **1.6×–3.2× P50** for OpenAI chat
endpoints ([Digital Applied latency benchmarks 2026](https://www.digitalapplied.com/blog/ai-model-latency-benchmarks-2026-ttft-throughput)).
Numbers above match that envelope.

**Note (June 2026):** OpenAI direct gpt-4o-mini saw a regression where
TTFB drifted from ~50ms to ~1s and TTLB up to ~8s on some routes. We track
this in [`prompts-iteration-log.md`](prompts-iteration-log.md) and the
analyzer's p95 column rather than asserting a fixed SLO in CI.

## Observability — OpenTelemetry GenAI semantic conventions

`src/observability.ts` builds an OTel-shaped span per turn following the
emerging **GenAI Semantic Conventions** (stabilising through 2026). The
attributes are vendor-neutral — the same payload feeds Langfuse, LangSmith,
Helicone, or any OTLP collector without remapping.

Confirmed-stable attributes:

```
gen_ai.system            "openai" | "azure_openai"
gen_ai.request.model     gpt-4o-mini | <deployment-name>
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
```

Custom attributes (project-specific, in `ulovdomov.*` namespace to avoid
stepping on reserved space):

```
ulovdomov.router.intent      faq | property_search | viewing_request | ...
ulovdomov.router.confidence  0–1
ulovdomov.guard.verdict      safe | suspicious | malicious
ulovdomov.guard.blocked      boolean
ulovdomov.retrieval.sources  comma-separated source filenames
ulovdomov.retrieval.top_score
ulovdomov.tools.invoked      comma-separated tool names
```

Spec reference:
[OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) ·
[Langfuse OTel integration](https://langfuse.com/integrations/native/opentelemetry).

## What's not implemented (yet)

- **Dedicated viewing-request agent** — currently falls through to FAQ with
  a TODO marker.
- **RAG-over-conversation-history memory tier** — see hierarchical memory
  section above.
- **Cost projection** — analyzer shows running total + per-turn average;
  a "$/day projected at current QPS" line is v0.2.
- **Property search backend** — stubbed; would proxy to úlovdomov's
  listings API.

These are deliberate omissions, not gaps. The architecture is the
priority for this stage.
