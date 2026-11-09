// The cost report: reads the JSON lines `drive.mjs` wrote and prints, per cell, the sample count and the median
// [min–max] of each of its numbers, with the conditions they depend on; then every excluded cell with its reason.
// A row whose axis value is not declared fails the report (exit 1), and so does a required cell without samples or with
// one that fails the shared validation (`validate.mjs`; the A/A run needs both arms), or no artifact inventory
// ("incomplete"). Every number is derived from the rows' records there. Phase medians are never summed.
//   node tools/player-gate/report.mjs --phase r0|r1 [--json FILE] [--artifacts FILE]... RESULTS.jsonl...
import { readFileSync, writeFileSync } from "node:fs";
import { allCells, cellName, classify } from "./cells.mjs";
import { deriveSample, PASS_FAIL, UNVALIDATED } from "./validate.mjs";
import { summarize } from "./lib/measure.mjs";

const format = ({ n, median, min, max }) =>
  n === 0 ? "—" : `${round(median)} [${round(min)}–${round(max)}] (n=${n})`;
const round = (value) => (Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

/** The issue that holds the declared gaps (`UNVALIDATED`) until they are validated. */
const GAP_ISSUE = "#2122";

/**
 * The known measured failures of the pass/fail scenarios, each with its finding and issue; a failure not listed here is
 * reported as unexplained, a finding still to be made.
 */
const FINDINGS = {
  delayedSmoke: (row) =>
    ({
      50: "the smoke's own wait, #2125",
      250: "the Player's scene clock, the stutter track, #2126: scene time advances 100 ms per bridge round trip (about 0.4× wall at 250 ms); affects waits, pacing and timers",
    })[row.delayMs] ?? "unexplained",
  demo: (row) =>
    row.engine === "firefox"
      ? "#2113, fixed on runtime-v2 in c8a1af3df after this R0"
      : "unexplained",
};

/** A pass/fail cell's result as one line: what passed, and each failure with its finding. */
function resultLine(scenario, derived) {
  // The pass is the derivation's, from the records (`validate.mjs`), never the row's cached flag.
  const passedOf = (sample) => sample.values.find(({ label }) => label === "passed")?.value === 1;
  const rows = derived.map((sample) => ({ ...sample.row, passed: passedOf(sample) }));
  const failed = rows.filter((row) => !row.passed);
  if (failed.length === 0) return `Result: passes (${rows.length} of ${rows.length}).`;
  if (scenario === "delayedSmoke") {
    const passed = rows.filter((row) => row.passed).map((row) => `${row.delayMs} ms`);
    const fails = failed.map((row) => `at ${row.delayMs} ms (${FINDINGS.delayedSmoke(row)})`);
    return `Result: ${passed.length > 0 ? `passes at ${passed.join(", ")}; ` : ""}fails ${fails.join(" and ")}.`;
  }
  return `Result: fails in ${failed.length} of ${rows.length} samples (${[...new Set(failed.map(FINDINGS[scenario]))].join("; ")}).`;
}

/**
 * The conditions a cell's numbers depend on, written beside them: what each keep witness is (a simulated handler check
 * on the desktop, a real background on the Pixel, a force-stop's survival), and how the Pixel is driven.
 */
function conditionLines(cell) {
  const lines = [];
  if (cell.scenario === "keepHandler")
    lines.push(
      "Witness: a simulated reported-hidden handler check: the probe makes the document report hidden while the page keeps running, so it checks the Player's hidden path, not a browser's background policy.",
    );
  if (cell.scenario === "keepCompletion")
    lines.push(
      "Witness: a real background: the phone goes home (`KEYCODE_HOME`) for 30 s, then Chrome is brought back.",
    );
  if (cell.scenario === "keepDurable")
    lines.push(
      "Witness: survival of a force-stop at 1 s: home, `am force-stop` Chrome 1 s later, relaunch, then the stored snapshot read before anything continues it.",
    );
  if (cell.engine === "pixel")
    lines.push(
      "Pixel: `noDefaults`: no Playwright touch emulation; input is sent through CDP (`Input.dispatchTouchEvent`).",
    );
  return lines;
}

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
  // Cells outside the invariant (`UNVALIDATED`): their numbers print apart, never in `summary` or the comparison.
  const unvalidatedLines = [];
  const unvalidated = {};
  for (const cell of allCells()) {
    const decision = classify(cell, phase);
    const name = cellName(cell);
    if (!decision.required) {
      excluded.push(`- ${name}: ${decision.reason}`);
      continue;
    }
    const data = byCell.get(name)?.rows ?? [];
    // The invariant (`validate.mjs` `deriveSample`): a sample that fails the shared validation makes its cell
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
    const gap = UNVALIDATED[cell.scenario] ?? null;
    const out = gap === null ? lines : unvalidatedLines;
    const table = {};
    if (gap === null) summary[name] = table;
    else unvalidated[name] = table;
    out.push(
      `## ${name}${gap === null ? "" : " (unvalidated)"}`,
      "",
      `${data.length} samples, ${gap === null ? "all validated" : `outside the invariant (${gap})`}. ${conditions.join(" | ")}`,
      "",
    );
    if (NOTES[cell.scenario]) out.push(NOTES[cell.scenario], "");
    for (const condition of conditionLines(cell)) out.push(condition, "");
    if (PASS_FAIL.has(cell.scenario)) out.push(resultLine(cell.scenario, derived), "");
    out.push("| Number | Value | Unit |", "| --- | --- | --- |");
    for (const arm of arms)
      for (const [index, { label, unit }] of derived[0].values.entries()) {
        const named = arm === null ? label : `${arm} probe: ${label}`;
        const value = summarize(
          derived
            .filter((sample) => arm === null || sample.row.result.arm === arm)
            .map((sample) => sample.values[index].value),
        );
        table[named] = value;
        out.push(`| ${named} | ${format(value)} | ${unit} |`);
      }
    // The byte page's retries, where the bytes are: how many attempts the cell discarded in all.
    const retry = derived[0].values.findIndex(({ label }) =>
      label.startsWith("byte pages discarded"),
    );
    if (retry !== -1) {
      const total = derived.reduce((sum, sample) => sum + (sample.values[retry].value ?? 0), 0);
      table["byte pages discarded, in all"] = total;
      out.push(
        "",
        `Byte pages discarded and loaded again: ${total} over ${derived.length} samples.`,
      );
    }
    out.push("");
  }
  // The cells outside the invariant, apart from the headline, then the gaps they declare.
  lines.push(
    "## Unvalidated cells",
    "",
    "Outside the headline and the R0 comparison (the declared gaps below).",
    "",
    ...(unvalidatedLines.length === 0 ? ["None with samples.", ""] : unvalidatedLines),
    "## Declared gaps",
    "",
    ...Object.entries(UNVALIDATED).map(
      ([scenario, gap]) =>
        `- \`${scenario}\` (every required cell): ${gap}. ${GAP_ISSUE}: the label is lifted (these derivations validated under the kit's invariant in docs/TESTING.md) before the activation PR's R1 run, since the gate's decision is R1's.`,
    ),
    "",
  );
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
  return {
    text: lines.join("\n"),
    summary,
    unvalidated,
    complete: incomplete.length === 0,
    incomplete,
  };
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
