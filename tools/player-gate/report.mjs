// The cost report: reads the JSON lines `drive.mjs` wrote and prints, per cell, the sample count and the median
// [min–max] of each of its numbers, with the conditions they depend on; then every excluded cell with its reason.
// A row whose axis value is not declared fails the report (exit 1), and so does a required cell without samples or with
// one that fails the shared validation (`derive.mjs`; the A/A run needs both arms), or no artifact inventory
// ("incomplete"). Every number is derived from the rows' records there. Phase medians are never summed.
//   node tools/player-gate/report.mjs --phase r0|r1 [--json FILE] [--artifacts FILE]... RESULTS.jsonl...
import { readFileSync, writeFileSync } from "node:fs";
import { allCells, cellName, classify } from "./cells.mjs";
import { deriveSample } from "./derive.mjs";
import { summarize } from "./lib/measure.mjs";

const format = ({ n, median, min, max }) =>
  n === 0 ? "—" : `${round(median)} [${round(min)}–${round(max)}] (n=${n})`;
const round = (value) => (Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

/** What a reader needs beside a scenario's numbers. */
const NOTES = {
  aa: "The two arms' difference estimates the full probe's incremental cost beyond the shared observer, over the cold interval; the shared observer's own cost is an unmeasured residual (it is the only route to the milestones).",
  session:
    "Playable's headline is the Player's own time: navigation → the frame after Start (Continue) enabled, plus its input event → the frame after the first enabled control; the enabled → input delay is the driver's. The first save includes the plan JSON write, which is not timed apart. Bytes come from a second cold page with the CDP network account, which pauses each Worker at its start.",
};

/**
 * The artifact inventories (`artifacts.mjs`, one per build) as report lines: totals per class and once overall, each
 * file counted once.
 */
function artifactLines(inventories) {
  const lines = ["## Artifacts (files, every engine)", ""];
  if (inventories.length === 0)
    return { lines: [...lines, "No inventory given.", ""], complete: false };
  for (const inventory of inventories) {
    lines.push(
      `${inventory.build}: ${inventory.files.length} files.`,
      "",
      "| Class | Raw | gzip | brotli |",
      "| --- | --- | --- | --- |",
    );
    for (const [name, total] of Object.entries(inventory.totals))
      lines.push(`| ${name} | ${total.raw} | ${total.gzip} | ${total.brotli} |`);
    lines.push("");
  }
  return { lines, complete: true };
}

/** The report over `rows` (and `artifacts`) for `phase`: its text, a summary object and whether it is complete. */
export function buildReport(rows, phase, artifacts = []) {
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
    // The invariant (`derive.mjs` `deriveSample`): a sample that fails the shared validation makes its cell
    // incomplete; it is never left out to let the others stand for the cell.
    const derived = data.map((row) => ({ row, ...deriveSample(cell, row) }));
    const failing = derived.filter((sample) => sample.problems.length > 0);
    const delays =
      cell.scenario === "delayedSmoke"
        ? [0, 50, 250].filter((delay) => !data.some((row) => row.delayMs === delay))
        : [];
    // The A/A run needs both arms.
    const arms = cell.scenario === "aa" ? ["full", "minimal"] : [null];
    const missingArms = arms.filter(
      (arm) => arm !== null && !data.some((row) => row.result.arm === arm),
    );
    if (data.length === 0 || failing.length > 0 || delays.length > 0 || missingArms.length > 0) {
      const reasons = [...new Set(failing.flatMap((sample) => sample.problems))];
      incomplete.push(
        `- ${name}: ${data.length} samples, ${failing.length} failing the validation${delays.length > 0 ? `, no run at ${delays.join(", ")} ms` : ""}${missingArms.length > 0 ? `, no ${missingArms.join(" or ")} arm` : ""}${reasons.length > 0 ? `; ${reasons.join("; ")}` : ""}`,
      );
      continue;
    }
    const conditions = [
      ...new Set(
        data.map(
          (row) =>
            `${row.engine} ${row.version}${row.battery ? `, battery ${row.battery.level} % ${row.battery.temperatureC} °C` : ""}; ${row.build} ${row.commit ?? "(commit unknown)"}; ${row.hostPolicy ?? ""}`,
        ),
      ),
    ];
    lines.push(
      `## ${name}`,
      "",
      `${data.length} samples, all validated. ${conditions.join(" | ")}`,
      "",
    );
    if (NOTES[cell.scenario]) lines.push(NOTES[cell.scenario], "");
    lines.push("| Number | Value | Unit |", "| --- | --- | --- |");
    summary[name] = {};
    for (const arm of arms)
      for (const [index, { label, unit }] of derived[0].values.entries()) {
        const named = arm === null ? label : `${arm} probe: ${label}`;
        const value = summarize(
          derived
            .filter((sample) => arm === null || sample.row.result.arm === arm)
            .map((sample) => sample.values[index].value),
        );
        summary[name][named] = value;
        lines.push(`| ${named} | ${format(value)} | ${unit} |`);
      }
    lines.push("");
  }
  const files = artifactLines(artifacts);
  lines.push(...files.lines);
  if (!files.complete) incomplete.push("- artifacts: no inventory given");
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
  const artifacts = [];
  for (let file; (file = take("--artifacts")) !== null;)
    artifacts.push(JSON.parse(readFileSync(file, "utf8")));
  const rows = args.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line)),
  );
  let report;
  try {
    report = buildReport(rows, phase, artifacts);
  } catch (error) {
    console.error(`player-gate report: ${error.message}`);
    process.exit(1);
  }
  console.log(report.text);
  if (json !== null) writeFileSync(json, JSON.stringify(report.summary, null, 2));
  process.exit(report.complete ? 0 : 1);
}
