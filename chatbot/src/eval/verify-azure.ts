#!/usr/bin/env tsx
/**
 * Verify Azure OpenAI deployment connectivity.
 *
 * Runs two minimal calls — one chat completion, one embedding — against the
 * deployments configured in .env. Prints success / failure for each so we
 * can confirm both models are deployed and reachable before running the
 * full ingest pipeline.
 *
 * Usage:
 *   npx tsx src/eval/verify-azure.ts
 */

import {
  getChatClient,
  getChatModel,
  getEmbeddingModel,
  detectBackend,
} from "../llm-client.js";

async function main(): Promise<void> {
  const backend = detectBackend();
  console.log(`Backend detected: ${backend}`);
  console.log(`Chat deployment:      ${getChatModel()}`);
  console.log(`Embedding deployment: ${getEmbeddingModel()}\n`);

  if (backend !== "azure") {
    console.error(
      "❌ Expected azure backend but detected openai. Check AZURE_OPENAI_* env vars.",
    );
    process.exit(1);
  }

  const client = getChatClient();

  // --- Chat ---
  console.log("Testing chat completion …");
  try {
    const chat = await client.chat.completions.create({
      model: getChatModel(),
      max_tokens: 20,
      messages: [
        { role: "system", content: "Reply with exactly: OK" },
        { role: "user", content: "ping" },
      ],
    });
    const text = chat.choices[0]?.message?.content?.trim();
    console.log(`✅ Chat OK — response: "${text}"`);
    console.log(
      `   usage: prompt=${chat.usage?.prompt_tokens} completion=${chat.usage?.completion_tokens}`,
    );
  } catch (err) {
    console.error(
      `❌ Chat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  // --- Embedding ---
  console.log("\nTesting embedding …");
  try {
    const emb = await client.embeddings.create({
      model: getEmbeddingModel(),
      input: "Kolik stojí inzerát?",
    });
    const dim = emb.data[0]?.embedding.length ?? 0;
    console.log(`✅ Embedding OK — vector dimension: ${dim}`);
    console.log(`   usage: prompt=${emb.usage?.prompt_tokens}`);
  } catch (err) {
    console.error(
      `❌ Embedding failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(3);
  }

  console.log("\n✅ Both deployments reachable. Ready to ingest the KB.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(99);
});
