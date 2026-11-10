// The kit's validation boundary (#2122): rows parsed once into validated copies (`lib/records.mjs`,
// `lib/row-shapes.mjs`), read through the strict reader, each scenario's parts and relations (`validate.mjs`). The
// fixtures hold every declared leaf between them; the families mutate them, and every expected outcome is written here.
import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "./report.mjs";
import { isParsedRow, parseRow, sectionsOf } from "./lib/records.mjs";
import { SHAPES } from "./lib/row-shapes.mjs";
import { NULLABLE, strictRecord } from "./lib/evidence.mjs";
import { cellOf, NUMBERS, validateSample } from "./validate.mjs";

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
 * Family (b): the order relations and evidence rules the validation checks, written here: each with the fixture it
 * applies to, the change that reverses or removes its evidence, the cells that change must fail, and the reason each
 * of them must give.
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
    (r) => (r.result.probe.cold.states[1].frame = 554),
    ["counts", "timing"],
    "the first control: its event → its frame",
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
    "first save: the press → its commit",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].end = 550),
    ["counts", "timing"],
    "Start's input → the first save's commit",
  ],
  [
    "first save: its start → its commit",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].end = 599),
    ["counts", "timing"],
    "the first save's transaction",
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
    "its cached beforeStartEnabled (false) is not its start",
  ],
  [
    // An open request has no length: its served bytes are no count, which the output domain refuses.
    "byte account: every request finished or failed",
    "session chromium main",
    (r) => Object.assign(r.result.bytes.requests[0], { finished: false, encodedBytes: null }),
    ["counts"],
    "is no safe integer ≥ 0",
  ],
  [
    "probe records: none dropped",
    "session chromium main",
    (r) => (r.result.probe.repeat.dropped = 1),
    ["counts", "timing"],
    "1 probe records dropped",
  ],
  [
    "instrumented: a post → its reply",
    "sessionInstrumented chromium worker",
    (r) => (r.result.diagnostics.bridgeLogs.cold[1].at = 519),
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
    "a transaction's start → its end",
  ],
  [
    "keep: the page reported hidden (R5-02)",
    "keepHandler chromium",
    (r) => (r.result.lifecycle = [r.result.lifecycle[1]]),
    ["timing"],
    "a visibilitychange to hidden",
  ],
  [
    "keep: the cached outcome",
    "keepHandler chromium",
    (r) => (r.result.outcome = "aborted"),
    ["timing"],
    "the recorded outcome (aborted)",
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
    "the recorded outcome (not durable after 1 s)",
  ],
  [
    "demo: the cached pass",
    "demo chromium",
    (r) => (r.result.ok = false),
    ["counts", "timing"],
    "the recorded ok (false)",
  ],
  [
    "smoke: the cached pass against the exit (R6)",
    "delayedSmoke chromium",
    (r) => (r.result.exit = 1),
    ["timing"],
    "the recorded ok (true)",
  ],
  [
    "a sample that must complete and failed",
    "bridge chromium main",
    (r) => (r.ok = false),
    ["counts", "timing"],
    "the sample failed",
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
  "enabled → its input": ["playable: Start enabled → its input"],
  "Worker: construction → ready": [
    "Worker start: construction → ready",
    "bridge: Worker construction → ready",
  ],
  "first save: Start's input → commit": ["first save: the press → its commit"],
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
  for (const [what, base, change, failing, reason] of RELATIONS) {
    const fixture = clone(BASES[base]);
    change(fixture);
    const cells = cellsOf(fixture);
    assert.deepEqual(failingCells(cells), failing, what);
    for (const name of failing)
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
