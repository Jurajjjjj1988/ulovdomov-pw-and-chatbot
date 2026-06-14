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

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import chalk from "chalk";

import { processTurn } from "./index.js";
import { detectBackend } from "./llm-client.js";
import { formatCostUsd } from "./cost-tracker.js";

async function main(): Promise<void> {
  const backend = detectBackend();
  console.log(chalk.bold.cyan(`\n🤖 úlovdomov chatbot — interactive CLI`));
  console.log(chalk.gray(`   LLM backend: ${backend === "azure" ? "Azure OpenAI" : "OpenAI direct"}`));
  console.log(chalk.gray(`   Conversation ID: ${randomUUID().slice(0, 8)}…`));
  console.log(chalk.gray(`   Type your message and press Enter. Ctrl-C to exit.\n`));

  const conversationId = randomUUID();
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let turn = 1;

  const rl = createInterface({ input: stdin, output: stdout });

  while (true) {
    const userMessage = await rl.question(chalk.bold("👤 > "));
    if (!userMessage.trim()) continue;

    try {
      const { response, intent, record } = await processTurn({
        userMessage,
        conversationId,
        turn,
        history,
      });

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

      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: response });
      turn++;
    } catch (err) {
      console.error(chalk.red("\nError:"), err instanceof Error ? err.message : String(err));
      console.log();
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
