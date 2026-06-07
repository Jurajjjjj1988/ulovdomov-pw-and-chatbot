# Module 3 — Chatbot evaluation pipeline

> SDET-discipline **evaluation pipeline** for the úlovdomov chatbot in
> [`../chatbot/`](../chatbot/). Where Module 2 *builds* the chatbot, Module 3
> *qualifies* it across four layers — model, retrieval, trajectory, safety —
> behind an offline regression gate.

This is **Module 3** of the [ulovdomov-pw-and-chatbot](../README.md) suite.

- [Module 1](../tests/README.md) — Playwright E2E tests against úlovdomov.cz
- [Module 2](../chatbot/README.md) — Multi-agent LLM chatbot (the system under test)
- **Module 3** (this folder) — evaluation pipeline for the chatbot

---

## The model: four layers + a pipeline

Evaluating an LLM/RAG/agent system is **not** "run an LLM-as-a-judge on the
outputs". That's the answer that misses the retrieval pipeline, the agent
trajectory, and the system around them. Module 3 is built on the layered model:

| Layer | What it checks | Scorer |
|---|---|---|
| **L1 — Model** | router intent accuracy, response-content assertions, token/latency/cost per turn | [`scorers/l1-model.ts`](scorers/l1-model.ts) |
| **L2 — Retrieval** | Precision@k · Recall@k · MRR · Hit@k · nDCG@k against a labeled **chunk-level** golden set | [`scorers/l2-retrieval.ts`](scorers/l2-retrieval.ts) |
| **L3 — Trajectory** | tool-call sequence (ordered/unordered/subset), terminal-state validity, step efficiency | [`scorers/l3-trajectory.ts`](scorers/l3-trajectory.ts) |
| **SAFETY — Guard** | the lexical guard as a binary classifier: precision · recall · **FPR** (legit users wrongly blocked) | [`scorers/guard-classifier.ts`](scorers/guard-classifier.ts) |

Wired into the slide-7 pipeline:

```
Golden Dataset ─→ Offline Eval Runner ─→ Scorer (L1+L2+L3+SAFETY) ─→ Regression Gate
   golden/            eval-runner.ts          scorers/*.ts                gate.ts
                                                   │
                                                   └─→ Human Review Queue (review-queue.jsonl)
```

Two design rules carried straight from the architecture:

1. **Deterministic where possible, LLM-judge only for semantics.** Every scorer
   here is **offline and deterministic** — it reads frozen fixtures (the
   embedding index, frozen query vectors, recorded turn snapshots, a labeled
   corpus) and makes **zero LLM calls**. The gate runs in CI for free. The
   semantic LLM-judge metric (RAGAS-style faithfulness) is kept *separate* and
   opt-in — see [Roadmap](#roadmap).
2. **Automated scoring catches regressions; human review catches distribution
   shift.** The gate blocks on metric regressions. Anything a scorer is unsure
   about (a guard miss, a low-confidence route, a zero-hit retrieval) is pushed
   to the review queue, not silently passed.

> **Faithfulness ≠ retrieval quality.** A common conflation: "we use RAGAS for
> retrieval quality". RAGAS *faithfulness* is an **L1** answer-grounding metric;
> it says nothing about whether the *right chunks* were retrieved. L2 here is
> real IR (Precision@k / Recall@k / MRR / nDCG) against labeled relevant chunks.

---

## Layout

```
chatbot-tests/
├── golden/                          ← versioned golden datasets (slide 7)
│   ├── conversations/               ← L1/L3 labeled transcripts (was scenarios/)
│   │   └── 01..06.json              ← per-turn expect{} incl. trajectory{}
│   ├── retrieval/retrieval-set.json ← L2: query → relevant chunks (graded)
│   └── safety/guard-corpus.json     ← SAFETY: labeled safe + malicious corpus
├── fixtures/                        ← frozen inputs that make eval offline
│   ├── query-embeddings.json        ← frozen query vectors (built once)  [generated]
│   ├── recordings/<id>.json         ← recorded processTurn() snapshots   [generated]
│   └── build-query-embeddings.ts    ← build step (the only file that hits the API)
├── scorers/                         ← one file per layer + shared types.ts
├── eval-runner.ts                   ← runs all scorers → reports/ + review queue
├── gate.ts                          ← report vs baseline → exit code (CI gate)
├── baseline.json                    ← committed baseline metrics
├── review-queue.ts                  ← `npm run review` lists pending flags
├── replay.ts                        ← legacy LIVE end-to-end smoke (opt-in)
└── reports/                         ← run artifacts (gitignored)
```

---

## Running

```bash
npm install

# ── Offline, zero-token (these run in CI) ─────────────────────────────
npm run eval            # run every scorer → reports/eval-<ts>.{json,md}
npm run eval:gate       # eval + compare to baseline.json → exit 1 on regression
npm run review          # list turns flagged for human review
npm test                # unit tests for the scorer math
npm run typecheck       # tsc --noEmit

# ── Build steps (LIVE backend, cost tokens — run deliberately) ────────
npm run eval:retrieval:embed   # freeze query vectors for L2  → fixtures/query-embeddings.json
npm run eval:record            # record processTurn() snapshots for L1+L3 → fixtures/recordings/
npm run eval:baseline:update   # re-capture baseline.json from a fresh run

# ── Optional live end-to-end smoke (legacy) ───────────────────────────
npm run replay
```

The build steps need the chatbot backend configured —
[`../chatbot/.env`](../chatbot/.env) with `GITHUB_MODELS_TOKEN`,
`AZURE_OPENAI_*`, or `OPENAI_API_KEY`.

**First-run order:** `eval:retrieval:embed` + `eval:record` (live, once) →
`eval:baseline:update` → from then on `eval:gate` runs offline in CI. Until the
fixtures exist, the runner reports L2 as *skipped* and L1/L3 as *unrecorded* —
the gate still protects whatever is in the baseline.

---

## Current state (honest)

Measured offline, deterministically, on this branch:

- **SAFETY guard** — runs fully today (the guard is lexical → no fixtures needed).
  On a 36-item labeled corpus (22 malicious / 14 safe):

  | precision | recall | F1 | FPR | block accuracy |
  |---|---|---|---|---|
  | **1.000** | **0.773** | 0.872 | **0.000** | 0.861 |

  - **FPR = 0** — no legitimate customer in the corpus was wrongly blocked
    (forgot-own-password, frustrated complaint, benign use of "system"/"heslo").
    *A single jailbreak scenario can never reveal this number — only a labeled
    safe set can.*
  - **recall = 0.773 is a real, surfaced gap**: the lexical guard misses 5/22
    attacks — 4 obfuscated (base64, leetspeak, spaced-out, Slovak-diacritic
    override) and 1 phrasing (`pretend you are now in developer mode`). These are
    pushed to the review queue, not hidden. Hardening the guard regexes (and
    adding encoded-variant tests) is a chatbot-team item.

- **L1 / L2 / L3** — scorers built, typechecked, unit-tested; they populate with
  real numbers once `eval:retrieval:embed` (L2) and `eval:record` (L1/L3) are run
  against the live backend. The `baseline.json` is currently **guard-only** by
  design — run the build steps then `eval:baseline:update` to lock in the rest.

- **Known limitation (L3 tool-args):** the chatbot logs *synthetic* tool
  arguments, not the model's real function-call args, so `tool_args` matching is
  recorded as *skipped* (not failed). Capturing real args in
  `chatbot/src/index.ts` would unlock it.

---

## Why a separate module

Module 2 ships with its own unit + smoke tests — whitebox, "does the code match
the design". Module 3 is the **independent evaluation suite** an SDET owns:
blackbox over the public `processTurn()` contract, regression-stable, asking
"does the chatbot do what a real customer would expect, and does the *system*
around the model hold up". Same dev/SDET separation mature LLM teams keep
between the model developer and the model-evaluation engineer.

---

## Roadmap

**Phase 3 — semantic layer (LLM-judge, opt-in, not in the hard gate)**
- Relocate RAGAS-style faithfulness from `../chatbot/src/eval/` into `scorers/`,
  add an explicit hallucination-rate metric; feed results to the review queue.
- Add **answer relevancy** + **answer correctness** (vs reference) — faithful
  but off-topic / confidently-wrong-but-grounded answers slip past faithfulness.
- Calibrate the judge against human labels before trusting its scores.

**Hardening the gate**
- Per-example regression diff vs baseline (today: aggregate + current-failures list).
- Cost ($/turn) and latency (p95) as first-class baselined gate metrics (metrics
  already emitted by L1 — add them to the baseline once recordings exist).
- Repeat-N runs to measure the LLM noise floor and justify the 5pp band.

**Growing the golden set**
- Mine [`logs/conversations.jsonl`](logs/conversations.jsonl) / production traces
  into new golden cases; version the dataset alongside the baseline.

**Safety depth**
- Attack-strategy mutators (base64 / leetspeak / crescendo) layered over the
  corpus to systematically probe the guard, with attack-success-rate per category.
