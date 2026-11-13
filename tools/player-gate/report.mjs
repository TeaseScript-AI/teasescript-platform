// The cost report: reads the JSON lines `drive.mjs` wrote and prints, per cell, the sample count and the median
// [min–max] of each of its numbers, with the conditions they depend on; then every excluded cell with its reason.
// Each row is parsed first against its scenario's shape (`lib/records.mjs`). A row whose header does not parse or
// whose axis value is not declared fails the report (exit 1), and so does a required cell without samples or with one
// that fails the shared validation (`validate.mjs`; the A/A run needs both arms), or no artifact inventory
// ("incomplete"). Every number is derived from the rows' records there. Phase medians are never summed.
//   node tools/player-gate/report.mjs --phase r0|r1 [--json FILE] [--artifacts FILE]... RESULTS.jsonl...
import { readFileSync, writeFileSync } from "node:fs";
import { allCells, cellName, classify } from "./cells.mjs";
import { isValidated, PASS_FAIL, validateSample } from "./validate.mjs";
import { isParsedRow, parseRow } from "./lib/records.mjs";
import { summarize } from "./lib/measure.mjs";

const format = ({ n, median, min, max }) =>
  n === 0 ? "—" : `${round(median)} [${round(min)}–${round(max)}] (n=${n})`;
const round = (value) => (Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

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
  const passedOf = (sample) =>
    sample.timing.values.find(({ label }) => label === "passed")?.value === 1;
  const rows = derived.map((sample) => ({ ...sample.header, passed: passedOf(sample) }));
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
  const lines = ["## Artifacts (files, every engine; byte evidence, outside the headline)", ""];
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

/** A sub-cell's name: the scenario's cell itself for `timing`, else `<cell> / bytes and counts` or `<cell> / cross-clock`. */
const SUB_CELLS = { counts: "bytes and counts", crossClock: "cross-clock" };

/** What a reader needs beside a sub-cell's numbers. */
const SUB_NOTES = {
  crossClock:
    "Cross-clock: each number is the Worker's clock minus the page's (both epoch-based), not an interval on one clock. Firefox and WebKit coarsen each clock to 1 ms, so a delivery can read negative: the sign is kept, never clamped, and the [min–max] is the range these samples show.",
};

/**
 * One cell's table: `| label | median [min–max] (n) | unit |` per field of `samples`' `values` (for `arms`, each arm
 * apart), its values into `table`.
 */
function tableLines(samples, arms, table) {
  const lines = ["| Number | Value | Unit |", "| --- | --- | --- |"];
  for (const arm of arms)
    for (const [index, { label, unit }] of samples[0].values.entries()) {
      const named = arm === null ? label : `${arm} probe: ${label}`;
      const value = summarize(
        samples
          .filter((sample) => arm === null || sample.arm === arm)
          .map((sample) => sample.values[index].value),
      );
      table[named] = value;
      lines.push(`| ${named} | ${format(value)} | ${unit} |`);
    }
  return lines;
}

/**
 * The report over the parsed rows `rows` (`records.mjs` `parseRow`; a row it did not make is refused) and `artifacts`
 * for `phase`: its text, the summary of the headline cells, the cells outside the headline, and whether it is complete.
 */
export function buildReport(rows, phase, artifacts = []) {
  const byCell = new Map();
  for (const row of rows) {
    if (!isParsedRow(row)) throw new Error("a row the report did not parse (records.mjs parseRow)");
    const { scenario, script, route, backend, engine } = row.header;
    const cell = { scenario, script, route, backend, engine };
    const decision = classify(cell, phase);
    if (!decision.required)
      throw new Error(`a row for the excluded cell ${cellName(cell)} (${decision.reason})`);
    const name = cellName(cell);
    if (!byCell.has(name)) byCell.set(name, { cell, rows: [] });
    byCell.get(name).rows.push(row);
  }
  const lines = [
    `# L5 gate cost report (${phase})`,
    "",
    "Validated: each value derives from records whose structure, domains, order relations and needed evidence passed the kit's validation; it does not say that a derivation pairs the right records or computes the right formula (`tools/player-gate/README.md`).",
    "",
  ];
  const incomplete = [];
  const excluded = [];
  const summary = {};
  // The bytes-and-counts and cross-clock cells: printed apart, never in `summary` or the comparison.
  const outsideLines = [];
  const outsideHeadline = {};
  for (const cell of allCells()) {
    const decision = classify(cell, phase);
    const name = cellName(cell);
    if (!decision.required) {
      excluded.push(`- ${name}: ${decision.reason}`);
      continue;
    }
    const data = byCell.get(name)?.rows ?? [];
    // The invariant (`validate.mjs` `validateSample`): a sample that fails the shared validation makes its cell
    // incomplete; it is never left out to let the others stand for the cell. Each of a cell's parts is its own boundary.
    const derived = data.map((row) => {
      const cells = validateSample(cell, row);
      if (!isValidated(cells)) throw new Error("a sample validateSample did not validate");
      return { header: row.header, ...cells };
    });
    const conditions = [
      ...new Set(
        data.map(
          ({ header: row }) =>
            `${row.engine} ${row.version}${row.battery ? `, battery ${row.battery.level} % ${row.battery.temperatureC} °C` : ""}; ${row.build} ${row.commit ?? "(commit unknown)"}; ${row.hostPolicy ?? ""}`,
        ),
      ),
    ];
    timingCell(cell, name, derived, conditions, { lines, incomplete, summary });
    for (const [sub, label] of Object.entries(SUB_CELLS)) {
      if (derived.length === 0 || derived[0][sub] === null) continue;
      const subName = `${name} / ${label}`;
      const failing = derived.filter((sample) => sample[sub].problems.length > 0);
      if (failing.length > 0) {
        incomplete.push(
          `- ${subName}: ${derived.length} samples, ${failing.length} failing; ${[...new Set(failing.flatMap((sample) => sample[sub].problems))].join("; ")}`,
        );
        continue;
      }
      const table = (outsideHeadline[subName] = {});
      outsideLines.push(
        `## ${subName} (measured, validated)`,
        "",
        `${derived.length} samples, measured, validated.`,
        "",
      );
      if (SUB_NOTES[sub]) outsideLines.push(SUB_NOTES[sub], "");
      outsideLines.push(
        ...tableLines(
          derived.map((sample) => sample[sub]),
          [null],
          table,
        ),
      );
      if (sub === "counts") outsideLines.push(...retryLines(derived, table));
      outsideLines.push("");
    }
  }
  lines.push(
    "## Cells outside the headline",
    "",
    "Outside the headline and the R0 comparison, which are timings and pass/fail only.",
    "",
    ...(outsideLines.length === 0 ? ["None with samples.", ""] : outsideLines),
  );
  // The build's files and their sizes: byte evidence too, outside the headline, which is timings only.
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
    outsideHeadline,
    complete: incomplete.length === 0,
    incomplete,
  };
}

/** A headline cell: its table into `lines` and `summary`, or its line in `incomplete` with why. */
function timingCell(cell, name, derived, conditions, { lines, incomplete, summary }) {
  const failing = derived.filter((sample) => sample.timing.problems.length > 0);
  const delays =
    cell.scenario === "delayedSmoke"
      ? [0, 50, 250].filter((delay) => !derived.some(({ header }) => header.delayMs === delay))
      : [];
  // The A/A run needs both arms.
  const arms = cell.scenario === "aa" ? ["full", "minimal"] : [null];
  const missingArms = arms.filter(
    (arm) => arm !== null && !derived.some(({ header }) => header.arm === arm),
  );
  if (derived.length === 0 || failing.length > 0 || delays.length > 0 || missingArms.length > 0) {
    const reasons = [...new Set(failing.flatMap((sample) => sample.timing.problems))];
    incomplete.push(
      `- ${name}: ${derived.length} samples, ${failing.length} failing the kit's checks${delays.length > 0 ? `, no run at ${delays.join(", ")} ms` : ""}${missingArms.length > 0 ? `, no ${missingArms.join(" or ")} arm` : ""}${reasons.length > 0 ? `; ${reasons.join("; ")}` : ""}`,
    );
    return;
  }
  const table = (summary[name] = {});
  lines.push(
    `## ${name} (measured, validated)`,
    "",
    `${derived.length} samples, measured, validated. ${conditions.join(" | ")}`,
    "",
  );
  if (NOTES[cell.scenario]) lines.push(NOTES[cell.scenario], "");
  for (const condition of conditionLines(cell)) lines.push(condition, "");
  if (PASS_FAIL.has(cell.scenario)) lines.push(resultLine(cell.scenario, derived), "");
  lines.push(
    ...tableLines(
      derived.map((sample) => ({ ...sample.timing, arm: sample.header.arm })),
      arms,
      table,
    ),
    "",
  );
}

/** The byte page's retries, where the bytes are: how many attempts the cell discarded in all. */
function retryLines(derived, table) {
  const retry = derived[0].counts.values.findIndex(({ label }) =>
    label.startsWith("byte pages discarded"),
  );
  if (retry === -1) return [];
  const total = derived.reduce((sum, sample) => sum + (sample.counts.values[retry].value ?? 0), 0);
  table["byte pages discarded, in all"] = total;
  return ["", `Byte pages discarded and loaded again: ${total} over ${derived.length} samples.`];
}

if (import.meta.main) {
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
  let report;
  try {
    // The one place the raw rows are held: each is parsed at once, and the report reads only the parsed rows.
    const rows = args.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line, where: `${file}:${index + 1}` }))
        .filter(({ line }) => line.trim() !== "")
        .map(({ line, where }) => parseRow(JSON.parse(line), where)),
    );
    report = buildReport(rows, phase, artifacts);
  } catch (error) {
    console.error(`player-gate report: ${error.message}`);
    process.exit(1);
  }
  console.log(report.text);
  if (json !== null) writeFileSync(json, JSON.stringify(report.summary, null, 2));
  process.exit(report.complete ? 0 : 1);
}
