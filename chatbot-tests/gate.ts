#!/usr/bin/env tsx
/**
 * Module 3 — Regression Gate (slide 7).
 *
 * "Blocks deploy if L2 precision drops > 5pp from baseline" — generalised to
 * every metric in the baseline. The gate runs the eval (or reads the latest
 * report with `--use-latest`), compares each baselined metric against the fresh
 * value in the *worse* direction (using `greaterIsBetter`), and exits non-zero
 * if any metric regressed beyond tolerance.
 *
 * Coverage regressions count: a metric that the baseline expects but that's
 * MISSING from the current report (because its scorer was skipped) FAILS — you
 * don't get to hide a regression by not measuring it.
 *
 * Tolerances come from {@link GateConfig}: absolute (0.05 = 5pp) and an optional
 * relative tolerance, with per-metric overrides. Defaults are overridable via an
 * optional `gate.config.json`.
 *
 * Run via:
 *   `npx tsx gate.ts`                    — fresh eval, then gate. Exit 0/1.
 *   `npx tsx gate.ts --use-latest`       — gate against reports/latest.json.
 *   `npx tsx gate.ts --update-baseline`  — fresh eval, then overwrite baseline.
 *
 * Exit codes:
 *   0 — no metric regressed beyond tolerance.
 *   1 — at least one metric regressed (or disappeared).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Baseline, EvalReport, GateConfig, Metric } from "./scorers/types.js";
import { runEval } from "./eval-runner.js";

const BASELINE_PATH = resolve("baseline.json");
const GATE_CONFIG_PATH = resolve("gate.config.json");
const LATEST_REPORT_PATH = resolve("reports", "latest.json");

/** Default gate tolerances — 5pp absolute, no relative, no per-metric overrides. */
const DEFAULT_CONFIG: GateConfig = {
  absoluteTolerance: 0.05,
};

/** Per-metric verdict for the printed table. */
interface MetricVerdict {
  key: string;
  baseline: number;
  current: number | null;
  /** Regression magnitude in the worse direction (negative = improvement). */
  regression: number | null;
  status: "pass" | "fail";
  note: string;
}

/** Load the baseline, throwing a clear error if it's absent. */
function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `baseline.json not found at ${BASELINE_PATH} — run \`gate.ts --update-baseline\` first.`,
    );
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

/** Load gate.config.json if present, else fall back to defaults. */
function loadConfig(): GateConfig {
  if (!existsSync(GATE_CONFIG_PATH)) return DEFAULT_CONFIG;
  const parsed = JSON.parse(readFileSync(GATE_CONFIG_PATH, "utf8")) as Partial<GateConfig>;
  return {
    absoluteTolerance: parsed.absoluteTolerance ?? DEFAULT_CONFIG.absoluteTolerance,
    relativeTolerance: parsed.relativeTolerance,
    perMetric: parsed.perMetric,
  };
}

/** Read the short commit hash, or null when git is unavailable. */
function currentCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Read reports/latest.json as an EvalReport, throwing if it's missing. */
function loadLatestReport(): EvalReport {
  if (!existsSync(LATEST_REPORT_PATH)) {
    throw new Error(
      `--use-latest given but ${LATEST_REPORT_PATH} not found — run the eval-runner first.`,
    );
  }
  return JSON.parse(readFileSync(LATEST_REPORT_PATH, "utf8")) as EvalReport;
}

/**
 * Effective absolute/relative tolerance for one metric (per-metric overrides win).
 *
 * @param key - Metric key.
 * @param config - Gate config (defaults + optional overrides).
 */
function effectiveTolerance(
  key: string,
  config: GateConfig,
): { absolute: number; relative: number | undefined } {
  const override = config.perMetric?.[key];
  return {
    absolute: override?.absoluteTolerance ?? config.absoluteTolerance,
    relative: override?.relativeTolerance ?? config.relativeTolerance,
  };
}

/**
 * Gate a fresh report against a baseline.
 *
 * For each baselined metric, the regression is measured in the worse direction:
 *   greaterIsBetter  → regression = baseline.value - current.value
 *   !greaterIsBetter → regression = current.value - baseline.value
 * A metric fails if `regression` exceeds the effective absolute tolerance (or
 * the relative tolerance × baseline, when configured). Improvements (negative
 * regression) never fail. Metrics missing from the report fail as a coverage
 * regression. Metrics present in the report but absent from the baseline are
 * reported as warnings (new metric), never failures.
 *
 * @param report - The current {@link EvalReport}.
 * @param baseline - The {@link Baseline} to compare against.
 * @param config - {@link GateConfig} tolerances.
 * @returns Per-metric verdicts, new-metric warnings, and an overall `failed`.
 */
function gate(
  report: EvalReport,
  baseline: Baseline,
  config: GateConfig,
): { verdicts: MetricVerdict[]; newMetrics: string[]; failed: boolean } {
  const verdicts: MetricVerdict[] = [];
  let failed = false;

  for (const [key, base] of Object.entries(baseline.metrics)) {
    const current = report.metrics[key];

    if (current === undefined) {
      // Coverage regression — the scorer that emits this metric was skipped.
      failed = true;
      verdicts.push({
        key,
        baseline: base.value,
        current: null,
        regression: null,
        status: "fail",
        note: `metric ${key} disappeared from report (coverage regression)`,
      });
      continue;
    }

    const regression = base.greaterIsBetter
      ? base.value - current.value
      : current.value - base.value;

    const tol = effectiveTolerance(key, config);
    const relAllowance = tol.relative !== undefined ? tol.relative * base.value : undefined;
    // A metric fails only if it breaches the absolute AND (when set) the
    // relative allowance — relative tightens or loosens the absolute floor.
    const breachAbsolute = regression > tol.absolute;
    const breachRelative = relAllowance !== undefined ? regression > relAllowance : true;
    const regressed = breachAbsolute && breachRelative;

    if (regressed) failed = true;
    verdicts.push({
      key,
      baseline: base.value,
      current: current.value,
      regression,
      status: regressed ? "fail" : "pass",
      note: regressed
        ? `regressed ${regression.toFixed(3)} > tol ${tol.absolute}${
            relAllowance !== undefined ? `/${relAllowance.toFixed(3)}` : ""
          }`
        : regression <= 0
          ? "improved or unchanged"
          : `within tolerance (Δ ${regression.toFixed(3)} ≤ ${tol.absolute})`,
    });
  }

  // New metrics: present in report, absent from baseline → warn, never fail.
  const newMetrics = Object.keys(report.metrics).filter(
    (k) => !(k in baseline.metrics),
  );

  return { verdicts, newMetrics, failed };
}

/** Print the metric | baseline | current | Δ | verdict table. */
function printVerdictTable(
  verdicts: MetricVerdict[],
  newMetrics: string[],
  report: EvalReport,
): void {
  console.log(`\n🚦 Regression gate`);

  if (verdicts.length === 0) {
    console.log(`   (baseline has no metrics — nothing to gate yet)`);
  } else {
    const keyW = Math.max(6, ...verdicts.map((v) => v.key.length));
    console.log(
      `   ${"metric".padEnd(keyW)}  baseline  current   Δ(worse)  verdict`,
    );
    console.log(
      `   ${"─".repeat(keyW)}  ────────  ────────  ────────  ───────`,
    );
    for (const v of verdicts) {
      const cur = v.current === null ? "MISSING" : v.current.toFixed(3);
      const delta = v.regression === null ? "—" : v.regression.toFixed(3);
      const mark = v.status === "fail" ? "✗ FAIL" : "✓ pass";
      console.log(
        `   ${v.key.padEnd(keyW)}  ${v.baseline.toFixed(3).padStart(8)}  ${cur.padStart(8)}  ${delta.padStart(8)}  ${mark}`,
      );
      if (v.status === "fail") console.log(`   ${" ".repeat(keyW)}  └─ ${v.note}`);
    }
  }

  for (const k of newMetrics) {
    const m = report.metrics[k]!;
    console.log(`   ⚠ new metric, no baseline yet: ${k} = ${m.value.toFixed(3)}`);
  }
  console.log("");
}

/**
 * Scan every scorer's ExampleScores and print failing examples (value === 0).
 *
 * This is the per-example regression view reviewers need — which exact scenario
 * / query / corpus item the failure traces to.
 *
 * NOTE (future enhancement): this prints absolute failures (value === 0), not a
 * per-example diff against a previous run. Full per-example-vs-baseline diffing
 * (e.g. an example that went 1→0 since the last green run) requires persisting
 * per-example baselines and is left as a documented next step.
 */
function printFailingExamples(report: EvalReport): void {
  const failing = report.scorers.flatMap((s) =>
    s.examples
      .filter((e) => e.value === 0)
      .map((e) => ({ layer: s.layer, ...e })),
  );

  console.log(`🔬 Failing examples (value === 0)`);
  if (failing.length === 0) {
    console.log(`   (none)\n`);
    return;
  }
  for (const e of failing) {
    const detail = e.detail ? ` — ${e.detail}` : "";
    console.log(`   ✗ [${e.layer}] ${e.id}  (${e.metricKey})${detail}`);
  }
  console.log("");
}

/**
 * `--update-baseline`: run a fresh eval and overwrite baseline.json from the
 * current report's metrics. Deliberate operator action (the `eval:baseline:update`
 * script) — captures every metric the report currently emits.
 */
async function updateBaseline(): Promise<void> {
  console.log(`\n📌 Updating baseline from a fresh eval run…`);
  const report = await runEval();

  const metrics: Baseline["metrics"] = {};
  for (const m of Object.values(report.metrics)) {
    metrics[m.key] = { value: m.value, greaterIsBetter: m.greaterIsBetter };
  }

  const baseline: Baseline = {
    captured: new Date().toISOString().slice(0, 10),
    commit: currentCommit(),
    metrics,
  };

  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log(
    `   ✍  wrote ${BASELINE_PATH} — ${Object.keys(metrics).length} metric(s), captured ${baseline.captured}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--update-baseline")) {
    await updateBaseline();
    process.exit(0);
  }

  const useLatest = args.includes("--use-latest");
  let report: EvalReport;
  if (useLatest) {
    console.log(`\n🚦 Gate reading reports/latest.json (--use-latest)`);
    report = loadLatestReport();
  } else {
    report = await runEval();
  }

  const baseline = loadBaseline();
  const config = loadConfig();
  const { verdicts, newMetrics, failed } = gate(report, baseline, config);

  printVerdictTable(verdicts, newMetrics, report);
  printFailingExamples(report);

  const failedKeys = verdicts.filter((v) => v.status === "fail").map((v) => v.key);
  if (failed) {
    console.log(`❌ GATE FAILED — ${failedKeys.length} metric(s) regressed: ${failedKeys.join(", ")}`);
    console.log(`   (blocks deploy)\n`);
    process.exit(1);
  }
  console.log(`✅ GATE PASSED — no metric regressed beyond tolerance.\n`);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err: unknown) => {
    console.error(`❌ gate failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
