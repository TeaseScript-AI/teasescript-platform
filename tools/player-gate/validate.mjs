// The report's validation: every field of a sample derived again from the records the row kept, with the same functions
// the scenarios measure with (`lib/measure.mjs`, `scenarios/keep.mjs`, `scenarios/taps.mjs`), never read from the
// row's own summaries (`reviews/l5-gate/field-inventory.md`). The records are the validated copy `records.mjs` parsed
// (#2122), read through the strict reader; each scenario's parts check the order relations and the evidence a trial
// needs before they derive; and every field's value is checked against its unit's domain. A part that fails fails the
// cells whose fields read it, and no other.
import {
  firstSave,
  playable,
  summarize,
  requestsOf,
  turnTimes,
  workerSideOf,
  workerStart,
} from "./lib/measure.mjs";
import {
  ContradictoryEvidence,
  isEvidenceError,
  MissingEvidence,
  nullable,
  span,
  strictRecord,
} from "./lib/evidence.mjs";
import { sectionsOf } from "./lib/records.mjs";
import { keepOutcome } from "./scenarios/keep.mjs";
import { tapCounts } from "./scenarios/taps.mjs";

/**
 * The kept-session transactions the probe recorded (`probe.mjs`), each open (no end, no outcome) or ended with both,
 * its start before its end: the probe sets the two together, so one without the other is no evidence (Sol code r1,
 * #2253).
 */
function transactionsComplete(transactions, where) {
  transactions.forEach((transaction, index) => {
    const end = nullable(transaction, "end");
    const outcome = nullable(transaction, "outcome");
    if ((end === null) !== (outcome === null))
      throw new MissingEvidence(
        `${where} transaction ${index}: its ${end === null ? "end" : "outcome"}, beside its ${end === null ? "outcome" : "end"}`,
      );
    if (end !== null)
      span(transaction.start, end, `${where} transaction ${index}: its start → its end`);
  });
}

/**
 * One page's probe records as evidence: none dropped past the probe's limit (its lists would be cut short), and its
 * transactions complete.
 */
function gateComplete(gate, page) {
  if (gate.dropped !== 0)
    throw new MissingEvidence(`${page} page: ${gate.dropped} probe records dropped`);
  transactionsComplete(gate.transactions, `${page} page's`);
}

/** A session's timings, from its probe records and its turn records. */
function sessionTiming(result, cell, problems) {
  const cold = result.probe.cold;
  const repeat = result.probe.repeat;
  gateComplete(cold, "the cold");
  gateComplete(repeat, "the repeat");
  const coldPlayable = playable(cold, "Start");
  const repeatPlayable = playable(repeat, "Continue");
  if (!coldPlayable.ok) problems.push(`cold playable: ${coldPlayable.reason}`);
  if (!repeatPlayable.ok) problems.push(`repeat playable: ${repeatPlayable.reason}`);
  const save = coldPlayable.ok ? firstSave(cold, coldPlayable.inputMs) : null;
  if (save?.ok !== true) problems.push(`first save: ${save?.reason ?? "no playable cold page"}`);
  const worker = workerStart(cold);
  if (cell.backend === "worker" && (worker === null || worker.readyMs === null))
    problems.push("the engine Worker reaching ready");
  const turns = result.turns.map((turn) =>
    nullable(turn, "sentAt") === null
      ? { ok: false, reason: nullable(turn, "reason") ?? "no records of the turn" }
      : turnTimes(repeat, turn.sentAt, turn.before, nullable(turn, "end")),
  );
  if (turns.length === 0) problems.push("a turn");
  turns.forEach((turn, index) => {
    if (!turn.ok) problems.push(`turn ${index}: ${turn.reason}`);
  });
  return { cold: coldPlayable, repeat: repeatPlayable, firstSave: save, worker, turns };
}

/** Each byte phase and the cold page's mark that ends it (`scenarios/session.mjs` `coldBytes`). */
const PHASE_MARKS = { beforeStartEnabled: "startEnabled", beforePlayable: "playable" };

/**
 * A session's heap readings and, the headline session's on a CDP engine only, its byte account: the byte page's
 * Start enabled must not follow its playable mark.
 */
function sessionBytes(result, cell) {
  const bytes = cell.scenario === "session" && onCdp(cell) ? result.bytes : null;
  if (bytes !== null)
    span(
      bytes.marks.startEnabled,
      bytes.marks.playable,
      "the byte page's Start enabled → playable",
    );
  return { memory: result.memory, bytes };
}

/**
 * Each byte request's cached phase flags against its start and the phase's mark: a flag that disagrees is
 * contradictory evidence (Sol code r8, R8-01).
 */
function phaseFlagsAgree(sample, cached) {
  if (sample.bytes === null) return;
  sample.bytes.requests.forEach((request, index) => {
    for (const phase of Object.keys(PHASE_MARKS)) {
      const flag = cached.bytes.requests[index][phase];
      const member = inPhase(sample.bytes, request, phase);
      if (flag !== member)
        throw new ContradictoryEvidence(
          `${request.url}: its cached ${phase} (${flag}) is not its start against the mark (${member})`,
        );
    }
  });
}

/** The instrumented cohort's diagnostics, derived from the raw bridge logs and the injected Worker logs. */
function diagnostics(result, cell, problems, { timing }) {
  const logs = result.diagnostics.bridgeLogs;
  const cold = requestsOf(logs.cold);
  const repeat = requestsOf(logs.repeat);
  if (!cold.some((request) => request.op === "start" && request.replyAt !== null))
    problems.push("a start request with its reply in the cold log");
  const workerSide =
    onCdp(cell) && cell.backend === "worker"
      ? {
          cold: workerSideOf(
            result.diagnostics.workerLogs.cold,
            cold,
            result.diagnostics.timeOrigins.cold,
          ),
          repeat: workerSideOf(
            result.diagnostics.workerLogs.repeat,
            repeat,
            result.diagnostics.timeOrigins.repeat,
          ),
        }
      : null;
  return {
    diagnostics: {
      cold,
      repeat,
      workerSide,
      turns: timing.turns.map((turn) =>
        turn.ok && turn.settledMs !== null
          ? repeat.filter(
              (request) =>
                request.postAt >= turn.submissionMs &&
                request.postAt <= turn.submissionMs + turn.settledMs,
            )
          : null,
      ),
      gaps: { cold: result.probe.cold.gaps, repeat: result.probe.repeat.gaps },
    },
  };
}

/** The bridge page's request order: each reply after its request, the Worker's ready after its construction. */
function bridgeTiming(result, cell) {
  if (cell.backend === "worker")
    span(result.at.workerConstructed, result.at.workerReady, "the bridge page's Worker start");
  for (const request of result.requests) {
    const reply = nullable(request, "replyAt");
    if (reply !== null) span(request.postAt, reply, `${request.op}'s round trip`);
  }
  return {
    requests: result.requests,
    at: result.at,
    workerSide:
      cell.backend === "worker"
        ? workerSideOf(result.workerLog, result.requests, result.timeOrigin)
        : null,
  };
}

/**
 * A taps sample: its window in order, each delivery's handling after its event, its sends in order (the delay and the
 * cadence subtract them in `tapCounts`); then its counts, with no CDP error and no tap off its grid point.
 */
function tapsTiming(result, cell, problems) {
  span(result.window.fromMs, result.window.toMs, "the taps window");
  for (const tap of result.deliveries)
    span(tap.ts, tap.t, `tap ${tap.id}: its event → its handler`);
  result.ledger.forEach((send, index) => {
    if (index > 0)
      span(result.ledger[index - 1].sentMs, send.sentMs, `the sends ${index - 1} → ${index}`);
  });
  const counts = tapCounts(result);
  if (counts === null) {
    problems.push("the send ledger, the deliveries and the window");
    return {};
  }
  if (result.cdpErrors.length > 0) problems.push(`${result.cdpErrors.length} CDP send errors`);
  if (counts.outside > 0) problems.push(`${counts.outside} taps off their grid point`);
  return { ...counts, clock: result.clock };
}

/**
 * A keep trial: a hiding (handler and completion trials) and its transactions complete, then the outcome from those
 * records. A page that never reported hidden gave no evidence (Sol code r5, R5-02).
 */
function keepTiming(trial) {
  return (result) => {
    if (trial !== "keepDurable") {
      if (
        !result.lifecycle.some(
          (event) => event.type === "visibilitychange" && event.visibility === "hidden",
        )
      )
        throw new MissingEvidence("row.result.lifecycle: a visibilitychange to hidden");
      transactionsComplete(result.transactions, "the trial's");
    }
    const derived = keepOutcome(trial, result);
    return { outcome: derived.outcome, hiddenToCommitMs: derived.hiddenToCommitMs ?? null };
  };
}

/** A cached value's disagreement with the derived one, as a problem. */
const agrees = (what, recorded, derived, problems) => {
  if (recorded !== derived)
    problems.push(`the recorded ${what} (${recorded}) is not its records' (${derived})`);
};

/** The demo's pass, from its records: at least four turns and fewer than its cap, no error, no failure. */
const demoPassed = (result) =>
  result.errors.length === 0 && result.turns >= 4 && result.turns < 80 && result.failed === false;

/**
 * Each scenario's parts: `name → { sections, after, derive(result, cell, problems, parts), check(sample, cached,
 * problems) }`. `derive` reads only the merged copy of its `sections`, strictly, and the samples of the parts in
 * `after`; `check` compares the cached values of those sections with what was derived. A field names its part
 * (`NUMBERS`); a scenario without parts fails.
 */
const SESSION_PARTS = {
  timing: { sections: ["timing"], derive: sessionTiming },
  bytes: { sections: ["bytes"], derive: sessionBytes, check: phaseFlagsAgree },
};
const KEEP = (trial) => ({
  timing: {
    sections: ["timing"],
    derive: keepTiming(trial),
    check: (sample, cached, problems) =>
      agrees("outcome", cached.outcome, sample.outcome, problems),
  },
});
const PASS_FAIL_PART = (passed, what) => ({
  timing: {
    sections: ["timing"],
    derive: (result) => ({ passed: passed(result) ? 1 : 0, result }),
    check: (sample, cached, problems) => agrees(what, cached.ok, sample.passed === 1, problems),
  },
});
const PARTS = {
  session: SESSION_PARTS,
  sessionInstrumented: {
    ...SESSION_PARTS,
    diagnostics: { sections: ["diagnostics", "timing"], after: ["timing"], derive: diagnostics },
  },
  aa: {
    timing: {
      sections: ["timing"],
      derive: (result, cell, problems) => {
        gateComplete(result.probe, "the");
        const cold = playable(result.probe, "Start");
        if (!cold.ok) problems.push(`cold playable: ${cold.reason}`);
        return { cold };
      },
    },
  },
  bridge: {
    timing: { sections: ["timing"], derive: bridgeTiming },
    input: {
      sections: ["input"],
      derive: (result) => ({ inputUnits: result.inputUnits, inputBytes: result.inputBytes }),
    },
  },
  taps: { timing: { sections: ["timing"], derive: tapsTiming } },
  bridgeTaps: { timing: { sections: ["timing"], derive: tapsTiming } },
  keepHandler: KEEP("keepHandler"),
  keepCompletion: KEEP("keepCompletion"),
  keepDurable: KEEP("keepDurable"),
  // Pass or fail is these scenarios' measurement (`PASS_FAIL`), from their primary records.
  demo: {
    timing: {
      ...PASS_FAIL_PART(demoPassed, "ok").timing,
      derive: (result) => ({
        passed: demoPassed(result) ? 1 : 0,
        errors: result.errors,
        turns: result.turns,
      }),
    },
  },
  delayedSmoke: PASS_FAIL_PART((result) => result.exit === 0, "ok"),
};

/** The scenarios whose samples must complete: a row that failed fails each of its parts. */
const MUST_COMPLETE = new Set([
  "session",
  "sessionInstrumented",
  "aa",
  "bridge",
  "taps",
  "bridgeTaps",
]);

const CDP_ENGINES = new Set(["chromium", "pixel"]);
const LONG_TASK_ENGINES = CDP_ENGINES;
const isWorker = (cell) => cell.backend === "worker";
const onCdp = (cell) => CDP_ENGINES.has(cell.engine);

/**
 * The numbers each scenario reports: `[label, unit, value of one sample, applies(cell), required, part, aggregate]`, the
 * unit one of `UNITS`, `part` the scenario's part whose sample the value reads (`timing` when left out, `PARTS`),
 * `aggregate` a count that is a median of counts. A field that does not apply to a cell is left out of it, never
 * printed as a dash; a required one that applies must hold a value in its unit's domain for its sample to count
 * (`reviews/l5-gate/field-inventory.md`).
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
        "bytes",
      ]),
    ),
  ),
  [
    "requests of the engine Worker's target",
    "count",
    (r) =>
      (r.bytes?.requests ?? []).filter((q) => q.target !== "page" && /engine/u.test(q.target))
        .length || null,
    (cell) => onCdp(cell) && isWorker(cell),
    true,
    "bytes",
  ],
  // The byte page is loaded once more, cold, when CDP leaves a request open (`drive.mjs`): the attempts discarded.
  [
    "byte pages discarded (a request left open)",
    "count",
    (r) => (r.bytes === null ? null : r.bytes.discarded.length),
    onCdp,
    true,
    "bytes",
  ],
];
/** A hidden-page keep trial's numbers (`keepHandler`, `keepCompletion`). */
const KEEP_FIELDS = [
  [
    "completed while hidden",
    "boolean",
    (r) => (r.outcome === "completed" || r.outcome === "durable after 1 s" ? 1 : 0),
    always,
    true,
  ],
  [
    "completed after resume",
    "boolean",
    (r) => (r.outcome === "completed after resume" ? 1 : 0),
    always,
    false,
  ],
  ["hidden → commit", "ms", (r) => r.hiddenToCommitMs, always, false],
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
    [
      "first save: plan JSON, UTF-16 units",
      "count",
      (r) => r.firstSave?.planJsonLength,
      always,
      true,
    ],
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
      "count",
      (r) => (r.turns ?? []).filter((t) => t.ok !== false).length,
      always,
      true,
    ],
    [
      "turns ended or cut, not settled",
      "count",
      (r) => (r.turns ?? []).filter((t) => t.end).length,
      always,
      false,
    ],
    ...MILESTONES.flatMap(([at, page, label]) => [
      [
        `heap, page (${page}), at ${label}`,
        "bytes",
        (r) => heapAt(r, at, "page"),
        onCdp,
        true,
        "bytes",
      ],
      [
        `heap, engine Worker, at ${label}`,
        "bytes",
        (r) => heapAt(r, at, "engine"),
        (cell) => onCdp(cell) && isWorker(cell),
        true,
        "bytes",
      ],
    ]),
    ...BYTES,
  ],
  taps: [
    ["taps sent in the window", "count", (r) => r.sent, always, true],
    ["taps answered", "count", (r) => r.answered, always, true],
    ["taps unanswered", "count", (r) => r.unanswered, always, true],
    ["delay, median", "ms", (r) => r.delay?.median, always, false],
    ["delay, max", "ms", (r) => r.delay?.max, always, false],
    ["answered within 16 ms", "count", (r) => r.within16, always, true],
    ["send cadence, median", "ms", (r) => r.cadence?.median, always, true],
    ["clock offset uncertainty", "ms", (r) => r.clock?.uncertaintyMs, always, true],
  ],
  bridge: [
    [
      "Worker: construction → ready",
      "ms",
      (r) => between(r, "workerConstructed", "workerReady"),
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
      "ms, cross-clock",
      (r) => workerSide(r, "prepare", "deliveryMs"),
      isWorker,
      true,
    ],
    ["input, UTF-16 units", "count", (r) => r.inputUnits, always, true, "input"],
    ["input, UTF-8", "bytes", (r) => r.inputBytes, always, true, "input"],
    ["start: request → reply", "ms", (r) => rtt(r, "start"), always, true],
    ["preparePlanText: request → reply", "ms", (r) => rtt(r, "preparePlanText"), always, true],
    ["captureKeep: request → reply", "ms", (r) => rtt(r, "captureKeep"), always, true],
    ["continue: request → reply", "ms", (r) => rtt(r, "continue"), always, true],
  ],
  demo: [
    ["passed", "boolean", (r) => r.passed, always, true],
    ["errors", "count", (r) => r.errors?.length, always, true],
    ["turns", "count", (r) => r.turns, always, true],
  ],
  delayedSmoke: [["passed", "boolean", (r) => r.passed, always, true]],
};
NUMBERS.sessionInstrumented = [
  ...NUMBERS.session.filter((field) => !BYTES.includes(field)),
  [
    "diagnostic: prepare request → reply",
    "ms",
    (r) => diagnosticRtt(r, "cold", "prepare"),
    always,
    true,
    "diagnostics",
  ],
  [
    "diagnostic: start request → reply",
    "ms",
    (r) => diagnosticRtt(r, "cold", "start"),
    always,
    true,
    "diagnostics",
  ],
  [
    "diagnostic: continue request → reply",
    "ms",
    (r) => diagnosticRtt(r, "repeat", "continue"),
    always,
    true,
    "diagnostics",
  ],
  [
    "diagnostic: captureKeep request → reply",
    "ms",
    (r) => diagnosticRtt(r, "cold", "captureKeep"),
    always,
    false,
    "diagnostics",
  ],
  [
    "diagnostic: captureKeep reply, UTF-16 units",
    "count",
    (r) => diagnosticRequest(r, "cold", "captureKeep")?.replySize,
    always,
    false,
    "diagnostics",
  ],
  [
    "diagnostic: requests per settled turn (median)",
    "count",
    (r) => summarize((r.diagnostics?.turns ?? []).filter(Boolean).map((t) => t.length)).median,
    always,
    false,
    "diagnostics",
    true,
  ],
  [
    "diagnostic: prepare Worker handling",
    "ms",
    (r) => r.diagnostics?.workerSide?.cold?.find((w) => w.op === "prepare")?.handlingMs,
    (cell) => onCdp(cell) && isWorker(cell),
    true,
    "diagnostics",
  ],
  [
    "diagnostic: start delivery latency",
    "ms, cross-clock",
    (r) => r.diagnostics?.workerSide?.cold?.find((w) => w.op === "start")?.deliveryMs,
    (cell) => onCdp(cell) && isWorker(cell),
    true,
    "diagnostics",
  ],
  [
    "diagnostic: scheduling gaps over 50 ms",
    "count",
    (r) =>
      (r.diagnostics?.gaps?.cold?.length ?? NaN) + (r.diagnostics?.gaps?.repeat?.length ?? NaN),
    always,
    true,
    "diagnostics",
  ],
];
// The A/A run compares the cold interval only: the full probe's incremental cost beyond the shared observer.
NUMBERS.aa = PLAYABLE("cold", "Start");
NUMBERS.bridgeTaps = NUMBERS.taps;
NUMBERS.keepHandler = KEEP_FIELDS;
NUMBERS.keepCompletion = KEEP_FIELDS;
NUMBERS.keepDurable = [
  [
    "survived force-stop at 1 s",
    "boolean",
    (r) => (r.outcome === "durable after 1 s" ? 1 : 0),
    always,
    true,
  ],
];

/** Whether `request` belongs to `phase`, from its validated start and the phase's validated mark (epoch ms). */
const inPhase = (bytes, request, phase) => request.wallTimeMs <= bytes.marks[PHASE_MARKS[phase]];

/**
 * The served bytes (`encoded` or `decoded`) of `target` (`page` or `Workers`), all or those in `phase`: a missing
 * length throws; 0 for a target that requested nothing (no Worker).
 */
function bytesOf(sample, target, phase, size) {
  if (sample.bytes === null || sample.bytes === undefined) return null;
  const bytes = sample.bytes;
  const requests = bytes.requests.filter(
    (request) =>
      (target === "page" ? request.target === "page" : request.target !== "page") &&
      (phase === null || inPhase(bytes, request, phase)),
  );
  if (target === "page" && requests.length === 0) return null;
  const field = size === "encoded" ? "encodedBytes" : "decodedBytes";
  // A failed request served nothing; any other must have finished with its length (a missing one throws).
  return requests.reduce(
    (sum, request) =>
      nullable(request, "failed") !== null ? sum : sum + (request.finished ? request[field] : NaN),
    0,
  );
}
function heapAt(sample, at, target) {
  const reading = sample.memory.find((entry) => entry.at === at);
  if (reading === undefined) return null;
  if (target === "page") return reading.page.usedBytes;
  const engine = reading.workers.find(
    (worker) => worker.engine && nullable(worker, "usedBytes") !== null,
  );
  return engine === undefined ? null : engine.usedBytes;
}
/** The bridge page's interval between two of its marks, both required. */
const between = (sample, from, to) =>
  span(sample.at[from], sample.at[to], `the bridge page's ${from} → ${to}`);
const request = (sample, op) => sample.requests.find((entry) => nullable(entry, "op") === op);
const rtt = (sample, op) => {
  const found = request(sample, op);
  if (found === undefined) return null;
  const reply = nullable(found, "replyAt");
  return reply === null ? null : span(found.postAt, reply, `${op}'s round trip`);
};
const workerSide = (sample, op, field) =>
  sample.workerSide?.find((entry) => entry.op === op)?.[field];
const diagnosticRequest = (sample, page, op) =>
  sample.diagnostics?.[page]?.find((entry) => entry.op === op);
const diagnosticRtt = (sample, page, op) => diagnosticRequest(sample, page, op)?.rttMs;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Every unit: the cell its fields belong to and the domain of their values (orchestrator 2's partition after Sol code
 * r10 and r11, and #2122). The headline, the summary and the R0 comparison are the `timing` cells: `ms` and
 * `boolean`. `bytes` and `count` fields are `<cell> / bytes and counts`; the signed differences between the page's
 * clock and the Worker's are `<cell> / cross-clock`. Each is its own failure boundary. A count that is a median of
 * counts is a finite number ≥ 0, not an integer.
 */
const UNITS = new Map([
  [
    "ms",
    { cell: "timing", domain: (v) => finite(v) && v >= 0, what: "no finite number of ms ≥ 0" },
  ],
  ["boolean", { cell: "timing", domain: (v) => v === 0 || v === 1, what: "neither 0 nor 1" }],
  ["bytes", { cell: "counts", domain: safeCount, what: "no safe integer ≥ 0" }],
  ["count", { cell: "counts", domain: safeCount, what: "no safe integer ≥ 0" }],
  ["ms, cross-clock", { cell: "crossClock", domain: finite, what: "no finite number of ms" }],
]);
const AGGREGATE = { domain: (v) => finite(v) && v >= 0, what: "no finite number ≥ 0" };
for (const scenario in NUMBERS)
  for (const [label, unit, , , , part = "timing"] of NUMBERS[scenario]) {
    if (!UNITS.has(unit)) throw new Error(`${scenario} "${label}": no unit of UNITS`);
    if (!Object.hasOwn(PARTS[scenario] ?? {}, part))
      throw new Error(`${scenario} "${label}": no part '${part}'`);
  }
/** The cell a field belongs to: `timing`, `counts` or `crossClock`. */
export const cellOf = ([, unit]) => UNITS.get(unit).cell;
/** Whether `field` is in the headline: its unit is `ms` or `boolean`. */
export const isHeadline = (field) => cellOf(field) === "timing";
export { NUMBERS };

/** The scenarios whose result is pass or fail: a measured failure is their cell's value, never an incomplete cell. */
export const PASS_FAIL = new Set(["demo", "delayedSmoke"]);

/**
 * Each part of `cell`'s scenario run over the parsed row `handle`: `name → { sample, problems }`, `sample` `null` when
 * its inputs failed or its derivation threw. A part with problems fails the cells that read it either way.
 */
function runParts(cell, handle) {
  const sections = sectionsOf(handle);
  const parts = PARTS[cell.scenario];
  if (parts === undefined) throw new Error(`no parts for the scenario '${cell.scenario}'`);
  // A keep trial's outcome and a pass/fail scenario's result are their measurement; any other failed sample fails.
  const failed =
    MUST_COMPLETE.has(cell.scenario) && handle.header.cached.ok !== true
      ? ["the sample failed"]
      : [];
  const done = {};
  for (const [name, part] of Object.entries(parts)) {
    const inputs = [
      ...part.sections.flatMap((section) => sections.get(section).problems),
      ...(part.after ?? []).flatMap((before) => done[before].problems),
    ];
    const problems = [...failed, ...inputs];
    let sample = null;
    if (inputs.length === 0)
      try {
        // The one place a row's copies are wrapped: the part reads them strictly, its cached values never.
        const copy = Object.assign(
          {},
          ...part.sections.map((section) => sections.get(section).value),
        );
        const cached = Object.assign(
          {},
          ...part.sections.map((section) => sections.get(section).cached),
        );
        const before = Object.fromEntries(
          Object.entries(done).map(([key, { sample }]) => [key, sample]),
        );
        sample = part.derive(strictRecord(copy, "row.result"), cell, problems, before);
        part.check?.(sample, cached, problems);
      } catch (error) {
        if (!isEvidenceError(error)) throw error;
        problems.push(error.message);
      }
    done[name] = { sample, problems };
  }
  return done;
}

/**
 * The kit's one completeness invariant (`docs/TESTING.md` "The L5 activation gate kit", #2122): every value a cell
 * reports derives from records that passed this shared validation (their shape, each required interval present and in
 * order, the evidence a trial needs, a counted turn's feedback, cached flags only compared); a sample that fails makes
 * its cell incomplete and is never a value in a median. Returns, for the parsed row `handle` and `cell`, each of its
 * cells (`timing`, `counts`, `crossClock`; `null` where no field applies): its applicable fields' values with their
 * labels and units, and the problems that failed it.
 */
export function validateSample(cell, handle) {
  const done = runParts(cell, handle);
  const cells = { timing: null, counts: null, crossClock: null };
  for (const field of NUMBERS[cell.scenario]) {
    const [label, unit, read, applies, required, part = "timing", aggregate = false] = field;
    if (!applies(cell)) continue;
    const out = (cells[cellOf(field)] ??= { values: [], problems: [] });
    const { sample, problems } = done[part];
    let value = null;
    out.problems.push(...problems);
    if (sample !== null)
      try {
        const found = read(sample);
        const { domain, what } = aggregate ? AGGREGATE : UNITS.get(unit);
        if (found === null || found === undefined) {
          if (required) out.problems.push(`${label} (${unit})`);
        } else if (!domain(found)) out.problems.push(`${label}: ${found} is ${what}`);
        else value = found;
      } catch (error) {
        if (!isEvidenceError(error)) throw error;
        out.problems.push(error.message);
      }
    out.values.push({ label, unit, value });
  }
  for (const out of Object.values(cells))
    if (out !== null) {
      out.problems = Object.freeze([...new Set(out.problems)]);
      out.values.forEach(Object.freeze);
      Object.freeze(out.values);
      Object.freeze(out);
    }
  VALIDATED.add(Object.freeze(cells));
  return cells;
}

/** The results `validateSample` made, frozen: the report aggregates no other. */
const VALIDATED = new WeakSet();
export const isValidated = (cells) => VALIDATED.has(cells);
