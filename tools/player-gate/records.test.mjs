// The kit's validation boundary (#2122): rows parsed once into validated copies (`lib/records.mjs`,
// `lib/row-shapes.mjs`), read through the strict reader, each scenario's parts and relations (`validate.mjs`). The
// fixtures hold every declared leaf between them; the families mutate them, and every expected outcome is written here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildReport } from "./report.mjs";
import { isParsedRow, parseRow, sectionsOf } from "./lib/records.mjs";
import { cellName } from "./cells.mjs";
import { SHAPES } from "./lib/row-shapes.mjs";
import { NULLABLE, strictRecord } from "./lib/evidence.mjs";
import { cellOf, isValidated, NUMBERS, validateSample } from "./validate.mjs";

const clone = (value) => structuredClone(value);
const axes = (row) => ({
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
const BASES = {
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
const VARIANTS = {
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

const failingCells = (cells) =>
  Object.entries(cells)
    .filter(([, cell]) => cell !== null && cell.problems.length > 0)
    .map(([name]) => name)
    .sort();
const cellsOf = (fixture) => validateSample(axes(fixture), parseRow(fixture));

test("every intact fixture validates complete, and every variant fails exactly its cells", () => {
  for (const [name, fixture] of Object.entries(BASES))
    assert.deepEqual(
      failingCells(cellsOf(fixture)),
      [],
      `${name}: ${JSON.stringify(cellsOf(fixture))}`,
    );
  for (const [name, { row: fixture, failing }] of Object.entries(VARIANTS))
    assert.deepEqual(failingCells(cellsOf(fixture)), failing, name);
});

/**
 * A declared slot: the shape object that declares it and the key (`[]` for an array's elements), so a shared shape's
 * slot is one slot. The row's own fields are every scenario's header: one set of slots, `HEADER_SLOTS`.
 */
const HEADER_SLOTS = {};
const ids = new WeakMap();
let nextId = 0;
const slotOf = (parent, key) => {
  if (!ids.has(parent)) ids.set(parent, (nextId += 1));
  return `${ids.get(parent)}:${key}`;
};

/**
 * Each leaf of `value` under `shape` (`row-shapes.mjs`) at `path`: `{ path, kind, optional, owner, slot }`, `owner`
 * the section that owns it (`header` for the row's own fields), `slot` its declaration. An ignored subtree has none.
 */
function* leaves(shape, value, path, owner, slot = "root") {
  if (shape.kind === "ignored" || value === undefined || value === null) return;
  if (shape.kind === "cached") {
    yield { path, kind: shape.shape.kind, optional: shape.shape.optional === true, owner, slot };
    return;
  }
  if (shape.kind === "object") {
    yield { path, kind: "object", optional: shape.optional === true, owner, slot };
    for (const [key, field] of Object.entries(shape.fields)) {
      if (path.length === 1 && path[0] === "result") {
        if (field.kind === "ignored") continue;
        const inner = field.kind === "section" || field.kind === "header" ? field.shape : field;
        const section = field.kind === "section" ? field.name : "header";
        yield* leaves(inner, value[key], [...path, key], section, slotOf(shape, key));
      } else {
        const parent = path.length === 0 ? HEADER_SLOTS : shape;
        yield* leaves(field, value[key], [...path, key], owner, slotOf(parent, key));
      }
    }
    return;
  }
  if (shape.kind === "array") {
    yield { path, kind: "array", optional: shape.optional === true, owner, slot };
    for (const [index, element] of value.entries())
      yield* leaves(shape.element, element, [...path, index], owner, slotOf(shape, "[]"));
    return;
  }
  yield { path, kind: shape.kind, optional: shape.optional === true, owner, slot };
}
const rowShape = (scenario) => ({
  kind: "object",
  fields: { ...SHAPES[scenario].header, result: SHAPES[scenario].result },
});
const leavesOf = (fixture) => [...leaves(rowShape(fixture.scenario), fixture, [], "header")];

/** Every declared slot under `shape`, `slot → a path pattern that reaches it` (`[]` for an array's elements). */
function declared(shape, pattern, slot, into, root = false) {
  if (shape.kind === "ignored") return into;
  if (["cached", "section", "header"].includes(shape.kind))
    return declared(shape.shape, pattern, slot, into);
  if (!into.has(slot)) into.set(slot, pattern);
  if (shape.kind === "object")
    for (const [key, field] of Object.entries(shape.fields))
      declared(field, `${pattern}.${key}`, slotOf(root ? HEADER_SLOTS : shape, key), into);
  if (shape.kind === "array") declared(shape.element, `${pattern}[]`, slotOf(shape, "[]"), into);
  return into;
}
const patternOf = (path) =>
  path.reduce(
    (pattern, key) => (typeof key === "number" ? `${pattern}[]` : `${pattern}.${key}`),
    "row",
  );

test("the fixtures hold every declared slot of every scenario's shape, each shared shape once", () => {
  const fixtures = [
    ...Object.values(BASES),
    ...Object.values(VARIANTS).map(({ row: fixture }) => fixture),
  ];
  const shapes = new Map(Object.keys(SHAPES).map((scenario) => [scenario, rowShape(scenario)]));
  const held = new Set(
    fixtures.flatMap((fixture) =>
      [...leaves(shapes.get(fixture.scenario), fixture, [], "header")].map(({ slot }) => slot),
    ),
  );
  const all = new Map();
  for (const [scenario, shape] of shapes)
    declared(shape, `${scenario}: row`, `${scenario}:root`, all, true);
  const missing = [...all]
    .filter(([slot]) => !slot.endsWith(":root") && !held.has(slot))
    .map(([, at]) => at);
  assert.deepEqual(missing, [], "declared slots no fixture holds");
  assert.ok(all.size > 100, `only ${all.size} slots`);
});

/**
 * The cells a failure in each section fails, per scenario, on the fixtures' engines: written here from the fields'
 * parts (`validate.mjs` `NUMBERS`), not derived from them. A header failure fails the row's parse.
 */
const SECTION_CELLS = {
  session: { timing: ["counts", "timing"], bytes: ["counts"] },
  sessionInstrumented: {
    timing: ["counts", "crossClock", "timing"],
    bytes: ["counts"],
    diagnostics: ["counts", "crossClock", "timing"],
  },
  aa: { timing: ["timing"] },
  bridge: { timing: ["crossClock", "timing"], input: ["counts"] },
  taps: { timing: ["counts", "timing"] },
  bridgeTaps: { timing: ["counts", "timing"] },
  keepHandler: { timing: ["timing"] },
  keepCompletion: { timing: ["timing"] },
  keepDurable: { timing: ["timing"] },
  demo: { timing: ["counts", "timing"] },
  delayedSmoke: { timing: ["timing"] },
};

/** `fixture` with the value at `path` replaced by `value` (removed for `undefined`). */
function mutated(fixture, path, value) {
  const copy = clone(fixture);
  const parent = path.slice(0, -1).reduce((node, key) => node[key], copy);
  if (value === undefined) {
    if (Array.isArray(parent)) parent.splice(path.at(-1), 1);
    else delete parent[path.at(-1)];
  } else parent[path.at(-1)] = value;
  return copy;
}

/** The JSON-retainable values each kind refuses, written per kind. */
const REFUSED = {
  time: [-1, 2 ** 53, "1", false],
  signed: [2 ** 53, "1", true],
  real: ["1", false],
  count: [-1, 1.5, 2 ** 53, "1"],
  string: [7, false],
  boolean: ["true", 0],
  object: ["x", 1, []],
  array: [{}, "x"],
};

/** Each intact fixture's cells that apply. */
const applying = new Map(
  Object.values(BASES).map((fixture) => [
    fixture,
    Object.entries(cellsOf(fixture))
      .filter(([, cell]) => cell !== null)
      .map(([name]) => name),
  ]),
);

/** What a refused value at a leaf of `owner` does to `fixture`: the parse throws (header) or exactly its cells fail. */
function assertRefused(fixture, path, value, owner, what) {
  const copy = mutated(fixture, path, value);
  if (owner === "header") {
    assert.throws(
      () => parseRow(copy),
      /malformed evidence|missing evidence|no shape for the scenario/u,
      what,
    );
    return;
  }
  assert.deepEqual(
    failingCells(validateSample(axes(copy), parseRow(copy))),
    SECTION_CELLS[fixture.scenario][owner].filter((name) => applying.get(fixture).includes(name)),
    what,
  );
}

test("family (a): a refused value, a missing required value or an undeclared key fails exactly its section's cells", () => {
  let cases = 0;
  for (const [name, fixture] of Object.entries(BASES)) {
    if (fixture.engine === "firefox") continue; // its section cells differ by applicability; the parse is checked below
    const swept = new Set();
    for (const { path, kind, optional, owner, slot } of leavesOf(fixture)) {
      // The row and its result are the parse's own boundary, checked apart below; each slot once per fixture.
      if ((path.length <= 1 && kind === "object") || swept.has(slot)) continue;
      swept.add(slot);
      const where = `${name}: ${patternOf(path)}`;
      for (const value of REFUSED[kind]) {
        assertRefused(fixture, path, value, owner, `${where} = ${JSON.stringify(value)}`);
        cases += 1;
      }
      if (!optional && typeof path.at(-1) !== "number") {
        assertRefused(fixture, path, undefined, owner, `${where} deleted`);
        assertRefused(fixture, path, null, owner, `${where} null`);
        cases += 2;
      }
      if (kind === "object") {
        const node = path.reduce((at, key) => at[key], fixture);
        assertRefused(
          fixture,
          path,
          { ...node, undeclared: 1 },
          owner,
          `${where}: an undeclared key`,
        );
        cases += 1;
      }
    }
  }
  assert.ok(cases > 1000, `only ${cases} cases`);
});

test("family (c): a result that is no object, or holds an undeclared key, fails every section; an undeclared row key fails the parse", () => {
  for (const [name, fixture] of Object.entries(BASES)) {
    if (fixture.engine === "firefox") continue;
    const all = Object.entries(cellsOf(fixture))
      .filter(([, cell]) => cell !== null)
      .map(([cell]) => cell)
      .sort();
    for (const result of [null, "x", [], { ...fixture.result, undeclared: 1 }])
      assert.deepEqual(
        failingCells(cellsOf({ ...fixture, result })),
        all,
        `${name}: result ${JSON.stringify(result).slice(0, 20)}`,
      );
    assert.throws(
      () => parseRow({ ...fixture, undeclared: 1 }),
      /row.undeclared is a path no shape declares/u,
      name,
    );
  }
  assert.throws(
    () => parseRow({ ...BASES["demo chromium"], scenario: "unknown" }),
    /no shape for the scenario/u,
  );
});

test("family (a): an optional leaf may be absent or null without a parse problem", () => {
  for (const [name, fixture] of Object.entries(BASES))
    for (const { path, optional, owner } of leavesOf(fixture)) {
      if (!optional || owner === "header" || typeof path.at(-1) === "number") continue;
      for (const value of [undefined, null]) {
        const sections = sectionsOf(parseRow(mutated(fixture, path, value)));
        const at = path.join(".");
        assert.ok(
          ![...sections.values()].some(({ problems }) =>
            problems.some((problem) => problem.includes(at)),
          ),
          `${name}: ${patternOf(path)} = ${value}`,
        );
      }
    }
});

/**
 * `gate` with every frame from `t` on still pending: the probe has recorded those records, but no frame has run for
 * them yet, which is a page's legitimate tail (`validate.mjs` `framesComplete`).
 */
function pendingFrom(gate, t) {
  for (const list of ["states", "changes", "rowChanges", "rows"])
    for (const record of gate[list]) if (record.t >= t) delete record.frame;
}

/**
 * Family (b): the order relations and evidence rules the validation checks, written here: each with the fixture it
 * applies to, the change that reverses or removes its evidence, the cells that change must fail, and the reason each
 * of them must give (or the cells named sixth, for a field's own reason).
 */
const RELATIONS = [
  [
    "playable: Start enabled → its input",
    "session chromium main",
    (r) => (r.result.probe.cold.inputs[0].ts = 400),
    ["counts", "timing"],
    "Start enabled → its input runs from 500 to 400",
  ],
  [
    "playable: a state's event → its frame",
    "session chromium main",
    (r) => (r.result.probe.cold.states[0].frame = 490),
    ["counts", "timing"],
    "Start enabled: its event → its frame",
  ],
  [
    "playable: the input → the first control's frame",
    "session chromium main",
    (r) => (r.result.probe.cold.inputs[0].ts = 717),
    ["counts", "timing"],
    "Start's input → the first control's frame",
  ],
  [
    "playable: Start's frame → its input",
    "session chromium main",
    (r) => (r.result.probe.cold.inputs[0].ts = 505),
    ["counts", "timing"],
    "Start's frame → its input",
  ],
  [
    "session: a page's ended transaction has its outcome",
    "session chromium main",
    (r) => (r.result.probe.repeat.transactions[0].outcome = null),
    ["counts", "timing"],
    "the repeat page's transaction 0: its outcome, beside its end",
  ],
  [
    "turn: the input → its feedback frame",
    "session chromium main",
    (r) => (r.result.probe.repeat.inputs[1].ts = 940),
    ["counts", "timing"],
    "the turn's input → its feedback frame",
  ],
  [
    "turn: a change's event → its frame",
    "session chromium main",
    (r) => (r.result.probe.repeat.changes = [{ t: 920, frame: 910 }]),
    ["counts", "timing"],
    "the feedback change: its event → its frame",
  ],
  [
    "turn: the settling event → its frame",
    "session chromium main",
    (r) => (r.result.probe.repeat.states[2].frame = 940),
    ["counts", "timing"],
    "the settling control: its event → its frame",
  ],
  [
    "first save: its start → its commit",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].end = 599),
    ["counts", "timing"],
    "the cold page's transaction 0: its start → its end",
  ],
  [
    "Worker start: construction → ready",
    "session chromium worker",
    (r) => (r.result.probe.cold.workers[0].ready = 90),
    ["counts", "timing"],
    "the engine Worker's start",
  ],
  [
    "Worker start: ready present",
    "session chromium worker",
    (r) => (r.result.probe.cold.workers[0].ready = null),
    ["counts", "timing"],
    "the engine Worker reaching ready",
  ],
  [
    "byte marks: Start enabled → playable",
    "session chromium main",
    (r) => {
      const marks = r.result.bytes.marks;
      [marks.startEnabled, marks.playable] = [marks.playable, marks.startEnabled];
    },
    ["counts"],
    "the byte page's Start enabled → playable",
  ],
  [
    "byte phases: the cached flag against the start",
    "session chromium main",
    (r) => (r.result.bytes.requests[0].beforeStartEnabled = false),
    ["counts"],
    "/player/: its cached beforeStartEnabled (false) is not its start against the mark (true)",
  ],
  [
    // An open request has no length: its served bytes are no count, which the output domain refuses.
    "byte account: every request finished or failed",
    "session chromium main",
    (r) => Object.assign(r.result.bytes.requests[0], { finished: false, encodedBytes: null }),
    ["counts"],
    "served the whole cold page, page, encoded: NaN is no safe integer ≥ 0",
  ],
  [
    "probe records: none dropped",
    "session chromium main",
    (r) => (r.result.probe.repeat.dropped = 1),
    ["counts", "timing"],
    "the repeat page: 1 probe records dropped",
  ],
  [
    "instrumented: a post → its reply",
    "sessionInstrumented chromium worker",
    (r) => (r.result.diagnostics.bridgeLogs.cold[2].at = 519),
    ["counts", "crossClock", "timing"],
    "prepare's round trip runs from 520 to 519",
  ],
  [
    "instrumented: a Worker receipt → its reply",
    "sessionInstrumented chromium worker",
    (r) => (r.result.diagnostics.workerLogs.cold[2].at = 10_520),
    ["counts", "crossClock", "timing"],
    "prepare's handling in the Worker",
  ],
  [
    "bridge: a request → its reply",
    "bridge chromium worker",
    (r) => (r.result.requests[2].replyAt = 199),
    ["crossClock", "timing"],
    "preparePlanText's round trip",
  ],
  [
    "bridge: Worker construction → ready",
    "bridge chromium worker",
    (r) => (r.result.at.workerReady = 39),
    ["crossClock", "timing"],
    "the bridge page's Worker start",
  ],
  [
    "bridge: a Worker receipt → its reply",
    "bridge chromium worker",
    (r) => (r.result.workerLog[2].at = 10_100),
    ["crossClock", "timing"],
    "prepare's handling in the Worker",
  ],
  [
    "taps: the window",
    "taps chromium main",
    (r) => (r.result.window = { fromMs: 100, toMs: 0 }),
    ["counts", "timing"],
    "the taps window",
  ],
  [
    "taps: a tap's event → its handler",
    "taps chromium main",
    (r) => (r.result.deliveries[0].ts = 16),
    ["counts", "timing"],
    "tap 1: its event → its handler",
  ],
  [
    "taps: the sends in order",
    "taps chromium main",
    (r) => (r.result.ledger[1].sentMs = 9),
    ["counts", "timing"],
    "the sends 0 → 1",
  ],
  [
    "keep: a transaction's start → its end",
    "keepHandler chromium",
    (r) => (r.result.transactions[0].end = 150),
    ["timing"],
    "transaction 0: its start → its end",
  ],
  [
    // Sol code r1's witness: an aborted capture without its end, its cached outcome agreeing.
    "keep: a transaction with an outcome has its end",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "aborted";
      r.result.transactions = [{ ...r.result.transactions[0], end: null, outcome: "abort" }];
    },
    ["timing"],
    "transaction 0: its end, beside its outcome",
  ],
  [
    "keep: an ended transaction has its outcome",
    "keepHandler chromium, an aborted and an open transaction",
    (r) => (r.result.transactions[1].outcome = null),
    ["timing"],
    "transaction 1: its outcome, beside its end",
  ],
  [
    "keep: a committed capture has its end",
    "keepHandler chromium, an aborted and an open transaction",
    (r) => (r.result.transactions[0].end = null),
    ["timing"],
    "transaction 0: its end, beside its outcome",
  ],
  [
    "keep: the page reported hidden (R5-02)",
    "keepHandler chromium",
    (r) => (r.result.lifecycle = [r.result.lifecycle[1]]),
    ["timing"],
    "row.result.lifecycle: a visibilitychange to hidden",
  ],
  [
    "keep: the cached outcome",
    "keepHandler chromium",
    (r) => (r.result.outcome = "aborted"),
    ["timing"],
    "the recorded outcome (aborted) is not its records' (completed)",
  ],
  [
    "durable: the baseline present (R6)",
    "keepDurable pixel",
    (r) => (r.result.baselineMs = null),
    ["timing"],
    "missing evidence: row.result.baselineMs",
  ],
  [
    "durable: the cached outcome",
    "keepDurable pixel",
    (r) => (r.result.outcome = "not durable after 1 s"),
    ["timing"],
    "the recorded outcome (not durable after 1 s) is not its records' (durable after 1 s)",
  ],
  [
    "demo: the cached pass",
    "demo chromium",
    (r) => (r.result.ok = false),
    ["counts", "timing"],
    "the recorded ok (false) is not its records' (true)",
  ],
  [
    "smoke: the cached pass against the exit (R6)",
    "delayedSmoke chromium",
    (r) => (r.result.exit = 1),
    ["timing"],
    "the recorded ok (true) is not its records' (false)",
  ],
  [
    "a sample that must complete and failed",
    "bridge chromium main",
    (r) => (r.ok = false),
    ["counts", "timing"],
    "the sample failed",
  ],
  // The rows the check sites' coverage demands (orchestrator 2's ruling (B)); each reason is its site's message.
  [
    "session: a turn without its records",
    "session chromium main",
    (r) => r.result.turns.push({ turn: 1 }),
    ["counts", "timing"],
    "turn 1: no records of the turn",
  ],
  [
    "session: no turn",
    "session chromium main",
    (r) => (r.result.turns = []),
    ["counts", "timing"],
    "a turn",
  ],
  [
    "playable: Start never shown enabled",
    "session chromium main",
    (r) => (r.result.probe.cold.states[0].start = null),
    ["counts", "timing"],
    "cold playable: Start was never shown enabled",
  ],
  [
    "playable: Start enabled has no frame",
    "session chromium main",
    (r) => pendingFrom(r.result.probe.cold, 500),
    ["counts", "timing"],
    "cold playable: Start enabled has no frame",
  ],
  [
    // Sol code r3's witness: A/A's own playable check, apart from the session's.
    "aa: Start enabled has no frame",
    "aa chromium full",
    (r) => pendingFrom(r.result.probe, 500),
    ["timing"],
    "cold playable: Start enabled has no frame",
  ],
  [
    "playable: no trusted input after Start",
    "session chromium main",
    (r) => r.result.probe.cold.inputs.forEach((input) => (input.trusted = false)),
    ["counts", "timing"],
    "cold playable: no trusted input after Start was enabled",
  ],
  [
    "playable: no control after the input",
    "session chromium main",
    (r) => (r.result.probe.cold.states = [r.result.probe.cold.states[0]]),
    ["counts", "timing"],
    "cold playable: no enabled control after Start's input",
  ],
  [
    "playable: the first control has no frame",
    "session chromium main",
    (r) => pendingFrom(r.result.probe.cold, 700),
    ["counts", "timing"],
    "cold playable: the first control has no frame",
  ],
  [
    "playable: Continue never shown enabled",
    "session chromium main",
    (r) => (r.result.probe.repeat.states[0].start = null),
    ["counts", "timing"],
    "repeat playable: Continue was never shown enabled",
  ],
  [
    "turn: no input recorded",
    "session chromium main",
    (r) => r.result.probe.repeat.inputs.pop(),
    ["counts", "timing"],
    "turn 0: no input recorded",
  ],
  [
    "turn: no DOM change after the input",
    "session chromium main",
    (r) => (r.result.probe.repeat.changes = []),
    ["counts", "timing"],
    "turn 0: no DOM change after the input",
  ],
  [
    "turn: no feedback frame",
    "session chromium main",
    (r) => pendingFrom(r.result.probe.repeat, 920),
    ["counts", "timing"],
    "turn 0: no feedback frame after the input",
  ],
  [
    "turn: neither settled nor ended",
    "session chromium main",
    (r) => {
      r.result.probe.repeat.states.pop();
      r.result.probe.repeat.rowChanges = [];
    },
    ["counts", "timing"],
    "turn 0: neither settled nor ended",
  ],
  [
    // Sol code r2's witness: feedback (961 → 1000) and the settling control (950 → 960) in order, the input after it.
    "turn: the input → its settlement",
    "session chromium main",
    (r) => {
      r.result.probe.repeat.inputs[1].ts = 961;
      r.result.probe.repeat.changes[0].frame = 1000;
    },
    ["counts", "timing"],
    "the turn's input → its settlement",
  ],
  [
    "turn: the input → the first script row shown",
    "session chromium main",
    (r) =>
      r.result.probe.repeat.rows.push({
        id: "m2",
        speaker: "system",
        t: 905,
        frame: 906,
        shownFrame: 898,
      }),
    ["counts", "timing"],
    "the turn's input → the first script row shown",
  ],
  [
    "first save: no publish",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions = []),
    ["counts", "timing"],
    "first save: no publish with a session and a plan record after Start",
  ],
  [
    "first save: not complete",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].outcome = "abort"),
    ["counts", "timing"],
    "first save: the first save abort",
  ],
  [
    "a required field without a value",
    "session chromium worker",
    (r) => (r.result.probe.cold.workers[0].ready = null),
    ["counts", "timing"],
    "Worker: construction → ready (ms)",
    // The field's own cell gives its reason; the counts cell fails with the part it reads.
    ["timing"],
  ],
  [
    "instrumented: the start request's reply",
    "sessionInstrumented chromium worker",
    (r) =>
      (r.result.diagnostics.bridgeLogs.cold = r.result.diagnostics.bridgeLogs.cold.filter(
        (entry) => entry.id !== 2 || entry.dir !== "reply",
      )),
    ["counts", "crossClock", "timing"],
    "a start request with its reply in the cold log",
  ],
  [
    "taps: a CDP send error",
    "taps chromium main",
    (r) => (r.result.cdpErrors = ["Input.dispatchTouchEvent: closed"]),
    ["counts", "timing"],
    "1 CDP send errors",
  ],
  [
    "taps: a delivery no send has",
    "taps chromium main",
    (r) => (r.result.deliveries[1].id = 9),
    ["counts", "timing"],
    "1 taps off their grid point",
  ],
  [
    "taps: a tap off its grid point",
    "taps chromium main",
    (r) => (r.result.deliveries[1].x = 40),
    ["counts", "timing"],
    "1 taps off their grid point",
  ],
  // Sol final r1, F1 and the inventory's scope sites (orchestrator 2's ruling (a)): an ended transaction's session put
  // without its observation or its scope, or a trial without its scope, is no evidence, its cached negative agreeing.
  [
    "keep: a committed session put without its observation (Sol final r1)",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "not observed within 30 s";
      r.result.transactions[0].puts[0].observedMs = null;
    },
    ["timing"],
    "the trial's transaction 0: a session put's observed scene time",
  ],
  [
    "keep: a committed session put without its scope",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "not observed within 30 s";
      r.result.transactions[0].puts[0].scope = null;
    },
    ["timing"],
    "the trial's transaction 0: a session put's scope",
  ],
  [
    "keep: the trial without its scope",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "not observed within 30 s";
      delete r.result.scope;
    },
    ["timing"],
    "missing evidence: row.result.scope",
  ],
  [
    "session: a page's committed session put without its observation",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].puts[0].observedMs = null),
    ["counts", "timing"],
    "the cold page's transaction 0: a session put's observed scene time",
  ],
  // The implied sites' ordering rows (Sol final r1, F3): each breaks both the earlier check and the implied condition,
  // so the earlier check's reason pins which one speaks first.
  [
    "first save: a commit before the press (ordering)",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].end = 554),
    ["counts", "timing"],
    "the cold page's transaction 0: its start → its end",
  ],
  [
    "keep: a commit before the hiding (ordering)",
    "keepHandler chromium",
    (r) => (r.result.transactions[0].end = 99),
    ["timing"],
    "the trial's transaction 0: its start → its end",
  ],
  // The absence sites' witnesses: a value absent where its context requires it makes the cell incomplete.
  [
    "bridge: a request without its reply",
    "bridge chromium worker",
    (r) => (r.result.requests[1].replyAt = null),
    ["timing"],
    "start: request → reply (ms)",
  ],
  [
    "bridge: the Worker's reply absent",
    "bridge chromium worker",
    (r) => r.result.workerLog.splice(2, 1),
    ["timing"],
    "prepare: Worker receipt → reply (ms)",
  ],
  [
    "session: a worker build without its engine Worker's requests",
    "session chromium worker",
    (r) => (r.result.bytes.requests = r.result.bytes.requests.filter((q) => q.target === "page")),
    ["counts"],
    "requests of the engine Worker's target (count)",
  ],
  [
    "heap: the engine Worker's reading absent",
    "session chromium worker",
    (r) => (r.result.memory[0].workers[0].usedBytes = null),
    ["counts"],
    "heap, engine Worker, at Start enabled (bytes)",
  ],
  [
    "instrumented: the probe's gaps absent",
    "sessionInstrumented chromium worker",
    (r) => delete r.result.probe.cold.gaps,
    ["counts", "crossClock", "timing"],
    "missing evidence: row.result.probe.cold.gaps",
  ],
  [
    "first save: still open",
    "session chromium main",
    (r) => Object.assign(r.result.probe.cold.transactions[0], { end: null, outcome: null }),
    ["counts", "timing"],
    "first save: the first save never ended",
  ],
  [
    "first save: long tasks absent where the engine reports them",
    "session chromium main",
    (r) => (r.result.probe.cold.longTasks = null),
    ["timing"],
    "first save: long tasks in that span (ms)",
  ],
  // Sol code r6, F5: the client posts only requests, so a post without its ID is a request lost from the count.
  [
    "instrumented: a posted operation without its request ID",
    "sessionInstrumented chromium worker",
    (r) =>
      r.result.diagnostics.bridgeLogs.repeat.push({
        dir: "post",
        at: 906,
        postMs: 1,
        id: null,
        op: "observeInput",
        session: "s",
        atMs: 21,
      }),
    ["counts", "crossClock", "timing"],
    "a posted request's ID",
  ],
  [
    "instrumented: a posted operation with its request ID deleted",
    "sessionInstrumented chromium worker",
    (r) => delete r.result.diagnostics.bridgeLogs.cold[1].id,
    ["counts", "crossClock", "timing"],
    "the cold log's entry 1: a posted request's ID",
  ],
  // Sol code r7, F6: a state that shows buttons holds its controls root's serial; without it an unchanged action reads
  // as another one, and the turn settles early.
  [
    "turn: the state before without its controls' serial (Sol code r7)",
    "session chromium main",
    (r) => {
      const again = { ...r.result.turns[0].before, t: 910, frame: 915 };
      again.buttons = [{ ...again.buttons[0], label: "Go again" }];
      r.result.probe.repeat.states.splice(2, 0, again);
      r.result.probe.repeat.changes.unshift({ t: 909, frame: 915 });
      r.result.turns[0].before = { ...r.result.turns[0].before, control: null };
    },
    ["counts", "timing"],
    "turn 0's state before: a state with buttons, its controls' serial",
  ],
  [
    "turn: the state before with its controls' serial deleted",
    "session chromium main",
    (r) => {
      const before = { ...r.result.turns[0].before };
      delete before.control;
      r.result.turns[0].before = before;
    },
    ["counts", "timing"],
    "turn 0's state before: a state with buttons, its controls' serial",
  ],
  [
    "probe: a page's state with buttons without its controls' serial",
    "session chromium main",
    (r) =>
      (r.result.probe.repeat.states[2] = { ...r.result.probe.repeat.states[2], control: null }),
    ["counts", "timing"],
    "the repeat page's state 2: a state with buttons, its controls' serial",
  ],
  // Sol code r8, F7: frames arrive in the order they were asked for, so a record without its frame before a later drawn
  // one lost it; a settling candidate filtered out for it would report a later settlement.
  [
    "turn: a control state's frame lost before a later one (Sol code r8)",
    "session chromium main",
    (r) => (r.result.probe.repeat.states[2].frame = null),
    ["counts", "timing"],
    "the repeat page's states 2: its frame, before a later record's",
  ],
  [
    "turn: a control state's frame deleted before a later one",
    "session chromium main",
    (r) => delete r.result.probe.repeat.states[2].frame,
    ["counts", "timing"],
    "the repeat page's states 2: its frame, before a later record's",
  ],
  [
    "turn: a row update's frame lost before a later one (Sol code r8)",
    "session chromium main",
    (r) => Object.assign(r.result.probe.repeat.rowChanges[0], { t: 920, frame: null }),
    ["counts", "timing"],
    "the repeat page's rowChanges 0: its frame, before a later record's",
  ],
];

/** Each `ms` field's relations, written here: a field that reports an interval names the relation that orders it. */
const FIELD_RELATIONS = {
  "playable, the Player's own time (headline)": [
    "playable: a state's event → its frame",
    "playable: the input → the first control's frame",
  ],
  "navigation → the frame after": ["playable: a state's event → its frame"],
  "input → the frame after the first control": ["playable: the input → the first control's frame"],
  "enabled → its input": [
    "playable: Start enabled → its input",
    "playable: Start's frame → its input",
  ],
  "Worker: construction → ready": [
    "Worker start: construction → ready",
    "bridge: Worker construction → ready",
  ],
  // The first save is the first transaction to start after the press (`firstSave`), so its start → end orders it.
  "first save: Start's input → commit": ["first save: its start → its commit"],
  "first save: long tasks in that span": ["first save: its start → its commit"],
  "turn: input → feedback frame": ["turn: the input → its feedback frame"],
  "turn: input → settled frame": ["turn: the settling event → its frame"],
  "diagnostic: ": [
    "instrumented: a post → its reply",
    "instrumented: a Worker receipt → its reply",
  ],
  ": request → reply": ["bridge: a request → its reply"],
  "prepare: Worker receipt → reply": ["bridge: a Worker receipt → its reply"],
  "prepare: post duration": ["a recorded duration: family (a)'s refused values"],
  "delay, ": ["taps: a tap's event → its handler"],
  "send cadence, median": ["taps: the sends in order"],
  "clock offset uncertainty": ["a recorded duration: family (a)'s refused values"],
  // A capture counts only when it started after the hiding (`hiddenCapture`), so its start → end orders it.
  "hidden → commit": ["keep: a transaction's start → its end"],
};

test("family (b): each relation reversed or its evidence removed fails exactly its cells", () => {
  for (const [what, base, change, failing, reason, reasonIn = failing] of RELATIONS) {
    const fixture = clone(BASES[base]);
    change(fixture);
    const cells = cellsOf(fixture);
    assert.deepEqual(failingCells(cells), failing, what);
    for (const name of reasonIn)
      assert.ok(
        cells[name].problems.some((problem) => problem.includes(reason)),
        `${what}: ${cells[name].problems}`,
      );
  }
});

test("family (b): every ms field names a relation of the inventory or a recorded duration", () => {
  const names = new Set([
    ...RELATIONS.map(([what]) => what),
    "a recorded duration: family (a)'s refused values",
  ]);
  for (const [scenario, fields] of Object.entries(NUMBERS))
    for (const [label, unit] of fields) {
      if (unit !== "ms") continue;
      const key = Object.keys(FIELD_RELATIONS).find((part) => label.includes(part));
      assert.ok(key !== undefined, `${scenario} "${label}": no relation`);
      for (const relation of FIELD_RELATIONS[key]) assert.ok(names.has(relation), relation);
    }
});

test("a cross-clock difference keeps its sign in its own cell, outside the headline", () => {
  const fixture = clone(BASES["bridge chromium worker"]);
  // The Worker's clock reads the prepare's receipt 2 ms before the page's post: coarsened clocks, not an error.
  fixture.result.workerLog[1].at =
    fixture.result.timeOrigin + fixture.result.requests[0].postAt - 2;
  const cells = cellsOf(fixture);
  assert.deepEqual(failingCells(cells), []);
  assert.equal(
    cells.crossClock.values.find(({ label }) => label === "prepare: delivery latency").value,
    -2,
  );
  for (const field of NUMBERS.bridge.filter(([, unit]) => unit === "ms, cross-clock"))
    assert.equal(cellOf(field), "crossClock");
});

test("the report takes parsed rows only, and a parsed row hands out its frozen header and nothing else", () => {
  const raw = BASES["delayedSmoke chromium"];
  assert.throws(() => buildReport([raw], "r0"), /did not parse/u);
  assert.throws(() => buildReport([{ ...parseRow(raw) }], "r0"), /did not parse/u);
  const handle = parseRow(raw);
  assert.ok(isParsedRow(handle));
  assert.deepEqual(Object.keys(handle), ["header"]);
  assert.ok(Object.isFrozen(handle) && Object.isFrozen(handle.header));
  assert.throws(() => sectionsOf({ header: handle.header }), /not a row parseRow made/u);
  // A validated sample is frozen and branded; a copy of it is no validated sample.
  const cells = validateSample(axes(raw), handle);
  assert.ok(isValidated(cells) && Object.isFrozen(cells.timing.values[0]));
  assert.ok(!isValidated({ ...cells }));
});

test("the strict reader refuses every write, and a reflective read of a parsed copy reaches validated data only", () => {
  const sections = sectionsOf(parseRow(BASES["keepDurable pixel"]));
  const record = strictRecord(sections.get("timing").value, "row.result");
  for (const write of [
    () => (record.baselineMs = 1),
    () => Object.defineProperty(record, "baselineMs", { value: 1 }),
    () => delete record.baselineMs,
    () => Object.setPrototypeOf(record, null),
    () => Object.preventExtensions(record),
  ])
    assert.throws(write, /read-only/u);
  // Sol code r10's descriptor and r12's shorthand prototype link: past the `get` trap, still the validated copy.
  const { constructor } = {};
  assert.equal(constructor.getOwnPropertyDescriptor(record, "baselineMs").value, 5);
  assert.equal(Object.getOwnPropertyDescriptor(record, "storedMs").value, 9);
  // The cached outcome is not in the copy the derivation reads.
  assert.throws(() => record.outcome, /missing evidence: row.result.outcome/u);
  // A missing baseline never reaches a derivation: its section fails at the parse.
  const missing = sectionsOf(
    parseRow(mutated(BASES["keepDurable pixel"], ["result", "baselineMs"], null)),
  );
  assert.deepEqual(missing.get("timing").problems, ["missing evidence: row.result.baselineMs"]);
});

test("Sol final r1, F1: a committed session put without its observation fails its keep cell through the report; valid negatives, plan puts and open transactions stay values", () => {
  const trial = (base, change) => {
    const fixture = clone(BASES[base]);
    change(fixture.result);
    return fixture;
  };
  const outcome = (fixture) => {
    const name = cellName(axes(fixture));
    const report = buildReport([parseRow(fixture)], "r0");
    return {
      incomplete: report.incomplete.some((line) => line.startsWith(`- ${name}:`)),
      completed: report.summary[name]?.["completed while hidden"]?.median ?? null,
    };
  };
  for (const base of ["keepHandler chromium", "keepCompletion pixel"]) {
    // The counterexample, its cached negative agreeing: the observation null, or deleted.
    for (const missing of [(put) => (put.observedMs = null), (put) => delete put.observedMs])
      assert.deepEqual(
        outcome(
          trial(base, (result) => {
            result.outcome = "not observed within 30 s";
            missing(result.transactions[0].puts[0]);
          }),
        ),
        { incomplete: true, completed: null },
        base,
      );
    // A valid observation not later than the baseline is an observed negative; a later one completes.
    assert.deepEqual(
      outcome(
        trial(base, (result) => {
          result.outcome = "not observed within 30 s";
          result.transactions[0].puts[0].observedMs = 4;
        }),
      ),
      { incomplete: false, completed: 0 },
      `${base}: observed 4`,
    );
    assert.deepEqual(outcome(trial(base, () => {})), { incomplete: false, completed: 1 }, base);
    // A plan put has no observation, and a transaction still open committed nothing: both stay valid.
    assert.deepEqual(
      outcome(
        trial(base, (result) => {
          result.transactions[0].puts.push({ store: "plans", scope: null, observedMs: null });
          result.transactions.push({
            start: 350,
            end: null,
            outcome: null,
            puts: [{ store: "sessions", scope: null, observedMs: null }],
          });
        }),
      ),
      { incomplete: false, completed: 1 },
      `${base}: a plan put and an open transaction`,
    );
  }
});

test("Sol final r1, F2: the parsed copy holds no raw record; ignored and cached data are unreachable, and a later change of the row reaches nothing", () => {
  const fixture = clone(BASES["session chromium main"]);
  fixture.result.metrics = { JSHeapUsedSize: 1 };
  const handle = parseRow(fixture);
  const sections = sectionsOf(handle);
  const bytes = strictRecord(sections.get("bytes").value, "row.result").bytes;
  // An ignored subtree (a discarded page's requests, the account's own ok) and a cached phase flag are not in the copy,
  // by a property read or by a descriptor.
  assert.throws(() => bytes.discarded[0].requests, /missing evidence/u);
  assert.equal(Object.getOwnPropertyDescriptor(bytes.discarded[0], "requests"), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(bytes, "ok"), undefined);
  assert.throws(() => bytes.requests[0].beforeStartEnabled, /missing evidence/u);
  assert.throws(
    () => strictRecord(sections.get("timing").value, "row.result").metrics,
    /missing evidence/u,
  );
  // No copy is an alias of the row: changing the row after the parse changes no derived value.
  const before = validateSample(axes(fixture), handle);
  fixture.result.probe.cold.states[0].frame = 999;
  fixture.result.probe.repeat.changes[0].frame = 950;
  fixture.result.bytes.requests[0].encodedBytes = 1_000_000;
  fixture.result.bytes.discarded[0].requests.push({ url: "/raw" });
  assert.deepEqual(validateSample(axes(fixture), handle), before);
  assert.notEqual(sections.get("timing").value.probe.cold, fixture.result.probe.cold);
});

test("every NULLABLE name is an optional leaf of some section, never of the header alone", () => {
  const optionalKeys = new Set();
  const walk = (shape, key, inSection) => {
    if (shape.kind === "section") return walk(shape.shape, key, true);
    if (shape.kind === "cached" || shape.kind === "header")
      return walk(shape.shape, key, inSection);
    if (inSection && shape.optional) optionalKeys.add(key);
    if (shape.kind === "object")
      for (const [name, field] of Object.entries(shape.fields)) walk(field, name, inSection);
    if (shape.kind === "array") walk(shape.element, key, inSection);
  };
  for (const { result } of Object.values(SHAPES)) walk(result, "result", false);
  for (const name of Object.keys(NULLABLE)) assert.ok(optionalKeys.has(name), name);
});

/*
 * The check sites' coverage (orchestrator 2's ruling (B) on the family report after Sol code r2). The claim: every
 * check site of these kinds in these modules (`MODULES`) has a relation row (`RELATIONS`) whose asserted reason is
 * that site's message, so the row fails when the site is weakened. The kinds:
 *   - a call of `span` (its third argument, the interval's label);
 *   - an object with `ok: false` (its `reason`);
 *   - `problems.push(…)` (its message);
 *   - `throw new MissingEvidence | ContradictoryEvidence | ReversedInterval | MalformedEvidence(…)` (its message).
 * The rule is "all occurrences equal the readable ones": every occurrence of `span`, `ok: false`, `problems.push` and
 * `throw` in a module's code (its comments and the text of its strings blanked) is one of the readable forms above, a
 * named import of `span`, a pass-through (`PASS_THROUGH`), `throw new Error(…)` (a defect of the kit or a live run's
 * failure, no evidence check) or a rethrow; any other occurrence fails, naming its file and line. A site is its
 * position: its file, its top-level declaration and its message. A message that several positions share, which no
 * reason can tell apart, is witnessed per position (`SHARED`), by the rows that reach that position or the position
 * whose check always precedes it. A message with little literal text (`WEAK`) is witnessed only by the rows named for
 * it. A site an earlier check always precedes (`IMPLIED`) has an ordering row that breaks both and expects the earlier
 * one's reason. A second claim covers absence (Sol final r1, F1): every occurrence of `nullable` (a call, or the
 * reader passed as a value), every `read(` call through such a value, and every `??` or `||` in these modules
 * (`absenceSites`, by position) has rows where its absence, in a context that requires the value, makes the cell
 * incomplete, or a stated reason the absence is permitted (`ABSENCE`). The limit: a check written in another
 * form (a bare comparison that throws, a new module) is outside both claims until its kind is added here.
 */
const MODULES = ["validate.mjs", "lib/measure.mjs", "scenarios/keep.mjs", "scenarios/taps.mjs"];
const PASS_THROUGH = new Set(["error.message", "...problems"]);
const EVIDENCE_ERRORS = [
  "MissingEvidence",
  "ContradictoryEvidence",
  "ReversedInterval",
  "MalformedEvidence",
];

/** `text` with its comments, and the text of its strings, templates and regular expressions, blanked; lines kept. */
function codeOf(text) {
  const out = [...text];
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const templates = [];
  let depth = 0;
  let last = "";
  let i = 0;
  const templateText = () => {
    const start = i;
    for (; i < text.length; i += 1) {
      if (text[i] === "\\") i += 1;
      else if (text[i] === "`") {
        blank(start, i);
        i += 1;
        last = "`";
        return;
      } else if (text[i] === "$" && text[i + 1] === "{") {
        blank(start, i);
        i += 2;
        templates.push(depth);
        depth = 0;
        last = "{";
        return;
      }
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const stop = text.indexOf("*/", i + 2) + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const start = i;
      for (i += 1; text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
      blank(start + 1, i);
      i += 1;
      last = c;
    } else if (c === "`") {
      i += 1;
      templateText();
    } else if (c === "/" && (last === "" || "(,=:[!&|?{};".includes(last))) {
      const start = i;
      let inClass = false;
      for (i += 1; text[i] !== "/" || inClass; i += 1)
        if (text[i] === "\\") i += 1;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
      blank(start + 1, i);
      for (i += 1; /[a-z]/u.test(text[i] ?? ""); i += 1);
      last = "/";
    } else if (c === "}" && depth === 0 && templates.length > 0) {
      depth = templates.pop();
      i += 1;
      templateText();
    } else {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      if (!/\s/u.test(c)) last = c;
      i += 1;
    }
  }
  return out.join("");
}

/** The top-level arguments of the call whose `(` is at `open` in `code`: `[from, to]` ranges, and the `)`'s index. */
function argumentsAt(code, open) {
  const ranges = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) {
      depth -= 1;
      if (depth === 0) {
        if (code.slice(from, i).trim() !== "") ranges.push([from, i]);
        return { ranges, close: i };
      }
    } else if (c === "," && depth === 1) {
      ranges.push([from, i]);
      from = i + 1;
    }
  }
  throw new Error(`no closing parenthesis for the call at ${open}`);
}

/**
 * A message expression's pattern, when the test can read it: a string literal, a template (each `${…}` any text), or
 * `<expression> ?? <literal>` (the literal is the site's own message). `null` otherwise.
 */
function messagePattern(source) {
  const text = source.trim();
  const fallback = /\?\?\s*("(?:[^"\\]|\\.)*"|`[^`]*`)$/u.exec(text);
  if (fallback !== null && !/^["'`]/u.test(text)) return messagePattern(fallback[1]);
  if (/^"(?:[^"\\]|\\.)*"$/u.test(text) || /^'(?:[^'\\]|\\.)*'$/u.test(text))
    return { parts: [text.slice(1, -1)], text };
  if (!/^`[\s\S]*`$/u.test(text) || codeOf(text).slice(1, -1).includes("`")) return null;
  const parts = [];
  let literal = "";
  for (let i = 1; i < text.length - 1; i += 1)
    if (text[i] === "$" && text[i + 1] === "{") {
      parts.push(literal);
      literal = "";
      const { close } = argumentsAt(codeOf(text).replaceAll("$", " "), i + 1);
      i = close;
    } else literal += text[i];
  parts.push(literal);
  return { parts, text };
}
const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Every check site in `MODULES`, and every occurrence of the kinds' words that is no readable site. */
function checkSites() {
  const sites = new Map();
  const unreadable = [];
  for (const file of MODULES) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const code = codeOf(text);
    const lineOf = (index) => text.slice(0, index).split("\n").length;
    const imports = [...code.matchAll(/import\s*\{[^}]*\}\s*from/gu)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    // Each site's position: its file and its top-level declaration (the function or constant that holds it).
    const declarations = [
      ...code.matchAll(
        /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gmu,
      ),
    ].map((m) => ({ index: m.index, name: m[1] ?? m[2] }));
    const declarationOf = (index) =>
      declarations.findLast((declaration) => declaration.index <= index)?.name ?? "(module)";
    const site = (kind, index, source) => {
      const pattern = messagePattern(source);
      if (pattern === null) {
        unreadable.push(`${file}:${lineOf(index)}: ${kind} with the message ${source.trim()}`);
        return;
      }
      const position = `${file} ${declarationOf(index)}`;
      const repeats = [...sites.values()].filter(
        (other) => other.position === position && other.text === pattern.text,
      ).length;
      const key = `${position} ${pattern.text}${repeats > 0 ? ` #${repeats + 1}` : ""}`;
      sites.set(key, {
        key,
        kind,
        position,
        regex: new RegExp(pattern.parts.map(escape).join(".+?"), "u"),
        literal: pattern.parts.join("").length,
        at: `${file}:${lineOf(index)}`,
        text: pattern.text,
      });
    };
    for (const m of code.matchAll(/\bspan\b/gu)) {
      if (imports.some(([from, to]) => m.index >= from && m.index < to)) continue;
      const open = /^\s*\(/u.exec(code.slice(m.index + 4));
      if (open === null) {
        unreadable.push(`${file}:${lineOf(m.index)}: span, not called`);
        continue;
      }
      const { ranges } = argumentsAt(code, m.index + 4 + open[0].length - 1);
      if (ranges.length !== 3)
        unreadable.push(`${file}:${lineOf(m.index)}: span with ${ranges.length} arguments`);
      else site("span", m.index, text.slice(...ranges[2]));
    }
    for (const m of code.matchAll(/\bok\s*:\s*false\b/gu)) {
      let open = m.index;
      for (let depth = 0; open >= 0; open -= 1)
        if (code[open] === "}") depth += 1;
        else if (code[open] === "{") {
          if (depth === 0) break;
          depth -= 1;
        }
      const { ranges } = argumentsAt(code, open);
      const reason = ranges.find(([from]) => /^\s*reason\s*:/u.test(code.slice(from)));
      if (reason === undefined)
        unreadable.push(`${file}:${lineOf(m.index)}: ok: false without a reason`);
      else
        site("ok: false", m.index, text.slice(reason[0], reason[1]).replace(/^\s*reason\s*:/u, ""));
    }
    for (const m of code.matchAll(/\bproblems\s*\.\s*push\s*\(/gu)) {
      const { ranges } = argumentsAt(code, m.index + m[0].length - 1);
      const source = ranges.length === 1 ? text.slice(...ranges[0]).trim() : "";
      if (PASS_THROUGH.has(source)) continue;
      site("problems.push", m.index, ranges.length === 1 ? source : "(not one argument)");
    }
    for (const m of code.matchAll(/\bthrow\b/gu)) {
      const after = code.slice(m.index + 5);
      // A kit defect or a live run's failure, and a rethrow of a caught error: no evidence check.
      if (/^\s*new\s+Error\s*\(/u.test(after) || /^\s*[\w$]+(?:\.[\w$]+)*\s*;/u.test(after))
        continue;
      const evidence = new RegExp(`^\\s*new\\s+(${EVIDENCE_ERRORS.join("|")})\\s*\\(`, "u").exec(
        after,
      );
      if (evidence === null) {
        unreadable.push(`${file}:${lineOf(m.index)}: a throw of another form`);
        continue;
      }
      const { ranges } = argumentsAt(code, m.index + 5 + evidence[0].length - 1);
      site(
        `throw ${evidence[1]}`,
        m.index,
        ranges.length > 0 ? text.slice(...ranges[0]) : "(none)",
      );
    }
  }
  return { sites: [...sites.values()], unreadable };
}

/**
 * Every read of a value that may be absent, and every default applied where one may be, in `MODULES`: each occurrence
 * of `nullable` (a call, or the reader passed as a value), each `read(` call through such a value, and each `??` and
 * `||` in a module's code (comments and string text blanked). Each is a position: its file, its
 * top-level declaration and its line's text (`#n` for a second on one line).
 */
function absenceSites() {
  const found = [];
  for (const file of MODULES) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const code = codeOf(text);
    const lines = text.split("\n");
    const declarations = [
      ...code.matchAll(
        /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gmu,
      ),
    ].map((m) => ({ index: m.index, name: m[1] ?? m[2] }));
    const declarationOf = (index) =>
      declarations.findLast((declaration) => declaration.index <= index)?.name ?? "(module)";
    const imports = [...code.matchAll(/import\s*\{[^}]*\}\s*from/gu)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    // `nullable` called, `nullable` passed as a value (its reader's alias), a `read(` call through such an alias, `??`
    // and `||`.
    for (const m of code.matchAll(/\bnullable\b(?:\s*\()?|\bread\s*\(|\?\?|\|\|/gu)) {
      if (imports.some(([from, to]) => m.index >= from && m.index < to)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const kind = m[0].startsWith("nullable")
        ? m[0].endsWith("(")
          ? "nullable"
          : "nullable as a value"
        : m[0].startsWith("read")
          ? "read"
          : m[0];
      const base = `${file} ${declarationOf(m.index)} ${kind}: ${lines[line - 1].trim()}`;
      const repeats = found.filter(
        (site) => site.key === base || site.key.startsWith(`${base} #`),
      ).length;
      found.push({
        key: repeats > 0 ? `${base} #${repeats + 1}` : base,
        at: `${file}:${line}`,
        kind,
      });
    }
  }
  return found;
}

/**
 * Every read of a value that may be absent and every default where one may be (`absenceSites`), by position: the
 * rows where its absence, in a context that requires the value, makes the cell incomplete, or why the absence is
 * permitted (Sol final r1, F1, and orchestrator 2's ruling).
 */
const ABSENCE = {
  'validate.mjs framesComplete nullable: gate[list].filter((record) => nullable(record, "frame") !== null).map((record) => record.t),':
    { permitted: "the drawn records' times: an absent frame is the next site's to judge" },
  'validate.mjs framesComplete nullable: if (nullable(record, "frame") === null && record.t < last)':
    {
      rows: [
        "turn: a control state's frame lost before a later one (Sol code r8)",
        "turn: a control state's frame deleted before a later one",
        "turn: a row update's frame lost before a later one (Sol code r8)",
      ],
    },
  "validate.mjs validateSample read: const found = read(sample);": {
    permitted:
      "a field's reader (`NUMBERS`), no record read: an absent result fails a required field",
  },
  'lib/measure.mjs turnSettlement read: const composer = read(state, "composer");': {
    permitted: "the page shows no composer",
  },
  'lib/measure.mjs turnSettlement read: read(state, "start") === null &&': {
    permitted: "no start button is shown",
  },
  'lib/measure.mjs turnSettlement read: read(state, "control") !== beforeControl &&': {
    rows: ["probe: a page's state with buttons without its controls' serial"],
  },
  'lib/measure.mjs turnSettlement read: read(state, "frame") !== null,': {
    // A frame lost before a later drawn record is refused first (`framesComplete`, F7); one still pending settles nothing.
    rows: [
      "turn: a control state's frame lost before a later one (Sol code r8)",
      "turn: a control state's frame deleted before a later one",
      "turn: a row update's frame lost before a later one (Sol code r8)",
    ],
  },
  'lib/measure.mjs turnSettlement read: .map((state) => ({ by: "control", t: state.t, at: read(state, "frame") })),':
    { permitted: "the candidates were filtered to those holding the value just above" },
  'lib/measure.mjs turnSettlement read: .filter((row) => row.speaker !== "user" && row.t > after && read(row, "shownFrame") !== null)':
    {
      permitted:
        "a row not yet drawn with a positive opacity is not yet shown, so it settles nothing (H's rule)",
    },
  'lib/measure.mjs turnSettlement read: .map((row) => ({ by: "row", t: row.t, at: read(row, "shownFrame") })),':
    { permitted: "the candidates were filtered to those holding the value just above" },
  'lib/measure.mjs turnSettlement read: const shown = row === undefined ? null : read(row, "shownFrame");':
    { permitted: "a row not yet shown before the input: its update settles nothing" },
  'lib/measure.mjs turnSettlement read: read(change, "frame") !== null': {
    // A frame lost before a later drawn record is refused first (`framesComplete`, F7); one still pending settles nothing.
    rows: [
      "turn: a control state's frame lost before a later one (Sol code r8)",
      "turn: a control state's frame deleted before a later one",
      "turn: a row update's frame lost before a later one (Sol code r8)",
    ],
  },
  'lib/measure.mjs turnSettlement read: .map((change) => ({ by: "row update", t: change.t, at: read(change, "frame") })),':
    { permitted: "the candidates were filtered to those holding the value just above" },
  'lib/measure.mjs turnTimes nullable as a value: const { submission, event } = turnSettlement(gate, sentAt, nullable(before, "control"), nullable);':
    {
      permitted:
        "`turnSettlement`'s reader: its reads through `read` are listed as sites of their own",
    },
  'validate.mjs stateComplete nullable: if (state.buttons.length > 0 && nullable(state, "control") === null)':
    {
      rows: [
        "turn: the state before without its controls' serial (Sol code r7)",
        "turn: the state before with its controls' serial deleted",
        "probe: a page's state with buttons without its controls' serial",
      ],
    },
  'validate.mjs sessionTiming nullable: if (nullable(turn, "sentAt") !== null)': {
    permitted:
      'a turn the driver could not send has no state before it; its absent send time fails the turn ("session: a turn without its records")',
  },
  'validate.mjs transactionsComplete nullable: const end = nullable(transaction, "end");': {
    rows: [
      "keep: a transaction with an outcome has its end",
      "keep: an ended transaction has its outcome",
    ],
  },
  'validate.mjs transactionsComplete nullable: const outcome = nullable(transaction, "outcome");': {
    rows: [
      "keep: a transaction with an outcome has its end",
      "keep: an ended transaction has its outcome",
    ],
  },
  'validate.mjs transactionsComplete nullable: if (nullable(put, "scope") === null)': {
    rows: ["keep: a committed session put without its scope"],
  },
  'validate.mjs transactionsComplete nullable: if (nullable(put, "observedMs") === null)': {
    rows: [
      "keep: a committed session put without its observation (Sol final r1)",
      "session: a page's committed session put without its observation",
    ],
  },
  'validate.mjs sessionTiming ??: if (save?.ok !== true) problems.push(`first save: ${save?.reason ?? "no playable cold page"}`);':
    {
      permitted:
        "the message of a first save already failed: its absence is reported, never a value",
    },
  'validate.mjs sessionTiming ||: if (cell.backend === "worker" && (worker === null || worker.readyMs === null))':
    { rows: ["Worker start: ready present"] },
  'validate.mjs sessionTiming nullable: nullable(turn, "sentAt") === null': {
    rows: ["session: a turn without its records"],
  },
  'validate.mjs sessionTiming nullable: ? { ok: false, reason: nullable(turn, "reason") ?? "no records of the turn" }':
    { rows: ["session: a turn without its records"] },
  'validate.mjs sessionTiming ??: ? { ok: false, reason: nullable(turn, "reason") ?? "no records of the turn" }':
    { rows: ["session: a turn without its records"] },
  'validate.mjs sessionTiming nullable: : turnTimes(repeat, turn.sentAt, turn.before, nullable(turn, "end")),':
    { rows: ["turn: neither settled nor ended"] },
  'validate.mjs bridgeTiming nullable: const reply = nullable(request, "replyAt");': {
    rows: ["bridge: a request without its reply"],
  },
  "validate.mjs keepTiming ??: return { outcome: derived.outcome, hiddenToCommitMs: derived.hiddenToCommitMs ?? null };":
    {
      permitted: "no capture while hidden: the interval does not exist, and its field is optional",
    },
  'validate.mjs BYTES ??: (r.bytes?.requests ?? []).filter((q) => q.target !== "page" && /engine/u.test(q.target))':
    {
      permitted:
        "the field applies only on a worker build on a CDP engine, where the byte part reads the byte account strictly",
    },
  "validate.mjs BYTES ||: .length || null,": {
    rows: ["session: a worker build without its engine Worker's requests"],
  },
  'validate.mjs KEEP_FIELDS ||: (r) => (r.outcome === "completed" || r.outcome === "durable after 1 s" ? 1 : 0),':
    { permitted: "a condition, no default" },
  "validate.mjs NUMBERS ??: (r) => summarize((r.turns ?? []).map((t) => t.feedbackMs)).median,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => summarize((r.turns ?? []).map((t) => t.settledMs)).median,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => (r.turns ?? []).filter((t) => t.ok !== false).length,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => (r.turns ?? []).filter((t) => t.end).length,": {
    permitted: "the part's sample always holds its turns; a failed part is never read",
  },
  "validate.mjs NUMBERS ??: (r) => summarize((r.diagnostics?.turns ?? []).filter(Boolean).map((t) => t.length)).median,":
    { permitted: "the part's sample always holds its turns; a failed part is never read" },
  "validate.mjs NUMBERS ??: (r.diagnostics?.gaps?.cold?.length ?? NaN) + (r.diagnostics?.gaps?.repeat?.length ?? NaN),":
    { rows: ["instrumented: the probe's gaps absent"] },
  "validate.mjs NUMBERS ??: (r.diagnostics?.gaps?.cold?.length ?? NaN) + (r.diagnostics?.gaps?.repeat?.length ?? NaN), #2":
    { rows: ["instrumented: the probe's gaps absent"] },
  "validate.mjs bytesOf ||: if (sample.bytes === null || sample.bytes === undefined) return null;":
    { permitted: "the byte fields apply only where the byte part reads the byte account strictly" },
  "validate.mjs bytesOf ||: (phase === null || inPhase(bytes, request, phase)),": {
    permitted: "a condition: no phase means every request",
  },
  'validate.mjs bytesOf nullable: nullable(request, "failed") !== null ? sum : sum + (request.finished ? request[field] : NaN),':
    { rows: ["byte account: every request finished or failed"] },
  'validate.mjs heapAt nullable: (worker) => worker.engine && nullable(worker, "usedBytes") !== null,':
    { rows: ["heap: the engine Worker's reading absent"] },
  'validate.mjs request nullable: const request = (sample, op) => sample.requests.find((entry) => nullable(entry, "op") === op);':
    { permitted: "a lookup key: a bridge request's op is required by its shape" },
  'validate.mjs rtt nullable: const reply = nullable(found, "replyAt");': {
    rows: ["bridge: a request without its reply"],
  },
  'validate.mjs UNITS ||: ["boolean", { cell: "timing", domain: (v) => v === 0 || v === 1, what: "neither 0 nor 1" }],':
    { permitted: "a condition, no default" },
  "validate.mjs AGGREGATE ??: if (!Object.hasOwn(PARTS[scenario] ?? {}, part))": {
    permitted: "the table of parts, read at load: no record",
  },
  "validate.mjs runParts ??: ...(part.after ?? []).flatMap((before) => done[before].problems),": {
    permitted: "the table of parts: no record",
  },
  "validate.mjs validateSample ??: const out = (cells[cellOf(field)] ??= { values: [], problems: [] });":
    { permitted: "the cells' accumulator: no record" },
  "validate.mjs validateSample ||: if (found === null || found === undefined) {": {
    rows: ["a required field without a value"],
  },
  'lib/measure.mjs answerable nullable: const composer = nullable(state, "composer");': {
    permitted: "the page shows no composer",
  },
  'lib/measure.mjs answerable nullable: nullable(state, "start") === null &&': {
    permitted: "no start button is shown",
  },
  "lib/measure.mjs answerable ||: (state.buttons.some((button) => button.enabled) ||": {
    permitted: "a condition, no default",
  },
  'lib/measure.mjs frameOf nullable: const frame = nullable(record, "frame");': {
    rows: [
      "playable: Start enabled has no frame",
      "playable: the first control has no frame",
      "turn: no feedback frame",
    ],
  },
  "lib/measure.mjs firstControlAfter ??: return gate.states.find((state) => state.t > after && answerable(state)) ?? null;":
    { rows: ["playable: no control after the input"] },
  "lib/measure.mjs inputAfter ??: gate.inputs.find((input) => input.t >= after && input.trusted && types.includes(input.type)) ??":
    { rows: ["playable: no trusted input after Start"] },
  'lib/measure.mjs playable nullable: const start = nullable(state, "start");': {
    rows: ["playable: Start never shown enabled"],
  },
  "lib/measure.mjs turnSettlement ??: read = (record, key) => record[key] ?? null,": {
    permitted: "the page's own read in `SETTLED`; the derivations pass `nullable` (`turnTimes`)",
  },
  'lib/measure.mjs turnSettlement ||: (input.type === "pointerdown" || input.type === "touchstart" || input.type === "keydown"),':
    { permitted: "a condition, no default" },
  'lib/measure.mjs turnSettlement ||: (input.type === "pointerdown" || input.type === "touchstart" || input.type === "keydown"), #2':
    { permitted: "a condition, no default" },
  "lib/measure.mjs turnSettlement ??: ) ?? null;": { rows: ["turn: no input recorded"] },
  "lib/measure.mjs turnSettlement ||: (state.buttons.some((button) => button.enabled) ||": {
    permitted: "a condition, no default",
  },
  "lib/measure.mjs turnSettlement ??: const event = events[0] ?? null;": {
    rows: ["turn: neither settled nor ended"],
  },
  "lib/measure.mjs turnSettlement ??: return { submission, settledAt: event?.at ?? null, by: event?.by ?? null, event };":
    { permitted: "the page's wait reads `settledAt`; `turnTimes` reads the event itself" },
  "lib/measure.mjs turnSettlement ??: return { submission, settledAt: event?.at ?? null, by: event?.by ?? null, event }; #2":
    { permitted: "the page's wait reads `settledAt`; `turnTimes` reads the event itself" },
  'lib/measure.mjs turnTimes nullable: const { submission, event } = turnSettlement(gate, sentAt, nullable(before, "control"), nullable);':
    {
      // A state with buttons must hold its serial (`stateComplete`, F6); one without buttons, such as a state still
      // showing Start, has no controls root (the complete variant "a turn sent from a state that still showed Start").
      rows: [
        "turn: the state before without its controls' serial (Sol code r7)",
        "turn: the state before with its controls' serial deleted",
      ],
    },
  'lib/measure.mjs turnTimes nullable: nullable(record, "shownFrame") !== null,': {
    permitted: "a row not yet drawn; the first row's time is no reported field",
  },
  'lib/measure.mjs publishesAfter nullable: nullable(transaction, "outcome") === "complete" &&': {
    permitted: "live code only, which no derivation calls",
  },
  'lib/measure.mjs publishesAfter ||: (put) => put.store === "sessions" && (scope === null || nullable(put, "scope") === scope),':
    { permitted: "live code only, which no derivation calls" },
  'lib/measure.mjs publishesAfter nullable: (put) => put.store === "sessions" && (scope === null || nullable(put, "scope") === scope),':
    { permitted: "live code only, which no derivation calls" },
  'lib/measure.mjs firstSave nullable: const outcome = nullable(save, "outcome");': {
    rows: ["first save: still open"],
  },
  'lib/measure.mjs firstSave ??: return { ok: false, outcome, reason: `the first save ${outcome ?? "never ended"}` };':
    { rows: ["first save: still open"] },
  'lib/measure.mjs firstSave nullable: const longTasks = nullable(gate, "longTasks");': {
    rows: ["first save: long tasks absent where the engine reports them"],
  },
  'lib/measure.mjs firstSave nullable: scope: nullable(session, "scope"),': {
    permitted: "a scope the first save does not report",
  },
  'lib/measure.mjs firstSave nullable: planScope: nullable(plan, "scope"),': {
    permitted: "a scope the first save does not report",
  },
  "lib/measure.mjs firstSave ||: blocked === null || blocked.length === 0": {
    permitted: "the longest long task: no reported field",
  },
  'lib/measure.mjs firstSave nullable: longTasksUnavailable: nullable(gate, "longTasksUnavailable"),':
    { permitted: "the reason a browser gives: no reported field" },
  'lib/measure.mjs workerStart nullable: const ready = nullable(worker, "ready");': {
    rows: ["Worker start: ready present"],
  },
  'lib/measure.mjs requestsOf nullable: .filter((entry) => entry.dir === "reply" && nullable(entry, "id") !== null)':
    { permitted: "a message outside a request (the Worker's ready) has no ID" },
  'lib/measure.mjs requestsOf nullable: .filter((entry) => entry.dir === "post" && nullable(entry, "id") !== null)':
    {
      // Every post is a request, and `postsComplete` refuses one without its ID before this filter runs (F5).
      rows: [
        "instrumented: a posted operation without its request ID",
        "instrumented: a posted operation with its request ID deleted",
      ],
    },
  'validate.mjs postsComplete nullable: if (entry.dir === "post" && nullable(entry, "id") === null)':
    {
      rows: [
        "instrumented: a posted operation without its request ID",
        "instrumented: a posted operation with its request ID deleted",
      ],
    },
  "lib/measure.mjs requestsOf ??: const reply = replies.get(post.id) ?? null;": {
    rows: ["instrumented: the start request's reply"],
  },
  'lib/measure.mjs requestsOf nullable: op: nullable(post, "op"),': {
    permitted:
      "a post without an op is no request the report names; a named op's missing reply fails its field",
  },
  'lib/measure.mjs requestsOf nullable: reply === null ? null : span(post.at, reply.at, `${nullable(post, "op")}\'s round trip`),':
    { permitted: "the label of a span only" },
  'lib/measure.mjs requestsOf nullable: replySize: reply === null ? null : nullable(reply, "size"),':
    { permitted: "only captureKeep's reply has a size, and its field is optional" },
  'lib/measure.mjs workerSideOf nullable: (entry) => entry.dir === "request" && nullable(entry, "id") === request.id,':
    { permitted: "a message outside a request (the Worker's ready) has no ID" },
  'lib/measure.mjs workerSideOf nullable: (entry) => entry.dir === "reply" && nullable(entry, "id") === request.id,':
    { permitted: "a message outside a request (the Worker's ready) has no ID" },
  "lib/measure.mjs workerSideOf ||: receipt === undefined || reply === undefined": {
    rows: ["bridge: the Worker's reply absent"],
  },
  'scenarios/keep.mjs storedObservedMs ??: read.result?.snapshotJson ?? "",': {
    permitted: "live code only, which no derivation calls",
  },
  'scenarios/keep.mjs hiddenCapture ||: (event.type === "resume" ||': {
    permitted: "a condition, no default",
  },
  'scenarios/keep.mjs hiddenCapture nullable: const end = (transaction) => nullable(transaction, "end");':
    {
      permitted:
        "an open transaction committed nothing; an end without its outcome is refused first (`transactionsComplete`)",
    },
  'scenarios/keep.mjs hiddenCapture nullable: transaction.puts.some((put) => put.store === "sessions" && nullable(put, "scope") === scope),':
    { rows: ["keep: a committed session put without its scope"] },
  'scenarios/keep.mjs hiddenCapture nullable: nullable(transaction, "outcome") === "complete" &&': {
    permitted:
      "an open transaction committed nothing; an end without its outcome is refused first (`transactionsComplete`)",
  },
  'scenarios/keep.mjs hiddenCapture nullable: (put) => put.store === "sessions" && (nullable(put, "observedMs") ?? -Infinity) > baselineMs,':
    { rows: ["keep: a committed session put without its observation (Sol final r1)"] },
  'scenarios/keep.mjs hiddenCapture ??: (put) => put.store === "sessions" && (nullable(put, "observedMs") ?? -Infinity) > baselineMs,':
    { rows: ["keep: a committed session put without its observation (Sol final r1)"] },
  'scenarios/keep.mjs hiddenCapture nullable: const outcome = nullable(transaction, "outcome");': {
    permitted:
      "an open transaction committed nothing; an end without its outcome is refused first (`transactionsComplete`)",
  },
  'scenarios/keep.mjs hiddenCapture ||: return (outcome === "abort" || outcome === "error") && end(transaction) <= boundary;':
    { permitted: "a condition, no default" },
  'scenarios/keep.mjs keepOutcome nullable: const storedMs = nullable(record, "storedMs");': {
    permitted: "the store held no snapshot: an observed negative (design r1, C10)",
  },
  'scenarios/keep.mjs keepOutcome nullable: const found = hiddenCapture(record, hiddenAt, nullable(record, "scope"), record.baselineMs);':
    { rows: ["keep: the trial without its scope"] },
  "scenarios/taps.mjs calibrate ||: if (element === null || element.closest(interactive) !== null) return false;":
    { permitted: "live code only, which no derivation calls" },
  "scenarios/taps.mjs tapCounts ||: if (!Array.isArray(ledger) || !Array.isArray(deliveries) || !(window?.toMs >= window?.fromMs))":
    {
      permitted:
        "the shapes make both lists arrays, and the taps window's span orders the window first (`IMPLIED`)",
    },
  "scenarios/taps.mjs tapCounts ||: if (!Array.isArray(ledger) || !Array.isArray(deliveries) || !(window?.toMs >= window?.fromMs)) #2":
    {
      permitted:
        "the shapes make both lists arrays, and the taps window's span orders the window first (`IMPLIED`)",
    },
  "scenarios/taps.mjs tapCounts ||: sent === undefined ||": {
    rows: ["taps: a delivery no send has"],
  },
  "scenarios/taps.mjs tapCounts ||: Math.abs(tap.x - sent.x) > TAP_SPACING / 2 ||": {
    rows: ["taps: a tap off its grid point"],
  },
};

test("every absence read and default in the derivation modules is witnessed or permitted, by position", () => {
  const rows = new Set(RELATIONS.map(([name]) => name));
  const keys = absenceSites().map((site) => site.key);
  assert.deepEqual(
    keys.filter((key) => !Object.hasOwn(ABSENCE, key)),
    [],
    "absence sites without an entry",
  );
  assert.deepEqual(
    Object.keys(ABSENCE).filter((key) => !keys.includes(key)),
    [],
    "entries without their site",
  );
  for (const [key, entry] of Object.entries(ABSENCE))
    if (entry.rows !== undefined)
      for (const name of entry.rows) assert.ok(rows.has(name), `${key}: no row ${name}`);
    else assert.ok(entry.permitted.length > 0, key);
});

/**
 * The sites whose message has little literal text, witnessed only by the rows named here (their own reasons), so a
 * loose pattern cannot be matched by another site's message.
 */
const WEAK = {
  "`the sends ${index - 1} → ${index}`": ["taps: the sends in order"],
  '"the taps window"': ["taps: the window"],
  '`first save: ${save?.reason ?? "no playable cold page"}`': ["first save: no publish"],
  '"a turn"': ["session: no turn"],
  "`turn ${index}: ${turn.reason}`": ["session: a turn without its records"],
  "`${label} (${unit})`": ["a required field without a value"],
  "`${label}: ${found} is ${what}`": ["byte account: every request finished or failed"],
  '`the first save ${outcome ?? "never ended"}`': ["first save: not complete"],
  '"no input recorded"': ["turn: no input recorded"],
};

/**
 * The positions that share a message, each with the rows that reach it (a scenario whose parts run that declaration)
 * or the position whose check of the same records always precedes it.
 */
const SHARED = {
  "validate.mjs bridgeTiming `${request.op}'s round trip`": {
    rows: ["bridge: a request → its reply"],
  },
  // `rtt` reads the requests `bridgeTiming` has ordered.
  "validate.mjs rtt `${op}'s round trip`": {
    impliedBy: "validate.mjs bridgeTiming `${request.op}'s round trip`",
  },
  'lib/measure.mjs requestsOf `${nullable(post, "op")}\'s round trip`': {
    rows: ["instrumented: a post → its reply"],
  },
  "validate.mjs sessionTiming `cold playable: ${coldPlayable.reason}`": {
    rows: ["playable: Start enabled has no frame"],
  },
  "validate.mjs PARTS `cold playable: ${cold.reason}`": {
    rows: ["aa: Start enabled has no frame"],
  },
};

/**
 * The sites an earlier check of the same records always precedes, so that no row can reach them alone: each with that
 * earlier site (`by`) and its ordering row (`row`), which breaks both checks and expects the earlier one's reason, so
 * a reorder fails a test (Sol final r1, F3). Weakening an implied site lets no wrong value through.
 */
const IMPLIED = {
  // `between` reads the marks `bridgeTiming` has ordered.
  "`the bridge page's ${from} → ${to}`": {
    by: '"the bridge page\'s Worker start"',
    row: "bridge: Worker construction → ready",
  },
  // The first save is the first transaction to start after the press, and every transaction is ordered first.
  "\"Start's input → the first save's commit\"": {
    by: "`${where} transaction ${index}: its start → its end`",
    row: "first save: a commit before the press (ordering)",
  },
  '"the first save\'s transaction"': {
    by: "`${where} transaction ${index}: its start → its end`",
    row: "first save: its start → its commit",
  },
  // A capture counts only when it started after the hiding (`hiddenCapture`), and every transaction is ordered first.
  '"hidden → the commit"': {
    by: "`${where} transaction ${index}: its start → its end`",
    row: "keep: a commit before the hiding (ordering)",
  },
  // `tapCounts` refuses only an unordered window, which the taps window's span refuses first.
  '"the send ledger, the deliveries and the window"': {
    by: '"the taps window"',
    row: "taps: the window",
  },
};

test("every check site in the derivation modules is readable and has a row that fails when it is weakened", () => {
  const { sites, unreadable } = checkSites();
  assert.deepEqual(unreadable, [], "occurrences that are no readable site");
  const rows = new Map(RELATIONS.map((row) => [row[0], row]));
  const byKey = new Map(sites.map((site) => [site.key, site]));
  const sharing = (site) => sites.filter((other) => other.regex.source === site.regex.source);
  const texts = new Set(sites.map((site) => site.text));
  const implied = Object.values(IMPLIED).map(({ by }) => by);
  for (const text of [...Object.keys(WEAK), ...Object.keys(IMPLIED), ...implied])
    assert.ok(texts.has(text), `no site ${text}`);
  for (const [key, entry] of Object.entries(SHARED)) {
    assert.ok(byKey.has(key), `no site ${key}`);
    assert.ok(sharing(byKey.get(key)).length > 1, `${key} shares its message with no other site`);
    if (entry.impliedBy !== undefined)
      assert.ok(byKey.has(entry.impliedBy), `no site ${entry.impliedBy}`);
  }
  const named = (site, names) =>
    names.length > 0 && names.every((name) => rows.has(name) && site.regex.test(rows.get(name)[4]));
  const witnessed = (site) => {
    if (sharing(site).length > 1) {
      const entry = SHARED[site.key];
      if (entry === undefined) return false;
      return entry.impliedBy !== undefined
        ? witnessed(byKey.get(entry.impliedBy))
        : named(site, entry.rows);
    }
    if (Object.hasOwn(IMPLIED, site.text)) {
      const { by, row } = IMPLIED[site.text];
      const earlier = sites.find((other) => other.text === by);
      return witnessed(earlier) && rows.has(row) && earlier.regex.test(rows.get(row)[4]);
    }
    if (Object.hasOwn(WEAK, site.text)) return named(site, WEAK[site.text]);
    return site.literal >= 16 && RELATIONS.some((row) => site.regex.test(row[4]));
  };
  assert.deepEqual(
    sites.filter((site) => !witnessed(site)).map((site) => `${site.at}: ${site.kind} ${site.key}`),
    [],
    "check sites without a row",
  );
  assert.ok(sites.length > 50, `only ${sites.length} sites`);
});
