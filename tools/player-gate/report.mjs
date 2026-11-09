// The cost report: reads the JSON lines `drive.mjs` wrote and prints, per cell, the sample count and the median
// [min–max] of each of its numbers, with the conditions they depend on; then every excluded cell with its reason.
// A row whose axis value is not declared fails the report (exit 1), and so does a required cell without a complete
// sample (one whose every required field that applies is a finite number; the A/A run needs both arms), or no artifact
// inventory ("incomplete"). Phase medians are never summed.
//   node tools/player-gate/report.mjs --phase r0|r1 [--json FILE] [--artifacts FILE]... RESULTS.jsonl...
import { readFileSync, writeFileSync } from "node:fs";
import { allCells, cellName, classify } from "./cells.mjs";
import { deriveSample } from "./derive.mjs";
import { summarize } from "./lib/measure.mjs";

const CDP_ENGINES = new Set(["chromium", "pixel"]);
const LONG_TASK_ENGINES = CDP_ENGINES;
const isWorker = (cell) => cell.backend === "worker";
const onCdp = (cell) => CDP_ENGINES.has(cell.engine);

/**
 * The numbers each scenario reports: `[label, unit, value of one sample's result, applies(cell), required]`. A field that
 * does not apply to a cell is left out of it, never printed as a dash; a required one that applies must be a finite
 * number in a sample for that sample to count (`reviews/l5-gate/field-inventory.md`).
 */
const always = () => true;
const PLAYABLE = (of, label) => [
  [
    `${of}: playable, the Player's own time (headline)`,
    "ms",
    (r) => r[of]?.playableMs,
    always,
    true,
  ],
  [
    `${of}: navigation → the frame after ${label} enabled`,
    "ms",
    (r) => r[of]?.enabledFrameMs,
    always,
    true,
  ],
  [
    `${of}: ${label}'s input → the frame after the first control`,
    "ms",
    (r) => r[of]?.inputToControlMs,
    always,
    true,
  ],
  [
    `${of}: ${label} enabled → its input (the driver's, not in the headline)`,
    "ms",
    (r) => r[of]?.enabledToInputMs,
    always,
    true,
  ],
];
const MILESTONES = [
  ["startEnabled", "cold", "Start enabled"],
  ["playable", "cold", "playable"],
  ["firstSave", "cold", "the first save"],
  ["afterTurns", "repeat", "after the turns"],
  ["end", "repeat", "the end, after a forced GC"],
];
/**
 * The byte account's numbers, the headline session's only: the cold page's served bytes, cumulative, per target (the
 * page; every Worker together) and phase, encoded and decoded; a worker build must also show its engine Worker's own
 * requests. The instrumented cohort runs no byte account (`drive.mjs`).
 */
const BYTES = [
  ...["page", "Workers"].flatMap((target) =>
    [
      ["beforeStartEnabled", "before Start enabled"],
      ["beforePlayable", "before playable"],
      [null, "the whole cold page"],
    ].flatMap(([phase, label]) =>
      ["encoded", "decoded"].map((size) => [
        `served ${label}, ${target}, ${size}`,
        "bytes",
        (r) => bytesOf(r, target, phase, size),
        onCdp,
        true,
      ]),
    ),
  ),
  [
    "requests of the engine Worker's target",
    "",
    (r) =>
      (r.bytes?.requests ?? []).filter((q) => q.target !== "page" && /engine/u.test(q.target))
        .length || null,
    (cell) => onCdp(cell) && isWorker(cell),
    true,
  ],
];
const NUMBERS = {
  session: [
    ...PLAYABLE("cold", "Start"),
    ...PLAYABLE("repeat", "Continue"),
    ["Worker: construction → ready", "ms", (r) => r.worker?.startMs, isWorker, true],
    [
      "first save: Start's input → commit (the plan JSON write included, not timed apart)",
      "ms",
      (r) => r.firstSave?.startToCommitMs,
      always,
      true,
    ],
    [
      "first save: long tasks in that span",
      "ms",
      (r) => r.firstSave?.longTasksMs,
      (cell) => LONG_TASK_ENGINES.has(cell.engine),
      true,
    ],
    ["first save: plan JSON", "UTF-16 units", (r) => r.firstSave?.planJsonLength, always, true],
    [
      "turn: input → feedback frame (median of the sample's turns)",
      "ms",
      (r) => summarize((r.turns ?? []).map((t) => t.feedbackMs)).median,
      always,
      true,
    ],
    [
      "turn: input → settled frame (median of the sample's settled turns)",
      "ms",
      (r) => summarize((r.turns ?? []).map((t) => t.settledMs)).median,
      always,
      false,
    ],
    [
      "turns answered",
      "",
      (r) => (r.turns ?? []).filter((t) => t.ok !== false).length,
      always,
      true,
    ],
    [
      "turns ended or cut, not settled",
      "",
      (r) => (r.turns ?? []).filter((t) => t.end).length,
      always,
      false,
    ],
    ...MILESTONES.flatMap(([at, page, label]) => [
      [`heap, page (${page}), at ${label}`, "bytes", (r) => heapAt(r, at, "page"), onCdp, true],
      [
        `heap, engine Worker, at ${label}`,
        "bytes",
        (r) => heapAt(r, at, "engine"),
        (cell) => onCdp(cell) && isWorker(cell),
        true,
      ],
    ]),
    ...BYTES,
  ],
  taps: [
    ["taps sent in the window", "", (r) => r.sent, always, true],
    ["taps answered", "", (r) => r.answered, always, true],
    ["taps unanswered", "", (r) => r.unanswered, always, true],
    ["delay, median", "ms", (r) => r.delay?.median, always, false],
    ["delay, max", "ms", (r) => r.delay?.max, always, false],
    ["answered within 16 ms", "", (r) => r.within16, always, true],
    ["send cadence, median", "ms", (r) => r.cadence?.median, always, true],
    ["clock offset uncertainty", "ms", (r) => r.clock?.uncertaintyMs, always, true],
  ],
  bridge: [
    [
      "Worker: construction → ready",
      "ms",
      (r) => span(r, "workerConstructed", "workerReady"),
      isWorker,
      true,
    ],
    ["prepare: request → reply", "ms", (r) => rtt(r, "prepare"), always, true],
    [
      "prepare: Worker receipt → reply",
      "ms",
      (r) => workerSide(r, "prepare", "handlingMs"),
      isWorker,
      true,
    ],
    ["prepare: post duration", "ms", (r) => request(r, "prepare")?.postMs, always, true],
    [
      "prepare: delivery latency",
      "ms",
      (r) => workerSide(r, "prepare", "deliveryMs"),
      isWorker,
      true,
    ],
    ["input", "UTF-16 units", (r) => r.inputUnits, always, true],
    ["input", "UTF-8 bytes", (r) => r.inputBytes, always, true],
    ["start: request → reply", "ms", (r) => rtt(r, "start"), always, true],
    ["preparePlanText: request → reply", "ms", (r) => rtt(r, "preparePlanText"), always, true],
    ["captureKeep: request → reply", "ms", (r) => rtt(r, "captureKeep"), always, true],
    ["continue: request → reply", "ms", (r) => rtt(r, "continue"), always, true],
  ],
  keep: [
    [
      "completed while hidden",
      "",
      (r) => (r.outcome === "completed" || r.outcome === "durable after 1 s" ? 1 : 0),
      always,
      true,
    ],
    [
      "completed after resume",
      "",
      (r) => (r.outcome === "completed after resume" ? 1 : 0),
      always,
      false,
    ],
    ["hidden → commit", "ms", (r) => r.hiddenToCommitMs, always, false],
  ],
  demo: [["errors", "", (r) => r.errors?.length, always, true]],
  delayedSmoke: [["passed", "", (r) => (r.ok ? 1 : 0), always, true]],
};
NUMBERS.sessionInstrumented = [
  ...NUMBERS.session.filter((field) => !BYTES.includes(field)),
  [
    "diagnostic: prepare request → reply",
    "ms",
    (r) => diagnosticRtt(r, "cold", "prepare"),
    always,
    true,
  ],
  [
    "diagnostic: start request → reply",
    "ms",
    (r) => diagnosticRtt(r, "cold", "start"),
    always,
    true,
  ],
  [
    "diagnostic: continue request → reply",
    "ms",
    (r) => diagnosticRtt(r, "repeat", "continue"),
    always,
    true,
  ],
  [
    "diagnostic: captureKeep request → reply",
    "ms",
    (r) => diagnosticRtt(r, "cold", "captureKeep"),
    always,
    false,
  ],
  [
    "diagnostic: captureKeep reply",
    "UTF-16 units",
    (r) => diagnosticRequest(r, "cold", "captureKeep")?.replySize,
    always,
    false,
  ],
  [
    "diagnostic: requests per settled turn (median)",
    "",
    (r) => summarize((r.diagnostics?.turns ?? []).filter(Boolean).map((t) => t.length)).median,
    always,
    false,
  ],
  [
    "diagnostic: prepare Worker handling",
    "ms",
    (r) => r.diagnostics?.workerSide?.cold?.find((w) => w.op === "prepare")?.handlingMs,
    (cell) => onCdp(cell) && isWorker(cell),
    true,
  ],
  [
    "diagnostic: start delivery latency",
    "ms",
    (r) => r.diagnostics?.workerSide?.cold?.find((w) => w.op === "start")?.deliveryMs,
    (cell) => onCdp(cell) && isWorker(cell),
    true,
  ],
  [
    "diagnostic: scheduling gaps over 50 ms",
    "",
    (r) =>
      (r.diagnostics?.gaps?.cold?.length ?? NaN) + (r.diagnostics?.gaps?.repeat?.length ?? NaN),
    always,
    true,
  ],
];
// The A/A run compares the cold interval only: the full probe's incremental cost beyond the shared observer.
NUMBERS.aa = PLAYABLE("cold", "Start");
NUMBERS.bridgeTaps = NUMBERS.taps;
NUMBERS.keepHandler = NUMBERS.keep;
NUMBERS.keepCompletion = NUMBERS.keep;
NUMBERS.keepDurable = NUMBERS.keep;

/**
 * The served bytes (`encoded` or `decoded`) of `target` (`page` or `Workers`), all or those flagged `phase`: `null`
 * while a request is still open or a finished one lacks its length; 0 for a target that requested nothing (no Worker).
 */
function bytesOf(result, target, phase, size) {
  if (result.bytes?.requests === undefined) return null;
  const requests = result.bytes.requests.filter(
    (request) =>
      (target === "page" ? request.target === "page" : request.target !== "page") &&
      (phase === null || request[phase] === true),
  );
  if (target === "page" && requests.length === 0) return null;
  const field = size === "encoded" ? "encodedBytes" : "decodedBytes";
  if (
    requests.some(
      (request) =>
        request.failed === null && (!request.finished || !Number.isFinite(request[field])),
    )
  )
    return null;
  return requests.reduce((sum, request) => sum + (request.failed === null ? request[field] : 0), 0);
}
function heapAt(result, at, target) {
  const reading = (result.memory ?? []).find((entry) => entry.at === at);
  if (reading === undefined) return null;
  if (target === "page") return reading.page?.usedBytes ?? null;
  return (
    reading.workers?.find((worker) => worker.engine && worker.usedBytes !== undefined)?.usedBytes ??
    null
  );
}
const span = (result, from, to) =>
  result.at?.[from] === undefined || result.at?.[to] === undefined
    ? null
    : result.at[to] - result.at[from];
const request = (result, op) => (result.requests ?? []).find((entry) => entry.op === op);
const rtt = (result, op) => {
  const found = request(result, op);
  return found?.replyAt == null ? null : found.replyAt - found.postAt;
};
const workerSide = (result, op, field) =>
  result.workerSide?.find((entry) => entry.op === op)?.[field];
const diagnosticRequest = (result, page, op) =>
  result.diagnostics?.[page]?.find((entry) => entry.op === op);
const diagnosticRtt = (result, page, op) => diagnosticRequest(result, page, op)?.rttMs;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** The required fields of `cell` that `row` lacks: an empty list for a complete sample. */
export function missingFields(cell, row) {
  const { sample, problems } = deriveSample(cell, row.result);
  // A keep trial's outcome is its measurement, whichever it is.
  if (!cell.scenario.startsWith("keep") && !row.ok) return ["the sample failed", ...problems];
  return [
    ...problems,
    ...NUMBERS[cell.scenario]
      .filter(([, , read, applies, required]) => required && applies(cell) && !finite(read(sample)))
      .map(([label, unit]) => (unit === "" ? label : `${label} (${unit})`)),
  ];
}
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
    const complete = data.filter((row) => missingFields(cell, row).length === 0);
    const delays =
      cell.scenario === "delayedSmoke"
        ? [0, 50, 250].filter((delay) => !complete.some((row) => row.delayMs === delay))
        : [];
    // The A/A run needs both arms.
    const arms = cell.scenario === "aa" ? ["full", "minimal"] : [null];
    const missingArms = arms.filter(
      (arm) => arm !== null && !complete.some((row) => row.result.arm === arm),
    );
    if (complete.length === 0 || delays.length > 0 || missingArms.length > 0) {
      const reasons = [...new Set(data.flatMap((row) => missingFields(cell, row)))];
      incomplete.push(
        `- ${name}: ${data.length} samples, ${complete.length} complete${delays.length > 0 ? `, no passing run at ${delays.join(", ")} ms` : ""}${missingArms.length > 0 ? `, no complete ${missingArms.join(" or ")} arm` : ""}${reasons.length > 0 ? `; missing: ${reasons.join("; ")}` : ""}`,
      );
      continue;
    }
    const conditions = [
      ...new Set(
        complete.map(
          (row) =>
            `${row.engine} ${row.version}${row.battery ? `, battery ${row.battery.level} % ${row.battery.temperatureC} °C` : ""}; ${row.build} ${row.commit ?? "(commit unknown)"}; ${row.hostPolicy ?? ""}`,
        ),
      ),
    ];
    lines.push(
      `## ${name}`,
      "",
      `${complete.length} complete of ${data.length} samples. ${conditions.join(" | ")}`,
      "",
    );
    if (NOTES[cell.scenario]) lines.push(NOTES[cell.scenario], "");
    lines.push("| Number | Value | Unit |", "| --- | --- | --- |");
    summary[name] = {};
    for (const arm of arms)
      for (const [label, unit, read, applies] of NUMBERS[cell.scenario]) {
        if (!applies(cell)) continue;
        const named = arm === null ? label : `${arm} probe: ${label}`;
        const value = summarize(
          complete
            .filter((row) => arm === null || row.result.arm === arm)
            .map((row) => read(deriveSample(cell, row.result).sample)),
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
