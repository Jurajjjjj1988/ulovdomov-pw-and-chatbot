#!/usr/bin/env tsx
/**
 * L3 snapshot recorder (build step) — the ONLY file here that calls the live
 * chatbot.
 *
 * Replays every golden conversation through the chatbot's `processTurn()`,
 * feeding history forward turn-by-turn, and freezes each scenario's per-turn
 * `TurnRecord` array to fixtures/recordings/<id>.json. The L3 trajectory
 * scorer then evaluates those frozen snapshots fully offline (zero LLM calls).
 *
 * Run via: `npm run eval:record` (a human runs this when the chatbot or the
 * golden set changes; it costs tokens + time). The scorer never invokes it.
 *
 * Exit codes:
 *   0  — all scenarios recorded
 *   2  — chatbot package not reachable (run `npm install` in ../chatbot/)
 *   1  — a scenario failed to execute
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { TurnRecord } from "./scorers/types.js";

const GOLDEN_DIR = resolve("golden/conversations");
const RECORDINGS_DIR = resolve("fixtures/recordings");
const CHATBOT_ROOT = resolve("../chatbot");
const CHATBOT_INDEX = resolve(CHATBOT_ROOT, "src/index.ts");

// Load the chatbot's .env BEFORE importing the chatbot package — otherwise
// llm-client.ts sees an empty process.env (it calls `import "dotenv/config"`
// which only loads from cwd; here cwd is chatbot-tests/ with no .env). Same
// minimal parser as replay.ts — avoids pulling `dotenv` as a dependency.
function loadChatbotEnv(): void {
  const envPath = resolve(CHATBOT_ROOT, ".env");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return; // .env optional — loader reports a clearer error if no backend
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
loadChatbotEnv();

/** Golden conversation shape (only the fields the recorder consumes). */
interface GoldenConversation {
  id: string;
  description?: string;
  turns: Array<{ user: string }>;
}

/** Subset of the chatbot's processTurn output the recorder reads. */
interface ProcessTurnOutput {
  response: string;
  intent: string;
  record: TurnRecord;
}

type ProcessTurn = (input: {
  userMessage: string;
  turn?: number;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}) => Promise<ProcessTurnOutput>;

/**
 * Dynamically imports the chatbot's `processTurn` via a file URL — the same
 * pattern replay.ts uses so the TS-source ESM module resolves under tsx.
 *
 * @returns The chatbot's processTurn function.
 */
async function loadChatbot(): Promise<ProcessTurn> {
  const url = pathToFileURL(CHATBOT_INDEX).href;
  const mod = (await import(url)) as { processTurn: ProcessTurn };
  return mod.processTurn;
}

/** Loads every golden conversation, sorted by filename for determinism. */
function loadGoldenConversations(): GoldenConversation[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf8")) as GoldenConversation);
}

/**
 * Records one scenario: runs each turn through processTurn, threading history
 * forward, and returns the per-turn TurnRecord array.
 *
 * @param processTurn The live chatbot entry point.
 * @param conv The golden conversation to replay.
 * @returns One TurnRecord per turn, in turn order.
 */
async function recordScenario(
  processTurn: ProcessTurn,
  conv: GoldenConversation,
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  const history: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  for (let i = 0; i < conv.turns.length; i++) {
    const turn = conv.turns[i]!;
    const { response, record } = await processTurn({
      userMessage: turn.user,
      turn: i + 1,
      history,
    });
    records.push(record);
    history.push({ role: "user", content: turn.user });
    history.push({ role: "assistant", content: response });
  }

  return records;
}

/**
 * Recorder main: replays all golden conversations and freezes their snapshots.
 *
 * @returns Resolves when every scenario has been written (or sets exit code).
 */
async function main(): Promise<void> {
  let processTurn: ProcessTurn;
  try {
    processTurn = await loadChatbot();
  } catch (err) {
    console.error(`❌ Cannot load chatbot package at ${CHATBOT_INDEX}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    console.error(`   Run 'npm install' in ../chatbot/ first.`);
    process.exit(2);
  }

  if (!existsSync(RECORDINGS_DIR)) {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
  }

  const conversations = loadGoldenConversations();
  console.log(`\n📸 recording L3 snapshots`);
  console.log(`   Scenarios: ${conversations.length}\n`);

  let recorded = 0;
  let failed = 0;

  for (const conv of conversations) {
    try {
      const records = await recordScenario(processTurn, conv);
      const outPath = join(RECORDINGS_DIR, `${conv.id}.json`);
      writeFileSync(outPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      console.log(`   ✓ [${conv.id}] ${records.length} turn(s) → ${outPath}`);
      recorded += 1;
    } catch (err) {
      console.error(
        `   ✗ [${conv.id}] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed += 1;
    }
  }

  console.log(`\nRecorded: ${recorded}/${conversations.length} · Failed: ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
