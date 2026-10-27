import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import type { FlowNode } from "../src/type-inference/core/flow-graph.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

/*
 * The program stop through the candidate route, in its three layers (the owner's D4, option a′, TABLE r4.54; the
 * runtime-check evidence rule of `docs/TESTING.md`): at a small test allowance the analysis stops, and the program still
 * compiles. The decision: a check that waits on the stop is moved to the runtime with the reason `budget`, one warning
 * says so, and a literal's error found by the finishing path stands. The plan: the moved check stands at its site. The
 * execution: a value that fits reaches the next effect; one that does not stops at the check.
 */

const OPTIONS = { globals: ["hostValue"] };

/** A stop in the setup: an allowance below what the program's size alone charges. */
const ALLOWANCE = 50;

/** `make` in the core's order and with its consumers' and solver's orders reversed: both, equal. */
function inBothOrders<T>(make: () => T): T {
  const forward = make();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), make),
  );
  assert.deepEqual(reversed, forward);
  return forward;
}

/** The candidate route's compile of `source` under an allowance (the small one by default): diagnostics and plan. */
function compiled(source: string, allowance = ALLOWANCE) {
  return withTestAllowance(allowance, () =>
    inBothOrders(() => {
      const result = compileSourceWithBackend(source, OPTIONS, CORE_BACKEND);
      return {
        diagnostics: result.diagnostics.map(
          (d) => `${d.severity} ${d.code} @${d.span.start.offset}:${d.span.end.offset}`,
        ),
        plan: result.plan,
      };
    }),
  );
}

/** A plan's checked stores: each `typeCheck` (place and type) with the span of what holds it, sorted. */
function storeChecks(plan: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) for (const item of node) walk(item);
    else if (node !== null && typeof node === "object") {
      const fields = new Map(Object.entries(node));
      if (fields.get("typeCheck") !== undefined)
        out.push(JSON.stringify([fields.get("span") ?? null, fields.get("typeCheck")]));
      for (const value of fields.values()) walk(value);
    }
  };
  walk(plan);
  return out.sort();
}

/** A run of a plan to its end with `hostValue`: what it said and where it failed. */
function ran(
  plan: NonNullable<ReturnType<typeof compiled>["plan"]>,
  hostValue: SerializableRuntimeValue,
) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  };
}

test("a check the stop moves to the runtime is decided, planned and run, in both orders (D4 a′)", () => {
  const source = 'let v: integer = hostValue\nsay "AFTER"\nexit\n';
  const value = source.indexOf("hostValue");
  // the decision: the store's check with the reason `budget`, and one warning
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const decided = withTestAllowance(ALLOWANCE, () =>
    inBothOrders(() => {
      const answers = analyseCore(request);
      return {
        exhausted: answers.budget.exhausted,
        moved: answers.budget.deferred.map(
          (d) =>
            `${d.obligation.kind} ${d.obligation.target} [${d.obligation.against.join(", ")}] ` +
            `@${d.site.start} ${d.provenance.context}`,
        ),
      };
    }),
  );
  assert.deepEqual(decided, {
    exhausted: "work",
    moved: [`copy-type v [integer] @${value} budget`],
  });
  const { diagnostics, plan } = compiled(source);
  // (the warning and the mark at the first moved check, the program's top level its heaviest place)
  assert.deepEqual(diagnostics, [
    `info TSV076 @${value}:${value + 9}`,
    `warning TSV076 @${value}:${value + 9}`,
  ]);
  // the plan: valid, its store checked exactly as the unstopped compile's (place, type, span)
  assert.ok(plan !== null);
  assert.deepEqual(validateInstructionPlan(plan).errors, []);
  const unstopped = compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).plan;
  assert.ok(unstopped !== null);
  assert.deepEqual(storeChecks(plan), storeChecks(unstopped));
  assert.equal(storeChecks(plan).length, 1);
  // the execution: a whole number reaches the next effect, a fraction stops at the store's check, its exact span
  assert.deepEqual(ran(plan, 1), { said: ["AFTER"], failure: null });
  assert.deepEqual(ran(plan, 1.5), { said: [], failure: `TSR058@${value}:${value + 9}` });
  const failed = ran(plan, 1.5);
  assert.deepEqual(failed.said, []);
  assert.match(failed.failure ?? "", /^TSR058@/u);
});

test("a literal's error the stop does not hide stands beside the moved check, in both orders", () => {
  const source = 'let k: integer = 1.5\nlet v: integer = hostValue\nsay "AFTER"\nexit\n';
  const literal = source.indexOf("1.5");
  const value = source.indexOf("hostValue");
  const { diagnostics, plan } = compiled(source);
  assert.equal(plan, null);
  assert.deepEqual(diagnostics, [
    `error TSV041 @${literal}:${literal + 3}`,
    `info TSV076 @${value}:${value + 9}`,
    `warning TSV076 @${value}:${value + 9}`,
  ]);
});

/** The allowance a source's analysis spends to its end: a stop at it falls in the route's questions after it. */
function analysisTotal(source: string): number {
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  return analyseCore(request).budget.total;
}

test("a stop in the route's questions after a finished analysis keeps its findings, decisions and checks", () => {
  // a type decided by a copy of a written one (A4): its store's check stands
  const inherited = 'let a: integer = 0\nlet b = a\nb = hostValue\nsay "AFTER"\nexit\n';
  const { plan } = compiled(inherited, analysisTotal(inherited));
  assert.ok(plan !== null);
  assert.deepEqual(ran(plan, 2), { said: ["AFTER"], failure: null });
  assert.match(ran(plan, "wrong").failure ?? "", /^TSR058@/u);
  // a decided record's fields, checked at its store
  const record = 'let b = {stats: {n: 1}}\nb = hostValue\nsay "AFTER"\nexit\n';
  const fields = compiled(record, analysisTotal(record)).plan;
  assert.ok(fields !== null);
  const stats = (n: SerializableRuntimeValue): SerializableRuntimeValue => ({
    kind: "object",
    properties: [
      { name: "stats", value: { kind: "object", properties: [{ name: "n", value: n }] } },
    ],
  });
  assert.deepEqual(ran(fields, stats(2)), { said: ["AFTER"], failure: null });
  assert.match(ran(fields, stats("wrong")).failure ?? "", /^TSR058@/u);
  // a literal's error, once
  const literal = 'let k: integer = 1.5\nlet n: integer = hostValue\nsay "AFTER"\nexit\n';
  const errors = compiled(literal, analysisTotal(literal)).diagnostics.filter((d) =>
    d.startsWith("error"),
  );
  assert.deepEqual(errors, [
    `error TSV041 @${literal.indexOf("1.5")}:${literal.indexOf("1.5") + 3}`,
  ]);
});

test("after a stop a typed parse still reads its JSON as its expected type and takes its default (F18)", () => {
  for (const source of [
    'let b: integer = fromJson(hostValue, default: 0)\nsay b\nsay "AFTER"\nexit\n',
    'let b: integer = fromJson(hostValue, default: 0, files: false)\nsay b\nsay "AFTER"\nexit\n',
    'let b = fromJson(hostValue, default: 0)\nsay b\nsay "AFTER"\nexit\n',
  ])
    for (const allowance of [1, analysisTotal(source)]) {
      const { plan } = compiled(source, allowance);
      assert.ok(plan !== null, `${source} @${allowance}`);
      assert.deepEqual(ran(plan, '"wrong"'), { said: ["0", "AFTER"], failure: null }, source);
      assert.deepEqual(ran(plan, "5"), { said: ["5", "AFTER"], failure: null }, source);
    }
});

test("after a stop a typed parse inside a typed default keeps its record's fields (F18)", () => {
  const source =
    'let b = fromJson(hostValue, default: {x: fromJson("{}", default: {n: 0})}, files: false)\nsay b.x.n\nsay "AFTER"\nexit\n';
  for (const allowance of [1, analysisTotal(source)]) {
    const { plan } = compiled(source, allowance);
    assert.ok(plan !== null, `@${allowance}`);
    assert.deepEqual(ran(plan, '{"x":{"n":2}}'), { said: ["2", "AFTER"], failure: null });
    assert.deepEqual(ran(plan, '{"x":{"n":"wrong"}}'), { said: ["0", "AFTER"], failure: null });
  }
});

test("after a stop a typed default's null leaves its level open, as without one (F18, ADR 0021 2.6)", () => {
  const source =
    "let b = fromJson(hostValue, default: {n: null, m: 0}, files: false)\nsay b.n\nsay b.m\nexit\n";
  for (const allowance of [1, analysisTotal(source)]) {
    const { plan } = compiled(source, allowance);
    assert.ok(plan !== null, `@${allowance}`);
    assert.deepEqual(ran(plan, '{"n":"text","m":4}'), { said: ["text", "4"], failure: null });
  }
});

test("after a stop a typed default's own literal and the call's expected type answer the same in any read order", () => {
  for (const [source, literal, path, call] of [
    [
      "let b = fromJson(hostValue, default: null, files: false)\nsay b\nexit\n",
      "null",
      [],
      ["null", "unknown"],
    ],
    [
      "let b = fromJson(hostValue, default: [null], files: false)\nsay b\nexit\n",
      "[null]",
      ["element"],
      ["unknown"],
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
    assert.ok(request !== null);
    for (const literalFirst of [true, false]) {
      const answers: Answers = withTestAllowance(1, () => analyseCore(request));
      const node = (text: string): FlowNode =>
        answers.graph.nodes.find(
          (found) =>
            found.kind === "expression" &&
            found.span !== null &&
            source.slice(found.span.start.offset, found.span.end.offset) === text,
        )!;
      const parse = node(source.slice(source.indexOf("fromJson"), source.indexOf(")") + 1));
      const own = node(literal);
      const tags = (at: FlowNode): string[] =>
        answers
          .valueAt(at, path)
          .items.map((item) => item.tag)
          .sort();
      const [first, second] = literalFirst ? [own, parse] : [parse, own];
      const answered = new Map([
        [first, tags(first)],
        [second, tags(second)],
      ]);
      assert.deepEqual(answered.get(own), ["null"], `${source} literal first: ${literalFirst}`);
      assert.deepEqual(
        answered.get(parse),
        [...call].sort(),
        `${source} literal first: ${literalFirst}`,
      );
    }
  }
});

/**
 * TABLE r4.90: what a phase settled is never discarded by a later one. A stop in a settled pass's walk or publication
 * keeps admission's contracts (an inferred scalar's, a record's), the findings (an error a copy brings, not a literal's)
 * and the quiet proofs, exactly as the unstopped compile has them: its diagnostics besides the stop's own, its plan's
 * checked stores (place, type, span), and the span a violating value fails at. The stop at the first unit of each such
 * phase and at its last, in both orders, with the sharing on and off (the every-unit sweep runs outside CI).
 */
test("a stop after admission settled keeps its contracts, findings and quiet proofs exactly", () => {
  const options = { globals: ["hostValue", "hostOther"] };
  const object = (props: Record<string, SerializableRuntimeValue>): SerializableRuntimeValue => ({
    kind: "object",
    properties: Object.entries(props).map(([name, value]) => ({ name, value })),
  });
  const cases: readonly (readonly [string, readonly SerializableRuntimeValue[]])[] = [
    ['let count = 1\ncount = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n', [2, 1.5]],
    [
      'let parcel = {count: 1}\nparcel = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n',
      [object({ count: 2 }), object({ count: 1.5 })],
    ],
    [
      'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n',
      [],
    ],
    ['let count = 2\nrepeat count {}\nlet n: integer = hostValue\nsay "DONE"\nexit\n', [2, 1.5]],
  ];
  for (const [source, values] of cases) {
    const request = coreRequest([{ path: "main.tease", source }], options.globals);
    assert.ok(request !== null);
    // the first and last unit of each settled phase: the stops below the total, down to the first that is not settled
    const total = analyseCore(request).budget.total;
    const stops = new Map<string, number[]>();
    for (let allowance = total - 1; allowance > 0; allowance -= 1) {
      const { stoppedIn, settled } = withTestAllowance(allowance, () =>
        analyseCore(request),
      ).budget;
      if (!settled || stoppedIn === null) break;
      stops.set(stoppedIn, [allowance, ...(stops.get(stoppedIn) ?? [])]);
    }
    assert.ok(stops.has("publication"), source);
    const compile = () => compileSourceWithBackend(source, options, CORE_BACKEND);
    const unstopped = compile();
    const shown = (result: ReturnType<typeof compile>): string[] =>
      result.diagnostics
        .filter((d) => d.code !== "TSV076")
        .map((d) => `${d.severity} ${d.code} @${d.span.start.offset}:${d.span.end.offset}`);
    const runs = (plan: NonNullable<ReturnType<typeof compile>["plan"]>) =>
      values.map((hostValue) => {
        const result = run(
          plan,
          createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue, hostOther: 2 } }),
        );
        const failure = result.events.find((event) => event.kind === "runtimeFailure");
        return failure?.kind === "runtimeFailure"
          ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
          : "none";
      });
    for (const [phase, allowances] of stops)
      for (const allowance of [allowances[0]!, allowances.at(-1)!])
        for (const sharing of [true, false]) {
          const result = withTestAllowance(allowance, () =>
            sharing ? inBothOrders(compile) : withoutSharing(() => inBothOrders(compile)),
          );
          const where = `${source} ${phase} @${allowance} sharing: ${sharing}`;
          if (phase === "publication") assert.deepEqual(shown(result), shown(unstopped), where);
          else
            for (const diagnostic of shown(unstopped))
              assert.ok(
                shown(result).includes(diagnostic) ||
                  result.diagnostics.some(
                    (d) =>
                      d.severity === "warning" &&
                      `@${d.span.start.offset}:${d.span.end.offset}` === diagnostic.split(" ")[2],
                  ),
                `${where}: ${diagnostic}`,
              );
          assert.equal(result.plan === null, unstopped.plan === null, where);
          if (result.plan !== null && unstopped.plan !== null) {
            assert.deepEqual(storeChecks(result.plan), storeChecks(unstopped.plan), where);
            assert.deepEqual(runs(result.plan), runs(unstopped.plan), where);
          }
        }
  }
});
