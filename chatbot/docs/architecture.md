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

## What's not implemented (yet)

- **Long-term conversation memory** — current implementation passes the last
  N turns directly. Real production wants embedding-based memory + summary.
- **Guard / input filter agent** — currently the router does soft guarding by
  routing hostile inputs to `complaint`. A dedicated guard agent (running
  before the router) would catch prompt injection attempts more aggressively.
- **Cost tracking** — every LLM call returns token usage in the response. We
  log it but don't aggregate or alarm yet.
- **Property search** — stubbed, would query a mock listings API. Listed in
  roadmap for v0.2.

These are deliberate v0.1 omissions, not gaps. The architecture is the
priority for this stage.
