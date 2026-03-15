/**
 * Endpoint-agnostic LLM client.
 *
 * Wraps the OpenAI SDK so the same code path works against:
 *   - OpenAI direct (default — uses OPENAI_API_KEY)
 *   - Azure OpenAI Service (when AZURE_OPENAI_ENDPOINT is set)
 *
 * The Azure variant is the same wire protocol with a different base URL and
 * an api-version query parameter. This lets the rest of the codebase stay
 * vendor-agnostic — `getChatClient()` returns the same `OpenAI` instance
 * regardless of the backend.
 */

import OpenAI, { AzureOpenAI } from "openai";
import "dotenv/config";

let cachedClient: OpenAI | null = null;
let cachedBackend: "openai" | "azure" | null = null;

/** Detect which backend is configured. */
export function detectBackend(): "openai" | "azure" {
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
    throw new Error("OPENAI_API_KEY missing — set it in .env or use Azure config.");
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

/** Model / deployment name resolver — Azure uses deployment names, OpenAI uses model names. */
export function getChatModel(): string {
  const backend = cachedBackend ?? detectBackend();
  if (backend === "azure") {
    return process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "gpt-4o-mini";
  }
  return process.env.CHAT_MODEL ?? "gpt-4o-mini";
}

export function getEmbeddingModel(): string {
  const backend = cachedBackend ?? detectBackend();
  if (backend === "azure") {
    return process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? "text-embedding-3-small";
  }
  return process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
}

export function getTemperature(): number {
  const raw = process.env.CHAT_TEMPERATURE;
  if (!raw) return 0.3;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0.3;
}
