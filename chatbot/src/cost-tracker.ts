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
  // gpt-5.4 family — current Azure AI Foundry catalog (June 2026 refresh).
  // gpt-5.4-nano is the cheapest production-grade chat model; perfect fit for
  // FAQ-style customer support. Pricing assumed in line with prior generation
  // gap; refine when Microsoft publishes the official Azure pricing page.
  "gpt-5.4-nano": { inputPer1M: 0.05, outputPer1M: 0.2 },
  "gpt-5.4-mini": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5.4": { inputPer1M: 1.25, outputPer1M: 10 },
  // gpt-5 series (legacy / fallback)
  "gpt-5-mini": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2 },
  "gpt-5": { inputPer1M: 1.25, outputPer1M: 10 },
  // Mistral models via Azure Foundry serverless. Small / cheap / multilingual.
  "ministral-3b": { inputPer1M: 0.04, outputPer1M: 0.04 },
  "mistral-small-2503": { inputPer1M: 0.1, outputPer1M: 0.3 },
  "mistral-large-2411": { inputPer1M: 2, outputPer1M: 6 },
  // gpt-4o family — kept for backward compatibility with older deployments.
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  // o1-mini — reasoning model, much more expensive output.
  "o1-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
};

const EMBEDDING_PRICING: Record<string, ModelPricing> = {
  "text-embedding-3-small": { inputPer1M: 0.02, outputPer1M: 0 },
  "text-embedding-3-large": { inputPer1M: 0.13, outputPer1M: 0 },
  // Cohere multilingual embeddings via Azure Foundry serverless deployment —
  // ~100 languages including Czech/Slovak with stronger cross-language
  // semantic search than OpenAI's English-centric embeddings.
  "cohere-embed-v3-multilingual": { inputPer1M: 0.1, outputPer1M: 0 },
  "cohere-embed-v4": { inputPer1M: 0.12, outputPer1M: 0 },
};

/**
 * Azure OpenAI pricing is typically within ~5% of OpenAI direct for the same
 * model. We don't carry a separate table; if you need exact billing, pull
 * the real prices from the Azure cost-management API at run-time.
 */
const AZURE_MULTIPLIER = 1;

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

// Fallback used when an unknown model is requested. Set high enough that a
// typo doesn't silently underestimate cost in dashboards.
const UNKNOWN_MODEL_FALLBACK: ModelPricing = { inputPer1M: 0.15, outputPer1M: 0.6 };

/** Estimate cost in USD for a single chat completion. */
export function estimateChatCostUsd(
  model: string,
  usage: TokenUsage,
  backend: Backend = "openai",
): number {
  const pricing = CHAT_PRICING[model] ?? UNKNOWN_MODEL_FALLBACK;
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
  const pricing = EMBEDDING_PRICING[model] ?? UNKNOWN_MODEL_FALLBACK;
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
