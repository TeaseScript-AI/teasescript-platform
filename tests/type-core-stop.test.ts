import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { compileSourceWithBackend } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import type { FlowNode } from "../src/type-inference/core/flow-graph.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { withConsumerOrder, withoutRecords } from "../src/type-inference/core/consumers.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
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
    stopped.diagnostics.filter((d) => d.code !== "TSV076"),
    unstopped.diagnostics,
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
 * A mode's settled phases, each with its lowest and highest stopping allowance, found by bisection: below the analysis's
 * total `phaseOf` (an analysis stopped at the allowance: its phase where admission had settled, else `null`) names
 * contiguous ranges, the publication's above the walk's, down to the first stop that is not settled. A phase found twice
 * is not contiguous and fails.
 */
function phaseEnds(
  total: number,
  phaseOf: (allowance: number) => string | null,
): Map<string, readonly [number, number]> {
  const ends = new Map<string, readonly [number, number]>();
  for (let high = total - 1; high > 0;) {
    const phase = phaseOf(high);
    if (phase === null) break;
    assert.ok(!ends.has(phase), `${phase} again below ${high + 1}`);
    let low = 1;
    for (let top = high; low < top;) {
      const middle = (low + top) >> 1;
      if (phaseOf(middle) === phase) top = middle;
      else low = middle + 1;
    }
    ends.set(phase, [low, high]);
    high = low - 1;
  }
  return ends;
}

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
      // a copied domain that admits `null` leaves the family undecided (TABLE r4.105): marked, not imposed
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
 * Before admission settled, a store marked with its type undecided stands for its records within its value and for the
 * errors it brought (TABLE r4.111): an object stored with host data inside it (Codex r8's copy of fields), a typed parse
 * inside a typed default, and a copy's error reported where it is read. Each rule only so far: the mark narrowed off
 * the record, or the error's store moved elsewhere, and the oracle reports the record.
 */
test("a store a stop before admission settled marks stands for its records within its value and the errors it brought", () => {
  const inner =
    'let a = {inner: {n: 1, title: "ok"}}\nlet b = a\nb = {inner: hostValue}\nsay b.inner.n\nsay b.inner.title\nexit\n';
  const copied =
    'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n';
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
  // the copy's error brought by another store than the marked one
  const unstopped = stopRun(copied);
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
  assert.notDeepEqual(problems(elsewhere, stopRun(copied, ALLOWANCE)), []);
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
 * Before admission settled, a written store's literal parts take their collections from the written type and their
 * parts from the literal's syntax, never from the solver (TABLE r4.120, Codex r13's S1): a set's element, a dict's value,
 * a set inside a dict; and a stop changes no site, an error inside an add's literal staying at the add's argument
 * (TABLE r4.122 (d)). At a stop in the setup and at the last before admission settled, each error, its site, its rule's
 * steps and its sentence equal the unstopped ones (the analysis: a written set or dict is outside the candidate route).
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
    const text = messageSource([source]);
    const errors = (answers: Answers) =>
      answers.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => ({ ...d, message: coreMessage(d, text) }));
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
    const text = messageSource([source]);
    const errors = (answers: Answers) =>
      answers.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => ({ ...d, message: coreMessage(d, text) }));
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
 * silently (Astra r6 B2, TABLE r4.144).
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
 * (ADR 0021 1.3) as it runs it, a mixed literal's grouping and an error that only it finds, written or inferred; a written
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
    'function f(xs: integer[]) { say "x" }\nf(["wrong"])\nf(["bad"])\nexit\n',
    'function f(xs: integer[]) { say "x" }\nexit\nf(["wrong"])\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null);
    const text = messageSource([source]);
    const errors = (answers: Answers) =>
      answers.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => ({ ...d, message: coreMessage(d, text) }));
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
