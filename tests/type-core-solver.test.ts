import assert from "node:assert/strict";
import test from "node:test";

import { createXorShift32State, nextXorShift32 } from "../src/runtime/random/random.js";
import { analyseCore, solveDemands } from "../src/type-inference/core/answers.js";
import {
  BudgetExhausted,
  joinParts,
  withTestAllowance,
} from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { exportNames } from "../src/type-inference/core/contract/key-ids.js";
import { keyOf } from "../src/type-inference/core/definitions.js";
import {
  ingressLeaves,
  itemsSignature,
  makeItem,
  mergeItems,
  REASON,
  STOPPED,
  writerKey,
  type Item,
} from "../src/type-inference/core/items.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import {
  Solver,
  withSolverSeam,
  type Demand,
  type Proof,
  type ProofDecision,
  type ProofDemand,
  type SolvedMember,
  type Work,
} from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { itemScope } from "./helpers/type-core-items.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";

/**
 * The determinism of the coarse core (ADR 0021 1.6; the port plan's S3 note §1): the answers depend on the program,
 * never on the order the analysis visits its consumers or discovers its demands. Every record of the expectation set
 * is analysed in four orders; every component of demands the set produces is solved again from each member as the
 * entry, in the canonical and the reverse order, and each member's answer compared by its items' signature and the
 * ingress stores its external items name.
 */

/** The set's requests, one per exact input (its files in order), each with the names of the records that give it. */
const requests = (() => {
  const byInput = new Map<string, { names: string[]; request: CoreAnalysisRequest }>();
  for (const record of readFixture()) {
    const input = JSON.stringify(record.files);
    const known = byInput.get(input);
    if (known !== undefined) known.names.push(record.name);
    else {
      const request = coreRequest(record.files);
      assert.ok(request !== null, `${record.name}: its files parse and resolve`);
      byInput.set(input, { names: [record.name], request });
    }
  }
  return [...byInput.values()];
})();

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
  for (const { names, request } of requests) {
    const forward = canonical(compactAnalysis(request));
    for (const [order, visit] of orders)
      if (canonical(withConsumerOrder(visit, () => compactAnalysis(request))) !== forward)
        differing.push(...names.map((name) => `${name} (${order})`));
  }
  assert.deepEqual(differing, []);
});

/** A member's answer as the component test compares it: its items' signature and their ingress stores. */
function answer(items: readonly Item[]): string {
  const stores = items
    .map((item) =>
      item.ingress === undefined ? "" : ingressLeaves(item.ingress).map(writerKey).join(","),
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
): {
  readonly components: number;
  readonly differing: readonly string[];
  /** The components holding a layer's summary (`protoLayer|`, #1466). */
  readonly layered: number;
} {
  const solved: {
    readonly members: readonly SolvedMember[];
    readonly replay: { readonly names: readonly string[]; readonly packet: unknown } | null;
  }[] = [];
  withSolverSeam({ onComponent: (members, replay) => solved.push({ members, replay }) }, () =>
    compactAnalysis(request),
  );
  const differing: string[] = [];
  let layered = 0;
  for (const { members, replay } of solved) {
    // (a cursor's name replayed through its component's packet, never by its ids: #1422 B1)
    const keys = replay?.names ?? members.map((member) => member.key);
    if (keys.some((key) => key.startsWith("protoLayer|"))) layered += 1;
    const expected = members.map((member) => answer(member.items));
    for (const entry of keys)
      for (const reverseWorklist of [false, true]) {
        const got = withSolverSeam({ reverseWorklist }, () =>
          solveDemands(request, [entry, ...keys], replay?.packet).slice(1),
        ).map(answer);
        keys.forEach((key, index) => {
          if (got[index] !== expected[index])
            differing.push(`${name}: ${key} from ${entry}${reverseWorklist ? " reversed" : ""}`);
        });
      }
  }
  return { components: solved.length, differing, layered };
}

test("every component is solved alike from each member as the entry and in either order", () => {
  let components = 0;
  const differing: string[] = [];
  for (const { names, request } of requests) {
    const found = componentDifferences(names.join(", "), request);
    components += found.components;
    differing.push(...found.differing);
  }
  assert.ok(components > 0, "the set produces components");
  assert.deepEqual(differing, []);
});

/**
 * #1466 (TABLE r4.225's B1, r4.227): a layer's summary is a demand named by its layer's origin and the path
 * (`protoLayer|alias|<place>||<path>`, `protoLayer|projected|<place>|<projection>|<path>` as their texts), never by a
 * number its pass allocated: Astra's B1 witness and sibling, and Sol's copy cycles through a list element, of nested
 * copies and below a projected prefix, each a component holding one.
 */
const LAYER_CYCLES: readonly string[] = [
  "let a = {g: hostValue}\nlet b = a\nb.g = a.g\na = b\nrepeat a.g {}\nexit",
  "let a = {g: hostValue}\nlet b = a\nlet c = b\na = c\nb.g = c.g\nc.g = a.g\nrepeat b.g {}\nexit",
  "let a = [{g: hostValue}]\nlet b = a\nb[0].g = a[0].g\na = b\nrepeat a[0].g {}\nexit",
  "let a = {g: {g: hostValue}}\nlet b = a\nlet c = b\nb.g.g = c.g.g\na = c\nrepeat a.g.g {}\nexit",
  "let root = {box: {g: 1}}\nroot.box.g = hostValue\nlet a = root.box\nlet b = a\nb.g = a.g\na = b\nrepeat a.g {}\nexit",
];

const layerRequest = (source: string): CoreAnalysisRequest => {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  return request;
};

test("a layer's summary in a copy cycle is solved alike from each member as the entry and in either order (#1466)", () => {
  for (const source of LAYER_CYCLES) {
    const found = componentDifferences(source, layerRequest(source));
    assert.ok(found.layered > 0, `${source}: a component holds a layer's summary`);
    assert.deepEqual(found.differing, []);
  }
});

/**
 * #1466: every finished layer summary is asked again in a fresh pass from its name and packet alone (`exportNames`,
 * `solveDemands`): its layer found again by its origin through that pass's own stores, after the producing pass met
 * other paths first, so no id of the one pass names anything in the other. A name of no origin kind and an origin
 * without a layer (the host value's place) are rejected, never answered by a guess.
 */
test("every finished layer summary is asked again in a fresh pass by its name and packet alone (#1466)", () => {
  const kinds = new Set<string>();
  const sources = [
    ...LAYER_CYCLES,
    "let d0 = {f: hostValue, g: 1}\nlet l0 = d0\nlet r0 = d0\nl0.g = hostValue\nlet d1 = l0\nd1 = r0\nlet l1 = d1\nlet r1 = d1\nl1.g = hostValue\nlet d2 = l1\nd2 = r1\nrepeat d2.g {}\nexit",
  ];
  for (const source of sources) {
    const request = layerRequest(source);
    const pass = narrowingPass(request);
    // (the producing pass's arena made other paths first)
    pass.contract.pathIdOf(["shifted", "first"]);
    for (const place of pass.program.places)
      if (place.kind.kind === "binding")
        for (const path of [["g"], ["element", "g"], ["g", "g"]])
          pass.solver.run(pass.contract.contractOf(keyOf(place.id, path)));
    for (const { key } of pass.solver.demandWork()) {
      if (!key.startsWith("protoLayer|")) continue;
      kinds.add(key.split("|")[1]!);
      const exported = exportNames(pass.contract, [key])!;
      const packet: unknown = JSON.parse(JSON.stringify(exported.packet));
      assert.equal(
        answer(solveDemands(request, exported.names, packet)[0]!),
        answer(pass.solver.answer(key)!),
        `${source}: ${key}`,
      );
      const [, kind, origin, path] = exported.names[0]!.split("|");
      assert.throws(
        () => solveDemands(request, [joinParts("protoLayer", "copied", origin!, path!)], packet),
        /No layer is written/,
      );
      // (the host value's place: no store makes a layer of it)
      const host = pass.program.places.find((place) => pass.program.isHost(place.id))!.id;
      assert.throws(
        () =>
          solveDemands(request, [joinParts("protoLayer", kind!, `${host}#0`, ".1")], {
            nodes: [[-1, "g"]],
            keys: [
              [host, -1],
              [0, 0],
            ],
          }),
        /No layer comes from/,
      );
    }
  }
  assert.deepEqual([...kinds].sort(), ["alias", "projected"]);
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
 * control, with their diagnostics (a class `warning-runtime-check` unless written; a member's at the whole access, TABLE
 * §3.4). A return that may not fit the result
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
  // (the member read at the whole access, its receiver included, TABLE §3.4)
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

/**
 * TABLE r4.164's proof payloads (`ProofDemand`): a proof is the solver's as a demand's items are. The tests' proofs
 * hold what was chosen (`null` for an absence), the kinds seen and a round counter; their signature is all three.
 */
interface Chosen extends Proof {
  readonly chosen: string | null;
  readonly tags: readonly string[];
  readonly n: number;
}

function chosen(choice: string | null, tags: readonly string[], n: number): Chosen {
  return {
    chosen: choice,
    tags,
    n,
    signature: (scope) => {
      scope.work.charge("sigItems");
      return `${choice ?? "-"}|${tags.join(",")}|${n}`;
    },
  };
}

/** A test's proof demand at `offset`, its run `make`. */
function proofDemand(
  key: string,
  offset: number,
  make: () => Work<{ readonly items: readonly Item[]; readonly proof: Chosen }>,
): ProofDemand<Chosen> {
  return { key, kind: "value", file: 0, offset, make, proves: true };
}

test("a finished proof is read with its answer by its first reader and by a later one, made once", () => {
  const scope = itemScope();
  const solver = new Solver(scope);
  let runs = 0;
  const producer = proofDemand("p", 0, function* () {
    runs += 1;
    scope.work.charge("invSteps", 100);
    return { items: [makeItem("integer")], proof: chosen("a", [], 0) };
  });
  const dependent: Demand = {
    key: "d",
    kind: "value",
    file: 0,
    offset: 1,
    *make() {
      const { items, proof } = yield* solver.proven(producer);
      return proof?.chosen === "a" ? [...items, makeItem("string")] : [];
    },
  };
  const read = solver.run(
    (function* (): Work<readonly Item[]> {
      return yield dependent;
    })(),
  );
  assert.deepEqual(
    read.map((item) => item.tag),
    ["integer", "string"],
  );
  const before = scope.work.total;
  const again = solver.run(solver.proven(producer));
  assert.equal(runs, 1);
  assert.equal(again.proof?.chosen, "a");
  assert.deepEqual(
    again.items.map((item) => item.tag),
    ["integer"],
  );
  // (the later read pays its lookup, not the producer's work, which stays its first reader's)
  assert.ok(scope.work.total - before < 100);
  assert.deepEqual(
    solver.demandWork().map(({ key, units }) => [key, units >= 100]),
    [
      ["p", true],
      ["d", true],
    ],
  );
});

/** A member's proof one round further, to `limit`: the kinds it read beside its own, the same items every round. */
function* counted(
  solver: Solver,
  self: () => ProofDemand<Chosen>,
  reads: readonly (() => Demand | ProofDemand<Chosen>)[],
  limit: number,
): Work<{ readonly items: readonly Item[]; readonly proof: Chosen }> {
  const own = (yield* solver.proven(self())).proof;
  const tags = new Set(own?.tags ?? []);
  let n = own === null ? 0 : Math.min(own.n + 1, limit);
  for (const read of reads) {
    const demand = read();
    if (demand.proves === undefined) for (const item of yield demand) tags.add(item.tag);
    else {
      const other = (yield* solver.proven(demand)).proof;
      for (const tag of other?.tags ?? []) tags.add(tag);
      n = Math.max(n, other?.n ?? 0);
    }
  }
  return { items: [makeItem("integer")], proof: chosen("a", [...tags].sort(), n) };
}

/** Every member's finished answer and proof signature, from each entry and in either order. */
function solvedFrom(
  entries: readonly string[],
  build: (solver: Solver) => ReadonlyMap<string, ProofDemand<Chosen>>,
): Set<string> {
  const got = new Set<string>();
  for (const entry of entries)
    for (const reverseWorklist of [false, true])
      withSolverSeam({ reverseWorklist }, () => {
        const scope = itemScope();
        const solver = new Solver(scope);
        const demands = build(solver);
        solver.run(solver.proven(demands.get(entry)!));
        const answers = [...demands.values()].map((demand) => {
          const { items, proof } = solver.run(solver.proven(demand));
          return `${demand.key}: ${items.map((item) => item.tag).join(",")} ${proof === null ? "none" : proof.signature(scope)}`;
        });
        got.add(answers.join("; "));
      });
  return got;
}

test("a component whose proofs change under unchanged items is solved to their fixed point, alike from each entry", () => {
  // p reads itself and q, q reads p: their items are the same each round, their proofs count to 3
  const got = solvedFrom(["p", "q"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "p",
      proofDemand("p", 0, () =>
        counted(solver, () => demands.get("p")!, [() => demands.get("q")!], 3),
      ),
    );
    demands.set(
      "q",
      proofDemand("q", 1, () =>
        counted(solver, () => demands.get("q")!, [() => demands.get("p")!], 0),
      ),
    );
    return demands;
  });
  assert.deepEqual([...got], ["p: integer a||3; q: integer a||3"]);
});

test("an enlarged component and a held decision start their proofs again from none", () => {
  // p reads itself, and once its own proof stands at 1 a new demand r that reads p: r joins p's component, which starts
  // again from bottom; alike from either entry and in either order
  const enlarged = solvedFrom(["p", "r"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "p",
      proofDemand("p", 0, function* () {
        const own = (yield* solver.proven(demands.get("p")!)).proof;
        const reads = own !== null && own.n >= 1 ? [() => demands.get("r")!] : [];
        return yield* counted(solver, () => demands.get("p")!, reads, 2);
      }),
    );
    demands.set(
      "r",
      proofDemand("r", 1, () =>
        counted(solver, () => demands.get("r")!, [() => demands.get("p")!], 0),
      ),
    );
    return demands;
  });
  assert.deepEqual([...enlarged], ["p: integer a||2; r: integer a||2"]);
  // s decides: open, `string` beside its input; held, its input alone. p's proof takes s's kinds beside its own: had
  // the held solve started from the open solve's proof, it would keep `string`
  const held = solvedFrom(["p"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    const s: Demand = {
      key: "s",
      kind: "value",
      file: 0,
      offset: 1,
      *make() {
        yield* solver.proven(demands.get("p")!);
        return [makeItem("integer")];
      },
      decision: {
        choose: (input) => (input.length > 0 ? "some" : "none"),
        answer: (choice, input) => (choice === null ? [...input, makeItem("string")] : input),
      },
    };
    demands.set(
      "p",
      proofDemand("p", 0, () => counted(solver, () => demands.get("p")!, [() => s], 0)),
    );
    return demands;
  });
  assert.deepEqual([...held], ["p: integer a|integer|0"]);
});

/** A proof decision that changes the proof alone: open, `open`; held, `held`; the items as the run gave them. */
const PROOF_CHOICE: ProofDecision<Chosen> = {
  choose: () => "held",
  answer: (choice, input) => ({
    items: input.items,
    proof: input.proof === null ? null : chosen(choice === null ? "open" : "held", [], 0),
  }),
};

test("a proof demand's own decision is held on its proof alone, in a component and outside one", () => {
  // q decides and reads p; p reads itself and q, taking q's choice into its kinds: the open and the held answers have
  // one set of items, so only their proofs tell the solve to start again with q's choice held (review r1's F1), and p
  // keeps none of the open solve's proof
  const got = solvedFrom(["p", "q"], (solver) => {
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "p",
      proofDemand("p", 0, function* () {
        const own = (yield* solver.proven(demands.get("p")!)).proof;
        const other = (yield* solver.proven(demands.get("q")!)).proof;
        const tags = new Set(own?.tags ?? []);
        if (other?.chosen !== undefined && other.chosen !== null) tags.add(other.chosen);
        return { items: [makeItem("integer")], proof: chosen("a", [...tags].sort(), 0) };
      }),
    );
    demands.set("q", {
      ...proofDemand("q", 1, function* () {
        yield* solver.proven(demands.get("p")!);
        return { items: [makeItem("integer")], proof: chosen("run", [], 0) };
      }),
      decision: PROOF_CHOICE,
    });
    return demands;
  });
  assert.deepEqual([...got], ["p: integer a|held|0; q: integer held||0"]);
  // outside a component the choice is made at once; after a stop an unfinished one reads its open answer, no proof
  const scope = itemScope();
  const alone: ProofDemand<Chosen> = {
    ...proofDemand("r", 0, function* () {
      return { items: [makeItem("integer")], proof: chosen("run", [], 0) };
    }),
    decision: PROOF_CHOICE,
  };
  const solver = new Solver(scope);
  assert.equal(solver.run(solver.proven(alone)).proof?.chosen, "held");
  scope.work.stop("work");
  const fresh = new Solver(scope);
  const stopped = fresh.run(fresh.proven(alone));
  assert.deepEqual([stopped.items, stopped.proof], [STOPPED, null]);
});

test("a stop at any unit keeps each proof only with its answer, finished, and runs nothing after it", () => {
  // f is finished first; p (a choice) and n (an absence) read each other; d reads both: at every stop each key reads
  // as it finished or as `STOPPED` with no proof, never a provisional proof, and a new solver (a new pass's) reads none
  const schedule = (solver: Solver, runs: Map<string, number>, returned: Map<string, Chosen>) => {
    const noted = (key: string, proof: () => Chosen): Chosen => {
      runs.set(key, (runs.get(key) ?? 0) + 1);
      const made = proof();
      returned.set(key, made);
      return made;
    };
    const demands = new Map<string, ProofDemand<Chosen>>();
    demands.set(
      "f",
      proofDemand("f", 0, function* () {
        return { items: [makeItem("integer")], proof: noted("f", () => chosen("f", [], 0)) };
      }),
    );
    demands.set(
      "p",
      proofDemand("p", 1, function* () {
        const other = (yield* solver.proven(demands.get("n")!)).proof;
        return {
          items: [makeItem("string")],
          proof: noted("p", () => chosen("p", [], Math.min((other?.n ?? 0) + 1, 3))),
        };
      }),
    );
    demands.set(
      "n",
      proofDemand("n", 2, function* () {
        const other = (yield* solver.proven(demands.get("p")!)).proof;
        return {
          items: [makeItem("string")],
          proof: noted("n", () => chosen(null, [], other?.n ?? 0)),
        };
      }),
    );
    demands.set(
      "d",
      proofDemand("d", 3, function* () {
        yield* solver.proven(demands.get("f")!);
        const p = (yield* solver.proven(demands.get("p")!)).proof;
        return {
          items: [makeItem("integer")],
          proof: noted("d", () => chosen("d", [], p?.n ?? 0)),
        };
      }),
    );
    return demands;
  };
  const read = (
    solver: Solver,
    demands: ReadonlyMap<string, ProofDemand<Chosen>>,
    scope: ReturnType<typeof itemScope>,
  ) =>
    [...demands.values()].map((demand) => {
      const { items, proof } = solver.run(solver.proven(demand));
      return `${demand.key}: ${itemsSignature(items, scope)} ${proof === null ? "none" : proof.signature(scope)}`;
    });
  const order = function* (
    solver: Solver,
    demands: ReadonlyMap<string, ProofDemand<Chosen>>,
  ): Work<void> {
    yield* solver.proven(demands.get("f")!);
    yield* solver.proven(demands.get("d")!);
  };
  // the unstopped run: every key's finished answer and proof, and the units it takes
  const full = itemScope();
  const unstopped = new Solver(full);
  const fullDemands = schedule(unstopped, new Map(), new Map());
  unstopped.run(order(unstopped, fullDemands));
  const units = full.work.total;
  const finished = read(unstopped, fullDemands, full);
  const stoppedLine = (key: string) => `${key}: ${itemsSignature(STOPPED, full)} none`;
  let provisional = 0;
  let atSlot = 0;
  for (let allowance = 0; allowance < units; allowance += 1) {
    const scope = itemScope(allowance);
    const solver = new Solver(scope);
    const runs = new Map<string, number>();
    const returned = new Map<string, Chosen>();
    const demands = schedule(solver, runs, returned);
    assert.throws(() => solver.run(order(solver, demands)), BudgetExhausted);
    scope.work.stop("work");
    const ran = JSON.stringify([...runs]);
    const got = read(solver, demands, scope);
    // (a stop with p and n each returned, neither kept; a stop at a proof's slot, the one charge of what the core keeps
    // here, its units beyond the slots of the proofs kept)
    const kept = got.filter((line) => !line.endsWith(" none")).length;
    if (returned.has("p") && returned.has("n") && got[1] === stoppedLine("p")) provisional += 1;
    if ((scope.work.counts().get("literalUnits") ?? 0) > kept) atSlot += 1;
    assert.equal(
      JSON.stringify([...runs]),
      ran,
      `allowance ${allowance}: nothing runs after the stop`,
    );
    got.forEach((line, at) =>
      assert.ok(
        line === finished[at] || line === stoppedLine([...demands.keys()][at]!),
        `allowance ${allowance}: ${line}`,
      ),
    );
    // (p and n, one component, are kept together or not at all)
    assert.equal(got[1] === finished[1], got[2] === finished[2], `allowance ${allowance}`);
    const fresh = new Solver(scope);
    assert.deepEqual(
      read(fresh, schedule(fresh, runs, returned), scope),
      [...demands.keys()].map(stoppedLine),
    );
    assert.equal(JSON.stringify([...runs]), ran);
  }
  assert.ok(provisional > 0, "some stop falls while p and n hold provisional proofs");
  assert.ok(atSlot > 0, "some stop falls at a proof's slot");
});
