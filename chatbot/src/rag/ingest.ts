#!/usr/bin/env tsx
/**
 * Build the RAG index from `knowledge-base/*.md`.
 *
 * Splits each markdown file at H2/H3 headings (semantic chunks), embeds each
 * chunk with the configured embedding model, and writes the result to
 * `knowledge-base/.index.json` which the retriever consumes.
 *
 * Run via: `npm run ingest:kb`
 *
 * Idempotent — safe to re-run after editing knowledge base files. v0.2 will
 * support incremental updates (hash content per chunk, only re-embed changed
 * ones — saves embedding cost on large KBs).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { chunkMarkdown } from "./knowledge-base.js";
import { embed, saveIndex, type KnowledgeChunk } from "./retriever.js";

const KB_DIR = "knowledge-base";

async function main(): Promise<void> {
  const files = readdirSync(KB_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .sort();

  console.log(`Found ${files.length} markdown file(s) in ${KB_DIR}/`);

  const allChunks: KnowledgeChunk[] = [];

  for (const file of files) {
    const path = join(KB_DIR, file);
    const content = readFileSync(path, "utf8");
    const chunks = chunkMarkdown(content, file);
    console.log(`  ${file} → ${chunks.length} chunk(s)`);

    for (const chunk of chunks) {
      const embedding = await embed(`${chunk.heading}\n\n${chunk.content}`);
      allChunks.push({
        source: chunk.source,
        heading: chunk.heading,
        content: chunk.content,
        embedding,
      });
    }
  }

  saveIndex(allChunks);
  console.log(`\n✓ Index written with ${allChunks.length} chunks.`);
}

main().catch((err: unknown) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
