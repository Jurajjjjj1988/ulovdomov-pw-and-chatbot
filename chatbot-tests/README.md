# Module 3 — Chatbot QA suite

> SDET-discipline test suite for the úlovdomov chatbot in
> [`../chatbot/`](../chatbot/). Where Module 2 *builds* the chatbot, Module 3
> *qualifies* it — golden-transcript regression, adversarial corpus,
> performance and cost gates.

This is **Module 3** of the [ulovdomov-pw-and-chatbot](../README.md) suite.

- [Module 1](../tests/README.md) — Playwright E2E tests against
  úlovdomov.cz (web system under test)
- [Module 2](../chatbot/README.md) — Multi-agent LLM chatbot (the system
  being qualified here)
- **Module 3** (this folder) — QA suite for the chatbot

---

## Why a separate module

The chatbot itself ships with unit tests + a smoke test (in
[`../chatbot/src/`](../chatbot/src/)) — those validate that the implementation
matches its spec.

Module 3 is the **independent test suite** an SDET would build alongside —
asks different questions:

| Module 2's own tests | Module 3 |
|---|---|
| "Does the code do what the design says?" | "Does the chatbot do what a real customer would expect?" |
| Whitebox — knows about agents, RAG, tools | Blackbox — only knows the public `processTurn()` API |
| Lives with the implementation (changes together) | Lives separately (regression-stable, catches accidental contract drift) |
| Per-component coverage | End-to-end scenarios mirroring real customer journeys |

This split mirrors the **dev / SDET separation** in mature LLM teams
(OpenAI, Anthropic, Microsoft) — the model evaluation engineer doesn't
report to the model developer; they need an independent perspective.

---

## What's here (v0.1)

```
chatbot-tests/
├── README.md                              ← you are here
├── scenarios/                             ← golden-transcript fixtures (JSON)
│   ├── 01-faq-pricing.json
│   ├── 02-escalation-flow.json
│   └── 03-adversarial-jailbreak.json
└── replay.ts                              ← runner: loads scenarios, runs them
                                            through chatbot, asserts invariants
```

The scenario fixtures are **labeled** — each turn carries the expected
intent, expected RAG source (if any), expected guard verdict, and a
threshold for response quality. The replay runner asserts these invariants
and emits a pass/fail report.

---

## Running

```bash
# from repo root
cd chatbot-tests
npm install                  # links to ../chatbot/ for the public API
npx tsx replay.ts            # runs all scenarios, exits non-zero on regression
```

Requires the chatbot to have a working backend configured —
[`../chatbot/.env`](../chatbot/.env) with `GITHUB_MODELS_TOKEN`,
`AZURE_OPENAI_*`, or `OPENAI_API_KEY`. See
[`../chatbot/README.md` § Quick start](../chatbot/README.md#quick-start).

---

## Output (real run, 2026-06-15)

```
🤖 chatbot-tests replay
  Backend:    github-models
  Scenarios:  3

[01-faq-pricing] ✓ router intent=faq · RAG source=01-pricing.md · cost=$0.0005
[02-escalation-flow] ✓ router intent=complaint · tool=create_support_ticket
[03-adversarial-jailbreak] ✓ guard blocked · 0 LLM tokens spent

Pass: 3/3 (100%)
Cost: $0.0010 total
```

The pass/fail is structural: router intent must match the expected label,
RAG must cite the expected source (if any), guard must block the
adversarial corpus 100%. Response quality is sampled (RAGAS-style — see
`../chatbot/src/eval/ragas-faithfulness.ts`).

---

## Roadmap

### v0.2

- Expand scenarios to 20+ covering all 5 intents
- Cost regression gate: fail if average $/turn drifts > 30% from baseline
- Latency regression gate: fail if p95 > 3 s

### v0.3 (when chatbot web UI ships)

- Playwright-driven UI smoke tests (chatbot rendered in browser)
- Multi-language conversation tests (mid-conversation language switch)
- Accessibility (WCAG) audit of the chat widget

---

## Design notes

This module deliberately stays **outside the chatbot package**. Coupling
the tests too tightly to the implementation defeats the purpose — the
SDET surface is the public `processTurn(input) → response` contract,
nothing else. Internal refactors of `chatbot/src/agents/` should not
break Module 3.

Same principle Module 1 follows for the úlovdomov.cz web suite: page
objects abstract the UI; specs only depend on stable selectors.
