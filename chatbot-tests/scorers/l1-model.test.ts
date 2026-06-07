#!/usr/bin/env tsx
/**
 * Offline unit verification for the L1 model scorer's pure helpers.
 *
 * Zero LLM, zero live chatbot, no new framework — just node:assert/strict over
 * hand-built inputs where the answer is known by hand (percentile nearest-rank,
 * mean, and the content-assertion matcher).
 *
 * Run via: `npx tsx scorers/l1-model.test.ts`
 */

import assert from "node:assert/strict";

import { percentile, mean, checkContent } from "./l1-model.js";

// ─── percentile (nearest-rank) ───────────────────────────────────────────────

// p95 of [10,20,…,100] (N=10): rank = ceil(0.95·10) = 10 → value at rank 10 = 100.
const tens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
assert.equal(percentile(tens, 95), 100, "p95 of 10..100 = 100");
assert.equal(percentile(tens, 100), 100, "p100 = max");
assert.equal(percentile(tens, 50), 50, "p50 of 10..100 = 50 (rank ceil(5)=5 → 50)");
assert.equal(percentile(tens, 0), 10, "p0 clamps to rank 1 → min");
assert.equal(percentile([42], 95), 42, "p95 of single element = that element");
assert.equal(percentile([], 95), 0, "p95 of empty = 0");
// p90 rank = ceil(0.90·10) = 9 → value at rank 9 = 90.
assert.equal(percentile(tens, 90), 90, "p90 of 10..100 = 90");

// ─── mean ────────────────────────────────────────────────────────────────────

assert.equal(mean([2, 4, 6]), 4, "mean of 2,4,6 = 4");
assert.equal(mean([5]), 5, "mean of single = itself");
assert.equal(mean([]), 0, "mean of empty = 0 (not NaN)");
assert.equal(mean([0.001, 0.003]), 0.002, "mean of small floats");

// ─── checkContent ────────────────────────────────────────────────────────────

// must_mention — case-SENSITIVE substring containment, ALL required.
assert.equal(
  checkContent("Prémiový inzerát stojí 490 Kč.", { response_must_mention: ["490", "Kč"] }).passed,
  true,
  "must_mention all present",
);
const miss = checkContent("Prémiový inzerát stojí 490 korun.", {
  response_must_mention: ["490", "Kč"],
});
assert.equal(miss.passed, false, "must_mention one missing → fail");
assert.equal(miss.failed.length, 1, "exactly one failed assertion recorded");
assert.match(miss.failed[0]!, /Kč/, "failure names the missing substring");
// case-sensitivity: lowercase 'kč' must NOT satisfy a 'Kč' requirement.
assert.equal(
  checkContent("stojí 490 kč", { response_must_mention: ["Kč"] }).passed,
  false,
  "must_mention is case-sensitive (kč ≠ Kč)",
);

// must_mention_any — ≥1 present, case-INSENSITIVE.
assert.equal(
  checkContent("Předám to kolegovi z podpory.", {
    response_must_mention_any: ["ticket", "kolega", "podpor"],
  }).passed,
  true,
  "must_mention_any one present",
);
assert.equal(
  checkContent("PODPORA vám pomůže.", { response_must_mention_any: ["podpor"] }).passed,
  true,
  "must_mention_any is case-insensitive (PODPORA matches podpor)",
);
assert.equal(
  checkContent("Nemám tušení.", { response_must_mention_any: ["ticket", "kolega"] }).passed,
  false,
  "must_mention_any none present → fail",
);

// must_not_mention — NONE present, case-INSENSITIVE.
assert.equal(
  checkContent("Předáme to dál.", { response_must_not_mention: ["kompenzace", "refund"] }).passed,
  true,
  "must_not_mention none present → pass",
);
const violation = checkContent("Nabídneme vám REFUND.", {
  response_must_not_mention: ["refund"],
});
assert.equal(violation.passed, false, "must_not_mention violated (case-insensitive) → fail");
assert.match(violation.failed[0]!, /refund/, "failure names the forbidden substring");

// combined: a passing must_mention but a violated must_not_mention → fail, with
// only the violated assertion recorded.
const combined = checkContent("Vrátíme vám 490 Kč.", {
  response_must_mention: ["490"],
  response_must_not_mention: ["vrátíme"],
});
assert.equal(combined.passed, false, "combined: must_not violation fails the turn");
assert.equal(combined.failed.length, 1, "combined: only the violated assertion recorded");

// no content keys declared → vacuously passes.
assert.equal(checkContent("anything", {}).passed, true, "no content expectation → pass");
assert.deepEqual(checkContent("anything", {}).failed, [], "no content expectation → no failures");

console.log("L1 math OK");
