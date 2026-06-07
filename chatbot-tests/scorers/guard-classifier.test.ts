#!/usr/bin/env tsx
/**
 * Offline unit verification for the guard-classifier metric math.
 *
 * Does NOT call scoreGuard (that imports the chatbot's guard and reads the
 * corpus). Instead it exercises the pure `computeClassifierMetrics` helper with
 * hand-built confusion matrices whose correct answers are computed by hand, so a
 * regression in the precision/recall/F1/FPR formulas fails here regardless of
 * the corpus or guard state. No live LLM, no test framework — just
 * `node:assert/strict`.
 *
 * Run via: `npx tsx scorers/guard-classifier.test.ts`
 */

import assert from "node:assert/strict";

import { computeClassifierMetrics } from "./guard-classifier.js";

/** Assert two floats are equal within an epsilon (guards FP noise). */
function assertClose(actual: number, expected: number, msg: string, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg}: expected ${expected}, got ${actual}`,
  );
}

// ── Known matrix: TP=3, FP=1, FN=2, TN=4 (total 10) ──────────────────────────
// precision = 3/(3+1) = 0.75
// recall    = 3/(3+2) = 0.6
// f1        = 2·0.75·0.6/(0.75+0.6) = 0.9/1.35 = 0.6666…
// fpr       = 1/(1+4) = 0.2
// accuracy  = (3+4)/10 = 0.7
{
  const cm = computeClassifierMetrics({ tp: 3, fp: 1, fn: 2, tn: 4 });
  assertClose(cm.precision, 0.75, "precision 3/(3+1)");
  assertClose(cm.recall, 0.6, "recall 3/(3+2)");
  assertClose(cm.f1, (2 * 0.75 * 0.6) / (0.75 + 0.6), "f1 harmonic mean");
  assertClose(cm.fpr, 0.2, "fpr 1/(1+4)");
  assertClose(cm.blockAccuracy, 0.7, "accuracy (3+4)/10");
}

// ── Perfect classifier: every attack blocked, no safe item blocked ───────────
// precision = recall = f1 = accuracy = 1; fpr = 0.
{
  const cm = computeClassifierMetrics({ tp: 5, fp: 0, fn: 0, tn: 5 });
  assertClose(cm.precision, 1, "perfect precision");
  assertClose(cm.recall, 1, "perfect recall");
  assertClose(cm.f1, 1, "perfect f1");
  assertClose(cm.fpr, 0, "perfect fpr");
  assertClose(cm.blockAccuracy, 1, "perfect accuracy");
}

// ── Over-blocker: blocks everything (FP high, FN zero) ───────────────────────
// TP=4, FP=6, FN=0, TN=0 → recall 1 (catches all attacks) but precision 0.4,
// and fpr = 6/(6+0) = 1 (blocks EVERY legit customer — the worst FPR).
{
  const cm = computeClassifierMetrics({ tp: 4, fp: 6, fn: 0, tn: 0 });
  assertClose(cm.precision, 0.4, "over-blocker precision 4/10");
  assertClose(cm.recall, 1, "over-blocker recall");
  assertClose(cm.fpr, 1, "over-blocker fpr (all safe blocked)");
}

// ── Divide-by-zero guards: undefined ratios collapse to 0, never NaN ─────────
// Nothing blocked at all: TP+FP=0 → precision 0; f1 0.
{
  const cm = computeClassifierMetrics({ tp: 0, fp: 0, fn: 3, tn: 4 });
  assertClose(cm.precision, 0, "no-blocks precision guard");
  assertClose(cm.recall, 0, "no-blocks recall (0/(0+3))");
  assertClose(cm.f1, 0, "no-blocks f1 guard");
  assert.ok(!Number.isNaN(cm.precision), "precision not NaN");
}
// No safe items: FP+TN=0 → fpr 0. No attacks: TP+FN=0 → recall 0.
{
  const onlyMalicious = computeClassifierMetrics({ tp: 3, fp: 0, fn: 1, tn: 0 });
  assertClose(onlyMalicious.fpr, 0, "no-safe fpr guard");
  const onlySafe = computeClassifierMetrics({ tp: 0, fp: 1, fn: 0, tn: 5 });
  assertClose(onlySafe.recall, 0, "no-attacks recall guard");
}
// Empty matrix: every metric 0, no throw.
{
  const cm = computeClassifierMetrics({ tp: 0, fp: 0, fn: 0, tn: 0 });
  assertClose(cm.blockAccuracy, 0, "empty accuracy guard");
  assertClose(cm.precision, 0, "empty precision guard");
}

console.log("Guard math OK");
