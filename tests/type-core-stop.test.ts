import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { compileProject, compileSourceWithBackend } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers, type CorePass } from "../src/type-inference/core/answers.js";
import type { FlowNode } from "../src/type-inference/core/flow-graph.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { Contract } from "../src/type-inference/core/contract.js";
import { withTestAllowance, withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import { withConsumerOrder, withoutRecords } from "../src/type-inference/core/consumers.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam, type Proof, type ProofDemand } from "../src/type-inference/core/solver.js";
import { REASON, type Item } from "../src/type-inference/core/items.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import {
  heldFamily,
  heldProblems,
  heldStops,
  heldUnstopped,
  HELD_MODES,
  phaseEnds,
} from "./helpers/type-core-held-host.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";
import { inMode, keptErrors, MODES, stopIdentity } from "./helpers/type-core-oracles.js";
import { runGlobals } from "./helpers/type-core-route.js";
import {
  NAMED_EXCEPTIONS,
  stopProblems,
  type Globals,
  type StopRun,
} from "./helpers/type-core-stop-oracle.js";

/*
 * The program stop through the candidate route, in its three layers (the owner's D4, option a′, TABLE r4.54; the
 * runtime-check evidence rule of `docs/TESTING.md`): at a small test allowance the analysis stops, and the program still
 * compiles. The decision: a check that waits on the stop is moved to the runtime, with the reason its value gives (host
 * data its own, as unstopped: TABLE r4.126; a value the stop leaves undecided `budget`), one warning says so, and a
 * literal's error found by the finishing path stands. The plan: the moved check stands at its site. The
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
  // the decision: the store's check with the host data's own reason, and one warning
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
    moved: [`copy-type v [integer] @${value} unknown`],
  });
  const { diagnostics, plan } = compiled(source);
  // (the warning and the mark at the first moved check, the program's top level its heaviest place)
  assert.deepEqual(diagnostics, [
    `info TSV076 @${value}:${value + 9}`,
    `warning TSV076 @${value}:${value + 9}`,
  ]);
  // the plan: valid, the unstopped compile's whole (the store's check: place, type, span)
  assert.ok(plan !== null);
  assert.deepEqual(validateInstructionPlan(plan).errors, []);
  assert.deepEqual(plan, compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).plan);
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

/**
 * The answers' own setup after a finished analysis counts its work too (the parameters with several call sites, for
 * messages): a stop there is a question's, every finding kept, never an exception out of the analysis.
 */
test("a stop in the answers' setup after a finished analysis is a question's", () => {
  const source =
    "function make {\n  return {kept: 1}\n}\nlet mirror = make()\nmirror.absent = hostValue\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const unstopped = analyseCore(request);
  const stopped = withTestAllowance(unstopped.budget.total - 1, () => analyseCore(request));
  assert.equal(stopped.budget.stoppedIn, "questions");
  assert.deepEqual(
    stopped.diagnostics.filter((d) => d.code !== "TSV076").map(stopIdentity),
    unstopped.diagnostics.map(stopIdentity),
  );
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
      // (as unstopped: the parsed list may be empty)
      ["empty", "unknown"],
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
 * TABLE r4.90, r4.99, r4.108: what a phase settled is never discarded by a later one, and a stop changes nothing of the
 * unstopped compile but the records its deferred marks name (the stop oracle, `helpers/type-core-stop-oracle.ts`). A
 * stop in a settled pass's walk or publication keeps admission's contracts (an inferred scalar's, a record's), the
 * findings (an error a copy brings, not a literal's), the quiet proofs and the whole plan (a default's check against a
 * written or written element type, Astra's B1 of round 2; an `otherwise`'s). Each mode's phases found in that mode; the
 * stop at the first unit of each settled phase and at its last, its phase asserted (the every-unit sweep runs outside
 * CI). `marked`: the code of an obligation a stop may leave undecided and the source text of its site, the first after
 * `after` (TABLE r4.100): the stop marks it at one stop at least.
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
      const analyse = (allowance: number): Answers =>
        withTestAllowance(allowance, () => inMode(() => analyseCore(request)));
      const compile = () => inMode(() => compileSourceWithBackend(source, options, CORE_BACKEND));
      const both = () => ({ result: compile(), answers: inMode(() => analyseCore(request)) });
      const unstopped: StopRun = { ...both(), without: (omit) => withoutRecords(omit, both) };
      // this mode's settled phases: the stops below its total, down to the first that is not settled
      const stops = phaseEnds(unstopped.answers.budget.total, (allowance) => {
        const { stoppedIn, settled } = analyse(allowance).budget;
        return settled ? stoppedIn : null;
      });
      const where = `${source} reversed: ${reversed} sharing: ${sharing}`;
      // (a settled phase at least: a program without boundaries charges its publication nothing)
      assert.ok(stops.has("walk") || stops.has("publication"), where);
      // (the marked obligation's code and site)
      const start = marked && source.indexOf(marked.text, source.indexOf(marked.after));
      const site = marked && `${marked.code} ${start}:${start! + marked.text.length}`;
      let marks = 0;
      for (const [phase, ends] of stops)
        for (const allowance of ends) {
          const answers = analyse(allowance);
          assert.equal(answers.budget.stoppedIn, phase, `${where} @${allowance}`);
          if (
            answers.budget.deferred.some((d) => `${d.code} ${d.site.start}:${d.site.end}` === site)
          )
            marks += 1;
          assert.deepEqual(
            stopProblems({
              unstopped,
              stopped: {
                result: withTestAllowance(allowance, compile),
                answers,
                without: (omit) => withTestAllowance(allowance, () => withoutRecords(omit, both)),
              },
              fitting,
              violating,
            }),
            [],
            `${where} ${phase} @${allowance}`,
          );
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
    // a domain is not the value's kinds (TABLE r4.105): `integer?` copied where the value is only `null` imposes no
    // family on the fallback, so a text fallback still runs (Codex r9's B1)
    [
      'let v: integer? = null\nlet a = {v:v}\nlet b = a\nlet c = b.v\nsay c otherwise hostValue\nsay "AFTER"\nexit\n',
      [host("bad", 3)],
      [],
    ],
  ]);
});

/** A compile of `source` and its analysis, under an allowance where one is given. */
function stopRun(source: string, allowance?: number): StopRun {
  const options = { globals: ["hostValue", "hostOther"] };
  const request = coreRequest([{ path: "main.tease", source }], options.globals);
  assert.ok(request !== null);
  const allowed = <T>(make: () => T): T =>
    allowance === undefined ? make() : withTestAllowance(allowance, make);
  const both = () => ({
    result: compileSourceWithBackend(source, options, CORE_BACKEND),
    answers: analyseCore(request),
  });
  return { ...allowed(both), without: (omit) => allowed(() => withoutRecords(omit, both)) };
}

/** `stopRun` made inside `mode` (orders, allowances), its omissions run again inside it (`stopProblems` asks them). */
function stopRunIn(mode: <T>(make: () => T) => T, source: string, allowance?: number): StopRun {
  const run = mode(() => stopRun(source, allowance));
  return { ...run, without: (omit, key) => mode(() => run.without(omit, key)) };
}

/** A source's settled phases, each with its lowest and highest stopping allowance (`phaseEnds`). */
function settledEnds(source: string): Map<string, readonly [number, number]> {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  return phaseEnds(analyseCore(request).budget.total, (allowance) => {
    const { stoppedIn, settled } = withTestAllowance(allowance, () => analyseCore(request)).budget;
    return settled ? stoppedIn : null;
  });
}

/** The lowest and highest allowance of a source's settled walk stops. */
function walkEnds(source: string): readonly [number, number] {
  const walk = settledEnds(source).get("walk");
  assert.ok(walk !== undefined, source);
  return walk;
}

/**
 * The highest allowance at which a source's analysis stops before admission settled: below its total where none settles.
 */
function lastUnsettled(source: string): number {
  const lows = [...settledEnds(source).values()].map(([low]) => low);
  return (lows.length > 0 ? Math.min(...lows) : analysisTotal(source)) - 1;
}

/**
 * The stop oracle itself (TABLE r4.108 (1)): the whole plan, a mark excusing only its own record. Changes to a compile
 * stand in for a stop that made them: a store check's place, type or presence (Codex r8's T1), a property store's
 * guard (Astra r3's T1), alone and beside the mark of a default the stop left undecided, the diagnostics' order and a
 * coordinate of one (Codex r12's T1).
 */
test("the stop oracle sees every change no mark of the stop names", () => {
  // `edit` applied to every node of the plan, changing one at least
  const edited = (each: StopRun, edit: (node: unknown) => boolean): StopRun => {
    const plan = structuredClone(each.result.plan);
    let changed = 0;
    const pending: unknown[] = [plan];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || typeof node !== "object") continue;
      if (edit(node)) changed += 1;
      pending.push(...Object.values(node));
    }
    assert.ok(changed > 0);
    return { ...each, result: { ...each.result, plan } };
  };
  // (the store's check is `{type: {kind: "integer"}, place: "'n'"}`; `undefined` removes it)
  const typeCheck =
    (check: unknown) =>
    (node: unknown): boolean => {
      if (node === null || typeof node !== "object" || !("typeCheck" in node)) return false;
      node.typeCheck = check;
      return true;
    };
  const withoutGuard = (node: unknown): boolean => {
    if (node === null || typeof node !== "object" || !("requireExisting" in node)) return false;
    delete node.requireExisting;
    return true;
  };
  const problems = (unstopped: StopRun, stopped: StopRun, violating: readonly Globals[] = []) =>
    stopProblems({ unstopped, stopped, fitting: [], violating });
  const store = stopRun("let n: integer = hostValue\nexit\n");
  assert.deepEqual(problems(store, store), []);
  for (const edit of [
    typeCheck({ type: { kind: "integer" }, place: "wrong target" }),
    typeCheck({ type: { kind: "text" }, place: "'n'" }),
    typeCheck(undefined),
  ])
    assert.notDeepEqual(problems(store, edited(store, edit)), []);
  const vessel = stopRun('let vessel = hostValue\nvessel.amount = 4\nsay "AFTER"\nexit\n');
  assert.deepEqual(problems(vessel, vessel), []);
  assert.notDeepEqual(problems(vessel, edited(vessel, withoutGuard)), []);
  // a walk stop marks the default (r4.100), which excuses its own check and not the guard
  const source =
    'let nums: number?[] = [null,1.25]\nlet pack={nums:nums}\nlet twin=pack\nsay twin.nums.get(4, default:hostValue)\nlet vessel=hostOther\nvessel.amount=4\nsay "AFTER"\nexit\n';
  const unstopped = stopRun(source);
  const stopped = stopRun(source, walkEnds(source)[0]);
  const fallback = source.indexOf("hostValue");
  assert.ok(
    stopped.answers.budget.deferred.some((d) => d.code === "TSV041" && d.site.start === fallback),
  );
  const violating = [host(2.5, object({ other: 2 }))];
  assert.deepEqual(problems(unstopped, stopped, violating), []);
  const unguarded = problems(unstopped, edited(stopped, withoutGuard), violating);
  assert.ok(
    unguarded.some((problem) => problem.includes("requireExisting")),
    unguarded.join(" | "),
  );
  assert.ok(
    unguarded.some((problem) => problem.startsWith("violating ")),
    unguarded.join(" | "),
  );
  // the diagnostics whole, in their published order: the order, and a coordinate of a span (Codex r12's T1)
  assert.ok(unstopped.result.diagnostics.length > 1);
  const diagnostics = (list: typeof unstopped.result.diagnostics): StopRun => ({
    ...unstopped,
    result: { ...unstopped.result, diagnostics: list },
  });
  assert.notDeepEqual(
    problems(unstopped, diagnostics([...unstopped.result.diagnostics].reverse())),
    [],
  );
  const [first, ...others] = unstopped.result.diagnostics;
  assert.ok(first !== undefined);
  for (const span of [
    { ...first.span, start: { ...first.span.start, line: first.span.start.line + 1 } },
    { ...first.span, end: { ...first.span.end, column: first.span.end.column + 1 } },
  ])
    assert.notDeepEqual(problems(unstopped, diagnostics([{ ...first, span }, ...others])), []);
});

/**
 * Before admission settled a written store's mark stands for its records within its value (TABLE r4.152 (1), r4.111): a
 * literal holding an element admission left undecided (`v = [kept]`) is marked at the literal, while unstopped its
 * TSV041 stands at the element; the oracle excuses that record, and the same record planted outside the value is still
 * reported.
 */
test("a written store's mark stands for its records within its value, and for none outside it", () => {
  const source = "let kept = 8.0\nlet v: integer[] = [1]\nv = [kept]\nexit\n";
  const unstopped = stopRun(source);
  const start = source.indexOf("[kept]");
  const error = unstopped.result.diagnostics.find((d) => d.code === "TSV041");
  assert.ok(error !== undefined && error.span.start.offset === start + 1);
  // the same record at the declaration's `[1]`, outside the store's value
  const outside = source.indexOf("[1]");
  const planted: StopRun = {
    ...unstopped,
    result: {
      ...unstopped.result,
      diagnostics: [
        {
          ...error,
          span: {
            ...error.span,
            start: { ...error.span.start, offset: outside },
            end: { ...error.span.end, offset: outside + 3 },
          },
        },
        ...unstopped.result.diagnostics,
      ],
    },
  };
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (mark) =>
          mark.rule.rule === "store" &&
          mark.rule.written &&
          mark.site.start === start &&
          mark.site.end === start + "[kept]".length,
      ),
      `@${allowance}`,
    );
    assert.deepEqual(
      stopProblems({ unstopped, stopped, fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
    assert.notDeepEqual(
      stopProblems({ unstopped: planted, stopped, fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
  }
});

/**
 * C5's record where the retained state decides its receiver's shape (TABLE r4.108 (2), Astra r3's N1): a store of a
 * property no source of its receiver has is an error at the literal the receiver copies, and a stop after admission
 * settled publishes it there, not a mark at the store.
 */
test("a stop after admission settled keeps the error at the literal a property store's receiver copies", () => {
  settledPhases([
    ["let original = {kept:1}\nlet mirror = original\nmirror.absent = hostValue\nexit\n", [], []],
  ]);
});

/**
 * Before admission settled nothing it decided stands, so the receiver's shape is undecided: the record stands as the
 * mark of the store that owes it, the one move of a record's site the oracle accepts, and only there (TABLE r4.108 (2)).
 */
test("a stop before admission settled marks a property store whose receiver's shape it leaves undecided", () => {
  const source =
    "let original = {kept:1}\nlet mirror = original\nmirror.absent = hostValue\nexit\n";
  const unstopped = stopRun(source);
  const literal = source.indexOf("{kept:1}");
  const store = source.indexOf("mirror.absent");
  assert.deepEqual(
    unstopped.answers.diagnostics.map((d) => `${d.class} ${d.code} ${d.site.start}`),
    [`compile-error TSV043 ${literal}`],
  );
  // a stop in the setup, and the last before admission settled
  for (const allowance of [ALLOWANCE, walkEnds(source)[0] - 1]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (d) => d.code === "TSV043" && d.site.start === store && d.site.end === store + 13,
      ),
      `@${allowance}`,
    );
    assert.deepEqual(
      stopProblems({ unstopped, stopped, fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
    // (claimed settled, the moved record is not accepted)
    const budget = { ...stopped.answers.budget, settled: true };
    assert.notDeepEqual(
      stopProblems({
        unstopped,
        stopped: { ...stopped, answers: { ...stopped.answers, budget } },
        fitting: [],
        violating: [],
      }),
      [],
      `@${allowance}`,
    );
  }
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
    // the settled walk's first and last stops
    const walk = phaseEnds(analyse().budget.total, (allowance) => {
      const { stoppedIn, settled } = analyse(allowance).budget;
      return settled ? stoppedIn : null;
    }).get("walk");
    assert.ok(walk !== undefined, `reversed: ${reversed}`);
    for (const allowance of walk)
      assert.deepEqual(errors(analyse(allowance)), errors(analyse()), `${reversed} @${allowance}`);
  }
});

/**
 * After a stop a read is answered from admission's retained state through the copy forest (S3 §5 revision 14), walked
 * finitely: round a cycle of copies whose member copies another's part (`b = a.next`, `a = b`) a path grows no step,
 * so a read below it finishes at every settled phase's ends instead of overflowing the native stack (Codex r9's B2).
 */
test("after a stop a read through a cycle of copies that would grow its path finishes", () => {
  const source =
    'let items: integer[] = [2,3]\nlet a = {xs: items, next: {xs: items}}\nlet b = a.next\na = b\nsay b.next.xs.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const analyse = (allowance: number): Answers =>
    withTestAllowance(allowance, () => analyseCore(request));
  const ends = phaseEnds(analyseCore(request).budget.total, (allowance) => {
    const { stoppedIn, settled } = analyse(allowance).budget;
    return settled ? stoppedIn : null;
  });
  assert.ok(ends.has("walk"));
  for (const pair of ends.values())
    for (const allowance of pair)
      assert.equal(analyse(allowance).outcome, "warning-runtime-check", `@${allowance}`);
});

/**
 * Read as the value for a fixed need, a domain says nothing of emptiness (TABLE r4.105): a copied written list that may
 * be empty keeps its selection's empty check at the settled walk's ends, in both orders. A call statement is outside
 * the candidate route: through the analysis.
 */
test("a stop keeps the empty check of a selection read through a copied written list", () => {
  const source =
    'let grow: boolean = hostValue\nlet a: integer[] = []\nif grow { a.add(2) }\nlet b = a\nsay b.first\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const at = source.indexOf("b.first");
  const owed = (answers: Answers): boolean =>
    [...answers.diagnostics, ...answers.budget.deferred].some(
      (d) => d.code === "TSV043" && d.site.start === at && d.site.end === at + "b.first".length,
    );
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
    assert.ok(owed(analyse()), `unstopped, reversed: ${reversed}`);
    const walk = phaseEnds(analyse().budget.total, (allowance) => {
      const { stoppedIn, settled } = analyse(allowance).budget;
      return settled ? stoppedIn : null;
    }).get("walk");
    assert.ok(walk !== undefined, `reversed: ${reversed}`);
    for (const allowance of walk) assert.ok(owed(analyse(allowance)), `${reversed} @${allowance}`);
  }
});

/**
 * The key's finished contract is a domain too (TABLE r4.106): `b.v` is only `null` at the read though `v` may hold an
 * integer later, so no stop gives the fallback the integer family (Codex r10's B1, a band inside the walk): at every
 * settled walk stop, in the source order, the text fallback still runs.
 */
test("no stop in a settled walk gives a fallback the family of its key's contract", () => {
  const source =
    'let v: integer? = null\nlet a = {v:v}\nlet b = a\nsay b.v otherwise hostValue\nv = 2\nsay "AFTER"\nexit\n';
  const unstopped = stopRun(source);
  const [low, high] = walkEnds(source);
  for (let allowance = low; allowance <= high; allowance += 1)
    assert.deepEqual(
      stopProblems({
        unstopped,
        stopped: stopRun(source, allowance),
        fitting: [host("good", 3)],
        violating: [],
      }),
      [],
      `@${allowance}`,
    );
});

/**
 * The same of an inferred list's default (`get`'s C10): its element type is first found by its own unit's read, so a walk
 * stop before that unit leaves the element's contract unfinished; the stores' syntax decides it (`[2, 3]`: integers,
 * TABLE r4.100), so the default keeps its check. A copied element type that admits `null` (`integer?[]`) is a domain that
 * leaves the default's family undecided (TABLE r4.105): the stop marks it "not checked (budget)" at the default.
 */
test("a stop after admission settled checks an inferred list's default by its stores' syntax", () => {
  settledPhases([
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
  ]);
});

test("a stop after admission settled marks a default whose element domain admits null", () => {
  settledPhases(
    [
      [
        'let items: integer?[] = [2,null]\nlet a = {xs: items}\nlet b = a\nsay b.xs.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
        [host(2, 3)],
        [host("bad", 3)],
      ],
    ],
    { code: "TSV041", after: "default:", text: "hostValue" },
  );
});

/**
 * Source 4 decides only what every store's syntax tells (r4.122): objects with other properties leave a read of one
 * undecided, which may find it missing (its check and warning, marked); a copy of a written place is checked by
 * admission's A4 against the type the copy inherits, from the copied value, so its store is marked, standing for that
 * record. At a stop in the setup and at the last before admission settled, the oracle finds nothing else.
 */
test("a stop before admission settled leaves to the analysis what a store's syntax does not tell", () => {
  for (const [source, fitting, violating] of [
    [
      'let flag: boolean = hostValue\nlet room = {n: 1}\nroom = {n: 1}\nif flag { room = {other: 0} }\nsay room.n\nsay "DONE"\nexit\n',
      host(false),
      host(true),
    ],
    [
      'let base: integer[]? = hostValue\nlet copy = base\nsay copy.length\nsay "AFTER"\nexit\n',
      host({ kind: "list", items: [1, 2] }),
      host(null),
    ],
  ] as const) {
    const unstopped = stopRun(source);
    for (const allowance of [ALLOWANCE, lastUnsettled(source)])
      assert.deepEqual(
        stopProblems({
          unstopped,
          stopped: stopRun(source, allowance),
          fitting: [fitting],
          violating: [violating],
        }),
        [],
        `${source} @${allowance}`,
      );
  }
});

/**
 * Before admission settled nothing it decided is read (TABLE r4.110 (3); A6: a later pass may admit a store this one
 * rejected): a store into an inferred place is marked at its site, its type undecided, and one into a written type
 * keeps its check and its boundary; at a stop in the setup and at the last before admission settled, the oracle finds
 * nothing else, the inferred store's check moved to the runtime with its mark.
 */
test("a stop before admission settled marks the stores into inferred places and keeps the written ones", () => {
  const source = 'let count = 1\ncount = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n';
  const unstopped = stopRun(source);
  const store = source.indexOf("hostValue");
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (d) =>
          d.code === "TSV041" &&
          d.site.start === store &&
          d.obligation.against.length === 1 &&
          d.obligation.against[0] === "unknown",
      ),
      `@${allowance}`,
    );
    assert.deepEqual(
      stopProblems({
        unstopped,
        stopped,
        fitting: [host(2, 3)],
        violating: [host(1.5, 3), host(2, 1.5)],
      }),
      [],
      `@${allowance}`,
    );
  }
});

/**
 * TABLE r4.135: before admission settled no syntax decision is made, so every store into an inferred place is marked at
 * its site whatever its literals give, a store the unstopped analysis rejects among them (its error stands for the
 * mark's content, r4.111); at a settled stop, as unstopped, the error stands. Disagreements of a scalar, a list, an
 * object and an object's nested field, an integer then a decimal (no error), and a later copy (`let m = n`), in both
 * orders, at a stop in the setup, the last stop before admission settled, the first after it and the last. Every stop
 * of every one in both orders, outside CI: 0 differing (13,542 analyses).
 */
test("before admission settled every store into an inferred place is marked, after it a rejection's error stands", () => {
  const tail = '\nsay n\nrepeat 2 { say "AFTER" }\nexit\n';
  const at = (source: string, text: string, skip = 0): number => source.indexOf(text) + skip;
  for (const [source, values] of [
    [
      'let n = 1\nn = "wrong"' + tail,
      [
        ["= 1", 2],
        ['"wrong"', 0],
      ],
    ],
    [
      'let n = [1]\nn = ["wrong"]' + tail,
      [
        ["[1]", 0],
        ['["wrong"]', 0],
      ],
    ],
    [
      'let n = {x: 1}\nn = {x: "wrong"}' + tail,
      [
        ["{x: 1}", 0],
        ['{x: "wrong"}', 0],
      ],
    ],
    [
      'let n = {x: {y: 1}}\nn = {x: {y: "wrong"}}' + tail,
      [
        ["{x: {y: 1}}", 0],
        ['{x: {y: "wrong"}}', 0],
      ],
    ],
    [
      "let n = 1\nn = 2.5" + tail,
      [
        ["= 1", 2],
        ["2.5", 0],
      ],
    ],
    [
      'let n = 1\nn = "wrong"\nlet m = n' + tail,
      [
        ["= 1", 2],
        ['"wrong"', 0],
        ["= n\n", 2],
      ],
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const sites = values.map(([text, skip]) => at(source, text, skip));
    const wrong = source.indexOf('"wrong"');
    for (const reversed of [false, true]) {
      const analyse = (allowance?: number): Answers => {
        const go = (): Answers =>
          allowance === undefined
            ? analyseCore(request)
            : withTestAllowance(allowance, () => analyseCore(request));
        return reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), go),
            )
          : go();
      };
      const errors = (answers: Answers): string[] =>
        answers.diagnostics
          .filter((d) => d.class === "compile-error")
          .map((d) => `${d.code} ${d.site.start}`);
      const unstopped = analyse();
      assert.deepEqual(errors(unstopped), wrong < 0 ? [] : [`TSV041 ${wrong}`], source);
      // (settledness is monotone in the allowance: the first settled stop by bisection)
      let [low, high] = [1, unstopped.budget.total - 1];
      while (low < high) {
        const mid = (low + high) >> 1;
        if (analyse(mid).budget.settled) high = mid;
        else low = mid + 1;
      }
      for (const allowance of [1, low - 1, low, unstopped.budget.total - 1]) {
        const stopped = analyse(allowance);
        const where = `${source} @${allowance}${reversed ? " reversed" : ""}`;
        assert.equal(stopped.budget.exhausted, "work", where);
        if (stopped.budget.settled) assert.deepEqual(errors(stopped), errors(unstopped), where);
        else {
          assert.deepEqual(errors(stopped), [], where);
          for (const site of sites)
            assert.ok(
              stopped.budget.deferred.some(
                (d) =>
                  d.code === "TSV041" &&
                  d.site.start === site &&
                  d.obligation.against.length === 1 &&
                  d.obligation.against[0] === "unknown",
              ),
              `${where}: a mark at ${site}`,
            );
        }
      }
    }
  }
});

/**
 * #1275 (Codex r7's B2 on #1310): a pass keys the stores below an own selection by the targets the pass before it gave,
 * and where its admission gives others the passes start again, so a stop before they do settles nothing (TABLE r4.110
 * (3)): its finishing path marks such a store as it marks every store into an inferred place, and the store's error
 * stands as that mark. Each own selection, both orders, each end of the first pass's walk.
 */
test("a stop before a store below an own selection takes its target settles nothing and marks the store", () => {
  const options = { globals: ["hostValue", "hostOther"] };
  const phases = ["setup", "admission", "walk", "publication"];
  for (const own of ["first", "last", "random"])
    for (const reversed of [false, true]) {
      const source = `let box = {${own}: {n: 1}}\nbox.${own}.n = "bad"\nsay "AFTER"\nexit\n`;
      const where = `${own} reversed: ${reversed}`;
      const inOrder = <T>(make: () => T): T =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), make),
            )
          : make();
      const request = coreRequest([{ path: "main.tease", source }], options.globals);
      assert.ok(request !== null);
      const both = () =>
        inOrder(() => ({
          result: compileSourceWithBackend(source, options, CORE_BACKEND),
          answers: analyseCore(request),
        }));
      const runAt = (allowance?: number): StopRun => {
        const allowed = <T>(make: () => T): T =>
          allowance === undefined ? make() : withTestAllowance(allowance, make);
        return { ...allowed(both), without: (omit) => allowed(() => withoutRecords(omit, both)) };
      };
      const unstopped = runAt();
      const value = source.indexOf('"bad"');
      assert.deepEqual(
        unstopped.answers.diagnostics
          .filter((d) => d.class === "compile-error")
          .map((d) => `${d.code} ${d.site.start}`),
        [`TSV041 ${value}`],
        where,
      );
      // (how far a stop at the allowance came: the passes started again, its phase in its pass)
      const reached = (allowance: number): number => {
        const { counts, stoppedIn } = withTestAllowance(allowance, () =>
          inOrder(() => analyseCore(request)),
        ).budget;
        return (counts.get("rejectPasses") ?? 0) * phases.length + phases.indexOf(stoppedIn ?? "");
      };
      const lowest = (at: number): number => {
        let [low, high] = [1, unstopped.answers.budget.total];
        while (low < high) {
          const middle = (low + high) >> 1;
          if (reached(middle) >= at) high = middle;
          else low = middle + 1;
        }
        return low;
      };
      const walk = phases.indexOf("walk");
      for (const allowance of [lowest(walk), lowest(walk + 1) - 1]) {
        assert.equal(reached(allowance), walk, `${where} @${allowance}`);
        const stopped = runAt(allowance);
        assert.equal(stopped.answers.budget.settled, false, `${where} @${allowance}`);
        assert.ok(
          stopped.answers.budget.deferred.some(
            (d) =>
              d.code === "TSV041" &&
              d.site.start === value &&
              d.obligation.against.length === 1 &&
              d.obligation.against[0] === "unknown",
          ),
          `${where} @${allowance}`,
        );
        assert.deepEqual(
          stopProblems({ unstopped, stopped, fitting: [], violating: [] }),
          [],
          `${where} @${allowance}`,
        );
      }
    }
});

/**
 * S3 §5 with #1275 (Codex r10's B1 on #1310): a store at a key whose decision stopped is an obligation the stop stands
 * for (`Consumers.#stoppedStores`), whichever pass stopped it: a pass that both stops a decision and gives new store
 * targets starts again with the key stopped, and the store keeps a mark there, through demand-only completion and a
 * settled program stop alike. Each own selection's invalid store beside a property's and a variable's, in both
 * orders with the sharing on and off, at half of each decision's demand: the completed analysis keeps each error as an
 * error or as a warning or a stop's mark with a check at its site, and adds none (against the unbounded analysis); and
 * where a pass started again, a program stop halfway through the analysis and at its end changes nothing the stop oracle
 * does not excuse (against the completed analysis at that demand allowance, as above). The generated family (every
 * decision's demand at several fractions, an add, a k = 64 joined list, work stops across the restarted pass) runs
 * outside CI.
 */
test("a store at a stopped decision's key keeps an obligation, whichever pass stopped it (S3 §5, #1275)", () => {
  const options = { globals: ["hostValue", "hostOther"] };
  const sources = [
    ...["first", "last", "random"].map((own) => `let box = {${own}: {n: 1}}\nbox.${own}.n = "bad"`),
    'let box = {inner: {n: 1}}\nbox.inner.n = "bad"',
    'let n = 1\nn = "bad"',
  ].map((body) => `${body}\nsay "DONE"\nexit\n`);
  const modes: readonly (readonly [string, <T>(make: () => T) => T])[] = [
    ["forward", (make) => make()],
    [
      "reversed",
      (make) =>
        withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder((list) => [...list].reverse(), make),
        ),
    ],
    ["forward, unshared", (make) => withoutSharing(make)],
    [
      "reversed, unshared",
      (make) =>
        withoutSharing(() =>
          withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), make),
          ),
        ),
    ],
  ];
  let combined = 0;
  for (const source of sources) {
    const request = coreRequest([{ path: "main.tease", source }], options.globals);
    assert.ok(request !== null);
    for (const [name, inMode] of modes) {
      const runAt = (demand: number | null, work: number | null): StopRun => {
        const allowed = <T>(make: () => T): T =>
          inMode(() => {
            const demanded = () =>
              demand === null ? make() : withTestDemandAllowance(demand, make);
            return work === null ? demanded() : withTestAllowance(work, demanded);
          });
        const both = () => ({
          result: compileSourceWithBackend(source, options, CORE_BACKEND),
          answers: analyseCore(request),
        });
        return { ...allowed(both), without: (omit) => allowed(() => withoutRecords(omit, both)) };
      };
      const unbounded = runAt(null, null);
      const errors = unbounded.answers.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => d.site.start);
      assert.ok(errors.length > 0, source);
      const demands = new Set(
        unbounded.answers.budget.decisions
          .filter((d) => d.units >= 2)
          .map((d) => Math.floor(d.units / 2)),
      );
      for (const demand of demands) {
        const where = `${name} @${demand}: ${source}`;
        const capped = runAt(demand, null);
        const { budget } = capped.answers;
        const kept = capped.answers.diagnostics
          .filter((d) => d.class === "compile-error")
          .map((d) => d.site.start);
        const marked = [
          ...capped.answers.diagnostics.filter((d) => d.class === "warning-runtime-check"),
          ...budget.deferred,
        ].map((d) => d.site.start);
        const checked = capped.answers.checks.map((check) => check.site.start);
        assert.deepEqual(
          errors.filter(
            (at) => !kept.includes(at) && !(marked.includes(at) && checked.includes(at)),
          ),
          [],
          `${where}: an error neither kept nor checked`,
        );
        assert.deepEqual(
          kept.filter((at) => !errors.includes(at)),
          [],
          `${where}: an error the unbounded analysis lacks`,
        );
        const stopPasses = budget.counts.get("stopPasses") ?? 0;
        if (stopPasses === 0 || budget.exhausted !== null) continue;
        if ((budget.counts.get("rejectPasses") ?? 0) > 0) combined += 1;
        // (a program stop halfway through the analysis and at its end)
        const total = budget.total;
        for (const work of [Math.floor(total / 2), total - 1])
          assert.deepEqual(
            stopProblems({
              unstopped: capped,
              stopped: runAt(demand, work),
              fitting: [],
              violating: [],
            }),
            [],
            `${where} #${work}`,
          );
      }
    }
  }
  // (a decision stop and new store targets in one pass: Codex r10's B1 shape)
  assert.ok(combined > 0);
});

/**
 * Before admission settled, a store marked with its type undecided stands for its records within its value and for the
 * errors it brought (TABLE r4.111): an object stored with host data inside it (Codex r8's copy of fields), a typed parse
 * inside a typed default, a copy whose conflict A2 finds where it meets the place (the error inside the store's value,
 * TABLE r4.131), and a copy whose conflict is reached only through a cycle of copies that adds steps (r4.154), its
 * error reported where it is read and naming the copy. Each rule only so far: the mark narrowed off the record, or the
 * error's store moved elsewhere, and the oracle reports the record. A2's checks run before the stop, so its records at
 * a literal of copies, a store, a relay inside a cycle of whole copies and a fed ring, and at a literal and a store of
 * copies of written bindings (Astra r1 N1), stand at an early and the latest unsettled stop as the unstopped analysis
 * publishes them, or as the marks' content.
 */
test("a store a stop before admission settled marks stands for its records within its value and the errors it brought", () => {
  const inner =
    'let a = {inner: {n: 1, title: "ok"}}\nlet b = a\nb = {inner: hostValue}\nsay b.inner.n\nsay b.inner.title\nexit\n';
  const copied =
    'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n';
  const read =
    'let a = {inner: {n: 1}}\na = a.inner\nlet bad = {n: "x"}\nlet copy = a\ncopy = bad\nsay copy.n\n' +
    "let n: integer = hostValue\nexit\n";
  const typed =
    'let value = fromJson(hostValue, default: {list: [{n: fromJson("3", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay "DONE"\nexit\n';
  const problems = (
    unstopped: StopRun,
    stopped: StopRun,
    fitting: readonly Globals[] = [],
    violating: readonly Globals[] = [],
  ) => stopProblems({ unstopped, stopped, fitting, violating });
  const fields = (n: SerializableRuntimeValue) => host(object({ n, title: "yes" }), 3);
  for (const [source, fitting, violating] of [
    [inner, [fields(2)], [fields(1.5)]],
    [copied, [], []],
    [read, [], []],
    [typed, [], []],
  ] as const) {
    const stopped = stopRun(source, ALLOWANCE);
    assert.equal(stopped.answers.budget.settled, false, source);
    assert.deepEqual(problems(stopRun(source), stopped, fitting, violating), [], source);
  }
  // the store's mark narrowed to its first character: the C1 warning inside its value is no longer its record
  const literal = inner.indexOf("{inner: hostValue}");
  const stopped = stopRun(inner, ALLOWANCE);
  const narrowed: StopRun = {
    ...stopped,
    answers: {
      ...stopped.answers,
      budget: {
        ...stopped.answers.budget,
        deferred: stopped.answers.budget.deferred.map((d) =>
          d.site.start === literal ? { ...d, site: { ...d.site, end: literal + 1 } } : d,
        ),
      },
    },
  };
  assert.notDeepEqual(problems(stopRun(inner), narrowed), []);
  // A2's witnesses (#1293), stopped early and at the latest unsettled unit
  for (const source of [
    'let a = {n: 1}\nlet b = {n: "x"}\nlet xs = [a, b]\nlet n: integer = hostValue\nexit\n',
    'let good = {n: 1}\nlet bad = {n: "x"}\nlet a = {inner: {inner: bad}}\nlet b = {inner: {inner: good}}\n' +
      'let c = b\nc = a\nsay "AFTER"\nb = c\na = b\nexit\n',
    'let good = {p0: 1, p1: 1}\nlet bad = {p0: "x", p1: "x"}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\na0 = a2\n' +
      "a2 = bad\nexit\n",
    'let w: integer = 1\nlet a = {n: w}\nlet b = {n: "x"}\nlet xs = [a, b]\nsay xs[0].n\nlet n: integer = hostValue\nexit\n',
    'let s: string = "x"\nlet a = {n: 1}\nlet b = {n: s}\nlet copy = a\ncopy = b\nsay copy.n\n' +
      "let n: integer = hostValue\nexit\n",
  ])
    for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
      const stopped = stopRun(source, allowance);
      assert.equal(stopped.answers.budget.settled, false, `${source} @${allowance}`);
      assert.deepEqual(problems(stopRun(source), stopped), [], `${source} @${allowance}`);
    }
  // the copy's error brought by another store than the marked one
  const unstopped = stopRun(read);
  const elsewhere: StopRun = {
    ...unstopped,
    answers: {
      ...unstopped.answers,
      diagnostics: unstopped.answers.diagnostics.map((d) =>
        d.class === "compile-error" && "rule" in d && d.rule.rule === "store"
          ? { ...d, rule: { ...d.rule, brought: { file: 0, start: 0, end: 3 } } }
          : d,
      ),
    },
  };
  assert.ok(
    unstopped.answers.diagnostics.some(
      (d) =>
        d.class === "compile-error" &&
        "rule" in d &&
        d.rule.rule === "store" &&
        d.rule.brought !== null,
    ),
  );
  assert.notDeepEqual(problems(elsewhere, stopRun(read, ALLOWANCE)), []);
});

/**
 * A host read's ingress is structural (TABLE r4.113, Codex r12's B1): whatever the script stores into the host global,
 * the read's external data meets its boundary check at any stop, settled or not; its kinds come from the read itself
 * only where the script stores at no path at or above it. At a stop in the setup each compile keeps every record but
 * the marks' own.
 */
test("a host read keeps its boundary check at a stop whatever the script stores into the host global", () => {
  for (const source of [
    "hostValue.n = 2\nexit\n",
    'hostValue.n = null\nsay hostValue.n otherwise "ok"\nexit\n',
    "hostValue.n = 2\nsay hostValue.n.x\nexit\n",
    "say hostValue.m\nhostValue.n = 2\nexit\n",
  ]) {
    const stopped = stopRun(source, ALLOWANCE);
    assert.equal(stopped.answers.budget.settled, false, source);
    assert.deepEqual(
      stopProblems({ unstopped: stopRun(source), stopped, fitting: [], violating: [] }),
      [],
      source,
    );
  }
});

/**
 * Before admission settled, a store into a written type checks each part of a collection literal the type reaches at the
 * part's own site, as A8 does (TABLE r4.117, Codex r12's final-check B2): a host read as a written list's element, a
 * host property the script stored, a nested list's element. At a stop in the setup and at the last before admission
 * settled, the oracle finds nothing.
 */
test("a stop before admission settled checks a written store's literal parts at their own sites", () => {
  for (const [source, fitting, violating] of [
    ["let xs: integer[] = [hostValue]\nexit\n", [host(2)], [host("bad")]],
    ["hostValue.n = 2\nlet xs: integer[] = [hostValue.n]\nexit\n", [host(object({ n: 1 }))], []],
    ["let xs: integer[][] = [[hostValue]]\nexit\n", [host(2)], [host("bad")]],
  ] as const) {
    const unstopped = stopRun(source);
    for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
      const stopped = stopRun(source, allowance);
      assert.equal(stopped.answers.budget.settled, false, `${source} @${allowance}`);
      assert.deepEqual(
        stopProblems({ unstopped, stopped, fitting, violating }),
        [],
        `${source} @${allowance}`,
      );
    }
  }
});

/**
 * TABLE r4.162 at a stop (Astra r3 on #1273): a fix's code holds the author's text only where no other diagnostic lies
 * in it, nor a region the stop left unchecked, its "not checked" mark's, where the checks it moved to the runtime stand
 * unreported; and after a stop no fix fact is proved (`Consumers.withFacts`), so an error's code is words. So a stop
 * never lets through code the unstopped analysis withholds: at stops across a grid of allowances (the setup,
 * admission's passes, the walk), every check and declaration a published diagnostic offers compiles where it is
 * pasted, one inside a marked region is words, also a check the stop publishes there, and a check just outside it
 * keeps its code. Each source declares a sibling the stop may hide: in the same statement (`ns + 1`, a null-returning
 * call), or elsewhere in its function.
 */
const UNCHECKED: readonly string[] = [
  'function hide(n) { return n }\nlet v: integer = hostValue\nlet ns: integer? = hide(null)\nlet xs: integer set = set["wrong", ns + 1]\nexit\n',
  'function bad { return null }\nlet v: integer = hostValue\nlet xs: integer set = set["wrong", bad() + 1]\nexit\n',
  'function f(n) {\n  let ys: integer set = set["wrong"]\n  say n + 1\n  return ys\n}\nlet xs: integer set = set["wrong"]\nsay f(hostValue)\nexit\n',
  'function f(n) {\n  let ys: integer set = set["wrong"]\n  say n + 1\n  return ys\n}\nlet ns = [1, null]\nsay ns[1] + 1\nsay f(hostValue)\nexit\n',
  // (a null check a stop publishes inside the function's unchecked region: words, the mark covering the region)
  "function f(n) {\n  let ms = [1, null]\n  say ms[1] + 1\n  say n + 1\n  return 1\n}\nsay f(hostValue)\nexit\n",
];

test("a stop's unchecked region gives words for a fix's code in it, never code it would hide (TABLE r4.162)", () => {
  const globals = { globals: ["hostValue", "hostOther"] };
  const phases = new Set<string>();
  let inside = 0;
  let warned = 0;
  let outside = 0;
  for (const source of UNCHECKED) {
    const request = coreRequest([{ path: "main.tease", source }], globals.globals);
    assert.ok(request !== null);
    const errorsOf = (code: string): string[] =>
      compileProject([{ path: "main.tease", source: code }], globals)
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => `${d.code}: ${d.message}`);
    const before = errorsOf(source);
    const pasted = new Map<string, string[]>();
    const total = analyseCore(request).budget.total;
    const analyses = [analyseCore(request)];
    for (let point = 1; point < 128; point += 1)
      analyses.push(
        withTestAllowance(Math.max(1, Math.round((total * point) / 128)), () =>
          analyseCore(request),
        ),
      );
    for (const answers of analyses) {
      if (answers.budget.stoppedIn !== null) phases.add(answers.budget.stoppedIn);
      const text = messageSource([source], answers.diagnostics);
      const regions = answers.diagnostics.flatMap((d) =>
        d.class === "not-checked-budget" ? [d.place.lines] : [],
      );
      for (const d of answers.diagnostics) {
        if (d.kind === "budget" || d.kind === "written-type") continue;
        const message = coreMessage(d, text);
        // (the text the form holds and replaces: a declaration's, else the line of the statement a check holds)
        const root = d.rule.rule === "store" ? (d.rule.root?.site ?? null) : null;
        const lineStart = source.lastIndexOf("\n", d.site.start - 1) + 1;
        const lineEnd = source.indexOf("\n", d.site.start);
        const held = root ?? { file: d.site.file, start: lineStart, end: lineEnd };
        const declared = /declare it as '([^']*)'/.exec(message)?.[1];
        const check = / as in '(if [^']*)'/.exec(message)?.[1];
        const keep = /as in '(let value = [^']*)', and check/.exec(message)?.[1];
        const form = root === null ? check : declared;
        const where = `${source} @${answers.budget.allowance}: ${message}`;
        const marked = regions.some((r) => r.start <= held.start && held.end <= r.end);
        if (marked) assert.equal(form, undefined, where);
        if (form === undefined) {
          if (marked) inside += 1;
          if (marked && d.class === "warning-runtime-check") warned += 1;
          continue;
        }
        if (regions.length > 0) outside += 1;
        const indent = /^\s*/.exec(source.slice(lineStart, lineEnd))![0];
        const fixed =
          root === null
            ? source.slice(0, lineStart) +
              indent +
              (keep === undefined ? "" : `${keep}\n${indent}`) +
              form +
              source.slice(lineEnd)
            : source.slice(0, root.start) + form + source.slice(root.end);
        let errors = pasted.get(fixed);
        if (errors === undefined) pasted.set(fixed, (errors = errorsOf(fixed)));
        assert.deepEqual(
          errors.filter((error) => !before.includes(error)),
          [],
          `${where}\n${fixed}`,
        );
      }
    }
  }
  assert.ok(
    ["setup", "admission", "walk"].every((phase) => phases.has(phase)),
    [...phases].join(),
  );
  assert.ok(
    inside > 0 && warned > 0 && outside > 0,
    `${inside} inside, ${warned} of them warnings, ${outside} outside`,
  );
});

/**
 * Before admission settled, a written store's literal parts take their collections from the written type and their
 * parts from the literal's syntax, never from the solver (TABLE r4.120, Codex r13's S1): a set's element, a dict's value,
 * a set inside a dict; and a stop changes no site, an error inside an add's literal staying at the add's argument
 * (TABLE r4.122 (d)). At a stop in the setup and at the last before admission settled, each error, its site, its rule's
 * steps and its first sentence equal the unstopped ones (`keptErrors`; the analysis: a written set or dict is outside the
 * candidate route).
 */
test("a stop before admission settled keeps a written store's errors whole, their collections and sites", () => {
  for (const source of [
    'let xs: integer set = set["wrong"]\nexit\n',
    'let d: integer dict = dict{a: "wrong"}\nexit\n',
    'let d: integer set dict = dict{a: set["wrong"]}\nexit\n',
    'let xs: integer[] set = set[]\nxs.add(["wrong"])\nexit\n',
    'let xs: integer dict set = set[]\nxs.add(dict{a: "wrong"})\nexit\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const errors = (answers: Answers) => keptErrors(answers, source);
    const unstopped = errors(analyseCore(request));
    assert.equal(unstopped.length, 1, source);
    for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
      const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
      assert.equal(stopped.budget.settled, false, `${source} @${allowance}`);
      assert.deepEqual(errors(stopped), unstopped, `${source} @${allowance}`);
    }
  }
});

/** The analysis of `source` unstopped, and at a stop in the setup and at the last before admission settled. */
function unsettledAnalyses(source: string): { unstopped: Answers; stopped: Answers[] } {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const stopped = [ALLOWANCE, lastUnsettled(source)].map((allowance) => {
    const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.equal(answers.budget.settled, false, `${source} @${allowance}`);
    return answers;
  });
  return { unstopped: analyseCore(request), stopped };
}

/**
 * Every walk of a literal's children asks `literalChildren` with its path's own step, so the step that reaches a dict
 * literal's values is read in one place (TABLE r4.122, Codex r14), and a written store's checks name its parts as the
 * written type does (`entry`, a dict's value). At a stop in the setup and at the last before admission settled (each
 * defect showed at every such stop; the every-stop sweep runs outside CI): a written dict's checks equal the unstopped
 * ones; a dict default's host data keeps its own boundary; a default's wrong text stays an error; a dict literal's value
 * answers its kind and properties.
 */
test("a stop before admission settled reads a dict literal's values as its syntax and the written type give them", () => {
  for (const source of [
    "let d: integer dict = dict{a: hostValue}\nexit\n",
    "let d: integer[] dict = dict{a: [hostValue]}\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    assert.ok(unstopped.checks.some((check) => check.target.includes("entry")));
    for (const answers of stopped) assert.deepEqual(answers.checks, unstopped.checks, source);
  }
  {
    const source =
      'let items = [dict{a: 1}]\nlet v = items.get(hostOther, default: dict{a: hostValue})\nsay v["a"]\nexit\n';
    const { unstopped, stopped } = unsettledAnalyses(source);
    const site = source.indexOf("hostValue");
    const boundary = unstopped.checks.find((check) => check.boundary && check.site.start === site);
    assert.ok(boundary !== undefined);
    for (const answers of stopped)
      assert.ok(answers.checks.some((check) => isDeepStrictEqual(check, boundary)));
  }
  {
    const source = 'let v = dict{a: 1}.get(hostOther, default: "wrong")\nsay v\nexit\n';
    const errors = (answers: Answers) => keptErrors(answers, source);
    const { unstopped, stopped } = unsettledAnalyses(source);
    assert.equal(errors(unstopped).length, 1);
    for (const answers of stopped) assert.deepEqual(errors(answers), errors(unstopped));
  }
  {
    const source = "let d = dict{a: {n: 1}}\nexit\n";
    const value = (answers: Answers) => {
      const literal = answers.graph.nodes.find(
        (node) => node.kind === "expression" && node.expression?.kind === "dictLiteral",
      );
      assert.ok(literal !== undefined);
      const found = answers.valueAt(literal, ["element"]);
      return {
        tags: found.items.map((item) => item.tag),
        properties: [...found.properties].sort(),
      };
    };
    const { unstopped, stopped } = unsettledAnalyses(source);
    assert.deepEqual(value(unstopped), { tags: ["object"], properties: ["n"] });
    for (const answers of stopped) assert.deepEqual(value(answers), value(unstopped));
  }
});

/**
 * After a stop a literal's composed questions (`valueAt`, `project`, `properties`) read a child its syntax leaves open as
 * the child's own read does, beside its known siblings, never `budget` where that read keeps a type (Astra r6 B1, TABLE
 * r4.144): a written child, a union's, a nullable's, at a stop before admission settled; a decided one at every settled
 * walk stop.
 */
test("after a stop a literal's composed questions read a child as its own read does, beside its siblings", () => {
  const composed = (answers: Answers, kind: string, step: string) => {
    const literal = answers.graph.nodes.find(
      (node) => node.kind === "expression" && node.expression?.kind === kind,
    );
    assert.ok(literal !== undefined);
    const tags = (items: readonly { readonly tag: string }[]) =>
      [...new Set(items.map((item) => item.tag))].sort();
    return {
      valueAt: tags(answers.valueAt(literal, [step]).items),
      project: tags(answers.project(literal, step === "element" ? "element" : { property: step })),
      properties:
        kind === "objectLiteral" ? tags(answers.properties(literal).get(step) ?? []) : null,
    };
  };
  for (const [source, kind, step, tags] of [
    ["let quantity: number = 3.5\nsay [quantity]\nexit\n", "listLiteral", "element", ["number"]],
    [
      'let quantity: number = 3.5\nsay [quantity, "x"]\nexit\n',
      "listLiteral",
      "element",
      ["number", "string"],
    ],
    [
      "let quantity: integer | boolean = 3\nsay [quantity]\nexit\n",
      "listLiteral",
      "element",
      ["boolean", "integer"],
    ],
    [
      "let quantity: integer? = 3\nsay {part: quantity}\nexit\n",
      "objectLiteral",
      "part",
      ["integer", "null"],
    ],
  ] as const)
    for (const answers of unsettledAnalyses(source).stopped)
      assert.deepEqual(
        composed(answers, kind, step),
        { valueAt: tags, project: tags, properties: kind === "objectLiteral" ? tags : null },
        source,
      );
  const source =
    "let quantity = 8.0\nif quantity is integer { quantity = 3.5\nlet observed: number = quantity\nsay [quantity] }\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const [low, high] = walkEnds(source);
  for (let allowance = low; allowance <= high; allowance += 1) {
    const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.deepEqual(
      composed(answers, "listLiteral", "element"),
      { valueAt: ["number"], project: ["number"], properties: null },
      `@${allowance}`,
    );
  }
});

/**
 * After a stop a typed call no store takes in keeps its boundary through a named default's written type, and is marked
 * where its default's type is undecided (an inferred variable, a call's result): a missing answer never declines it
 * silently (Astra r6 B2, TABLE r4.144). A written type wider than the value is no type for it (an `integer?` may hold
 * null alone, which leaves the level open; a `number` an integer; a union one member): no boundary the unstopped analysis
 * lacks, the call marked (Codex r22 B1).
 */
test("after a stop a typed call keeps its boundary through a named default, or is marked", () => {
  for (const source of [
    "let fallback: integer = 3\nsay fromJson(hostValue, default: fallback)\nexit\n",
    'let fallback: boolean = false\nsay load("key", default: fallback)\nexit\n',
    "let fallback: integer[] = [3]\nsay fromJson(hostValue, default: fallback)\nexit\n",
    'let fallback: object = {amount: 3}\nsay load("key", default: fallback)\nexit\n',
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const boundary = unstopped.checks.find((check) => check.boundary);
    assert.ok(boundary !== undefined, source);
    for (const answers of stopped)
      assert.ok(
        answers.checks.some((check) => isDeepStrictEqual(check, boundary)),
        source,
      );
  }
  for (const source of [
    "let fallback = 9\nsay fromJson(hostValue, default: fallback)\nexit\n",
    "function fallback { return 9 }\nsay fromJson(hostValue, default: fallback())\nexit\n",
  ]) {
    const site = { file: 0, start: source.indexOf("fromJson"), end: source.indexOf(")\nexit") + 1 };
    for (const answers of unsettledAnalyses(source).stopped)
      assert.ok(
        answers.budget.deferred.some(
          (mark) =>
            mark.obligation.target === "fromJson.result" && isDeepStrictEqual(mark.site, site),
        ),
        source,
      );
  }
  for (const source of [
    'let fallback: integer? = null\nsay load("key", default: fallback)\nexit\n',
    "let fallback: number = 3\nsay fromJson(hostValue, default: fallback)\nexit\n",
    "let fallback: integer | string = 3\nsay fromJson(hostValue, default: fallback)\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const call = source.indexOf("say ") + 4;
    for (const answers of stopped) {
      assert.ok(
        answers.checks.every(
          (check) =>
            !check.boundary || unstopped.checks.some((kept) => isDeepStrictEqual(kept, check)),
        ),
        source,
      );
      assert.ok(
        answers.budget.deferred.some((mark) => mark.site.start === call),
        source,
      );
    }
  }
});

/**
 * An element read a stop left unsettled is no proof of an element: a selection of a typed call whose named list default
 * the finishing read leaves open at its element owes C6's empty check as unstopped, or its mark, at a stop before
 * admission settled and in the settled walk (TABLE r4.144's matrix).
 */
test("after a stop a selection of a typed call with a named list default owes its empty check", () => {
  for (const source of [
    "let fallback: integer[] = [1]\nsay fromJson(hostValue, default: fallback).first\nexit\n",
    "let fallback = [1]\nsay fromJson(hostValue, default: fallback).first\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const check = unstopped.checks.find((found) => found.kind === "empty-check");
    assert.ok(check !== undefined, source);
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const settled = walkEnds(source).map((allowance): Answers =>
      withTestAllowance(allowance, () => analyseCore(request)),
    );
    for (const answers of [...stopped, ...settled])
      assert.ok(
        answers.checks.some((found) => isDeepStrictEqual(found, check)) ||
          answers.budget.deferred.some((mark) => mark.obligation.kind === "empty-check"),
        `${source} @${answers.budget.allowance}`,
      );
  }
});

/**
 * After a settled stop a read's answer takes the type admission gives its place as `place` does, a path admission decides
 * lazily among them (S3 §5, TABLE r4.152 (2)): at every settled walk stop, `src.first`'s `at` and `valueAt` hold the kinds
 * `place(src, ["element"])` admits, never `budget` (the matrix's 116).
 */
test("after a settled stop a read answers its place's lazily decided type, as place does", () => {
  const source =
    'let count: integer = 2\nlet base: integer[] = [1]\nlet src = [1, 2]\nsay src.first\nsay "DONE"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const at = source.indexOf("src.first");
  const [low, high] = walkEnds(source);
  for (let allowance = low; allowance <= high; allowance += 1) {
    const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
    const read = answers.graph.nodes.find(
      (node) =>
        node.expression?.kind === "propertyAccessExpression" && node.span?.start.offset === at,
    );
    assert.ok(read !== undefined);
    const answer = answers.at(read);
    assert.ok(answer !== null && answer.place !== null, `@${allowance}`);
    const admitted = answers.place(answer.place.id, answer.place.path).admitted;
    assert.equal(admitted.by, "decided", `@${allowance}`);
    const kinds = (items: readonly { readonly tag: string }[]) =>
      [...new Set(items.map((item) => item.tag).filter((tag) => tag !== "empty"))].sort();
    const expected = [...admitted.kinds].sort();
    assert.deepEqual(kinds(answer.items), expected, `@${allowance}`);
    assert.deepEqual(kinds(answers.valueAt(read, []).items), expected, `@${allowance}`);
  }
});

/**
 * A literal's composed questions read a child through the same sources as the child's own question (TABLE r4.158): at
 * every settled walk stop of Astra r7's three, a list, two objects deep and a copy's selection in a set, the literal's
 * element or property answers the selection's lazily decided `integer`, as the selection's own read does, never `budget`.
 */
test("after a settled stop a literal's composed questions answer a child's lazily decided type, as its own read does", () => {
  for (const [source, child, literal, kind, path] of [
    [
      "let basket = [2, 4]\nsay [basket.first]\nexit\n",
      "basket.first",
      "[",
      "listLiteral",
      ["element"],
    ],
    [
      "let basket = [2, 4]\nsay {outer: {inner: basket.first}}\nexit\n",
      "basket.first",
      "{outer",
      "objectLiteral",
      ["outer", "inner"],
    ],
    [
      "let basket = [2, 4]\nlet mirror = basket\nsay set[mirror.first]\nexit\n",
      "mirror.first",
      "set[",
      "setLiteral",
      ["element"],
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const nodeAt = (answers: Answers, offset: number, expression: string) => {
      const node = answers.graph.nodes.find(
        (each) =>
          each.kind === "expression" &&
          each.expression?.kind === expression &&
          each.span?.start.offset === offset,
      );
      assert.ok(node !== undefined, `${source} @${offset}`);
      return node;
    };
    const kinds = (items: readonly { readonly tag: string }[]) => {
      assert.ok(items.length > 0 && items.every((item) => item.tag !== "unknown"), source);
      return [...new Set(items.map((item) => item.tag).filter((tag) => tag !== "empty"))].sort();
    };
    const [low, high] = walkEnds(source);
    for (let allowance = low; allowance <= high; allowance += 1) {
      const answers: Answers = withTestAllowance(allowance, () => analyseCore(request));
      const own = answers.at(nodeAt(answers, source.indexOf(child), "propertyAccessExpression"));
      assert.ok(own !== null, `${source} @${allowance}`);
      assert.deepEqual(kinds(own.items), ["integer"], `${source} @${allowance}`);
      const outer = nodeAt(answers, source.indexOf(literal), kind);
      const composed = [answers.valueAt(outer, path).items];
      if (path.length === 1) composed.push(answers.project(outer, "element"));
      else {
        const inner = nodeAt(answers, source.indexOf("{inner"), "objectLiteral");
        composed.push(answers.project(inner, { property: "inner" }));
        composed.push(answers.properties(inner).get("inner") ?? []);
      }
      for (const items of composed)
        assert.deepEqual(kinds(items), ["integer"], `${source} @${allowance}`);
    }
  }
});

/**
 * A member read a stop left unsettled is no proof of the property either (C5, Codex r24 B1): a typed call's member its
 * default lacks keeps its TSV043 or its mark, from a literal and from a named default, at a stop before admission settled
 * and in the settled walk. A literal's own element is proof of one, settled or not (Codex r24 N1): `[count].first` owes no
 * empty check at a stop, as unstopped.
 */
test("after a stop an unsettled member read owes its check; a literal's own element needs none", () => {
  for (const source of [
    "say fromJson(hostValue, default: {n: 1}).missing\nexit\n",
    "let fallback = {n: 1}\nsay fromJson(hostValue, default: fallback).missing\nexit\n",
  ]) {
    const { unstopped, stopped } = unsettledAnalyses(source);
    const warning = unstopped.diagnostics.find((found) => found.code === "TSV043");
    assert.ok(warning !== undefined && "site" in warning, source);
    const { site } = warning;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const settled = walkEnds(source).map((allowance): Answers =>
      withTestAllowance(allowance, () => analyseCore(request)),
    );
    for (const answers of [...stopped, ...settled])
      assert.ok(
        answers.diagnostics.some((found) =>
          isDeepStrictEqual(stopIdentity(found), stopIdentity(warning)),
        ) ||
          answers.budget.deferred.some(
            (mark) => mark.code === "TSV043" && isDeepStrictEqual(mark.site, site),
          ),
        `${source} @${answers.budget.allowance}`,
      );
  }
  const source = "let count = 2\nsay [count].first\nexit\n";
  const { unstopped, stopped } = unsettledAnalyses(source);
  assert.ok(!unstopped.checks.some((found) => found.kind === "empty-check"));
  for (const answers of stopped) {
    assert.ok(!answers.checks.some((found) => found.kind === "empty-check"), source);
    assert.ok(
      !answers.budget.deferred.some((mark) => mark.obligation.kind === "empty-check"),
      source,
    );
  }
});

/**
 * A store marked with its type undecided stands for its records within its value on both sides alike (r4.111, TABLE
 * r4.122, Codex r14): a check there that the stopped analysis keeps as the unstopped one has it is that record, so a host
 * index read below the store is no extra check, at a stop in the setup and at the last before admission settled; a
 * check there that the unstopped analysis lacks, with or without the marks, is still reported.
 */
test("a marked store's records within its value are compared alike on both sides", () => {
  const source = "let items = [[1]]\nlet v = items[hostOther]\nsay v[0]\nexit\n";
  const unstopped = stopRun(source);
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.deepEqual(
      stopProblems({ unstopped, stopped, fitting: [host(2, 0)], violating: [host(2, 1.5)] }),
      [],
      `@${allowance}`,
    );
  }
  const stopped = stopRun(source, ALLOWANCE);
  const index = source.indexOf("hostOther");
  const boundary = stopped.answers.checks.find(
    (check) => check.boundary && check.site.start === index,
  );
  assert.ok(boundary !== undefined);
  const extra = { ...boundary, against: ["integer" as const] };
  const added = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: { ...each.answers, checks: [...each.answers.checks, extra] },
  });
  const problems = stopProblems({
    unstopped,
    stopped: { ...added(stopped), without: (omit, key) => added(stopped.without(omit, key)) },
    fitting: [],
    violating: [],
  });
  assert.deepEqual(problems, [`extra check ${JSON.stringify(extra)}`]);
});

/**
 * Before admission settled, a store into a written type is checked by admission's own C1, the derivation the analysis
 * runs unstopped, reading what the stop retained (TABLE r4.125, r4.126, Astra r4's B1): two wrong elements give one
 * error, a record literal its own kind, in a list, a set, a dict and a nested list; and admission's mixed-element check
 * (ADR 0021 1.3) as it runs it, a mixed literal's grouping and an error that only it finds, written or inferred, and a
 * join of two literals' (#1272); a written
 * parameter's every call, a dead one too (Codex r16, r17). At every stop before admission settled the errors, their
 * sites and sentences equal the unstopped ones.
 */
test("a stop before admission settled checks a written store by admission's own C1, error for error", () => {
  for (const source of [
    'let rows: integer[] = ["one", "two"]\nexit\n',
    'let rows: integer set = set["one", "two"]\nexit\n',
    'let rows: integer dict = dict{a: "one", b: "two"}\nexit\n',
    'let rows: integer[][] = [["one", "two"]]\nexit\n',
    "let rows: integer[] = [{n: hostValue}]\nexit\n",
    "let rows: integer set = set[{n: 4}]\nexit\n",
    'let xs: integer[] set = set[]\nxs.add(["wrong", true])\nexit\n',
    'let xs: (integer | string)[] set = set[]\nxs.add([1, "a"])\nexit\n',
    'let ys = [1, "a"]\nexit\n',
    'let ys = [1] + ["a"]\nexit\n',
    'function f(xs: integer[]) { say "x" }\nf(["wrong"])\nf(["bad"])\nexit\n',
    'function f(xs: integer[]) { say "x" }\nexit\nf(["wrong"])\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const errors = (answers: Answers) => keptErrors(answers, source);
    const unstopped = analyseCore(request);
    const want = errors(unstopped);
    assert.ok(want.length > 0, source);
    let stops = 0;
    for (let allowance = 1; allowance < unstopped.budget.total; allowance += 1) {
      const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
      if (stopped.budget.settled) continue;
      stops += 1;
      assert.deepEqual(errors(stopped), want, `${source} @${allowance}`);
    }
    assert.ok(stops > 0, source);
  }
});

/**
 * Before admission settled, a literal whose element needs a decision admission did not make (here a copy of an inferred
 * place) is not compared for mixed elements: the store holding it is marked at its site, its type undecided, standing for
 * its records within its value (TABLE r4.126). At a stop in the setup and at the last before admission settled the
 * mark stands.
 */
test("a stop before admission settled marks the store of a literal whose element needs a decision", () => {
  const source =
    'let base = 1\nlet xs: (integer | string)[] set = set[]\nxs.add([base, "a"])\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const literal = source.indexOf("[base");
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.equal(stopped.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.budget.deferred.some(
        (d) =>
          d.code === "TSV041" &&
          d.site.start === literal &&
          d.obligation.against.length === 1 &&
          d.obligation.against[0] === "unknown",
      ),
      `@${allowance}`,
    );
  }
});

/**
 * Before admission settled, a list join with an operand read through a decision admission did not make (here an inferred
 * variable) is not compared for mixed elements (#1272): a join no definition holds is marked at its own site, its type
 * undecided, as a literal is (`#markValue`). At a stop in the setup and at the last before admission settled the mark
 * stands.
 */
test("a stop before admission settled marks a list join whose operand needs a decision", () => {
  const source = 'let xs = [1]\nsay (xs + ["a"]).length\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const join = source.indexOf("xs +");
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped: Answers = withTestAllowance(allowance, () => analyseCore(request));
    assert.equal(stopped.budget.settled, false, `@${allowance}`);
    assert.ok(
      stopped.budget.deferred.some(
        (d) =>
          d.code === "TSV041" &&
          d.site.start === join &&
          d.obligation.against.length === 1 &&
          d.obligation.against[0] === "unknown",
      ),
      `@${allowance}`,
    );
  }
});

/**
 * After a settled stop a boundary's type is a read like any other (TABLE r4.126, Astra r4's B2): where admission retained
 * no decision for `total`, its boundary takes its stored value's finished contract, `integer | number`, as the finishing
 * read answers it. At every settled stop it equals the unstopped boundary, in four modes; the quiet controls (a
 * subtraction, a multiplication, a comparison, a written `number` destination) keep theirs, in the core's order.
 */
test("a settled stop keeps a boundary's type from its stored value's finished contract", () => {
  const reversed = <T>(make: () => T): T =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), make),
    );
  const modes: readonly (<T>(make: () => T) => T)[] = [
    (make) => make(),
    reversed,
    (make) => withoutSharing(make),
    (make) => withoutSharing(() => reversed(make)),
  ];
  for (const [source, inModes] of [
    ["let total = hostValue + 8\nrepeat hostOther { say total }\nexit\n", modes],
    ["let total = hostValue - 8\nrepeat hostOther { say total }\nexit\n", modes.slice(0, 1)],
    ["let total = hostValue * 8\nrepeat hostOther { say total }\nexit\n", modes.slice(0, 1)],
    ["let total = hostValue < 8\nrepeat hostOther { say total }\nexit\n", modes.slice(0, 1)],
    [
      "let total: number = hostValue + 8\nrepeat hostOther { say total }\nexit\n",
      modes.slice(0, 1),
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const site = source.indexOf("hostValue");
    const boundary = (answers: Answers) =>
      answers.checks.filter((check) => check.boundary && check.site.start === site);
    for (const inMode of inModes) {
      const at = (allowance?: number): Answers =>
        inMode(() =>
          allowance === undefined
            ? analyseCore(request)
            : withTestAllowance(allowance, () => analyseCore(request)),
        );
      const unstopped = at();
      assert.equal(boundary(unstopped).length, 1, source);
      const phaseOf = (allowance: number): string | null => {
        const { stoppedIn, settled } = at(allowance).budget;
        return settled ? stoppedIn : null;
      };
      for (const [low, high] of phaseEnds(unstopped.budget.total, phaseOf).values())
        for (let allowance = low; allowance <= high; allowance += 1)
          assert.deepEqual(boundary(at(allowance)), boundary(unstopped), `${source} @${allowance}`);
    }
  }
});

/**
 * A stop takes back its running unit's read checks with all that made them (Codex r12's final check): the dedupe keys
 * and the ingress resolutions, so finishing makes a projected fallback's own-read boundary again. At every settled walk
 * stop, in the source order (an interior stop: a phase's ends miss it), the compile keeps every record.
 */
test("every settled walk stop keeps a projected fallback's own-read boundary", () => {
  const source = "hostValue.n = 2\nsay 1 otherwise hostValue.n\nexit\n";
  const unstopped = stopRun(source);
  const [low, high] = walkEnds(source);
  for (let allowance = low; allowance <= high; allowance += 1)
    assert.deepEqual(
      stopProblems({ unstopped, stopped: stopRun(source, allowance), fitting: [], violating: [] }),
      [],
      `@${allowance}`,
    );
});

/**
 * The oracle's named exception for #1216 (TABLE r4.110 (b)): a settled walk stop adds a redundant read check of
 * `state.ticks`, read by its key's contract that lost the ingress origin; counted at every stop of the settled phases in
 * the analysis's own order, the test fails where the count moves (the exception goes when #1216 lands).
 */
test("the named exception for #1216 stands at its counted stops", () => {
  const exception = NAMED_EXCEPTIONS.find((each) => each.issue === "#1216");
  assert.ok(exception?.settled !== undefined);
  const request = coreRequest(
    [{ path: "main.tease", source: exception.source }],
    ["hostValue", "hostOther"],
  );
  assert.ok(request !== null);
  const analyse = (allowance: number): Answers =>
    withTestAllowance(allowance, () => analyseCore(request));
  const check = exception.problems[0]!.slice("extra check ".length);
  const has = (answers: Answers): boolean =>
    answers.checks.some((each) => JSON.stringify(each) === check);
  const unstopped = analyseCore(request);
  assert.equal(has(unstopped), false);
  let count = 0;
  for (const [low, high] of phaseEnds(unstopped.budget.total, (allowance) => {
    const { stoppedIn, settled } = analyse(allowance).budget;
    return settled ? stoppedIn : null;
  }).values())
    for (let allowance = low; allowance <= high; allowance += 1)
      if (has(analyse(allowance))) count += 1;
  assert.equal(count, exception.settled);
});

/**
 * #1432, #1415 (S3 §5; S8's mark-ownership rule; TABLE r4.113): after a settled program stop, a read the finishing walk
 * answers by a domain holds the host data its key's stores hold, as the unstopped read does, so its consumer owes its
 * check (a mark carrying the unstopped obligation) and the store's boundary forms. The generated family's anchors
 * (`heldFamily`: each holder at depth 1, read by a repeat count and by an interpolation) at every fifth stop of each
 * settled phase and its last, forward with the sharing and reversed without it; the whole family runs outside CI.
 */
test("a settled stop keeps the checks of the host data a place's stores hold (#1432, #1415)", () => {
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!])
    for (const c of heldFamily(true)) {
      const { run: unstopped, problems } = heldUnstopped(c, mode);
      assert.deepEqual(problems, [], `${c.name}, ${mode.name}`);
      const stops = heldStops(c, mode, 5);
      assert.ok(
        stops.some((stop) => stop.phase === "walk"),
        `${c.name}, ${mode.name}`,
      );
      for (const { allowance, phase } of stops)
        assert.deepEqual(
          heldProblems(c, mode, allowance, unstopped),
          [],
          `${c.name}, ${mode.name}, ${phase} @${allowance}`,
        );
    }
});

/**
 * The per-demand fallback (S3 §5, TABLE B1, ADR 0021 rule 1.10): `y` copies a number through a chain of copies, so its
 * read's exact path is a long demand, and a later store makes its key's contract a whole number or a number; `count`'s
 * read is short. With a demand allowance below the chain's (three quarters of the longest read's work, measured), the
 * read of `y` stops with its key's contract and the reason `budget`, so its check runs when the script runs, while
 * `count`'s error stays an error.
 */
const chain = (reads: number, count: boolean): string =>
  [
    "let x = 1.5",
    ...Array.from({ length: 30 }, (_, i) => `let y${i + 1} = ${i === 0 ? "x" : `y${i}`}`),
    ...Array.from({ length: reads }, () => "repeat y30 {}"),
    "y30 = 2",
    ...(count ? ["let count = 1", "count = 0.5", "repeat count {}"] : []),
    'say "AFTER"',
    "exit",
  ].join("\n") + "\n";

/** Three quarters of the longest demand a source's analysis bounds, unbounded: below the chain's, above a short read's. */
function demandAllowance(source: string): number {
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const bounded = analyseCore(request).budget.demands.filter((read) => read.bounded);
  return Math.floor(0.75 * Math.max(...bounded.map((read) => read.units)));
}

test("a demand past its allowance moves its read's check to the runtime, an independent proof staying an error (S3 §5)", () => {
  const source = chain(1, true);
  const read = source.indexOf("y30 {}");
  const count = source.indexOf("count {}");
  const diagnostics = withTestDemandAllowance(demandAllowance(source), () =>
    inBothOrders(() =>
      compileSourceWithBackend(source, OPTIONS, CORE_BACKEND).diagnostics.map(
        (d) => `${d.severity} ${d.code} @${d.span.start.offset}`,
      ),
    ),
  );
  assert.deepEqual(diagnostics, [`warning TSV011 @${read}`, `error TSV011 @${count}`]);
  // without the independent error: the moved check runs and stops the fraction before the next effect
  const runnable = chain(1, false);
  const plan = withTestDemandAllowance(demandAllowance(runnable), () =>
    inBothOrders(() => compileSourceWithBackend(runnable, OPTIONS, CORE_BACKEND).plan),
  );
  assert.ok(plan !== null);
  const failed = ran(plan, 0);
  assert.deepEqual(failed.said, []);
  assert.match(failed.failure ?? "", new RegExp(`^TSR043@${runnable.indexOf("y30 {}")}:`, "u"));
});

test("a stopped demand's proof is not reused by a later demand of its key, in either order (S3 §5)", () => {
  // two reads of `y30`: the one asked first stops; the other, an independent demand, keeps its allowance and proves
  const source = chain(2, false);
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  const first = source.indexOf("repeat y30") + "repeat ".length;
  const second = source.indexOf("repeat y30", first) + "repeat ".length;
  const allowance = demandAllowance(source);
  for (const reversed of [false, true]) {
    const analyse = (): Answers => withTestDemandAllowance(allowance, () => analyseCore(request));
    const answers: Answers = reversed
      ? withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder((list) => [...list].reverse(), analyse),
        )
      : analyse();
    const at = (start: number): string[] =>
      answers.diagnostics
        .filter((d) => d.site.start === start)
        .map((d) => `${d.class} ${"provenance" in d ? d.provenance.context : "-"}`);
    const [stopped, proved] = reversed ? [second, first] : [first, second];
    assert.deepEqual(at(stopped), ["warning-runtime-check budget"], `reversed: ${reversed}`);
    assert.deepEqual(at(proved), ["compile-error -"], `reversed: ${reversed}`);
  }
});

/**
 * S3 §5's allowance by where a read sits (Astra r1 B3 on #1165): a top-level read reads globals every file stores, so in
 * any file it takes 256 × the program's nodes, not its file's; a function's read takes its function's. `g136` copies a
 * number through 136 globals of a second file, and main's read of it stays the error it is: with its file's 11 nodes it
 * stopped with a moved check instead.
 */
test("a top-level read takes the program's allowance in every file, a function's read its function's (S3 §5)", () => {
  const files = [
    { path: "main.tease", source: 'repeat g136 {}\ng136 = 2\ncheck()\nsay "DONE"\nexit\n' },
    {
      path: "data.tease",
      source:
        [
          "global g0 = 1.5",
          ...Array.from({ length: 136 }, (_, i) => `global g${i + 1} = g${i}`),
          "global h: integer = g136",
          "global function check {",
          "  repeat g136 {}",
          "}",
          "end",
        ].join("\n") + "\n",
    },
  ];
  const request = coreRequest(files);
  assert.ok(request !== null);
  for (const reversed of [false, true]) {
    const answers: Answers = reversed
      ? withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder(
            (list) => [...list].reverse(),
            () => analyseCore(request),
          ),
        )
      : analyseCore(request);
    const { graph, budget } = answers;
    const functionNodes = new Map<unknown, number>();
    for (const node of graph.nodes) {
      const owner = graph.callableOf(node.region);
      if (owner?.kind === "function") functionNodes.set(owner, (functionNodes.get(owner) ?? 0) + 1);
    }
    const reads = budget.demands.filter((read) => read.bounded);
    const where = (file: string, inFunction: boolean) =>
      reads.filter((read) => {
        const node = graph.nodes[read.node]!;
        return (
          request.files[node.file]!.path === file &&
          (graph.callableOf(node.region)?.kind === "function") === inFunction
        );
      });
    for (const [file, inFunction] of [
      ["main.tease", false],
      ["data.tease", false],
      ["data.tease", true],
    ] as const)
      assert.ok(where(file, inFunction).length > 0, `${file}, function: ${inFunction}`);
    for (const read of reads) {
      const owner = graph.callableOf(graph.nodes[read.node]!.region);
      const nodes = owner?.kind === "function" ? functionNodes.get(owner)! : graph.nodes.length;
      assert.equal(read.allowance, 256 * nodes, `reversed: ${reversed}`);
    }
    // (the top-level reads prove their errors; the function's 7 nodes may stop its own read, its check moved)
    assert.ok(
      !reads.some(
        (read) =>
          read.stopped && graph.callableOf(graph.nodes[read.node]!.region)?.kind !== "function",
      ),
      `reversed: ${reversed}`,
    );
    const at = (file: string, start: number): string[] =>
      answers.diagnostics
        .filter((d) => request.files[d.site.file]!.path === file && d.site.start === start)
        .map((d) => d.class);
    assert.deepEqual(at("main.tease", 7), ["compile-error"], `reversed: ${reversed}`);
    assert.deepEqual(
      at("data.tease", files[1]!.source.indexOf("g136\nglobal function")),
      ["compile-error"],
      `reversed: ${reversed}`,
    );
  }
});

/**
 * TABLE r4.100, S3 revision 21: a settled walk stop leaves a typed parse's nested paths undecided (admission decides
 * them lazily, never after a stop); source 4 decides them from its default literal's syntax, so the store's check stays
 * whole (#1165's class, a named exception of the oracle before: 984 and 1,180 stop points over four modes, the first
 * walk stop among them). At the first walk stop and one halfway through the walk.
 */
test("a settled stop decides a typed parse's nested default by its syntax, its check whole", () => {
  for (const source of [
    'let value = fromJson(hostValue, default: {list: [{n: fromJson("3", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay "DONE"\nexit\n',
    "let parsed = fromJson(hostValue, default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n",
  ]) {
    const unstopped = stopRun(source);
    const [low, high] = walkEnds(source);
    for (const allowance of [low, Math.floor((low + high) / 2)])
      assert.deepEqual(
        stopProblems({
          unstopped,
          stopped: stopRun(source, allowance),
          fitting: [],
          violating: [],
        }),
        [],
        `@${allowance}`,
      );
  }
});

test("an admission decision past its allowance stops: its key undecided, its reads checked when the script runs (S3 §5)", () => {
  // `b`'s decision scans its 41 stores, while each read is short, `count`'s decision too
  const source = (count: boolean): string =>
    [
      "let b = 1",
      ...Array.from({ length: 40 }, (_, i) => `b = ${i + 2}`),
      "b = hostValue",
      "let n: integer = b",
      ...(count ? ["let count = 1", "count = 0.5", "repeat count {}"] : []),
      'say "AFTER"',
      "exit",
    ].join("\n") + "\n";
  for (const reversed of [false, true]) {
    const inOrder = <T>(make: () => T): T =>
      reversed
        ? withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), make),
          )
        : make();
    for (const count of [true, false]) {
      const text = source(count);
      const request = coreRequest([{ path: "main.tease", source: text }], OPTIONS.globals);
      assert.ok(request !== null);
      const b = new CoreProgram(request).places.find(
        ({ kind }) => kind.kind === "binding" && kind.name === "b",
      )!.id;
      // half of `b`'s decision in the unbounded analysis in this order, still far above `count`'s (the solver's steps
      // decide where it stops: since A2, #1293, three quarters is crossed only after the last of them)
      const { decisions } = inOrder(() => analyseCore(request)).budget;
      const own = decisions.filter((d) => d.place === b && d.path.length === 0);
      assert.equal(own.length, 1);
      const allowance = Math.floor(0.5 * own[0]!.units);
      const where = `reversed: ${reversed}, count: ${count}`;
      const answers: Answers = withTestDemandAllowance(allowance, () =>
        inOrder(() => analyseCore(request)),
      );
      assert.deepEqual(
        answers.budget.decisions.filter((d) => d.stopped).map((d) => [d.place, d.path]),
        [[b, []]],
        where,
      );
      // (a read as long as the decision may stop too: its own key's contract with `budget`)
      assert.deepEqual(answers.place(b).admitted, { by: "undecided" }, where);
      const at = (start: number): string[] =>
        answers.diagnostics
          .filter((d) => d.site.start === start)
          .map((d) => `${d.class} ${"provenance" in d ? d.provenance.context : "-"}`);
      const read = text.indexOf(count ? "b\nlet count" : "b\nsay");
      // (`budget` in either order: the pass in which `b`'s decision stopped is not settled, and the next starts with `b`
      // stopped, so `n`'s check, which reads `b` before `b` is decided in the reversed order, reads it stopped, TABLE
      // r4.180)
      assert.deepEqual(at(read), ["warning-runtime-check budget"], where);
      if (count) assert.deepEqual(at(text.indexOf("count {}")), ["compile-error -"], where);
      else {
        // the read's moved check stops a fraction before the next effect
        const plan = withTestDemandAllowance(allowance, () =>
          inOrder(() => compileSourceWithBackend(text, OPTIONS, CORE_BACKEND).plan),
        );
        assert.ok(plan !== null, where);
        assert.deepEqual(ran(plan, 5), { said: ["AFTER"], failure: null }, where);
        assert.match(ran(plan, 1.5).failure ?? "", new RegExp(`^TSR\\d+@${read}:`, "u"), where);
      }
    }
  }
});

/**
 * Astra r1 B1 and Codex c-r7 B1 on #1165: a decision stopped at its allowance leaves its key's contract `budget` for
 * every read from then on (`Contract.stop`), a read composed in a literal or its projection included, also after a
 * program stop where admission had settled, when the finishing path asks retained, lazily decided and syntax sources
 * (source 4 tells a stopped decision from a path admission decides lazily). `tally`'s decision scans its 14 stores; its
 * place stays undecided and its read, an object literal's property holding it and that property's read answer `budget`
 * before the program stop and at its first settled and its last stop, and the stop changes nothing the oracle does not
 * excuse, no boundary among it. The generated family (shapes, readers, caps and allowances around the stop) runs outside
 * CI.
 */
test("a stopped decision stays undecided at every reader, also after a settled program stop (S3 §5)", () => {
  const source =
    [
      "let tally = 1",
      ...Array.from({ length: 12 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let picked: integer = tally",
      "let other = tally",
      "repeat {kept: tally}.kept {}",
      "repeat tally {}",
      "repeat other {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const tally = new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === "tally",
  )!.id;
  const read = source.indexOf("tally {}");
  const kept = source.indexOf("{kept: tally}");
  for (const reversed of [false, true]) {
    const inOrder = <T>(make: () => T): T =>
      reversed
        ? withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), make),
          )
        : make();
    const { decisions } = inOrder(() => analyseCore(request)).budget;
    const own = decisions.find((d) => d.place === tally && d.path.length === 0)!;
    const capped = <T>(make: () => T): T =>
      withTestDemandAllowance(Math.floor(own.units / 2), () => inOrder(make));
    const unstopped = capped(() => stopRun(source));
    const total = unstopped.answers.budget.total;
    const [first] = capped(() => [...settledEnds(source).values()]).reduce(
      (lowest, ends) => (ends[0] < lowest[0] ? ends : lowest),
      [total, total] as const,
    );
    for (const allowance of [undefined, first, total - 1]) {
      const where = `reversed: ${reversed}, allowance: ${allowance}`;
      const run = allowance === undefined ? unstopped : capped(() => stopRun(source, allowance));
      const { answers } = run;
      assert.equal(answers.budget.settled, true, where);
      assert.ok(
        answers.budget.decisions.some((d) => d.place === tally && d.stopped),
        where,
      );
      assert.deepEqual(answers.place(tally).admitted, { by: "undecided" }, where);
      const node = (start: number, kind: string) =>
        answers.graph.nodes.find(
          (each) => each.expression?.kind === kind && each.span?.start.offset === start,
        )!;
      const budget = (items: readonly { tag: string; reasons: number }[]) =>
        items.map((item) => `${item.tag}/${item.reasons}`);
      assert.deepEqual(budget(answers.at(node(read, "identifier"))!.items), ["unknown/16"], where);
      assert.deepEqual(
        budget(answers.valueAt(node(kept, "objectLiteral"), ["kept"]).items),
        ["unknown/16"],
        where,
      );
      assert.deepEqual(
        budget(answers.at(node(kept, "propertyAccessExpression"))!.items),
        ["unknown/16"],
        where,
      );
      if (allowance !== undefined)
        assert.deepEqual(
          capped(() =>
            stopProblems({ unstopped, stopped: run, fitting: [host(2)], violating: [host(2.5)] }),
          ),
          [],
          where,
        );
    }
  }
});

/**
 * Astra r1's B2 on #1437: a stop changes nothing no mark of it names. Below a decision stopped at its demand allowance
 * the unstopped publication owes no boundary, so the stopped one reads no further there (`againstOf`); and
 * after a stop `toJson` owes the check of a value the stop left unread, its mark owning the one the unstopped walk made
 * for the regex below each argument. Each mode's settled phase ends and its last stop before admission settled (whose
 * fresh pass reads no property names: a literal argument, which it reads as an object), without a demand allowance and
 * with the witness's
 * 257, which stops a decision below `root`; where it stops the analysis itself (TABLE r4.183, the reversed orders) there
 * is no unstopped analysis to compare. A host value fits where the unstopped plan runs it: without sharing, 257 decides
 * the element `regex`, which C9 checks the host value against.
 */
test("a stop adds no boundary below a stopped decision and keeps toJson's checks (#1437)", () => {
  const sources = [
    "let root={value:{a:[hostValue otherwise /r/],b:1}}\nlet first=root\nlet second=first\n" +
      "say toJson(first)\nsay toJson(second)\nsay toJson(root)\nexit\n",
    "let n = 1\nsay toJson({a: [hostValue otherwise /r/], b: n})\nexit\n",
  ];
  let compared = 0;
  for (const source of sources)
    for (const demand of [null, 257])
      for (const mode of MODES) {
        const inDemand = <T>(make: () => T): T =>
          inMode(mode, () => (demand === null ? make() : withTestDemandAllowance(demand, make)));
        const unstopped = stopRunIn(inDemand, source);
        if (unstopped.answers.budget.exhausted !== null) continue;
        const inputs = [host(1), host(null)];
        const fits = (globals: Globals): boolean =>
          runGlobals(unstopped.result.plan!, globals).failure === null;
        // (each settled phase's ends, and the last stop before admission settled, whose fresh pass asks nothing)
        const stops: (readonly [string, number])[] = [
          ...inDemand(() => settledEnds(source)),
        ].flatMap(([phase, ends]) => ends.map((allowance) => [phase, allowance] as const));
        stops.push(["unsettled", inDemand(() => lastUnsettled(source))]);
        for (const [phase, allowance] of stops) {
          compared += 1;
          assert.deepEqual(
            stopProblems({
              unstopped,
              stopped: stopRunIn(inDemand, source, allowance),
              fitting: inputs.filter(fits),
              violating: inputs.filter((globals) => !fits(globals)),
            }),
            [],
            `${source} demand: ${demand}, ${JSON.stringify(mode)}, ${phase} @${allowance}`,
          );
        }
      }
  assert.equal(compared, 54);
});

/**
 * TABLE r4.180: a pass in which a decision stops is not settled; the next, from the same rejections, starts with that
 * key stopped (`Contract.stop`), so no result read the key before its stop, in any order. `pair`'s stored literal holds
 * a read of `tally`; in the reversed order `pair` is decided before `tally`, and without the next pass `pair.first`
 * kept the host value `tally` held then; `count`'s error is independent of `tally` and stays. One extra pass where a
 * decision first stops, none without one, and at most one per rejected set (TABLE r4.183): in the reversed order `box`'s
 * root, which reads the values `box.n`'s stopped decision had finished, stops once `box.n` is stopped from its pass's
 * start, and that second stop stops the analysis as the work allowance does. A program stop in the pass where a
 * decision first stopped is not settled: finishing marks the stores (r4.135), and the stop oracle holds, no boundary
 * among it, as in #1194's witness below of a second stop.
 */
test("a pass in which a decision stops is not settled: the next starts with its key stopped (TABLE r4.180)", () => {
  const reversed = <T>(make: () => T): T =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), make),
    );
  const modes: readonly (readonly [string, <T>(make: () => T) => T])[] = [
    ["forward", (make) => make()],
    ["reversed", reversed],
    ["forward, unshared", (make) => withoutSharing(make)],
    ["reversed, unshared", (make) => withoutSharing(() => reversed(make))],
  ];
  const globals = ["hostValue", "hostOther"];
  const place = (source: string, name: string) => {
    const request = coreRequest([{ path: "main.tease", source }], globals);
    assert.ok(request !== null);
    return {
      request,
      id: new CoreProgram(request).places.find(
        ({ kind }) => kind.kind === "binding" && kind.name === name,
      )!.id,
    };
  };
  const passes = (answers: Answers): number => answers.budget.counts.get("stopPasses") ?? 0;
  const items = (list: readonly { tag: string; reasons: number }[]) =>
    list.map((item) => `${item.tag}/${item.reasons}`);
  const dependent =
    [
      "let tally = 1",
      ...Array.from({ length: 60 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let pair = [tally]",
      "let count = 1",
      "count = 0.5",
      "repeat count {}",
      "repeat pair.first {}",
      "repeat tally {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const tally = place(dependent, "tally");
  for (const [mode, inMode] of modes) {
    const unbounded = inMode(() => analyseCore(tally.request));
    assert.equal(passes(unbounded), 0, mode);
    const own = unbounded.budget.decisions.find(
      (d) => d.place === tally.id && d.path.length === 0,
    )!;
    const capped = <T>(make: () => T): T =>
      withTestDemandAllowance(Math.floor(own.units / 2), () => inMode(make));
    const answers = capped(() => analyseCore(tally.request));
    const node = (text: string, kind: string) =>
      answers.graph.nodes.find(
        (each) =>
          each.expression?.kind === kind && each.span?.start.offset === dependent.indexOf(text),
      )!;
    assert.deepEqual(
      items(answers.at(node("pair.first", "propertyAccessExpression"))!.items),
      ["unknown/16"],
      mode,
    );
    assert.deepEqual(
      items(answers.at(node("tally {}", "identifier"))!.items),
      ["unknown/16"],
      mode,
    );
    // (the independent error stays; in the reversed unshared mode `pair`'s element decision, longer there than `tally`'s,
    // stops too and then again in the restarted pass, which stops the analysis (TABLE r4.183): its check is marked)
    assert.equal(passes(answers), 1, mode);
    const count = dependent.indexOf("count {}");
    if (mode === "reversed, unshared") {
      assert.equal(answers.budget.exhausted, "work", mode);
      assert.ok(
        answers.budget.deferred.some((mark) => mark.site.start === count),
        mode,
      );
    } else
      assert.deepEqual(
        answers.diagnostics.filter((d) => d.site.start === count).map((d) => d.class),
        ["compile-error"],
        mode,
      );
  }
  // one decision stopping: one extra pass in either order; a program stop at the last unit of the pass where it stopped
  const single =
    [
      "let tally = 1",
      ...Array.from({ length: 12 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let picked: integer = tally",
      "repeat tally {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const scalar = place(single, "tally");
  for (const [mode, inMode] of modes.slice(0, 2)) {
    const own = inMode(() => analyseCore(scalar.request)).budget.decisions.find(
      (d) => d.place === scalar.id && d.path.length === 0,
    )!;
    const capped = <T>(make: () => T): T =>
      withTestDemandAllowance(Math.floor(own.units / 2), () => inMode(make));
    const unstopped = capped(() => stopRun(single));
    assert.equal(passes(unstopped.answers), 1, mode);
    // (the lowest program allowance whose stop comes after the first pass: one below it, the first pass's last unit)
    let [low, high] = [1, unstopped.answers.budget.total];
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (passes(capped(() => withTestAllowance(middle, () => analyseCore(scalar.request)))) >= 1)
        high = middle;
      else low = middle;
    }
    const stopped = capped(() => stopRun(single, low));
    const { budget } = stopped.answers;
    assert.equal(budget.exhausted, "work", mode);
    assert.equal(budget.settled, false, mode);
    assert.ok(
      budget.deferred.some((mark) => mark.rule.rule === "store"),
      mode,
    );
    assert.deepEqual(
      capped(() =>
        stopProblems({ unstopped, stopped, fitting: [host(2)], violating: [host(2.5)] }),
      ),
      [],
      mode,
    );
  }
  // a decision stopping only in the restarted pass: the analysis stops there (TABLE r4.183)
  const property =
    [
      "let box = {n: 1}",
      ...Array.from({ length: 12 }, (_, i) => `box.n = ${i + 2} + ${i + 3}`),
      "box = {n: 4}",
      "repeat box.n {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  const box = place(property, "box");
  const root = reversed(() => analyseCore(box.request)).budget.decisions.find(
    (d) => d.place === box.id && d.path.length === 0,
  )!;
  // (outside the candidate route's slice, `2 + 3`: its analysis alone; #1194's witness below runs the stop oracle)
  const twice: Answers = withTestDemandAllowance(root.units + 3, () =>
    reversed(() => analyseCore(box.request)),
  );
  assert.equal(passes(twice), 1);
  assert.equal(twice.budget.exhausted, "work");
  assert.equal(twice.budget.settled, false);
  assert.ok(twice.budget.deferred.some((mark) => mark.rule.rule === "store"));
});

/**
 * Codex c-r8 B1 on #1165 and TABLE r4.183: a narrowed read of a key whose decision stopped reads it as every read does,
 * through the one key read (`Values.#keyRead`), as unknown data with the reason `budget`, and the test narrows it as it
 * narrows host data: under `is integer` the read is the integer the test itself proves, so its reason is the test's, not
 * `budget`; under `is not integer`, and unguarded, it stays `unknown` with `budget`. Both orders.
 */
test("a narrowed read of a stopped decision's key is what its test proves, unguarded reads budget (TABLE r4.183)", () => {
  for (const [form, expected] of [
    ["is integer", ["integer/0"]],
    ["is not integer", ["unknown/16"]],
  ] as const) {
    const source =
      [
        "let tally = 1",
        ...Array.from({ length: 12 }, (_, i) => `tally = ${i + 2}`),
        "tally = hostValue",
        `if tally ${form} {`,
        "  let picked: integer = tally",
        "}",
        "repeat tally {}",
        "exit",
      ].join("\n") + "\n";
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const tally = new CoreProgram(request).places.find(
      ({ kind }) => kind.kind === "binding" && kind.name === "tally",
    )!.id;
    for (const reversed of [false, true]) {
      const inOrder = <T>(make: () => T): T =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), make),
            )
          : make();
      const own = inOrder(() => analyseCore(request)).budget.decisions.find(
        (d) => d.place === tally && d.path.length === 0,
      )!;
      const answers: Answers = withTestDemandAllowance(Math.floor(own.units / 2), () =>
        inOrder(() => analyseCore(request)),
      );
      const where = `${form}, reversed: ${reversed}`;
      assert.deepEqual(answers.place(tally).admitted, { by: "undecided" }, where);
      const read = (start: number) =>
        answers
          .at(
            answers.graph.nodes.find(
              (each) => each.expression?.kind === "identifier" && each.span?.start.offset === start,
            )!,
          )!
          .items.map((item) => `${item.tag}/${item.reasons}`);
      assert.deepEqual(read(source.indexOf("tally\n}")), expected, where);
      assert.deepEqual(read(source.indexOf("tally {}")), ["unknown/16"], where);
    }
  }
});

/**
 * TABLE r4.183's recorded cost: a decision over a deep written type costs its depth × its copies (C1's per-copy visits,
 * G6 in #1319's design-round list) against an allowance linear in the program's nodes, so `out`'s decisions cross it at
 * 64 levels and copies, the deepest first in the reversed order: one restart, then the next path's decision stops in
 * the restarted pass and stops the analysis there, its stores marked and the stop oracle holding. The G6 repair's
 * acceptance: this returns to `valid` with no restart.
 */
test("a decision stopping in the restarted pass stops the analysis: #1194's copies reversed (TABLE r4.183)", () => {
  const source = [
    `let typed: integer${"[]".repeat(64)} = []`,
    "let out = typed",
    ...Array.from({ length: 64 }, () => "out = typed"),
    "exit",
  ].join("\n");
  const reversed = <T>(make: () => T): T =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), make),
    );
  // (the reference: no decision stops under a demand allowance the analysis never reaches)
  const unstopped = stopRunIn(
    (make) => withTestDemandAllowance(30_000_000, () => reversed(make)),
    source,
  );
  assert.equal(unstopped.answers.budget.exhausted, null);
  assert.equal(unstopped.result.diagnostics.length, 0);
  const stopped = stopRunIn(reversed, source);
  const { budget } = stopped.answers;
  assert.equal(budget.counts.get("stopPasses"), 1);
  assert.equal(budget.exhausted, "work");
  assert.equal(budget.settled, false);
  assert.ok(budget.deferred.some((mark) => mark.rule.rule === "store"));
  assert.deepEqual(stopProblems({ unstopped, stopped, fitting: [], violating: [] }), []);
});

/** A test of the stopped-key family in the four modes: the solver's and consumers' orders, sharing on and off. */
const STOP_MODES: readonly (readonly [string, <T>(make: () => T) => T])[] = (() => {
  const reversed = <T>(make: () => T): T =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), make),
    );
  return [
    ["forward", (make) => make()],
    ["reversed", reversed],
    ["forward, unshared", (make) => withoutSharing(make)],
    ["reversed, unshared", (make) => withoutSharing(() => reversed(make))],
  ];
})();

const tagged = (items: readonly Item[]): string[] =>
  items.map((item) => `${item.tag}/${item.reasons}`);
const stoppedItems = (items: readonly Item[]): boolean =>
  items.some((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0);

/**
 * TABLE r4.186 at a property or index read's occurrence (G3 3a): its answer kept before a key's decision stops is not
 * read after it (`Contract.stop` forgets it), so a read of the key, or of one below it, answers `budget` from the stop
 * on, as in a pass that starts with the key stopped. Each chain is read, its key stopped at every depth of its reads'
 * paths, and read again, in both read orders, directly and through a selection and an operation, and a proof read of
 * its deepest occurrence after the stop holds the stop too.
 */
test("a property or index read's occurrence answers its key's stop at every depth from the stop on (r4.186)", () => {
  const shapes = [
    {
      source: "let tree = [{q: [{q: 1}]}]\nlet copy = tree[0].q[0].q\nsay copy\nexit\n",
      reads: ["tree[0]", "tree[0].q", "tree[0].q[0]", "tree[0].q[0].q"],
    },
    {
      source: "let seed: integer = 1\nlet box = {q: {n: seed}}\nsay box.q.n\nexit\n",
      reads: ["box.q", "box.q.n"],
    },
    {
      source: "let pair = [{n: [1]}]\nsay pair.first.n[0]\nexit\n",
      reads: ["pair.first.n", "pair.first.n[0]"],
    },
    {
      source: "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n",
      reads: ["a.n", "(a.n otherwise {m: 2}).m"],
    },
  ];
  type Budget = Proof & { readonly stopped: boolean };
  for (const { source, reads } of shapes) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const at = (pass: CorePass): PlaceId[] =>
      reads.map((text) => {
        const found = pass.program.places.find(
          (place) =>
            place.site !== null &&
            source.slice(place.site.start, place.site.end) === text &&
            pass.program.projOf.has(place.id),
        );
        assert.ok(found !== undefined, text);
        return found.id;
      });
    const shape = narrowingPass(request);
    const roots = at(shape).map((value) => shape.program.targetRoot(value));
    const binding = roots[0]!.root;
    // (the binding itself and every prefix of its reads' paths)
    const stops = new Map<string, readonly string[]>();
    for (const { root, path } of roots)
      if (root === binding)
        for (let depth = 0; depth <= path.length; depth += 1)
          stops.set(path.slice(0, depth).join("."), path.slice(0, depth));
    for (const path of stops.values())
      for (const [mode, inMode] of STOP_MODES)
        for (const order of ["source", "deepest first"])
          inMode(() => {
            const where = `${source.split("\n")[1]} @${path.join(".") || "-"}, ${mode}, ${order}`;
            const own = (list: readonly PlaceId[]) =>
              order === "source" ? list : [...list].reverse();
            const pass = narrowingPass(request);
            const values = at(pass);
            const read = (value: PlaceId) => pass.solver.run(pass.contract.contractOfValue(value));
            for (const value of own(values)) assert.ok(!stoppedItems(read(value)), where);
            pass.contract.stop(binding, path);
            const after = new Map(own([...values].reverse()).map((value) => [value, read(value)]));
            const fresh = narrowingPass(request);
            fresh.contract.stop(binding, path);
            for (const [i, value] of at(fresh).entries()) {
              const expected = fresh.solver.run(fresh.contract.contractOfValue(value));
              assert.deepEqual(
                tagged(after.get(values[i]!)!),
                tagged(expected),
                `${reads[i]}: ${where}`,
              );
              const { root, path: below } = roots[i]!;
              if (root === binding && path.every((step, depth) => below[depth] === step))
                assert.ok(stoppedItems(expected), `${reads[i]}: ${where}`);
            }
            const deepest = values.at(-1)!;
            const proof: ProofDemand<Budget> = {
              key: "stop-proof",
              kind: "contract",
              file: 0,
              offset: 0,
              proves: true,
              *make() {
                const items = yield* pass.contract.contractOfValue(deepest);
                const stopped = stoppedItems(items);
                return { items, proof: { stopped, signature: () => String(stopped) } };
              },
            };
            assert.equal(
              pass.solver.run(pass.solver.proven(proof)).proof?.stopped,
              stoppedItems(after.get(deepest)!),
              where,
            );
          });
  }
});

/**
 * TABLE r4.186 through every answer the solver keeps (#1403): an answer kept before a key's decision stops may have
 * read the key at an occurrence (a selection, an operation, a literal's read) or through a copy's contract, a call's
 * result, a receiver, a narrowed read or a default's decision, so `Contract.stop` has the solver forget them all. In
 * each shape every value is read in one pass, on the contract side and on the value side, a key is stopped (each
 * binding and every prefix of its reads' paths), and every value is read again, in both read orders and the four
 * modes: each answers as in a pass that starts with the key stopped. A second stop in a pass that started with
 * another key stopped (the restarted pass) answers as a pass that starts with both. Between them the shapes reach
 * every memo that kept such an answer on `main`: forgetting all but one of them fails this test.
 */
test("every answer kept before a key's decision stops answers the stop from the stop on (r4.186, #1403)", () => {
  const shapes = [
    "let box = [[{n: 1}]]\nsay box.first.first.n\nexit\n",
    "let v: integer? = null\nlet a = {n: v}\nsay a.n otherwise 2\nexit\n",
    "let a = {n: 1}\nsay [a][0].n\nexit\n",
    "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n",
    "let box = [[{n: 1}]]\nlet copy = box\nsay copy.first.first.n\nexit\n",
    "let xs = [1.5]\nlet removed = xs.removeAt(0)\nrepeat removed {}\nexit\n",
    'let handle = timer async hidden 1 s { say "done", instant }\nlet observed: integer = handle.stop()\nexit\n',
    "let box = {value: 2.0}\nif box != null {\nlet saved = box.value\nlet whole: integer = saved\n}\nexit\n",
    'let textHost = askText "text"\nlet d = 0\nlet result = fromJson(textHost, default: d)\nsay result\nexit\n',
  ];
  type Stop = { readonly place: PlaceId; readonly path: readonly string[] };
  for (const source of shapes) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { program } = narrowingPass(request);
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    const text = (value: PlaceId): string => {
      const site = program.places[value]!.site!;
      return source.slice(site.start, site.end);
    };
    const stops = new Map<string, Stop>();
    for (const place of program.places)
      if (place.kind.kind === "binding") stops.set(`${place.id}`, { place: place.id, path: [] });
    for (const value of values) {
      const { root, path } = program.targetRoot(value);
      if (stops.has(`${root}`))
        for (let depth = 1; depth <= path.length; depth += 1)
          stops.set(`${root}|${path.slice(0, depth).join(".")}`, {
            place: root,
            path: path.slice(0, depth),
          });
    }
    const named = (stop: Stop | null) =>
      stop === null ? "-" : `${program.places[stop.place]!.label}@${stop.path.join(".") || "-"}`;
    // (a stop alone, and a stop after another binding's, which the pass started with)
    const cases = [...stops.values()].flatMap((stop) => [
      { first: null, stop },
      ...[...stops.values()]
        .filter((first) => first.place !== stop.place && first.path.length === 0)
        .map((first) => ({ first, stop })),
    ]);
    for (const { first, stop } of cases)
      for (const lane of ["contract", "value"] as const)
        for (const [mode, inMode] of STOP_MODES)
          for (const order of ["source", "reversed"])
            inMode(() => {
              const keys = `${named(first)}, ${named(stop)}`;
              const where = `${source.split("\n").at(-3)} @${keys}, ${lane}, ${mode}, ${order}`;
              const read = (pass: CorePass, value: PlaceId) =>
                tagged(
                  pass.solver.run(
                    lane === "contract"
                      ? pass.contract.contractOfValue(value)
                      : pass.values.valueItems(value, null, []),
                  ),
                );
              const own = order === "source" ? values : [...values].reverse();
              const pass = narrowingPass(request);
              if (first !== null) pass.contract.stop(first.place, first.path);
              for (const value of own) read(pass, value);
              pass.contract.stop(stop.place, stop.path);
              const after = new Map(own.map((value) => [value, read(pass, value)]));
              const fresh = narrowingPass(request);
              if (first !== null) fresh.contract.stop(first.place, first.path);
              fresh.contract.stop(stop.place, stop.path);
              for (const value of values)
                assert.deepEqual(after.get(value), read(fresh, value), `${text(value)}: ${where}`);
            });
  }
});

/**
 * Astra r1's B1 witness: through its consumers the decision of `tree`'s element stops at a small demand allowance, and
 * every read of an occurrence of the stopped key after it, `tree[0]`, `tree[0].q` and `tree[0].q[0]` among them, answers
 * `budget` (observed by wrapping `contractOfValue`, for this analysis only, without a charge), with the one restart.
 */
test("after a decision stops through its consumers, every read of an occurrence of its key answers the stop (B1)", () => {
  const source = "let tree = [{q: [{q: 1}]}]\nlet copy = tree[0].q[0].q\nsay copy\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const original = Contract.prototype.contractOfValue;
  const seen: string[] = [];
  const stale: string[] = [];
  Contract.prototype.contractOfValue = function* (this: Contract, value: PlaceId) {
    const items = yield* original.call(this, value);
    const { program } = this.pass;
    const { root, path } = program.targetRoot(value);
    const site = program.places[value]!.site!;
    if (
      this.stoppedKeys().some(
        (key) => key.place === root && key.path.every((step, i) => path[i] === step),
      )
    ) {
      seen.push(source.slice(site.start, site.end));
      if (!stoppedItems(items)) stale.push(source.slice(site.start, site.end));
    }
    return items;
  };
  try {
    for (const [mode, inMode] of STOP_MODES) {
      seen.length = 0;
      stale.length = 0;
      const answers: Answers = inMode(() =>
        withTestDemandAllowance(25, () => analyseCore(request)),
      );
      assert.equal(answers.budget.counts.get("stopPasses"), 1, mode);
      for (const text of ["tree[0]", "tree[0].q", "tree[0].q[0]"])
        assert.ok(seen.includes(text), `${text}: ${mode}`);
      assert.deepEqual(stale, [], mode);
    }
  } finally {
    Contract.prototype.contractOfValue = original;
  }
});
