#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { writeJson } from "../lib/json.mjs";
try {
  const [input, out] = process.argv.slice(2);
  if (!input || !out) throw new Error("Usage: node bin/metrics.mjs RESULTS.jsonl OUTPUT.json");
  const rows = readFileSync(input, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const measured = rows.filter((r) => r.metrics),
    sum = (k) => measured.reduce((n, r) => n + (r.metrics[k] ?? 0), 0);
  const result = {
    schemaVersion: 1,
    rows: rows.length,
    measuredRows: measured.length,
    cpuMeasuredRows: measured.filter((r) => Number.isFinite(r.metrics.cpuMs)).length,
    stageSumMs: {
      analysis: sum("analysisMs"),
      compilation: sum("compileMs"),
      runtime: sum("runtimeMs"),
      total: sum("totalMs"),
      cpu: sum("cpuMs"),
    },
    workerPeakRssKiB: Math.max(0, ...measured.map((r) => r.metrics.workerPeakRssKiB ?? 0)),
    notes:
      "RSS is process high-water, not independent per-case allocation; CPU sum covers rows carrying cpuMs only; stage sums exclude sealing, compilation preparation, queue delay and IPC.",
  };
  writeJson(out, result);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
