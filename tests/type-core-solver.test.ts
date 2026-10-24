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
    [
      "a record read further",
      "function f(flag: boolean) {\n  if flag { return {custom: 1} }\n  return f(true).custom\n}\nrepeat f(false) {}\nexit",
      "warning-runtime-check",
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
