#!/usr/bin/env tsx
/**
 * Conversation log analyzer.
 *
 * Reads the JSONL log produced by `conversation-log.ts` and reports:
 *   - Intent distribution (how often each route fires)
 *   - Average router confidence per intent (signal: which prompts need work)
 *   - Top-K most retrieved RAG sources (signal: what users actually ask)
 *   - Escalation rate over time (signal: chatbot quality regression)
 *   - Average response latency + token cost per turn
 *
 * v0.2 will add:
 *   - RAGAS-style faithfulness score (does the answer cite retrieved chunks?)
 *   - Intent confusion matrix (requires labeled set, optional --labels flag)
 *   - Cost projection (dollars/day at current rate)
 *
 * Run via: `npm run analyze:logs -- [--top-k 10] [--from YYYY-MM-DD]`
 */

import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";

interface ConversationTurnRow {
  ts: string;
  conversationId: string;
  router: { intent: string; confidence: number };
  retrieval: Array<{ source: string; score: number }>;
  toolCalls: Array<{ name: string }>;
  latencyMs: number;
  tokensUsed: { prompt: number; completion: number };
}

function loadRows(path: string): ConversationTurnRow[] {
  if (!existsSync(path)) {
    console.error(`No log at ${path}. Run \`npm run chat\` to generate some.`);
    process.exit(1);
  }
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ConversationTurnRow);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      "log-path": { type: "string", default: "./logs/conversations.jsonl" },
      "top-k": { type: "string", default: "10" },
      from: { type: "string" },
    },
  });

  const path = String(values["log-path"]);
  const topK = Number.parseInt(String(values["top-k"]), 10);
  const fromDate = typeof values.from === "string" ? values.from : null;

  let rows = loadRows(path);
  if (fromDate) {
    rows = rows.filter((r) => r.ts.slice(0, 10) >= fromDate);
  }

  if (rows.length === 0) {
    console.log("No turns to analyze.");
    return;
  }

  console.log(`\n📊 Analyzed ${rows.length} turn(s) from ${path}\n`);

  // --- Intent distribution ---
  const intentCounts = new Map<string, number>();
  const intentConfSum = new Map<string, number>();
  for (const r of rows) {
    intentCounts.set(r.router.intent, (intentCounts.get(r.router.intent) ?? 0) + 1);
    intentConfSum.set(
      r.router.intent,
      (intentConfSum.get(r.router.intent) ?? 0) + r.router.confidence,
    );
  }
  console.log("Intent distribution:");
  for (const [intent, count] of [...intentCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / rows.length) * 100).toFixed(1);
    const avgConf = ((intentConfSum.get(intent) ?? 0) / count).toFixed(2);
    console.log(`  ${intent.padEnd(20)} ${count.toString().padStart(4)} (${pct}%)  avg confidence: ${avgConf}`);
  }

  // --- Top-K RAG sources ---
  const sourceCounts = new Map<string, number>();
  for (const r of rows) {
    for (const ret of r.retrieval) {
      sourceCounts.set(ret.source, (sourceCounts.get(ret.source) ?? 0) + 1);
    }
  }
  console.log(`\nTop ${topK} RAG sources:`);
  const sortedSources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  for (const [source, count] of sortedSources) {
    console.log(`  ${source.padEnd(40)} ${count.toString().padStart(4)}`);
  }

  // --- Escalation rate ---
  const escalationCount = rows.filter((r) =>
    r.toolCalls.some((t) => t.name === "create_support_ticket"),
  ).length;
  const escalationRate = ((escalationCount / rows.length) * 100).toFixed(1);
  console.log(`\nEscalation rate: ${escalationCount}/${rows.length} (${escalationRate}%)`);

  // --- Latency + tokens ---
  const totalLatency = rows.reduce((acc, r) => acc + r.latencyMs, 0);
  const totalTokensIn = rows.reduce((acc, r) => acc + r.tokensUsed.prompt, 0);
  const totalTokensOut = rows.reduce((acc, r) => acc + r.tokensUsed.completion, 0);
  console.log(`\nAverage latency: ${(totalLatency / rows.length).toFixed(0)} ms/turn`);
  console.log(
    `Average tokens:  ${(totalTokensIn / rows.length).toFixed(0)} prompt, ` +
      `${(totalTokensOut / rows.length).toFixed(0)} completion`,
  );
}

main();
