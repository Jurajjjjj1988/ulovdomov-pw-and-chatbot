# úlovdomov · Playwright tests + AI chatbot

> End-to-end **Quality Engineering** stack for the Czech real-estate
> platform [úlovdomov.cz](https://www.ulovdomov.cz) — production Playwright
> test automation **and** a multi-agent AI customer-support chatbot
> for the same platform.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-E2E-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![OpenAI](https://img.shields.io/badge/OpenAI%20SDK-4.x-412991?logo=openai&logoColor=white)](https://github.com/openai/openai-node)
[![Azure OpenAI](https://img.shields.io/badge/Azure%20OpenAI-ready-0078D4?logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/azure/ai-services/openai/)
[![Docker](https://img.shields.io/badge/Docker-image-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-deploy-326CE5?logo=kubernetes&logoColor=white)](https://kubernetes.io/)

---

## What this repo is

This is a **dual-module portfolio piece** that demonstrates full-stack
quality engineering for a single real-world platform:

### Module 1 — Playwright E2E test suite (`./` root + `tests/`)

A production-style end-to-end test framework for úlovdomov.cz:

- **Page Object Model** (POM) with strict TypeScript
- **Fixtures** for parametrised setup (auth, locale, network mocks)
- **Docker** image (slim, chromium-only) ready for CI runners
- **Kubernetes Job** manifest for cluster-scheduled regression runs
- **Slack** notification hook on CI failures

Details in [`tests/README.md`](tests/README.md).

### Module 2 — AI customer-support chatbot (`chatbot/`)

A concept multi-agent LLM chatbot for the same platform:

- **Intent router** (gpt-4o-mini, JSON-forced output, 5-class classifier)
- **FAQ agent** with **RAG** retrieval over a Czech/Slovak knowledge base
- **Escalation handler** with **tool calling** (mock backend ticket system)
- **Conversation logger** + post-hoc analyzer (RAGAS-style faithfulness)
- **Azure OpenAI deployment-ready** (one-line config switch)

Details in [`chatbot/README.md`](chatbot/README.md).

---

## Why both in one repo

The job title **AI Quality Engineer** sits at the intersection of two
historically separate disciplines:

| Discipline | This repo's contribution |
|---|---|
| **Software QE** | Playwright suite — automated regression of úlovdomov.cz |
| **AI engineering** | Multi-agent chatbot with RAG and tool calling |
| **AI testing** | Conversation log analyzer + planned Playwright tests of the chatbot's UI |

In 2026, **testing AI systems** is a fast-growing niche — and the natural
home for an engineer who's done both production test automation and LLM
agent development. This repo is built to show all three sides at once.

---

## Architecture

```mermaid
flowchart LR
    subgraph SUT["úlovdomov.cz · system under test"]
        Web[Web app]
        API[Backend API]
    end

    subgraph M1["Module 1 · Playwright E2E"]
        PW[Playwright tests]
        POM[Page Objects]
        Fix[Fixtures]
        PW --> POM
        PW --> Fix
    end

    subgraph M2["Module 2 · AI Chatbot"]
        Router[Intent Router]
        FAQ[FAQ Agent + RAG]
        Esc[Escalation Handler]
        Logger[Conversation Logger]
        Router --> FAQ
        Router --> Esc
        FAQ --> Logger
        Esc --> Logger
    end

    subgraph CI["CI/CD"]
        GHA[GitHub Actions]
        Docker[Docker image]
        K8s[Kubernetes Job]
    end

    POM --> Web
    Fix --> API
    PW -.->|future v0.2| FAQ
    PW -.->|future v0.2| Esc
    GHA --> Docker
    Docker --> K8s
    K8s --> PW

    style SUT fill:#fff7ed,stroke:#fb923c
    style M1 fill:#eff6ff,stroke:#3b82f6
    style M2 fill:#f0fdf4,stroke:#22c55e
    style CI fill:#fef3c7,stroke:#f59e0b
```

The dashed lines show the planned **cross-module integration**: Playwright
tests will also validate the chatbot's UI behavior (intent classification
accuracy from end-user perspective, escalation flow correctness, RAG
groundedness via UI assertions). This is the "AI testing" piece of the
AI Quality Engineer story.

---

## Repository structure

```
ulovdomov-qe-suite/
├── README.md                            ← you are here (suite overview)
│
├── Module 1 — Playwright E2E
│   ├── tests/                           ← E2E test specs
│   │   └── README.md                    ← testing module docs
│   ├── pages/                           ← Page Object Model
│   ├── fixtures/                        ← test fixtures
│   ├── helpers/                         ← shared utilities
│   ├── data/                            ← test data
│   ├── docs/                            ← architecture, theory
│   ├── playwright.config.ts             ← Playwright config
│   ├── Dockerfile                       ← slim chromium-only CI image
│   ├── job.yaml                         ← Kubernetes Job manifest
│   ├── package.json
│   └── tsconfig.json
│
└── Module 2 — AI Chatbot
    └── chatbot/                         ← all chatbot code under here
        ├── README.md                    ← chatbot module docs
        ├── .env.example
        ├── package.json                 ← chatbot has its own deps
        ├── tsconfig.json
        ├── src/
        │   ├── llm-client.ts            ← endpoint-agnostic OpenAI client
        │   ├── prompts/                 ← system prompts (markdown)
        │   ├── agents/                  ← intent router, FAQ, escalation
        │   ├── rag/                     ← retrieval-augmented generation
        │   ├── tools/                   ← LLM-callable mock backend tools
        │   ├── conversation-log.ts      ← JSONL append-only logger
        │   └── conversation-log-analyzer.ts
        ├── knowledge-base/              ← Czech/Slovak RAG sources
        ├── docs/
        │   ├── architecture.md
        │   ├── prompts-iteration-log.md
        │   └── azure-deployment.md
        └── examples/
            └── sample-conversations.md
```

The two modules have **separate `package.json` / `node_modules`** to keep
their dependency trees independent — the Playwright suite doesn't pull
in the OpenAI SDK, and the chatbot doesn't pull in Playwright. They share
nothing at the JS level; the shared artifact is the **domain knowledge**
about úlovdomov.cz captured in tests, page objects, and the chatbot's
knowledge base.

---

## Quick links

| Resource | Where |
|---|---|
| **Testing module setup** | [`tests/README.md`](tests/README.md) |
| **Chatbot module setup** | [`chatbot/README.md`](chatbot/README.md) |
| **Chatbot architecture** | [`chatbot/docs/architecture.md`](chatbot/docs/architecture.md) |
| **Prompt iteration log** | [`chatbot/docs/prompts-iteration-log.md`](chatbot/docs/prompts-iteration-log.md) |
| **Sample conversations** | [`chatbot/examples/sample-conversations.md`](chatbot/examples/sample-conversations.md) |
| **Playwright config** | [`playwright.config.ts`](playwright.config.ts) |
| **CI/CD K8s manifest** | [`job.yaml`](job.yaml) |

---

## Tech stack (combined)

| Layer | Tech |
|---|---|
| Language | TypeScript 5.7 (strict mode, both modules) |
| Test runner | Playwright + chromium |
| LLM SDK | `openai` (compatible with both OpenAI and Azure OpenAI) |
| Vector store | In-memory (production: Azure AI Search) |
| Containerisation | Docker (slim chromium image) |
| Orchestration | Kubernetes Jobs |
| Linting | ESLint flat config |
| Notifications | Slack webhook (CI failures) |

---

## License & disclaimer

MIT — see [LICENSE](LICENSE).

This is a **portfolio project**. Not affiliated with úlovdomov.cz or its
operator. All trademarks belong to their respective owners. Test selectors,
test data, and chatbot knowledge base reflect **publicly available** info
from the live site for educational/demonstration purposes.

Built by **[Juraj Kapusansky](https://github.com/Jurajjjjj1988)** —
AI Quality Engineer · Bratislava, Slovakia.
