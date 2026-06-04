#!/usr/bin/env tsx
/**
 * RAGAS-style faithfulness evaluation.
 *
 * Reads the conversation log and computes for each FAQ-routed turn:
 *
 *   faithfulness = (# atomic claims in answer supported by retrieved context)
 *                  / (# atomic claims in answer)
 *
 * Atomic claims are extracted by asking the LLM to split the response into
 * standalone factual statements. Support is determined by another LLM call
 * that asks "is this claim entailed by the retrieved context, yes/no?".
 *
 * This is the methodology behind the public `ragas` Python library and is
 * the de-facto standard for RAG quality measurement in 2026.
 *
 * Run via: `npm run eval:faithfulness`
 *
 * Output:
 *   - per-turn faithfulness score (CLI table)
 *   - aggregate mean + median
 *   - list of turns with score < 0.7 (candidates for prompt fix)
 *
 * Cost: ~2 LLM calls per claim per turn. For 100 turns × ~3 claims each,
 * ~600 calls = ~$0.30 on gpt-4o-mini. Negligible.
 */

import { readFileSync, existsSync } from "node:fs";

import { getChatClient, getChatModel } from "../llm-client.js";

interface ConversationTurnRow {
  ts: string;
  conversationId: string;
  userMessage: string;
  router: { intent: string };
  retrieval: Array<{ source: string; heading: string; score: number }>;
  agentResponse: string;
}

interface FaithfulnessResult {
  turnTs: string;
  conversationId: string;
  userMessage: string;
  claims: string[];
  supportedClaims: string[];
  faithfulness: number; // 0..1
}

function loadRows(path: string): ConversationTurnRow[] {
  if (!existsSync(path)) {
    console.error(`No log at ${path}.`);
    process.exit(1);
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ConversationTurnRow);
}

async function extractClaims(answer: string): Promise<string[]> {
  const client = getChatClient();
  const completion = await client.chat.completions.create({
    model: getChatModel(),
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Split the assistant's answer into atomic factual claims — each one " +
          'a standalone statement that could be marked "true" or "false" against ' +
          "a knowledge base. Ignore questions, CTAs, and tone phrases. Return JSON: " +
          '{"claims": [string, …]}. Output Czech/Slovak claims verbatim from the input.',
      },
      { role: "user", content: answer },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as { claims?: unknown };
  return Array.isArray(parsed.claims)
    ? parsed.claims.filter((c): c is string => typeof c === "string")
    : [];
}

async function checkSupport(claim: string, context: string): Promise<boolean> {
  const client = getChatClient();
  const completion = await client.chat.completions.create({
    model: getChatModel(),
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Decide if the claim is supported by the retrieved context. Return JSON: ' +
          '{"supported": true | false}. "Supported" means the context contains either ' +
          "the same fact verbatim or a sentence from which the claim is a direct " +
          "paraphrase. Numeric facts must match exactly. If the context is silent " +
          "on the claim, return false.",
      },
      { role: "user", content: `Context:\n${context}\n\nClaim: ${claim}` },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as { supported?: unknown };
  return parsed.supported === true;
}

async function evaluateTurn(row: ConversationTurnRow): Promise<FaithfulnessResult> {
  const claims = await extractClaims(row.agentResponse);
  if (claims.length === 0) {
    return {
      turnTs: row.ts,
      conversationId: row.conversationId,
      userMessage: row.userMessage,
      claims: [],
      supportedClaims: [],
      faithfulness: 1, // no claims = nothing to be unfaithful about
    };
  }
  const context = row.retrieval.map((r) => `[${r.source}] ${r.heading}`).join("\n\n");
  const supportedClaims: string[] = [];
  for (const claim of claims) {
    const supported = await checkSupport(claim, context);
    if (supported) supportedClaims.push(claim);
  }
  return {
    turnTs: row.ts,
    conversationId: row.conversationId,
    userMessage: row.userMessage,
    claims,
    supportedClaims,
    faithfulness: supportedClaims.length / claims.length,
  };
}

async function main(): Promise<void> {
  const logPath = process.env.CONVERSATION_LOG_PATH ?? "./logs/conversations.jsonl";
  const rows = loadRows(logPath).filter((r) => r.router.intent === "faq");

  console.log(`Evaluating faithfulness on ${rows.length} FAQ-routed turn(s)…\n`);

  const results: FaithfulnessResult[] = [];
  for (const row of rows) {
    const result = await evaluateTurn(row);
    results.push(result);
    const flag = result.faithfulness < 0.7 ? "⚠ " : "  ";
    const userPreview = row.userMessage.slice(0, 40).replace(/\n/g, " ");
    console.log(
      `${flag}${result.faithfulness.toFixed(2)} · ` +
        `${result.supportedClaims.length}/${result.claims.length} claims · ` +
        `"${userPreview}…"`,
    );
  }

  if (results.length === 0) {
    console.log("No FAQ turns in log — nothing to evaluate.");
    return;
  }

  const sorted = [...results].sort((a, b) => a.faithfulness - b.faithfulness);
  const mean = results.reduce((acc, r) => acc + r.faithfulness, 0) / results.length;
  const median = sorted[Math.floor(sorted.length / 2)]?.faithfulness ?? 0;

  console.log(`\nMean faithfulness:   ${mean.toFixed(3)}`);
  console.log(`Median faithfulness: ${median.toFixed(3)}`);

  const weak = results.filter((r) => r.faithfulness < 0.7);
  if (weak.length > 0) {
    console.log(`\n⚠  ${weak.length} turn(s) below 0.7 faithfulness — candidates for prompt fix:`);
    for (const r of weak) {
      const unsupported = r.claims.filter((c) => !r.supportedClaims.includes(c));
      console.log(`  • "${r.userMessage.slice(0, 60)}…"`);
      for (const c of unsupported) {
        console.log(`    – unsupported: "${c.slice(0, 80)}"`);
      }
    }
  } else {
    console.log("\n✓ All turns ≥ 0.7 faithfulness.");
  }
}

main().catch((err: unknown) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
