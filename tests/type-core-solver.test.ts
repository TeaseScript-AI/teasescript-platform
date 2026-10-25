import assert from "node:assert/strict";
import test from "node:test";

import { createXorShift32State, nextXorShift32 } from "../src/runtime/random/random.js";
import { analyseCore, solveDemands } from "../src/type-inference/core/answers.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import {
  ingressStores,
  itemsSignature,
  makeItem,
  mergeItems,
  REASON,
  writerKey,
  type Item,
} from "../src/type-inference/core/items.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import {
  Solver,
  withSolverSeam,
  type Demand,
  type SolvedMember,
  type Work,
} from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { itemScope } from "./helpers/type-core-items.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/**
 * The determinism of the coarse core (ADR 0021 1.6; the port plan's S3 note §1): the answers depend on the program,
 * never on the order the analysis visits its consumers or discovers its demands. Every record of the expectation set
 * is analysed in four orders; every component of demands the set produces is solved again from each member as the
 * entry, in the canonical and the reverse order, and each member's answer compared by its items' signature and the
 * ingress stores its external items name.
 */

const requests = readFixture().map((record) => {
  const request = coreRequest(record.files);
  assert.ok(request !== null, `${record.name}: its files parse and resolve`);
  return { name: record.name, request };
});

/** A seeded shuffle, for a consumer order no source order gives. */
function shuffled(seed: number): <T>(list: readonly T[]) => T[] {
  return (list) => {
    const random = createXorShift32State(seed);
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(nextXorShift32(random) * (index + 1));
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  };
}

/** A record as a multiset: its outcome, its diagnostics and its checks, each in a canonical order. */
function canonical(record: ReturnType<typeof compactAnalysis>): string {
  return JSON.stringify({
    outcome: record.outcome,
    diagnostics: record.diagnostics.map((entry) => JSON.stringify(entry)).sort(),
    checks: record.checks.map((entry) => JSON.stringify(entry)).sort(),
  });
}

test("every record has one result in the source order, the reverse order and two seeded orders", () => {
  const orders: readonly [string, <T>(list: readonly T[]) => T[]][] = [
    ["reverse", (list) => [...list].reverse()],
    ["seed 1", shuffled(1)],
    ["seed 2", shuffled(2)],
  ];
  const differing: string[] = [];
  for (const { name, request } of requests) {
    const forward = canonical(compactAnalysis(request));
    for (const [order, visit] of orders)
      if (canonical(withConsumerOrder(visit, () => compactAnalysis(request))) !== forward)
        differing.push(`${name} (${order})`);
  }
  assert.deepEqual(differing, []);
});

/** A member's answer as the component test compares it: its items' signature and their ingress stores. */
function answer(items: readonly Item[]): string {
  const stores = items
    .map((item) =>
      item.ingress === undefined ? "" : ingressStores(item.ingress).map(writerKey).join(","),
    )
    .sort();
  return `${itemsSignature(items, itemScope())} ${stores.join(";")}`;
}

/**
 * Solves every component an analysis of `request` produces again from each member and in either order: how many there
 * are, and the members answered otherwise.
 */
function componentDifferences(
  name: string,
  request: CoreAnalysisRequest,
): { readonly components: number; readonly differing: readonly string[] } {
  const solved: (readonly SolvedMember[])[] = [];
  withSolverSeam({ onComponent: (members) => solved.push(members) }, () =>
    compactAnalysis(request),
  );
  const differing: string[] = [];
  for (const members of solved) {
    const keys = members.map((member) => member.key);
    const expected = members.map((member) => answer(member.items));
    for (const entry of keys)
      for (const reverseWorklist of [false, true]) {
        const got = withSolverSeam({ reverseWorklist }, () =>
          solveDemands(request, [entry, ...keys]).slice(1),
        ).map(answer);
        keys.forEach((key, index) => {
          if (got[index] !== expected[index])
            differing.push(`${name}: ${key} from ${entry}${reverseWorklist ? " reversed" : ""}`);
        });
      }
  }
  return { components: solved.length, differing };
}

test("every component is solved alike from each member as the entry and in either order", () => {
  let components = 0;
  const differing: string[] = [];
  for (const { name, request } of requests) {
    const found = componentDifferences(name, request);
    components += found.components;
    differing.push(...found.differing);
  }
  assert.ok(components > 0, "the set produces components");
  assert.deepEqual(differing, []);
});

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
 * r4.47 (1), r4.44, S3 §1 (Astra's R2-B1 on #1028): a method without a category answers per receiver alternative, and a
 * receiver without items yet is a provisional bottom, no answer: the method's result stays the bottom, which the solver
 * completes, so no `external` reason enters a component from it. A chain round its own component (a self-update, a
 * record's field updated from itself, a loop, two functions) gives the same record in every order combination
 * (consumers × worklist) and the same answers from every component entry, its unknowns opaque.
 */
const METHOD_CYCLES: readonly (readonly [string, string, string])[] = [
  [
    "a self-update",
    'let s = "a"\nif askBoolean "f" { s = s.trimStart() }\nlet n: integer = s.trimEnd()\nexit',
    "s.trimEnd()",
  ],
  [
    "a record's field updated from itself",
    'let r = {s: "a"}\nif askBoolean "f" { r.s = r.s.trimStart() }\nlet n: integer = r.s.trimEnd()\nexit',
    "r.s.trimEnd()",
  ],
  [
    "a loop",
    'let s = "a"\nrepeat 3 { s = s.trimStart() }\nlet n: integer = s.trimEnd()\nexit',
    "s.trimEnd()",
  ],
  [
    "two functions",
    'function f(x) {\nif x > 0 { return g(x - 1).trimStart() }\nreturn "a"\n}\nfunction g(x) { return f(x).trimEnd() }\nlet n: integer = f(3)\nexit',
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
 * Programs whose receiver gains a reference kind only round its own cycle (r4.44), whose receiver holds a reference from
 * outside the cycle beside a record, a nested record or an external leaf round it (B2, B2-r2), and the record-only
 * control, with their diagnostics (a class `warning-runtime-check` unless written). A return that may not fit the result
 * its function's first return decides owes C1's check (A2, F23), at the result and at each path of the first return's
 * literal (A8); the record-only control's, which none of its kinds fits, is an error (ADR 0021 1.5).
 */
const REFERENCE_CYCLES: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "a record holding a reference, read through two functions",
    `${NARRATOR}function g(flag: boolean) {\n  if flag { return {custom: narrator} }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return g(true).custom }\n  return g(false).custom\n}\nrepeat f(false) {}\nexit`,
    [
      "integer-use f(false)",
      "member-read g(false)",
      "member-read g(true)",
      "written-target f(true)",
    ],
  ],
  [
    "the same in the other declaration order",
    `${NARRATOR}function f(flag: boolean) {\n  if flag { return g(true).custom }\n  return g(false).custom\n}\nfunction g(flag: boolean) {\n  if flag { return {custom: narrator} }\n  return f(true)\n}\nrepeat f(false) {}\nexit`,
    [
      "integer-use f(false)",
      "member-read g(false)",
      "member-read g(true)",
      "written-target f(true)",
    ],
  ],
  [
    "a list holding a reference, its method's result returned",
    `${NARRATOR}function f(flag: boolean) {\n  if flag { return [narrator] }\n  return f(true).removeFirst()\n}\nrepeat f(false) {}\nexit`,
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read f(true)",
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
      "member-read g(true)",
      "member-read g(true)",
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
      "member-read f(true)",
      "member-read f(true)",
      "written-target f(true).custom",
    ],
  ],
  [
    "a reference from outside the cycle beside a nested record round it",
    "speaker narrator { custom: 1 }\nfunction g(flag: boolean) {\n  if flag { return narrator }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return {custom: {custom: 1}} }\n  return g(true).custom\n}\nrepeat f(false) {}\nexit",
    [
      "integer-use f(false)",
      "integer-use f(false)",
      "member-read g(true)",
      "member-read g(true)",
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
      "member-read g(true)",
      "member-read g(true)",
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
      "member-read g(true)",
      "member-read g(true)",
      "written-target f(true)",
      "written-target f(true)",
      "written-target g(true).custom",
    ],
  ],
  [
    "the record-only control",
    "function g(flag: boolean) {\n  if flag { return {custom: 2} }\n  return f(true)\n}\nfunction f(flag: boolean) {\n  if flag { return {custom: 1} }\n  return g(true).custom\n}\nrepeat f(false) {}\nexit",
    [
      "integer-use f(false)",
      "member-read g(true)",
      "written-target compile-error g(true).custom",
      "written-target f(true)",
    ],
  ],
];

/**
 * r4.44: F19a's test of a receiver is a decision of its component, made once on the completed open solve (every
 * receiver read as a record) and held for the second, so a reference that reaches its receiver only round its own cycle
 * makes the access opaque: a warning with its runtime obligations; a reference from outside the cycle keeps its ordinary
 * answer. B2, B2-r2: the stores through a receiver are followed only for its records and collections, its unknowns
 * projected with their own reasons and ingress and its references the runtime's, so the open solve is finite whatever
 * the leaf. On `2941d76d8` the first three stopped with `budget-error` (4 to 20 s at the real allowance); on
 * `30477f011` the fourth; on `5a10f3a27` the loaded and host leaves. Here, in the two orders: 1,498 and 1,518; 1,498 and
 * 1,502; 1,412 and 1,319; 1,871 and 1,568; 669 and 643; 3,078 and 2,575; 1,987 and 1,681; 1,877 and 1,576; the
 * record-only control 1,288 and 1,255 units.
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
  const want = [
    "integer-use warning-runtime-check f(true).custom.custom",
    "member-read warning-runtime-check f(true).custom",
  ];
  assert.deepEqual(got, [want, want]);
  const record = compactAnalysis(request);
  assert.deepEqual(
    record.diagnostics.map((d) => d.context),
    record.diagnostics.map(() => "unknown"),
  );
});
