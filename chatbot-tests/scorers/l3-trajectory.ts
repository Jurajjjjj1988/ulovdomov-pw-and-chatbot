/**
 * L3 Trajectory scorer.
 *
 * Slide 6, layer L3: did the agent take the *right path* — the expected tool
 * sequence, with the expected arguments, ending in the expected terminal state,
 * within a step-efficiency budget. This REPLACES the ad-hoc tool-call
 * assertions in replay.ts (`tool_calls` / `tool_calls_allowed`) with a proper,
 * mode-aware trajectory comparator.
 *
 * FULLY OFFLINE — zero LLM calls. It evaluates *recorded* snapshots
 * (fixtures/recordings/<id>.json, written by record-snapshots.ts) against the
 * `expect.trajectory` blocks in the golden conversations. To refresh the
 * snapshots a human runs `npm run eval:record` (which IS allowed to call the
 * live chatbot); this scorer never does.
 *
 * Recorded tool-call shape (verified against chatbot/src/index.ts and
 * logs/conversations.jsonl): each tool call is `{ name, args }` where `args`
 * is a *synthetic* post-hoc object the orchestrator attaches
 * (`{ ticket_id }` for create_support_ticket, `{ invocation_count }` for
 * search_listings) — NOT the model's real function-calling arguments
 * (priority / category / summary / customer_message are discarded before
 * logging). `matchToolArgs` therefore reads `args` first, falls back to
 * `arguments`, and degrades gracefully when neither is present. See the
 * dependency/risk note in the return value when a tool_args check can't be
 * satisfied because the real arguments aren't captured.
 *
 * Run (offline): `npx tsx scorers/l3-trajectory.ts` is not an entry point —
 * the scorer is imported by the eval-runner. Unit tests live in
 * l3-trajectory.test.ts.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  ScorerResult,
  Metric,
  ExampleScore,
  ReviewFlag,
  TrajectoryExpect,
  TrajectoryMatchMode,
  TurnRecord,
} from "./types.js";

// ───────────────────────────────────────────────────────────────────────────
// Paths. Resolved from the eval-runner cwd (chatbot-tests root), matching the
// convention replay.ts uses for its scenario/chatbot paths.
// ───────────────────────────────────────────────────────────────────────────

const GOLDEN_DIR = resolve("golden/conversations");
const RECORDINGS_DIR = resolve("fixtures/recordings");

// ───────────────────────────────────────────────────────────────────────────
// Local view of a recorded tool call. The chatbot logs `args`; the eval
// `TurnRecord` type declares `arguments?`. We accept either so the scorer is
// robust to which producer wrote the snapshot.
// ───────────────────────────────────────────────────────────────────────────

/** A recorded tool call as it may appear in a snapshot (defensive on the key). */
export interface RecordedToolCall {
  name: string;
  /** Arguments under the chatbot's key. */
  args?: Record<string, unknown>;
  /** Arguments under the eval contract's key. */
  arguments?: Record<string, unknown>;
}

/** Minimal record shape the matchers need (superset-compatible with TurnRecord). */
export interface TrajectoryRecord {
  toolCalls: RecordedToolCall[];
}

/** A golden conversation turn carrying an optional trajectory expectation. */
interface GoldenTurn {
  user: string;
  expect: { trajectory?: TrajectoryExpect } & Record<string, unknown>;
}

/** A golden conversation file. */
interface GoldenConversation {
  id: string;
  description?: string;
  turns: GoldenTurn[];
}

// ───────────────────────────────────────────────────────────────────────────
// Pure matchers — exported so the unit test can hit them in isolation.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compares an actual tool-call name sequence against an expected one under a
 * match mode.
 *
 * - `strict`   — identical length, order and content (deep array equality).
 * - `unordered`— same multiset of names (order ignored, counts respected).
 * - `subset`   — every expected name appears in actual (order-free, counts
 *                respected: each expected occurrence must be covered by a
 *                distinct actual occurrence).
 * - `superset` — every actual name is permitted by expected (order-free,
 *                counts respected: actual is a sub-multiset of expected).
 *
 * @param actual Tool-call names in the order the agent invoked them.
 * @param expected Tool-call names declared in the golden trajectory.
 * @param mode How to compare. Defaults to `strict` if an unknown mode is passed.
 * @returns true iff the sequences match under `mode`.
 */
export function matchToolSequence(
  actual: string[],
  expected: string[],
  mode: TrajectoryMatchMode,
): boolean {
  switch (mode) {
    case "strict":
      return (
        actual.length === expected.length &&
        actual.every((name, i) => name === expected[i])
      );
    case "unordered":
      return isMultisetEqual(actual, expected);
    case "subset":
      // expected ⊆ actual (every expected occurrence covered by a distinct actual)
      return isSubMultiset(expected, actual);
    case "superset":
      // actual ⊆ expected (every actual occurrence permitted by expected)
      return isSubMultiset(actual, expected);
    default:
      return (
        actual.length === expected.length &&
        actual.every((name, i) => name === expected[i])
      );
  }
}

/**
 * Subset/superset deep-equality check for tool arguments.
 *
 * For each named tool in `expected`, finds a recorded call with that name and
 * verifies every listed key/value is present and deep-equal in the recorded
 * call's arguments (a *subset* match — keys not listed are ignored). Reads the
 * chatbot's `args` key first, falling back to the contract's `arguments` key.
 *
 * NOTE: the chatbot currently records only synthetic args (`ticket_id`,
 * `invocation_count`), not the model's real function-calling arguments. A
 * tool_args expectation on those real keys can never pass against today's
 * snapshots — callers should surface that as a record-extension need rather
 * than a regression (the scorer's `main()` does exactly this).
 *
 * @param actualCalls Recorded tool calls (with `args` and/or `arguments`).
 * @param expected Map of tool name → expected key/value subset.
 * @returns true iff every expected tool is present with all listed key/values
 *          matching; false if any tool is missing or any value differs.
 */
export function matchToolArgs(
  actualCalls: RecordedToolCall[],
  expected: Record<string, Record<string, unknown>>,
): boolean {
  for (const [toolName, expectedArgs] of Object.entries(expected)) {
    const call = actualCalls.find((c) => c.name === toolName);
    if (!call) return false;
    const recordedArgs = call.args ?? call.arguments ?? {};
    for (const [key, value] of Object.entries(expectedArgs)) {
      if (!(key in recordedArgs)) return false;
      if (!deepEqual(recordedArgs[key], value)) return false;
    }
  }
  return true;
}

/**
 * Evaluates a terminal-state predicate against the final turn's record.
 *
 * Supported predicate vocabulary:
 * - `ticket_created: true`  — true iff a `create_support_ticket` tool call
 *   occurred in the final record. `ticket_created: false` asserts the opposite.
 * - `tool_called: "<name>"` — true iff a tool call with that name occurred.
 *
 * Any unrecognised predicate key causes the whole check to fail (fail-closed),
 * so silently-ignored expectations can't mask a regression.
 *
 * @param finalRecord The final turn's recorded tool calls.
 * @param expected Predicate map (see vocabulary above).
 * @returns true iff every predicate holds against `finalRecord`.
 */
export function matchTerminalState(
  finalRecord: TrajectoryRecord,
  expected: Record<string, unknown>,
): boolean {
  const names = finalRecord.toolCalls.map((c) => c.name);
  for (const [predicate, value] of Object.entries(expected)) {
    switch (predicate) {
      case "ticket_created": {
        const created = names.includes("create_support_ticket");
        if (created !== Boolean(value)) return false;
        break;
      }
      case "tool_called": {
        if (typeof value !== "string") return false;
        if (!names.includes(value)) return false;
        break;
      }
      default:
        // Unknown predicate — fail closed rather than silently pass.
        return false;
    }
  }
  return true;
}

/**
 * Derives the step count for a turn and checks it against a max-steps budget.
 *
 * Step count = number of tool calls + 1 (the router→agent hop that always
 * happens). The chatbot record exposes no finer hop counter, so this is the
 * best available proxy; documented here so the heuristic is explicit.
 *
 * @param record The turn's recorded tool calls.
 * @param maxSteps Inclusive upper bound on steps.
 * @returns true iff derived step count ≤ maxSteps.
 */
export function checkStepEfficiency(record: TrajectoryRecord, maxSteps: number): boolean {
  return stepCount(record) <= maxSteps;
}

/**
 * Derives the step count for a turn: tool calls + 1 (router→agent hop).
 *
 * @param record The turn's recorded tool calls.
 * @returns The derived step count.
 */
export function stepCount(record: TrajectoryRecord): number {
  return record.toolCalls.length + 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers (not exported — implementation detail of the matchers).
// ───────────────────────────────────────────────────────────────────────────

/** True iff two string arrays hold the same multiset of values. */
function isMultisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = countBy(a);
  for (const name of b) {
    const n = counts.get(name);
    if (n === undefined || n === 0) return false;
    counts.set(name, n - 1);
  }
  return true;
}

/** True iff every occurrence in `needle` is covered by a distinct one in `haystack`. */
function isSubMultiset(needle: string[], haystack: string[]): boolean {
  const counts = countBy(haystack);
  for (const name of needle) {
    const n = counts.get(name);
    if (n === undefined || n === 0) return false;
    counts.set(name, n - 1);
  }
  return true;
}

/** Builds a name→count map for a string array. */
function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/** Structural deep-equality for JSON-shaped values (no functions / cycles). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Snapshot / golden loading.
// ───────────────────────────────────────────────────────────────────────────

/** Loads every golden conversation file, sorted by filename for determinism. */
function loadGoldenConversations(): GoldenConversation[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf8")) as GoldenConversation);
}

/**
 * Loads a scenario's recorded per-turn records, or null if no snapshot exists.
 * The recorder writes a `TurnRecord[]` (one entry per turn) per scenario.
 */
function loadSnapshot(id: string): TurnRecord[] | null {
  const path = join(RECORDINGS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as TurnRecord[];
}

/** Normalises a recorded TurnRecord into the minimal shape the matchers need. */
function toTrajectoryRecord(record: TurnRecord): TrajectoryRecord {
  const calls = (record.toolCalls ?? []) as RecordedToolCall[];
  return { toolCalls: calls };
}

/** Flattens tool-call names across a set of turn records (chronological). */
function namesAcross(records: TrajectoryRecord[]): string[] {
  return records.flatMap((r) => r.toolCalls.map((c) => c.name));
}

/** Flattens tool calls across a set of turn records (chronological). */
function callsAcross(records: TrajectoryRecord[]): RecordedToolCall[] {
  return records.flatMap((r) => r.toolCalls);
}

// ───────────────────────────────────────────────────────────────────────────
// Per-scenario evaluation.
// ───────────────────────────────────────────────────────────────────────────

/** The four sub-check outcomes for one scenario (null = check not applicable). */
interface ScenarioChecks {
  toolSequence: boolean | null;
  toolArgs: boolean | null;
  terminalState: boolean | null;
  stepEfficiency: boolean | null;
  /** Set when tool_args is requested but the real arguments aren't captured. */
  argsNotCaptured: boolean;
}

/**
 * Finds the trajectory expectation in a conversation. The golden files attach
 * `trajectory` to a single turn's `expect`; for multi-turn scenarios the LAST
 * turn carrying one is treated as the terminal expectation and the whole
 * conversation's tool calls form the trajectory.
 */
function findTrajectoryTurnIndex(conv: GoldenConversation): number {
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    if (conv.turns[i]?.expect.trajectory) return i;
  }
  return -1;
}

/**
 * Runs the four trajectory sub-checks for a single scenario against its
 * recorded turn records.
 */
function evaluateScenario(
  expect: TrajectoryExpect,
  records: TrajectoryRecord[],
): ScenarioChecks {
  const checks: ScenarioChecks = {
    toolSequence: null,
    toolArgs: null,
    terminalState: null,
    stepEfficiency: null,
    argsNotCaptured: false,
  };

  const allNames = namesAcross(records);
  const allCalls = callsAcross(records);
  const finalRecord = records[records.length - 1] ?? { toolCalls: [] };

  if (expect.tool_sequence !== undefined) {
    const mode: TrajectoryMatchMode = expect.match_mode ?? "strict";
    checks.toolSequence = matchToolSequence(allNames, expect.tool_sequence, mode);
  }

  if (expect.tool_args !== undefined) {
    // Defensive: detect whether the expected keys could exist at all. The
    // chatbot records only synthetic keys (ticket_id / invocation_count). If
    // none of a tool's expected keys are present in any recorded call AND a
    // call with that name exists, treat it as "args not captured" and skip the
    // sub-check gracefully (don't fail the scenario on a known recorder gap).
    const captured = expectedKeysArePresent(allCalls, expect.tool_args);
    if (captured) {
      checks.toolArgs = matchToolArgs(allCalls, expect.tool_args);
    } else {
      checks.argsNotCaptured = true;
      checks.toolArgs = null; // skipped, not failed
    }
  }

  if (expect.terminal_state !== undefined) {
    checks.terminalState = matchTerminalState(finalRecord, expect.terminal_state);
  }

  if (expect.max_steps !== undefined) {
    // Per-turn step budget: the cap applies to the trajectory turn. Use the
    // max single-turn step count so a multi-turn scenario isn't penalised for
    // its cumulative hops.
    const worstTurnSteps = records.reduce((m, r) => Math.max(m, stepCount(r)), 1);
    checks.stepEfficiency = worstTurnSteps <= expect.max_steps;
  }

  return checks;
}

/**
 * True iff, for every tool whose call is present, at least one expected key is
 * actually present in the recorded args — i.e. the args needed to evaluate the
 * expectation were captured. Tools with no matching call are left to
 * matchToolArgs to fail normally.
 */
function expectedKeysArePresent(
  calls: RecordedToolCall[],
  expected: Record<string, Record<string, unknown>>,
): boolean {
  for (const [toolName, expectedArgs] of Object.entries(expected)) {
    const call = calls.find((c) => c.name === toolName);
    if (!call) continue; // missing call → matchToolArgs handles it
    const recordedArgs = call.args ?? call.arguments ?? {};
    const anyKeyPresent = Object.keys(expectedArgs).some((k) => k in recordedArgs);
    if (!anyKeyPresent) return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Scorer entry point.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Scores the L3 trajectory layer fully offline from recorded snapshots.
 *
 * Reads each golden conversation that declares an `expect.trajectory`, loads
 * its snapshot from fixtures/recordings/<id>.json, runs the four sub-checks
 * (tool sequence, tool args, terminal state, step efficiency) and aggregates
 * pass rates. Scenarios with no snapshot are flagged for review (not failed)
 * with a "run npm run eval:record" hint.
 *
 * Emits ratio metrics (greaterIsBetter): l3.tool_sequence_pass_rate,
 * l3.tool_args_pass_rate, l3.terminal_state_pass_rate,
 * l3.step_efficiency_pass_rate, l3.trajectory_pass_rate. Pushes a per-scenario
 * ExampleScore (metricKey l3.trajectory_pass_rate, value 1/0) and a ReviewFlag
 * for every failed or unrecorded scenario.
 *
 * @returns The L3 ScorerResult.
 */
export async function scoreTrajectory(): Promise<ScorerResult> {
  const conversations = loadGoldenConversations();
  const examples: ExampleScore[] = [];
  const reviewFlags: ReviewFlag[] = [];

  // Sub-check tallies: [passed, applicable].
  const tally = {
    sequence: { pass: 0, total: 0 },
    args: { pass: 0, total: 0 },
    terminal: { pass: 0, total: 0 },
    steps: { pass: 0, total: 0 },
  };
  let scenarioPass = 0;
  let scenarioTotal = 0;

  for (const conv of conversations) {
    const trajIndex = findTrajectoryTurnIndex(conv);
    if (trajIndex === -1) continue; // no trajectory expectation declared
    const expect = conv.turns[trajIndex]!.expect.trajectory!;
    scenarioTotal += 1;

    const snapshot = loadSnapshot(conv.id);
    if (snapshot === null) {
      reviewFlags.push({
        id: conv.id,
        reason: "no recording — run `npm run eval:record` to capture a snapshot",
        scores: {},
      });
      examples.push({
        id: conv.id,
        metricKey: "l3.trajectory_pass_rate",
        value: 0,
        detail: "missing snapshot",
      });
      continue;
    }

    const records = snapshot.map(toTrajectoryRecord);
    const checks = evaluateScenario(expect, records);

    if (checks.toolSequence !== null) {
      tally.sequence.total += 1;
      if (checks.toolSequence) tally.sequence.pass += 1;
    }
    if (checks.toolArgs !== null) {
      tally.args.total += 1;
      if (checks.toolArgs) tally.args.pass += 1;
    }
    if (checks.terminalState !== null) {
      tally.terminal.total += 1;
      if (checks.terminalState) tally.terminal.pass += 1;
    }
    if (checks.stepEfficiency !== null) {
      tally.steps.total += 1;
      if (checks.stepEfficiency) tally.steps.pass += 1;
    }

    // Scenario passes iff every *applicable* sub-check passed. A skipped
    // tool_args check (args-not-captured) does not fail the scenario.
    const applicable = [
      checks.toolSequence,
      checks.toolArgs,
      checks.terminalState,
      checks.stepEfficiency,
    ].filter((c): c is boolean => c !== null);
    const scenarioOk = applicable.every((c) => c);

    if (scenarioOk) scenarioPass += 1;
    examples.push({
      id: conv.id,
      metricKey: "l3.trajectory_pass_rate",
      value: scenarioOk ? 1 : 0,
      detail: checks.argsNotCaptured
        ? "tool args not captured by chatbot — tool_args sub-check skipped; needs record extension"
        : undefined,
    });

    if (!scenarioOk) {
      reviewFlags.push({
        id: conv.id,
        reason: `trajectory failed: ${describeFailures(checks)}`,
        scores: {
          tool_sequence: boolToScore(checks.toolSequence),
          tool_args: boolToScore(checks.toolArgs),
          terminal_state: boolToScore(checks.terminalState),
          step_efficiency: boolToScore(checks.stepEfficiency),
        },
      });
    }
  }

  const metrics: Metric[] = [
    ratioMetric("l3.tool_sequence_pass_rate", tally.sequence.pass, tally.sequence.total),
    ratioMetric("l3.tool_args_pass_rate", tally.args.pass, tally.args.total),
    ratioMetric("l3.terminal_state_pass_rate", tally.terminal.pass, tally.terminal.total),
    ratioMetric("l3.step_efficiency_pass_rate", tally.steps.pass, tally.steps.total),
    ratioMetric("l3.trajectory_pass_rate", scenarioPass, scenarioTotal),
  ];

  return {
    layer: "L3",
    name: "L3 Trajectory",
    metrics,
    examples,
    reviewFlags,
  };
}

/** Builds a ratio Metric (greaterIsBetter). Empty denominator → 1 (vacuous pass). */
function ratioMetric(key: string, pass: number, total: number): Metric {
  return {
    key,
    value: total === 0 ? 1 : pass / total,
    greaterIsBetter: true,
    unit: "ratio",
  };
}

/** Maps a nullable boolean sub-check to a 1/0 score (null → 0 for flag display). */
function boolToScore(check: boolean | null): number {
  return check === true ? 1 : 0;
}

/** Human-readable list of failed sub-checks for a review flag. */
function describeFailures(checks: ScenarioChecks): string {
  const failed: string[] = [];
  if (checks.toolSequence === false) failed.push("tool_sequence");
  if (checks.toolArgs === false) failed.push("tool_args");
  if (checks.terminalState === false) failed.push("terminal_state");
  if (checks.stepEfficiency === false) failed.push("step_efficiency");
  return failed.join(", ") || "unknown";
}
