/**
 * Endpoint-agnostic LLM client.
 *
 * Wraps the OpenAI SDK so the same code path works against three backends
 * without touching agent code:
 *
 *   - **GitHub Models** — Microsoft's "try before Azure" gateway, free with a
 *     GitHub PAT, OpenAI-compatible at https://models.inference.ai.azure.com.
 *     Picked first when GITHUB_MODELS_TOKEN is set.
 *   - **Azure OpenAI** — picked when AZURE_OPENAI_ENDPOINT + key are set.
 *     Same wire protocol; just a different base URL + api-version query param.
 *   - **OpenAI direct** — fallback, uses OPENAI_API_KEY.
 *
 * Priority order matches the most-common dev experience (free GitHub Models
 * first, then enterprise Azure, then OpenAI personal) so an account upgrade
 * doesn't require code changes — just a .env tweak.
 */

import OpenAI, { AzureOpenAI } from "openai";
import "dotenv/config";

export type Backend = "openai" | "azure" | "github-models";

let cachedClient: OpenAI | null = null;
let cachedBackend: Backend | null = null;

const GITHUB_MODELS_BASE_URL = "https://models.inference.ai.azure.com";

/** Detect which backend is configured. */
export function detectBackend(): Backend {
  if (process.env.GITHUB_MODELS_TOKEN) {
    return "github-models";
  }
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
    return "azure";
  }
  return "openai";
}

/** Return the chat completions client. Memoised — one instance per process. */
export function getChatClient(): OpenAI {
  if (cachedClient) return cachedClient;

  const backend = detectBackend();
  cachedBackend = backend;

  if (backend === "github-models") {
    const token = process.env.GITHUB_MODELS_TOKEN;
    if (!token) {
      throw new Error("github-models backend selected but GITHUB_MODELS_TOKEN missing.");
    }
    // GitHub Models is OpenAI-compatible — point the SDK at its base URL and
    // pass the PAT as the bearer token. Rate-limited (~15 RPM, 150 RPD on
    // free tier) but enough for demo / portfolio use.
    cachedClient = new OpenAI({
      apiKey: token,
      baseURL: GITHUB_MODELS_BASE_URL,
    });
    return cachedClient;
  }

  if (backend === "azure") {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
    const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
    if (!endpoint || !apiKey || !deployment) {
      throw new Error(
        "Azure backend selected but AZURE_OPENAI_ENDPOINT / _API_KEY / _CHAT_DEPLOYMENT not all set.",
      );
    }
    cachedClient = new AzureOpenAI({
      endpoint,
      apiKey,
      apiVersion,
      deployment,
    });
    return cachedClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No LLM backend configured. Set GITHUB_MODELS_TOKEN, AZURE_OPENAI_*, or OPENAI_API_KEY in .env.",
    );
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

/**
 * Model / deployment name resolver.
 *
 * - Azure: deployment name (what you typed when deploying the model)
 * - GitHub Models: model identifier from the GitHub Models catalog
 *   (e.g. "gpt-4o-mini", "Phi-4", "DeepSeek-R1")
 * - OpenAI: model name
 */
export function getChatModel(): string {
  const backend = cachedBackend ?? detectBackend();
  if (backend === "azure") {
    return process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "gpt-4o-mini";
  }
  if (backend === "github-models") {
    return process.env.GITHUB_MODELS_CHAT_MODEL ?? "gpt-4o-mini";
  }
  return process.env.CHAT_MODEL ?? "gpt-4o-mini";
}

export function getEmbeddingModel(): string {
  const backend = cachedBackend ?? detectBackend();
  if (backend === "azure") {
    return process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? "text-embedding-3-small";
  }
  if (backend === "github-models") {
    return process.env.GITHUB_MODELS_EMBEDDING_MODEL ?? "text-embedding-3-small";
  }
  return process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
}

export function getTemperature(): number {
  const raw = process.env.CHAT_TEMPERATURE;
  if (!raw) return 0.3;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0.3;
}
