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
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { planChecks, stopProblems, type Globals } from "./helpers/type-core-stop-oracle.js";

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
  // the plan: valid, every check it carries as the unstopped compile's (the store's: place, type, span)
  assert.ok(plan !== null);
  assert.deepEqual(validateInstructionPlan(plan).errors, []);
  const unstopped = compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).plan;
  assert.ok(unstopped !== null);
  assert.deepEqual(planChecks(plan), planChecks(unstopped));
  assert.deepEqual(
    [...planChecks(plan).keys()].filter((at) => at.startsWith("typeCheck|")).length,
    1,
  );
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

const object = (props: Record<string, SerializableRuntimeValue>): SerializableRuntimeValue => ({
  kind: "object",
  properties: Object.entries(props).map(([name, value]) => ({ name, value })),
});
const host = (hostValue: SerializableRuntimeValue, hostOther: SerializableRuntimeValue = 2) => ({
  hostValue,
  hostOther,
});

/**
 * TABLE r4.90, r4.99: what a phase settled is never discarded by a later one, and a stop owes what the unstopped
 * analysis owes, through the same consumers (the stop oracle, `helpers/type-core-stop-oracle.ts`). A stop in a settled
 * pass's walk or publication keeps admission's contracts (an inferred scalar's, a record's), the findings (an error a
 * copy brings, not a literal's), the quiet proofs and every check the plan carries (a default's against a written or
 * written element type, Astra's B1 of round 2; an `otherwise`'s). Each mode's phases found in that mode; the stop at
 * the first unit of each settled phase and at its last, its phase asserted (the every-unit sweep runs outside CI).
 * `marked`: the code of an obligation whose type a stop may leave undecided and the source text of its site, the first
 * after `after` (TABLE r4.100): where the stopped plan lacks its check, the stop marks it among its deferred warnings,
 * and it does so at one stop at least.
 */
function settledPhases(
  cases: readonly (readonly [string, readonly Globals[], readonly Globals[]])[],
  marked?: { readonly code: string; readonly after: string; readonly text: string },
): void {
  const options = { globals: ["hostValue", "hostOther"] };
  const modes = [
    { reversed: false, sharing: true },
    { reversed: true, sharing: true },
    { reversed: false, sharing: false },
    { reversed: true, sharing: false },
  ];
  for (const [source, fitting, violating] of cases)
    for (const { reversed, sharing } of modes) {
      const inMode = <T>(make: () => T): T => {
        const ordered = (): T =>
          reversed
            ? withSolverSeam({ reverseWorklist: true }, () =>
                withConsumerOrder((list) => [...list].reverse(), make),
              )
            : make();
        return sharing ? ordered() : withoutSharing(ordered);
      };
      const request = coreRequest([{ path: "main.tease", source }], options.globals);
      assert.ok(request !== null);
      const places = new CoreProgram(request).places;
      const analyse = (allowance: number): Answers =>
        withTestAllowance(allowance, () => inMode(() => analyseCore(request)));
      const compile = () => inMode(() => compileSourceWithBackend(source, options, CORE_BACKEND));
      // this mode's settled phases: the stops below its total, down to the first that is not settled
      const total = inMode(() => analyseCore(request)).budget.total;
      const stops = new Map<string, number[]>();
      for (let allowance = total - 1; allowance > 0; allowance -= 1) {
        const { stoppedIn, settled } = analyse(allowance).budget;
        if (!settled || stoppedIn === null) break;
        stops.set(stoppedIn, [allowance, ...(stops.get(stoppedIn) ?? [])]);
      }
      const where = `${source} reversed: ${reversed} sharing: ${sharing}`;
      // (a settled phase at least: a program without boundaries charges its publication nothing)
      assert.ok(stops.has("walk") || stops.has("publication"), where);
      const unstopped = compile();
      let marks = 0;
      for (const [phase, allowances] of stops)
        for (const allowance of [allowances[0]!, allowances.at(-1)!]) {
          const answers = analyse(allowance);
          assert.equal(answers.budget.stoppedIn, phase, `${where} @${allowance}`);
          const undecided = (place: string, path: readonly string[]): boolean => {
            const found = places.find((each) => `'${each.label}'` === place);
            return found !== undefined && answers.place(found.id, path).admitted.by === "undecided";
          };
          const deferred = answers.budget.deferred.map(
            (d) => `${d.code} ${d.site.start}:${d.site.end}`,
          );
          let problems = stopProblems({
            unstopped,
            stopped: withTestAllowance(allowance, compile),
            settled: true,
            exact: phase === "publication",
            deferred,
            undecided,
            fitting,
            violating,
          });
          const owed = problems.filter(
            (problem) =>
              problem.startsWith("lost fallbackCheck|") || problem.startsWith("violating "),
          );
          if (marked !== undefined && owed.length > 0) {
            const at = source.indexOf(marked.text, source.indexOf(marked.after));
            assert.ok(
              deferred.includes(`${marked.code} ${at}:${at + marked.text.length}`),
              `${where} ${phase} @${allowance}: ${owed.join(" | ")}`,
            );
            problems = problems.filter((problem) => !owed.includes(problem));
            marks += 1;
          }
          assert.deepEqual(problems, [], `${where} ${phase} @${allowance}`);
        }
      if (marked !== undefined) assert.ok(marks > 0, where);
    }
}

test("a stop after admission settled keeps its contracts, findings, quiet proofs and checks", () => {
  settledPhases([
    [
      'let count = 1\ncount = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n',
      [host(2)],
      [host(1.5)],
    ],
    [
      'let parcel = {count: 1}\nparcel = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n',
      [host(object({ count: 2 }))],
      [host(object({ count: 1.5 }))],
    ],
    [
      'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n',
      [],
      [],
    ],
    [
      'let count = 2\nrepeat count {}\nlet n: integer = hostValue\nsay "DONE"\nexit\n',
      [host(2)],
      [host(1.5)],
    ],
    [
      'let items: integer[] = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [host(2, 3)],
      [host("bad", 3)],
    ],
    [
      'let anchor = 4\nlet value = anchor otherwise hostValue\nsay value\nsay "AFTER"\nexit\n',
      [host(2, 3)],
      [host("bad", 3)],
    ],
  ]);
});

/**
 * The stop oracle itself (Codex r8's T1): a kept store check is kept whole, its place as well as its type. Changes to
 * the unstopped plan's check stand in for a stop that changed it.
 */
test("the stop oracle sees a store check's place, type or presence change", () => {
  const unstopped = compileSourceWithBackend(
    "let n: integer = hostValue\nexit\n",
    OPTIONS,
    CORE_BACKEND,
  );
  assert.ok(unstopped.plan !== null);
  const changed = (change: (holder: Record<string, unknown>) => void): typeof unstopped => {
    const plan = structuredClone(unstopped.plan);
    const pending: unknown[] = [plan];
    while (pending.length > 0) {
      const at = pending.pop();
      if (at === null || typeof at !== "object") continue;
      const holder = at as Record<string, unknown>;
      if (holder["typeCheck"] !== undefined) change(holder);
      pending.push(...Object.values(holder));
    }
    return { ...unstopped, plan };
  };
  const problems = (stopped: typeof unstopped): string[] =>
    stopProblems({
      unstopped,
      stopped,
      settled: true,
      exact: true,
      deferred: [],
      fitting: [],
      violating: [],
    });
  assert.deepEqual(problems(unstopped), []);
  for (const change of [
    (holder: Record<string, unknown>) => {
      holder["typeCheck"] = { ...(holder["typeCheck"] as object), place: "wrong target" };
    },
    (holder: Record<string, unknown>) => {
      holder["typeCheck"] = { ...(holder["typeCheck"] as object), type: { kind: "text" } };
    },
    (holder: Record<string, unknown>) => {
      delete holder["typeCheck"];
    },
  ])
    assert.notDeepEqual(problems(changed(change)), []);
});

/**
 * TABLE r4.99: the finishing path derives a unit's findings as the analysis does. A parameter whose `null` default
 * reaches a member read is an error (#1172's `defaultOf`); a walk stop before that read keeps the error, in both orders.
 * Functions are outside the candidate route: through the analysis.
 */
test("a stop in a settled walk keeps the error of a member read of a null default", () => {
  const source =
    'function show(item = null) {\n  say item.name\n}\nshow({name: "n0"})\nlet n: integer = hostValue\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const errors = (answers: Answers): string[] =>
    answers.diagnostics
      .filter((d) => d.class === "compile-error")
      .map((d) => `${d.code} ${d.site.start}:${d.site.end}`);
  const at = source.indexOf("item.name");
  for (const reversed of [false, true]) {
    const analyse = (allowance?: number): Answers => {
      const run = (): Answers => analyseCore(request);
      const ordered = (): Answers =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), run),
            )
          : run();
      return allowance === undefined ? ordered() : withTestAllowance(allowance, ordered);
    };
    assert.deepEqual(errors(analyse()), [`TSV043 ${at}:${at + "item.name".length}`]);
    // the settled walk's stops, from the last down to the first
    const walk: number[] = [];
    for (let allowance = analyse().budget.total - 1; allowance > 0; allowance -= 1) {
      const { stoppedIn, settled } = analyse(allowance).budget;
      if (!settled) break;
      if (stoppedIn === "walk") walk.push(allowance);
    }
    assert.ok(walk.length > 0, `reversed: ${reversed}`);
    for (const allowance of [walk[0]!, walk.at(-1)!])
      assert.deepEqual(errors(analyse(allowance)), errors(analyse()), `${reversed} @${allowance}`);
  }
});

/**
 * The same of an inferred list's default (`get`'s C10): its element type is first found by its own unit's read, so a walk
 * stop before that unit leaves the type the default is checked against undecided. The stop never loses the obligation
 * silently (TABLE r4.100): it marks it "not checked (budget)" at the default with its code; deciding the element at the
 * stop, to check it, is the per-demand fallback's step.
 */
test("a stop after admission settled marks an inferred list's default it leaves undecided", () => {
  settledPhases(
    [
      [
        'let items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
        [host(2, 3)],
        [host("bad", 3)],
      ],
      [
        "let anchor = 4\nlet value = anchor otherwise hostValue\nlet items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay value\nexit\n",
        [host(2, 3)],
        [host("bad", 3)],
      ],
    ],
    { code: "TSV041", after: "default:", text: "hostValue" },
  );
});
