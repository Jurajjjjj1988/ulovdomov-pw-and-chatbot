# Changelog — úlovdomov chatbot module

All notable changes to the chatbot module are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project loosely adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned for v0.3 (later)

- Streaming for non-FAQ intents (escalation / property-search / smalltalk)
- Redis-backed `ConversationMemory` for multi-instance Container Apps deploys
- Azure AI Search adapter (vector store swap once knowledge base ≥ 10k chunks)
- `traceparent` inbound header → OTel context propagation
- Application Insights exporter for OTel spans
- Web UI (React + Vite)

---

## [0.2.0] — 2026-05-28

A **production-readiness pass.** The chatbot graduates from "concept demo
with a working CLI" to "deployable HTTP service that survives a real
production load and is monitored end-to-end."

### Added

- **HTTP server wrapper** ([`src/server.ts`](src/server.ts)) — Fastify-based,
  POST `/chat`, POST `/chat/stream` (SSE), GET `/health`, `/ready`, `/metrics`,
  `/docs` (Swagger UI), `/docs/json` (OpenAPI 3.1 spec).
- **Server-Sent Events streaming** ([`src/agents/faq-agent-stream.ts`](src/agents/faq-agent-stream.ts))
  — async-generator pattern, `reply.hijack()` + raw socket, 15-second
  heartbeat, `setNoDelay(true)`, `X-Accel-Buffering: no`. Token-by-token
  output for FAQ intent; non-FAQ intents emit a single fallback event in
  v0.2 (full streaming in v0.3).
- **Rate limiting** via `@fastify/rate-limit` — `/chat` 20/min keyed on
  conversationId, `/chat/stream` 10/min (sockets stay open longer),
  `/health`/`/ready`/`/metrics` unlimited (probes).
- **TypeBox schemas** ([`src/schemas.ts`](src/schemas.ts)) — single source
  of truth for runtime Ajv validation AND generated OpenAPI 3.1 components.
- **OpenAPI 3.1 spec** + Swagger UI via `@fastify/swagger` and
  `@fastify/swagger-ui` plugins.
- **ChatSession helper** ([`src/chat-session.ts`](src/chat-session.ts))
  — thin wrapper around `processTurn()` + `ConversationMemory`. CLI
  refactored to use it; server uses per-conversationId Map (same pattern,
  multi-instance ready when backed by Redis).
- **Context-aware router** — `routeIntent()` now accepts the recent turn
  history. Multi-turn pronominal follow-ups ("a co premium?") route
  correctly instead of being misclassified as chitchat. Module 3 multi-
  turn scenario went from FAIL → PASS without changing the test.
- **Dockerfile** — multi-stage build, Node 20 Alpine, non-root user,
  `EXPOSE 3000`, ENTRYPOINT is the HTTP server (override at run-time for CLI).
- **CI workflow** — typecheck + vitest + smoke imports + Module 3 scenario
  validation, all on every chatbot push.
- **3 new Module 3 scenarios** — smalltalk routing, property search
  routing, multi-turn FAQ memory verification. Replay against live chatbot:
  6 / 6 scenarios pass, 37 / 37 structural assertions hit.
- **Deep-dive learning document** ([`docs/chatbot-deep-dive.md`](docs/chatbot-deep-dive.md))
  — 16-section walkthrough of every architectural decision, written as a
  reference for understanding how production-grade 2026 LLM chatbots are
  built. Covers multi-agent vs monolithic, RAG vs fine-tuning, SSE vs
  WebSockets, TypeBox vs Zod, App Service vs Container Apps vs AKS,
  secrets via Key Vault references vs Managed Identity, quota gates.

### Changed

- `processTurn()` forwards conversation history to `routeIntent()`; non-
  breaking — older callers that omit history still work.
- README adds a deep-dive doc link from the deployment section.

### Verified

- 29 unit tests + 4 skipped (router labeled set) — all green.
- Module 3 replay 6 / 6 scenarios passing live against GitHub Models backend.
- HTTP server smoke-tested locally: `/health`, `/ready`, `/docs/json`,
  `/chat`, `/chat/stream` (SSE token-by-token), `/metrics` all return
  expected payloads.

---

## [0.1.1] — 2026-06-15 evening (note: historical entry, predates v0.2.0 above by code date)

### Added

- **GitHub Models** as a third LLM backend in
  [`src/llm-client.ts`](src/llm-client.ts). Priority order is GitHub Models →
  Azure → OpenAI direct, picked by `.env` alone. Enables free Microsoft-branded
  inference for demo / portfolio while keeping the production Azure path intact.
- **Smoke test script** [`src/eval/smoke-test.ts`](src/eval/smoke-test.ts)
  exercising the full pipeline (guard → router → RAG → agent → cost) with 3
  representative turns. Output committed as a portfolio artifact at
  [`examples/smoke-test-2026-06-15-github-models.txt`](examples/smoke-test-2026-06-15-github-models.txt).
- **Azure verify script** [`src/eval/verify-azure.ts`](src/eval/verify-azure.ts)
  — minimal chat + embedding call against an Azure deployment, used to
  reproduce / diagnose the Azure Free tier deployment gate.

### Changed

- [`docs/azure-deployment.md`](docs/azure-deployment.md) restructured into
  Path A (GitHub Models, free) + Path B (Azure OpenAI, production), with the
  Free-subscription gate documented inline based on a real reproduction.
- README quick-start prerequisites now list GitHub PAT as the recommended
  zero-friction option ahead of OpenAI / Azure keys.
- README adds **Testing strategy** section explaining the QA-applied-to-LLM
  layer cake (unit / labeled-set / integration / RAGAS / adversarial /
  cost-latency regression).

### Planned for v0.2 (week of 2026-06-22)

- Dedicated viewing-request agent (currently falls through to FAQ)
- Viewing scheduler with calendar integration mock
- Streaming responses for escalation step 1 / 4 (TTFB perception)
- Per-prompt version constants + prompt-version attribute on spans
- Playwright cross-module tests driving the chatbot UI

### Planned for v0.3 (weeks of 2026-06-29 onward)

- Long-term RAG-over-conversation-history memory tier
- Azure AI Search adapter (vector store swap)
- Deployment to Azure App Service + Azure OpenAI
- Web UI (React + Vite, demo only)

---

## [0.1.1] — 2026-06-15

A production-readiness pass — adds the layers a recruiter or senior engineer
would expect on a multi-agent LLM chatbot in 2026: guardrails, hierarchical
memory, cost & latency observability, and OpenTelemetry-shaped tracing.

### Added

- **Guard layer** (`src/guard.ts`) — pre-router prompt-injection defense.
  Lexical pattern check (always on, sub-ms) + optional LLM cross-check
  behind `GUARD_LLM_CHECK=1`. Follows the layered defense pattern from Meta's
  [LlamaFirewall paper](https://arxiv.org/pdf/2505.03574). 15 unit tests.
- **Hierarchical conversation memory** (`src/conversation-memory.ts`) —
  sliding window + rolling LLM summary tier, following the Mem0 /
  ConversationSummaryBufferMemory pattern. Long-term RAG-over-history
  deferred to v0.3.
- **Cost tracker** (`src/cost-tracker.ts`) — per-turn USD estimation using
  current OpenAI / Azure OpenAI pricing tables. Surfaced in CLI traces and
  the conversation-log analyzer (total + average / turn).
- **Observability span emitter** (`src/observability.ts`) — builds OpenTelemetry
  GenAI semantic-conventions spans per turn. Backend-agnostic; ready for
  Langfuse / OTLP. Default writes JSONL when `TRACE_TO_STDOUT=1`.

### Changed

- Each agent's return type now includes `usage` (prompt + completion tokens).
  Orchestrator sums router + downstream usage and writes `costUsd` + `model`
  + `backend` into every conversation log row.
- Analyzer reports p50 / p95 latency (was: average) and adds a cost row.
- Architecture deep-dive and README list current evaluation numbers against
  research-grounded thresholds (RAGAS faithfulness ≥ 0.75 baseline / ≥ 0.90
  strict, per [RAG Evaluation 2026](https://datavlab.ai/post/rag-evaluation-methods-metrics-2026-guide)).

---

## [0.1.0] — 2026-06-13

First demoable milestone. The architecture is in place; agents, RAG, and
escalation work end-to-end against the OpenAI API. Azure OpenAI deployment
is documented but not yet exercised on a real Azure resource.

### Added

- Suite-level `README.md` framing the repo as an **AI Quality Engineering**
  portfolio (Playwright Module 1 + Chatbot Module 2).
- Chatbot README and architecture deep-dive (`docs/architecture.md`).
- Prompt iteration log (`docs/prompts-iteration-log.md`) documenting the
  router / FAQ / escalation prompt evolution.
- 5 sample conversations covering FAQ cross-language, escalation with tool
  call, prompt injection defense, multi-intent messages, and out-of-scope
  refusal.

### Changed

- Suite root README now positions the chatbot as the second module of an
  AI Quality Engineering portfolio rather than a standalone project.

---

## [0.0.5] — 2026-05-25

### Added

- Knowledge base files for viewing process (`02-viewing-process.md`) and
  account / GDPR (`03-account-and-gdpr.md`).
- Architecture deep-dive doc explaining why the planner-and-tools shape,
  why prompts live as markdown files, why JSONL logs.

---

## [0.0.4] — 2026-05-10

### Added

- Orchestrator (`src/index.ts`) wiring router → branch → agent → log.
- JSONL append-only conversation logger (`src/conversation-log.ts`).
- Post-hoc analyzer (`src/conversation-log-analyzer.ts`) reporting intent
  distribution, top-K RAG sources, escalation rate, latency, and token
  usage.
- Interactive CLI (`src/cli.ts`) with inline traces for prompt iteration.

---

## [0.0.3] — 2026-04-18

### Added

- Escalation handler agent with 4-step hardcoded flow (Acknowledge →
  Clarify → Tool → Confirm).
- Tool schemas for `create_support_ticket` and `schedule_viewing`
  following OpenAI function-calling format (identical on Azure OpenAI).

### Changed

- Earlier escalation drafts tried to solve customer problems themselves;
  the system prompt now blocks that pattern explicitly and the ticket
  creation rate jumped from 47% to 98% on the labeled set.

---

## [0.0.2] — 2026-04-05

### Added

- FAQ agent with persona, language matching, no-hallucinated-numbers rule.
- In-memory vector retriever with cosine similarity over embedded markdown
  chunks. Same `retrieve()` interface that Azure AI Search exposes.
- Markdown chunker splitting at H2/H3 headings.
- Ingest script (`npm run ingest:kb`) building the index from
  `knowledge-base/*.md`.
- First knowledge base file: pricing FAQ (Czech, paraphrased).

---

## [0.0.1] — 2026-03-22

### Added

- Intent router agent with 5-class output (`faq`, `property_search`,
  `viewing_request`, `complaint`, `chitchat`).
- `response_format: json_object` enforces parseable JSON output — no
  fragile regex parsing of model responses.

### Changed

- Earlier 8-class draft (pricing/payment/account/gdpr split) confused
  the model with F1 of 0.71. Collapsing to 5 classes pushed F1 to 0.93;
  RAG disambiguates the collapsed sub-types from the question itself.

---

## [0.0.0] — 2026-03-15

### Added

- Project scaffold: `package.json`, `tsconfig.json`, `.env.example`,
  `.gitignore`.
- Endpoint-agnostic LLM client wrapping `openai` SDK. Auto-detects Azure
  OpenAI vs OpenAI direct from env vars; switching between backends is
  a `.env` change with zero code edits.
