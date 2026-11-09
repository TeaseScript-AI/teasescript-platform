// The report's derivation: every field of a sample derived again from the raw records the row kept, with the same
// functions the scenarios measure with (`lib/measure.mjs`, `scenarios/keep.mjs`, `scenarios/taps.mjs`), never read
// from the row's own summaries (`reviews/l5-gate/field-inventory.md`). A record that is missing, empty where it must
// hold events, or that does not give its field is a problem, and a sample with a problem is incomplete.
import {
  firstSave,
  playable,
  summarize,
  requestsOf,
  turnTimes,
  workerSideOf,
  workerStart,
} from "./lib/measure.mjs";
import { keepOutcome } from "./scenarios/keep.mjs";
import { tapCounts } from "./scenarios/taps.mjs";

const list = Array.isArray;
/** A page's probe records, as `readGate` returns them. */
const probeRecords = (gate) =>
  gate !== null &&
  typeof gate === "object" &&
  ["states", "inputs", "changes", "rows", "rowChanges", "transactions", "workers", "gaps"].every(
    (name) => list(gate[name]),
  );

/** The fields of a session sample, derived from its probe records, its turn records, heap readings and requests. */
function session(result, cell, problems) {
  const need = (holds, what) => {
    if (!holds) problems.push(what);
  };
  const cold = result.probe?.cold;
  const repeat = result.probe?.repeat;
  need(probeRecords(cold) && probeRecords(repeat), "the probe's records of both pages");
  const coldPlayable = probeRecords(cold)
    ? playable(cold, "Start")
    : { ok: false, reason: "no records" };
  const repeatPlayable = probeRecords(repeat)
    ? playable(repeat, "Continue")
    : { ok: false, reason: "no records" };
  need(coldPlayable.ok, `cold playable: ${coldPlayable.reason}`);
  need(repeatPlayable.ok, `repeat playable: ${repeatPlayable.reason}`);
  const save = coldPlayable.ok ? firstSave(cold, coldPlayable.inputMs) : null;
  need(
    save?.ok === true,
    `first save: ${save?.reason ?? save?.outcome ?? "no playable cold page"}`,
  );
  const worker = probeRecords(cold) ? workerStart(cold) : null;
  if (cell.backend === "worker") need(worker?.readyMs != null, "the engine Worker reaching ready");
  const turns = (result.turns ?? []).map((turn) =>
    typeof turn.sentAt !== "number" || turn.before === undefined || !probeRecords(repeat)
      ? { ok: false, reason: turn.reason ?? "no records of the turn" }
      : turnTimes(repeat, turn.sentAt, turn.before, turn.end ?? null),
  );
  need(turns.length > 0, "a turn");
  turns.forEach((turn, index) => need(turn.ok, `turn ${index}: ${turn.reason}`));
  return {
    cold: coldPlayable,
    repeat: repeatPlayable,
    firstSave: save,
    worker,
    turns,
    memory: list(result.memory) ? result.memory : [],
    bytes: result.bytes,
  };
}

/** The instrumented cohort's diagnostics, derived from the raw bridge logs and the injected Worker logs. */
function diagnostics(result, cell, sample, problems) {
  const logs = result.diagnostics?.bridgeLogs;
  if (!(list(logs?.cold) && list(logs?.repeat))) {
    problems.push("the instrumented port's logs of both pages");
    return null;
  }
  const cold = requestsOf(logs.cold);
  const repeat = requestsOf(logs.repeat);
  if (!cold.some((request) => request.op === "start" && request.replyAt !== null))
    problems.push("a start request with its reply in the cold log");
  let workerSide = null;
  if (onCdp(cell) && cell.backend === "worker") {
    const workerLogs = result.diagnostics?.workerLogs;
    const origins = result.diagnostics?.timeOrigins;
    if (
      list(workerLogs?.cold) &&
      list(workerLogs?.repeat) &&
      Number.isFinite(origins?.cold) &&
      Number.isFinite(origins?.repeat)
    )
      workerSide = {
        cold: workerSideOf(workerLogs.cold, cold, origins.cold),
        repeat: workerSideOf(workerLogs.repeat, repeat, origins.repeat),
      };
    else problems.push("the engine Worker's injected logs with both pages' clock origins");
  }
  return {
    cold,
    repeat,
    workerSide,
    turns: sample.turns.map((turn) =>
      turn.ok && turn.settledMs !== null
        ? repeat.filter(
            (request) =>
              request.postAt >= turn.submissionMs &&
              request.postAt <= turn.submissionMs + turn.settledMs,
          )
        : null,
    ),
    gaps: { cold: result.probe?.cold?.gaps, repeat: result.probe?.repeat?.gaps },
  };
}

/** Each scenario's derivation: `(result, cell, problems) => sample`, the sample the report's numbers read. */
const DERIVE = {
  session,
  sessionInstrumented: (result, cell, problems) => {
    const sample = session(result, cell, problems);
    return {
      ...sample,
      bytes: undefined,
      diagnostics: diagnostics(result, cell, sample, problems),
    };
  },
  aa: (result, cell, problems) => {
    const cold = probeRecords(result.probe)
      ? playable(result.probe, "Start")
      : { ok: false, reason: "no records" };
    if (!cold.ok) problems.push(`cold playable: ${cold.reason}`);
    return { arm: result.arm, cold };
  },
  bridge: (result, cell, problems) => {
    if (!list(result.requests)) problems.push("the request records");
    let workerSide = null;
    if (cell.backend === "worker") {
      if (list(result.workerLog) && Number.isFinite(result.timeOrigin))
        workerSide = workerSideOf(result.workerLog, result.requests ?? [], result.timeOrigin);
      else problems.push("the Worker's log with the page's clock origin");
    }
    return {
      requests: result.requests,
      at: result.at,
      inputUnits: result.inputUnits,
      inputBytes: result.inputBytes,
      workerSide,
    };
  },
  taps: (result, cell, problems) => {
    const counts = tapCounts(result);
    if (counts === null) problems.push("the send ledger, the deliveries and the window");
    if (!list(result.cdpErrors)) problems.push("the CDP error records");
    else if (result.cdpErrors.length > 0)
      problems.push(`${result.cdpErrors.length} CDP send errors`);
    if (counts !== null && counts.outside > 0)
      problems.push(`${counts.outside} taps off their grid point`);
    return { ...counts, clock: result.clock };
  },
  // Pass or fail is these scenarios' measurement (`PASS_FAIL`): their records must be intact, their failure is a value.
  demo: (result, cell, problems) => {
    if (!list(result.errors) || typeof result.turns !== "number")
      problems.push("the demo's error and turn records");
    return { passed: result.ok === true ? 1 : 0, errors: result.errors, turns: result.turns };
  },
  delayedSmoke: (result, cell, problems) => {
    if (typeof result.exit !== "number") problems.push("the smoke's exit status");
    return { passed: result.ok === true ? 1 : 0 };
  },
};
DERIVE.bridgeTaps = DERIVE.taps;
for (const trial of ["keepHandler", "keepCompletion", "keepDurable"])
  DERIVE[trial] = (result, cell, problems) => {
    const derived = keepOutcome(trial, result);
    if (derived === null) problems.push("the trial's records");
    else if (derived.outcome !== result.outcome)
      problems.push(
        `the recorded outcome '${result.outcome}' is not its records' '${derived.outcome}'`,
      );
    return { outcome: derived?.outcome, hiddenToCommitMs: derived?.hiddenToCommitMs ?? null };
  };

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
  // The byte page is loaded once more, cold, when CDP leaves a request open (`drive.mjs`): the attempts discarded.
  [
    "byte pages discarded (a request left open)",
    "",
    (r) => (Array.isArray(r.bytes?.discarded) ? r.bytes.discarded.length : null),
    onCdp,
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
  demo: [
    ["passed", "", (r) => r.passed, always, true],
    ["errors", "", (r) => r.errors?.length, always, true],
    ["turns", "", (r) => r.turns, always, true],
  ],
  delayedSmoke: [["passed", "", (r) => r.passed, always, true]],
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

/** The scenarios whose result is pass or fail: a measured failure is their cell's value, never an incomplete cell. */
export const PASS_FAIL = new Set(["demo", "delayedSmoke"]);

/**
 * The scenarios whose cells the invariant does not cover (orchestrator 2's bound after Sol code r5): their intervals
 * or lifecycle outcomes are derived without the endpoint or evidence validation the invariant requires. Their cells are
 * `unvalidated`: reported apart, out of the headline and the R0 comparison, and listed as declared gaps.
 */
export const UNVALIDATED = {
  bridge:
    "R5-01: request round trips, the Worker's start, handling and delivery subtract unvalidated endpoints",
  sessionInstrumented:
    "R5-01: the diagnostic round trips and Worker side subtract unvalidated endpoints",
  taps: "R5-01: tap delay and cadence subtract unvalidated endpoints",
  bridgeTaps: "R5-01: tap delay and cadence subtract unvalidated endpoints",
  keepHandler: "R5-02: an empty lifecycle yields an outcome instead of no evidence",
  keepCompletion: "R5-02: an empty lifecycle yields an outcome instead of no evidence",
};

/**
 * The kit's one completeness invariant (`docs/TESTING.md` "The L5 activation gate kit"): every required field of a cell
 * derives from records that passed this shared validation, each required interval present and in order, the lifecycle
 * evidence there where a trial needs it, a counted turn's feedback present; a sample that fails it makes its cell
 * incomplete and is never a value in a median. It holds for every scenario but those in `UNVALIDATED`. Returns `row`'s
 * values for `cell`, each applicable field with its label and unit, and the problems that failed the validation.
 */
export function deriveSample(cell, row) {
  const problems = [];
  const sample = DERIVE[cell.scenario](row.result ?? {}, cell, problems);
  // A keep trial's outcome is its measurement, whichever it is; any other failed sample fails.
  // A keep trial's outcome and a pass/fail scenario's result are their measurement; any other failed sample fails.
  if (!cell.scenario.startsWith("keep") && !PASS_FAIL.has(cell.scenario) && !row.ok)
    problems.unshift("the sample failed");
  const values = [];
  for (const [label, unit, read, applies, required] of NUMBERS[cell.scenario]) {
    if (!applies(cell)) continue;
    const value = read(sample);
    if (required && !finite(value)) problems.push(unit === "" ? label : `${label} (${unit})`);
    values.push({ label, unit, value: finite(value) ? value : null });
  }
  return { values, problems };
}
