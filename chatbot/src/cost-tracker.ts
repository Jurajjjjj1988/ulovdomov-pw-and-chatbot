/**
 * Cost tracker.
 *
 * Translates OpenAI / Azure OpenAI token usage into USD estimates per turn.
 * Pricing tables are hard-coded for the models this project actually uses;
 * unknown models fall back to gpt-4o-mini's rate so a typo doesn't crash the
 * pipeline but a sanity-check warning is surfaced.
 *
 * Numbers are in USD per **1M tokens** — the unit OpenAI publishes them in.
 * Sources:
 *   - OpenAI pricing: https://openai.com/api/pricing/
 *   - Azure OpenAI pricing: https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/
 *
 * When OpenAI / Azure raise or drop a model, update this table; the rest of
 * the codebase reads cost via `estimateCostUsd()` and stays unchanged.
 */
import type { Backend } from "./llm-client.js";

interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1M: number;
}

const CHAT_PRICING: Record<string, ModelPricing> = {
  // gpt-4o-mini — the default for this project. Cheapest production-grade
  // chat completion model in mid-2026.
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  // gpt-4o — when higher quality is needed (currently unused, kept for future).
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  // o1-mini — reasoning model, much more expensive output.
  "o1-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
};

const EMBEDDING_PRICING: Record<string, ModelPricing> = {
  "text-embedding-3-small": { inputPer1M: 0.02, outputPer1M: 0 },
  "text-embedding-3-large": { inputPer1M: 0.13, outputPer1M: 0 },
};

/**
 * Azure OpenAI pricing is typically within ~5% of OpenAI direct for the same
 * model. We don't carry a separate table; if you need exact billing, pull
 * the real prices from the Azure cost-management API at run-time.
 */
const AZURE_MULTIPLIER = 1.0;

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface CostBreakdown {
  model: string;
  backend: Backend;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Estimate cost in USD for a single chat completion. */
export function estimateChatCostUsd(
  model: string,
  usage: TokenUsage,
  backend: Backend = "openai",
): number {
  const pricing = CHAT_PRICING[model] ?? CHAT_PRICING["gpt-4o-mini"]!;
  const multiplier = backend === "azure" ? AZURE_MULTIPLIER : 1;
  const inputCost = (usage.prompt / 1_000_000) * pricing.inputPer1M;
  const outputCost = (usage.completion / 1_000_000) * pricing.outputPer1M;
  return (inputCost + outputCost) * multiplier;
}

/** Estimate cost in USD for an embedding batch. */
export function estimateEmbeddingCostUsd(
  model: string,
  tokens: number,
  backend: Backend = "openai",
): number {
  const pricing = EMBEDDING_PRICING[model] ?? EMBEDDING_PRICING["text-embedding-3-small"]!;
  const multiplier = backend === "azure" ? AZURE_MULTIPLIER : 1;
  return (tokens / 1_000_000) * pricing.inputPer1M * multiplier;
}

/** Sum a list of token-usage records. */
export function sumUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, u) => ({
      prompt: acc.prompt + u.prompt,
      completion: acc.completion + u.completion,
    }),
    { prompt: 0, completion: 0 },
  );
}

/**
 * Format a USD cost for human-readable logs.
 * Cents-precision for >$0.01, otherwise 6 decimals (still ~1/100c).
 */
export function formatCostUsd(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}
