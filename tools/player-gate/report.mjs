// The cost report: reads the JSON lines `drive.mjs` wrote and prints, per cell, the sample count and the median
// [min–max] of each of its numbers, with the conditions they depend on; then every excluded cell with its reason.
// A row whose axis value is not declared fails the report (exit 1), and so does a required cell without an ok sample
// ("incomplete"). Phase medians are never summed.
//   node tools/player-gate/report.mjs --phase r0|r1 [--json FILE] RESULTS.jsonl...
import { readFileSync, writeFileSync } from "node:fs";
import { allCells, cellName, classify } from "./cells.mjs";
import { summarize } from "./lib/measure.mjs";

/** The numbers each scenario reports, as `[label, unit, value of one sample's result]`. */
const NUMBERS = {
  session: [
    ["navigation → Start enabled", "ms", (r) => r.cold?.startEnabledMs],
    ["cold: navigation → playable", "ms", (r) => r.cold?.playableMs],
    ["cold: press → playable", "ms", (r) => r.cold?.pressToPlayableMs],
    ["repeat: reload → playable", "ms", (r) => r.repeat?.playableMs],
    ["repeat: press → playable", "ms", (r) => r.repeat?.pressToPlayableMs],
    ["Worker: construction → ready", "ms", (r) => r.worker?.startMs],
    ["first save: Start → commit", "ms", (r) => r.firstSave?.startToCommitMs],
    ["first save: long tasks", "ms", (r) => r.firstSave?.longTasksMs],
    ["first save: plan JSON", "UTF-16 units", (r) => r.firstSave?.planJsonLength],
    [
      "turn: input → feedback frame (median of the sample's turns)",
      "ms",
      (r) => summarize((r.turns ?? []).map((t) => t.feedbackMs)).median,
    ],
    [
      "turn: input → settled frame (median of the sample's turns)",
      "ms",
      (r) => summarize((r.turns ?? []).map((t) => t.settledMs)).median,
    ],
    ["turns answered", "", (r) => (r.turns ?? []).filter((t) => t.ok !== false).length],
    ["served before Start enabled (page)", "bytes", (r) => bytesOf(r, "page", "beforeStart")],
    ["served before playable (page)", "bytes", (r) => bytesOf(r, "page", "beforePlayable")],
    ["served by Workers", "bytes", (r) => bytesOf(r, "worker", null)],
    ["page heap at playable", "bytes", (r) => heapAt(r, "playable", "page")],
    ["engine Worker heap at playable", "bytes", (r) => heapAt(r, "playable", "engine")],
    ["page heap at the end, after GC", "bytes", (r) => heapAt(r, "endAfterGc", "page")],
    ["engine Worker heap at the end, after GC", "bytes", (r) => heapAt(r, "endAfterGc", "engine")],
  ],
  taps: [
    ["taps sent", "", (r) => r.sent],
    ["taps answered", "", (r) => r.answered],
    ["taps unanswered", "", (r) => r.unanswered],
    ["delay, median", "ms", (r) => r.delay?.median],
    ["delay, max", "ms", (r) => r.delay?.max],
    ["answered within 16 ms", "", (r) => r.within16],
    ["send cadence, median", "ms", (r) => r.cadence?.median],
  ],
  bridge: [
    ["Worker: start → ready", "ms", (r) => span(r, "start", "ready")],
    ["prepare: request → reply", "ms", (r) => span(r, "ready", "prepared")],
    ["prepare: Worker receipt → reply", "ms", (r) => r.prepareInWorkerMs],
    ["prepare: post duration", "ms", (r) => r.preparePostMs],
    ["prepare: delivery latency", "ms", (r) => r.prepareDeliveryMs],
    ["input", "UTF-16 units", (r) => r.inputUnits],
    ["start: request → reply", "ms", (r) => span(r, "prepared", "started")],
    ["keep capture", "ms", (r) => span(r, "started", "captured")],
    ["restore", "ms", (r) => span(r, "captured", "restored")],
    ["continue", "ms", (r) => span(r, "restored", "continued")],
  ],
  keep: [
    [
      "completed",
      "",
      (r) => (r.outcome === "completed" || r.outcome === "durable after 1 s" ? 1 : 0),
    ],
    ["hidden → commit", "ms", (r) => r.hiddenToCommitMs],
  ],
  demo: [["errors", "", (r) => r.errors?.length]],
  delayedSmoke: [["passed", "", (r) => (r.ok ? 1 : 0)]],
};
NUMBERS.sessionInstrumented = [
  ...NUMBERS.session,
  ["start: request → reply", "ms", (r) => r.bridge?.start],
  ["turn: requests per turn (median)", "", (r) => r.bridge?.requestsPerTurn],
];
NUMBERS.aa = NUMBERS.session;
NUMBERS.bridgeTaps = NUMBERS.taps;
NUMBERS.keepHandler = NUMBERS.keep;
NUMBERS.keepCompletion = NUMBERS.keep;
NUMBERS.keepDurable = NUMBERS.keep;

function bytesOf(result, target, phase) {
  const entries = (result.bytes ?? []).filter(
    (entry) =>
      (target === "page" ? entry.target === "page" : entry.target !== "page") &&
      (phase === null || entry.phase === phase),
  );
  return entries.length === 0
    ? null
    : entries.reduce((sum, entry) => sum + (entry.transferBytes ?? 0), 0);
}
function heapAt(result, at, target) {
  const reading = (result.memory ?? []).find((entry) => entry.at === at);
  if (reading === undefined) return null;
  if (target === "page") return reading.page?.usedBytes ?? null;
  return (
    reading.workers?.find((worker) => /engine/u.test(worker.url) && worker.usedBytes !== undefined)
      ?.usedBytes ?? null
  );
}
const span = (result, from, to) =>
  result.at?.[from] === undefined || result.at?.[to] === undefined
    ? null
    : result.at[to] - result.at[from];
const format = ({ n, median, min, max }) =>
  n === 0 ? "—" : `${round(median)} [${round(min)}–${round(max)}] (n=${n})`;
const round = (value) => (Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

/** The report over `rows` for `phase`: its text, a summary object and whether it is complete. */
export function buildReport(rows, phase) {
  const byCell = new Map();
  for (const row of rows) {
    const cell = {
      scenario: row.scenario,
      script: row.script,
      route: row.route,
      backend: row.backend,
      engine: row.engine,
    };
    const decision = classify(cell, phase);
    if (!decision.required)
      throw new Error(`a row for the excluded cell ${cellName(cell)} (${decision.reason})`);
    const name = cellName(cell);
    if (!byCell.has(name)) byCell.set(name, { cell, rows: [] });
    byCell.get(name).rows.push(row);
  }
  const lines = [`# L5 gate cost report (${phase})`, ""];
  const incomplete = [];
  const excluded = [];
  const summary = {};
  for (const cell of allCells()) {
    const decision = classify(cell, phase);
    const name = cellName(cell);
    if (!decision.required) {
      excluded.push(`- ${name}: ${decision.reason}`);
      continue;
    }
    const data = byCell.get(name)?.rows ?? [];
    const ok = data.filter((row) => row.ok);
    const delays =
      cell.scenario === "delayedSmoke"
        ? [0, 50, 250].filter((delay) => !ok.some((row) => row.delayMs === delay))
        : [];
    if (ok.length === 0 || delays.length > 0) {
      incomplete.push(
        `- ${name}: ${data.length} samples, ${ok.length} ok${delays.length > 0 ? `, no passing run at ${delays.join(", ")} ms` : ""}`,
      );
      continue;
    }
    const conditions = [
      ...new Set(
        ok.map(
          (row) =>
            `${row.engine} ${row.version}${row.battery ? `, battery ${row.battery.level} % ${row.battery.temperatureC} °C` : ""}; ${row.build} ${row.commit ?? "(commit unknown)"}; ${row.hostPolicy ?? ""}`,
        ),
      ),
    ];
    lines.push(
      `## ${name}`,
      "",
      `${ok.length} ok of ${data.length} samples. ${conditions.join(" | ")}`,
      "",
      "| Number | Value | Unit |",
      "| --- | --- | --- |",
    );
    summary[name] = {};
    // The A/A run's two arms (the full probe and the minimal one) are reported apart: their difference estimates the
    // probe's own cost.
    const arms = cell.scenario === "aa" ? ["full", "minimal"] : [null];
    for (const arm of arms)
      for (const [label, unit, read] of NUMBERS[cell.scenario]) {
        const named = arm === null ? label : `${arm} probe: ${label}`;
        const value = summarize(
          ok.filter((row) => arm === null || row.result.arm === arm).map((row) => read(row.result)),
        );
        summary[name][named] = value;
        lines.push(`| ${named} | ${format(value)} | ${unit} |`);
      }
    lines.push("");
  }
  lines.push(
    "## Incomplete cells",
    "",
    ...(incomplete.length === 0 ? ["None."] : incomplete),
    "",
    "## Excluded cells",
    "",
    ...excluded,
    "",
  );
  return { text: lines.join("\n"), summary, complete: incomplete.length === 0, incomplete };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args.splice(index, 2)[1];
  };
  const phase = take("--phase");
  const json = take("--json");
  const rows = args.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line)),
  );
  let report;
  try {
    report = buildReport(rows, phase);
  } catch (error) {
    console.error(`player-gate report: ${error.message}`);
    process.exit(1);
  }
  console.log(report.text);
  if (json !== null) writeFileSync(json, JSON.stringify(report.summary, null, 2));
  process.exit(report.complete ? 0 : 1);
}
