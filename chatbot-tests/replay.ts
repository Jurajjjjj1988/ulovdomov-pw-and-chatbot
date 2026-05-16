#!/usr/bin/env tsx
/**
 * Module 3 — chatbot QA replay runner.
 *
 * Loads JSON scenarios from `scenarios/`, runs each turn through the chatbot's
 * `processTurn()` API, asserts structural invariants (router intent, RAG
 * source, guard verdict, token caps, response substring assertions), and
 * reports pass / fail per scenario.
 *
 * Status: **v0.1 — skeleton implementation.** The scenario schema is
 * locked; the assertion engine is currently a stub that reports the
 * scenario list and an emulated pass result so the suite is wired into
 * the repo and the structure is visible. The actual `processTurn()`
 * invocation + structural assertions land in v0.2 — see roadmap in
 * `README.md` § Roadmap.
 *
 * Why ship the skeleton first: locks the public API contract (scenario
 * JSON shape, the runner's exit-code semantics) before we commit to the
 * implementation. Same pattern Module 1 used when shipping page object
 * skeletons ahead of the spec layer.
 *
 * Run via: `npx tsx replay.ts`
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCENARIO_DIR = "scenarios";

interface Scenario {
  id: string;
  description: string;
  language: string;
  turns: Array<{
    user: string;
    expect: Record<string, unknown>;
  }>;
}

function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8")) as Scenario);
}

async function main(): Promise<void> {
  const scenarios = loadScenarios();

  console.log(`\n🤖 chatbot-tests replay (skeleton — v0.1)`);
  console.log(`   Scenarios: ${scenarios.length}\n`);

  let passed = 0;
  for (const s of scenarios) {
    // v0.2: import { processTurn } from "../chatbot/src/index.js";
    //       run each turn, capture record, assert against expect.
    //       For now the skeleton just prints the contract.
    console.log(`[${s.id}] (skeleton) ${s.description}`);
    console.log(`           turns: ${s.turns.length} · language: ${s.language}`);
    passed += 1;
  }

  console.log(`\nPass: ${passed}/${scenarios.length} (skeleton — assertions land in v0.2)`);
  console.log(`\nSee README.md for the assertion engine roadmap.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
