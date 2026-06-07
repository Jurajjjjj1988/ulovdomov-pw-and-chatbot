#!/usr/bin/env tsx
/**
 * Offline unit verification for the L2 retrieval metric math.
 *
 * Does NOT call scoreRetrieval (that needs frozen fixtures + the live-built
 * index). Instead it exercises the pure exported helpers with hand-built inputs
 * whose correct answers are computed by hand, so a regression in the math fails
 * here regardless of fixture state. No live LLM, no test framework — just
 * `node:assert/strict`.
 *
 * Run via: `npx tsx scorers/l2-retrieval.test.ts`
 */

import assert from "node:assert/strict";

import {
  cosine,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  hitAtK,
  ndcgAtK,
} from "./l2-retrieval.js";

/** Assert two floats are equal within an epsilon (guards FP noise). */
function assertClose(actual: number, expected: number, msg: string, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg}: expected ${expected}, got ${actual}`,
  );
}

// ── cosine ──────────────────────────────────────────────────────────────────
// Identical direction → 1; orthogonal → 0; opposite → -1; zero-norm guard → 0.
assertClose(cosine([1, 0], [1, 0]), 1, "cosine identical");
assertClose(cosine([1, 0], [0, 1]), 0, "cosine orthogonal");
assertClose(cosine([1, 0], [-1, 0]), -1, "cosine opposite");
// [1,2,3]·[2,4,6] = 28; |a|=√14, |b|=√56=2√14; 28/(√14·2√14)=28/28=1 (parallel).
assertClose(cosine([1, 2, 3], [2, 4, 6]), 1, "cosine parallel scaled");
assertClose(cosine([0, 0], [1, 1]), 0, "cosine zero-norm guard");
assertClose(cosine([], []), 0, "cosine empty guard");

// ── Perfect ranking: top-3 all relevant, relevant set size 3 ─────────────────
{
  const ranked = [true, true, true];
  assertClose(precisionAtK(ranked, 3), 1, "perfect P@3");
  assertClose(recallAtK(ranked, 3, 3), 1, "perfect R@3");
  assertClose(reciprocalRank(ranked), 1, "perfect MRR");
  assert.equal(hitAtK(ranked, 3), 1, "perfect Hit@3");
  // grades [2,2,1], ideal = same → nDCG = 1.
  assertClose(ndcgAtK([2, 2, 1], 3, [2, 2, 1]), 1, "perfect nDCG@3");
}

// ── Zero-hit ranking: nothing relevant in top-3, relevant set exists ─────────
{
  const ranked = [false, false, false];
  assertClose(precisionAtK(ranked, 3), 0, "zero P@3");
  assertClose(recallAtK(ranked, 3, 2), 0, "zero R@3");
  assertClose(reciprocalRank(ranked), 0, "zero MRR");
  assert.equal(hitAtK(ranked, 3), 0, "zero Hit@3");
  assertClose(ndcgAtK([0, 0, 0], 3, [2, 1]), 0, "zero nDCG@3");
}

// ── Mid ranking: [rel, irrel, rel], relevant set size 2 ──────────────────────
// P@3 = 2/3; R@3 = 2/2 = 1; first relevant at rank 1 → MRR = 1; Hit@3 = 1.
{
  const ranked = [true, false, true];
  assertClose(precisionAtK(ranked, 3), 2 / 3, "mid P@3");
  assertClose(recallAtK(ranked, 3, 2), 1, "mid R@3");
  assertClose(reciprocalRank(ranked), 1, "mid MRR (first hit rank 1)");
  assert.equal(hitAtK(ranked, 3), 1, "mid Hit@3");

  // graded [2,0,1]: DCG = 2/log2(2) + 0/log2(3) + 1/log2(4)
  //               = 2/1 + 0 + 1/2 = 2.5
  // ideal grades sorted [2,1]: IDCG = 2/log2(2) + 1/log2(3) = 2 + 1/log2(3)
  const dcg = 2 / Math.log2(2) + 0 / Math.log2(3) + 1 / Math.log2(4);
  const idcg = 2 / Math.log2(2) + 1 / Math.log2(3);
  assertClose(ndcgAtK([2, 0, 1], 3, [2, 1]), dcg / idcg, "mid nDCG@3");
}

// ── First-relevant-at-rank-2 → MRR = 1/2 (distinct from rank-1 case) ─────────
{
  const ranked = [false, true, true];
  assertClose(reciprocalRank(ranked), 0.5, "MRR first hit rank 2");
  assertClose(precisionAtK(ranked, 3), 2 / 3, "P@3 rank-2 start");
}

// ── Recall with a relevant item beyond the cutoff: 1 of 3 found in top-2 ─────
{
  const ranked = [true, false, true]; // only top-2 counted
  assertClose(recallAtK(ranked, 2, 3), 1 / 3, "R@2 partial recall");
  assertClose(precisionAtK(ranked, 2), 1 / 2, "P@2 partial");
}

// ── Edge: empty relevant set / k<=0 ──────────────────────────────────────────
assertClose(recallAtK([true], 3, 0), 0, "R@k no relevant → 0");
assertClose(precisionAtK([true, true], 0), 0, "P@0 → 0");
assertClose(ndcgAtK([1], 3, []), 0, "nDCG no ideal → 0");

console.log("L2 math OK");
