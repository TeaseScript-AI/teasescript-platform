// A typed parse's or load's expected type and contract, the core's own answer at the call, and the structure its
// store's check keeps (S7's review rounds).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan, TypeCheckPlan } from "../../../src/plan/model.js";
import { validateInstructionPlan } from "../../../src/plan/validation.js";
import type { InterpreterEvent } from "../../../src/runtime/events.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { type CompactRecord } from "../../helpers/type-core-records.js";
import {
  OPTIONS,
  decision,
  typeText,
  contentOf,
  candidatePlan,
  summary,
  runWith,
  halted,
  failed,
  at,
  object,
  ran,
  planNodes,
  stored,
  listOf,
  bound,
} from "../../helpers/type-core/type-core-discharge-runtime-setup.js";

/** A plan's checked stores, as `target type`: the `let`s and assignments that check what they store. */
function checkedStores(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.typeCheck !== undefined
      ? [`${instruction.typeCheck.place} ${typeText(instruction.typeCheck.type)}`]
      : [],
  );
}

test("a store's check, a parse's expected type and a fallback's check keep the structure the core decided, in three layers, in both orders (S7 review r1 B1, B2, B4, r2 B1, B2)", () => {
  // a record stored whole from host data: its boundary validates the decided fields (C9 at the record level, A7)
  const whole = 'let p = {stats: {n: 1}}\np = hostValue\nsay p.stats.n\nsay "AFTER"\nexit\n';
  assert.ok(
    decision(whole).checks.includes(`copy-type p [object] boundary @${at(whole, "hostValue")}`),
  );
  const store = candidatePlan(whole);
  assert.deepEqual(checkedStores(store), ["'p' {stats: {n: integer}}"]);
  assert.deepEqual(
    ran(runWith(store, object({ stats: object({ n: 3 }) }))),
    halted(["3", "AFTER"]),
  );
  assert.deepEqual(
    ran(runWith(store, object({ stats: object({ n: "bad" }) }))),
    failed(`TSR058@${at(whole, "hostValue")}`),
  );
  // a nested object default gives its structure at every depth, on both lowerings
  for (const files of ["", ", files: false"]) {
    const named = `let p = fromJson(hostValue, default: {stats: {count: 0}}${files})\nsay p.stats.count\nexit\n`;
    const parse = at(named, `fromJson(hostValue, default: {stats: {count: 0}}${files})`);
    assert.ok(decision(named).checks.includes(`copy-type p [object] boundary @${parse}`));
    const plan = candidatePlan(named);
    assert.ok(
      contentOf(plan).some((entry) => entry.endsWith(`@${parse} {stats: {count: integer}}`)),
      JSON.stringify(contentOf(plan)),
    );
    assert.deepEqual(ran(runWith(plan, '{"stats": {"count": 3}}')), halted(["3"]));
    assert.deepEqual(
      ran(runWith(plan, '{"stats": {"count": "bad"}}')),
      halted(["0"], [`TSW020@${parse}`]),
    );
  }
  // a fallback's elements: C10 at the fallback's element depth checks the selected list where it is selected, a null
  // element allowed as C10 allows it
  const nested =
    'let xs = [[1], null][1]\nlet n = (xs otherwise [hostValue, 2])[1]\nsay n\nsay "AFTER"\nexit\n';
  const fallback = at(nested, "[hostValue, 2]");
  assert.ok(
    decision(nested).checks.includes(
      `copy-type [hostValue, 2].element [integer, number] @${fallback}`,
    ),
  );
  const checked = candidatePlan(nested);
  assert.ok(
    contentOf(checked).includes(
      `fallbackCheck binary@${at(nested, "xs otherwise [hostValue, 2]")} list<integer|number|null>`,
    ),
    JSON.stringify(contentOf(checked)),
  );
  assert.deepEqual(ran(runWith(checked, 3)), halted(["2", "AFTER"]));
  assert.deepEqual(ran(runWith(checked, null)), halted(["2", "AFTER"]));
  assert.deepEqual(ran(runWith(checked, "bad")), failed(`TSR058@${fallback}`));
  // the written type of the place a parse lands in directly, through a literal's elements and a get's default,
  // nullable as written: the core's own answer at the call (its kinds possible, F18)
  for (const [source, json, expected, said] of [
    [
      "let xs: number[] = [fromJson(hostValue, default: 0, files: false)]\nsay xs[0]\nexit\n",
      "1.5",
      "number",
      "1.5",
    ],
    [
      "let a: number[] = [[1].get(2, default: fromJson(hostValue, default: 0, files: false))]\nsay a[0]\nexit\n",
      "1.5",
      "number",
      "1.5",
    ],
    [
      "let n: integer? = fromJson(hostValue, default: 0, files: false)\nsay n\nexit\n",
      "null",
      "integer|null",
      "null",
    ],
  ] as const) {
    const call = at(source, "fromJson(hostValue, default: 0, files: false)");
    assert.ok(
      decision(source).checks.some((check) => check.endsWith(`boundary @${call}`)),
      source,
    );
    const plan = candidatePlan(source);
    assert.deepEqual(contentOf(plan), [`expected call@${call} ${expected}`], source);
    assert.deepEqual(ran(runWith(plan, json)), halted([said]), source);
  }
});

test("a typed parse's known value is the one its run gets: a known bad count is still the kept check's error (S7 review r2 B4)", () => {
  // JSON that fits the expected type keeps its value for the kept count check; JSON that does not gives the default
  assert.deepEqual(
    compileSourceWithBackend(
      'repeat fromJson("-1", default: 0, files: false) { say "BODY" }\nsay "AFTER"\nexit\n',
      OPTIONS,
      CORE_BACKEND,
    ).diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}`),
    ["error TSV011"],
  );
  const repaired =
    'repeat fromJson("1.5", default: 0, files: false) { say "BODY" }\nsay "AFTER"\nexit\n';
  assert.deepEqual(ran(runWith(candidatePlan(repaired), null)).said, ["AFTER"]);
});

test("a typed parse's or load's expected type is the core's own answer at the call, which its store's check holds, in three layers, in both orders (S7 review r3 B1, B2, B3)", () => {
  // a `null` element of the default is one of its values (ADR 0021 2.6), on both lowerings
  for (const files of ["", ", files: false"]) {
    const source = `let out = fromJson(hostValue, default: [null, 1]${files})\nsay out[0]\nsay "AFTER"\nexit\n`;
    const parse = at(source, `fromJson(hostValue, default: [null, 1]${files})`);
    assert.ok(
      decision(source).checks.some((check) => check.endsWith(`boundary @${parse}`)),
      source,
    );
    const plan = candidatePlan(source);
    assert.deepEqual(checkedStores(plan), ["'out' list<integer|null>"], source);
    assert.ok(
      contentOf(plan).some((entry) => entry.endsWith(`@${parse} list<integer|null>`)),
      JSON.stringify(contentOf(plan)),
    );
    assert.deepEqual(
      ran(runWith(plan, '["bad", 2]')),
      halted(["null", "AFTER"], [`TSW020@${parse}`]),
      source,
    );
    assert.deepEqual(ran(runWith(plan, "[3, 2]")), halted(["3", "AFTER"]), source);
  }
  // the load reads its stored value as the same type
  const load = 'let out = load("k", default: [null, 1])\nsay out[0]\nsay "AFTER"\nexit\n';
  const loaded = candidatePlan(load);
  assert.deepEqual(checkedStores(loaded), ["'out' list<integer|null>"]);
  const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
    kind: "list",
    items,
  });
  assert.deepEqual(
    ran(runWith(loaded, null, [{ key: "k", value: list("bad", 2) }])),
    halted(["null", "AFTER"], [`TSW016@${at(load, 'load("k", default: [null, 1])')}`]),
  );
  assert.deepEqual(
    ran(runWith(loaded, null, [{ key: "k", value: list(3, 2) }])),
    halted(["3", "AFTER"]),
  );
  // the records of a list default settle one family: a field's numbers read as numbers
  const records =
    'let out = fromJson(hostValue, default: [{n: 1}, {n: 1.5}], files: false)\nsay out[0].n\nsay "AFTER"\nexit\n';
  const parse = at(records, "fromJson(hostValue, default: [{n: 1}, {n: 1.5}], files: false)");
  const read = candidatePlan(records);
  assert.deepEqual(checkedStores(read), ["'out' list<{n: number}>"]);
  assert.deepEqual(contentOf(read), [`expected call@${parse} list<{n: number}>`]);
  assert.deepEqual(ran(runWith(read, '[{"n": 2.5}]')), halted(["2.5", "AFTER"]));
  assert.deepEqual(ran(runWith(read, '[{"n": "x"}]')), halted(["1", "AFTER"], [`TSW020@${parse}`]));
  // a record as deep as the slice follows repairs its leaf; deeper, and fields some records of a list lack, which no
  // default supplies there, leave the slice rather than check less than the core decided
  const deep = (depth: number): string =>
    `let out = fromJson(hostValue, default: ${"{f: ".repeat(depth)}0${"}".repeat(depth)}, files: false)\n` +
    `say out${".f".repeat(depth)}\nsay "AFTER"\nexit\n`;
  const followed = deep(128);
  assert.deepEqual(
    ran(runWith(candidatePlan(followed), `${'{"f":'.repeat(128)}"bad"${"}".repeat(128)}`)),
    halted(["0", "AFTER"], [`TSW020@10:${followed.indexOf("\n")}`]),
  );
  for (const source of [
    deep(255),
    'let out = fromJson(hostValue, default: [{n: 1}, {m: 2}], files: false)\nsay "AFTER"\nexit\n',
  ])
    assert.throws(
      () => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND),
      (error) =>
        error instanceof CandidateOutsideSlice &&
        error.what === "a value whose structure the slice does not follow",
      source.slice(0, 80),
    );
});

test("a typed parse's or load's contract stays the one the core decided, or its program leaves the slice, in three layers, in both orders (S7 review r4 B1, B2, N1)", () => {
  // a default that reads a variable reads it at the call (F18): the plan's type is the core's answer there,
  // a `null` field open (any value), in both orders
  for (const [source, call, type] of [
    [
      "let d = {n: 0}\nd.n = null\nlet out = fromJson(hostValue, default: d, files: false)\nsay out.n\nexit\n",
      "fromJson(hostValue, default: d, files: false)",
      null,
    ],
    [
      "let d = {n: 1.5}\nd.n = 0\nlet out = fromJson(hostValue, default: d, files: false)\nsay out.n\nexit\n",
      "fromJson(hostValue, default: d, files: false)",
      "{n: integer}",
    ],
    [
      "let d = {a: {n: 0}}\nlet out = fromJson(hostValue, default: d.a, files: false)\nsay out.n\nexit\n",
      "fromJson(hostValue, default: d.a, files: false)",
      "{n: integer}",
    ],
  ] as const) {
    const expected = contentOf(candidatePlan(source)).filter((entry) =>
      entry.startsWith("expected "),
    );
    assert.equal(expected.length, 1, source);
    assert.ok(expected[0]!.startsWith(`expected call@${at(source, call)} `), expected[0]);
    if (type !== null) assert.equal(expected[0], `expected call@${at(source, call)} ${type}`);
    // (an open field: any value, `null` among them)
    else
      for (const kind of ["null", "string", "list"])
        assert.match(expected[0]!, new RegExp(`\\b${kind}\\b`));
  }
  const loaded = 'let d = {n: 0}\nlet out = load("k", default: d)\nsay out.n\nexit\n';
  assert.ok(
    contentOf(candidatePlan(loaded)).some(
      (entry) => entry === `type storageLoad@${at(loaded, 'load("k", default: d)')} {n: integer}`,
    ),
    JSON.stringify(contentOf(candidatePlan(loaded))),
  );
  const structure = "a value whose structure the slice does not follow";
  for (const [source, what] of [
    // fields some records of a list lack, also where a record gives them as `null` or host data
    [
      "let out = fromJson(hostValue, default: [{n: null, a: 1}, {m: null, a: 2}], files: false)\nsay out[0].a\nexit\n",
      structure,
    ],
    [
      "let out = fromJson(hostValue, default: [{n: null}, {m: null}], files: false)\nexit\n",
      structure,
    ],
  ] as const)
    assert.throws(
      () => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND),
      (error) => error instanceof CandidateOutsideSlice && error.what === what,
      source,
    );
  // a `null` field of the default that the program types elsewhere: the core answers the call with it unknown and the
  // place with that type, so the slice leaves it out too
  assert.throws(
    () =>
      compileSourceWithBackend(
        "let p = fromJson(hostValue, default: {a: 1, b: null}, files: false)\np.b = 2\nsay p.a\nexit\n",
        OPTIONS,
        CORE_BACKEND,
      ),
    (error) =>
      error instanceof CandidateOutsideSlice &&
      error.what === "an open part of a typed parse's or load's default that its destination types",
  );
  // where nothing else types it, it stays unknown: any JSON value there, the others read as typed
  const open =
    'let p = fromJson(hostValue, default: {a: 1, b: null}, files: false)\nsay p.a\nsay "AFTER"\nexit\n';
  const parse = at(open, "fromJson(hostValue, default: {a: 1, b: null}, files: false)");
  const plan = candidatePlan(open);
  assert.deepEqual(checkedStores(plan), ["'p' {a: integer}"]);
  assert.ok(
    contentOf(plan).some((entry) => entry.startsWith(`expected call@${parse} {a: integer, b: `)),
    JSON.stringify(contentOf(plan)),
  );
  assert.deepEqual(ran(runWith(plan, '{"a": 3, "b": "x"}')), halted(["3", "AFTER"]));
  assert.deepEqual(
    ran(runWith(plan, '{"a": "x", "b": 4}')),
    halted(["1", "AFTER"], [`TSW020@${parse}`]),
  );
  // a record's fields keep its own default's order, whatever another record writes first
  const ordered =
    "let unused = {b: 0, a: 0}\nlet p = fromJson(hostValue, default: {a: 1, b: 2}, files: false)\nsay p.a\nexit\n";
  assert.deepEqual(contentOf(candidatePlan(ordered)), [
    `expected call@${at(ordered, "fromJson(hostValue, default: {a: 1, b: 2}, files: false)")} {a: integer, b: integer}`,
  ]);
});

test("a typed parse or load into a written `object` keeps every key and takes each property its default names from it per field, plain, nested, optional or as a list's element, in three layers, in both orders (#1223)", () => {
  // the written type stays the store's (`{}`); the call reads the default's properties with their types, every other
  // key kept: a missing or wrong one is the default's, named by its warning, never the whole value, and JSON or a stored
  // value of another kind gives the whole default
  for (const [type, fallback, said, cases] of [
    [
      "object",
      "{n: 0}",
      "p.n",
      [
        ['{"n": 3}', { n: 3 }, ["3"], []],
        ['{"m": 1}', { m: 1, n: 0 }, ["0"], ["n"]],
        ['{"n": "text"}', { n: 0 }, ["0"], ["n"]],
        ['{"n": "text", "m": 1}', { n: 0, m: 1 }, ["0"], ["n"]],
        ["[]", { n: 0 }, ["0"], [null]],
      ],
    ],
    // a `null` in the default stays open, as without a written type
    [
      "object",
      "{n: null}",
      '"DONE"',
      [['{"n": "text", "m": 1}', { n: "text", m: 1 }, ["DONE"], []]],
    ],
    // every level below a written `object` keeps its keys; a list field is one field (the lead's ruling 1)
    [
      "object",
      "{a: {n: 0}, xs: [0]}",
      '"DONE"',
      [
        [
          '{"a": {"n": "text", "extra": 2}, "xs": ["text"], "other": 3}',
          { a: { n: 0, extra: 2 }, xs: [0], other: 3 },
          ["DONE"],
          ["a.n", "xs"],
        ],
      ],
    ],
    // `object?` reads its object member so, `null` as it is; `object[]` keeps each element's keys, and a list with an
    // element that does not fit gives the whole default (the lead's ruling 2)
    ["object?", "{n: 0}", '"DONE"', [['{"n": "text", "m": 1}', { n: 0, m: 1 }, ["DONE"], ["n"]]]],
    [
      "object[]",
      "[{n: 0}]",
      '"DONE"',
      [
        ['[{"n": 1, "m": 2}]', [{ n: 1, m: 2 }], ["DONE"], []],
        ['[{"n": "text", "m": 1}]', [{ n: 0 }], ["DONE"], [null]],
      ],
    ],
  ] as const)
    for (const call of [
      `fromJson(hostValue, default: ${fallback}, files: false)`,
      `load("k", default: ${fallback})`,
    ]) {
      const source = `let p: ${type} = ${call}\nsay ${said}\nexit\n`;
      const where = at(source, call);
      const parse = call.startsWith("fromJson");
      const plan = candidatePlan(source);
      if (type === "object" && fallback === "{n: 0}") {
        assert.deepEqual(checkedStores(plan), ["'p' {}"], source);
        assert.deepEqual(
          contentOf(plan),
          parse
            ? [`expected call@${where} {n: integer, ...}`]
            : [`repair storageLoad@${where}`, `type storageLoad@${where} {n: integer, ...}`],
          source,
        );
      }
      for (const [input, value, says, fields] of cases) {
        const storage = parse ? [] : [{ key: "k", value: stored(JSON.parse(input)) }];
        const result = runWith(plan, parse ? input : null, storage);
        const code = parse ? "TSW020" : "TSW016";
        assert.deepEqual(
          ran(result),
          halted(
            says,
            fields.map(() => `${code}@${where}`),
          ),
          `${source} with ${input}`,
        );
        assert.deepEqual(bound(result.snapshot, "p"), stored(value), `${source} with ${input}`);
        const warnings = result.events.filter((event) => event.kind === "developerWarning");
        fields.forEach((field, index) => {
          if (field !== null)
            assert.match(warnings[index]!.message, new RegExp(`'${field}'`), `${source}: ${input}`);
        });
        assert.deepEqual(result.snapshot.scriptStorage, storage, `${source} with ${input}`);
      }
    }
  // `null` JSON into `object?` is `null`
  const optional = "let p: object? = fromJson(hostValue, default: {n: 0}, files: false)\nexit\n";
  assert.equal(bound(runWith(candidatePlan(optional), "null").snapshot, "p"), null);
  // an object default without a written type still leaves the other keys of JSON out, its stored record keeps them
  const inferred = runWith(
    candidatePlan("let p = fromJson(hostValue, default: {n: 0}, files: false)\nexit\n"),
    '{"n": "text", "m": 1}',
  );
  assert.deepEqual(bound(inferred.snapshot, "p"), stored({ n: 0 }));
  const kept = [{ key: "k", value: stored({ n: "text", m: 1 }) }];
  const loaded = runWith(candidatePlan('let p = load("k", default: {n: 0})\nexit\n'), null, kept);
  assert.deepEqual(bound(loaded.snapshot, "p"), stored({ n: 0, m: 1 }));
  // a checkpoint keeps the marker, and one of another value fails the plan's and the checkpoint's validation
  const marked = candidatePlan(optional);
  const start = createImmediatePacingRuntimeSnapshot(marked, { globals: { hostValue: "{}" } });
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(marked, start)));
  assert.deepEqual(restored.plan, marked);
  const malformed = structuredClone(marked);
  const marker = planNodes(malformed).find((node) => node["keepExtra"] === true);
  assert.ok(marker !== undefined);
  marker["keepExtra"] = false;
  assert.ok(
    JSON.stringify(validateInstructionPlan(malformed).errors).includes(
      "Object type keepExtra must be true.",
    ),
  );
  assert.throws(
    () => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(malformed, start))),
    (error) => error instanceof Error && !(error instanceof TypeError),
  );
});

test("a known `null` reads as the `null` type, an unknown stays open, and each record keeps its own fields' order, in three layers, in both orders (S7 review r5 B1, N1)", () => {
  // a written `null` target, at the root and as a list's elements, on both lowerings: the decision layer only, as the
  // route takes no written type with a position only `null` fills
  for (const files of ["", ", files: false"])
    for (const [written, fallback] of [
      ["null", "null"],
      ["null[]", "[null]"],
    ] as const) {
      const source = `let p: ${written} = fromJson(hostValue, default: ${fallback}${files})\nsay ${written === "null" ? "p" : "p[0]"}\nsay "AFTER"\nexit\n`;
      const parse = at(source, `fromJson(hostValue, default: ${fallback}${files})`);
      assert.ok(
        decision(source).checks.some((check) => check.endsWith(`boundary @${parse}`)),
        source,
      );
      assert.throws(
        () => compileSourceWithBackend(source, OPTIONS, CORE_BACKEND),
        (error) =>
          error instanceof CandidateOutsideSlice &&
          error.what === "this written type" &&
          error.site.start === source.indexOf("null"),
        source,
      );
    }
  // without a written type, a `null` default leaves the value unknown (F19): no expected type
  assert.deepEqual(
    contentOf(
      candidatePlan(
        'let p = fromJson(hostValue, default: null, files: false)\nsay "AFTER"\nexit\n',
      ),
    ),
    [],
  );
  // each record's fields in the order its own literal writes them, not a sibling's or a descendant's
  const nested =
    'let p = fromJson(hostValue, default: {r: {b: 0, a: 0}, s: {a: 1, b: 2}}, files: false)\nsay p.s.a\nsay "AFTER"\nexit\n';
  const parse = at(
    nested,
    "fromJson(hostValue, default: {r: {b: 0, a: 0}, s: {a: 1, b: 2}}, files: false)",
  );
  const plan = candidatePlan(nested);
  const type = "{r: {b: integer, a: integer}, s: {a: integer, b: integer}}";
  assert.deepEqual(contentOf(plan), [`expected call@${parse} ${type}`]);
  assert.deepEqual(checkedStores(plan), [`'p' ${type}`]);
  const repaired = runWith(plan, '{"r": {"b": 0, "a": 0}, "s": {"a": "bad", "b": "bad"}}');
  assert.deepEqual(ran(repaired), halted(["1", "AFTER"], [`TSW020@${parse}`, `TSW020@${parse}`]));
  assert.deepEqual(
    repaired.events.flatMap((event) =>
      event.kind === "developerWarning" ? [/'(s\.[ab])'/.exec(event.message)?.[1]] : [],
    ),
    ["s.a", "s.b"],
  );
});

test("a literal wider than a native call takes compiles and keeps its checks, in three layers (S7 review r7 B1, r8 B1)", () => {
  // more elements than one call passes as spread arguments: the contracts collect them one at a time. A call's
  // arguments overflow near 12,000 under a 100 KiB stack (near 125,000 at Node's default), so every layer runs in a
  // child of that stack (`--stack-size=100`, the native suite's method) at 30,000, where `recordsBelow`'s spread
  // restored has no plan (TSC007) at a fraction of the default stack's work; one order only, as the width is the
  // defect's cause
  const source = `let p = [hostValue, ${Array.from({ length: 29_999 }, () => "0").join(", ")}]\nsay p[0]\nsay "AFTER"\nexit\n`;
  assert.ok(coreRequest([{ path: "main.tease", source }], OPTIONS.globals) !== null);
  const url = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import {readFileSync} from "node:fs";
    import {compileSourceWithBackend} from ${url("../../../src/compiler.js")};
    import {validateInstructionPlan} from ${url("../../../src/plan/validation.js")};
    import {run} from ${url("../../../src/runtime/engine.js")};
    import {CORE_BACKEND} from ${url("../../../src/type-inference/core/backend.js")};
    import {createImmediatePacingRuntimeSnapshot} from ${url("../../helpers/immediate-pacing-runtime.js")};
    import {compactAnalysis, coreRequest} from ${url("../../helpers/type-core-analysis.js")};
    const source = readFileSync(0, "utf8");
    const options = ${JSON.stringify(OPTIONS)};
    const {checks} = compactAnalysis(coreRequest([{path: "main.tease", source}], options.globals));
    const {plan, diagnostics} = compileSourceWithBackend(source, options, CORE_BACKEND);
    const runOf = (hostValue) => {
      const {snapshot, events} = run(plan, createImmediatePacingRuntimeSnapshot(plan, {globals: {hostValue}}));
      return {status: snapshot.status, events};
    };
    console.log(JSON.stringify({
      checks,
      codes: diagnostics.map(({code}) => code),
      plan: plan === null ? null : {
        errors: validateInstructionPlan(plan).errors,
        stores: plan.instructions.flatMap(({kind, typeCheck}) =>
          (kind === "declareBinding" || kind === "assign") && typeCheck !== undefined ? [typeCheck] : []),
        runs: [runOf(1), runOf("bad")],
      },
    }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=100", "--input-type=module", "--eval", script],
    { input: source, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, `exit ${child.status}\n${child.stderr.slice(-2_000)}`);
  // EVIDENCE: invariant: the child prints the JSON its script above builds.
  const seen = JSON.parse(child.stdout) as {
    readonly checks: CompactRecord["checks"];
    readonly codes: readonly string[];
    readonly plan: {
      readonly errors: readonly unknown[];
      readonly stores: readonly TypeCheckPlan[];
      readonly runs: readonly { readonly status: string; readonly events: InterpreterEvent[] }[];
    } | null;
  };
  // the core's boundary at the host value, against the elements' integer (C9)
  const hostValue = `${source.indexOf("hostValue")}:${source.indexOf("hostValue") + 9}`;
  assert.ok(
    seen.checks.some(
      (check) =>
        check.boundary &&
        check.target === "p.element" &&
        `${check.site.offset}:${check.site.end}` === hostValue &&
        check.against.join() === "integer",
    ),
  );
  assert.ok(seen.plan !== null, `no plan (${seen.codes.join(", ")})`);
  assert.deepEqual(seen.plan.errors, []);
  assert.deepEqual(
    seen.plan.stores.map((check) => `${check.place} ${typeText(check.type)}`),
    ["'p' list<integer>"],
  );
  const [fits, misfits] = seen.plan.runs.map(({ status, events }) => summary(events, status));
  assert.deepEqual(fits, halted(["1", "AFTER"]));
  assert.deepEqual(misfits, failed(`TSR058@8:${source.indexOf("\n")}`));
});

test("a typed parse or load into a place its own store or literal decides reads the default's kinds, in three layers", () => {
  // a place its own store decides, not a copy of a written type: F18 reads the default's kinds, in three layers
  const decided =
    'let b = 1.5\nb = fromJson(hostValue, default: 0, files: false)\nsay b\nsay "AFTER"\nexit\n';
  const parse = at(decided, "fromJson(hostValue, default: 0, files: false)");
  assert.ok(decision(decided).checks.some((check) => check.endsWith(`boundary @${parse}`)));
  const plan = candidatePlan(decided);
  assert.deepEqual(contentOf(plan), [`expected call@${parse} integer`]);
  assert.deepEqual(ran(runWith(plan, "3")), halted(["3", "AFTER"]));
  assert.deepEqual(ran(runWith(plan, "1.5")), halted(["0", "AFTER"], [`TSW020@${parse}`]));
  // a copy of a place its own literal decides, not of a written type, whole or selected from a literal (Sol r10 B1):
  // the default's kinds too
  for (const copy of [
    "base",
    "[base][0]",
    "[base].get(0, default: {n: 0})",
    "null otherwise [base][0]",
  ]) {
    const copied = `let base = {n: 1.5}\nlet out = ${copy}\nout = fromJson(hostValue, default: {n: 0}, files: false)\nsay out.n\nexit\n`;
    const read = at(copied, "fromJson(hostValue, default: {n: 0}, files: false)");
    assert.ok(
      decision(copied).checks.some((check) => check.endsWith(`boundary @${read}`)),
      copied,
    );
    const copiedPlan = candidatePlan(copied);
    assert.ok(
      contentOf(copiedPlan).includes(`expected call@${read} {n: integer}`),
      `${copied}: ${JSON.stringify(contentOf(copiedPlan))}`,
    );
    assert.deepEqual(ran(runWith(copiedPlan, '{"n": 3}')), halted(["3"]), copied);
    assert.deepEqual(
      ran(runWith(copiedPlan, '{"n": 1.5}')),
      halted(["0"], [`TSW020@${read}`]),
      copied,
    );
  }
});

test("JSON fitting a nullable collection's level reads whole, at every nesting, on both lowerings, in three layers, in both orders (Astra B1)", () => {
  // kind × nullability × nesting: each default, the expected type the core gives it, JSON that fits (also with its
  // nulls) read as that type, and JSON that does not, which gives the default with TSW020
  const n = (value: number): SerializableRuntimeValue => object({ n: value });
  for (const [fallback, type, fitting] of [
    [
      "[null, [{n: 0}]]",
      "list<list<{n: integer}>|null>",
      [
        ['[[{"n": 7}]]', listOf(listOf(n(7)))],
        ['[null, [{"n": 7}], []]', listOf(null, listOf(n(7)), listOf())],
      ],
    ],
    ["[null, [1]]", "list<list<integer>|null>", [["[[2], null]", listOf(listOf(2), null)]]],
    [
      "{items: [null, [1]]}",
      "{items: list<list<integer>|null>}",
      [['{"items": [[2], null], "extra": 1}', object({ items: listOf(listOf(2), null) })]],
    ],
    // the controls: a nullable record, and a nested list without null
    ["[null, {n: 0}]", "list<{n: integer}|null>", [['[{"n": 7}, null]', listOf(n(7), null)]]],
    ["[[{n: 0}]]", "list<list<{n: integer}>>", [['[[{"n": 7}]]', listOf(listOf(n(7)))]]],
  ] as const)
    for (const files of ["", ", files: false"]) {
      const source = `let out = fromJson(hostValue, default: ${fallback}${files})\nsay "AFTER"\nexit\n`;
      const parse = at(source, `fromJson(hostValue, default: ${fallback}${files})`);
      assert.ok(
        decision(source).checks.some((check) => check.endsWith(`boundary @${parse}`)),
        source,
      );
      const plan = candidatePlan(source);
      assert.ok(
        contentOf(plan).some((entry) => entry.endsWith(`@${parse} ${type}`)),
        `${source}: ${JSON.stringify(contentOf(plan))}`,
      );
      for (const [json, value] of fitting) {
        const result = runWith(plan, json);
        assert.deepEqual(ran(result), halted(["AFTER"]), `${source} with ${json}`);
        assert.deepEqual(bound(result.snapshot, "out"), value, `${source} with ${json}`);
      }
      const violating = runWith(plan, '[[{"n": "x"}], 1]');
      assert.deepEqual(ran(violating), halted(["AFTER"], [`TSW020@${parse}`]), source);
    }
});
