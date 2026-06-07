/**
 * L2 — Retrieval scorer (slide 6: "L2 retrieval").
 *
 * Fully OFFLINE and deterministic: it makes ZERO network/LLM calls. It scores
 * the RAG retriever against a chunk-level golden set by replaying *frozen*
 * query vectors (built once via `npm run eval:retrieval:embed`) against the
 * *frozen* knowledge-base index (`knowledge-base/.index.json`). Because both
 * sides are frozen, the same code + fixtures always yield the same numbers —
 * which is exactly what the regression gate needs.
 *
 * Metrics emitted (all greaterIsBetter, unit "ratio"), `k` = topK:
 *   l2.precision_at_{k} · l2.recall_at_{k} · l2.mrr · l2.hit_at_{k} · l2.ndcg_at_{k}
 *
 * Per-query ExampleScores are pushed for precision_at_{k} and hit_at_{k} so the
 * gate can detect single-query regressions, and any zero-hit query is flagged
 * for the Human Review Queue.
 *
 * Run via the eval-runner; standalone smoke: `npx tsx scorers/l2-retrieval.ts`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ExampleScore,
  Metric,
  RetrievalGoldenQuery,
  RetrievalGoldenSet,
  ReviewFlag,
  ScorerResult,
} from "./types.js";

const CHATBOT_ROOT = resolve("../chatbot");
const INDEX_PATH = resolve(CHATBOT_ROOT, "knowledge-base/.index.json");
const GOLDEN_PATH = resolve("golden/retrieval/retrieval-set.json");
const QUERY_EMB_PATH = resolve("fixtures/query-embeddings.json");

/** One chunk in the frozen knowledge-base index. */
interface IndexChunk {
  source: string;
  heading: string;
  content: string;
  embedding: number[];
}

/** One frozen query vector, keyed by golden-query id in query-embeddings.json. */
interface QueryEmbedding {
  embedding: number[];
  embeddingModel: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure metric helpers (unit-tested in l2-retrieval.test.ts).
// All take a boolean `ranked` (true = chunk at that rank is relevant) so the
// math is independent of how chunk ids are matched.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Returns 0 when either vector has zero norm (guards division by zero) — a
 * zero-norm vector has no direction, so similarity is undefined; 0 is the
 * neutral, safe answer. Missing components are treated as 0.
 *
 * @param a First vector.
 * @param b Second vector.
 * @returns Cosine similarity in [-1, 1], or 0 for a zero-norm input.
 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Precision@k — fraction of the top-k results that are relevant.
 *
 * @param ranked Relevance flags for the ranked results, top-first.
 * @param k Cutoff. The denominator is `k` (not the number returned), matching
 *   the textbook definition; a short result list is implicitly padded with
 *   irrelevant slots.
 * @returns Precision in [0, 1]; 0 when `k <= 0`.
 */
export function precisionAtK(ranked: boolean[], k: number): number {
  if (k <= 0) return 0;
  const hits = ranked.slice(0, k).filter(Boolean).length;
  return hits / k;
}

/**
 * Recall@k — fraction of all relevant items that appear in the top-k.
 *
 * @param ranked Relevance flags for the ranked results, top-first.
 * @param k Cutoff.
 * @param totalRelevant Size of the labeled relevant set for the query.
 * @returns Recall in [0, 1]; 0 when there are no relevant items to recall.
 */
export function recallAtK(ranked: boolean[], k: number, totalRelevant: number): number {
  if (totalRelevant <= 0) return 0;
  const hits = ranked.slice(0, k).filter(Boolean).length;
  return hits / totalRelevant;
}

/**
 * Reciprocal rank — 1 / (rank of first relevant result), rank starting at 1.
 *
 * Mean of this across queries is the MRR. Considers the whole ranked list, not
 * just top-k, so callers pass a `ranked` already sliced to k if they want MRR@k.
 *
 * @param ranked Relevance flags for the ranked results, top-first.
 * @returns 1/rank of the first relevant hit, or 0 if none is relevant.
 */
export function reciprocalRank(ranked: boolean[]): number {
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i]) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Hit@k — 1 if at least one relevant item is in the top-k, else 0.
 *
 * @param ranked Relevance flags for the ranked results, top-first.
 * @param k Cutoff.
 * @returns 1 or 0.
 */
export function hitAtK(ranked: boolean[], k: number): number {
  return ranked.slice(0, k).some(Boolean) ? 1 : 0;
}

/**
 * nDCG@k with graded relevance — DCG of the top-k grades over the ideal DCG.
 *
 * Gain = grade, discount = 1/log2(rank+1). Ideal DCG sorts all available grades
 * descending and takes the best k. Linear-gain (not 2^grade - 1) variant, which
 * is the common choice for small integer grade scales.
 *
 * @param gradedRanked Graded relevance of the ranked results, top-first
 *   (0 = irrelevant, higher = more relevant).
 * @param k Cutoff.
 * @param allGrades Every grade in the query's relevant set, used to build the
 *   ideal ranking.
 * @returns nDCG in [0, 1]; 0 when the ideal DCG is 0 (nothing relevant exists).
 */
export function ndcgAtK(gradedRanked: number[], k: number, allGrades: number[]): number {
  const dcg = gradedRanked
    .slice(0, k)
    .reduce((sum, grade, i) => sum + grade / Math.log2(i + 2), 0);
  const idealGrades = [...allGrades].sort((a, b) => b - a).slice(0, k);
  const idcg = idealGrades.reduce((sum, grade, i) => sum + grade / Math.log2(i + 2), 0);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

// ───────────────────────────────────────────────────────────────────────────
// Scorer.
// ───────────────────────────────────────────────────────────────────────────

/** Chunk id used everywhere as the join key: `${source}#${heading}`. */
function chunkId(source: string, heading: string): string {
  return `${source}#${heading}`;
}

function loadIndex(): IndexChunk[] {
  return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as IndexChunk[];
}

function loadGolden(): RetrievalGoldenSet {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as RetrievalGoldenSet;
}

function loadQueryEmbeddings(): Record<string, QueryEmbedding> {
  let raw: string;
  try {
    raw = readFileSync(QUERY_EMB_PATH, "utf8");
  } catch {
    throw new Error("Run `npm run eval:retrieval:embed` to build query embeddings first.");
  }
  return JSON.parse(raw) as Record<string, QueryEmbedding>;
}

/**
 * Rank every index chunk by cosine similarity to the query vector (desc) and
 * return their chunk ids, best-first. Ties break by chunk id for determinism.
 *
 * @param queryEmbedding Frozen query vector.
 * @param index Frozen knowledge-base index.
 * @returns All chunk ids ordered by similarity, highest first.
 */
function rankChunks(queryEmbedding: number[], index: IndexChunk[]): string[] {
  return index
    .map((chunk) => ({
      id: chunkId(chunk.source, chunk.heading),
      score: cosine(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .map((c) => c.id);
}

/** Mean of a numeric list; 0 for an empty list. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Score the RAG retriever offline against the golden retrieval set.
 *
 * Reads the frozen KB index and frozen query embeddings, ranks chunks per query
 * by cosine similarity, and computes Precision@k, Recall@k, MRR, Hit@k and
 * graded nDCG@k. Aggregates are the mean across queries.
 *
 * @param topK Cutoff `k` for all @k metrics. Default 3 (matches the retriever's
 *   default top-K, so the eval mirrors production retrieval depth).
 * @returns A {@link ScorerResult} (layer "L2") with aggregate metrics,
 *   per-query precision/hit ExampleScores, and review flags for zero-hit queries.
 * @throws If `fixtures/query-embeddings.json` is missing — the caller must run
 *   the embed build step first; the scorer never silently passes.
 */
export async function scoreRetrieval(topK = 3): Promise<ScorerResult> {
  const index = loadIndex();
  const golden = loadGolden();
  const queryEmbeddings = loadQueryEmbeddings();

  const k = topK;
  const precisions: number[] = [];
  const recalls: number[] = [];
  const rrs: number[] = [];
  const hits: number[] = [];
  const ndcgs: number[] = [];

  const examples: ExampleScore[] = [];
  const reviewFlags: ReviewFlag[] = [];

  for (const q of golden.queries) {
    const qe = queryEmbeddings[q.id];
    if (!qe) {
      throw new Error(
        `No frozen embedding for query "${q.id}". Re-run \`npm run eval:retrieval:embed\` ` +
          `after editing golden/retrieval/retrieval-set.json.`,
      );
    }

    const relevantGrade = buildGradeMap(q);
    const rankedIds = rankChunks(qe.embedding, index);
    const topIds = rankedIds.slice(0, k);

    const rankedFlags = topIds.map((id) => (relevantGrade.get(id) ?? 0) > 0);
    const gradedRanked = topIds.map((id) => relevantGrade.get(id) ?? 0);
    const allGrades = q.relevant.map((r) => r.grade);

    const precision = precisionAtK(rankedFlags, k);
    const recall = recallAtK(rankedFlags, k, q.relevant.length);
    const rr = reciprocalRank(rankedFlags);
    const hit = hitAtK(rankedFlags, k);
    const ndcg = ndcgAtK(gradedRanked, k, allGrades);

    precisions.push(precision);
    recalls.push(recall);
    rrs.push(rr);
    hits.push(hit);
    ndcgs.push(ndcg);

    examples.push({
      id: q.id,
      metricKey: `l2.precision_at_${k}`,
      value: precision,
      detail: `top${k}=[${topIds.join(", ")}]`,
    });
    examples.push({
      id: q.id,
      metricKey: `l2.hit_at_${k}`,
      value: hit,
    });

    if (hit === 0) {
      reviewFlags.push({
        id: q.id,
        reason: `zero relevant chunk in top-${k} for "${q.query}"`,
        scores: { [`l2.precision_at_${k}`]: precision, [`l2.recall_at_${k}`]: recall, "l2.ndcg_at_k": ndcg },
      });
    }
  }

  const metrics: Metric[] = [
    { key: `l2.precision_at_${k}`, value: mean(precisions), greaterIsBetter: true, unit: "ratio" },
    { key: `l2.recall_at_${k}`, value: mean(recalls), greaterIsBetter: true, unit: "ratio" },
    { key: "l2.mrr", value: mean(rrs), greaterIsBetter: true, unit: "ratio" },
    { key: `l2.hit_at_${k}`, value: mean(hits), greaterIsBetter: true, unit: "ratio" },
    { key: `l2.ndcg_at_${k}`, value: mean(ndcgs), greaterIsBetter: true, unit: "ratio" },
  ];

  return { layer: "L2", name: "L2 Retrieval", metrics, examples, reviewFlags };
}

/** Map a query's labeled chunk ids to their grade (>0 means relevant). */
function buildGradeMap(q: RetrievalGoldenQuery): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of q.relevant) map.set(r.chunk, r.grade);
  return map;
}

// Standalone smoke run: `npx tsx scorers/l2-retrieval.ts`. Prints the metrics.
// Guarded so importing this module (from the eval-runner or tests) is side-effect free.
if (import.meta.url === `file://${process.argv[1]}`) {
  scoreRetrieval()
    .then((result) => {
      console.log(`\n${result.name} (${result.layer})`);
      for (const m of result.metrics) {
        console.log(`  ${m.key} = ${m.value.toFixed(4)}`);
      }
      if (result.reviewFlags && result.reviewFlags.length > 0) {
        console.log(`\n  Review queue (${result.reviewFlags.length}):`);
        for (const f of result.reviewFlags) console.log(`   - ${f.id}: ${f.reason}`);
      }
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
