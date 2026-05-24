#!/usr/bin/env tsx
/**
 * Interactive CLI for local chatbot testing.
 *
 * Prints intent routing + RAG retrieval traces alongside the response so the
 * developer can see what the chatbot "thought" each turn. Useful for prompt
 * iteration and for demo purposes.
 *
 * Type a message and press Enter. Ctrl-C to exit.
 *
 * Each session generates a fresh conversation ID; turns are persisted to the
 * conversation log so you can `npm run analyze:logs` afterward.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import chalk from "chalk";

import { ChatSession } from "./chat-session.js";
import { detectBackend } from "./llm-client.js";
import { formatCostUsd } from "./cost-tracker.js";

function formatBackend(backend: ReturnType<typeof detectBackend>): string {
  if (backend === "azure") return "Azure OpenAI";
  if (backend === "github-models") return "GitHub Models";
  return "OpenAI direct";
}

async function main(): Promise<void> {
  const backend = detectBackend();
  const session = new ChatSession();

  console.log(chalk.bold.cyan(`\n🤖 úlovdomov chatbot — interactive CLI`));
  console.log(chalk.gray(`   LLM backend: ${formatBackend(backend)}`));
  console.log(chalk.gray(`   Conversation ID: ${session.conversationId.slice(0, 8)}…`));
  console.log(chalk.gray(`   Type your message and press Enter. Ctrl-C to exit.\n`));

  const rl = createInterface({ input: stdin, output: stdout });

  while (true) {
    const userMessage = await rl.question(chalk.bold("👤 > "));
    if (!userMessage.trim()) continue;

    try {
      const { response, intent, record } = await session.send(userMessage);

      // Traces
      console.log(
        chalk.gray(
          `   [router] intent=${intent} confidence=${record.router.confidence.toFixed(2)}`,
        ),
      );
      if (record.retrieval.length > 0) {
        const sources = record.retrieval
          .map((r) => `${r.source} (${r.score.toFixed(2)})`)
          .join(", ");
        console.log(chalk.gray(`   [rag] ${sources}`));
      }
      if (record.toolCalls.length > 0) {
        const tools = record.toolCalls.map((t) => t.name).join(", ");
        console.log(chalk.gray(`   [tool] ${tools}`));
      }
      console.log(
        chalk.gray(
          `   [latency] ${record.latencyMs} ms · [tokens] ${record.tokensUsed.prompt}p + ${record.tokensUsed.completion}c · [cost] ${formatCostUsd(record.costUsd)}\n`,
        ),
      );

      // Response
      console.log(chalk.bold.green("🤖 "));
      console.log(`${response}\n`);
    } catch (err) {
      console.error(chalk.red("\nError:"), err instanceof Error ? err.message : String(err));
      console.log();
    }
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
