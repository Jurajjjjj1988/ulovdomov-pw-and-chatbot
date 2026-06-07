#!/usr/bin/env tsx
/**
 * Build step: freeze the golden retrieval queries into embedding vectors.
 *
 * This is the ONLY file in the L2 retrieval path that touches the live
 * embedding API. It loads the golden set, embeds each query through the
 * chatbot's own `embed()` function (so the query vectors match the index
 * vectors' model + dimensionality), and writes the frozen vectors to
 * `fixtures/query-embeddings.json`. The scorer then runs fully offline.
 *
 * Re-run whenever you edit `golden/retrieval/retrieval-set.json` OR the chatbot
 * changes its embedding model — stale query vectors silently distort retrieval
 * metrics. The recorded `embeddingModel` (also written back into the golden
 * set's top-level field) is the staleness tripwire.
 *
 * Run via: `npm run eval:retrieval:embed` (or `npx tsx fixtures/build-query-embeddings.ts`).
 *
 * Exit codes:
 *   0  — embeddings written
 *   1  — golden set unreadable / write failed
 *   2  — chatbot package not reachable (run `npm install` in ../chatbot/)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { RetrievalGoldenSet } from "../scorers/types.js";

const CHATBOT_ROOT = resolve("../chatbot");
const RETRIEVER_PATH = resolve(CHATBOT_ROOT, "src/rag/retriever.ts");
const GOLDEN_PATH = resolve("golden/retrieval/retrieval-set.json");
const OUTPUT_PATH = resolve("fixtures/query-embeddings.json");

/**
 * Load the chatbot's `.env` BEFORE importing the chatbot package, so the
 * embedding client can detect the backend (llm-client.ts reads process.env at
 * import time). Mirrors the minimal parser in replay.ts — avoids pulling
 * `dotenv` into chatbot-tests just for this.
 */
function loadChatbotEnv(): void {
  const envPath = resolve(CHATBOT_ROOT, ".env");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return; // .env optional — the embed call fails with a clearer error if no backend
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** One frozen query vector entry written to query-embeddings.json. */
interface QueryEmbeddingEntry {
  embedding: number[];
  embeddingModel: string;
}

type Embed = (text: string) => Promise<number[]>;

/**
 * Resolve the embedding model name the same way the chatbot's retriever does,
 * so the recorded model matches the vectors actually produced. Prefers the
 * generic EMBEDDING_MODEL, falling back to the GitHub Models backend var.
 *
 * @returns The embedding model identifier, or "unknown" if neither var is set.
 */
function resolveEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL ?? process.env.GITHUB_MODELS_EMBEDDING_MODEL ?? "unknown";
}

/**
 * Dynamically import the chatbot's `embed()` via a file URL — the same pattern
 * proven in replay.ts for loading the chatbot's TS entrypoint from a sibling
 * package without a build step.
 *
 * @returns The chatbot's `embed` function.
 */
async function loadEmbed(): Promise<Embed> {
  const mod = (await import(pathToFileURL(RETRIEVER_PATH).href)) as { embed: Embed };
  return mod.embed;
}

async function main(): Promise<void> {
  loadChatbotEnv();

  let golden: RetrievalGoldenSet;
  try {
    golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as RetrievalGoldenSet;
  } catch (err) {
    console.error(`❌ Cannot read golden set at ${GOLDEN_PATH}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let embed: Embed;
  try {
    embed = await loadEmbed();
  } catch (err) {
    console.error(`❌ Cannot load chatbot embedder at ${RETRIEVER_PATH}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    console.error(`   Run 'npm install' in ../chatbot/ first.`);
    process.exit(2);
  }

  const embeddingModel = resolveEmbeddingModel();
  console.log(`\n🧊 Freezing ${golden.queries.length} query embeddings (model: ${embeddingModel})\n`);

  const out: Record<string, QueryEmbeddingEntry> = {};
  for (const q of golden.queries) {
    const embedding = await embed(q.query);
    out[q.id] = { embedding, embeddingModel };
    console.log(`   ✓ ${q.id} (${embedding.length} dims)`);
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 0), "utf8");

  // Stamp the model back into the golden set so a later index re-embed under a
  // different model is visible as a mismatch.
  golden.embeddingModel = embeddingModel;
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`, "utf8");

  console.log(`\n✅ Wrote ${OUTPUT_PATH}`);
  console.log(`   Stamped embeddingModel="${embeddingModel}" into ${GOLDEN_PATH}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
