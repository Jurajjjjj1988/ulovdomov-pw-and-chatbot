# Prompts iteration log

A chronological record of system prompt changes — what changed, why, what
broke before, what improved after. Treated as primary engineering artifact,
not docs decoration.

---

## Intent Router

### v0.1 — 2026-03-15
**Initial draft. 8 intent classes:** `pricing`, `viewing`, `account`, `gdpr`,
`payment`, `search`, `complaint`, `chitchat`.

**Problem caught on labeled set (50 utterances):** confusion between `pricing`
and `payment`, between `account` and `gdpr`. F1 dropped to 0.71.

### v0.2 — 2026-03-22
**Collapsed to 5 classes:** `faq` (merges pricing + account + gdpr +
payment), `property_search`, `viewing_request`, `complaint`, `chitchat`.

**Rationale:** the downstream FAQ agent uses RAG to distinguish between the
collapsed sub-types. The router doesn't need to pre-classify what RAG can
disambiguate from the question itself.

**Result on the same labeled set:** F1 = 0.93. Confidence median jumped from
0.68 → 0.89. Cleanest win in the project so far.

### v0.3 — 2026-04-05
**Added explicit rule:** "complaint has priority over faq if both signals
present." Caught a case where the test message
*"Som nespokojný s vašou cenou prémiového inzerátu"* was routed to `faq`
(model focused on "cena" keyword) when it should escalate.

**Result:** complaint recall went from 0.82 → 0.95.

### v0.4 — 2026-04-28
**Added examples** for ambiguous cases. Specifically: *"hľadám pekný 3+kk"*
was sometimes `chitchat` because the model treated "pekný" as casual. The
example bank now demonstrates that "looking for" intent always wins over tone.

**Result:** `property_search` precision +6pp on the eval set.

---

## FAQ Agent

### v0.1 — 2026-03-20
**Initial draft.** Generic helpful-assistant tone. Answered in English when
asked in English, in Czech when asked in Czech — but **mixed languages
mid-response** when RAG chunks contained Slovak phrases.

### v0.2 — 2026-04-02
**Added rule:** "match user's language for entire response. Never mix." Plus
disambiguation: "if user writes Slovak with Czech words (common), default to
Czech."

**Result:** mixed-language responses dropped from 18% to <2% (n=100 turns).

### v0.3 — 2026-04-18
**Added persona** (Ulik) and three-paragraph structure (core answer / details /
CTA). The unstructured baseline was producing wall-of-text responses that
recruiters flagged as "not chatbot-like".

**Trade-off:** average response length grew 30% (more tokens). Decided it was
worth it — readability matters more than token cost for customer-facing flows.

### v0.4 — 2026-05-10
**Added negative constraints section** ("NIKDY neprekroč"). Caught the chatbot
inventing a refund SLA in one test ("vrátime peniaze do 24h") that wasn't in
the knowledge base. Now hard-blocked.

**Result on faithfulness eval (50 RAG-grounded turns, human-judged):**
groundedness 0.88 → 0.96. The few remaining failures were RAG retrieval misses,
not prompt hallucinations.

### v0.5 — 2026-05-25
**Added example with explicit RAG citation format.** Was leaving "Podľa FAQ:"
prefix off ~40% of the time. Now consistent.

---

## Escalation Handler

### v0.1 — 2026-04-15
**Initial draft.** Empathetic, but tried to solve problems before escalating
("Skús si overiť heslo a ak to nepôjde, dáme vedieť"). This bypassed the
support ticket creation entirely on ~30% of complaints.

### v0.2 — 2026-04-30
**Hardcoded 4-step flow** (Acknowledge → Clarify → Tool → Confirm). The model
was instructed that step 3 (tool call) is mandatory. Skipping it now triggers
a sanity check warning in the orchestrator log.

**Result:** ticket creation rate on labeled complaint set: 47% → 98%.

### v0.3 — 2026-05-18
**Added priority detection rule.** Escalations containing legal-action keywords
(*advokát*, *ČOI*, *média*, *recenzia*) auto-set `priority: urgent` instead of
`priority: high`. Caught a real test case where a user threatened a public
review and the chatbot opened a `medium` ticket — would have aged in queue.

**Result:** all 7 urgent-keyword test turns now correctly tagged.

### v0.4 — 2026-06-02
**Removed emoji.** Earlier versions used 😊 in acknowledgements. Read as
condescending in escalation context (test users in survey: "feels like the
bot is making fun of me"). Hardcoded "no emoji in escalation flow."

---

## Things tried and reverted

- **Chain-of-thought reasoning in router output.** Added `<thinking>` block in
  JSON. Tripled token cost without measurable F1 improvement. Reverted.
- **Auto-translation layer.** Tried adding a "detect language, translate to
  English, run agents in English, translate back" pipeline. Latency went from
  1.2s to 4.7s, response quality went down. Native multilingual prompts are
  better.
- **Single shared "persona" prefix** in front of every agent prompt. Made the
  agents bleed into each other — escalation became too cheerful, FAQ became
  too formal. Reverted; each agent has its own focused tone now.

---

## Guard layer

### v0.1 — 2026-06-15
**Initial draft.** Two-stage layer in front of the router:
1. Lexical pre-check on a high-precision pattern set (EN + CS/SK).
2. Optional LLM cross-check classifying `safe` / `suspicious` / `malicious`.

**Labeled set:** 12 utterances (6 jailbreak templates, 6 legitimate). True
positive rate on the jailbreak set: 6/6. False positive rate on legitimate:
0/6. Lexical patterns chosen for precision over recall — novel jailbreak
phrasings will get past stage 1, mitigated by enabling stage 2 in production.

**Trade-off documented:** the guard is one layer, not the last line of
defense. The router + per-agent system prompts each provide additional
scope enforcement. This matches the **layered defense** recommendation in
the [LLM Guardrails 2026 reference](https://www.digitalapplied.com/blog/llm-guardrails-production-safety-layers-reference-2026).

---

## Conversation memory

### v0.1 — 2026-06-15
**Initial hierarchical implementation.** Sliding window (default 4 pairs)
+ rolling LLM summary triggered when conversation crosses 8 pairs. Summary
prompt is itself an iteration target — early drafts produced overly long
summaries that defeated the compression goal. Current version caps at
~3 sentences with `max_tokens: 200`.

**Trade-off:** long-term RAG-over-conversation-history is deliberately
deferred. For úlovdomov.cz's predominantly single-session use case, the
window + summary tier is sufficient; adding the third tier would cost
extra retrieval per turn for queries that rarely benefit from it.

---

## Evaluation methodology

Each prompt change is gated by:

1. **Labeled set replay** — 50-150 turns with human-assigned ground truth.
   Compare router F1, FAQ groundedness, escalation tool-call rate.
2. **Spot check on 5 hand-crafted adversarial prompts** — prompt injection
   attempts, language switches, multi-intent messages.
3. **Conversation log review** — read 20 random recent turns, look for
   smells (verbose responses, missed CTAs, off-language replies).

Changes ship when (1) regression-free, (2) measurable improvement on the
target metric, (3) doesn't introduce a new failure class.
