// The kit's test fixtures (#2122), shared by the kit's tests: one row per scenario and variant, which hold every declared
// leaf between them.
import { parseRow } from "./lib/records.mjs";
import { validateSample } from "./validate.mjs";

export const clone = (value) => structuredClone(value);
export const axes = (row) => ({
  scenario: row.scenario,
  script: row.script,
  route: row.route,
  backend: row.backend,
  engine: row.engine,
});

/** A row of `scenario` on `engine` and `backend`, with every header field `drive.mjs` writes. */
const header = (
  scenario,
  { engine = "chromium", backend = "main", script = "CelebWorship", route = "source" } = {},
) => ({
  scenario,
  script,
  route,
  backend,
  engine,
  sample: 0,
  build: "dist/player-app",
  commit: "0123abc",
  version: "1",
  battery: engine === "pixel" ? { acPowered: false, level: 80, temperatureC: 31.5 } : null,
  hostPolicy: "gate host",
  ok: true,
});

/**
 * One page's probe records: Start (or Continue) enabled at 500 ms and pressed at 555 ms, the first control (serial 2)
 * at 716 ms, a turn's input at 899 ms followed by a change and a control of another action (serial 3) at 960 ms; the
 * cold page's first save; the engine Worker on a worker build, a photo Worker otherwise.
 */
function gate(label, { worker = false, cdp = true } = {}) {
  const state = (t, frame, extra) => ({
    t,
    frame,
    start: null,
    control: null,
    buttons: [],
    composer: null,
    ended: false,
    failed: false,
    ...extra,
  });
  return {
    config: { minimal: false, diagnostic: false, ignoredError: "ResizeObserver" },
    states: [
      state(500, 510, { start: { label, enabled: true } }),
      state(700, 716, { control: 2, buttons: [{ label: "Go", enabled: true, image: "go.png" }] }),
      state(950, 960, {
        control: 3,
        buttons: [{ label: "Next", enabled: true, image: null }],
        composer: { enabled: true, asks: true, hint: "Type", inputMode: "text" },
      }),
    ],
    inputs: [
      { type: "pointerdown", t: 560, ts: 555, trusted: true },
      { type: "pointerdown", t: 900, ts: 899, trusted: true },
    ],
    changes: [{ t: 920, frame: 930 }],
    rows: [{ id: "m1", speaker: "system", t: 600, frame: 605, shownFrame: 610 }],
    rowChanges: [{ id: "m1", t: 970, frame: 975 }],
    transactions: [
      {
        stores: ["sessions", "plans"],
        start: 600,
        end: 630,
        outcome: "complete",
        puts: [
          { store: "sessions", scope: "s", observedMs: 1, length: 5 },
          { store: "plans", scope: "s", observedMs: null, length: 10 },
        ],
      },
    ],
    workers: worker
      ? [{ url: "engine.worker.js", engine: true, constructed: 100, ready: 150 }]
      : [{ url: "photo.worker.js", engine: false, constructed: 100, ready: null }],
    longTasks: cdp ? [{ start: 590, duration: 55 }] : null,
    ...(cdp
      ? {}
      : { longTasksUnavailable: "this browser does not report the longtask entry type" }),
    gaps: [{ kind: "frame", at: 300, gapMs: 70 }],
    lifecycle: [{ type: "visibilitychange", t: 40, visibility: "visible" }],
    taps: [{ id: 1, t: 21, ts: 20, x: 3, y: 4 }],
    errors: [{ t: 30, text: "a console error" }],
    dropped: 0,
  };
}

/** A headline session's result on `engine` and `backend`, its byte account on a CDP engine. */
function sessionResult({ engine = "chromium", backend = "main" } = {}) {
  const cdp = engine === "chromium" || engine === "pixel";
  const worker = backend === "worker";
  const cold = gate("Start", { worker, cdp });
  const repeat = gate("Continue", { worker, cdp });
  const heap = (at) => ({
    at,
    gc: at === "end",
    page: { usedBytes: 1000, totalBytes: 2000 },
    workers: [
      {
        url: worker ? "engine.worker.js" : "photo.worker.js",
        engine: worker,
        usedBytes: 300,
        totalBytes: 600,
      },
    ],
  });
  const request = (url, target, wallTimeMs, flags, extra = {}) => ({
    target,
    url,
    wallTimeMs,
    status: 200,
    encodedBytes: 7,
    decodedBytes: 14,
    finished: true,
    failed: null,
    fromCache: false,
    beforeStartEnabled: flags[0],
    beforePlayable: flags[1],
    ...extra,
  });
  return {
    ok: true,
    probe: { cold, repeat },
    turns: [
      {
        turn: 0,
        kind: "button",
        of: 2,
        sentAt: 880,
        before: repeat.states[1],
        end: null,
        ok: true,
        feedbackMs: 31,
      },
    ],
    memory: cdp ? ["startEnabled", "playable", "firstSave", "afterTurns", "end"].map(heap) : [],
    ...(cdp
      ? {
          bytes: {
            ok: true,
            // The cold byte page's marks and its requests' starts, epoch ms (`scenarios/session.mjs` `coldBytes`).
            marks: { startEnabled: 10_500, playable: 10_716, firstSave: 10_630 },
            requests: [
              request("/player/", "page", 10_000, [true, true]),
              request("/missing.png", "page", 10_100, [true, true], {
                status: null,
                encodedBytes: null,
                decodedBytes: 0,
                finished: false,
                failed: "net::ERR_FAILED",
              }),
              ...(worker
                ? [request("engine.worker.js", "engine.worker.js", 10_600, [false, true])]
                : []),
            ],
            workers: [{ url: "engine.worker.js", errors: ["resume: target closed"] }],
            discarded: [{ open: ["engine.worker.js"], requests: [] }],
          },
        }
      : {}),
    errors: [],
    cold: { ok: true },
    metrics: null,
  };
}

/** The instrumented cohort's result on a worker build: its bridge logs, the engine Worker's logs, the page origins. */
function instrumentedResult() {
  const result = sessionResult({ backend: "worker" });
  delete result.bytes;
  const log = [
    // The Worker's ready: a reply outside a request, the one message without an ID.
    { dir: "reply", at: 515, id: null, op: null, kind: "ready", ok: null },
    { dir: "post", at: 520, postMs: 1, id: 1, op: "prepare", session: null, atMs: null },
    { dir: "reply", at: 530, id: 1, op: "prepare", kind: "reply", ok: true },
    { dir: "post", at: 540, postMs: 1, id: 2, op: "start", session: "s", atMs: 0 },
    { dir: "reply", at: 545, id: 2, op: "start", kind: "reply", ok: true },
    { dir: "post", at: 550, postMs: 1, id: 3, op: "captureKeep", session: "s", atMs: 12 },
    { dir: "reply", at: 556, id: 3, op: "captureKeep", kind: "reply", ok: true, size: 900 },
    { dir: "post", at: 905, postMs: 1, id: 4, op: "continue", session: "s", atMs: 20 },
    { dir: "reply", at: 912, id: 4, op: "continue", kind: "reply", ok: true },
  ];
  const workerLog = [
    { dir: "reply", at: 10_150, id: null, kind: "ready" },
    { dir: "request", at: 10_521, id: 1, op: "prepare" },
    { dir: "reply", at: 10_529, id: 1, kind: "reply" },
    { dir: "request", at: 10_541, id: 2, op: "start" },
    { dir: "reply", at: 10_544, id: 2, kind: "reply" },
  ];
  result.diagnostics = {
    bridgeLogs: { cold: log, repeat: log },
    workerLogs: { cold: workerLog, repeat: workerLog },
    timeOrigins: { cold: 10_000, repeat: 10_000 },
    cold: [],
    turns: [],
  };
  return result;
}

/** The bridge page's result: five requests with replies; on a worker build its marks and the engine Worker's log. */
function bridgeResult(backend = "worker") {
  const ops = ["prepare", "start", "preparePlanText", "captureKeep", "continue"];
  const requests = ops.map((op, index) => ({
    op,
    id: index + 1,
    postAt: 100 + index * 50,
    postMs: 0.5,
    replyAt: 120 + index * 50,
  }));
  return {
    script: "CelebWorship",
    route: "source",
    backend,
    ok: true,
    at: backend === "worker" ? { workerConstructed: 40, workerReady: 90 } : {},
    inputUnits: 100,
    inputBytes: 120,
    requests,
    ...(backend === "worker"
      ? {
          workerLog: [
            { dir: "reply", at: 10_090, id: null, kind: "ready" },
            ...requests.flatMap((request) => [
              { dir: "request", at: 10_000 + request.postAt + 1, id: request.id, op: request.op },
              { dir: "reply", at: 10_000 + request.postAt + 4, id: request.id, kind: "reply" },
            ]),
          ],
          timeOrigin: 10_000,
          workerSide: [],
        }
      : {}),
  };
}

const tapsResult = () => ({
  ok: true,
  rectangle: { left: 8, top: 400, width: 96, height: 48 },
  window: { fromMs: 0, toMs: 100 },
  clock: { offsetMs: -3.5, uncertaintyMs: 1 },
  ledger: [
    { id: 1, x: 10, y: 10, sentMs: 10 },
    { id: 2, x: 12, y: 10, sentMs: 26 },
  ],
  deliveries: [
    { id: 1, t: 15, ts: 12, x: 10, y: 10 },
    { id: 2, t: 30, ts: 27, x: 12, y: 10 },
  ],
  cdpErrors: [],
  overflow: false,
  sent: 2,
});

const keepResult = () => ({
  ok: true,
  outcome: "completed",
  completed: true,
  scope: "s",
  baselineMs: 5,
  hiddenAt: 100,
  lifecycle: [
    { type: "visibilitychange", t: 100, visibility: "hidden" },
    { type: "visibilitychange", t: 400, visibility: "visible" },
  ],
  transactions: [
    {
      stores: ["sessions"],
      start: 200,
      end: 300,
      outcome: "complete",
      puts: [{ store: "sessions", scope: "s", observedMs: 9, length: 20 }],
    },
  ],
});

const row = (scenario, options, result) => ({ ...header(scenario, options), result });

/** Every scenario's intact fixtures: each validates complete in every cell that applies. */
export const BASES = {
  "session chromium main": row("session", {}, sessionResult()),
  "session chromium worker": row(
    "session",
    { backend: "worker" },
    sessionResult({ backend: "worker" }),
  ),
  "session firefox main": row(
    "session",
    { engine: "firefox" },
    sessionResult({ engine: "firefox" }),
  ),
  "session pixel main": row("session", { engine: "pixel" }, sessionResult({ engine: "pixel" })),
  "sessionInstrumented chromium worker": row(
    "sessionInstrumented",
    { backend: "worker" },
    instrumentedResult(),
  ),
  "aa chromium full": row(
    "aa",
    {},
    { ok: true, arm: "full", probe: gate("Start"), errors: [], cold: {} },
  ),
  "bridge chromium worker": row(
    "bridge",
    { backend: "worker", route: "plan" },
    bridgeResult("worker"),
  ),
  "bridge chromium main": row("bridge", { route: "plan" }, bridgeResult("main")),
  "taps chromium main": row("taps", { script: "DisciplineClinic" }, tapsResult()),
  "bridgeTaps chromium worker": row(
    "bridgeTaps",
    { script: "DisciplineClinic", backend: "worker", route: "plan" },
    tapsResult(),
  ),
  "keepHandler chromium": row("keepHandler", {}, keepResult()),
  // A capture committed while hidden, beside an aborted one and one still open: a complete trial.
  "keepHandler chromium, an aborted and an open transaction": row(
    "keepHandler",
    {},
    {
      ...keepResult(),
      transactions: [
        ...keepResult().transactions,
        {
          start: 310,
          end: 320,
          outcome: "abort",
          puts: [{ store: "sessions", scope: "s", observedMs: 9, length: 20 }],
        },
        { start: 350, end: null, outcome: null, puts: [] },
      ],
    },
  ),
  "keepCompletion pixel": row("keepCompletion", { engine: "pixel" }, keepResult()),
  "keepDurable pixel": row(
    "keepDurable",
    { engine: "pixel" },
    { ok: true, outcome: "durable after 1 s", completed: true, baselineMs: 5, storedMs: 9 },
  ),
  "demo chromium": row(
    "demo",
    { script: "demo" },
    { ok: true, errors: [], turns: 6, failed: false, ended: true },
  ),
  "delayedSmoke chromium": {
    ...row("delayedSmoke", { script: "smoke" }, { ok: true, exit: 0 }),
    delayMs: 0,
  },
};

/** Fixtures that hold the leaves the intact ones cannot, each with the cells it must fail (`[]`: complete). */
export const VARIANTS = {
  "a turn the driver could not send, and one cut": {
    row: (() => {
      const base = clone(BASES["session chromium main"]);
      base.result.turns.push({ turn: 1, ok: false, reason: "Turn 1 did not settle" });
      base.result.turns.push({
        turn: 2,
        sentAt: 980,
        before: base.result.probe.repeat.states[2],
        end: "cut",
      });
      return base;
    })(),
    failing: ["counts", "timing"],
  },
  "a turn sent from a state that still showed Start": {
    row: (() => {
      const base = clone(BASES["session chromium main"]);
      base.result.turns[0].before = base.result.probe.repeat.states[0];
      return base;
    })(),
    failing: [],
  },
  "a frame still pending after the last drawn record": {
    row: (() => {
      const base = clone(BASES["session chromium main"]);
      base.result.probe.repeat.changes.push({ t: 2000 });
      base.result.probe.repeat.states.push({
        ...base.result.probe.repeat.states[2],
        t: 2001,
        frame: null,
      });
      return base;
    })(),
    failing: [],
  },
  "a tied pending tail after every drawn record": {
    row: (() => {
      const base = clone(BASES["session chromium main"]);
      const gate = base.result.probe.repeat;
      gate.rowChanges.push({ id: "m1", t: 2000 }, { id: "m1", t: 2000 });
      gate.changes.push({ t: 2000 });
      return base;
    })(),
    failing: [],
  },
  "a demo with an error: a measured failure": {
    row: row(
      "demo",
      { script: "demo" },
      { ok: false, errors: ["TypeError: x"], turns: 6, failed: false },
    ),
    failing: [],
  },
  "a taps sample with a CDP send error": {
    row: (() => {
      const base = clone(BASES["taps chromium main"]);
      base.result.cdpErrors = ["Input.dispatchTouchEvent: closed"];
      return base;
    })(),
    failing: ["counts", "timing"],
  },
};

export const failingCells = (cells) =>
  Object.entries(cells)
    .filter(([, cell]) => cell !== null && cell.problems.length > 0)
    .map(([name]) => name)
    .sort();
export const cellsOf = (fixture) => validateSample(axes(fixture), parseRow(fixture));
