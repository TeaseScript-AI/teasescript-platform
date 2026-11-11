// The kit's validation boundary (#2122): rows parsed once into validated copies (`lib/records.mjs`,
// `lib/row-shapes.mjs`), read through the strict reader, each scenario's parts and relations (`validate.mjs`). The
// fixtures (`fixtures.mjs`) hold every declared leaf between them; the families mutate them, and every expected outcome
// is written there, in `relations.mjs`, or here.
import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "./report.mjs";
import { isParsedRow, parseRow, sectionsOf } from "./lib/records.mjs";
import { cellName } from "./cells.mjs";
import { SHAPES } from "./lib/row-shapes.mjs";
import { NULLABLE, strictRecord } from "./lib/evidence.mjs";
import { cellOf, isValidated, NUMBERS, validateSample } from "./validate.mjs";
import { axes, BASES, cellsOf, clone, failingCells, VARIANTS } from "./fixtures.mjs";
import { FIELD_RELATIONS, RELATIONS } from "./relations.mjs";

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
  keys: { timing: ["counts", "timing"] },
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
