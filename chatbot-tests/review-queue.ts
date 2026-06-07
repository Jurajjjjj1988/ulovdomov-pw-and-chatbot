#!/usr/bin/env tsx
/**
 * Module 3 — Human Review Queue (slide 7).
 *
 * The offline eval pipeline can't auto-resolve every signal: distribution-shift
 * turns, low-confidence retrievals, and missing recordings all need a human to
 * look. Each scorer emits {@link ReviewFlag}s; the eval-runner appends them here
 * so a reviewer can triage them out-of-band.
 *
 * Storage is a JSON-Lines file (`review-queue.jsonl`) — one entry per line, so
 * the queue is append-only, diff-friendly, and crash-safe (a partial write only
 * loses the last line). Each entry is a {@link QueueEntry}.
 *
 * Run via:
 *   `npx tsx review-queue.ts`            — list pending entries (pretty).
 *
 * Exit codes:
 *   0 — listed successfully (even when the queue is empty).
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReviewFlag } from "./scorers/types.js";

const QUEUE_PATH = resolve("review-queue.jsonl");

/** A persisted review-queue line. */
interface QueueEntry {
  /** When the flag was enqueued (ISO 8601). */
  ts: string;
  /** Scenario / query / corpus-item id that was flagged. */
  id: string;
  /** Why it needs review (carried from the scorer's {@link ReviewFlag}). */
  reason: string;
  /** Supporting scores at flag time (e.g. { confidence: 0.41 }). */
  scores: Record<string, number>;
  /** Triage state — always "pending" on enqueue; a human moves it onward. */
  status: "pending";
}

/**
 * Append review flags to the queue file as `{ts,id,reason,scores,status}` lines.
 *
 * Called by the eval-runner after a run. A no-op when `flags` is empty so the
 * runner can call it unconditionally. All flags from one run share a timestamp.
 *
 * @param flags - Review flags collected across every scorer in the run.
 */
export function enqueue(flags: ReviewFlag[]): void {
  if (flags.length === 0) return;
  const ts = new Date().toISOString();
  const lines = flags
    .map((f) => {
      const entry: QueueEntry = {
        ts,
        id: f.id,
        reason: f.reason,
        scores: f.scores,
        status: "pending",
      };
      return JSON.stringify(entry);
    })
    .join("\n");
  appendFileSync(QUEUE_PATH, lines + "\n", "utf8");
}

/** Read and parse every line of the queue file (skips blanks). */
function readQueue(): QueueEntry[] {
  if (!existsSync(QUEUE_PATH)) return [];
  return readFileSync(QUEUE_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as QueueEntry);
}

/**
 * Print all pending entries to stdout, grouped and pretty-formatted.
 *
 * Reviewer-facing: shows id, reason, and supporting scores per pending flag.
 */
export function listPending(): void {
  const entries = readQueue().filter((e) => e.status === "pending");

  console.log(`\n🧑‍⚖️  Human review queue — ${QUEUE_PATH}`);
  if (entries.length === 0) {
    console.log(`   (no pending entries)\n`);
    return;
  }

  console.log(`   Pending: ${entries.length}\n`);
  for (const e of entries) {
    const scoreStr = Object.entries(e.scores)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`─── [${e.id}]  ${e.ts}`);
    console.log(`   reason: ${e.reason}`);
    if (scoreStr) console.log(`   scores: ${scoreStr}`);
  }
  console.log("");
}

function main(): void {
  listPending();
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main();
}
