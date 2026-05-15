# Changelog — úlovdomov chatbot module

All notable changes to the chatbot module are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project loosely adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
