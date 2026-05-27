# Chatbot Deep Dive — building a production-grade LLM chatbot for Azure

> A learning document. Walks through every layer of this chatbot in the order
> a real LLM application is built: starting from "user types a message, what
> happens?", ending with "Container Apps, Azure OpenAI, OTel, billing." Each
> section answers *what*, *where in the code*, and most importantly *why*
> that decision over the alternatives.
>
> If you're new to LLM application engineering, read top to bottom. If you
> already know the basics, the **Why** subsections are where the actual
> engineering judgment lives.

---

## Table of contents

1. [The mental model — what a chatbot actually is in 2026](#1-the-mental-model)
2. [Anatomy of a single turn](#2-anatomy-of-a-single-turn)
3. [Multi-agent orchestration — why split](#3-multi-agent-orchestration)
4. [Intent router — the cheap classifier](#4-intent-router)
5. [Guard layer — defense in depth](#5-guard-layer)
6. [RAG — answers grounded in documents](#6-rag)
7. [Prompts as first-class artifacts](#7-prompts-as-first-class-artifacts)
8. [Memory — what the bot remembers](#8-memory)
9. [Cost & observability](#9-cost--observability)
10. [HTTP server design](#10-http-server-design)
11. [Streaming with SSE](#11-streaming-with-sse)
12. [OpenAPI 3.1 — schemas drive everything](#12-openapi-31)
13. [Multi-backend LLM client (OpenAI / Azure / GitHub Models)](#13-multi-backend)
14. [Deploying on Azure](#14-deploying-on-azure)
15. [Testing — the SDET discipline applied to LLM](#15-testing)
16. [Production checklist](#16-production-checklist)

---

## 1. The mental model

A 2026 chatbot is not "one big prompt." It's a **pipeline of small,
specialised LLM calls with deterministic glue around them**:

```
user message
     │
     ▼
[ guard ]       cheap, deterministic — "is this even a real customer message?"
     │
     ▼
[ router ]      tiny LLM call — "which agent handles this?"
     │
     ├──► [ faq agent + RAG ]            knowledge questions
     ├──► [ escalation agent + tool ]    complaints → support ticket
     ├──► [ property search + tool ]     search query → mock backend
     ├──► [ smalltalk ]                  greetings / off-topic
     └──► [ viewing — falls through to FAQ for now ]
     │
     ▼
[ memory.append ]   so next turn has context
     │
     ▼
[ log + OTel span ]   so you can debug and bill
     │
     ▼
response to user
```

Why this shape and not "one giant prompt that does everything"?

- **Context pollution.** A single prompt that tries to handle FAQs *and*
  escalations *and* tool calls juggles too many rules. The model picks the
  wrong rule at runtime.
- **Cost.** Routing is cheap (~300 tokens in, ~50 tokens out). Generating an
  answer is expensive (~2 000 tokens in, ~200 tokens out). Putting them in
  one call means you pay the answer-cost even when the user said "Hello."
- **Evaluation.** When something breaks ("the chatbot promised a refund it
  shouldn't have"), you need to know *which* component failed. With one
  monolithic prompt, the answer is always "the prompt." With separate
  agents, you see exactly which step produced the bad output.

That's the shape this codebase implements. Now let's walk through it.

---

## 2. Anatomy of a single turn

The entry point is [`src/index.ts`](../src/index.ts) — the `processTurn()`
function. It takes a `{userMessage, conversationId, turn, history}` and
returns `{response, intent, record}`. Everything else hangs off this.

Here's the actual sequence inside one call:

| Step | File | Token cost | Latency |
|---|---|---|---|
| Guard pre-check (lexical) | [`src/guard.ts`](../src/guard.ts) | 0 | ~1 ms |
| Router classify | [`src/agents/intent-router.ts`](../src/agents/intent-router.ts) | ~250 in / ~30 out | ~700 ms |
| RAG retrieve (if FAQ) | [`src/rag/retriever.ts`](../src/rag/retriever.ts) | ~30 (embedding) | ~300 ms |
| Agent generate response | various `src/agents/*` | ~2 000 in / ~200 out | ~1.5 s |
| Memory append | [`src/conversation-memory.ts`](../src/conversation-memory.ts) | 0 | <1 ms |
| Log + OTel span | [`src/conversation-log.ts`](../src/conversation-log.ts), [`src/observability.ts`](../src/observability.ts) | 0 | <1 ms |

Total: ~3 seconds, ~2 300 tokens, ~$0.0005 per turn at gpt-4o-mini rates.

The key insight: **most of the cost and latency is in the final agent call.**
Everything before it (guard, router, RAG) exists to make sure the right agent
gets the right context — so the expensive call doesn't waste tokens producing
the wrong answer.

---

## 3. Multi-agent orchestration

This project has **5 agents** plus the router. The router is itself a tiny
agent. Each specialised agent has one job:

| Agent | File | Job |
|---|---|---|
| Intent Router | `agents/intent-router.ts` | Classify the message into 1 of 5 intents |
| FAQ | `agents/faq-agent.ts` | Answer knowledge questions using retrieved RAG context |
| Escalation | `agents/escalation-handler.ts` | Acknowledge → clarify → create support ticket → confirm |
| Property Search | `agents/property-search-agent.ts` | Translate "I want 3+kk in Praha" to a search call |
| Smalltalk | `agents/smalltalk-agent.ts` | Handle greetings / off-topic, redirect to scope |

**Why 5 and not 8 or 3?**

We started with 8 (pricing / payment / account / GDPR / search / viewing /
complaint / chitchat) — see [`docs/prompts-iteration-log.md`](prompts-iteration-log.md)
v0.1 router. Router F1 was 0.71. Too many categories — the model couldn't
distinguish pricing from payment.

Collapsed to 5 (faq / property_search / viewing_request / complaint / chitchat).
Reasoning: **what the router can't distinguish, the downstream RAG can.** A
"pricing" question and a "GDPR" question both go to FAQ — the FAQ agent runs
RAG, and RAG retrieves the right knowledge-base chunk based on the question
itself. Router F1 jumped to 0.93.

3 would be too few — you'd lose the *complaint vs question* boundary, and
the escalation flow would never fire.

**Why does each agent have its own prompt?**

Each agent's `.md` system prompt encodes one set of rules:
- FAQ: "match the user's language, cite sources, never invent numbers"
- Escalation: "acknowledge → clarify → tool → confirm; never promise compensation"
- Smalltalk: "stay short, redirect to úlovdomov scope"

Mixing them dilutes each. The router's job is just to pick which set of
rules to invoke.

---

## 4. Intent router

The router is the most-evaluated component in the system because it gates
everything downstream. If it misroutes, the wrong agent runs.

**Why `response_format: { type: "json_object" }`?**

The router's job is to return `{ intent, confidence, rationale }`. Without
the JSON-mode constraint, the model might return *"I think this is faq."* or
*"Intent: FAQ"* or `"**FAQ**"`. Each requires a different parser; each fails
differently on edge cases.

With JSON mode forced, the model is constrained to emit valid JSON. We
still validate (in [`src/agents/intent-router.ts`](../src/agents/intent-router.ts))
that the `intent` field is one of the 5 valid values — if the model
hallucinates a sixth, we fall back to `faq` (the most common, lowest-risk
default).

**Why temperature 0?**

Classification is a deterministic task. Temperature > 0 is for creative
generation. For routing you want the same input → the same intent, every
time. T=0 doesn't *guarantee* that (the underlying model is still
stochastic), but it minimises variance.

**Why a 15-utterance labeled test set?**

See [`src/agents/intent-router.test.ts`](../src/agents/intent-router.test.ts).
It's a regression gate: if a prompt change drops F1 below 0.85, the change
is blocked. 15 utterances is enough to catch obvious regressions and small
enough that the test runs in ~10 seconds and costs ~$0.0001.

For production you'd grow this to 500+ over time as real conversations come
in. The pattern is what matters: **every prompt change runs against a
labeled set with a threshold gate.**

---

## 5. Guard layer

The guard runs *before* the router. Code in [`src/guard.ts`](../src/guard.ts).

**Why bother — doesn't the router catch hostile input by routing it to
complaint?**

Two reasons:

1. **Speed and cost.** Lexical pattern checks are free and sub-millisecond.
   If someone pastes the DAN jailbreak template, we don't need to spend
   $0.0001 + 700 ms on a router call to figure it out. We block at the
   lexical layer and emit a fixed refusal.
2. **Defense in depth.** This is the layered-defense pattern from Meta's
   [LlamaFirewall paper](https://arxiv.org/pdf/2505.03574) (May 2025).
   Single-layer safety always fails eventually — novel jailbreaks find one
   weakness. Multiple layers each catch a different class of attack.

**Two stages:**

1. **Lexical** (always on, always free). Regex for:
   - "Ignore previous instructions" / Slovak "Ignoruj predchádzajúce inštrukcie"
   - Role-override ("You are now DAN")
   - System-prompt extraction attempts
   - Credential extraction ("show me the admin password")
   - ChatML delimiter abuse (`<|im_start|>`)
   - Prompt-leak ("repeat everything above")

2. **LLM cross-check** (gated by `GUARD_LLM_CHECK=1`). Only runs when the
   lexical layer flags a *soft* hit (something suspicious but not a hard
   match). Asks a tiny LLM call to classify `safe` / `suspicious` /
   `malicious`. Adds ~$0.0001 + 300 ms but catches novel phrasings.

**Why this pattern over a dedicated guardrails library (NeMo Guardrails,
Lakera, Llama Guard)?**

For a portfolio / mid-size production app:
- NeMo is feature-rich but heavyweight and itself marked beta as of 2026.
- Lakera is excellent but a paid SaaS — adds an API hop and a vendor.
- Llama Guard 3 is great but requires hosting an additional model.

The lexical layer here is high-precision (designed for ~0% false positives
on the labeled test set), and the optional LLM stage uses the *same* LLM
the chatbot already calls. Zero new infrastructure, zero new dependencies.

For a large enterprise with strict compliance needs, you'd swap in Llama
Guard 3 or Lakera. The `runGuard()` interface stays the same; only the
implementation behind it changes.

**Tradeoff documented:** lexical patterns will miss novel jailbreak
phrasings. That's why this is *one layer*, not the only line of defense.
The router's system prompt also explicitly forbids breaking scope, and
each downstream agent's prompt has its own guardrails.

---

## 6. RAG

RAG = **R**etrieval **A**ugmented **G**eneration. The pattern:

1. Pre-compute embeddings (vectors) for every chunk of your knowledge base.
2. At query time, embed the user's question.
3. Find the K closest chunks (cosine similarity).
4. Append them to the system prompt as "here's the relevant knowledge."
5. The LLM generates an answer grounded in those chunks.

This codebase: [`src/rag/`](../src/rag/) — `ingest.ts` (build the index),
`knowledge-base.ts` (chunk the markdown at H2/H3 headings), `retriever.ts`
(cosine search at query time).

**Why RAG over fine-tuning?**

Fine-tuning bakes knowledge into the model weights at training time. For:
- Static, slow-changing knowledge (e.g. "how to fold proteins") — fine-tuning
  works.
- Dynamic knowledge that changes daily (pricing, GDPR rules, available
  apartments) — fine-tuning is wrong. You'd have to retrain on every change.

For úlovdomov.cz's domain, the pricing changes, the GDPR rules update, new
financing programs appear. RAG handles all of this without ever retraining
— you just edit the markdown in `knowledge-base/`.

**Why RAG over "just put everything in the prompt"?**

You *can* if your knowledge base is small (~1 000 tokens). But:
- It blows up the prompt cost on every request, even for questions the
  knowledge isn't relevant to.
- It pushes you toward the context-window limit (and into the
  context-degradation zone — see NVIDIA's RULER benchmark; models degrade
  noticeably past ~50% of their stated context limit).
- It defeats per-question observability — you don't know which chunk
  actually drove the answer.

RAG retrieves only the relevant 3-5 chunks per question. Top score
predictive of answer quality. Much cheaper, much more debuggable.

**Why in-memory cosine + JSON instead of Azure AI Search or Pinecone?**

For this size (51 chunks total): in-memory cosine over 1 024-dim vectors is
~5 ms. Adding Azure AI Search is more infra to manage, more secrets to
configure, more failure modes. **YAGNI** until you cross ~10 000 chunks.

The `retrieve()` interface in [`src/rag/retriever.ts`](../src/rag/retriever.ts)
is intentionally minimal — same signature as Azure AI Search's REST API.
When you cross 10 000 chunks, swap the implementation; nothing else
changes. The graduation path is in [`docs/azure-deployment.md`](azure-deployment.md).

**Why chunk at H2/H3 markdown headings?**

Headings are the human author's *semantic* boundaries. A chunk that ends
mid-paragraph confuses retrieval (you'd retrieve half a thought). A chunk
that's one whole H2 section is a coherent answer to a coherent question.

Fixed-size chunking (e.g. 500 tokens) is the alternative — easier to
implement but always slices through ideas at random points.

**Why Czech / Slovak embeddings? Wouldn't English ones work?**

OpenAI's `text-embedding-3-small` is English-centric. Cross-language
cosine still works (the model learned cross-language semantics) but
performance is lower for non-English content.

For a real production deployment serving Czech customers, you'd switch to
**Cohere embed v3 multilingual** (1 024 dim, trained on 100+ languages
including CS/SK). The model is available via Azure Foundry. We documented
this swap in [`docs/azure-deployment.md`](azure-deployment.md).

The retriever interface is unchanged — only the model name in `.env` flips.

---

## 7. Prompts as first-class artifacts

Every agent's system prompt is a `.md` file under
[`src/prompts/`](../src/prompts/). The agent reads it at boot.

**Why not inline strings?**

Three reasons:

1. **Diff-friendly.** When you change a tone or add a constraint, you get a
   clean markdown diff. Inline strings produce ugly TypeScript diffs full
   of escaped newlines.
2. **Versionable as content.** The prompt is the system's behaviour
   contract. Tracking prompt changes in git history is as important as
   tracking code changes. See [`docs/prompts-iteration-log.md`](prompts-iteration-log.md)
   — the iteration trajectory with measured F1 / faithfulness deltas per
   version.
3. **Reviewable by non-developers.** UX writers, support team leads, legal
   reviewers can read and comment on a markdown file. They can't review
   escaped TypeScript strings.

**Cost: one `readFileSync()` at module load. Acceptable.**

---

## 8. Memory

LLMs are stateless. Every API call is independent. To make the chatbot
"remember" what was said earlier in the conversation, *you* have to include
the prior turns in the next request's `messages` array.

This codebase: [`src/conversation-memory.ts`](../src/conversation-memory.ts)
+ [`src/chat-session.ts`](../src/chat-session.ts).

**The hierarchical pattern:**

1. **Sliding window** — keep the last N turn-pairs verbatim. Default 4.
2. **Rolling summary** — when the conversation crosses 8 pairs, summarise
   the oldest ones into a compressed "context brief" that prepends to the
   system prompt. Refresh as the conversation grows.

**Why hierarchical instead of pure sliding window?**

A pure window has no memory beyond N turns — past content is silently
forgotten. A pure full-history blows up token cost linearly with
conversation length.

Hierarchical is the production-standard 2026 pattern (Mem0, LangChain
ConversationSummaryBufferMemory, Letta MemGPT). Recent detail kept
verbatim; old detail compressed but not lost.

**Why deferred wiring until v0.2?**

`processTurn()` originally took `history` directly. That's fine for short
conversations and lets the caller (CLI, tests) control memory however they
want. We added `ChatSession` (in v0.2) as a wrapper that owns memory and
makes the common case (interactive chat) one-line.

`processTurn` signature didn't change. Backwards-compatible. The two
patterns coexist.

**Production caveat:** the per-conversation Map in
[`src/server.ts`](../src/server.ts) is in-memory. Multi-instance deploys
(2+ pods on Container Apps) need a shared store — Redis (fastest),
Cosmos DB (managed). The `ConversationMemory` interface stays the same;
only the persistence backend changes.

---

## 9. Cost & observability

If you don't measure it, you can't bill for it, can't budget it, can't
optimise it. Every LLM call returns token usage in the response body. We
plumb that through and compute USD per turn.

**Files**:
- [`src/cost-tracker.ts`](../src/cost-tracker.ts) — pricing table (gpt-4o-mini, gpt-4o, Cohere embed, Mistral, etc.) and `estimateChatCostUsd()`.
- [`src/conversation-log.ts`](../src/conversation-log.ts) — JSONL append-only persistence per turn.
- [`src/conversation-log-analyzer.ts`](../src/conversation-log-analyzer.ts) — post-hoc aggregator (intent distribution, p50/p95 latency, total cost).
- [`src/observability.ts`](../src/observability.ts) — OpenTelemetry GenAI semantic-conventions span emitter.

**Why JSONL?**

One JSON object per line. Streaming-friendly (write one line per turn, no
file rewriting), `jq`-able, DuckDB-queryable, grep-friendly. Schema-flexible
(adding a new field doesn't break old rows).

**Why OpenTelemetry GenAI?**

OTel is the vendor-neutral standard for distributed tracing. The GenAI
semantic conventions (stabilising through 2026) add LLM-specific attributes:

```
gen_ai.system               "openai" | "azure_openai"
gen_ai.request.model        gpt-4o-mini | <deployment>
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
gen_ai.response.cost_usd
```

The same payload feeds **Langfuse, LangSmith, Helicone, Phoenix, Datadog,
Application Insights** — no per-vendor remapping. When you ship to Azure,
you point the OTel SDK at the Azure Monitor exporter; nothing else changes.

The custom `ulovdomov.*` attributes (router intent, guard verdict,
retrieval source) ride in the same span. OTel's spec reserves `gen_ai.*`
for the GenAI standard, so we use a custom namespace for project-specific
attributes.

---

## 10. HTTP server design

[`src/server.ts`](../src/server.ts) — Fastify-based.

**Why Fastify over Express?**

- Fastify is **~2× faster** for the same workload (a real benchmark, not a
  microbenchmark).
- Built-in pino structured logging out of the box. Every request gets a
  JSON log line with `reqId`, `responseTime`, `statusCode`. No setup.
- Native schema-based validation via Ajv. No `joi` or `express-validator`
  bolt-on.
- First-class TypeScript types via type providers.
- Stable plugin lifecycle that schema-first works cleanly with.

Express is fine; it just has more boilerplate to reach the same place.

**Endpoints:**

| Path | What |
|---|---|
| `POST /chat` | Single turn; per-conversation memory |
| `POST /chat/stream` | Same, streaming via SSE |
| `GET /health` | Liveness probe (LLM client resolves) |
| `GET /ready` | Readiness probe (RAG index + backend configured) |
| `GET /metrics` | Aggregate over the conversation log |
| `GET /docs` | Swagger UI |
| `GET /docs/json` | OpenAPI 3.1 spec |

**Why health AND ready?**

Health = "the process is alive." Used by Kubernetes / Container Apps liveness
probes — if this fails, the orchestrator restarts the pod.

Ready = "the process can serve traffic." Different concern. If RAG index
isn't loaded yet, or LLM credentials aren't configured, returning 503
from /ready takes the pod out of rotation without restarting it. This is
the standard k8s pattern.

**Why `trustProxy: true`?**

Azure App Service / Container Apps terminate TLS at the front door. The
upstream client IP comes in `X-Forwarded-For`. Without `trustProxy`,
Fastify thinks every request comes from the load balancer IP — rate
limiting by IP would lump all users into one bucket.

---

## 11. Streaming with SSE

The non-streaming `/chat` returns the full response in one HTTP response
body. Total latency = guard + router + RAG + agent generation + memory
write = ~3 seconds. User stares at a spinner.

The streaming `/chat/stream` emits **Server-Sent Events** — guard, router,
RAG events first, then token-by-token deltas as the LLM produces them, then
a final `done` event with usage and cost. User starts seeing characters
within ~700 ms.

**Why SSE over WebSockets?**

SSE is server-to-client only, over plain HTTP, with `text/event-stream`
content type. WebSockets is bidirectional and a different protocol.

For chatbot output streaming, we only need server-to-client. SSE wins:
- Works with HTTP/2 multiplexing (free with Azure Front Door).
- Reconnects automatically via the `Last-Event-ID` header (browsers
  re-establish if the socket drops).
- Plays nicely with corporate proxies that strip WebSocket handshakes.
- Simpler client code (`new EventSource(url)` vs the full WebSocket
  lifecycle).

WebSockets would only win if we also wanted client-to-server streaming
(e.g. for voice / push-to-talk), which we don't.

**Why `reply.hijack()` over `@fastify/sse-v2`?**

The plugin wraps `eventsource-encoder` with sensible defaults. For one
streaming endpoint the extra dependency isn't worth it. We hijack the
raw socket once and own the SSE encoding directly — fewer abstractions
in the path means easier debugging.

**Why a 15-second heartbeat?**

Azure App Service times idle TCP connections out at **240 seconds**.
Intermediate proxies (nginx default, Azure Front Door) often time out at
**60 seconds**. A streaming response that takes 90 seconds (a long FAQ
answer) would silently die.

We write `: ping\n\n` (an SSE comment — no event fires, no client code
runs) every 15 seconds. Keeps every layer awake. Cost: 8 bytes per
heartbeat.

**Why `setNoDelay(true)` + `X-Accel-Buffering: no`?**

- **Nagle's algorithm** (on by default) buffers small writes. SSE token
  events are small. Without `setNoDelay`, the OS coalesces a few tokens
  into one packet and the user sees bursts every 200 ms instead of
  smooth typing.
- **`X-Accel-Buffering: no`** tells nginx and Azure Front Door not to
  buffer the response. Without it, the front door waits for ~8 KB
  before flushing — the user sees nothing for the first 5 seconds, then
  a wall of text.

**Why a tighter rate limit on `/chat/stream`?**

A streaming socket holds a TCP connection open for the response duration
(~5-15 seconds). If you allow 20 streams/min/user, that's potentially 20
concurrent open sockets per user. Cap at 10/min to keep the connection
pool sane.

**Where the per-token cost gets tracked:**

OpenAI's streaming API normally doesn't return `usage` (you used to have
to estimate). With `stream_options: { include_usage: true }`, the final
chunk arrives with `choices: []` and a populated `usage` block. We
capture that, run it through `cost-tracker.ts`, and emit it in the
`done` event.

---

## 12. OpenAPI 3.1

[`src/schemas.ts`](../src/schemas.ts) — TypeBox schemas. The Fastify
route options reference them in `{ schema: { body, response, tags,
summary } }`. The `@fastify/swagger` plugin generates the OpenAPI 3.1
spec; `@fastify/swagger-ui` serves the Swagger UI at `/docs`.

**Why TypeBox over Zod, Joi, manual JSON Schema?**

- **TypeBox** compiles to JSON Schema directly. Ajv (Fastify's validator)
  consumes JSON Schema natively. Zero runtime conversion cost.
- **Zod** is great for transformation pipelines but needs a converter
  plugin (`fastify-type-provider-zod`) to become JSON Schema.
- **Joi** is no longer maintained in step with JSON Schema 2020-12.
- **Manual JSON Schema** is tedious and you lose TypeScript inference.

TypeBox gives you a single source of truth for runtime validation, types,
and docs. Change a schema once, everything updates.

**Why `additionalProperties: false`?**

Default JSON Schema allows extra properties through silently. With `false`,
Ajv rejects unknown fields at the boundary. This catches client bugs
(typo'd field name, deprecated field) at the API surface, not deep inside
the orchestrator.

Future-proofs the API against drift: if you add a field on the client side
but forget to update the schema, the request fails fast.

**SSE in OpenAPI — the awkward bit:**

OpenAPI 3.1 has no native SSE support. We document `POST /chat/stream`
with `content: { "text/event-stream": { schema: {type: "string"} } }` and
a long `description` listing event types. Honest but tooling won't render
it well.

OpenAPI 3.2 (released early 2026) adds first-class SSE via `itemSchema`.
When `@fastify/swagger` adds 3.2 emission, we'll upgrade.

---

## 13. Multi-backend LLM client

[`src/llm-client.ts`](../src/llm-client.ts).

**Three backends:**

1. **GitHub Models** — Microsoft's free gateway to Azure AI. PAT auth.
   OpenAI-compatible endpoint at `https://models.inference.ai.azure.com`.
   Rate-limited (~15 req/min on the free tier) but free. Perfect for demo.

2. **Azure OpenAI Service** — production target. Same wire protocol as
   OpenAI direct, different base URL + api-version query. Different auth
   (endpoint + key + deployment names).

3. **OpenAI direct** — fallback. Standard `apiKey`.

The client detects which to use from environment variables. **Zero code
changes** to switch between them; you change `.env` and restart.

**Why this matters for production:**

You develop locally against OpenAI direct (cheapest for a single dev).
You demo against GitHub Models (free, no quota approval).
You ship to production on Azure OpenAI (compliance, data residency, EU
region pinning, BYOK, content filtering).

The codebase doesn't know or care. The contract is `OpenAI`-compatible
methods; both `AzureOpenAI` and `OpenAI` classes from the npm `openai`
SDK satisfy it.

**Why detect-by-env-var pattern over a flag?**

It's harder to misconfigure. If you set `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_API_KEY`, *and* `AZURE_OPENAI_CHAT_DEPLOYMENT`, you clearly
mean to use Azure. If you only set `OPENAI_API_KEY`, you clearly mean
direct. A flag would let you set Azure env vars but forget to flip the
flag, and you'd silently use the wrong backend.

---

## 14. Deploying on Azure

The chatbot ships as a container. The `Dockerfile` in `chatbot/` produces
a slim Node 20 Alpine image (~150 MB) with the non-root `chatbot` user
running `tsx src/server.ts` as the entrypoint.

**Three Azure targets, ordered by complexity:**

### A. Azure App Service for Linux Containers (simplest)

- Push the image to Azure Container Registry.
- Create an App Service plan (Linux, B1 minimum for non-trivial work).
- Point the App Service at the ACR image.
- Set environment variables in App Service Configuration:
  - `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`,
    `AZURE_OPENAI_CHAT_DEPLOYMENT`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`
  - `PORT=3000`
- Bind a custom domain + managed TLS cert.
- Done.

**When to use:** small-to-mid traffic (<100 concurrent users), need TLS
+ auto-scale + zero infra management.

### B. Azure Container Apps (modern microservices)

- Same image, deployed as a Container App.
- Scale-to-zero supported (cheaper for spiky workloads).
- KEDA scaling on HTTP request count, custom metrics, queue length, etc.
- Native Dapr integration if you grow into a microservices mesh.

**When to use:** spiky traffic, want to pay only when used, planning to
add more microservices around the chatbot.

### C. Azure Kubernetes Service (AKS)

- Full control. Standard k8s `Deployment` + `Service` + `Ingress` +
  optional Istio.
- Pair with Azure Managed Redis for shared `ConversationMemory` across
  pods.
- Pair with Azure AI Search for the RAG index when knowledge base
  crosses ~10 k chunks.

**When to use:** existing k8s infrastructure, complex multi-service
deployment, advanced traffic management needs.

For this chatbot's scale, **App Service** is fine. Container Apps if you
want scale-to-zero economics. AKS only if you're already running it.

### Secrets management

Don't put API keys in App Service Configuration directly in plaintext —
that's auditable but mutable by anyone with App Service permissions. Use:

- **Azure Key Vault** + Key Vault references in App Service Configuration.
  Format: `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)`
- Or **Managed Identity** + `DefaultAzureCredential` in the app code —
  no secret in the container at all. The Container App has a system-
  assigned identity that's RBAC-granted access to specific Key Vault
  secrets.

The second pattern is the 2026 best practice. We document the change in
[`docs/azure-deployment.md`](azure-deployment.md).

### Quota and approval

Azure OpenAI access (as of mid-2026) is **gated for individual
subscriptions**. Free-tier subscriptions explicitly cannot deploy
Azure OpenAI or Marketplace models — a documented hard gate. Upgrade
to Pay-As-You-Go before submitting the access request.

Approval is typically 1-7 working days for enterprise applications;
longer for individual / portfolio applications. Plan accordingly.

---

## 15. Testing

[`src/`](../src/) has Vitest unit tests, [`src/eval/`](../src/eval/) has
integration evaluation scripts, [`chatbot-tests/`](../../chatbot-tests/)
(Module 3 in the repo) has SDET-discipline blackbox tests.

| Layer | What it tests | Cost / run |
|---|---|---|
| Unit (guard / memory / observability / cost / ChatSession) | Deterministic logic | $0 |
| Labeled-set | Router intent accuracy | ~$0.001 |
| Integration smoke | Full pipeline | ~$0.001 |
| RAGAS faithfulness | Answer groundedness | ~$0.005 / 10 turns |
| Module 3 replay | Golden-transcript regression with structural assertions | ~$0.001 / scenario |

**Why a separate Module 3 instead of more tests inside `chatbot/`?**

Inside `chatbot/`, the tests have whitebox access — they import internals,
mock parts, assert on private state. That's appropriate for unit tests.

Module 3 is **blackbox**. It only knows the public `processTurn()` API.
If we refactor agents, the unit tests change but Module 3 stays the
same. This separation mirrors the dev/SDET split in mature LLM teams.

**Why JSON scenarios + a runner instead of Vitest's `it()` blocks?**

Scenarios are *data*. A future product manager can add a new scenario
by writing a JSON file — no TypeScript knowledge required. The runner
codifies the assertion semantics once; scenarios scale linearly.

This is the same pattern that productive testing teams use for
data-driven regression suites (Playwright's `test.describe.parallel` with
`for ... of` patterns, Cypress's fixtures).

---

## 16. Production checklist

Things that aren't done in this codebase and what'd be needed to ship to
real production traffic at úlovdomov.cz scale (estimated ~500 chats/day):

| Item | Status | Priority |
|---|---|---|
| Multi-backend LLM client | ✅ Done | — |
| Guard layer (lexical + LLM cross-check) | ✅ Done | — |
| Hierarchical memory | ✅ Done | — |
| Cost tracking per turn | ✅ Done | — |
| OTel GenAI spans | ✅ Done | — |
| HTTP server + health/ready/metrics | ✅ Done | — |
| Rate limiting | ✅ Done | — |
| OpenAPI 3.1 + Swagger UI | ✅ Done | — |
| SSE streaming for FAQ | ✅ Done | — |
| Dockerfile | ✅ Done | — |
| Module 3 SDET QA suite | ✅ Done | — |
| Per-instance scale-out via Redis-backed memory | ❌ | Required for ≥2 pods |
| Azure AI Search backend (>10k chunks) | ❌ | When KB grows |
| `traceparent` header propagation | ❌ | Optional |
| AsyncLocalStorage request-context | ❌ | Optional |
| Streaming for non-FAQ intents | ❌ | v0.3 |
| API key auth middleware | ❌ | Required for public deploy |
| Bicep / Terraform IaC | ❌ | Required for reproducible deploy |
| Application Insights integration | ❌ | Trivial — OTel exporter swap |
| Custom domain + TLS | ❌ | Azure-side config |
| Backup / restore strategy for conversation logs | ❌ | Per-org compliance |
| GDPR data retention policy | ❌ | Per-org compliance |
| Penetration test report | ❌ | Per-org compliance |

The first three items in the "❌" rows are the operational gap to fill if
you ship this to production. The rest are organisational compliance
work that doesn't change the code.

---

## Closing thought

Building an LLM chatbot in 2026 is **mostly engineering, not prompting**.
You spend 80% of your time on:

- Picking the right architecture (multi-agent vs single prompt)
- Wiring observability so you can debug
- Guarding against the long tail of abuse
- Keeping the cost spreadsheet honest
- Making it deploy somewhere real

The 20% that's prompt engineering is high-leverage — a 1-line prompt
change can move F1 from 0.71 to 0.93 — but the prompt only matters if
the rest of the system is sound. A great prompt in a broken pipeline
produces no value.

Use this codebase as a reference. Read each file in the order the docs
listed above mention them. Run the smoke test, run the Module 3 replay,
hit `/docs` in a browser, watch the SSE events come back.

The patterns generalise to *any* domain. Real estate happens to be ours.
