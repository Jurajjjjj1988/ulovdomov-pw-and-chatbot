#!/usr/bin/env tsx
/**
 * Module 3 — Offline Eval Runner (slide 7).
 *
 * Orchestrates the layer scorers (SAFETY guard, L2 retrieval, L3 trajectory)
 * into one {@link EvalReport}, writes machine- and human-readable artifacts to
 * `reports/`, and appends every {@link ReviewFlag} to the Human Review Queue.
 *
 * Design contract: a single scorer must NEVER crash the whole run. Each scorer
 * is wrapped in try/catch — a throw (e.g. L2 with no frozen query embeddings)
 * is recorded as a SKIPPED scorer with its error message and the run continues.
 * A skipped scorer contributes no metrics, so the gate sees the coverage gap.
 *
 * Run via:
 *   `npx tsx eval-runner.ts`             — run all scorers, write a report.
 *
 * Importable:
 *   `import { runEval } from "./eval-runner.js"` — the gate runs this directly.
 *
 * Exit codes:
 *   0 — report written (even if some scorers were skipped — that's the gate's
 *       call, not the runner's).
 *   1 — the runner itself failed (couldn't write artifacts).
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EvalReport,
  Metric,
  ReviewFlag,
  ScorerResult,
} from "./scorers/types.js";
import { enqueue } from "./review-queue.js";

const REPORTS_DIR = resolve("reports");

/** A scorer that ran but threw — tracked so the report can show the gap. */
interface SkippedScorer {
  name: string;
  reason: string;
}

/** Read the short commit hash, or null when git is unavailable. */
function currentCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Detect which (if any) LLM backend env is configured — informational only. */
function detectBackend(): string | null {
  if (process.env.GITHUB_MODELS_TOKEN) return "github-models";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

/** Filesystem-safe timestamp (no `:` or `.`), e.g. 2026-06-24T21-05-03-123Z. */
function safeStamp(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

/**
 * Run one scorer, capturing success or recording it as skipped on throw.
 *
 * @param name - Human label used in skip messages and CLI output.
 * @param fn - The scorer thunk (e.g. `() => scoreRetrieval(3)`).
 * @param results - Successful {@link ScorerResult}s are pushed here.
 * @param skipped - Throwing scorers are recorded here with the error message.
 */
async function runScorer(
  name: string,
  fn: () => Promise<ScorerResult>,
  results: ScorerResult[],
  skipped: SkippedScorer[],
): Promise<void> {
  try {
    const result = await fn();
    results.push(result);
    console.log(`   ✓ ${name} — ${result.metrics.length} metric(s), ${result.examples.length} example(s)`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    skipped.push({ name, reason });
    console.log(`   ⚠ ${name} SKIPPED — ${reason}`);
  }
}

/** Dynamically load the guard scorer. Built in parallel, so import may fail. */
async function loadGuard(): Promise<() => Promise<ScorerResult>> {
  const mod = (await import("./scorers/guard-classifier.js")) as {
    scoreGuard: () => Promise<ScorerResult>;
  };
  return mod.scoreGuard;
}

/** Dynamically load the L2 retrieval scorer. */
async function loadRetrieval(): Promise<(topK?: number) => Promise<ScorerResult>> {
  const mod = (await import("./scorers/l2-retrieval.js")) as {
    scoreRetrieval: (topK?: number) => Promise<ScorerResult>;
  };
  return mod.scoreRetrieval;
}

/** Dynamically load the L3 trajectory scorer. */
async function loadTrajectory(): Promise<() => Promise<ScorerResult>> {
  const mod = (await import("./scorers/l3-trajectory.js")) as {
    scoreTrajectory: () => Promise<ScorerResult>;
  };
  return mod.scoreTrajectory;
}

/** Dynamically load the L1 model scorer. */
async function loadModel(): Promise<() => Promise<ScorerResult>> {
  const mod = (await import("./scorers/l1-model.js")) as {
    scoreModel: () => Promise<ScorerResult>;
  };
  return mod.scoreModel;
}

/** Flatten every scorer's metrics into a key→Metric map for the gate. */
function flattenMetrics(scorers: ScorerResult[]): Record<string, Metric> {
  const out: Record<string, Metric> = {};
  for (const s of scorers) {
    for (const m of s.metrics) out[m.key] = m;
  }
  return out;
}

/** Collect every review flag across all scorers (in scorer order). */
function collectFlags(scorers: ScorerResult[]): ReviewFlag[] {
  return scorers.flatMap((s) => s.reviewFlags ?? []);
}

/** Format a metric value for display (ratios → 3dp, otherwise raw). */
function fmtValue(m: Metric): string {
  if (m.unit === "ratio" || m.unit === undefined) return m.value.toFixed(3);
  return `${m.value}${m.unit === "ms" ? " ms" : m.unit === "usd" ? " usd" : ""}`;
}

/** Build the human-/reviewer-facing Markdown report. */
function renderMarkdown(
  report: EvalReport,
  skipped: SkippedScorer[],
  flags: ReviewFlag[],
): string {
  const { meta } = report;
  const lines: string[] = [];

  lines.push(`# Offline eval report`);
  lines.push("");
  lines.push(`- **Timestamp:** ${meta.ts}`);
  lines.push(`- **Commit:** ${meta.commit ?? "(unknown)"}`);
  lines.push(`- **Backend:** ${meta.backend ?? "(none — offline fixtures only)"}`);
  lines.push(`- **Offline:** ${meta.offline}`);
  lines.push("");

  // ── Metrics table ─────────────────────────────────────────────────────────
  lines.push(`## Metrics`);
  lines.push("");
  const metricEntries = Object.values(report.metrics);
  if (metricEntries.length === 0) {
    lines.push(`_No metrics — every scorer was skipped._`);
  } else {
    lines.push(`| key | value | direction |`);
    lines.push(`| --- | ----- | --------- |`);
    for (const m of metricEntries) {
      const dir = m.greaterIsBetter ? "↑ higher is better" : "↓ lower is better";
      lines.push(`| \`${m.key}\` | ${fmtValue(m)} | ${dir} |`);
    }
  }
  lines.push("");

  // ── Scorers section ───────────────────────────────────────────────────────
  lines.push(`## Scorers`);
  lines.push("");
  if (report.scorers.length > 0) {
    lines.push(`**Ran:**`);
    for (const s of report.scorers) {
      lines.push(`- \`${s.layer}\` ${s.name} — ${s.metrics.length} metric(s), ${s.examples.length} example(s)`);
    }
    lines.push("");
  }
  if (skipped.length > 0) {
    lines.push(`**Skipped:**`);
    for (const s of skipped) {
      lines.push(`- ${s.name} — ${s.reason}`);
    }
    lines.push("");
  }
  if (report.scorers.length === 0 && skipped.length === 0) {
    lines.push(`_No scorers configured._`);
    lines.push("");
  }

  // ── Review queue section ──────────────────────────────────────────────────
  lines.push(`## Review queue`);
  lines.push("");
  if (flags.length === 0) {
    lines.push(`_No turns flagged for human review._`);
  } else {
    lines.push(`${flags.length} flag(s) appended to \`review-queue.jsonl\`:`);
    lines.push("");
    lines.push(`| id | reason | scores |`);
    lines.push(`| -- | ------ | ------ |`);
    for (const f of flags) {
      const scoreStr = Object.entries(f.scores)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`| \`${f.id}\` | ${f.reason} | ${scoreStr || "—"} |`);
    }
  }
  lines.push("");

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push(`---`);
  lines.push(`_commit ${meta.commit ?? "(unknown)"} · ${meta.ts}_`);
  lines.push("");

  return lines.join("\n");
}

/** Print the per-metric table to the CLI (mirrors the Markdown table). */
function printMetricTable(report: EvalReport): void {
  const metricEntries = Object.values(report.metrics);
  console.log(`\n📊 Metrics`);
  if (metricEntries.length === 0) {
    console.log(`   (none — every scorer was skipped)\n`);
    return;
  }
  const keyW = Math.max(3, ...metricEntries.map((m) => m.key.length));
  console.log(`   ${"key".padEnd(keyW)}  value    direction`);
  console.log(`   ${"─".repeat(keyW)}  ───────  ─────────`);
  for (const m of metricEntries) {
    const dir = m.greaterIsBetter ? "↑ higher" : "↓ lower";
    console.log(`   ${m.key.padEnd(keyW)}  ${fmtValue(m).padStart(7)}  ${dir}`);
  }
  console.log("");
}

/**
 * Run every scorer, assemble the {@link EvalReport}, write artifacts, and
 * enqueue review flags. Safe to call programmatically (the gate does).
 *
 * Writes three files to `reports/`:
 *   - `eval-<ts>.json` — the full machine-readable report.
 *   - `eval-<ts>.md`   — human-/reviewer-facing summary.
 *   - `latest.json`    — copy of the newest report (stable path for the gate).
 *
 * @returns The assembled {@link EvalReport}.
 */
export async function runEval(): Promise<EvalReport> {
  const ts = new Date().toISOString();
  console.log(`\n🧪 chatbot-tests offline eval runner`);
  console.log(`   ts: ${ts}`);

  const results: ScorerResult[] = [];
  const skipped: SkippedScorer[] = [];

  console.log(`\n   Running scorers…`);

  // SAFETY guard — offline, always works (if the module exists).
  try {
    const scoreGuard = await loadGuard();
    await runScorer("Guard classifier", scoreGuard, results, skipped);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    skipped.push({ name: "Guard classifier", reason });
    console.log(`   ⚠ Guard classifier SKIPPED — ${reason}`);
  }

  // L1 model — offline over recordings; degrades gracefully if none recorded.
  try {
    const scoreModel = await loadModel();
    await runScorer("L1 Model", scoreModel, results, skipped);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    skipped.push({ name: "L1 Model", reason });
    console.log(`   ⚠ L1 Model SKIPPED — ${reason}`);
  }

  // L2 retrieval — THROWS if fixtures/query-embeddings.json is missing.
  try {
    const scoreRetrieval = await loadRetrieval();
    await runScorer("L2 Retrieval", () => scoreRetrieval(3), results, skipped);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    skipped.push({ name: "L2 Retrieval", reason });
    console.log(`   ⚠ L2 Retrieval SKIPPED — ${reason}`);
  }

  // L3 trajectory — degrades gracefully (no throw on missing recordings).
  try {
    const scoreTrajectory = await loadTrajectory();
    await runScorer("L3 Trajectory", scoreTrajectory, results, skipped);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    skipped.push({ name: "L3 Trajectory", reason });
    console.log(`   ⚠ L3 Trajectory SKIPPED — ${reason}`);
  }

  const report: EvalReport = {
    meta: {
      ts,
      commit: currentCommit(),
      backend: detectBackend(),
      offline: true,
    },
    scorers: results,
    metrics: flattenMetrics(results),
  };

  // ── Write artifacts ─────────────────────────────────────────────────────
  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = safeStamp(ts);
  const jsonPath = resolve(REPORTS_DIR, `eval-${stamp}.json`);
  const mdPath = resolve(REPORTS_DIR, `eval-${stamp}.md`);
  const latestPath = resolve(REPORTS_DIR, "latest.json");

  const flags = collectFlags(results);
  const json = JSON.stringify(report, null, 2);
  writeFileSync(jsonPath, json + "\n", "utf8");
  writeFileSync(mdPath, renderMarkdown(report, skipped, flags), "utf8");
  writeFileSync(latestPath, json + "\n", "utf8");

  // ── Append review flags to the queue ──────────────────────────────────────
  enqueue(flags);

  printMetricTable(report);
  console.log(`   ✍  wrote ${jsonPath}`);
  console.log(`   ✍  wrote ${mdPath}`);
  console.log(`   ✍  refreshed ${latestPath}`);
  console.log(
    `   Scorers: ${results.length} ran · ${skipped.length} skipped · ` +
      `${flags.length} review flag(s) queued\n`,
  );

  return report;
}

async function main(): Promise<void> {
  await runEval();
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err: unknown) => {
    console.error(`❌ eval runner failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
