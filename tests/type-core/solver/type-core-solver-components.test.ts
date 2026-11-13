// Components round their own cycles: defaults, method chains, spellings and references answer alike from every entry, a
// component found during another's solve uses the explicit stack, and a recursive projection closes.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import {
  makeItem,
  mergeItems,
  REASON,
  spelledBy,
  type Item,
} from "../../../src/type-inference/core/items.js";
import {
  Solver,
  withSolverSeam,
  type Demand,
  type Work,
} from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { itemScope } from "../../helpers/type-core-items.js";
import { canonical, componentDifferences } from "../../helpers/type-core/type-core-solver-setup.js";

/**
 * F18/F19's kinds of a default are a choice that is not monotone in the default's kinds (none give `unknown`): in a
 * cycle through the default the choice is made on the completed kinds, so neither the order nor the entry changes it
 * (review r1: the forms through one and two functions reached two answers, and a budget stop in one order).
 */
const DEFAULT_CYCLES: readonly (readonly [string, string, string])[] = [
  [
    "through one function",
    'function a(flag: boolean) {\n  if flag { return 1 }\n  return fromJson("1", default: a(flag))\n}\nrepeat a(true) {}',
    "valid",
  ],
  [
    "through two functions",
    'function a(flag: boolean) {\n  if flag { return 1 }\n  return fromJson("1", default: b(flag))\n}\nfunction b(flag: boolean) {\n  if flag { return 1 }\n  return a(flag)\n}\nrepeat a(true) {}',
    "valid",
  ],
  [
    "through two functions declared the other way",
    'function b(flag: boolean) {\n  if flag { return 1 }\n  return a(flag)\n}\nfunction a(flag: boolean) {\n  if flag { return 1 }\n  return fromJson("1", default: b(flag))\n}\nrepeat a(true) {}',
    "valid",
  ],
  [
    "of a load",
    'function a(flag: boolean) {\n  if flag { return 2 }\n  return load("count", default: a(flag))\n}\nrepeat a(true) {}',
    "valid",
  ],
  [
    "without kinds of its own",
    'function a {\n  return fromJson("1", default: a())\n}\nrepeat a() {}',
    "warning-runtime-check",
  ],
  [
    "of only null",
    'function a(flag: boolean) {\n  if flag { return null }\n  return fromJson("1", default: a(flag))\n}\nlet n: integer = a(true) otherwise 0\nsay n',
    "warning-runtime-check",
  ],
  [
    "of a computed key",
    'function a(flag: boolean, key: string) {\n  if flag { return null }\n  return load(key, default: a(flag, key))\n}\nlet n: integer = a(true, "k") otherwise 0\nsay n',
    "warning-runtime-check",
  ],
  [
    "under a written type",
    'function a(flag: boolean) {\n  if flag { return 1 }\n  let v: integer = fromJson("1", default: a(flag))\n  return v\n}\nrepeat a(true) {}',
    "valid",
  ],
];

test("a default in a cycle is chosen on its completed kinds, in either order and from every entry", () => {
  const got: string[] = [];
  const differing: string[] = [];
  for (const [name, source] of DEFAULT_CYCLES) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: the source parses and resolves`);
    const forward = compactAnalysis(request);
    got.push(`${name}: ${forward.outcome}`);
    if (
      canonical(withSolverSeam({ reverseWorklist: true }, () => compactAnalysis(request))) !==
      canonical(forward)
    )
      differing.push(`${name} (reverse)`);
    const found = componentDifferences(name, request);
    if (found.components === 0) differing.push(`${name}: no component`);
    differing.push(...found.differing);
  }
  assert.deepEqual(
    got,
    DEFAULT_CYCLES.map(([name, , outcome]) => `${name}: ${outcome}`),
  );
  assert.deepEqual(differing, []);
});

/**
 * S3 (Astra's R2-B1 on #1028): a method without a category answers per receiver alternative, and a
 * receiver without items yet is a provisional bottom, no answer: the method's result stays the bottom, which the solver
 * completes, so no `external` reason enters a component from it. A chain round its own component (a self-update, a
 * record's field updated from itself, a loop, two functions) gives the same record in every order combination
 * (consumers × worklist) and the same answers from every component entry, its unknowns opaque.
 */
const METHOD_CYCLES: readonly (readonly [string, string, string])[] = [
  // (a list's `union`, a method whose result is the runtime's until S9b's result relations; text's methods have their
  // declared results since S9b)
  [
    "a self-update",
    'let s = [1]\nif askBoolean "f" { s = s.union([2]) }\nlet n: integer = s.union([3])\nexit',
    "s.union([3])",
  ],
  [
    "a record's field updated from itself",
    'let r = {s: [1]}\nif askBoolean "f" { r.s = r.s.union([2]) }\nlet n: integer = r.s.union([3])\nexit',
    "r.s.union([3])",
  ],
  [
    "a loop",
    "let s = [1]\nrepeat 3 { s = s.union([2]) }\nlet n: integer = s.union([3])\nexit",
    "s.union([3])",
  ],
  [
    "two functions",
    "function f(x) {\nif x > 0 { return g(x - 1).union([1]) }\nreturn [1]\n}\nfunction g(x) { return f(x).union([2]) }\nlet n: integer = f(3)\nexit",
    "f(3)",
  ],
];

test("a method chain round its own component answers alike from every entry, its unknowns opaque", () => {
  const differing: string[] = [];
  for (const [name, source, read] of METHOD_CYCLES) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: the source parses and resolves`);
    let first: string | null = null;
    for (const consumers of [false, true])
      for (const reverseWorklist of [false, true]) {
        const order = `${consumers ? "consumers reversed" : "consumers"}, ${reverseWorklist ? "worklist reversed" : "worklist"}`;
        const run = <T>(f: () => T): T =>
          withSolverSeam({ reverseWorklist }, () =>
            consumers ? withConsumerOrder((list) => [...list].reverse(), f) : f(),
          );
        const record = canonical(run(() => compactAnalysis(request)));
        first ??= record;
        if (record !== first) differing.push(`${name}: ${order}`);
        const answers = run(() => analyseCore(request));
        const node = answers.graph.nodes.find(
          (candidate) =>
            candidate.kind === "expression" &&
            candidate.span !== null &&
            source.slice(candidate.span.start.offset, candidate.span.end.offset) === read,
        );
        const unknowns = (node === undefined ? [] : (answers.at(node)?.items ?? [])).filter(
          (item) => item.tag === "unknown",
        );
        if (unknowns.length === 0 || unknowns.some((item) => item.reasons !== REASON.opaque))
          differing.push(
            `${name}: ${order}: reasons ${unknowns.map((item) => item.reasons).join(",")}`,
          );
      }
    const found = componentDifferences(name, request);
    if (found.components === 0) differing.push(`${name}: no component`);
    differing.push(...found.differing);
  }
  assert.deepEqual(differing, []);
});

/**
 * #1398 (Codex r6 on #1558): an item's spelling is part of its value, so a component member whose
 * answer gains a spelling changes, and the members reading it run again: A merges unmarked kinds with C, B is A, C
 * merges B with a written type's. From each member as the entry, all three end with the written spelling, in its order.
 */
test("a spelling a component's answers gain reaches every member, from each entry (#1398)", () => {
  const solved = (entry: "a" | "b" | "c"): readonly string[] => {
    const scope = itemScope();
    const solver = new Solver(scope);
    const inferred = (["integer", "string"] as const).map((tag) => makeItem(tag));
    const written = (["string", "integer"] as const).map((tag) =>
      makeItem(tag, null, spelledBy(["string", "integer"])),
    );
    const demand = (key: string, offset: number, make: () => Work<readonly Item[]>): Demand => ({
      key,
      kind: "value",
      file: 0,
      offset,
      make,
    });
    const demands: Record<"a" | "b" | "c", Demand> = {
      a: demand("a", 0, function* () {
        return mergeItems([...inferred, ...(yield demands.c)], scope);
      }),
      b: demand("b", 1, function* () {
        return yield demands.a;
      }),
      c: demand("c", 2, function* () {
        return mergeItems([...(yield demands.b), ...written], scope);
      }),
    };
    solver.run(
      (function* (): Work<readonly Item[]> {
        return yield demands[entry];
      })(),
    );
    return (["a", "b", "c"] as const).map((key) =>
      solver
        .answer(key)!
        .map((item) => `${item.tag}(${item.spelling?.join("|") ?? ""})`)
        .join(","),
    );
  };
  const spelled = "string(string|integer),integer(string|integer)";
  for (const entry of ["a", "b", "c"] as const)
    assert.deepEqual(solved(entry), [spelled, spelled, spelled], entry);
});

test("a component found while another is solved is solved on the explicit stack", () => {
  // each demand reads itself, and the next one once its own answer holds an item: each component is found by a run
  // again of a member of the one before it, 4,096 deep (review r1's solver-only control)
  const scope = itemScope();
  const solver = new Solver(scope);
  const size = 4096;
  const demands: Demand[] = Array.from({ length: size }, (_, at) => ({
    key: `n${at}`,
    kind: "contract",
    file: 0,
    offset: at,
    *make() {
      const own = yield demands[at]!;
      const next = own.length > 0 && at + 1 < size ? yield demands[at + 1]! : [];
      return mergeItems([makeItem("integer"), ...own, ...next], scope);
    },
  }));
  const items = solver.run(
    (function* (): Work<readonly Item[]> {
      return yield demands[0]!;
    })(),
  );
  assert.deepEqual(
    items.map((item) => item.tag),
    ["integer"],
  );
  assert.equal(solver.demandWork().length, size);
});

/**
 * Astra B2: a recursive projection of a reference (F19a) or of a record terminates; its receiver's provisional answer
 * no longer opens ever deeper paths, so its component closes. Under a 10,000-unit allowance, which the head before the
 * repair crossed at 81 frames with no component, each completes in either order (the reference: 506 and 517 units, two
 * members; the record: 657 and 694 units, three).
 */
test("a recursive projection of a reference or a record closes its component", () => {
  const shapes: readonly (readonly [string, string, string, number])[] = [
    [
      "a reference read further",
      'speaker narrator { value: "Hello" }\nfunction f(flag: boolean) {\n  if flag { return narrator }\n  return f(true).custom\n}\nrepeat f(false) {}\nexit',
      "warning-runtime-check",
      2,
    ],
    [
      "a reference read further in its own call",
      'speaker narrator { value: "Hello" }\nfunction f(flag: boolean) {\n  if flag { return narrator }\n  return f(flag).custom\n}\nrepeat f(true) {}\nexit',
      "warning-runtime-check",
      2,
    ],
    [
      "a reference and a record in two functions",
      'speaker narrator { value: "Hello" }\nfunction a(flag: boolean) {\n  if flag { return {n: 1} }\n  return b(flag)\n}\nfunction b(flag: boolean) {\n  if flag { return narrator }\n  return a(flag).n\n}\nrepeat a(true).n {}\nexit',
      "warning-runtime-check",
      0,
    ],
    // (its second return, a whole number into the result its first return decides as a record, is admission's error,
    // ADR 0021 1.5)
    [
      "a record read further",
      "function f(flag: boolean) {\n  if flag { return {custom: 1} }\n  return f(true).custom\n}\nrepeat f(false) {}\nexit",
      "compile-error",
      3,
    ],
  ];
  const got: string[] = [];
  const want: string[] = [];
  for (const [name, source, outcome, members] of shapes)
    for (const reversed of [false, true]) {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, name);
      let solved = 0;
      const run = (): string =>
        withTestAllowance(10_000, () =>
          withSolverSeam(
            { reverseWorklist: reversed, onComponent: (component) => (solved += component.length) },
            () => analyseCore(request).outcome,
          ),
        );
      const result = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      got.push(
        `${name}${reversed ? " reversed" : ""}: ${result}, ${solved >= members ? "closed" : solved}`,
      );
      want.push(`${name}${reversed ? " reversed" : ""}: ${outcome}, closed`);
    }
  assert.deepEqual(got, want);
});

const NARRATOR = 'speaker narrator { value: "Hello" }\n';

/**
 * Programs whose receiver gains a reference kind only round its own cycle, whose receiver holds a reference from
 * outside the cycle beside a record, a nested record or an external leaf round it (B2, B2-r2), and the record-only
 * control, with their diagnostics (a class `warning-runtime-check` unless written; a member's at the whole access).
 * A return that may not fit the result
 * its function's first return decides owes C1's check (A2, F23), at the result and at each path of the first return's
 * literal (A8); the record-only control's, which none of its kinds fits, is an error (ADR 0021 1.5) and is rejected, so
 * the result's use sees the first return's record (A6, F23).
 */
const REFERENCE_CYCLES: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "a record holding a reference, read through two functions",
    `${NARRATOR}function g(flag: boolean) {\n  if flag { return {custom: narrator} }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return g(true).custom }\n  return g(false).custom\n}\nrepeat f(false) {}\nexit`,
    [
      "integer-use f(false)",
      "member-read g(false).custom",
      "member-read g(true).custom",
      "written-target f(true)",
    ],
  ],
  [
    "the same in the other declaration order",
    `${NARRATOR}function f(flag: boolean) {\n  if flag { return g(true).custom }\n  return g(false).custom\n}\nfunction g(flag: boolean) {\n  if flag { return {custom: narrator} }\n  return f(true)\n}\nrepeat f(false) {}\nexit`,
    [
      "integer-use f(false)",
      "member-read g(false).custom",
      "member-read g(true).custom",
      "written-target f(true)",
    ],
  ],
  [
    "a list holding a reference, its method's result returned",
    `${NARRATOR}function f(flag: boolean) {\n  if flag { return [narrator] }\n  return f(true).removeFirst()\n}\nrepeat f(false) {}\nexit`,
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read f(true).removeFirst()",
      "member-read f(true).removeFirst()",
      "written-target f(true).removeFirst()",
    ],
  ],
  [
    "a reference from outside the cycle beside a record round it",
    "speaker narrator { custom: 1 }\nfunction g(flag: boolean) {\n  if flag { return narrator }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return {custom: 1} }\n  return g(true).custom\n}\nrepeat f(false) {}\nexit",
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read g(true).custom",
      "member-read g(true).custom",
      "written-target f(true)",
      "written-target f(true)",
      "written-target g(true).custom",
      "written-target g(true).custom",
    ],
  ],
  [
    "a reference returned or read further round the cycle (Astra B2)",
    "speaker narrator { custom: 1 }\nfunction f(flag: boolean) {\n  if flag { return narrator }\n  return f(true).custom\n}\nrepeat f(false) {}\nexit",
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read f(true).custom",
      "member-read f(true).custom",
      "written-target f(true).custom",
    ],
  ],
  [
    "a reference from outside the cycle beside a nested record round it",
    "speaker narrator { custom: 1 }\nfunction g(flag: boolean) {\n  if flag { return narrator }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return {custom: {custom: 1}} }\n  return g(true).custom\n}\nrepeat f(false) {}\nexit",
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read g(true).custom",
      "member-read g(true).custom",
      "written-target f(true)",
      "written-target f(true)",
      "written-target g(true).custom",
      "written-target g(true).custom",
      "written-target g(true).custom",
    ],
  ],
  [
    "a reference from outside the cycle beside a loaded leaf round it (B2-r2)",
    'speaker narrator { custom: 1 }\nfunction g(flag: boolean) {\n  if flag { return narrator }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return {custom: fromJson("1", default: null, files: false)} }\n  return g(true).custom\n}\nrepeat f(false) {}\nexit',
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read g(true).custom",
      "member-read g(true).custom",
      "written-target f(true)",
      "written-target f(true)",
      "written-target g(true).custom",
    ],
  ],
  [
    "a reference from outside the cycle beside a host value round it (B2-r2)",
    "speaker narrator { custom: 1 }\nfunction g(flag: boolean) {\n  if flag { return narrator }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return {custom: hostValue} }\n  return g(true).custom\n}\nrepeat f(false) {}\nexit",
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read g(true).custom",
      "member-read g(true).custom",
      "written-target f(true)",
      "written-target f(true)",
      "written-target g(true).custom",
    ],
  ],
  [
    "the record-only control",
    "function g(flag: boolean) {\n  if flag { return {custom: 2} }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return {custom: 1} }\n  return g(true).custom\n}\nrepeat f(false) {}\nexit",
    // (the rejected return leaves the result, so the count reads a record, A6)
    ["integer-use compile-error f(false)", "written-target compile-error g(true).custom"],
  ],
];

/**
 * (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-44): F19a's test of a receiver is a
 * decision of its component, made once on the completed open solve (every receiver read as a record) and held for the
 * second, so a reference that reaches its receiver only round its own cycle makes the access opaque: a warning with its
 * runtime obligations; a reference from outside the cycle keeps its ordinary answer. B2, B2-r2: the stores through a
 * receiver are followed only for its records and collections, its unknowns projected with their own reasons and ingress
 * and its references the runtime's, so the open solve is finite whatever the leaf. On `2941d76d8` the first three
 * stopped with `budget-error` (4 to 20 s at the real allowance); on `30477f011` the fourth; on `5a10f3a27` the loaded
 * and host leaves. Here, in the two orders: 1,498 and 1,518; 1,498 and 1,502; 1,412 and 1,319; 1,871 and 1,568; 669 and
 * 643; 3,078 and 2,575; 1,987 and 1,681; 1,877 and 1,576; the record-only control 1,288 and 1,255 units.
 */
test("a reference that reaches its receiver only round its own cycle is decided once, its access opaque", () => {
  const got: string[] = [];
  const want: string[] = [];
  const differing: string[] = [];
  for (const [name, source, diagnostics] of REFERENCE_CYCLES) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, name);
    for (const reversed of [false, true]) {
      let solved = 0;
      const run = (): ReturnType<typeof analyseCore> =>
        withTestAllowance(10_000, () =>
          withSolverSeam(
            { reverseWorklist: reversed, onComponent: (component) => (solved += component.length) },
            () => analyseCore(request),
          ),
        );
      const answers = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const label = `${name}${reversed ? " reversed" : ""}`;
      const found = answers.diagnostics
        .map((d) => `${d.kind} ${d.class} ${source.slice(d.site.start, d.site.end)}`)
        .sort();
      got.push(
        `${label}: ${answers.outcome}, ${solved > 0 ? "closed" : "none"}; ${found.join(", ")}`,
      );
      const expected = diagnostics
        .map((d) => (d.includes(" compile-error ") ? d : d.replace(" ", " warning-runtime-check ")))
        .sort();
      const outcome = expected.some((d) => d.includes(" compile-error "))
        ? "compile-error"
        : "warning-runtime-check";
      want.push(`${label}: ${outcome}, closed; ${expected.join(", ")}`);
    }
    differing.push(...componentDifferences(name, request).differing);
  }
  assert.deepEqual(got, want);
  assert.deepEqual(differing, []);
});

test("an external value read below its record without a cycle keeps its reasons and ingress (B2-r2's control)", () => {
  const source =
    "function f(flag: boolean) {\n  return {custom: hostValue}\n}\nrepeat f(true).custom.custom {}\nexit";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const got = [false, true].map((reversed) => {
    const run = (): ReturnType<typeof analyseCore> =>
      withSolverSeam({ reverseWorklist: reversed }, () => analyseCore(request));
    const answers = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    return answers.diagnostics
      .map((d) => `${d.kind} ${d.class} ${source.slice(d.site.start, d.site.end)}`)
      .sort();
  });
  // (the member read at the whole access, its receiver included)
  const want = [
    "integer-use warning-runtime-check f(true).custom.custom",
    "member-read warning-runtime-check f(true).custom.custom",
  ];
  assert.deepEqual(got, [want, want]);
  const record = compactAnalysis(request);
  assert.deepEqual(
    record.diagnostics.map((d) => d.context),
    record.diagnostics.map(() => "unknown"),
  );
});
