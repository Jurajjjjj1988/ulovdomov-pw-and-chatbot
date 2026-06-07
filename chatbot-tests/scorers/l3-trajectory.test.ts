#!/usr/bin/env tsx
/**
 * Offline unit verification for the L3 trajectory pure matchers.
 *
 * Zero LLM, zero live chatbot, no new framework — just node:assert/strict over
 * hand-built synthetic tool-call arrays and records where the answer is known.
 *
 * Run via: `npx tsx scorers/l3-trajectory.test.ts`
 */

import assert from "node:assert/strict";

import {
  matchToolSequence,
  matchToolArgs,
  matchTerminalState,
  checkStepEfficiency,
  stepCount,
  type RecordedToolCall,
  type TrajectoryRecord,
} from "./l3-trajectory.js";

// ─── matchToolSequence ───────────────────────────────────────────────────────

// strict: order + content must match exactly.
assert.equal(matchToolSequence(["a", "b"], ["a", "b"], "strict"), true, "strict exact");
assert.equal(matchToolSequence(["a", "b"], ["b", "a"], "strict"), false, "strict order matters");
assert.equal(matchToolSequence(["a"], ["a", "b"], "strict"), false, "strict length differs");
assert.equal(matchToolSequence([], [], "strict"), true, "strict empty == empty");

// unordered: same multiset regardless of order.
assert.equal(matchToolSequence(["a", "b"], ["b", "a"], "unordered"), true, "unordered reorder");
assert.equal(matchToolSequence(["a", "a"], ["a"], "unordered"), false, "unordered count differs");
assert.equal(
  matchToolSequence(["a", "b", "b"], ["b", "a", "b"], "unordered"),
  true,
  "unordered multiset",
);

// subset: every expected appears in actual (order-free).
assert.equal(matchToolSequence(["a", "b", "c"], ["b"], "subset"), true, "subset present");
assert.equal(matchToolSequence(["a", "c"], ["b"], "subset"), false, "subset missing");
assert.equal(matchToolSequence(["search_listings"], [], "subset"), true, "subset empty expected");
assert.equal(
  matchToolSequence(["a"], ["a", "a"], "subset"),
  false,
  "subset respects expected count",
);

// superset: every actual is permitted by expected (order-free).
assert.equal(matchToolSequence(["a"], ["a", "b"], "superset"), true, "superset within allowed");
assert.equal(matchToolSequence(["a", "z"], ["a", "b"], "superset"), false, "superset disallowed");
assert.equal(matchToolSequence([], ["a"], "superset"), true, "superset empty actual");

// ─── matchToolArgs ───────────────────────────────────────────────────────────

const ticketCall: RecordedToolCall = {
  name: "create_support_ticket",
  args: { ticket_id: "TICK-XYZ", priority: "high" },
};
const searchCall: RecordedToolCall = {
  name: "search_listings",
  args: { invocation_count: 1 },
};

// subset match: only listed keys checked, others ignored.
assert.equal(
  matchToolArgs([ticketCall], { create_support_ticket: { priority: "high" } }),
  true,
  "args subset matches listed key",
);
// right tool name, wrong arg value → false.
assert.equal(
  matchToolArgs([ticketCall], { create_support_ticket: { priority: "low" } }),
  false,
  "args wrong value → false",
);
// expected tool not present → false.
assert.equal(
  matchToolArgs([searchCall], { create_support_ticket: { priority: "high" } }),
  false,
  "args missing tool → false",
);
// reads the contract's `arguments` key as a fallback.
assert.equal(
  matchToolArgs([{ name: "t", arguments: { k: 42 } }], { t: { k: 42 } }),
  true,
  "args fallback to `arguments` key",
);
// missing expected key → false.
assert.equal(
  matchToolArgs([searchCall], { search_listings: { region: "Praha 6" } }),
  false,
  "args missing key → false",
);

// ─── matchTerminalState ──────────────────────────────────────────────────────

const ticketRecord: TrajectoryRecord = { toolCalls: [ticketCall] };
const noToolRecord: TrajectoryRecord = { toolCalls: [] };

assert.equal(
  matchTerminalState(ticketRecord, { ticket_created: true }),
  true,
  "ticket_created true when create_support_ticket present",
);
assert.equal(
  matchTerminalState(noToolRecord, { ticket_created: true }),
  false,
  "ticket_created true fails when no ticket tool",
);
assert.equal(
  matchTerminalState(noToolRecord, { ticket_created: false }),
  true,
  "ticket_created false when no ticket tool",
);
assert.equal(
  matchTerminalState({ toolCalls: [searchCall] }, { tool_called: "search_listings" }),
  true,
  "tool_called matches present tool",
);
assert.equal(
  matchTerminalState(noToolRecord, { tool_called: "search_listings" }),
  false,
  "tool_called fails when absent",
);
assert.equal(
  matchTerminalState(noToolRecord, { unknown_predicate: true }),
  false,
  "unknown predicate fails closed",
);

// ─── step efficiency ─────────────────────────────────────────────────────────

// step count = tool calls + 1 (router→agent hop).
assert.equal(stepCount(noToolRecord), 1, "step count no tools = 1");
assert.equal(stepCount(ticketRecord), 2, "step count 1 tool = 2");
assert.equal(stepCount({ toolCalls: [ticketCall, searchCall] }), 3, "step count 2 tools = 3");

assert.equal(checkStepEfficiency(noToolRecord, 1), true, "0 tools within max_steps 1");
assert.equal(checkStepEfficiency(ticketRecord, 3), true, "1 tool within max_steps 3");
assert.equal(
  checkStepEfficiency({ toolCalls: [ticketCall, searchCall] }, 1),
  false,
  "2 tools exceed max_steps 1",
);

console.log("L3 matchers OK");
