#!/usr/bin/env tsx
/**
 * Module 3 — chatbot QA replay runner.
 *
 * Loads JSON scenarios from `scenarios/`, runs each turn through the chatbot's
 * `processTurn()` API, asserts structural invariants (router intent, RAG
 * source, guard verdict, token caps, response substring assertions), and
 * reports pass / fail per scenario.
 *
 * Run via: `npx tsx replay.ts`
 *
 * Exit codes:
 *   0  — all scenarios passed
 *   1  — at least one scenario failed
 *   2  — chatbot package not reachable (run `npm install` in ../chatbot/)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCENARIO_DIR = "scenarios";
const CHATBOT_ROOT = resolve("../chatbot");
const CHATBOT_INDEX = resolve(CHATBOT_ROOT, "src/index.ts");

// Load the chatbot's .env BEFORE importing the chatbot package — otherwise
// llm-client.ts sees an empty process.env (it calls `import "dotenv/config"`
// which only loads from cwd; when this runner is invoked from chatbot-tests/,
// cwd has no .env and no backend gets detected). Minimal parser avoids
// pulling `dotenv` as a chatbot-tests dependency.
function loadChatbotEnv(): void {
  const envPath = resolve(CHATBOT_ROOT, ".env");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return; // .env optional — runner reports a clearer error if no backend
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

interface ScenarioExpect {
  guard_verdict?: "safe" | "suspicious" | "malicious";
  guard_blocked?: boolean;
  router_intent?: string;
  router_confidence_min?: number;
  rag_source?: string;
  rag_min_score?: number;
  response_language?: string;
  response_must_mention?: string[];
  response_must_mention_any?: string[];
  response_must_not_mention?: string[];
  tool_calls?: string[];
  tool_calls_allowed?: string[];
  tokens_max?: number;
  latency_ms_max?: number;
}

interface Scenario {
  id: string;
  description: string;
  language: string;
  turns: Array<{ user: string; expect: ScenarioExpect }>;
}

interface AssertionResult {
  passed: boolean;
  message: string;
}

function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8")) as Scenario);
}

function assertEqual<T>(label: string, actual: T, expected: T): AssertionResult {
  return {
    passed: actual === expected,
    message: actual === expected
      ? `✓ ${label}=${String(actual)}`
      : `✗ ${label}: expected ${String(expected)}, got ${String(actual)}`,
  };
}

function assertMin(label: string, actual: number, min: number): AssertionResult {
  return {
    passed: actual >= min,
    message: actual >= min
      ? `✓ ${label}=${actual.toFixed(2)} (≥ ${min})`
      : `✗ ${label}: expected ≥ ${min}, got ${actual.toFixed(2)}`,
  };
}

function assertMax(label: string, actual: number, max: number): AssertionResult {
  return {
    passed: actual <= max,
    message: actual <= max
      ? `✓ ${label}=${actual} (≤ ${max})`
      : `✗ ${label}: expected ≤ ${max}, got ${actual}`,
  };
}

function assertSubstrings(label: string, text: string, mustHave: string[]): AssertionResult {
  const missing = mustHave.filter((s) => !text.includes(s));
  return {
    passed: missing.length === 0,
    message: missing.length === 0
      ? `✓ ${label}: all of [${mustHave.join(", ")}] present`
      : `✗ ${label}: missing [${missing.join(", ")}]`,
  };
}

function assertAnyOf(label: string, text: string, candidates: string[]): AssertionResult {
  const lower = text.toLowerCase();
  const matched = candidates.find((s) => lower.includes(s.toLowerCase()));
  return {
    passed: matched !== undefined,
    message: matched !== undefined
      ? `✓ ${label}: matched "${matched}"`
      : `✗ ${label}: none of [${candidates.join(", ")}] found`,
  };
}

function assertAbsent(label: string, text: string, forbidden: string[]): AssertionResult {
  const lower = text.toLowerCase();
  const present = forbidden.filter((s) => lower.includes(s.toLowerCase()));
  return {
    passed: present.length === 0,
    message: present.length === 0
      ? `✓ ${label}: none of [${forbidden.join(", ")}] present`
      : `✗ ${label}: forbidden [${present.join(", ")}] appeared`,
  };
}

interface ProcessTurnRecord {
  guard: { verdict: string; block: boolean };
  router: { intent: string; confidence: number };
  retrieval: Array<{ source: string; score: number }>;
  toolCalls: Array<{ name: string }>;
  tokensUsed: { prompt: number; completion: number };
  latencyMs: number;
  agentResponse: string;
}

interface ProcessTurnOutput {
  response: string;
  intent: string;
  record: ProcessTurnRecord;
}

type ProcessTurn = (input: {
  userMessage: string;
  turn?: number;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}) => Promise<ProcessTurnOutput>;

async function loadChatbot(): Promise<ProcessTurn> {
  const url = pathToFileURL(CHATBOT_INDEX).href;
  const mod = (await import(url)) as { processTurn: ProcessTurn };
  return mod.processTurn;
}

function evaluateExpectations(
  expect: ScenarioExpect,
  record: ProcessTurnRecord,
  response: string,
): AssertionResult[] {
  const results: AssertionResult[] = [];

  if (expect.guard_verdict !== undefined) {
    results.push(assertEqual("guard.verdict", record.guard.verdict, expect.guard_verdict));
  }
  if (expect.guard_blocked !== undefined) {
    results.push(assertEqual("guard.blocked", record.guard.block, expect.guard_blocked));
  }
  if (expect.router_intent !== undefined) {
    results.push(assertEqual("router.intent", record.router.intent, expect.router_intent));
  }
  if (expect.router_confidence_min !== undefined) {
    results.push(
      assertMin("router.confidence", record.router.confidence, expect.router_confidence_min),
    );
  }
  if (expect.rag_source !== undefined) {
    const matched = record.retrieval.find((r) => r.source === expect.rag_source);
    results.push({
      passed: matched !== undefined,
      message: matched !== undefined
        ? `✓ rag.source=${expect.rag_source} (score ${matched.score.toFixed(2)})`
        : `✗ rag.source: expected ${expect.rag_source}, retrieved [${record.retrieval.map((r) => r.source).join(", ")}]`,
    });
    if (matched !== undefined && expect.rag_min_score !== undefined) {
      results.push(assertMin("rag.score", matched.score, expect.rag_min_score));
    }
  }
  if (expect.response_must_mention !== undefined) {
    results.push(assertSubstrings("response.mention", response, expect.response_must_mention));
  }
  if (expect.response_must_mention_any !== undefined) {
    results.push(
      assertAnyOf("response.mention_any", response, expect.response_must_mention_any),
    );
  }
  if (expect.response_must_not_mention !== undefined) {
    results.push(
      assertAbsent("response.must_not", response, expect.response_must_not_mention),
    );
  }
  if (expect.tool_calls !== undefined) {
    const names = record.toolCalls.map((t) => t.name).sort();
    const expected = [...expect.tool_calls].sort();
    const ok = JSON.stringify(names) === JSON.stringify(expected);
    results.push({
      passed: ok,
      message: ok
        ? `✓ tool_calls=[${names.join(", ")}]`
        : `✗ tool_calls: expected [${expected.join(", ")}], got [${names.join(", ")}]`,
    });
  }
  if (expect.tool_calls_allowed !== undefined) {
    const names = record.toolCalls.map((t) => t.name);
    const unexpected = names.filter((n) => !expect.tool_calls_allowed!.includes(n));
    results.push({
      passed: unexpected.length === 0,
      message: unexpected.length === 0
        ? `✓ tool_calls allowed=[${expect.tool_calls_allowed.join(", ")}]`
        : `✗ tool_calls: unexpected [${unexpected.join(", ")}]`,
    });
  }
  if (expect.tokens_max !== undefined) {
    const total = record.tokensUsed.prompt + record.tokensUsed.completion;
    results.push(assertMax("tokens.total", total, expect.tokens_max));
  }
  if (expect.latency_ms_max !== undefined) {
    results.push(assertMax("latency_ms", record.latencyMs, expect.latency_ms_max));
  }

  return results;
}

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

  const scenarios = loadScenarios();
  console.log(`\n🤖 chatbot-tests replay`);
  console.log(`   Scenarios: ${scenarios.length}\n`);

  let scenariosPassed = 0;
  let totalAssertions = 0;
  let assertionsPassed = 0;

  for (const s of scenarios) {
    console.log(`─── [${s.id}] ${s.description}`);

    let scenarioPassed = true;
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (let i = 0; i < s.turns.length; i++) {
      const turn = s.turns[i]!;
      try {
        const { response, record } = await processTurn({
          userMessage: turn.user,
          turn: i + 1,
          history,
        });

        const results = evaluateExpectations(turn.expect, record, response);
        for (const r of results) {
          totalAssertions += 1;
          if (r.passed) assertionsPassed += 1;
          else scenarioPassed = false;
          console.log(`   ${r.message}`);
        }

        history.push({ role: "user", content: turn.user });
        history.push({ role: "assistant", content: response });
      } catch (err) {
        console.error(`   ✗ Turn ${i + 1} failed to execute: ${err instanceof Error ? err.message : String(err)}`);
        scenarioPassed = false;
      }
    }

    if (scenarioPassed) scenariosPassed += 1;
    console.log(`   → ${scenarioPassed ? "PASS" : "FAIL"}\n`);
  }

  console.log(
    `Scenarios: ${scenariosPassed}/${scenarios.length} passed · ` +
      `Assertions: ${assertionsPassed}/${totalAssertions} passed\n`,
  );

  process.exit(scenariosPassed === scenarios.length ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
