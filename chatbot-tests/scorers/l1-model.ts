/**
 * L1 Model scorer.
 *
 * Slide 6, layer L1: did the chatbot's per-turn OUTPUT behave correctly — was
 * the router intent right, was it confident enough, did the response say what
 * it must (and not say what it must not), and did it stay inside the token and
 * latency budgets. This is the L1-relevant subset of the assertions
 * replay.ts's `evaluateExpectations` runs LIVE; here we re-implement them
 * FULLY OFFLINE over recorded snapshots and emit aggregate metrics instead of
 * per-assertion pass/fail prints.
 *
 * FULLY OFFLINE — zero LLM calls. It reads the *recorded* snapshots
 * (fixtures/recordings/<id>.json, written by record-snapshots.ts) — each file
 * is a `TurnRecord[]`, one entry per golden turn, serialised with
 * `JSON.stringify(records, null, 2)`. To refresh the snapshots a human runs
 * `npm run eval:record` (which IS allowed to call the live chatbot); this
 * scorer never does. Snapshot loading mirrors l3-trajectory.ts so both scorers
 * agree on the on-disk format and on the "no recording" degradation path.
 *
 * Also emits the cost & latency gate metrics (cost.usd_per_turn,
 * latency.p95_ms, tokens.mean_per_turn) derived from the same recordings.
 *
 * Run (offline): `npx tsx scorers/l1-model.ts` prints a per-metric summary.
 * The scorer is also imported by the eval-runner. Unit tests for the pure
 * helpers live in l1-model.test.ts.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ScorerResult,
  Metric,
  ExampleScore,
  ReviewFlag,
  TurnRecord,
} from "./types.js";

// ───────────────────────────────────────────────────────────────────────────
// Paths. Resolved from the eval-runner cwd (chatbot-tests root), matching the
// convention l3-trajectory.ts / replay.ts use for their scenario/chatbot paths.
// ───────────────────────────────────────────────────────────────────────────

const GOLDEN_DIR = resolve("golden/conversations");
const RECORDINGS_DIR = resolve("fixtures/recordings");

// ───────────────────────────────────────────────────────────────────────────
// Golden-file shapes. We only declare the L1-relevant `expect` fields; other
// layers' fields (rag_*, guard_*, trajectory, tool_calls*) are ignored here.
// ───────────────────────────────────────────────────────────────────────────

/** The L1-relevant subset of a golden turn's `expect` block. */
export interface L1Expect {
  router_intent?: string;
  router_confidence_min?: number;
  response_must_mention?: string[];
  response_must_mention_any?: string[];
  response_must_not_mention?: string[];
  tokens_max?: number;
  latency_ms_max?: number;
}

/** A golden conversation turn (only the fields the L1 scorer consumes). */
interface GoldenTurn {
  user: string;
  expect: L1Expect & Record<string, unknown>;
}

/** A golden conversation file. */
interface GoldenConversation {
  id: string;
  description?: string;
  turns: GoldenTurn[];
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — exported so the unit test can hit them in isolation.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Arithmetic mean of a number array.
 *
 * @param xs The values to average.
 * @returns The mean, or 0 for an empty array (no turns evaluated → 0, not NaN).
 */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * Percentile of an ALREADY-SORTED (ascending) numeric array using the
 * nearest-rank method: rank = ceil(p/100 · N), clamped to [1, N], then the
 * value at that 1-based rank is returned. p95 of [10,20,…,100] (N=10) →
 * rank = ceil(9.5) = 10 → 100. Nearest-rank is chosen over interpolation
 * because it always returns an observed latency, which is what a budget gate
 * should reason about.
 *
 * @param sorted Latencies sorted ascending. (Caller sorts; this does not.)
 * @param p Percentile in [0, 100].
 * @returns The percentile value, or 0 for an empty array.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index]!;
}

/** Outcome of the per-turn content assertions. */
export interface ContentCheck {
  /** True iff every applicable content assertion passed. */
  passed: boolean;
  /** Human-readable descriptions of each failed content assertion. */
  failed: string[];
}

/**
 * Evaluates the L1 response-content assertions against a recorded response.
 * Mirrors replay.ts exactly: `response_must_mention` is case-SENSITIVE
 * substring containment (all required); `response_must_mention_any` and
 * `response_must_not_mention` are case-INSENSITIVE (≥1 present / none present).
 *
 * Only assertions actually declared in `expect` are evaluated — an expectation
 * with no content keys yields `{ passed: true, failed: [] }`.
 *
 * @param response The recorded agent response text (record.agentResponse).
 * @param expect The turn's expectation block.
 * @returns Pass flag plus the list of failed-assertion descriptions.
 */
export function checkContent(response: string, expect: L1Expect): ContentCheck {
  const failed: string[] = [];
  const lower = response.toLowerCase();

  if (expect.response_must_mention !== undefined) {
    const missing = expect.response_must_mention.filter((s) => !response.includes(s));
    if (missing.length > 0) failed.push(`must_mention missing [${missing.join(", ")}]`);
  }

  if (expect.response_must_mention_any !== undefined) {
    const matched = expect.response_must_mention_any.some((s) => lower.includes(s.toLowerCase()));
    if (!matched) {
      failed.push(`must_mention_any none of [${expect.response_must_mention_any.join(", ")}]`);
    }
  }

  if (expect.response_must_not_mention !== undefined) {
    const present = expect.response_must_not_mention.filter((s) => lower.includes(s.toLowerCase()));
    if (present.length > 0) failed.push(`must_not_mention forbidden [${present.join(", ")}]`);
  }

  return { passed: failed.length === 0, failed };
}

/** True iff the turn declares at least one content assertion. */
function hasContentExpectation(expect: L1Expect): boolean {
  return (
    expect.response_must_mention !== undefined ||
    expect.response_must_mention_any !== undefined ||
    expect.response_must_not_mention !== undefined
  );
}

/** Counts the content assertions declared on a turn (one per declared key). */
function countContentAssertions(expect: L1Expect): number {
  let n = 0;
  if (expect.response_must_mention !== undefined) n += 1;
  if (expect.response_must_mention_any !== undefined) n += 1;
  if (expect.response_must_not_mention !== undefined) n += 1;
  return n;
}

/** Counts the PASSED content assertions declared on a turn. */
function countPassedContentAssertions(response: string, expect: L1Expect): number {
  let passed = 0;
  const lower = response.toLowerCase();
  if (expect.response_must_mention !== undefined) {
    if (expect.response_must_mention.every((s) => response.includes(s))) passed += 1;
  }
  if (expect.response_must_mention_any !== undefined) {
    if (expect.response_must_mention_any.some((s) => lower.includes(s.toLowerCase()))) passed += 1;
  }
  if (expect.response_must_not_mention !== undefined) {
    if (!expect.response_must_not_mention.some((s) => lower.includes(s.toLowerCase()))) passed += 1;
  }
  return passed;
}

// ───────────────────────────────────────────────────────────────────────────
// Snapshot / golden loading. Mirrors l3-trajectory.ts so both scorers consume
// the identical on-disk format and degrade identically on a missing snapshot.
// ───────────────────────────────────────────────────────────────────────────

/** Loads every golden conversation file, sorted by filename for determinism. */
function loadGoldenConversations(): GoldenConversation[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf8")) as GoldenConversation);
}

/**
 * Loads a scenario's recorded per-turn records, or null if no snapshot exists.
 * The recorder writes a `TurnRecord[]` (one entry per turn) per scenario.
 */
function loadSnapshot(id: string): TurnRecord[] | null {
  const path = join(RECORDINGS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as TurnRecord[];
}

// ───────────────────────────────────────────────────────────────────────────
// Per-turn evaluation.
// ───────────────────────────────────────────────────────────────────────────

/** The per-turn L1 sub-check outcomes (null = check not applicable). */
interface TurnChecks {
  intent: boolean | null;
  confidence: boolean | null;
  content: boolean | null;
  tokenCap: boolean | null;
  latencyCap: boolean | null;
}

/** Runs the five L1 sub-checks for one turn against its recorded record. */
function evaluateTurn(expect: L1Expect, record: TurnRecord): TurnChecks {
  const checks: TurnChecks = {
    intent: null,
    confidence: null,
    content: null,
    tokenCap: null,
    latencyCap: null,
  };

  if (expect.router_intent !== undefined) {
    checks.intent = record.router.intent === expect.router_intent;
  }
  if (expect.router_confidence_min !== undefined) {
    checks.confidence = record.router.confidence >= expect.router_confidence_min;
  }
  if (hasContentExpectation(expect)) {
    checks.content = checkContent(record.agentResponse, expect).passed;
  }
  if (expect.tokens_max !== undefined) {
    const total = record.tokensUsed.prompt + record.tokensUsed.completion;
    checks.tokenCap = total <= expect.tokens_max;
  }
  if (expect.latency_ms_max !== undefined) {
    checks.latencyCap = record.latencyMs <= expect.latency_ms_max;
  }

  return checks;
}

/** Names of the applicable sub-checks that failed (for ExampleScore detail). */
function describeFailures(checks: TurnChecks): string[] {
  const failed: string[] = [];
  if (checks.intent === false) failed.push("router_intent");
  if (checks.confidence === false) failed.push("router_confidence");
  if (checks.content === false) failed.push("response_content");
  if (checks.tokenCap === false) failed.push("token_cap");
  if (checks.latencyCap === false) failed.push("latency_cap");
  return failed;
}

// ───────────────────────────────────────────────────────────────────────────
// Scorer entry point.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Scores the L1 model layer fully offline from recorded snapshots.
 *
 * For each golden conversation it loads fixtures/recordings/<id>.json (a
 * `TurnRecord[]`). A missing recording is NOT an error: it pushes a ReviewFlag
 * ("run `npm run eval:record`") and skips that scenario's turns — the same
 * graceful degradation as the L3 scorer. For each turn that HAS a matching
 * record it evaluates the L1-relevant expectations (router intent, router
 * confidence, response content, token cap, latency cap) and aggregates pass
 * rates plus the cost/latency/token gate metrics.
 *
 * Emits Metrics:
 *  - l1.router_intent_accuracy        (ratio, ↑) — correct intents / turns specifying router_intent
 *  - l1.response_assertion_pass_rate  (ratio, ↑) — passed content assertions / total content assertions
 *  - l1.token_cap_pass_rate           (ratio, ↑) — passed token caps / turns specifying tokens_max
 *  - l1.latency_cap_pass_rate         (ratio, ↑) — passed latency caps / turns specifying latency_ms_max
 *  - cost.usd_per_turn                (usd, ↓)   — mean record.costUsd over evaluated turns
 *  - latency.p95_ms                   (ms, ↓)    — nearest-rank p95 of record.latencyMs
 *  - tokens.mean_per_turn             (count, ↓) — mean total tokens over evaluated turns
 *
 * Empty-denominator pass-rate ratios resolve to 1 (vacuous pass), consistent
 * with the L3 scorer's ratioMetric, so a golden set that declares no caps does
 * not drag a gate down. Cost/latency/token metrics over zero evaluated turns
 * resolve to 0.
 *
 * Pushes one ExampleScore per evaluated turn (id `${scenarioId}#${n}`,
 * metricKey "l1.turn_pass", value 1 iff every applicable L1 check passed,
 * detail naming the failed checks) and a ReviewFlag for every turn with a
 * failed intent OR failed content assertion OR confidence below the min.
 *
 * @returns The L1 ScorerResult.
 */
export async function scoreModel(): Promise<ScorerResult> {
  const conversations = loadGoldenConversations();
  const examples: ExampleScore[] = [];
  const reviewFlags: ReviewFlag[] = [];

  // Pass-rate tallies: [passed, applicable].
  const intent = { pass: 0, total: 0 };
  const content = { pass: 0, total: 0 };
  const tokenCap = { pass: 0, total: 0 };
  const latencyCap = { pass: 0, total: 0 };

  // Gate-metric accumulators (over every evaluated turn).
  const costs: number[] = [];
  const latencies: number[] = [];
  const totalTokens: number[] = [];

  for (const conv of conversations) {
    const snapshot = loadSnapshot(conv.id);
    if (snapshot === null) {
      reviewFlags.push({
        id: conv.id,
        reason: "no recording — run `npm run eval:record` to capture a snapshot",
        scores: {},
      });
      continue; // skip this scenario's turns (like the L3 scorer)
    }

    for (let i = 0; i < conv.turns.length; i++) {
      const expect = conv.turns[i]!.expect;
      const record = snapshot[i];
      // A short snapshot (fewer records than golden turns) has no record for
      // this turn — flag it and skip, rather than crashing on undefined.
      if (record === undefined) {
        reviewFlags.push({
          id: `${conv.id}#${i + 1}`,
          reason: "no recorded record for this turn — re-run `npm run eval:record`",
          scores: {},
        });
        continue;
      }

      // Gate metrics: count every turn we actually evaluated.
      costs.push(record.costUsd ?? 0);
      latencies.push(record.latencyMs);
      totalTokens.push(record.tokensUsed.prompt + record.tokensUsed.completion);

      const checks = evaluateTurn(expect, record);

      if (checks.intent !== null) {
        intent.total += 1;
        if (checks.intent) intent.pass += 1;
      }
      if (checks.content !== null) {
        const declared = countContentAssertions(expect);
        const passed = countPassedContentAssertions(record.agentResponse, expect);
        content.total += declared;
        content.pass += passed;
      }
      if (checks.tokenCap !== null) {
        tokenCap.total += 1;
        if (checks.tokenCap) tokenCap.pass += 1;
      }
      if (checks.latencyCap !== null) {
        latencyCap.total += 1;
        if (checks.latencyCap) latencyCap.pass += 1;
      }

      // ExampleScore: 1 iff every applicable check passed.
      const applicable = [
        checks.intent,
        checks.confidence,
        checks.content,
        checks.tokenCap,
        checks.latencyCap,
      ].filter((c): c is boolean => c !== null);
      const turnOk = applicable.every((c) => c);
      const failures = describeFailures(checks);
      examples.push({
        id: `${conv.id}#${i + 1}`,
        metricKey: "l1.turn_pass",
        value: turnOk ? 1 : 0,
        detail: failures.length > 0 ? `failed: ${failures.join(", ")}` : undefined,
      });

      // ReviewFlag: a human should inspect turns with a failed intent, failed
      // content assertion, or confidence below the declared minimum.
      if (checks.intent === false || checks.content === false || checks.confidence === false) {
        reviewFlags.push({
          id: `${conv.id}#${i + 1}`,
          reason: `L1 failed: ${describeReviewReasons(checks).join(", ")}`,
          scores: {
            router_confidence: record.router.confidence,
            total_tokens: record.tokensUsed.prompt + record.tokensUsed.completion,
            latency_ms: record.latencyMs,
          },
        });
      }
    }
  }

  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  const metrics: Metric[] = [
    ratioMetric("l1.router_intent_accuracy", intent.pass, intent.total),
    ratioMetric("l1.response_assertion_pass_rate", content.pass, content.total),
    ratioMetric("l1.token_cap_pass_rate", tokenCap.pass, tokenCap.total),
    ratioMetric("l1.latency_cap_pass_rate", latencyCap.pass, latencyCap.total),
    { key: "cost.usd_per_turn", value: mean(costs), greaterIsBetter: false, unit: "usd" },
    { key: "latency.p95_ms", value: percentile(sortedLatencies, 95), greaterIsBetter: false, unit: "ms" },
    { key: "tokens.mean_per_turn", value: mean(totalTokens), greaterIsBetter: false, unit: "count" },
  ];

  return {
    layer: "L1",
    name: "L1 Model",
    metrics,
    examples,
    reviewFlags,
  };
}

/** Review-flag reasons — only the human-inspect-worthy sub-checks. */
function describeReviewReasons(checks: TurnChecks): string[] {
  const reasons: string[] = [];
  if (checks.intent === false) reasons.push("router_intent");
  if (checks.confidence === false) reasons.push("router_confidence");
  if (checks.content === false) reasons.push("response_content");
  return reasons;
}

/** Builds a ratio Metric (greaterIsBetter). Empty denominator → 1 (vacuous pass). */
function ratioMetric(key: string, pass: number, total: number): Metric {
  return {
    key,
    value: total === 0 ? 1 : pass / total,
    greaterIsBetter: true,
    unit: "ratio",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CLI entry point — prints a readable per-metric summary when run directly.
// ───────────────────────────────────────────────────────────────────────────

/** Formats a metric value for the CLI summary (ratios → 3dp, else raw + unit). */
function fmtMetric(m: Metric): string {
  if (m.unit === "ratio" || m.unit === undefined) return m.value.toFixed(3);
  if (m.unit === "ms") return `${m.value.toFixed(0)} ms`;
  if (m.unit === "usd") return `$${m.value.toFixed(6)}`;
  return `${m.value.toFixed(2)}`;
}

/**
 * CLI main: runs the scorer offline and prints a per-metric summary plus a
 * review-flag count. Never throws on missing recordings — those surface as
 * review flags, exactly as the eval-runner expects.
 *
 * @returns Resolves once the summary is printed.
 */
async function main(): Promise<void> {
  const result = await scoreModel();

  console.log(`\n🧮 ${result.name} (${result.layer}) — offline`);
  console.log(`   Examples (turns evaluated): ${result.examples.length}`);
  console.log(`\n📊 Metrics`);
  const keyW = Math.max(3, ...result.metrics.map((m) => m.key.length));
  for (const m of result.metrics) {
    const dir = m.greaterIsBetter ? "↑ higher" : "↓ lower";
    console.log(`   ${m.key.padEnd(keyW)}  ${fmtMetric(m).padStart(10)}  ${dir}`);
  }

  const flags = result.reviewFlags ?? [];
  console.log(`\n🔎 Review flags: ${flags.length}`);
  for (const f of flags) {
    console.log(`   - [${f.id}] ${f.reason}`);
  }
  console.log("");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`❌ L1 scorer failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
