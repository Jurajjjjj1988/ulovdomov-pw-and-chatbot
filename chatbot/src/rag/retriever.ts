/**
 * In-memory vector retriever.
 *
 * On production (Azure deployment), swap this for Azure Cognitive Search or
 * Azure AI Search — they expose the same query/result shape over HTTP, so the
 * public interface (`retrieve()`) stays identical. The in-memory variant keeps
 * the project zero-infra for local development and portfolio demo purposes.
 *
 * Architecture is intentionally simple:
 *   1. Knowledge base = markdown files under `knowledge-base/`
 *   2. Each file is split into chunks at H2/H3 headings (keeps semantic units)
 *   3. Each chunk is embedded via the LLM provider's embedding endpoint
 *   4. Query embedding is compared via cosine similarity against all chunks
 *   5. Top-K returned with score
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getChatClient, getEmbeddingModel } from "../llm-client.js";

export interface KnowledgeChunk {
  source: string;
  heading: string;
  content: string;
  embedding: number[];
}

export interface RetrievedChunk {
  source: string;
  heading: string;
  content: string;
  score: number;
}

const INDEX_PATH = "knowledge-base/.index.json";

let cachedIndex: KnowledgeChunk[] | null = null;

/** Load the pre-computed index from disk. Run `npm run ingest:kb` to build it. */
export function loadIndex(): KnowledgeChunk[] {
  if (cachedIndex) return cachedIndex;
  if (!existsSync(INDEX_PATH)) {
    throw new Error(
      `RAG index not found at ${INDEX_PATH}. Run \`npm run ingest:kb\` first to build it from knowledge-base/*.md.`,
    );
  }
  const raw = readFileSync(INDEX_PATH, "utf8");
  cachedIndex = JSON.parse(raw) as KnowledgeChunk[];
  return cachedIndex;
}

export function saveIndex(chunks: KnowledgeChunk[]): void {
  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(chunks, null, 0), "utf8");
}

/** Cosine similarity between two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embed(text: string): Promise<number[]> {
  const client = getChatClient();
  const result = await client.embeddings.create({
    model: getEmbeddingModel(),
    input: text,
  });
  const embedding = result.data[0]?.embedding;
  if (!embedding) {
    throw new Error("Embedding endpoint returned no vector.");
  }
  return embedding;
}

/**
 * Retrieve top-K chunks most semantically similar to the query.
 *
 * Scores below `minScore` are filtered out — the system prompt's RAG block
 * should contain only relevant context, not low-similarity noise that would
 * dilute the answer.
 */
export async function retrieve(
  query: string,
  topK = 3,
  minScore = 0.3,
): Promise<RetrievedChunk[]> {
  const index = loadIndex();
  const queryEmbedding = await embed(query);
  const scored = index
    .map((chunk) => ({
      source: chunk.source,
      heading: chunk.heading,
      content: chunk.content,
      score: cosine(queryEmbedding, chunk.embedding),
    }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored;
}

export { embed };
