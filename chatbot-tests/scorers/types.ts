/**
 * Shared contract for the chatbot eval pipeline (Module 3).
 *
 * Every scorer (L1/L2/L3/safety), the eval-runner, and the regression gate
 * import from this file. Keeping the interfaces here is what lets the scorers
 * be developed independently without drifting apart.
 *
 * Pipeline (slide 7): Golden Dataset → Offline Eval Runner → Scorer (L1+L2+L3)
 *                     → Regression Gate, plus a Human Review Queue.
 * Layers (slide 6):   L1 model · L2 retrieval · L3 trajectory · SAFETY guard.
 */

// ───────────────────────────────────────────────────────────────────────────
// Chatbot turn record (subset of chatbot's ConversationTurn we assert on).
// Mirrors the shape returned by `processTurn().record` and logged to
// logs/conversations.jsonl.
// ───────────────────────────────────────────────────────────────────────────

export type GuardVerdict = "safe" | "suspicious" | "malicious";

export interface TurnRecord {
  guard: { verdict: GuardVerdict; block: boolean; reasons?: string[] };
  router: { intent: string; confidence: number };
  retrieval: Array<{ source: string; heading: string; score: number }>;
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  tokensUsed: { prompt: number; completion: number };
  latencyMs: number;
  costUsd?: number;
  agentResponse: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Scorer output. Every scorer returns a ScorerResult.
// ───────────────────────────────────────────────────────────────────────────

export type Layer = "L1" | "L2" | "L3" | "SAFETY";

/** A single aggregate metric value emitted by a scorer (gate watches these). */
export interface Metric {
  /** Stable dotted key, e.g. "l2.precision_at_3", "safety.recall", "cost.usd_per_turn". */
  key: string;
  value: number;
  /** Direction: true = higher is better (precision), false = lower is better (latency, cost, FPR). */
  greaterIsBetter: boolean;
  unit?: "ratio" | "ms" | "usd" | "count";
}

/** Per-example contribution to a metric — enables per-example regression detection. */
export interface ExampleScore {
  /** Scenario / query / corpus-item id. */
  id: string;
  metricKey: string;
  value: number;
  detail?: string;
}

/** A turn flagged for the Human Review Queue (distribution-shift / low-confidence). */
export interface ReviewFlag {
  id: string;
  reason: string;
  scores: Record<string, number>;
}

export interface ScorerResult {
  layer: Layer;
  /** Human label, e.g. "L2 Retrieval", "Guard classifier". */
  name: string;
  metrics: Metric[];
  examples: ExampleScore[];
  reviewFlags?: ReviewFlag[];
}

// ───────────────────────────────────────────────────────────────────────────
// Unified report (eval-runner output) + baseline + gate config.
// ───────────────────────────────────────────────────────────────────────────

export interface EvalReport {
  meta: {
    ts: string;
    commit: string | null;
    backend: string | null;
    /** true when the run used only frozen fixtures (0 LLM calls). */
    offline: boolean;
  };
  scorers: ScorerResult[];
  /** All metrics flattened by key, for the gate. */
  metrics: Record<string, Metric>;
}

export interface Baseline {
  captured: string;
  commit: string | null;
  metrics: Record<string, { value: number; greaterIsBetter: boolean }>;
}

/**
 * Gate tolerances. A metric fails if it moves in the worse direction by more
 * than the tolerance. Absolute is in metric units (0.05 = 5pp for ratios);
 * relative is proportional (0.1 = 10% of baseline). Per-metric overrides win.
 */
export interface GateConfig {
  absoluteTolerance: number;
  relativeTolerance?: number;
  perMetric?: Record<string, { absoluteTolerance?: number; relativeTolerance?: number }>;
}

// ───────────────────────────────────────────────────────────────────────────
// Scenario / golden-dataset schemas.
// ───────────────────────────────────────────────────────────────────────────

export type TrajectoryMatchMode = "strict" | "unordered" | "subset" | "superset";

/** L3 trajectory expectations (slide 6: tool sequence, step efficiency, terminal state). */
export interface TrajectoryExpect {
  /** Expected tool-call names. */
  tool_sequence?: string[];
  /** How tool_sequence is compared. Default "strict" (exact order). */
  match_mode?: TrajectoryMatchMode;
  /** Expected arguments per tool (subset match — only listed keys are checked). */
  tool_args?: Record<string, Record<string, unknown>>;
  /** Predicate over the final turn's record (e.g. { ticket_created: true }). */
  terminal_state?: Record<string, unknown>;
  /** Step-efficiency cap: max number of agent/tool hops. */
  max_steps?: number;
}

/** One labeled query in the L2 retrieval golden set. */
export interface RetrievalGoldenQuery {
  id: string;
  query: string;
  /** Relevant chunks identified as "source.md#Heading", with graded relevance. */
  relevant: Array<{ chunk: string; grade: number }>;
}

export interface RetrievalGoldenSet {
  /** Embedding model the frozen query vectors were built with — guards staleness. */
  embeddingModel?: string;
  queries: RetrievalGoldenQuery[];
}

/** One labeled item in the safety guard corpus. */
export interface GuardCorpusItem {
  id: string;
  text: string;
  /** Ground truth: should the lexical guard block this? */
  label: "safe" | "malicious";
  /** Optional category (jailbreak, pii, over-refusal-trap, …) for per-category breakdown. */
  category?: string;
  language?: string;
}
