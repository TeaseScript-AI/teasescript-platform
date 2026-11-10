import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { ts } from "ts-morph";

import {
  compileProject,
  compileProjectWithBackend,
  compileSourceWithBackend,
  type CompilationResult,
  type ProjectDiagnostic,
} from "../../src/compiler.js";
import type { Expression } from "../../src/ast.js";
import type { Diagnostic } from "../../src/diagnostics.js";
import { validateInstructionPlan } from "../../src/plan/validation.js";
import { run } from "../../src/runtime/engine.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../src/runtime/snapshot/checkpoint.js";
import {
  createSerializableList,
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers, type CorePass } from "../../src/type-inference/core/answers.js";
import type { FlowNode } from "../../src/type-inference/core/flow-graph.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { Contract } from "../../src/type-inference/core/contract.js";
import {
  DemandExhausted,
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import {
  Consumers,
  withConsumerOrder,
  withoutRecords,
} from "../../src/type-inference/core/consumers.js";
import {
  FRONTIER_COPIES,
  FRONTIER_DEPTH,
  labelDomain,
  withFrontierBound,
  type FrontierRead,
} from "../../src/type-inference/core/consumers/finishing.js";
import { keyOf } from "../../src/type-inference/core/definitions.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { CoreProgram, propertyStep } from "../../src/type-inference/core/program.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import {
  withEveryRecord,
  withSolverSeam,
  type Proof,
  type ProofDemand,
} from "../../src/type-inference/core/solver.js";
import { REASON, STOPPED, type Item } from "../../src/type-inference/core/items.js";
import type { Obligation } from "../../src/type-inference/core/result.js";
import type { PlaceId, SourceSite } from "../../src/type-inference/graph.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { completedCore, coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import {
  combinedAnalyses,
  combinedMarkProblems,
  combinedStop,
  combinedStopRule,
  withReadsChanged,
  declineOf,
  heldDemands,
  heldFamily,
  stopDeclineProblem,
  unsettledStop,
  heldProblems,
  heldRun,
  heldStops,
  heldUnstopped,
  HELD_MODES,
  labelIdentities,
  type LabelIdentities,
  type LabelIdentity,
  withLabels,
  provenRelabel,
  provenRewording,
  SENTENCE_VARIANTS,
  recordedAnalysis,
  runProblems,
  randomCopyGraph,
  topologySources,
  phaseEnds,
  testedAllowances,
  testedStops,
  searchedStops,
  type CombinedStop,
  type HeldCase,
  widerThan,
} from "../helpers/type-core-held-host.js";
import { narrowingPass } from "../helpers/type-core/type-core-narrowing.js";
import { sampled } from "../helpers/sweep.js";
import {
  decisionOf,
  inMode,
  itemText,
  keptErrors,
  MODES,
  stopIdentity,
  stopSet,
} from "../helpers/type-core-oracles.js";
import { plannedContent, runGlobals } from "../helpers/type-core-route.js";
import {
  repeatedDecisions,
  standsForNullCheck,
  stopProblems,
  type Globals,
  type StopRun,
} from "../helpers/type-core-stop-oracle.js";

/*
 * The program stop through the candidate route, in its three layers (the owner's D4, option a′; the
 * runtime-check evidence rule of `docs/TESTING.md`): at a small test allowance the analysis stops, and the program still
 * compiles. The decision: a check that waits on the stop is moved to the runtime, with the reason its value gives (host
 * data its own, as unstopped; a value the stop leaves undecided `budget`), one warning says so, and a
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

/** (a): a typed parse's or load's default a stop left open declines (#1767, #1775's rule (R)). */
const OPEN_BY_STOP = "a typed parse's or load's default that a stop left open";

/** The plain gate's decline (#2080 part 2): a stop before admission settled left a store's check undecided. */
const UNDECIDED = "a store whose check was left undecided at the budget";

/** The plain gate's decline of `source` under `allowance`, read off the thrown error: its site's start. */
function undecidedAt(source: string, allowance: number): number {
  try {
    compiled(source, allowance);
  } catch (error) {
    assert.ok(error instanceof CandidateOutsideSlice, String(error));
    assert.equal(error.what, UNDECIDED, `${source} @${allowance}`);
    assert.equal(error.limit, true);
    return error.site.start;
  }
  assert.fail(`${source} @${allowance}: published`);
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
      // (a stop before admission settled leaves an inferred destination's check undecided: the plain gate declines)
      if (allowance === 1 && source.startsWith("let b = ")) {
        assert.equal(undecidedAt(source, allowance), source.indexOf("fromJson"));
        continue;
      }
      const { plan } = compiled(source, allowance);
      assert.ok(plan !== null, `${source} @${allowance}`);
      assert.deepEqual(ran(plan, '"wrong"'), { said: ["0", "AFTER"], failure: null }, source);
      assert.deepEqual(ran(plan, "5"), { said: ["5", "AFTER"], failure: null }, source);
    }
});

test("after a stop a typed parse inside a typed default keeps its record's fields (F18)", () => {
  const source =
    'let b = fromJson(hostValue, default: {x: fromJson("{}", default: {n: 0})}, files: false)\nsay b.x.n\nsay "AFTER"\nexit\n';
  // (a stop before admission settled leaves the inferred destination's check undecided: the plain gate declines)
  assert.equal(undecidedAt(source, 1), source.indexOf("fromJson"));
  const { plan } = compiled(source, analysisTotal(source));
  assert.ok(plan !== null);
  assert.deepEqual(ran(plan, '{"x":{"n":2}}'), { said: ["2", "AFTER"], failure: null });
  assert.deepEqual(ran(plan, '{"x":{"n":"wrong"}}'), { said: ["0", "AFTER"], failure: null });
});

test("after a stop a typed default's null leaves its level open, as without one (F18, ADR 0021 2.6)", () => {
  const source =
    "let b = fromJson(hostValue, default: {n: null, m: 0}, files: false)\nsay b.n\nsay b.m\nexit\n";
  // (a stop before admission settled leaves the inferred destination's check undecided: the plain gate declines)
  assert.equal(undecidedAt(source, 1), source.indexOf("fromJson"));
  const { plan } = compiled(source, analysisTotal(source));
  assert.ok(plan !== null);
  assert.deepEqual(ran(plan, '{"n":"text","m":4}'), { said: ["text", "4"], failure: null });
});

/**
 * A source's typed loads and parses as its plan reads them (`load` and `expected` lines, `plannedContent`), or how the
 * candidate route ends without one: no plan (its errors), or declined.
 */
/** The lost-check gate's decline (#1526 decision 2, condition 1). */
const LOST_CHECK = "a store whose check was lost at the budget";

function readers(source: string): string[] {
  try {
    const { plan, diagnostics } = compileSourceWithBackend(source, { globals: [] }, CORE_BACKEND);
    if (plan === null) return [`no plan: ${diagnostics.map((d) => d.code).join(",")}`];
    return plannedContent(plan, source)
      .filter((line) => /^(load|expected) /u.test(line))
      .map((line) => line.replace(/ repair=\w+$/u, ""));
  } catch (error) {
    if (error instanceof CandidateOutsideSlice) return [`declined: ${error.what}`];
    throw error;
  }
}

/**
 * The stops a reader family visits of a source in a mode (TESTING.md, "Sampled sweeps"): the program stops before
 * admission settles (`sampled`, from the first unit to the last before the first settled phase), each settled phase's
 * sample (`testedStops`), and the demand allowances at which a decision stops (`heldDemands`), each a run's wrapper.
 */
function readerStops(
  source: string,
  mode: (typeof HELD_MODES)[number],
): (<T>(make: () => T) => T)[] {
  const c: HeldCase = { name: source, slice: true, values: [], source };
  const settled = heldStops(c, mode);
  const request = coreRequest([{ path: "main.tease", source }], []);
  assert.ok(request !== null, source);
  const first =
    settled.length > 0
      ? Math.min(...settled.map((stop) => stop.allowance))
      : mode.run(() => analyseCore(request)).budget.total;
  const allowances = [
    ...sampled(Array.from({ length: first - 1 }, (_, i) => i + 1)),
    ...testedStops(settled).map((stop) => stop.allowance),
  ];
  return [
    ...allowances.map(
      (allowance) =>
        <T>(make: () => T): T =>
          withTestAllowance(allowance, make),
    ),
    ...heldDemands(c, mode).map(
      (allowance) =>
        <T>(make: () => T): T =>
          withTestDemandAllowance(allowance, make),
    ),
  ];
}

/** Whether `stop` stops `source`'s analysis before admission settled, where the plain gate reads (#2080 part 2). */
function unsettledAt(
  source: string,
  stop: <T>(make: () => T) => T,
  mode: (typeof HELD_MODES)[number],
): boolean {
  const request = coreRequest([{ path: "main.tease", source }], []);
  assert.ok(request !== null, source);
  const { budget } = mode.run(() => stop(() => analyseCore(request)));
  return budget.exhausted !== null && !budget.settled;
}

test("a stop does not change what a typed load or parse reads: a record without a field lacks it and an empty collection holds nothing, as unstopped (#1460, ADR 0021 1.10)", () => {
  // the family: each clause at each depth, in four modes, at stops before and after admission settles and at a
  // decision's demand stop: an absent field (a record's, a nested list's, below an object's property, an empty record)
  // through a load, where a parse declines unstopped as stopped (JSON's records need every field, #1458); an empty
  // collection (a nested list's, below a record's property) and a `null` beside a collection or a record (nothing below
  // a scalar, Codex r1's N1; a level all of whose literals hold nothing) through both or a load; an empty default as the
  // open boundary
  const sources = [
    ...["[{n: 1}, {m: 2}]", "[{}, {n: 1}]", "[[{n: 1}], [{m: 2}]]", "{xs: [{n: 1}, {m: 2}]}"].map(
      (fallback) => `let seed = load("seed", default: ${fallback})`,
    ),
    'let seed = fromJson("[]", default: [{n: 1}, {m: 2}])',
    ...["[null, {n: 1}]", "[[null], [{n: 1}]]"].map(
      (fallback) => `let seed = load("seed", default: ${fallback})`,
    ),
    ...["[[], [1]]", "[{xs: []}, {xs: [1]}]", "[null, [1]]", "[]"].flatMap((fallback) => [
      `let seed = load("seed", default: ${fallback})`,
      `let seed = fromJson("[]", default: ${fallback})`,
    ]),
  ].map((line) => `${line}\nsay "X"\nexit\n`);
  for (const source of sources)
    for (const mode of HELD_MODES) {
      const unstopped = mode.run(() => readers(source));
      for (const stop of readerStops(source, mode)) {
        // (or declined where the stop left the load's store without a result: #1526 decision 2, an accepted
        // over-decline, #1832, no result's reader standing for the natural check; before admission settled, the
        // inferred store's check is left undecided and the plain gate declines, after a decline unstopped too)
        const stopped = mode.run(() => stop(() => readers(source)));
        if (unsettledAt(source, stop, mode))
          assert.deepEqual(
            stopped,
            unstopped[0]?.startsWith("declined: ") ? unstopped : [`declined: ${UNDECIDED}`],
            `${source} (${mode.name})`,
          );
        else if (JSON.stringify(stopped) !== JSON.stringify([`declined: ${LOST_CHECK}`]))
          assert.deepEqual(stopped, unstopped, `${source} (${mode.name})`);
      }
    }
  // the unstopped readers the family holds every stop to, by the defaults' own types (V30 §13)
  assert.deepEqual(readers('let seed = load("seed", default: [{n: 1}, {m: 2}])\nexit\n'), [
    "load 11:50 list<{n: integer, m: integer}>",
  ]);
  assert.deepEqual(readers('let seed = load("seed", default: [[], [1]])\nexit\n'), [
    "load 11:43 list<list<integer>>",
  ]);
});

test("after a stop a literal answers a step it writes nothing for as unstopped where its syntax proves the answer: an object lacks it, null and an empty collection hold nothing (#1460)", () => {
  // every literal at every path of these steps to depth 2, at a stop before admission settles, in four modes, by its
  // distinct kinds and reasons: where the literal's own syntax proves the answer (an object at a first step it lacks:
  // it has no member steps; `null`; an empty collection read at its element step) it is the unstopped one; anywhere
  // else it is that, or it holds the stop's unknown, which stands for whatever the stop left unread, and no kind the
  // unstopped one lacks; never an answer without the unknown that drops a kind: a named step of a scalar or a
  // collection may be a member its kind declares (a dict's `keys`, a calendar duration's parts, Codex r2's N2), and a
  // composition keeps an unproved sibling's unknown
  const STOP = "unknown/16";
  const steps = ["element", "n", "index", "keys", "values", "months"];
  const paths = steps.flatMap((first) => [[first], ...steps.map((second) => [first, second])]);
  const proved = (expression: Expression, path: readonly string[]): boolean =>
    (expression.kind === "objectLiteral" &&
      !expression.properties.some((property) => property.name.name === path[0])) ||
    expression.kind === "nullLiteral" ||
    (path[0] === "element" &&
      (((expression.kind === "listLiteral" || expression.kind === "setLiteral") &&
        expression.elements.length === 0) ||
        (expression.kind === "dictLiteral" && expression.entries.length === 0)));
  for (const source of [
    'let s: (integer[] | object)?[] = [null, [1], {n: 2}, []]\nsay "X"\nexit\n',
    'let s: (integer[] | object)?[][] = [[null], [[1]], [{n: 2}, {}]]\nsay "X"\nexit\n',
    "let d = dict{n: 1}\nlet e = dict{}\nlet c = 1 calendar month\nexit\n",
  ]) {
    const request = coreRequest([{ path: "main.tease", source }], []);
    assert.ok(request !== null, source);
    const answered = (answers: Answers): Map<string, string> => {
      const out = new Map<string, string>();
      for (const node of answers.graph.nodes) {
        const expression = node.expression;
        if (expression === undefined || !/Literal$/u.test(expression.kind)) continue;
        for (const path of paths)
          out.set(
            `${expression.kind}@${expression.span.start.offset} ${path.join(".")}${proved(expression, path) ? " proved" : ""}`,
            // (its distinct kinds and reasons: a stop's composition keeps an item per writer, #1398's order)
            answers
              .valueAt(node, path)
              .items.map((item) => `${item.tag}/${item.reasons}`)
              .filter((item, at, all) => all.indexOf(item) === at)
              .sort()
              .join(" "),
          );
      }
      return out;
    };
    for (const mode of HELD_MODES) {
      const stopped: Answers = mode.run(() => withTestAllowance(1, () => analyseCore(request)));
      assert.equal(stopped.budget.settled, false, source);
      const unstopped = answered(mode.run(() => analyseCore(request)));
      const wrong = [...answered(stopped)].filter(([key, answer]) => {
        const want = unstopped.get(key) ?? "";
        if (answer === want) return false;
        if (key.endsWith(" proved")) return true;
        const got = answer.split(" ");
        const held = new Set(want.split(" "));
        return !got.includes(STOP) || got.some((item) => item !== STOP && !held.has(item));
      });
      assert.deepEqual(wrong, [], `${source} (${mode.name})`);
    }
  }
});

test("after a stop a load still takes its default for a stored value its default's type does not fit, warns, and restores the same (#1460)", () => {
  const object = (n: SerializableRuntimeValue) =>
    createSerializableObject([{ name: "n", value: n }]);
  for (const [source, stored, kept, repaired] of [
    // a field one record of the default lacks
    [
      'let seed = load("seed", default: [{n: 1}, {m: 2}])\nsay "BEFORE"\nsay seed[0].n\nsay "AFTER"\nexit\n',
      (n: SerializableRuntimeValue) => createSerializableList([object(n)]),
      ["BEFORE", "5", "AFTER"],
      ["BEFORE", "1", "AFTER"],
    ],
    // an element of an empty collection of the default
    [
      'let seed = load("seed", default: [[], [1]])\nsay "BEFORE"\nsay seed[1][0]\nsay "AFTER"\nexit\n',
      (n: SerializableRuntimeValue) =>
        createSerializableList([createSerializableList([]), createSerializableList([n])]),
      ["BEFORE", "5", "AFTER"],
      ["BEFORE", "1", "AFTER"],
    ],
    // an element beside a `null` element of the default (Codex r1's N1)
    [
      'let seed = load("seed", default: [null, [1]])\nlet inner = seed[1] otherwise [0]\nsay "BEFORE"\nsay inner[0]\nsay "AFTER"\nexit\n',
      (n: SerializableRuntimeValue) => createSerializableList([null, createSerializableList([n])]),
      ["BEFORE", "5", "AFTER"],
      ["BEFORE", "1", "AFTER"],
    ],
  ] as const) {
    const load = source.indexOf("load(");
    const end = source.indexOf(")\n") + 1;
    let stoppedPlans = 0;
    for (const mode of HELD_MODES)
      for (const stop of [<T>(make: () => T): T => make(), ...sampled(readerStops(source, mode))]) {
        // (a stop that leaves the load's store without a result declines, #1526 decision 2, an accepted over-decline,
        // #1832; one before admission settled leaves the inferred store's check undecided, and the plain gate
        // declines; every published plan reads as unstopped)
        const unsettled = unsettledAt(source, stop, mode);
        let plan;
        try {
          ({ plan } = mode.run(() =>
            stop(() => compileSourceWithBackend(source, { globals: [] }, CORE_BACKEND)),
          ));
        } catch (error) {
          assert.ok(
            error instanceof CandidateOutsideSlice &&
              error.what === (unsettled ? UNDECIDED : LOST_CHECK),
            `${source} (${mode.name})`,
          );
          continue;
        }
        assert.ok(plan !== null && !unsettled, `${source} (${mode.name})`);
        stoppedPlans++;
        const loaded = (value: SerializableRuntimeValue) => {
          const snapshot = createImmediatePacingRuntimeSnapshot(plan, {
            scriptStorage: [{ key: "seed", value }],
          });
          const restored = deserializeCheckpoint(
            serializeCheckpoint(createCheckpoint(plan, snapshot)),
          );
          const runs = [run(plan, snapshot), run(restored.plan, restored.snapshot)].map(
            (result) => ({
              said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
              warned: result.events.flatMap((event) =>
                event.kind === "developerWarning"
                  ? [`${event.code}@${event.span.start.offset}:${event.span.end.offset}`]
                  : [],
              ),
            }),
          );
          assert.deepEqual(runs[1], runs[0], `${source} (${mode.name}) restored`);
          return runs[0];
        };
        // a stored value its default's type fits is read; one it does not fit takes the default, with TSW016 at the load
        assert.deepEqual(loaded(stored(5)), { said: kept, warned: [] }, `${source} (${mode.name})`);
        assert.deepEqual(
          loaded(stored("wrong")),
          { said: repaired, warned: [`TSW016@${load}:${end}`] },
          `${source} (${mode.name})`,
        );
      }
    // (a stopped plan runs, not only the unstopped one in each mode)
    assert.ok(stoppedPlans > HELD_MODES.length, source);
  }
});

/**
 * #1767 (ADR 0021 1.10, #1526 condition 1, the lead's rulings (A′) and (R)): after a stop only literal data proves a
 * typed parse's or load's default, by its own syntax at every level (#1460), so a default that reads anything else
 * leaves the slice rather than publish a plan that reads what the natural plan may not: at every stop a plan reads the
 * natural plan's reader types and runs as the natural one, or the candidate route declines. A default that reads a
 * variable (directly, below a literal's property or element, below a written `object`, through a load) declines before
 * admission settles; a literal default and a level its own `null` leaves open never decline for it (before admission
 * settled the plain gate declines their inferred stores instead, #2080 part 2: (a) is met first where both apply).
 * Four modes, each source's sampled program stops and Astra's demand grid on #1755.
 */
test("after a stop a typed call's reader type a stop left open declines the plan, never read as every value (#1767)", () => {
  const cases = [
    [
      "variable",
      'let textHost = hostValue\nlet d = {n: 1.5}\nd.n = 0\nlet result = fromJson(textHost, default: d, files: false)\nsay result.n\nrepeat result.n {}\nsay "after"\nexit\n',
      '{"n":2}',
    ],
    [
      "below a literal",
      'let d = {m: 1}\nlet result = fromJson(hostValue, default: {n: d}, files: false)\nsay result.n.m\nsay "after"\nexit\n',
      '{"n":{"m":2}}',
    ],
    // (below a written `object`, whose plan keeps the default's names: Codex r2's B1)
    [
      "below a written object",
      'let d = {n: 0}\nlet result: object = fromJson(hostValue, default: d, files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":"bad"}',
    ],
    // (a written default below a written `object`: its stopped answer an `object` whose names the stop left out,
    // Codex r3's B1)
    [
      "a written default below a written object",
      'let d: object = {n: 0}\nlet result: object = fromJson(hostValue, default: d, files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":"bad"}',
    ],
    // (a written default below a literal's property and element, and below a load's literal: Codex r4's B1 and its
    // siblings)
    [
      "a written default below a literal",
      'let d: object = {m: 0}\nlet result: object = fromJson(hostValue, default: {n: d}, files: false)\nsay result.n.m\nsay "after"\nexit\n',
      '{"n":{"m":"bad"}}',
    ],
    [
      "a written default in a literal list",
      'let d: object = {n: 0}\nlet result: object[] = fromJson(hostValue, default: [d], files: false)\nsay result[0].n\nsay "after"\nexit\n',
      '[{"n":"bad"}]',
    ],
    [
      "a written default below a load's literal",
      'let d: object = {m: 0}\nlet result: object = load("k", default: {n: d})\nsay result.n.m\nsay "after"\nexit\n',
      "{}",
    ],
    // (a default read through a nested load of a computed key: Codex r5's B1)
    [
      "a default through a computed-key load",
      'let k = "k"\nlet d: object = {n: 0}\nlet result: object = fromJson(hostValue, default: load(k, default: d), files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":"bad"}',
    ],
    // (a computed key's load answers by its literal default: Codex r6's P2)
    [
      "literal default through a computed-key load",
      'let k = "k"\nlet result: object = fromJson(hostValue, default: load(k, default: {n: 0}), files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":"bad"}',
    ],
    // (a written scalar destination is the reader type, whatever its default reads: Codex r5's P2)
    [
      "literal reader: a written scalar",
      'let d = 0\nlet result: integer = fromJson(hostValue, default: d, files: false)\nsay result\nsay "after"\nexit\n',
      "2",
    ],
    // (a projection the syntax proves: literal data at a literal's property or element, Astra r1's B1, through a
    // projected part, Codex r8, and at a projected or computed index or through a nested load, Codex r9; an object below
    // a projection is not, its properties unproven after a stop)
    [
      "literal property's scalar",
      'let result = fromJson(hostValue, default: ({n: 0}).n, files: false)\nsay result\nsay "after"\nexit\n',
      "2",
    ],
    [
      "literal index's scalar",
      'let result = fromJson(hostValue, default: [0][0], files: false)\nsay result\nsay "after"\nexit\n',
      "2",
    ],
    [
      "literal index's list of scalars",
      'let result = fromJson(hostValue, default: [[1]][0], files: false)\nsay result[0]\nsay "after"\nexit\n',
      "[2]",
    ],
    [
      "literal property's projected scalar",
      'let result = fromJson(hostValue, default: ({p: ({n: 0}).n}).p, files: false)\nsay result\nsay "after"\nexit\n',
      "2",
    ],
    [
      "literal index's scalar at a projected index",
      'let result = fromJson(hostValue, default: ({p: [0][({i: 0}).i]}).p, files: false)\nsay result\nsay "after"\nexit\n',
      "2",
    ],
    [
      "literal index's scalar of a projected holder",
      'let result = fromJson(hostValue, default: ({p: ({q: [0]}).q}).p[0], files: false)\nsay result\nsay "after"\nexit\n',
      "2",
    ],
    [
      "literal index's scalar at a computed index",
      'let result = fromJson(hostValue, default: [0][load("i", default: 0)], files: false)\nsay result\nsay "after"\nexit\n',
      "2",
    ],
    [
      "literal property's list of a load",
      'let result = fromJson(hostValue, default: ({p: [load("k", default: 0)]}).p, files: false)\nsay result[0]\nsay "after"\nexit\n',
      "[2]",
    ],
    [
      "a literal's projected load of an object",
      'let result = fromJson(hostValue, default: ({p: [load("k", default: {n: 0})]}).p, files: false)\nsay result[0].n\nsay "after"\nexit\n',
      '[{"n":2}]',
    ],
    [
      "a literal's object element",
      'let result = fromJson(hostValue, default: [{n: 0}][0], files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":2}',
    ],
    [
      "a literal's structured property",
      'let result = fromJson(hostValue, default: ({p: {n: 0}}).p, files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":2}',
    ],
    [
      "literal",
      'let result = fromJson(hostValue, default: {n: 0}, files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":2}',
    ],
    [
      "literal below a written object",
      'let result: object = fromJson(hostValue, default: {n: 0}, files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":"bad"}',
    ],
    [
      "null field",
      'let result = fromJson(hostValue, default: {n: null}, files: false)\nsay result.n\nsay "after"\nexit\n',
      '{"n":"text"}',
    ],
  ] as const;
  const GRID = [16, 32, 64, 96, 120, 127, 128, 136, 192, 224, 240, 256];
  const readers = (run: StopRun, source: string) =>
    run.result.plan === null
      ? null
      : plannedContent(run.result.plan, source).filter((line) => /^(load|expected) /u.test(line));
  let declined = 0;
  for (const [kind, source, json] of cases) {
    const c: HeldCase = { name: kind, slice: true, values: [], source };
    // (a default that reads anything but literal data, at any level)
    const opens = !kind.startsWith("literal") && kind !== "null field";
    for (const mode of HELD_MODES) {
      const natural = heldRun(c, mode);
      assert.ok(natural.result.plan !== null, kind);
      const naturalRun = ran(natural.result.plan, json);
      assert.equal(naturalRun.failure, null, kind);
      // the candidate route's decline under a work or demand allowance: its reason
      const reasonOf = (allowance?: number, demand?: number): string | null => {
        const compile = () =>
          compileSourceWithBackend(source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND);
        try {
          mode.run(() =>
            allowance !== undefined
              ? withTestAllowance(allowance, compile)
              : withTestDemandAllowance(demand!, compile),
          );
        } catch (error) {
          if (error instanceof CandidateOutsideSlice) return error.what;
          throw error;
        }
        return null;
      };
      const judged = (stopped: StopRun, at: string, allowance?: number, demand?: number) => {
        if (stopped.result.plan === null) {
          const { exhausted, settled } = stopped.answers.budget;
          // (before admission settled, a default that reads anything but literal data declines with (a): its store
          // contract throws it while the plan's checks are built, before the plain gate reads; a literal default's
          // inferred store is left undecided, and the plain gate declines it, #2080 part 2)
          if (exhausted !== null && !settled)
            assert.equal(reasonOf(allowance, demand), opens ? OPEN_BY_STOP : UNDECIDED, at);
          else assert.ok(opens, `${at}: declined`);
          declined += 1;
          return;
        }
        assert.deepEqual(readers(stopped, source), readers(natural, source), at);
        assert.deepEqual(ran(stopped.result.plan, json), naturalRun, at);
      };
      for (const allowance of [
        ...sampled(Array.from({ length: natural.answers.budget.total - 1 }, (_, i) => i + 1)),
        ...testedStops(heldStops(c, mode)).map((stop) => stop.allowance),
      ]) {
        const stopped = heldRun(c, mode, allowance);
        const at = `${kind} (${mode.name}) @${allowance}`;
        judged(stopped, at, allowance);
        const { stoppedIn, settled } = stopped.answers.budget;
        if (opens && stoppedIn === "admission" && !settled)
          assert.equal(stopped.result.plan, null, `${at}: open, so declined`);
        // (after admission settled every finished answer stands: a published plan reads the natural reader and keeps every
        // natural check, `judged`; or the candidate declines it with the lost-check text, #1526 decision 2, condition 1:
        // `variable`'s store of host text a work stop left partial, an accepted over-decline, #1832; #1775's rule (R) is
        // untouched, it never covered settled stops)
        if (settled && stoppedIn !== null && stopped.result.plan === null)
          assert.throws(
            () =>
              mode.run(() =>
                withTestAllowance(allowance, () =>
                  compileSourceWithBackend(
                    source,
                    { globals: ["hostValue", "hostOther"] },
                    CORE_BACKEND,
                  ),
                ),
              ),
            (error) =>
              error instanceof CandidateOutsideSlice &&
              error.what === "a store whose check was lost at the budget",
            `${at}: settled: publishes, or declines with the lost-check text`,
          );
      }
      for (const demand of GRID)
        judged(
          heldRun(c, mode, undefined, demand),
          `${kind} (${mode.name}) demand ${demand}`,
          undefined,
          demand,
        );
    }
  }
  assert.ok(declined > 0, `${declined} declined`);
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
 * what a phase settled is never discarded by a later one, and a stop changes nothing of the
 * unstopped compile but the records its deferred marks name (the stop oracle, `helpers/type-core-stop-oracle.ts`). A
 * stop in a settled pass's walk or publication keeps admission's contracts (an inferred scalar's, a record's), the
 * findings (an error a copy brings, not a literal's), the quiet proofs and the whole plan (a default's check against a
 * written or written element type, Astra's B1 of round 2; an `otherwise`'s). Each mode's phases found in that mode; the
 * stop at the first unit of each settled phase and at its last, its phase asserted (the every-unit sweep runs outside
 * CI). `marked`: the code of an obligation a stop may leave undecided and the source text of its site, the first after
 * `after`: the stop marks it at one stop at least.
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
    // a domain is not the value's kinds: `integer?` copied where the value is only `null` imposes no
    // family on the fallback, so a text fallback still runs (Codex r9's B1)
    [
      'let v: integer? = null\nlet a = {v:v}\nlet b = a\nlet c = b.v\nsay c otherwise hostValue\nsay "AFTER"\nexit\n',
      [host("bad", 3)],
      [],
    ],
  ]);
});

/** A compile of `source` and its analysis, under an allowance where one is given. */
function stopRun(source: string, allowance?: number): StopRun & { readonly undecided: boolean } {
  const options = { globals: ["hostValue", "hostOther"] };
  const request = coreRequest([{ path: "main.tease", source }], options.globals);
  assert.ok(request !== null);
  const allowed = <T>(make: () => T): T =>
    allowance === undefined ? make() : withTestAllowance(allowance, make);
  // (the plain gate's decline, #2080 part 2, is no plan and no diagnostics, as `heldRun` records a decline)
  let undecided = false;
  const compile = (): StopRun["result"] => {
    try {
      return compileSourceWithBackend(source, options, CORE_BACKEND);
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice) || error.what !== UNDECIDED) throw error;
      undecided = true;
      return { diagnostics: [], plan: null };
    }
  };
  const both = () => ({ result: compile(), answers: analyseCore(request) });
  return {
    ...allowed(both),
    undecided,
    without: (omit) => allowed(() => withoutRecords(omit, both)),
  };
}

/**
 * `stopProblems` of a stop as `declines` says the plain gate treats it (#2080 part 2): a declined stop's problems but
 * its missing plan, what the oracle compares beside the plan (diagnostics, records, the check ledger); a published one's
 * all of them.
 */
function gatedProblems(
  c: Omit<Parameters<typeof stopProblems>[0], "stopped"> & {
    readonly stopped: ReturnType<typeof stopRun>;
  },
  declines: boolean,
): string[] {
  assert.equal(c.stopped.undecided, declines, declines ? "declined" : "published");
  return stopProblems(c).filter((problem) => !declines || problem !== "no plan");
}

/** `stopRun` made inside `mode` (orders, allowances), its omissions run again inside it (`stopProblems` asks them). */
function stopRunIn(
  mode: <T>(make: () => T) => T,
  source: string,
  allowance?: number,
): ReturnType<typeof stopRun> {
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
 * The stop oracle itself: the whole plan, a mark excusing only its own record. Changes to a compile
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
  // a walk stop marks the default, which excuses its own check and not the guard; where `vessel` holds a host
  // value, its lowest walk stop loses the vessel's check, which `{amount: "x"}` passes, and the candidate declines it
  // (#1526 decision 2), so the oracle is judged on its variant, `vessel` a typed load's, which its reader carries
  const original =
    'let nums: number?[] = [null,1.25]\nlet pack={nums:nums}\nlet twin=pack\nsay twin.nums.get(4, default:hostValue)\nlet vessel=hostOther\nvessel.amount=4\nsay "AFTER"\nexit\n';
  assert.throws(
    () => stopRun(original, walkEnds(original)[0]),
    (error: unknown) =>
      error instanceof CandidateOutsideSlice &&
      error.what === "a store whose check was lost at the budget",
  );
  const source = original.replace(
    "let vessel=hostOther",
    'let vessel=load("v", default: {other: 1})',
  );
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
 * A fix a stop gives in words (#1449): at a settled walk stop whose unchecked region holds a store, its
 * warning gives the fix in words where the unstopped compile shows code, and the oracle takes it for the same diagnostic:
 * the unstopped one with every fix in words. The sources cover a check, a project's second file, and a kept value whose
 * text holds the author's own: a full stop, an apostrophe, quotes and listed words in a text literal or a comment (Codex
 * r1's F3, r2's F1, r3's F1; the comment's fix is words unstopped too). Generated over the stopped warning's sentences
 * (its first, its consequence, its cause and its fix) and the changes a stop could make, every one is reported: other
 * wording, a quoted name lost (Codex r1's F1), code kept from the unstopped fix (its F2), other code, code or other words
 * where the unstopped compile gives words (r2's F1, r3's F1), one more sentence, another severity, code, site or file, and
 * the warning published twice.
 */
const IN_WORDS: readonly (readonly SourceFile[])[] = [
  'let root = {f0: 1}\nroot.f0 = hostValue\nsay "BEFORE"\nrepeat root.f0 {say "ok"}\nsay "AFTER"\nexit\n',
  ...[
    "2.5",
    ...["a. B", "a' as in 'b", "it's", "'b'", "use it as in Write"].map((text) =>
      JSON.stringify(text),
    ),
  ]
    .map((text) => JSON.stringify(text))
    .concat(["/* a' as in 'b */ \"2.5\""])
    .map(
      (value) =>
        `let state = {amount: 2.5}\nstate.amount = 17\nstate.amount = fromJson(${value}, default: null)\nsay state.amount\nexit\n`,
    ),
].map((source) => [{ path: "main.tease", source }]);

test("the stop oracle takes a fix in words for the unstopped one's code, and nothing else (TABLE r4.162)", () => {
  const globals = ["hostValue", "hostOther"];
  const projects = [
    ...IN_WORDS,
    [
      { path: "main.tease", source: 'say "main"\nexit\n' },
      { ...IN_WORDS[0]![0]!, path: "part.tease" },
    ],
  ];
  for (const files of projects) {
    const request = coreRequest(files, globals);
    assert.ok(request !== null);
    const allowed = <T>(allowance: number | undefined, make: () => T): T =>
      allowance === undefined ? make() : withTestAllowance(allowance, make);
    const compile = () => compileProjectWithBackend(files, { globals }, CORE_BACKEND);
    // (a run's omissions, its compile in words among them, made once each)
    const runAt = (allowance?: number): StopRun => {
      const both = () => ({ result: compile(), answers: analyseCore(request) });
      const made = new Map<string, ReturnType<typeof both>>();
      return {
        ...allowed(allowance, both),
        without: (omit, key) => {
          if (!made.has(key))
            made.set(
              key,
              allowed(allowance, () => withoutRecords(omit, both)),
            );
          return made.get(key)!;
        },
      };
    };
    // (the project's warning, in its last file)
    const path = files.at(-1)!.path;
    const warning = (each: StopRun): Diagnostic => {
      const found = each.result.diagnostics.filter((d) => d.code === "TSV041");
      assert.equal(found.length, 1);
      assert.equal("path" in found[0]! ? found[0].path : null, path);
      return found[0]!;
    };
    // a settled walk stop whose warning gives the fix in words
    const unstopped = runAt();
    const code = warning(unstopped).message;
    const walk = phaseEnds(analyseCore(request).budget.total, (allowance) => {
      const { stoppedIn, settled } = allowed(allowance, () => analyseCore(request)).budget;
      return settled ? stoppedIn : null;
    }).get("walk");
    assert.ok(walk !== undefined);
    const inWords = (allowance: number) =>
      allowed(allowance, compile).diagnostics.find((d) => d.code === "TSV041")?.message !== code;
    // (the walk's stops every twelfth allowance from its first, as the anchors take them; the first where the unstopped
    // fix is words already)
    let at = walk[0];
    while (at <= walk[1] && !inWords(at)) at += 12;
    if (at > walk[1]) at = walk[0];
    const stopped = runAt(at);
    const words = warning(stopped).message;
    const where = `${path} @${at}`;
    const problems = (want: StopRun, got: StopRun) =>
      stopProblems({ unstopped: want, stopped: got, fitting: [], violating: [] });
    assert.deepEqual(problems(unstopped, stopped), [], where);
    // each message's sentences: its first, its consequence, its fix and its cause, whose subject is quoted
    const parts = (message: string) => {
      const consequence = "If it is, the Tease stops with an error at this line.";
      const [first = "", rest = "", ...more] = message.split(` ${consequence} `);
      assert.equal(more.length, 0, message);
      // (the fix ends where the cause's quoted subject starts)
      const cause = rest.indexOf(". '") + 1;
      return { first, consequence, fix: rest.slice(0, cause), cause: rest.slice(cause + 1) };
    };
    const [was, is] = [parts(code), parts(words)];
    assert.ok(!is.fix.includes(", as in '"), where);
    assert.equal(
      [is.first, is.consequence, is.fix, is.cause].join(" "),
      words,
      `${where}: the stopped warning's four sentences`,
    );
    const said = (change: Partial<typeof is>) => {
      const { first, consequence, fix, cause } = { ...is, ...change };
      return `${first} ${consequence} ${fix} ${cause}`;
    };
    // `each` with its warning changed
    const changed = (each: StopRun, change: Partial<ProjectDiagnostic>): StopRun => ({
      ...each,
      result: {
        ...each.result,
        diagnostics: each.result.diagnostics.map((d) =>
          d.code === "TSV041" ? { ...d, ...change } : d,
        ),
      },
    });
    // (each code example of the unstopped fix, its quoted text ending before a comma or a full stop)
    const examples = [...was.fix.matchAll(/, as in '.*?'(?=[,.](?:\s|$))/g)].map(
      (match) => match[0],
    );
    const { span } = warning(stopped);
    const shifted = (position: typeof span.start) => ({
      ...position,
      offset: position.offset + 1,
      column: position.column + 1,
    });
    const messages = [
      said({ first: is.first.replace(" holds ", " keeps ") }),
      said({ first: is.first.replace(/^'[^']*'/, "It") }),
      said({ consequence: "If not, the Tease stops with an error at this line." }),
      said({ cause: is.cause.replace("comes from outside", "is set outside") }),
      said({ cause: "Its type is known before the script runs." }),
      // (other words, with or without the names)
      said({ fix: is.fix.replace(/ first\.$/, " at once.") }),
      said({ fix: `${is.fix.split(" ")[0]!} the value first.` }),
      // (code added to the words, one code example of two kept, other code)
      ...(examples.length > 0
        ? [
            said({ fix: is.fix.replace(/\.$/, `${examples.at(-1)!}.`) }),
            said({ fix: `${was.fix.slice(0, was.fix.lastIndexOf(", as in '"))}, as in 'say 0'.` }),
          ]
        : []),
      ...(examples.length > 1 ? [said({ fix: was.fix.replace(examples[0]!, "") })] : []),
      `${words} Check it again.`,
    ];
    const cases = [
      ...messages.map((message) => [unstopped, changed(stopped, { message })] as const),
      // (code where the unstopped compile gives words)
      ...(code === words
        ? []
        : [[changed(unstopped, { message: words }), changed(stopped, { message: code })] as const]),
      [unstopped, changed(stopped, { severity: "error" })],
      [unstopped, changed(stopped, { code: "TSV042" })],
      [
        unstopped,
        changed(stopped, { span: { ...span, start: shifted(span.start), end: shifted(span.end) } }),
      ],
      [unstopped, changed(stopped, { path: path === "main.tease" ? "part.tease" : "main.tease" })],
      [
        unstopped,
        {
          ...stopped,
          result: {
            ...stopped.result,
            diagnostics: [...stopped.result.diagnostics, warning(stopped)],
          },
        },
      ],
    ] as const;
    cases.forEach(([want, got], index) =>
      assert.notDeepEqual(problems(want, got), [], `${where}: change ${index}`),
    );
  }
});

/**
 * Before admission settled a written store's mark stands for its records within its value: a
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
 * C5's record where the retained state decides its receiver's shape (Astra r3's N1): a store of a
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
 * mark of the store that owes it, the one move of a record's site the oracle accepts, and only there.
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
 * the finishing path derives a unit's findings as the analysis does. A parameter whose `null` default
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
 * Read as the value for a fixed need, a domain says nothing of emptiness: a copied written list that may
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
 * The key's finished contract is a domain too: `b.v` is only `null` at the read though `v` may hold an
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
 * stop before that unit leaves the element's contract unfinished; the stores' syntax decides it (`[2, 3]`: integers),
 * so the default keeps its check. A copied element type that admits `null` (`integer?[]`) is a domain that
 * leaves the default's family undecided: the stop marks it "not checked (budget)" at the default.
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
 * Source 4 decides only what every store's syntax tells: objects with other properties leave a read of one
 * undecided, which may find it missing (its check and warning, marked); a copy of a written place is checked by
 * admission's A4 against the type the copy inherits, from the copied value, so its store is marked, standing for that
 * record. At a stop in the setup and at the last before admission settled, the oracle finds nothing else; each program
 * stores into an inferred place, so the plain gate declines it there (#2080 part 2), with no plan to run.
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
        gatedProblems(
          {
            unstopped,
            stopped: stopRun(source, allowance),
            fitting: [fitting],
            violating: [violating],
          },
          true,
        ),
        [],
        `${source} @${allowance}`,
      );
  }
});

/**
 * Before admission settled nothing it decided is read (A6: a later pass may admit a store this one
 * rejected): a store into an inferred place is marked at its site, its type undecided, and one into a written type
 * keeps its check and its boundary; at a stop in the setup and at the last before admission settled, the oracle finds
 * nothing else. The inferred store's mark leaves its check undecided, so the plain gate declines the program (#2080
 * part 2); with every store written, the program publishes and runs as unstopped.
 */
test("a stop before admission settled marks the stores into inferred places and keeps the written ones", () => {
  const source = 'let count = 1\ncount = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n';
  const unstopped = stopRun(source);
  const store = source.indexOf("hostValue");
  const written = source.replace("let count = 1", "let count: integer = 1");
  const writtenUnstopped = stopRun(written);
  for (const allowance of [ALLOWANCE, lastUnsettled(written)]) {
    const stopped = stopRun(written, allowance);
    assert.equal(stopped.answers.budget.settled, false, `written @${allowance}`);
    const runs = { fitting: [host(2, 3)], violating: [host(1.5, 3), host(2, 1.5)] };
    assert.deepEqual(
      gatedProblems({ unstopped: writtenUnstopped, stopped, ...runs }, false),
      [],
      `written @${allowance}`,
    );
  }
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
      gatedProblems(
        { unstopped, stopped, fitting: [host(2, 3)], violating: [host(1.5, 3), host(2, 1.5)] },
        true,
      ),
      [],
      `@${allowance}`,
    );
  }
});

/**
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-135): before admission settled no
 * syntax decision is made, so every store into an inferred place is marked at its site whatever its literals give, a
 * store the unstopped analysis rejects among them (its error stands for the mark's content); at a settled stop, as
 * unstopped, the error stands. Disagreements of a scalar, a list, an object and an object's nested field, an integer
 * then a decimal (no error), and a later copy (`let m = n`), in both orders, at a stop in the setup, the last stop
 * before admission settled, the first after it and the last. Every stop of every one in both orders, outside CI: 0
 * differing (13,542 analyses).
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
 * and where its admission gives others the passes start again, so a stop before they do settles nothing:
 * its finishing path marks such a store as it marks every store into an inferred place, and the store's error
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
      // (the plain gate's decline, #2080 part 2, is no plan and no diagnostics, as in `stopRun`)
      let undecided = false;
      const compile = (): StopRun["result"] => {
        try {
          return compileSourceWithBackend(source, options, CORE_BACKEND);
        } catch (error) {
          if (!(error instanceof CandidateOutsideSlice) || error.what !== UNDECIDED) throw error;
          undecided = true;
          return { diagnostics: [], plan: null };
        }
      };
      const both = () => inOrder(() => ({ result: compile(), answers: analyseCore(request) }));
      const runAt = (allowance?: number): ReturnType<typeof stopRun> => {
        const allowed = <T>(make: () => T): T =>
          allowance === undefined ? make() : withTestAllowance(allowance, make);
        undecided = false;
        const made = allowed(both);
        return { ...made, undecided, without: (omit) => allowed(() => withoutRecords(omit, both)) };
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
        // (the store into the inferred place is left undecided: the plain gate declines, #2080 part 2)
        assert.deepEqual(
          gatedProblems({ unstopped, stopped, fitting: [], violating: [] }, true),
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
        // (#2080: a stop whose stopped mark's completion result was lost declines, no plan; its obligations stand. A
        // decline stands only with a limit's reason at the phase it belongs to, `stopDeclineProblem`)
        const both = () => {
          let result: Pick<CompilationResult, "diagnostics" | "plan">;
          let what: string | null = null;
          try {
            result = compileSourceWithBackend(source, options, CORE_BACKEND);
          } catch (error) {
            if (!(error instanceof CandidateOutsideSlice)) throw error;
            result = { diagnostics: [], plan: null };
            what = error.what;
          }
          const answers = analyseCore(request);
          const problem =
            what === null ? null : stopDeclineProblem(what, unsettledStop(answers.budget), null);
          if (problem !== null) throw new Error(`${source}: ${problem}`);
          return { result, answers };
        };
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
 * errors it brought: an object stored with host data inside it (Codex r8's copy of fields), a typed parse
 * inside a typed default, a copy whose conflict A2 finds where it meets the place (the error inside the store's value),
 * and a copy whose conflict is reached only through a cycle of copies that adds steps, its
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
  // (every program stores into an inferred place, so the plain gate declines each stop, #2080 part 2)
  const problems = (
    unstopped: StopRun,
    stopped: ReturnType<typeof stopRun>,
    fitting: readonly Globals[] = [],
    violating: readonly Globals[] = [],
  ) => gatedProblems({ unstopped, stopped, fitting, violating }, true);
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
  const narrowed: ReturnType<typeof stopRun> = {
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
 * A host read's ingress is structural (Codex r12's B1): whatever the script stores into the host global,
 * the read's external data meets its boundary check at any stop, settled or not; its kinds come from the read itself
 * only where the script stores at no path at or above it. At a stop in the setup each compile keeps every record but
 * the marks' own; the store into the host global is one into an inferred place, so the plain gate declines (#2080
 * part 2).
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
      gatedProblems({ unstopped: stopRun(source), stopped, fitting: [], violating: [] }, true),
      [],
      source,
    );
  }
});

/**
 * Before admission settled, a store into a written type checks each part of a collection literal the type reaches at the
 * part's own site, as A8 does (Codex r12's final-check B2): a host read as a written list's element, a
 * host property the script stored, a nested list's element. A part that reads a place the stop left undecided, a
 * variable or a property of one, marks the store at its literal whatever host read beside it (#1611).
 * At a stop in the setup and at the last before admission settled, the oracle finds nothing; where the program also
 * stores into an inferred place, the plain gate declines it (#2080 part 2), with no plan to run.
 */
test("a stop before admission settled checks a written store's literal parts at their own sites", () => {
  for (const [source, fitting, violating, declines] of [
    ["let xs: integer[] = [hostValue]\nexit\n", [host(2)], [host("bad")], false],
    [
      "hostValue.n = 2\nlet xs: integer[] = [hostValue.n]\nexit\n",
      [host(object({ n: 1 }))],
      [],
      true,
    ],
    ["let xs: integer[][] = [[hostValue]]\nexit\n", [host(2)], [host("bad")], false],
    [
      "let p = hostValue otherwise hostOther\nlet xs: integer[] = [p, hostOther]\nexit\n",
      [host(2)],
      [host("bad")],
      true,
    ],
    [
      "let p = hostValue otherwise hostOther\nlet xs: integer[] = [hostOther, p]\nexit\n",
      [host(2)],
      [host("bad")],
      true,
    ],
    [
      "let named = {v: hostValue}\nlet xs: integer[] = [named.v, hostOther]\nexit\n",
      [host(2)],
      [host("bad")],
      true,
    ],
  ] as const) {
    const unstopped = stopRun(source);
    for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
      const stopped = stopRun(source, allowance);
      assert.equal(stopped.answers.budget.settled, false, `${source} @${allowance}`);
      assert.deepEqual(
        gatedProblems({ unstopped, stopped, fitting, violating }, declines),
        [],
        `${source} @${allowance}`,
      );
    }
  }
});

/**
 * #1594: a stopped run's `without` reruns its compile and analysis at the run's own allowance (`StopRun.without`).
 * At the first stop after admission settled, a `get` whose default's element domain admits `null` publishes a plan
 * whose content the oracle excuses only where `without` measures it: the held host's own stopped run (`heldRun`) gives
 * no problem, and one made outside its allowance (`withTestAllowance` around `heldUnstopped`, whose `without` then runs
 * unstopped) is refused. (The issue's witness, a literal-zero `get` with a named default, stores into inferred places, so
 * before admission settles the plain gate declines it, #2080 part 2.)
 */
test("the stop oracle refuses a stopped run whose without leaves the run's allowance (#1594)", () => {
  const source =
    'let items: integer?[] = [2,null]\nlet a = {xs: items}\nlet b = a\nsay b.xs.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n';
  const values = [0, 2, "bad", true, null].map((value) => ({
    globals: { hostValue: value, hostOther: value },
    says: typeof value === "number" ? ["AFTER"] : null,
  }));
  const c: HeldCase = { name: "ownDefault", source, slice: true, values };
  const mode = HELD_MODES[0]!;
  const allowance = Math.min(
    ...heldStops(c, mode, Number.MAX_SAFE_INTEGER).map((stop) => stop.allowance),
  );
  const { run: unstopped } = heldUnstopped(c, mode);
  const judge = (stopped: StopRun): string[] =>
    stopProblems({
      unstopped,
      stopped,
      fitting: values.filter((each) => each.says !== null).map((each) => each.globals),
      violating: values.filter((each) => each.says === null).map((each) => each.globals),
    });
  const kept = heldRun(c, mode, allowance);
  assert.equal(kept.answers.budget.settled, true);
  // (the oracle measures the content: it reruns `without`)
  let reruns = 0;
  assert.deepEqual(
    judge({ ...kept, without: (omit, key) => ((reruns += 1), kept.without(omit, key)) }),
    [],
  );
  assert.ok(reruns > 0);
  const outside = withTestAllowance(allowance, () => heldUnstopped(c, mode)).run;
  assert.throws(() => judge(outside), /another stop/);
});

/**
 * #1631: a rerun without the run's demand allowance can stop in the same phase, settled, at the same program allowance,
 * yet under another demand allowance none of its decisions stops, so its compile differs. The issue's witness at program
 * allowance 1,886 (2,039 before #1251 made no narrowing index for it) and demand allowance 27, whose stopped compile the
 * candidate now declines (#1832): on its analysis with the reference's plan one text changed, the run's own `without` is
 * judged, the uncapped run's refused.
 */
test("the stop oracle refuses a stopped run whose without leaves the run's demand allowance (#1631)", () => {
  const c: HeldCase = {
    name: "domain-nested",
    slice: true,
    values: [],
    source:
      'let root = {inside: {f0: hostValue}}\nlet first = root\nroot = {inside: {f0: hostOther}}\nsay "BEFORE"\nrepeat first.inside.f0 {say "ok"}\nsay "AFTER"\nexit\n',
  };
  const mode = HELD_MODES[0]!;
  const unstopped = heldRun(c, mode, undefined, 27);
  const stopped = heldRun(c, mode, 1886, 27);
  const uncapped = heldRun(c, mode, 1886);
  for (const { budget } of [stopped.answers, uncapped.answers])
    assert.deepEqual([budget.allowance, budget.stoppedIn, budget.settled], [1886, "walk", true]);
  assert.ok(stopped.answers.budget.decisions.some((d) => d.stopped));
  assert.ok(!uncapped.answers.budget.decisions.some((d) => d.stopped));
  // (there the candidate may decline the stopped compile, #1526 decision 2, an accepted over-decline, #1832: no completion
  // tells `root`'s partial check from the natural one; a published plan runs as the natural one)
  try {
    const plan = mode.run(() =>
      withTestDemandAllowance(27, () =>
        withTestAllowance(1886, () =>
          compileSourceWithBackend(c.source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND),
        ),
      ),
    ).plan;
    const natural = heldRun(c, mode).result.plan!;
    assert.ok(plan !== null);
    for (const value of [2, "x", null])
      assert.deepEqual(
        runGlobals(plan, { hostValue: value, hostOther: value }),
        runGlobals(natural, { hostValue: value, hostOther: value }),
      );
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.ok(error instanceof CandidateOutsideSlice && error.what === LOST_CHECK, String(error));
  }
  // (the oracle's scope check, on the stopped analysis with the reference's plan and its `say "BEFORE"` text changed, so
  // the oracle reruns the stopped run: its own rerun is judged, the uncapped run's refused)
  // (the reference under demand allowance 27 is declined too, at its decision stop; the natural plan stands for it)
  const base: StopRun = {
    ...unstopped,
    result: { ...unstopped.result, plan: unstopped.result.plan ?? heldRun(c, mode).result.plan },
  };
  assert.ok(base.result.plan !== null);
  const plan = structuredClone(base.result.plan);
  const pending: unknown[] = [plan];
  let changed = 0;
  while (pending.length > 0 && changed === 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    for (const [key, value] of Object.entries(node))
      if (value === "BEFORE" && changed === 0) {
        Reflect.set(node, key, "OTHER");
        changed += 1;
      }
    pending.push(...Object.values(node));
  }
  assert.equal(changed, 1);
  const edited: StopRun = { ...stopped, result: { ...stopped.result, plan } };
  // (a combined stop, judged under its rule: its finishing read answers `first` from its stores' syntax through the copy
  // of `root`, as the natural analysis does, where the demand-only run's read stopped, #1604)
  const rule = combinedStopRule(c, mode, base, stopped.answers);
  const excused = {
    records: new Set([...rule.records.keys(), ...rule.relabelled.records, ...rule.coarse.records]),
    checks: new Set([
      ...rule.checks.keys(),
      ...rule.owing,
      ...rule.relabelled.checks,
      ...rule.coarse.checks.keys(),
    ]),
  };
  const judge = (run: StopRun): string[] =>
    stopProblems({ unstopped: base, stopped: run, fitting: [], violating: [], excused });
  assert.notDeepEqual(judge(edited), []);
  assert.throws(
    () => judge({ ...edited, without: uncapped.without }),
    /the demand allowance \d+ at its decision \[\d+,\[[^\]]*\]\], not the run's 27/,
  );
  // (and the reference's rerun without its completion, Codex r1's F1 on #1662: a decision of the reference stopped, its
  // uncapped rerun refused. The issue's `tally` witness stopped before admission settled, where the plain gate declines
  // it, #2080 part 2, so nothing reruns its reference; the reference here at demand 27 stands for it)
  assert.ok(unstopped.answers.budget.decisions.some((d) => d.stopped));
  assert.throws(
    () =>
      stopProblems({
        unstopped: { ...base, without: heldRun(c, mode).without },
        stopped: edited,
        fitting: [],
        violating: [],
        excused,
      }),
    /the demand allowance \d+ at its decision \[\d+,\[[^\]]*\]\], not the run's 27/,
  );
});

/**
 * #1642 and the stop oracle's ledger of each check's content (the lead's ruling on #1663): every check a record owns uses
 * one count of its content, so a further copy is an extra check and a missing one a lost check, on either side. The
 * issue's `dict-path` witness reversed, under demand allowance 256, stopped at program allowance 2,464: the reference's
 * TSV043 mark and the stopped run's each carry the receiver's null-check both runs publish, so neither is lost. Codex's
 * controls on #1663, each clean as compiled: r1's (a stop at program allowance 1) loses the check where the stopped run
 * keeps its mark but drops it and its guard, and changes the plan where it drops the guard alone; r2's, a copy the rule
 * accepts published twice; r3's, a further copy where a run publishes the check; r4's, a boundary that forms only with
 * the marks, doubled; r5's, a further copy of a boundary both runs owe; r6's, the reference losing its own check; and a further copy of a
 * check the stopped run alone owns. Before admission settled the stores into inferred places leave their checks
 * undecided, so the plain gate declines those stopped runs (#2080 part 2): the ledger is compared without a plan, and r1's
 * guard alone, a plan change, is made on the stopped and reference analyses carrying the natural run's plan. The
 * `dict-path` witness's written dict type is outside the slice, so its compiles decline, on main as here.
 */
test("the stop oracle counts each check's content on both sides, a further copy an extra and a missing one lost (#1642)", () => {
  const source =
    'let p = hostValue otherwise hostOther\nlet box: integer[] dict = dict{k: []}\nbox.k = [p, hostOther]\nsay "AFTER"\nexit\n';
  const c: HeldCase = { name: "dict-path", source, slice: true, values: [] };
  const receiver = (answers: Answers) =>
    answers.checks.filter(
      (check) =>
        check.kind === "null-check" &&
        check.target === "box" &&
        source.slice(check.site.start, check.site.end) === "box.k",
    );
  for (const mode of [HELD_MODES[1]!, HELD_MODES[3]!]) {
    const reference = heldRun(c, mode, undefined, 256);
    const stopped = heldRun(c, mode, 2464, 256);
    const [owed, kept] = [receiver(reference.answers), receiver(stopped.answers)];
    assert.equal(owed.length, 1, mode.name);
    assert.deepEqual(kept, owed, mode.name);
    assert.ok(
      stopped.answers.budget.deferred.some(
        (mark) =>
          mark.code === "TSV043" && JSON.stringify(mark.obligation) === JSON.stringify(owed[0]),
      ),
      mode.name,
    );
    // (the written dict type is outside the candidate slice, so both compiles decline, on main as here: the ledger is
    // what is compared)
    assert.deepEqual(
      [declineOf(reference), declineOf(stopped)],
      ["this written type", "this written type"],
      mode.name,
    );
    assert.deepEqual(
      stopProblems({ unstopped: reference, stopped, fitting: [], violating: [] }),
      [],
      mode.name,
    );
  }
  const plain =
    'let p = hostValue otherwise hostOther\nlet box = {k: [1]}\nbox.k = [p, hostOther]\nsay "AFTER"\nexit\n';
  const o: HeldCase = { name: "object", source: plain, slice: true, values: [] };
  const mode = HELD_MODES[1]!;
  const reference = heldRun(o, mode, undefined, 256);
  const stopped = heldRun(o, mode, 1, 256);
  const [check] = reference.answers.checks.filter(
    (each) => each.kind === "null-check" && plain.slice(each.site.start, each.site.end) === "box.k",
  );
  assert.ok(check !== undefined);
  const text = JSON.stringify(check);
  assert.ok(
    stopped.answers.budget.deferred.some((mark) => JSON.stringify(mark.obligation) === text),
  );
  // (the plain gate declines the stopped run: no plan, its ledger compared)
  assert.deepEqual([stopped.result.plan, declineOf(stopped)], [null, UNDECIDED]);
  const judge = (run: StopRun): string[] =>
    stopProblems({ unstopped: reference, stopped: run, fitting: [], violating: [] }).filter(
      (problem) => problem !== "no plan",
    );
  assert.deepEqual(judge(stopped), []);
  // (the check left out of the answers, and the guard it gives the store, `requireExisting`, out of the plan)
  const unguarded = (plan: StopRun["result"]["plan"]): StopRun["result"]["plan"] => {
    const copy = structuredClone(plan);
    const pending: unknown[] = [copy];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || typeof node !== "object") continue;
      if (
        "kind" in node &&
        node.kind === "assign" &&
        "span" in node &&
        typeof node.span === "object" &&
        node.span !== null &&
        "so" in node.span &&
        node.span.so === check.site.start
      )
        Reflect.deleteProperty(node, "requireExisting");
      pending.push(...Object.values(node));
    }
    return copy;
  };
  const dropped = <T extends { readonly answers: Answers; readonly result: StopRun["result"] }>(
    each: T,
    checks = true,
  ): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.filter((x) => !checks || JSON.stringify(x) !== text),
    },
    result: { ...each.result, plan: unguarded(each.result.plan) },
  });
  assert.ok(
    judge({
      ...dropped(stopped),
      without: (omit, key) => dropped(stopped.without(omit, key)),
    }).includes(`lost check ${text}`),
  );
  // (the guard alone: a plan change at the store whose mark owes the reference's own check there is a plan problem, never
  // that mark's content. The plain gate declines the stopped compile, and the reference's too, its decision stopping in
  // the restarted pass, #2080 part 2: each side is its own analysis, the reference's owing the check, with the natural
  // run's plan, each rerun likewise; equal as built, and the store's guard, `requireExisting`, toggled in the stopped
  // plan is a plan problem)
  assert.deepEqual([reference.result.plan, declineOf(reference)], [null, UNDECIDED]);
  const naturalRun = heldRun(o, mode);
  assert.ok(naturalRun.result.plan !== null);
  const built: StopRun = {
    ...stopped,
    result: naturalRun.result,
    without: (omit, key) => ({
      ...stopped.without(omit, key),
      result: naturalRun.without(omit, `${key} naturalRun`).result,
    }),
  };
  const builtReference: StopRun = {
    ...reference,
    result: naturalRun.result,
    without: (omit, key) => ({
      ...reference.without(omit, key),
      result: naturalRun.without(omit, `${key} naturalRun`).result,
    }),
  };
  const judgeAgainstNatural = (run: StopRun): string[] =>
    stopProblems({ unstopped: builtReference, stopped: run, fitting: [], violating: [] });
  assert.deepEqual(judgeAgainstNatural(built), []);
  let toggled = 0;
  const toggle = (plan: StopRun["result"]["plan"]): StopRun["result"]["plan"] => {
    const copy = structuredClone(plan);
    const pending: unknown[] = [copy];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || typeof node !== "object") continue;
      if (
        "kind" in node &&
        node.kind === "assign" &&
        "span" in node &&
        typeof node.span === "object" &&
        node.span !== null &&
        "so" in node.span &&
        node.span.so === check.site.start
      ) {
        if ("requireExisting" in node) Reflect.deleteProperty(node, "requireExisting");
        else Reflect.set(node, "requireExisting", true);
        toggled += 1;
      }
      pending.push(...Object.values(node));
    }
    return copy;
  };
  const guardChanged = <T extends { readonly result: StopRun["result"] }>(each: T): T => ({
    ...each,
    result: { ...each.result, plan: toggle(each.result.plan) },
  });
  assert.ok(
    judgeAgainstNatural({
      ...guardChanged(built),
      without: (omit, key) => guardChanged(built.without(omit, key)),
    }).some((problem) => problem.startsWith("plan ")),
  );
  assert.ok(toggled > 0);
  // (a further copy of the owned check where a run publishes it is an extra: what forms with the marks credits no content
  // a record owns, Codex r3's control on #1663)
  const again = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some((x) => JSON.stringify(x) === text)
        ? [...each.answers.checks, structuredClone(check)]
        : each.answers.checks,
    },
  });
  assert.ok(
    judge({
      ...again(stopped),
      without: (omit, key) => again(stopped.without(omit, key)),
    }).includes(`extra check ${text}`),
  );
  // (the reference's own check is one count of its content too: a reference that loses it has a lost check, Codex r6's
  // control on #1663)
  const lacking = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.filter((x) => JSON.stringify(x) !== text),
    },
  });
  assert.ok(
    stopProblems({
      unstopped: {
        ...lacking(reference),
        without: (omit, key) => lacking(reference.without(omit, key)),
      },
      stopped,
      fitting: [],
      violating: [],
    }).includes(`lost check ${text}`),
  );
  // (a check the stopped run alone owns, which the reference neither owns nor publishes, takes no count from what forms
  // with the marks: a further copy of it is an extra; the natural reference, forward, a stop at program allowance 1)
  const natural0 = heldRun(o, HELD_MODES[0]!);
  const early0 = heldRun(o, HELD_MODES[0]!, 1);
  const [own0] = early0.answers.budget.deferred.filter(
    (mark) => mark.code === "TSV043" && plain.slice(mark.site.start, mark.site.end) === "box.k",
  );
  assert.ok(own0 !== undefined);
  const owned0 = JSON.stringify(own0.obligation);
  assert.ok(!natural0.answers.checks.some((x) => JSON.stringify(x) === owned0));
  assert.ok(early0.answers.checks.some((x) => JSON.stringify(x) === owned0));
  assert.deepEqual([early0.result.plan, declineOf(early0)], [null, UNDECIDED]);
  const once0 = (run: StopRun): string[] =>
    stopProblems({ unstopped: natural0, stopped: run, fitting: [], violating: [] }).filter(
      (problem) => problem !== "no plan",
    );
  assert.deepEqual(once0(early0), []);
  const again0 = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some((x) => JSON.stringify(x) === owned0)
        ? [...each.answers.checks, structuredClone(own0.obligation)]
        : each.answers.checks,
    },
  });
  assert.ok(
    once0({
      ...again0(early0),
      without: (omit, key) => again0(early0.without(omit, key)),
    }).includes(`extra check ${owned0}`),
  );
  // (and a further copy of a boundary that forms only with the marks, #1448's, is an extra: what forms takes one credit,
  // Codex r4's control on #1663, forward with the sharing, a settled walk stop at program allowance 1,200: the boundary
  // forms there on main and with #1323, whose natural total is lower)
  const formedCase: HeldCase = {
    name: "formed-boundary",
    source:
      'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\nrepeat root.f0 {say "ok"}\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const plainRun = heldRun(formedCase, HELD_MODES[0]!);
  const walked = heldRun(formedCase, HELD_MODES[0]!, 1200);
  const isBoundary = (x: Answers["checks"][number]): boolean =>
    x.boundary &&
    x.target === "root" &&
    formedCase.source.slice(x.site.start, x.site.end) === "hostValue";
  assert.equal(plainRun.answers.checks.filter(isBoundary).length, 0);
  const [boundary] = walked.answers.checks.filter(isBoundary);
  assert.ok(boundary !== undefined);
  const formedJudge = (run: StopRun): string[] =>
    stopProblems({ unstopped: plainRun, stopped: run, fitting: [], violating: [] });
  assert.deepEqual(formedJudge(walked), []);
  const doubled = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some(isBoundary)
        ? [...each.answers.checks, structuredClone(boundary)]
        : each.answers.checks,
    },
  });
  assert.ok(
    formedJudge({
      ...doubled(walked),
      without: (omit, key) => doubled(walked.without(omit, key)),
    }).includes(`extra check ${JSON.stringify(boundary)}`),
  );
  // (a further copy of the boundary both runs owe, at 'hostOther', is an extra too: what forms takes no credit for a
  // content the reference owes, Codex r5's control on #1663)
  const isOwed = (x: Answers["checks"][number]): boolean =>
    x.boundary &&
    x.target === "root" &&
    formedCase.source.slice(x.site.start, x.site.end) === "hostOther";
  assert.equal(plainRun.answers.checks.filter(isOwed).length, 1);
  const [owedBoundary] = walked.answers.checks.filter(isOwed);
  assert.ok(owedBoundary !== undefined);
  const owedTwice = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: each.answers.checks.some(isOwed)
        ? [...each.answers.checks, structuredClone(owedBoundary)]
        : each.answers.checks,
    },
  });
  assert.ok(
    formedJudge({
      ...owedTwice(walked),
      without: (omit, key) => owedTwice(walked.without(omit, key)),
    }).includes(`extra check ${JSON.stringify(owedBoundary)}`),
  );
  // a check one record owns and the combined stop's rule accepts is one credit: a second copy of it is an extra (Codex
  // r2's control on #1663, forward with the sharing, demand 256, a stop at program allowance 1)
  const shapes: HeldCase = {
    name: "object-shapes",
    source:
      'let boxes = [{n:1},{k:2}]\nlet box = boxes[hostValue]\nbox.n = hostOther\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const forward = HELD_MODES[0]!;
  const natural = heldRun(shapes, forward, undefined, 256);
  const early = heldRun(shapes, forward, 1, 256);
  const rule = combinedStopRule(shapes, forward, natural, early.answers);
  const excused = {
    records: new Set([...rule.records.keys(), ...rule.relabelled.records, ...rule.coarse.records]),
    checks: new Set([
      ...rule.checks.keys(),
      ...rule.owing,
      ...rule.relabelled.checks,
      ...rule.coarse.checks.keys(),
    ]),
  };
  const [owner] = early.answers.budget.deferred.filter(
    (mark) =>
      mark.code === "TSV043" && shapes.source.slice(mark.site.start, mark.site.end) === "box.n",
  );
  assert.ok(owner !== undefined);
  const owned = JSON.stringify(owner.obligation);
  assert.ok(excused.checks.has(owned));
  const twice = <T extends { readonly answers: Answers }>(each: T): T => ({
    ...each,
    answers: {
      ...each.answers,
      checks: [...each.answers.checks, structuredClone(owner.obligation)],
    },
  });
  // (the plain gate declines the stopped run, #2080 part 2: its ledger is compared)
  assert.deepEqual([early.result.plan, declineOf(early)], [null, UNDECIDED]);
  const shaped = (run: StopRun): string[] =>
    stopProblems({ unstopped: natural, stopped: run, fitting: [], violating: [], excused }).filter(
      (problem) => problem !== "no plan",
    );
  assert.deepEqual(shaped(early), []);
  assert.ok(
    shaped({ ...twice(early), without: (omit, key) => twice(early.without(omit, key)) }).includes(
      `extra check ${owned}`,
    ),
  );
});

/**
 * At a stop (Astra r3 on #1273): a fix's code holds the author's text only where no other diagnostic lies
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
 * parts from the literal's syntax, never from the solver (Codex r13's S1): a set's element, a dict's value,
 * a set inside a dict; and a stop changes no site, an error inside an add's literal staying at the add's argument.
 * At a stop in the setup and at the last before admission settled, each error, its site, its rule's
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
 * literal's values is read in one place (Codex r14), and a written store's checks name its parts as the
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
 * the child's own read does, beside its known siblings, never `budget` where that read keeps a type (Astra r6 B1):
 * a written child, a union's, a nullable's, at a stop before admission settled; a decided one at every settled
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
 * silently (Astra r6 B2). A written type wider than the value is no type for it (an `integer?` may hold
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
 * admission settled and in the settled walk.
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
 * lazily among them (S3 §5): at every settled walk stop, `src.first`'s `at` and `valueAt` hold the kinds
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
 * A literal's composed questions read a child through the same sources as the child's own question: at
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
 * A store marked with its type undecided stands for its records within its value on both sides alike (Codex r14):
 * a check there that the stopped analysis keeps as the unstopped one has it is that record, so a host
 * index read below the store is no extra check, at a stop in the setup and at the last before admission settled; a
 * check there that the unstopped analysis lacks, with or without the marks, is still reported. The stores are into
 * inferred places, so the plain gate declines each stop (#2080 part 2): the records and the check ledger are compared.
 */
test("a marked store's records within its value are compared alike on both sides", () => {
  const source = "let items = [[1]]\nlet v = items[hostOther]\nsay v[0]\nexit\n";
  const unstopped = stopRun(source);
  for (const allowance of [ALLOWANCE, lastUnsettled(source)]) {
    const stopped = stopRun(source, allowance);
    assert.equal(stopped.answers.budget.settled, false, `@${allowance}`);
    assert.deepEqual(
      gatedProblems({ unstopped, stopped, fitting: [host(2, 0)], violating: [host(2, 1.5)] }, true),
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
  const problems = gatedProblems(
    {
      unstopped,
      stopped: { ...added(stopped), without: (omit, key) => added(stopped.without(omit, key)) },
      fitting: [],
      violating: [],
    },
    true,
  );
  assert.deepEqual(problems, [`extra check ${JSON.stringify(extra)}`]);
});

/**
 * Before admission settled, a store into a written type is checked by admission's own C1, the derivation the analysis
 * runs unstopped, reading what the stop retained (Astra r4's B1): two wrong elements give one
 * error, a record literal its own kind, in a list, a set, a dict and a nested list; and admission's mixed-element check
 * (ADR 0021 1.3) as it runs it, a mixed literal's grouping and an error that only it finds, written or inferred, and a
 * join of two literals' (#1272); a written
 * parameter's every call, a dead one too (Codex r16, r17). At the sample (`sampled`) of the stops before admission
 * settled the errors, their sites and sentences equal the unstopped ones.
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
    const last = lastUnsettled(source);
    for (const allowance of sampled(Array.from({ length: last }, (_, i) => i + 1))) {
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
 * its records within its value. At a stop in the setup and at the last before admission settled the
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
 * After a settled stop a boundary's type is a read like any other (Astra r4's B2): where admission retained
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
      for (const [phase, [low, high]] of phaseEnds(unstopped.budget.total, phaseOf))
        for (const allowance of testedAllowances(phase, low, high))
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
 * #1216: a settled walk stop adds a redundant read check of `state.ticks`, read by its key's contract
 * whose external item lost the ingress the value read keeps, so the count's consumer checks it as host data no ingress
 * store brought. The stop oracle takes it as the count's mark content (#1448); the check is pinned by its
 * publication, counted at every stop of the settled phases in the analysis's own order: the test fails where the count
 * moves (it goes when #1216 lands).
 */
test("#1216's redundant check stands at its counted stops", () => {
  const source =
    'let seed = {ticks: 2, title: "ok"}\nlet state = seed\nstate = hostValue\nrepeat state.ticks {}\nsay state.title\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const analyse = (allowance: number): Answers =>
    withTestAllowance(allowance, () => analyseCore(request));
  const check =
    '{"kind":"copy-type","target":"state.ticks","against":["unknown"],"on":"validate external data state.ticks","site":{"file":0,"start":77,"end":88},"boundary":true}';
  const has = (answers: Answers): boolean =>
    answers.checks.some((each) => JSON.stringify(each) === check);
  const unstopped = analyseCore(request);
  assert.equal(has(unstopped), false);
  let count = 0;
  for (const [phase, [low, high]] of phaseEnds(unstopped.budget.total, (allowance) => {
    const { stoppedIn, settled } = analyse(allowance).budget;
    return settled ? stoppedIn : null;
  }))
    for (const allowance of testedAllowances(phase, low, high))
      if (has(analyse(allowance))) count += 1;
  assert.equal(count, 96);
});

/**
 * #1432, #1415 (S3 §5; S8's mark-ownership rule): after a settled program stop, a read the finishing walk
 * answers by a domain holds the host data its key's stores hold, as the unstopped read does, so its consumer owes its
 * check (a mark carrying the unstopped obligation) and the store's boundary forms: through a dictionary's values
 * list (#1452), and where an unrestricted written type stands, whose store owes no other boundary (#1450). The anchors
 * (`heldFamily`: each holder at depth 1, read by a repeat count and by an interpolation) at the sample of every twelfth
 * stop of each settled phase and its last (`testedStops`), forward with the sharing and reversed without it; the whole
 * family runs outside CI.
 */
test("a settled stop keeps the checks of the host data a place's stores hold (#1432, #1415)", () => {
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!])
    for (const c of heldFamily(true)) {
      const { run: unstopped, problems } = heldUnstopped(c, mode);
      assert.deepEqual(problems, [], `${c.name}, ${mode.name}`);
      const stops = testedStops(heldStops(c, mode, 12));
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
 * #1501 (the owner's reviewer's control on #1536): host data stored into an unrestricted written element keeps its
 * boundary (`copy-type xs.element`, against `unknown`, at `hostValue`) at the walk's settled stops in source order, owned or
 * kept, its domain's `unknown` being opaque; before the finishing read took that reason the walk's stops lost it (895; 783 since #1251 makes no narrowing index for this program).
 */
test("a settled stop keeps the boundary of host data an unrestricted written element holds, at the walk's stops (#1501)", () => {
  const c = heldFamily(true).find((each) => each.name === "writtenList-1-repeat-plain")!;
  assert.equal(
    c.source,
    'let xs: list = [hostValue, 4]\nsay "BEFORE"\nrepeat xs[0] {say "ok"}\nsay "AFTER"\nexit\n',
  );
  const mode = HELD_MODES[0]!;
  const { run: unstopped } = heldUnstopped(c, mode);
  // the reviewer's own stop: forward order, program allowance 783, a settled walk stop, where the boundary of
  // `hostValue` (16:25) was lost
  const boundary = unstopped.answers.checks.find(
    (check) =>
      check.target === "xs.element" &&
      check.boundary &&
      check.site.start === 16 &&
      check.site.end === 25,
  );
  assert.deepEqual(boundary?.against, ["unknown"]);
  const request = coreRequest(
    [{ path: "main.tease", source: c.source }],
    ["hostValue", "hostOther"],
  )!;
  const { stoppedIn, settled } = mode.run(() =>
    withTestAllowance(783, () => analyseCore(request)),
  ).budget;
  assert.deepEqual({ stoppedIn, settled }, { stoppedIn: "walk", settled: true });
  assert.deepEqual(heldProblems(c, mode, 783, unstopped), [], "walk @783");
  // (and every eighth of the walk's stops, where the finishing read answers the repeat count's domain)
  const stops = heldStops(c, mode, 8).filter((stop) => stop.phase === "walk");
  assert.ok(stops.length > 0);
  for (const { allowance } of stops)
    assert.deepEqual(heldProblems(c, mode, allowance, unstopped), [], `walk @${allowance}`);
});

/**
 * #1501: after a settled stop the finishing read follows a domain's host data where its contract's `unknown` carries no
 * reason but the opaque one, as a written open domain's does (the held family's `writtenList` and its siblings above).
 * The same reason marks a reference's member, a speaker's property and a handle: a stop of a read of one changes nothing
 * of its unstopped analysis (judged at the analysis, as the candidate route declines speakers).
 */
test("a settled stop changes nothing of a read of a reference's member, a speaker's property or a handle (#1501)", () => {
  const cases: HeldCase[] = (
    [
      [
        "reference member",
        "speaker vera { mood: 1 }\nvera.mood = hostValue\nlet alias = vera",
        "alias.mood",
      ],
      ["speaker property", "speaker vera { mood: hostValue }", "vera.mood"],
      [
        "reference union",
        'speaker vera { length: 2 }\nlet pool: dict = dict{a: [hostValue], b: vera}\nlet alias = pool.get("a", default: vera)',
        "alias.length",
      ],
      ["handle", "let alias = timer async hidden 1 s {}", "alias.length"],
    ] as const
  ).map(([name, setup, read]) => ({
    name,
    source: `${setup}\nsay "BEFORE"\nrepeat ${read} {say "ok"}\nsay "AFTER"\nexit\n`,
    slice: false,
    values: [],
  }));
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!])
    for (const c of cases) {
      const { run: unstopped } = heldUnstopped(c, mode);
      const stops = testedStops(heldStops(c, mode, 12));
      assert.ok(stops.length > 0, `${c.name}, ${mode.name}`);
      for (const { allowance, phase } of stops)
        assert.deepEqual(
          heldProblems(c, mode, allowance, unstopped),
          [],
          `${c.name}, ${mode.name}, ${phase} @${allowance}`,
        );
    }
});

/** A `get` whose result nothing consumes, its default `hostOther`: a fitting value and `null` run on, `bad` is rejected. */
function unusedGet(name: string, setup: readonly string[], receiver: string): HeldCase {
  return {
    name,
    source: [
      ...setup,
      'say "BEFORE"',
      `${receiver}.get(4, default: hostOther)`,
      'say "AFTER"',
      "exit",
      "",
    ].join("\n"),
    slice: true,
    values: [
      ...[2, null].map((value) => ({
        globals: { hostValue: 2, hostOther: value },
        says: ["BEFORE", "AFTER"],
      })),
      { globals: { hostValue: 2, hostOther: "bad" }, says: null },
    ],
  };
}

/**
 * #1563 (S8's mark-ownership rule; C10): a `get` whose result nothing consumes reads its receiver's element first in the
 * walk, so a walk stop may leave that read unfinished, and the finishing read decides the default's family by structure
 * alone: a projection of a literal no place holds by the literal's cells (`[[hostValue, 4][0]]`, the issue's; a
 * dictionary literal's `values` list by the dictionary's), a store of one by the stores' syntax through the same cells,
 * and a requirement one domain leaves to several families or to every kind by the next domain that gives one (a written
 * `list` or union receiver: the stores' syntax). At the sample of every eighth settled stop of each phase and its last
 * (`testedStops`), forward with the sharing and reversed without it, all five preserve the unstopped check against the
 * integer family. The
 * projection, stored projection and written-list cases also reject `bad` before `AFTER`; dictionary values and the
 * written union are analysis-only (the candidate route declines them).
 */
test("a settled stop keeps the family of an unused get's default that structure decides (#1563)", () => {
  const cases = [
    unusedGet("projection", [], "[[hostValue, 4][0]]"),
    unusedGet("dictionary values", [], "[(dict {a: hostValue, b: 4}).values[0]]"),
    unusedGet("stored projection", ["let xs = [({f: 4, g: hostValue}).f]"], "xs"),
    unusedGet("written list", ["let xs: list = [4]"], "xs"),
    unusedGet("written union", ["let xs: (integer|string)[] = [4]"], "xs"),
  ];
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!])
    for (const c of cases) {
      const { run: unstopped, problems } = heldUnstopped(c, mode);
      assert.deepEqual(problems, [], `${c.name}, ${mode.name}`);
      assert.ok(
        unstopped.answers.checks.some(
          (check) =>
            check.target === "hostOther" &&
            !check.boundary &&
            isDeepStrictEqual(check.against, ["integer", "number"]),
        ),
        `${c.name}, ${mode.name}`,
      );
      const stops = testedStops(heldStops(c, mode, 8));
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
 * #1563, Codex r1's B1 on #1581: structure decides a projection only where every literal it may read has a part at the
 * step, so a selection of two objects of which one lacks `f` leaves `.f` undecided, and the read's obligations stay:
 * the natural analysis's null-checks of the selection and of its `f` (its property and its index read) are kept or
 * owned at each phase's sample of its settled stops (`testedStops`) in four modes. The unused default's family, which no
 * structure decides there, is reported lost as #1580's forms are, and nothing else: at the sample of every eighth stop,
 * forward with the sharing and reversed without it.
 */
test("a settled stop keeps a projection's read obligations where one literal lacks its step (#1563)", () => {
  const c = unusedGet("lacking step", [], "[[{f: [hostValue, 4]}, {g: 4}][0].f[0]]");
  const request = coreRequest(
    [{ path: "main.tease", source: c.source }],
    ["hostValue", "hostOther"],
  )!;
  const obligation = (check: Answers["checks"][number]) => JSON.stringify(check);
  for (const mode of HELD_MODES) {
    const { run: unstopped, problems } = heldUnstopped(c, mode);
    assert.deepEqual(problems, [], mode.name);
    const nullChecks = unstopped.answers.checks.filter((check) => check.kind === "null-check");
    assert.equal(nullChecks.length, 2, mode.name);
    for (const { allowance, phase } of testedStops(heldStops(c, mode))) {
      const stopped = mode.run(() => withTestAllowance(allowance, () => analyseCore(request)));
      const owed = new Set(
        [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)].map(
          obligation,
        ),
      );
      for (const check of nullChecks)
        assert.ok(
          owed.has(obligation(check)),
          `${mode.name}, ${phase} @${allowance}: ${check.target}`,
        );
    }
    if (mode !== HELD_MODES[0] && mode !== HELD_MODES[3]) continue;
    const lost = unstopped.answers.checks.find(
      (check) => check.target === "hostOther" && !check.boundary,
    );
    assert.ok(lost !== undefined, mode.name);
    const reported = [
      `unowned check ${obligation(lost)}`,
      'forbidden {"hostValue":2,"hostOther":"bad"} said ["BEFORE","AFTER"]',
    ];
    for (const { allowance, phase } of testedStops(heldStops(c, mode, 8)))
      assert.deepEqual(
        heldProblems(c, mode, allowance, unstopped).filter((found) => !reported.includes(found)),
        [],
        `${mode.name}, ${phase} @${allowance}`,
      );
  }
});

/**
 * #1563's forms structure does not decide: an element whose kinds the solver derives by a rule (a conversion's here; an
 * operation's, a fallback's, a `get`'s and a comparison's alike) is not decided after a stop, so where the walk stopped
 * before the receiver's element was read, the default's mark stands against `unknown`, "not checked (budget)" at the
 * default, and the oracle reports the unstopped check lost and `bad` running on (#1580, for #1526's completion).
 * Forward with the sharing, at every eighth settled stop.
 */
test("a settled stop reports an unused get's default lost where only a rule decides its family (#1563)", () => {
  const c = unusedGet("conversion", [], "[toInteger(hostValue, default: 3)]");
  const mode = HELD_MODES[0]!;
  const { run: unstopped, problems } = heldUnstopped(c, mode);
  assert.deepEqual(problems, [], c.name);
  const lost = unstopped.answers.checks.find(
    (check) =>
      check.target === "hostOther" &&
      !check.boundary &&
      isDeepStrictEqual(check.against, ["integer", "number"]),
  );
  assert.ok(lost !== undefined);
  const request = coreRequest(
    [{ path: "main.tease", source: c.source }],
    ["hostValue", "hostOther"],
  )!;
  let reported = 0;
  for (const { allowance, phase } of searchedStops(heldStops(c, mode, 8))) {
    const found = heldProblems(c, mode, allowance, unstopped);
    if (found.length === 0) continue;
    reported += 1;
    assert.deepEqual(
      found,
      [
        `unowned check ${JSON.stringify(lost)}`,
        'forbidden {"hostValue":2,"hostOther":"bad"} said ["BEFORE","AFTER"]',
      ],
      `${phase} @${allowance}`,
    );
    const marks = mode
      .run(() => withTestAllowance(allowance, () => analyseCore(request)))
      .budget.deferred.filter((mark) => mark.obligation.target === "hostOther");
    assert.deepEqual(
      marks.map((mark) => [mark.code, mark.obligation.against]),
      [["TSV041", ["unknown"]]],
      `${phase} @${allowance}`,
    );
  }
  assert.ok(reported > 0);
});

/** A held case `let r = <receiver>.get(4, default: hostOther)`, its runs `hostValue` 2 and `hostOther` each of `values`. */
function storedGet(
  name: string,
  setup: readonly string[],
  receiver: string,
  values: readonly [SerializableRuntimeValue, boolean][],
): HeldCase {
  return {
    name,
    source: [
      ...setup,
      'say "BEFORE"',
      `let r = ${receiver}.get(4, default: hostOther)`,
      'say "AFTER"',
      "exit",
      "",
    ].join("\n"),
    slice: true,
    values: values.map(([value, fits]) => ({
      globals: { hostValue: 2, hostOther: value },
      says: fits ? ["BEFORE", "AFTER"] : null,
    })),
  };
}

/** A held case from #1487's kit: `lines`, then `use` between `BEFORE` and `AFTER`, its runs `hostValue` each of these. */
function keptCase(
  name: string,
  lines: readonly string[],
  use: string,
  says: (value: SerializableRuntimeValue) => readonly string[] | null,
  slice = true,
): HeldCase {
  return {
    name,
    source: [...lines, 'say "BEFORE"', use, 'say "AFTER"', "exit", ""].join("\n"),
    slice,
    values: [2, 0, 2.5, -1, "bad", true, null].map((value) => ({
      globals: { hostValue: value, hostOther: 3 },
      says: says(value),
    })),
  };
}

/** `repeat <count> {say "ok"}`'s lines for a count, or `null` where the count is no whole number of zero or more. */
const repeated = (count: SerializableRuntimeValue): readonly string[] | null =>
  typeof count === "number" && Number.isInteger(count) && count >= 0
    ? ["BEFORE", ...Array<string>(count).fill("ok"), "AFTER"]
    : null;

/**
 * Every eighth settled stop of each phase and its last, under a demand allowance that stops a decision (the `which`th
 * largest, or `demand`), in a mode: the case's problems there (`heldProblems` under the combined stop's rule) and the
 * clauses the rule accepted.
 */
function combinedStops(
  c: HeldCase,
  mode: (typeof HELD_MODES)[number],
  each: (where: string, problems: readonly string[], clauses: readonly string[]) => void,
  which = 0,
  demand = heldDemands(c, mode)[which],
): void {
  assert.ok(demand !== undefined, `${c.name}, ${mode.name}: no decision stops`);
  const { run: unstopped } = heldUnstopped(c, mode, demand);
  const { stoppedAt } = combinedAnalyses([{ path: "main.tease", source: c.source }], mode, demand);
  for (const { allowance, phase } of searchedStops(heldStops(c, mode, 8, demand))) {
    const stopped = stoppedAt(allowance);
    each(
      `${c.name}, ${mode.name}, demand ${demand}, ${phase} @${allowance}`,
      heldProblems(c, mode, allowance, unstopped, demand),
      [...combinedStopRule(c, mode, unstopped, stopped).checks.values()],
    );
  }
}

/**
 * #1560, #1561 (S8's mark-ownership rule at a combined stop): under a demand allowance that stops a
 * decision, a read the demand stop leaves `unknown` owes a conservative check, but after a settled program stop the
 * finishing walk answers that read itself, by structure or a domain, and owes what the natural analysis owes there: no
 * check at `1` in `x otherwise 1` where the left is a literal's projection, the natural family's at a `get`'s default,
 * none on a written `list` receiver, none at an interpolation whose operand is a number. The issues' four witnesses
 * at every eighth settled stop in four modes: nothing changed that the demand-only run's marks or the rule's first clause
 * do not stand for, which some stop takes.
 */
test("a combined stop owes what the natural analysis owes where its finishing walk answers a read (#1560, #1561)", () => {
  const held = heldFamily(false);
  const cases = [
    held.find((c) => c.name === "literalProperty-1-fallback-plain")!,
    held.find((c) => c.name === "getRead-1-fallback-plain")!,
    keptCase(
      "written list receiver",
      ["let xs: list = [hostValue, 4]"],
      'repeat (xs[0] otherwise 2) {say "ok"}',
      (value) => repeated(value ?? 2),
    ),
    keptCase(
      "interpolated get",
      ["let items = [1]"],
      'repeat 2 {say "x"}\nsay "${items.get(4, default: items.get(4, default: hostValue)) * 2}"',
      () => null,
      false,
    ),
  ];
  let first = 0;
  for (const c of cases)
    for (const mode of HELD_MODES)
      combinedStops(c, mode, (where, problems, clauses) => {
        assert.deepEqual(problems, [], where);
        first += clauses.filter((clause) => clause === "a").length;
      });
  assert.ok(first > 0);
});

/**
 * #1560: the finishing read's host frontier reaches through a copy whose decision stopped, as the
 * demand-only run's read does, so the host data `root` holds keeps its boundary (`copy-type root against object` at
 * `hostValue`) through two copies, the first stopped whole. In four modes at every eighth settled stop under each demand
 * allowance that stops a decision.
 */
test("a combined stop's finishing read reaches through a copy whose decision stopped (#1560)", () => {
  const c = heldFamily(false).find((each) => each.name === "copies-2-interpolation-plain")!;
  for (const mode of HELD_MODES)
    for (const which of heldDemands(c, mode).keys())
      combinedStops(c, mode, (where, problems) => assert.deepEqual(problems, [], where), which);
});

/**
 * Other clauses at a combined stop, including (w): marks at a check's target and site whose
 * checks together let through exactly the kinds the reference's check does are that check in other words, whatever the
 * finishing read answered from (a written `list?` receiver's null check, an `integer?` element's count by a null check,
 * an `object`'s property read; two places copying each other, answered without a written type; a set's empty check,
 * its domain non-emptiness whatever family it names); (a) from the finishing walk's own reads (a fallback's left in
 * requirement mode) and at a member's presence check by its receiver's read at its unlisted property (a ring's), every
 * open read of the check's unit answered; and a boundary against
 * `unknown`, which has no plan content, dropped where the undecided store mark stands at the site of the store holding it
 * (a dictionary's value read through its `values`, forward, also parenthesized or in a parenthesized literal). Each case at every eighth settled stop under the largest
 * demand allowance that stops a decision (the copying places under each), in the modes where the clause arises, nothing
 * left over and the clause taken.
 */
test("a combined stop owes the reference's check in other words, or a boundary's undecided store mark (#1561)", () => {
  const cases = [
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[3]!],
      c: keptCase(
        "nullable list",
        ["let xs: list? = [hostValue, 4]"],
        'repeat xs[0] {say "ok"}',
        repeated,
      ),
    },
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[3]!],
      c: keptCase(
        "nullable integer elements",
        ["let xs: integer?[] = [hostValue, 4]"],
        'repeat xs[0] {say "ok"}',
        repeated,
      ),
    },
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[3]!],
      c: keptCase(
        "written object",
        ["let xs: object = {f: hostValue}"],
        'repeat xs.f {say "ok"}',
        repeated,
      ),
    },
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[1]!],
      c: heldFamily(false).find((c) => c.name === "twoWay-1-arithmetic-laterStore")!,
      each: true,
    },
    // ((w) on an empty check: the set's non-emptiness, whatever family the demand-only check named, `list` for a set; its
    // member's kind check the coarse (a) reading's counted class, the selection's element read left open in its unit)
    {
      clause: "w",
      modes: [HELD_MODES[0]!],
      c: keptCase(
        "written set",
        ["let xs: set = set[hostValue, 4]"],
        'repeat xs.first {say "ok"}',
        repeated,
        false,
      ),
      coarse: "element",
    },
    // ((a) from the finishing walk's own read: a fallback's left in requirement mode, which the stores' syntax decides
    // where the open written element alone would not, forward under demand 11)
    {
      clause: "a",
      modes: [HELD_MODES[0]!],
      c: heldFamily(false).find((c) => c.name === "writtenList-2-fallback-plain")!,
      each: true,
    },
    // ((a) at a member's presence check by every read its consumer makes: the receiver at the unlisted step `#`, which
    // the stop left `unknown` and the finishing walk answers from the ring's literals, reversed under demand 45: two
    // units below its decision's 47 (43 since #1221 charges the event searches by comparison, 4 more since #1073 PR 2's
    // consumers look up a descendant demand's narrowing), the stop at 46 past that read)
    {
      clause: "a",
      modes: [HELD_MODES[1]!],
      c: heldFamily(false).find((c) => c.name === "ring-1-written-plain")!,
      demand: 45,
    },
    ...[
      "function build {return dict {a: hostValue, b: 4}}",
      // (a parenthesized value and a parenthesized literal, which the lowering does not materialize: Codex r2's B3)
      "function build {return dict {a: (hostValue), b: 4}}",
      "function build {return (dict {a: hostValue, b: 4})}",
    ].map((line) => ({
      clause: "z",
      modes: [HELD_MODES[0]!],
      c: keptCase(
        `dictionary values of a result: ${line}`,
        [line],
        'repeat build().values[0] {say "ok"}',
        repeated,
        false,
      ),
    })),
  ];
  for (const { clause, modes, c, each = false, coarse, demand } of cases)
    for (const mode of modes) {
      let taken = 0;
      let counted = 0;
      // (under the largest demand allowance that stops a decision; the copying places under each)
      for (const which of each ? heldDemands(c, mode).keys() : [0])
        combinedStops(
          c,
          mode,
          (where, problems, clauses) => {
            const { entries, others } = coarseClass(problems);
            assert.deepEqual(others, [], where);
            // (a case's counted entries only where it names them, each read left open at the step it names)
            assert.ok(coarse !== undefined || entries.length === 0, where);
            assert.ok(
              entries.every((open) => open.every((key) => key.endsWith(`|${coarse}`))),
              where,
            );
            counted += entries.length;
            taken += clauses.filter((each) => each === clause).length;
          },
          which,
          demand,
        );
      assert.ok(taken > 0, `${c.name}, ${mode.name}: no stop takes ${clause}`);
      assert.ok(coarse === undefined || counted > 0, `${c.name}, ${mode.name}: none counted`);
    }
});

/**
 * A stop's problems split into the coarse (a) reading's counted class
 * (docs/specifications/type-inference-accepted-record/oracles.md#r4-299) and the others: each counted check's open
 * reads' keys (its record beside it).
 */
function coarseClass(problems: readonly string[]): {
  readonly entries: readonly (readonly string[])[];
  readonly others: readonly string[];
} {
  const entries = problems
    .filter((problem) => problem.startsWith("exception coarse(a) rejection check "))
    .map((problem) => problem.slice(problem.lastIndexOf(" open ") + 6).split(" "));
  const others = problems.filter(
    (problem) => !problem.startsWith("exception coarse(a) rejection "),
  );
  return { entries, others };
}

/**
 * #1604: at a combined stop the finishing read answers no kind that neither a finished contract nor a store gives, and a
 * receiver keeps the structure its key's literal stores give through a copy of an inferred place, so the stop owes the
 * demand-only run's checks, at most one for one in other words with their domain (`combinedMarkProblems`): two places
 * copying each other (the issue's witness 1, whose retained decision admitted a `null` no store gives) and a member
 * below a stopped decision, read through a wrapper of a copied object (witness 2's receiver, by a repeat count). The
 * issue's witness 2 itself keeps the demand-only run's checks; what remains there is the interpolation's operand check
 * on the operation's result, owed beyond the reference's (not this mechanism). Every eighth settled stop under each
 * demand allowance that stops a decision, four modes; the held oracle finds nothing.
 */
test("a combined stop owes the demand-only run's checks through a copied place and a wrapped receiver (#1604)", () => {
  const held = heldFamily(false);
  for (const name of [
    "twoWay-1-arithmetic-plain",
    "wrappers-1-repeat-plain",
    "wrappers-1-laterOperation-plain",
  ]) {
    const c = held.find((each) => each.name === name)!;
    for (const mode of HELD_MODES) {
      const demands = heldDemands(c, mode);
      for (const which of demands.keys()) {
        const { natural, reference, stoppedAt } = combinedAnalyses(
          [{ path: "main.tease", source: c.source }],
          mode,
          demands[which]!,
        );
        combinedStops(
          c,
          mode,
          (where, problems) => {
            assert.deepEqual(problems, [], where);
            const allowance = Number(where.slice(where.lastIndexOf("@") + 1));
            const marks = combinedMarkProblems(reference, natural, stoppedAt(allowance));
            assert.deepEqual(
              name === "wrappers-1-laterOperation-plain"
                ? marks.filter(
                    (mark) => !mark.startsWith('beyond {"kind":"operand","target":"w1.q.f * 2"'),
                  )
                : marks,
              [],
              where,
            );
          },
          which,
        );
      }
    }
  }
});

/**
 * #1604's copy of an inferred place by syntax reads its source's stores below the source's root too, one step down a
 * link (`root.f = {h: 2}` replacing `{g: 1}` in the copied `root`), so a copy's read there keeps the natural analysis's
 * check that `w1.q.f` has `.g`, which the replacement lacks (`widerThan`: no place lets through more, words apart). At
 * every settled stop of the program alone, four modes: the loss shows in a band of stops a sample (`testedStops`) misses,
 * and the whole list takes about 3 s.
 */
test("a copy of an inferred place reads its source's stores below the source's root (#1604)", () => {
  const source = [
    "let root = {f: {g: 1}}",
    "root.f = {h: 2}",
    "let w1 = {q: root, spare: {k: 1}}",
    'say "BEFORE"',
    'repeat w1.q.f.g {say "ok"}',
    'say "AFTER"',
    "exit",
    "",
  ].join("\n");
  const c: HeldCase = {
    name: "wrapper of a place stored below its root",
    source,
    slice: true,
    values: [],
  };
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  for (const mode of HELD_MODES) {
    const natural = mode.run(() => analyseCore(request));
    for (const { allowance } of heldStops(c, mode))
      assert.deepEqual(
        widerThan(
          natural.checks,
          mode.run(() => withTestAllowance(allowance, () => analyseCore(request))),
        ),
        [],
        `${mode.name} @${allowance}`,
      );
  }
});

/**
 * #1604's retained `null` follows the contract at a binding's root only: below it a decision admitting `null` keeps it,
 * since a read there may find no such member (`w1.q = {h: 2}` replaces the object holding `g`), which the conservative
 * null's check stands for. No place lets through more than the natural run at `w1.q.g` (`widerThan`), at the sampled
 * settled stops of the program alone (`testedStops`), four modes. The receiver `w1.q` itself is #1654's (a presence check `main` drops there).
 */
test("a retained member below its root keeps admission's null (#1604)", () => {
  const source = [
    "let root = {g: 1}",
    "let w1 = {q: root, spare: {k: 1}}",
    "w1.q = {h: 2}",
    'say "BEFORE"',
    'repeat w1.q.g {say "ok"}',
    'say "AFTER"',
    "exit",
    "",
  ].join("\n");
  const c: HeldCase = { name: "a member replaced below the root", source, slice: true, values: [] };
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  for (const mode of HELD_MODES) {
    const natural = mode.run(() => analyseCore(request));
    for (const { allowance } of testedStops(heldStops(c, mode)))
      assert.deepEqual(
        widerThan(
          natural.checks,
          mode.run(() => withTestAllowance(allowance, () => analyseCore(request))),
        ).filter((place) => !place.includes('\\"w1.q\\",')),
        [],
        `${mode.name} @${allowance}`,
      );
  }
});

/**
 * #1604's syntax through copies of inferred places answers each key alike whatever order its reads ask it (Codex r1's N1
 * and N2, r3's B4 on #1653): a key a cycle of copies reaches is untold from wherever it is asked (two places copying each
 * other, each wrapped; joined cycles through a projected copy), and a level cut past the copy bound from a deeper caller
 * is kept only where its chain started (a chain of eight copies of a literal, wrapped once). Every binding's own key and
 * its `q`, `f` and `q.f` paths asked in their order and reversed, on fresh walks of the analysis's settled pass, four
 * modes: the same decisions.
 */
test("the stores' syntax through copies answers alike in either order of reads (#1604)", () => {
  const sources = [
    ["let a = {f: 1}", "let b = a", "a = b", "let w = {q: a}", "let v = {q: b}"],
    [
      "let a0 = {f: 1}",
      ...Array.from({ length: 8 }, (_, i) => `let a${i + 1} = a${i}`),
      "let w = {q: a8}",
    ],
    [
      "let a = {f: 1}",
      "let b = {q: a}",
      "let c = b.q",
      "let d = {q: c}",
      "d = b",
      "b = d",
      "a = c",
      "let w = {q: d.q}",
    ],
  ].map((lines) => [...lines, 'say "${w.q.f}"', "exit", ""].join("\n"));
  for (const source of sources)
    for (const mode of HELD_MODES) {
      let captured: Consumers | undefined;
      const check = Consumers.prototype.check;
      Consumers.prototype.check = function (this: Consumers) {
        captured = this;
        return check.call(this);
      };
      try {
        mode.run(() =>
          analyseCore(coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!),
        );
      } finally {
        Consumers.prototype.check = check;
      }
      const pass = captured!.pass;
      const asked = pass.program.places.flatMap((place) =>
        place.kind.kind === "binding" && place.kind.declared === "let"
          ? [[], ["q"], ["f"], ["q", "f"]].map((path) => ({
              root: place.id,
              path: path.map(propertyStep),
            }))
          : [],
      );
      const decisions = (order: typeof asked) => {
        const walk = new Consumers(pass);
        walk.finishing = true;
        walk.settled = true;
        const found = new Map<string, string>();
        for (const { root, path } of order) {
          const decided = walk.cheapDecided(root, path);
          found.set(
            `${root}:${path.join(".")}`,
            JSON.stringify(
              decided === null
                ? null
                : {
                    kinds: decided.kinds,
                    spelling: decided.spelling,
                    decider: decided.decider.site,
                    inherited: decided.inherited,
                  },
            ),
          );
        }
        return [...found].sort(([a], [b]) => a.localeCompare(b));
      };
      assert.deepEqual(
        decisions([...asked].reverse()),
        decisions(asked),
        `${mode.name}: ${source}`,
      );
    }
});

/**
 * the coarse (a) reading's counted class, never a pass. Where a read of the check's reference unit that the
 * demand stop left `unknown` is not answered at its key by the stopped analysis's run of that unit, (a) takes nothing
 * and the check is counted with that read's key:
 * - a member's kind check beside its own selection's element read (the clauses' written set);
 * - an operand's check beside the next operand's read in one operation (`say a and xs.first`, Codex r4's B2, forward
 *   with the sharing under demand 3);
 * - a member's presence check whose own value the finishing walk leaves to the member's contract, its quiet path
 *   skipping the receiver (`writtenObjectBelow-1-say-plain`, forward without the sharing under demand 32);
 * - a `get`'s receiver check beside its default's read of the receiver's element, with the literal index's checks of
 *   that unit (a written union's list, forward with the sharing under demand 3).
 * The finer reading, by the consumer invocation that emitted the check, has no entry to hook: the consumers are module
 * functions no test can replace, and a call stack names no call. Every settled stop of each.
 */
test("a combined stop counts the coarse (a) reading's rejections with the read each leaves open (TABLE r4.299)", () => {
  const below = heldFamily(false).find((c) => c.name === "writtenObjectBelow-1-say-plain")!;
  const members = [
    {
      source:
        "let a: boolean = hostValue\nlet xs: list = [hostOther, 4]\nsay a and xs.first\nexit\n",
      demand: 3,
      mode: HELD_MODES[0]!,
      target: "a",
      open: "xs.first",
    },
    { source: below.source, demand: 32, mode: HELD_MODES[2]!, target: "root", open: "root.f0" },
    // (a `get`'s receiver beside its default's read of the receiver's element)
    {
      source: storedGet("written union", ["let xs: (integer|string)[] = [4]"], "xs", []).source,
      demand: 3,
      mode: HELD_MODES[0]!,
      target: "xs",
      open: "xs",
      where: "xs.get",
      steps: "element",
    },
  ];
  for (const { source, demand, mode, target, open, where = open, steps = "" } of members) {
    const at = source.indexOf(where);
    assert.ok(
      controlStops(
        mainFile(source),
        (rule) =>
          [...rule.coarse.checks.keys()].find((check) => JSON.parse(check).target === target),
        (reference, natural, stopped, check) => {
          const rule = combinedStop(reference, natural, stopped);
          assert.equal(rule.checks.get(check), undefined, open);
          assert.deepEqual(
            rule.coarse.checks.get(check),
            [`0:${at}:${at + open.length}|${steps}`],
            open,
          );
        },
        [demand],
        mode,
        1,
      ) > 0,
      open,
    );
  }
});

/** `answers` with `fields` in place of its own, its questions its own (a stopped analysis changed for an oracle's control). */
function shadowed(answers: Answers, fields: Partial<Answers>): Answers {
  return Object.assign(
    Object.create(answers),
    {
      graph: answers.graph,
      at: answers.at.bind(answers),
      place: answers.place.bind(answers),
      project: answers.project.bind(answers),
    },
    fields,
  );
}

/** A mark of `answers` changed by `by` (or left out), its published obligation with it, its diagnostic too. */
function withMark(
  answers: Answers,
  obligation: string,
  by:
    | ((mark: (typeof answers.budget.deferred)[number]) => (typeof answers.budget.deferred)[number])
    | null,
): Answers {
  const is = (check: Answers["checks"][number]): boolean => JSON.stringify(check) === obligation;
  const mark = answers.budget.deferred.find((each) => is(each.obligation));
  assert.ok(mark !== undefined, obligation);
  const changed = by === null ? null : by(mark);
  return shadowed(answers, {
    checks: answers.checks.flatMap((check) =>
      !is(check) ? [check] : changed === null ? [] : [changed.obligation],
    ),
    budget: {
      ...answers.budget,
      deferred: answers.budget.deferred.flatMap((each) =>
        each !== mark ? [each] : changed === null ? [] : [changed],
      ),
    },
  });
}

/**
 * Each settled stop of a program's files under each demand allowance that stops a decision of its main file (or under
 * `demands`), in `mode` (forward with the sharing), at every `step`th (eighth) allowance of each settled phase: where `select` names a reference
 * check there, `each` judges it. The number of stops judged.
 */
function controlStops(
  files: readonly SourceFile[],
  select: (rule: CombinedStop, reference: Answers, stopped: Answers) => string | undefined,
  each: (reference: Answers, natural: Answers, stopped: Answers, check: string) => void,
  demands?: readonly number[],
  mode = HELD_MODES[0]!,
  step = 8,
): number {
  let count = 0;
  for (const demand of demands ?? heldDemands({ source: files[0]!.source }, mode)) {
    const { natural, reference, stoppedAt } = combinedAnalyses(files, mode, demand);
    for (const [phase, [low, high]] of phaseEnds(reference.budget.total, (allowance) => {
      const { settled, stoppedIn } = stoppedAt(allowance).budget;
      return settled ? stoppedIn : null;
    }))
      for (const allowance of testedAllowances(phase, low, high, step)) {
        const stopped = stoppedAt(allowance);
        const check = select(combinedStop(reference, natural, stopped), reference, stopped);
        if (check === undefined) continue;
        count += 1;
        each(reference, natural, stopped, check);
      }
  }
  return count;
}

/** The reference check the rule takes by `clause` that `pick` names, or none. */
const takes =
  (clause: "a" | "w" | "z", pick: (check: Answers["checks"][number]) => boolean) =>
  (rule: CombinedStop): string | undefined =>
    [...rule.checks].find(([check, found]) => found === clause && pick(JSON.parse(check)))?.[0];

/** A program of one file. */
const mainFile = (source: string): SourceFile[] => [{ path: "main.tease", source }];

/**
 * The inventory at a combined stop: each predicate's controls on real stops, changed (Codex r1's and r2's on
 * #1597), each dimension with what it must reject and what it must accept.
 * - (a)'s reference read: a recovered contract tagged `budget` (`list|null`, never `unknown`) is no read the demand stop
 *   left `unknown`, so the receiver's mark left out is rejected; the issues' witnesses (the first test) are accepted.
 * - (a)'s finishing read: the receiver's mark left out with its read answered `STOPPED` is rejected.
 * - (a)'s reads, its unit's: an element selection's empty check and an index's integer check, their marks left out
 *   where only the receiver is answered, are rejected (Codex r3's B1).
 * - (w)'s domain: the null check against `integer` replaced by a copy check against `unknown` is rejected, and so is
 *   #1580's comparison form's boolean check with every obligation at its place removed; a redundant mark against
 *   `unknown` beside the restrictive one is accepted, the intersection unchanged.
 * - Site identity: the same mark moved to another file at the same offsets is rejected; in its own file it is taken.
 * - (z)'s holding store: the store mark moved to the whole source is rejected, and so are the holding store's obligation
 *   settled against a type and the copies' boundary with plan content left out; a parenthesized value and a
 *   parenthesized literal (the third test) are accepted.
 * And the runtime predicate: a written list's default obligation deliberately omitted from a real stopped compile lets
 * `bad` through, which it reports (forward with the sharing).
 */
test("a combined stop's rule takes nothing the natural analysis owes, nothing wider, and no boundary with plan content", () => {
  const mode = HELD_MODES[0]!;
  // (#1580's comparison form under each demand allowance that stops a decision: whatever the stopped analysis owes at the
  // comparison's place left out, its boolean check is no clause's)
  const elements = storedGet("compared element", [], "[hostValue == 2]", [
    [true, true],
    ["bad", false],
  ]);
  const samePlace = (x: Answers["checks"][number], u: Answers["checks"][number]): boolean =>
    isDeepStrictEqual(x.site, u.site) && x.target === u.target && x.boundary === u.boundary;
  assert.ok(
    controlStops(
      mainFile(elements.source),
      (_, reference, stopped) => {
        const owed = [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)];
        const check = reference.checks.find(
          (u) => isDeepStrictEqual(u.against, ["boolean"]) && owed.some((x) => samePlace(x, u)),
        );
        return check === undefined ? undefined : JSON.stringify(check);
      },
      (reference, natural, stopped, check) => {
        const u: Answers["checks"][number] = JSON.parse(check);
        const left = shadowed(stopped, {
          checks: stopped.checks.filter((x) => !samePlace(x, u)),
          budget: {
            ...stopped.budget,
            deferred: stopped.budget.deferred.filter((mark) => !samePlace(mark.obligation, u)),
          },
        });
        assert.equal(combinedStop(reference, natural, left).checks.get(check), undefined);
      },
      heldDemands(elements, mode),
    ) > 0,
  );
  const nullable =
    'let xs: list? = [hostValue, 4]\nsay "BEFORE"\nrepeat xs[0] {say "ok"}\nsay "AFTER"\nexit\n';
  const receiver = nullable.indexOf("xs[0]");
  const nullCheck = (check: Answers["checks"][number]): boolean =>
    check.kind === "null-check" && check.target === "xs";
  // (a)'s finishing read: the receiver's mark left out, its finishing read answered `STOPPED` (`unknown`, `budget`)
  assert.ok(
    controlStops(
      mainFile(nullable),
      takes("w", nullCheck),
      (reference, natural, stopped, check) => {
        const mark = stopped.budget.deferred.find((each) => nullCheck(each.obligation))!;
        const left = withMark(stopped, JSON.stringify(mark.obligation), null);
        const unanswered = withReadsChanged(
          stopped,
          left,
          { file: 0, start: receiver, end: receiver + 2 },
          [],
          (reads) => reads.map((read) => (read.finishing ? { ...read, items: STOPPED } : read)),
        );
        assert.equal(combinedStop(reference, natural, unanswered).checks.get(check), undefined);
      },
    ) > 0,
  );
  // (a)'s reference read: a recovered contract tagged `budget`, the receiver's mark left out (Codex r2's B1, at demand 5,
  // where the reference warns of the receiver's `null` alone)
  const known =
    'let pad = {q: {q: {q: {q: hostOther}}}}\nlet xs: list? = [hostValue, 4]\nrepeat xs[0] {say "ok"}\nsay pad.q.q.q.q\nexit\n';
  const knownAt = known.indexOf("xs[0]");
  assert.ok(
    controlStops(
      mainFile(known),
      (_, reference, stopped) => {
        const owner = reference.diagnostics.find(
          (d) =>
            "obligation" in d &&
            nullCheck(d.obligation) &&
            d.site.start === knownAt &&
            isDeepStrictEqual(d.kinds, ["null"]),
        );
        const text =
          owner !== undefined && "obligation" in owner ? JSON.stringify(owner.obligation) : "";
        return stopped.budget.deferred.some((mark) => JSON.stringify(mark.obligation) === text)
          ? text
          : undefined;
      },
      (reference, natural, stopped, check) =>
        assert.equal(
          combinedStop(reference, natural, withMark(stopped, check, null)).checks.get(check),
          undefined,
        ),
      // (where the receiver's read recovers its contract, `list|null` tagged `budget`: Codex r2's witness)
      [5],
    ) > 0,
  );
  // (w)'s domain: the null check against `integer` replaced by a copy check against `unknown` (Codex r1's B2); a
  // redundant mark against `unknown` beside it, the intersection unchanged
  const elementsOf =
    'let xs: integer?[] = [hostValue, 4]\nsay "BEFORE"\nrepeat xs[0] {say "ok"}\nsay "AFTER"\nexit\n';
  const count = (check: Answers["checks"][number]): boolean =>
    check.target === "xs.element" && check.kind === "integer-check";
  const elementMark = (stopped: Answers) =>
    stopped.budget.deferred.find(
      (each) => each.obligation.target === "xs.element" && each.obligation.kind === "null-check",
    )!;
  const unknownCopy = (mark: typeof elementMark extends (a: Answers) => infer M ? M : never) => ({
    ...mark,
    obligation: {
      ...mark.obligation,
      kind: "copy-type" as const,
      against: ["unknown" as const],
      on: "validate the stored value of xs.element against unknown",
    },
  });
  assert.ok(
    controlStops(mainFile(elementsOf), takes("w", count), (reference, natural, stopped, check) => {
      const mark = elementMark(stopped);
      const wider = withMark(stopped, JSON.stringify(mark.obligation), unknownCopy);
      assert.notEqual(combinedStop(reference, natural, wider).checks.get(check), "w");
      const beside = shadowed(stopped, {
        checks: [...stopped.checks, unknownCopy(mark).obligation],
        budget: { ...stopped.budget, deferred: [...stopped.budget.deferred, unknownCopy(mark)] },
      });
      assert.equal(combinedStop(reference, natural, beside).checks.get(check), "w");
    }) > 0,
  );
  // (a)'s reads, its unit's: an element selection's empty check and an index's integer check, each mark left out where
  // the receiver is answered but the read that decides the check, the element or the index, is still `unknown` in the
  // finishing walk (Codex r3's B1, at demands 3 and 2)
  for (const [source, demand, kind, target] of [
    ['let xs: list = [hostValue, 4]\nrepeat xs.first {say "ok"}\nexit\n', 3, "empty-check", "xs"],
    ["let xs: list = [hostValue, 4]\nlet i = 0\nsay xs[i]\nexit\n", 2, "integer-check", "i"],
  ] as const)
    assert.ok(
      controlStops(
        mainFile(source),
        (_, reference, stopped) => {
          const owed = reference.checks.find(
            (check) => check.kind === kind && check.target === target,
          );
          const text = owed === undefined ? "" : JSON.stringify(owed);
          return stopped.budget.deferred.some((mark) => JSON.stringify(mark.obligation) === text)
            ? text
            : undefined;
        },
        (reference, natural, stopped, check) =>
          assert.equal(
            combinedStop(reference, natural, withMark(stopped, check, null)).checks.get(check),
            undefined,
            source,
          ),
        [demand],
      ) > 0,
      source,
    );
  // site identity: the mark moved to another file at the same offsets (Codex r2's B2); taken in its own file
  const twoFiles = [
    ...mainFile(elementsOf),
    { path: "other.tease", source: elementsOf.replaceAll("xs", "ys") },
  ];
  const inMain = (check: Answers["checks"][number]): boolean =>
    count(check) && check.site.file === 0;
  assert.ok(
    controlStops(twoFiles, takes("w", inMain), (reference, natural, stopped, check) => {
      const mark = elementMark(stopped);
      const moved = withMark(stopped, JSON.stringify(mark.obligation), (each) => ({
        ...each,
        site: { ...each.site, file: 1 },
        obligation: { ...each.obligation, site: { ...each.obligation.site, file: 1 } },
      }));
      assert.equal(combinedStop(reference, natural, moved).checks.get(check), undefined);
    }) > 0,
  );
  // (z)'s holding store: the store mark moved from the holding store's site to the whole source (Codex r1's B3)
  const values =
    'function build {return dict {a: hostValue, b: 4}}\nsay "BEFORE"\nrepeat build().values[0] {say "ok"}\nsay "AFTER"\nexit\n';
  const holding = values.indexOf("dict {");
  assert.ok(
    controlStops(
      mainFile(values),
      takes("z", (check) => check.boundary),
      (reference, natural, stopped, check) => {
        const owns = (d: Answers["diagnostics"][number]): boolean =>
          "rule" in d && d.rule.rule === "store" && d.site.start === holding;
        assert.ok(stopped.diagnostics.some(owns) || stopped.budget.deferred.some(owns));
        const whole = { file: 0, start: 0, end: values.length };
        const move = <D extends Answers["diagnostics"][number]>(d: D): D =>
          !owns(d) || !("obligation" in d)
            ? d
            : { ...d, site: whole, obligation: { ...d.obligation, site: whole } };
        const moved = shadowed(stopped, {
          diagnostics: stopped.diagnostics.map(move),
          budget: { ...stopped.budget, deferred: stopped.budget.deferred.map(move) },
        });
        assert.notEqual(combinedStop(reference, natural, moved).checks.get(check), "z");
        // ((z)'s owner state: the holding store's obligation settled, against a type in place of `unknown`)
        const settle = <D extends Answers["diagnostics"][number]>(d: D): D =>
          !owns(d) || !("obligation" in d)
            ? d
            : { ...d, obligation: { ...d.obligation, against: ["integer" as const] } };
        const settled = shadowed(stopped, {
          diagnostics: stopped.diagnostics.map(settle),
          budget: { ...stopped.budget, deferred: stopped.budget.deferred.map(settle) },
        });
        assert.notEqual(combinedStop(reference, natural, settled).checks.get(check), "z");
      },
    ) > 0,
  );
  // (the runtime predicate on a real stopped plan: a written list's `get` default, its check's mark left out of the
  // compile, lets `bad` through to `AFTER`, which the predicate reports; with its check the plan rejects it; the check a
  // receiving completion gives the stopped store, #1526 phase C step 5, is left out too: it rejects `bad` as well. The
  // default is said, not stored: a store into an inferred place is left undecided before admission settled, where the
  // plain gate declines, #2080 part 2)
  const written: HeldCase = {
    name: "written list",
    source:
      'let xs: integer[] = [4]\nsay "BEFORE"\nsay xs.get(4, default: hostOther)\nsay "AFTER"\nexit\n',
    slice: true,
    values: [
      { globals: { hostValue: 2, hostOther: 2 }, says: ["BEFORE", "2", "AFTER"] },
      { globals: { hostValue: 2, hostOther: "bad" }, says: null },
    ],
  };
  const writtenDemand = heldDemands(written, mode)[0]!;
  const bad = 'forbidden {"hostValue":2,"hostOther":"bad"} said ["BEFORE","bad","AFTER"]';
  const defaultAt = written.source.indexOf("hostOther");
  let removed = 0;
  // (#2080 part 1: at its held stops, after admission settled, the completion is capped and keeps no result, and the
  // stopped marks decline; before the first, the analysis stops unsettled, where nothing is left undecided and the
  // stopped plan publishes)
  const first = heldStops(written, mode, 8, writtenDemand)[0]!.allowance;
  for (let allowance = 1; allowance < first; allowance += 104) {
    const stopped = heldRun(written, mode, allowance, writtenDemand);
    if (stopped.result.plan === null || runProblems(written, stopped).length > 0) continue;
    const owner = [...stopped.answers.diagnostics, ...stopped.answers.budget.deferred].find(
      (d) => "obligation" in d && !d.obligation.boundary && d.site.start === defaultAt,
    );
    if (owner === undefined) continue;
    const omitted = stopped.without(
      {
        diagnostic: (d) =>
          d.code === owner.code &&
          d.site.start === owner.site.start &&
          d.site.end === owner.site.end,
        check: () => false,
        completion: true,
      },
      `default ${owner.code}`,
    );
    assert.ok(runProblems(written, omitted).includes(bad), `@${allowance}`);
    removed += 1;
  }
  assert.ok(removed > 0);
  // (the copies' boundary left out of a stopped analysis that owes it: no clause takes it)
  const copies = heldFamily(false).find((c) => c.name === "copies-2-interpolation-plain")!;
  const boundary = (check: Answers["checks"][number]): boolean =>
    check.boundary && check.target === "root" && isDeepStrictEqual(check.against, ["object"]);
  let tried = 0;
  for (const copiesDemand of heldDemands(copies, mode)) {
    const { natural, reference, stoppedAt } = combinedAnalyses(
      mainFile(copies.source),
      mode,
      copiesDemand,
    );
    if (!reference.checks.some(boundary)) continue;
    for (const { allowance } of heldStops(copies, mode, 8, copiesDemand)) {
      const stopped = stoppedAt(allowance);
      const owed = stopped.checks.find(boundary);
      if (owed === undefined || !stopped.budget.decisions.some((d) => d.stopped)) continue;
      tried += 1;
      const without = shadowed(stopped, {
        checks: stopped.checks.filter((check) => !boundary(check)),
      });
      assert.equal(
        combinedStop(reference, natural, without).checks.has(JSON.stringify(owed)),
        false,
        `demand ${copiesDemand} @${allowance}`,
      );
    }
  }
  assert.ok(tried > 0);
});

/**
 * #1448 (S8's mark-ownership rule): after a settled walk stop, the boundaries a domain read
 * brings for its key's stores are the content of the warning that owns that read there: leaving its owner out
 * (`withoutRecords`) removes them, an unrelated mark does not, a second owner keeps them, an operation a later statement
 * reads, a method call's receiver, a `get`'s default and the soft owner of an unknown receiver's `get` key are owners too,
 * and a read's own host ingress keeps its boundary without any mark. At the first settled walk stop, forward with the sharing and reversed without it.
 */
test("a domain read's store boundaries are its owning mark's content (#1448)", () => {
  const record = (d: { code: string; site: { start: number; end: number } }): string =>
    `${d.code} ${d.site.start}:${d.site.end}`;
  const boundaries = (
    source: string,
    mode: (typeof HELD_MODES)[number],
    left: string[] | "all",
    allowance?: number,
  ) => {
    const c = { name: "owned", source, slice: false, values: [] };
    const stop =
      allowance ?? heldStops(c, mode, 1).find((each) => each.phase === "walk")?.allowance;
    assert.ok(stop !== undefined, source);
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
    const run = (omit: ((code: string) => boolean) | null): Answers =>
      mode.run(() =>
        withTestAllowance(stop, () =>
          omit === null
            ? analyseCore(request)
            : withoutRecords({ diagnostic: (d) => omit(record(d)), check: () => false }, () =>
                analyseCore(request),
              ),
        ),
      );
    const marks = run(null).budget.deferred.map(record);
    const answers = run(
      left === "all" ? (each) => marks.includes(each) : (each) => left.includes(each),
    );
    return answers.checks
      .filter((check) => check.boundary)
      .map((check) => `${check.target}@${check.site.start}`);
  };
  const replaced =
    'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\nrepeat root.f0 {say "ok"}\n';
  for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!]) {
    const where = mode.name;
    // the count's mark owns both stores' boundaries its domain read brings; the receiver's mark is unrelated
    const witness = `${replaced}say "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(witness, mode, []), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(witness, mode, ["TSV043 70:77"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(witness, mode, ["TSV011 70:77"]), [], where);
    // two consumers read the domain, each its own owner
    const two = `${replaced}say "\${root.f0}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(two, mode, ["TSV011 70:77"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(two, mode, ["TSV042 96:103"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(two, mode, ["TSV011 70:77", "TSV042 96:103"]), [], where);
    // an operation a later statement reads: its operand's mark owns them, the interpolation's is unrelated
    const later =
      'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\nrepeat 2 {say "x"}\nsay "${root.f0 * 2}"\nsay "AFTER"\nexit\n';
    assert.deepEqual(boundaries(later, mode, []), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(later, mode, ["TSV042 89:100"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(later, mode, ["TSV043 89:96"]), [], where);
    // a method call's receiver and a `get`'s default: the member check's mark and the default's own warning own them
    const head = 'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\n';
    const method = `${head}say "\${root.f0.first()}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(method, mode, ["TSV042 70:85"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(method, mode, ["TSV043 70:85"]), [], where);
    // (the interpolation shows the `get`'s result, which holds its default's host data as unstopped: an owner too, #1491)
    const fallback = `${head}say "\${[1].get(4, default: root.f0)}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(fallback, mode, ["TSV042 70:98"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(fallback, mode, ["TSV041 90:97"]), ["root@16", "root@39"], where);
    assert.deepEqual(boundaries(fallback, mode, ["TSV041 90:97", "TSV042 70:98"]), [], where);
    // a soft owner, a `get` on an unknown receiver (its key's one warning); and beside a count, two owners (Codex r1's B1)
    const get =
      "let root = {f0: hostValue}\nroot = {f0: hostOther}\nhostValue.get(root.f0, default: 0)\nexit\n";
    assert.deepEqual(boundaries(get, mode, []), ["root@16", "root@39", "hostValue@50"], where);
    assert.deepEqual(
      boundaries(get, mode, ["TSV043 50:84"]),
      ["root@16", "root@39", "hostValue@50"],
      where,
    );
    assert.deepEqual(boundaries(get, mode, ["TSV043 64:71"]), ["hostValue@50"], where);
    const counted = `${head}repeat root.f0 {say "ok"}\nhostValue.get(root.f0, default: 0)\nsay "AFTER"\nexit\n`;
    const both = ["root@16", "root@39", "hostValue@89"];
    assert.deepEqual(boundaries(counted, mode, ["TSV043 103:110"]), both, where);
    assert.deepEqual(boundaries(counted, mode, ["TSV011 70:77"]), both, where);
    assert.deepEqual(
      boundaries(counted, mode, ["TSV011 70:77", "TSV043 103:110"]),
      ["hostValue@89"],
      where,
    );
    // a member read whose receiver's object lacks the property: its `extra` warning owns the receiver's domain items, and
    // the property's presence, read from every source, asks that store's boundary itself
    const extra = `let root = {f0: hostValue}\nroot = {f0: {h: 1}}\nsay "BEFORE"\nsay "\${root.f0.g}"\nsay "AFTER"\nexit\n`;
    assert.deepEqual(boundaries(extra, mode, "all"), ["root@16"], where);
    // on an unrestricted written object nothing else asks it: at each settled stop the receiver's unknown warning or the
    // `extra` one owns it, and every mark left out leaves no boundary (Codex r2's witness on #1511)
    const written =
      'let root: object = {f0: hostValue}\nroot = {f0: {h: 1}}\nsay "${root.f0.g}"\nexit\n';
    const c = { name: "written", source: written, slice: false, values: [] };
    for (const { allowance } of testedStops(heldStops(c, mode, 1)))
      assert.deepEqual(boundaries(written, mode, "all", allowance), [], `${where} ${allowance}`);
    // a host read's own ingress beside its stores'
    const host =
      'hostValue.f0 = 2\nsay "BEFORE"\nrepeat hostValue.f0 {say "ok"}\nsay "AFTER"\nexit\n';
    assert.deepEqual(
      boundaries(host, mode, "all"),
      ["hostValue@0", "hostValue@37", "hostValue.f0@37"],
      where,
    );
  }
});

/** An analysis and its reads' walks (`withFrontierBound`). */
type Walked = { readonly result: Answers; readonly reads: ReadonlyMap<string, FrontierRead> };

/**
 * A bounded frontier's analysis against the exact walk's at one stop
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-208), whole, and whether a read's walk
 * was cut (`withFrontierBound` keeps a cut when the read is made again, #1509): where none was, the same reads, checks,
 * diagnostics and marks; where one was, every exact check's obligation (its kind, target, requirement, site and
 * boundary flag) kept or owned by a mark. A cut read answers its place's component's host data, a superset of what its
 * walk names, so its consumers may owe checks the exact walk does not, never fewer: those may read more, and one worded
 * for external data needs no read of its receiver (#1449's wording difference at a stop).
 */
function boundedKeepsExact(bounded: Walked, exact: Walked, where: string): boolean {
  const cut = [...bounded.reads.values()].some((read) => read.cut);
  if (!cut) {
    const whole = ({ result, reads }: Walked) => ({
      reads: [...reads.keys()].sort(),
      checks: result.checks,
      diagnostics: result.diagnostics.map(stopIdentity),
      deferred: result.budget.deferred.map(stopIdentity),
    });
    assert.deepEqual(whole(bounded), whole(exact), where);
    return cut;
  }
  const obligation = (check: Answers["checks"][number]) =>
    JSON.stringify({ ...check, on: undefined });
  const kept = new Set(
    [
      ...bounded.result.checks,
      ...bounded.result.budget.deferred.map((mark) => mark.obligation),
    ].map(obligation),
  );
  for (const check of exact.result.checks)
    assert.ok(kept.has(obligation(check)), `${where}: ${JSON.stringify(check)}`);
  return cut;
}

/**
 * #1445 (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-208): after a settled stop, a
 * domain read's host data is followed at most two copies deep and over at most eight copies met (`FRONTIER_DEPTH`,
 * `FRONTIER_COPIES`); past them the read answers its place's component's. Against the exact walk (`withFrontierBound`,
 * unbounded), read by read: the same stop guard, the same writers where a read's walk is not cut and a superset where
 * it is; whole, `boundedKeepsExact`. The topologies at k = 4 (rings and chains of own stores are cut there), two reads
 * no place holds whose links count as copies (#1559), and six random copy graphs (two with readers of two places),
 * forward with sharing and reversed without, near the first settled stop and at the last, without a demand cap and
 * under the largest that stops a decision. The same check runs at scale, in all four modes, on the workers.
 */
test("after a settled stop a read's bounded host frontier names its exact writers, or more where it is cut (#1445)", () => {
  const sources = [
    ...topologySources(4),
    // (reads no place holds, their links counted as copies: a `get`'s default 4 deep, each holding the next in a literal's
    // cell, and a literal below two copies at its root, Astra r1's B1 and B2 on #1559)
    {
      name: "nested-get-cells",
      source: `repeat ${"[1].get(5, default: [".repeat(4)}hostValue${"][0])".repeat(4)} {}\nexit\n`,
    },
    {
      name: "double-copied-literal",
      source: "repeat [[[[[[hostValue]]]]].toList()].toList()[0][0][0][0][0][0] {}\nexit\n",
    },
    ...[1, 2, 3, 4, 5, 6].map((seed) => ({
      name: `random ${seed}`,
      // (seeds 5 and 6 with four readers of two places each, Codex r5's B1)
      source: randomCopyGraph(seed, 6, 4, 18, seed > 4 ? 4 : 0),
    })),
  ];
  const bound = { depth: FRONTIER_DEPTH, copies: FRONTIER_COPIES };
  const exactly = { depth: Infinity, copies: Infinity };
  const seen = { cut: 0, whole: 0, guarded: 0, decisionStops: 0 };
  for (const { name, source } of sources) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null, name);
    for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!]) {
      // (the largest demand allowance under which a decision stops)
      for (const demand of [undefined, ...heldDemands({ source }, mode).slice(0, 1)]) {
        const analyse = (allowance?: number): Answers =>
          mode.run(() => {
            const capped = () =>
              demand === undefined
                ? analyseCore(request)
                : withTestDemandAllowance(demand, () => analyseCore(request));
            return allowance === undefined ? capped() : withTestAllowance(allowance, capped);
          });
        const total = analyse().budget.total;
        // (a settled stop within a 64th of the first: the settled phases, the walk and the publication, are the last)
        let [first, top] = [1, total - 1];
        while (top - first > total >> 6) {
          const middle = (first + top) >> 1;
          if (analyse(middle).budget.settled) top = middle;
          else first = middle + 1;
        }
        for (const allowance of new Set([top, total - 1])) {
          const where = `${name}, ${mode.name}, demand ${demand} @${allowance}`;
          const bounded = withFrontierBound(bound, () => analyse(allowance));
          const exact = withFrontierBound(exactly, () => analyse(allowance));
          assert.ok(bounded.result.budget.settled, where);
          for (const [read, mine] of bounded.reads) {
            const theirs = exact.reads.get(read);
            if (theirs === undefined) continue;
            assert.equal(mine.guarded, theirs.guarded, `${where} ${read}`);
            const missing = [...theirs.writers].filter((writer) => !mine.writers.has(writer));
            assert.equal(missing.length, 0, `${where} ${read}: a writer the exact walk names`);
            if (!mine.cut) assert.equal(mine.writers.size, theirs.writers.size, `${where} ${read}`);
            if (mine.guarded) seen.guarded += 1;
            else if (mine.cut) seen.cut += 1;
            else seen.whole += 1;
          }
          if (bounded.result.budget.decisions.some((d) => d.stopped)) seen.decisionStops += 1;
          boundedKeepsExact(bounded, exact, where);
        }
      }
    }
  }
  assert.ok(
    Object.values(seen).every((count) => count > 0),
    JSON.stringify(seen),
  );
});

/**
 * #1509: a read made again keeps its earlier cut in `withFrontierBound`'s record. Ten copies of a list holding host data,
 * read after a settled stop under a demand allowance that stops a decision: the first read of `c9` is cut past eight
 * copies and answers its place's component's host data, which owes the element's boundary and a null check the exact
 * walk does not; `c9` is read again through the chain the cut compressed (`sameOf`), two copies, uncut. In each mode, at
 * the first settled stop under the largest such allowance, the record says a read was cut, so `boundedKeepsExact`
 * demands the exact checks' obligations, not equality.
 */
test("a read made again keeps its earlier cut in the bounded frontier's record (#1509)", () => {
  const source = [
    "let c0: list = [hostValue, 4]",
    ...Array.from({ length: 9 }, (_, i) => `let c${i + 1} = c${i}`),
    'say "BEFORE"',
    'repeat c9[0] {say "ok"}',
    'say "AFTER"',
    "exit\n",
  ].join("\n");
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  for (const mode of HELD_MODES) {
    const demand = heldDemands({ source }, mode)[0];
    assert.ok(demand !== undefined, mode.name);
    const capped = () => withTestDemandAllowance(demand, () => analyseCore(request));
    const analyse = (allowance: number): Answers =>
      mode.run(() => withTestAllowance(allowance, capped));
    let first = 1;
    for (let top = mode.run(capped).budget.total - 1; first < top;) {
      const middle = (first + top) >> 1;
      if (analyse(middle).budget.settled) top = middle;
      else first = middle + 1;
    }
    const where = `${mode.name}, demand ${demand} @${first}`;
    const bounded = withFrontierBound({ depth: FRONTIER_DEPTH, copies: FRONTIER_COPIES }, () =>
      analyse(first),
    );
    const exact = withFrontierBound({ depth: Infinity, copies: Infinity }, () => analyse(first));
    assert.ok(bounded.result.budget.settled, where);
    assert.ok(boundedKeepsExact(bounded, exact, where), `${where}: no read's walk is cut`);
  }
});

/**
 * #1453: after a settled stop, a read whose walk is cut answers its place's component's host data, so it
 * keeps every check: through 257 copies of a host object (the store's record-level boundary, `copy-type root against
 * object`, which #1453 lost at 256), through 33 copies each storing its own property, and in a ring of 64 copies. In
 * each, at its first settled stop, its last and halfway between, in both orders, every check of the unstopped compile is
 * kept or owned by a mark, and some read's walk is cut.
 */
test("a read past the bounded walk keeps every check: #1453's 257 copies, copies each storing, and a ring", () => {
  const chain = (length: number, store: boolean) =>
    [
      "let root = {f: hostValue, g: 1}",
      ...Array.from(
        { length },
        (_, i) => `let c${i} = ${i ? `c${i - 1}` : "root"}${store ? `\nc${i}.g = ${i}` : ""}`,
      ),
      'say "BEFORE"',
      `repeat c${length - 1}.f {say "ok"}`,
      'say "AFTER"',
    ].join("\n");
  const ring = [
    ...Array.from({ length: 64 }, (_, i) => `let c${i} = {f: hostValue}`),
    ...Array.from({ length: 64 }, (_, i) => `c${i} = c${(i + 1) % 64}`),
    ...Array.from({ length: 64 }, (_, i) => `repeat c${i}.f {}`),
  ].join("\n");
  const bound = { depth: FRONTIER_DEPTH, copies: FRONTIER_COPIES };
  for (const [name, text] of [
    ["257 copies", chain(257, false)],
    ["33 copies, each storing", chain(33, true)],
    ["a ring of 64", ring],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source: `${text}\nexit\n` }], ["hostValue"]);
    assert.ok(request !== null, name);
    for (const mode of [HELD_MODES[0]!, HELD_MODES[3]!]) {
      const analyse = (allowance?: number): Answers =>
        mode.run(() =>
          allowance === undefined
            ? analyseCore(request)
            : withTestAllowance(allowance, () => analyseCore(request)),
        );
      const unstopped = analyse();
      if (name !== "a ring of 64")
        assert.ok(
          unstopped.checks.some((check) =>
            JSON.stringify(check).includes('"kind":"copy-type","target":"root"'),
          ),
          name,
        );
      const total = unstopped.budget.total;
      // (the first settled stop, where the most reads are left to the finishing walk)
      let first = 1;
      for (let top = total - 1; first < top;) {
        const middle = (first + top) >> 1;
        if (analyse(middle).budget.settled) top = middle;
        else first = middle + 1;
      }
      let cut = false;
      for (const allowance of new Set(
        [0, 1, 2].map((i) => first + (((total - 1 - first) * i) >> 1)),
      )) {
        const where = `${name}, ${mode.name} @${allowance}`;
        const { result, reads } = withFrontierBound(bound, () => analyse(allowance));
        assert.ok(result.budget.settled, where);
        cut ||= [...reads.values()].some((read) => read.cut);
        const kept = new Set(result.checks.map((check) => JSON.stringify(check)));
        const owned = new Set(
          result.budget.deferred.map((mark) => JSON.stringify(mark.obligation)),
        );
        for (const check of unstopped.checks.map((each) => JSON.stringify(each)))
          assert.ok(kept.has(check) || owned.has(check), `${where}: ${check}`);
      }
      assert.ok(cut, `${name}, ${mode.name}: no read's walk is cut`);
    }
  }
});

/**
 * The per-demand fallback (S3 §5, ADR 0021 rule 1.10): `y` copies a number through a chain of copies, so its
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
 * S3 revision 21: a settled walk stop leaves a typed parse's nested paths undecided (admission decides
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
    for (const allowance of [low, Math.floor((low + high) / 2)]) {
      // (or declined: the parse's store has no result at a program stop, and only a complete store check keeps it,
      // #1526 decision 2, an accepted over-decline, #1832)
      let stopped: StopRun;
      try {
        stopped = stopRun(source, allowance);
      } catch (error) {
        assert.ok(
          error instanceof CandidateOutsideSlice && error.what === LOST_CHECK,
          `@${allowance}`,
        );
        continue;
      }
      assert.deepEqual(
        stopProblems({ unstopped, stopped, fitting: [], violating: [] }),
        [],
        `@${allowance}`,
      );
    }
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
      const allowance = Math.floor(0.5 * decisionOf(decisions, { place: b, path: [] }).units);
      const where = `reversed: ${reversed}, count: ${count}`;
      const answers: Answers = withTestDemandAllowance(allowance, () =>
        inOrder(() => completedCore(request)),
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
      // stopped, so `n`'s check, which reads `b` before `b` is decided in the reversed order, reads it stopped)
      assert.deepEqual(at(read), ["warning-runtime-check budget"], where);
      if (count) assert.deepEqual(at(text.indexOf("count {}")), ["compile-error -"], where);
      else {
        // the read's moved check stops a fraction before the next effect; where the receiving completion completed `b`'s
        // contract (#1526 phase C step 5), the store of host data checks it first, as unstopped
        const plan = withTestDemandAllowance(allowance, () =>
          inOrder(() => compileSourceWithBackend(text, OPTIONS, CORE_BACKEND).plan),
        );
        assert.ok(plan !== null, where);
        assert.deepEqual(ran(plan, 5), { said: ["AFTER"], failure: null }, where);
        const checked = answers.budget.closure === null ? read : text.indexOf("hostValue\nlet n");
        assert.match(ran(plan, 1.5).failure ?? "", new RegExp(`^TSR\\d+@${checked}:`, "u"), where);
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
    const own = decisionOf(decisions, { place: tally, path: [] });
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
      // (at a settled program stop the candidate may decline the compile, #1526 decision 2: an accepted over-decline,
      // #1832, the store check of `tally`'s host value partial and no completion to tell it from the natural plan's; a
      // published plan runs as the unstopped one; its analysis is judged either way)
      if (allowance !== undefined)
        try {
          const run = capped(() => stopRun(source, allowance));
          // (a published plan runs as the unstopped one)
          assert.ok(run.result.plan !== null, where);
          for (const value of [2, 2.5, "x"])
            assert.deepEqual(
              runGlobals(run.result.plan, host(value)),
              runGlobals(unstopped.result.plan!, host(value)),
              where,
            );
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error;
          assert.ok(error instanceof CandidateOutsideSlice && error.what === LOST_CHECK, where);
        }
      const answers: Answers =
        allowance === undefined
          ? unstopped.answers
          : capped(() => withTestAllowance(allowance, () => analyseCore(request)));
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
 * 257, which stops a decision below `root`; where it stops the analysis itself (the reversed orders) there
 * is no unstopped analysis to compare. A host value fits where the unstopped plan runs it: without sharing, 257 decides
 * the element `regex`, which C9 checks the host value against. Both programs store into inferred places, so at the stop
 * before admission settled the plain gate declines (#2080 part 2): there the records and the check ledger are compared.
 */
test("a stop adds no boundary below a stopped decision and keeps toJson's checks, or the program is declined (#1437, #1526)", () => {
  const sources = [
    "let root={value:{a:[hostValue otherwise /r/],b:1}}\nlet first=root\nlet second=first\n" +
      "say toJson(first)\nsay toJson(second)\nsay toJson(root)\nexit\n",
    "let n = 1\nsay toJson({a: [hostValue otherwise /r/], b: n})\nexit\n",
  ];
  // (#1526 decision 2, condition 1: a settled stop whose plan lost the element's check, which the unstopped
  // plan makes against a host value, is declined; where the reference run at demand 257 is such a stop, a decision's,
  // each of its stops is declined too, and an unsettled one, which has no registry, by the plain gate, #2080 part 2)
  const declines = (error: unknown): boolean =>
    error instanceof CandidateOutsideSlice &&
    error.what === "a store whose check was lost at the budget";
  let compared = 0;
  let declined = 0;
  let unsettled = 0;
  let undecided = 0;
  for (const source of sources)
    for (const demand of [null, 257])
      for (const mode of MODES) {
        const inDemand = <T>(make: () => T): T =>
          inMode(mode, () => (demand === null ? make() : withTestDemandAllowance(demand, make)));
        // (each settled phase's ends, and the last stop before admission settled, whose fresh pass asks nothing)
        const stopsOf = (): (readonly [string, number])[] => [
          ...[...inDemand(() => settledEnds(source))].flatMap(([phase, ends]) =>
            ends.map((allowance) => [phase, allowance] as const),
          ),
          ["unsettled", inDemand(() => lastUnsettled(source))],
        ];
        let unstopped: StopRun;
        try {
          unstopped = stopRunIn(inDemand, source);
        } catch (error) {
          assert.ok(declines(error), `${source} demand: ${demand}, ${JSON.stringify(mode)}`);
          for (const [phase, allowance] of stopsOf()) {
            const where = `${source} demand: ${demand}, ${JSON.stringify(mode)}, ${phase} @${allowance}`;
            try {
              const stopped = stopRunIn(inDemand, source, allowance);
              assert.equal(stopped.answers.budget.settled, false, where);
              assert.ok(stopped.undecided, where);
              unsettled += 1;
            } catch (stop) {
              assert.ok(declines(stop), where);
              declined += 1;
            }
          }
          continue;
        }
        if (unstopped.answers.budget.exhausted !== null) continue;
        const inputs = [host(1), host(null)];
        const fits = (globals: Globals): boolean =>
          runGlobals(unstopped.result.plan!, globals).failure === null;
        for (const [phase, allowance] of stopsOf()) {
          compared += 1;
          const where = `${source} demand: ${demand}, ${JSON.stringify(mode)}, ${phase} @${allowance}`;
          let stopped: ReturnType<typeof stopRun>;
          try {
            stopped = stopRunIn(inDemand, source, allowance);
          } catch (error) {
            assert.ok(declines(error), where);
            assert.ok(
              inputs.some((globals) => !fits(globals)),
              where,
            );
            declined += 1;
            continue;
          }
          if (phase === "unsettled") undecided += 1;
          assert.deepEqual(
            gatedProblems(
              {
                unstopped,
                stopped,
                fitting: inputs.filter(fits),
                violating: inputs.filter((globals) => !fits(globals)),
              },
              phase === "unsettled",
            ),
            [],
            where,
          );
        }
      }
  // (54 stops: in source order at demand 257, with and without sharing, the first source's reference run stops `root`'s
  // decisions and loses the `value.a` element's check; of its five stops each, its two walk ends and two publication ends
  // are declined, and the last unsettled one by the plain gate; each of the 12 compared runs' last unsettled stop is the
  // plain gate's)
  assert.deepEqual(
    { compared, declined, unsettled, undecided },
    { compared: 44, declined: 8, unsettled: 2, undecided: 12 },
  );
});

/**
 * a pass in which a decision stops is not settled; the next, from the same rejections, starts with that key stopped
 * (`Contract.stop`), so no result read the key before its stop, in any order. `pair`'s stored literal holds a read of
 * `tally`; in the reversed order `pair` is decided before `tally`, and without the next pass `pair.first` kept the host
 * value `tally` held then; `count`'s error is independent of `tally` and stays. One extra pass where a decision first
 * stops, none without one, and at most one per rejected set
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183): in the reversed order `box`'s
 * root, which reads the values `box.n`'s stopped decision had finished, stops once `box.n` is stopped from its pass's
 * start, and that second stop stops the analysis as the work allowance does. A program stop in the pass where a
 * decision first stopped is not settled: finishing marks the stores, and the stop oracle holds, no boundary among it,
 * as in #1194's witness below of a second stop; the plain gate declines it (#2080 part 2).
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
    const own = decisionOf(unbounded.budget.decisions, { place: tally.id, path: [] });
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
    // (the independent error stays; in the reversed unshared mode `pair`'s element decision, longer there than
    // `tally`'s, stops too and then again in the restarted pass, which stops the analysis
    // (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183): its check is marked)
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
    const own = decisionOf(inMode(() => analyseCore(scalar.request)).budget.decisions, {
      place: scalar.id,
      path: [],
    });
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
    // (the inferred stores' checks are left undecided there: the plain gate declines, #2080 part 2)
    assert.deepEqual(
      capped(() =>
        gatedProblems({ unstopped, stopped, fitting: [host(2)], violating: [host(2.5)] }, true),
      ),
      [],
      mode,
    );
  }
  // a decision stopping only in the restarted pass: the analysis stops there
  // (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183)
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
  const root = decisionOf(reversed(() => analyseCore(box.request)).budget.decisions, {
    place: box.id,
    path: [],
  });
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
 * Codex c-r8 B1 on #1165: a narrowed read of a key whose decision stopped reads it as every read does,
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
      const own = decisionOf(inOrder(() => analyseCore(request)).budget.decisions, {
        place: tally,
        path: [],
      });
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
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183): a decision that stops in the
 * restarted pass stops the analysis there, its stores marked, the stop oracle holding, and the plain gate declining
 * (#2080 part 2). #1194's copies of a deep
 * written type (64 levels and copies) are the witness: at the natural allowance they are `valid` in the four modes with
 * no restart (the recorded cost was the alias class's eligibility index, charged to the first decision that asked for
 * it, the sharing on only, #1703); at the demand allowance 1,024 the reversed order's deepest decision stops, and the
 * next path's in the restarted pass, with the sharing on and off.
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
  const sharings = [
    ["shared", <T>(make: () => T): T => make()],
    ["unshared", withoutSharing],
  ] as const;
  for (const [name, sharing] of sharings)
    for (const order of [<T>(make: () => T): T => make(), reversed]) {
      const natural = stopRunIn((make) => sharing(() => order(make)), source);
      const where = `${name}, reversed: ${order === reversed}`;
      assert.equal(natural.answers.budget.exhausted, null, where);
      assert.equal(natural.answers.budget.counts.get("stopPasses"), undefined, where);
      assert.equal(natural.result.diagnostics.length, 0, where);
    }
  for (const [name, sharing] of sharings) {
    const ordered = <T>(make: () => T): T => sharing(() => reversed(make));
    // (the reference: no decision stops under a demand allowance the analysis never reaches)
    const unstopped = stopRunIn(
      (make) => withTestDemandAllowance(30_000_000, () => ordered(make)),
      source,
    );
    assert.equal(unstopped.answers.budget.exhausted, null, name);
    assert.equal(unstopped.result.diagnostics.length, 0, name);
    const stopped = stopRunIn(
      (make) => withTestDemandAllowance(1_024, () => ordered(make)),
      source,
    );
    const { budget } = stopped.answers;
    assert.equal(budget.counts.get("stopPasses"), 1, name);
    assert.equal(budget.exhausted, "work", name);
    assert.equal(budget.settled, false, name);
    assert.ok(
      budget.deferred.some((mark) => mark.rule.rule === "store"),
      name,
    );
    // (the copy `out`'s check is left undecided: the plain gate declines, #2080 part 2)
    assert.deepEqual(
      gatedProblems({ unstopped, stopped, fitting: [], violating: [] }, true),
      [],
      name,
    );
  }
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
 * At a property or index read's occurrence (G3 3a): its answer kept before a key's decision stops is not
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
 * Through every answer the solver keeps (#1403): an answer kept before a key's decision stops may have
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
 * #1599: what a stop forgets by is kept only where a decision can still stop (a place before its last decision ends,
 * and the readers of what a stop may then forget), so a forget sees exactly the answers it would with every record
 * kept (`withEveryRecord`). Shapes whose decisions read a place before, between and after its stores' decisions, through
 * copies, selections and an operation, each at demand allowances from 1 to 1,024 in the four modes, where decisions
 * stop: the stop set and what is published at it the same either way, and a decision stops at some allowance. The
 * oracle compares what production can reach: complete runs and runs cut short at a demand's allowance (a budget stop
 * closes forgetting, `Solver.run`).
 */
test("a stop forgets what it would with every record kept: the same stop sets in the four modes (#1599)", () => {
  const shapes = [
    'let seed = {n: "origin", m: "other"}\nseed.n = "later"\nlet c = seed.n\nlet d = [seed.n, seed.m][0]\nsay c\nsay d\nexit\n',
    'let seed = {n: "origin"}\nlet c0 = seed.n\nlet c1 = [seed.n][0]\nseed.n = "later"\nlet c2 = seed.n\nsay c2\nexit\n',
    "let box = {q: {n: 1}}\nlet copy = box\nbox.q.n = 2\ncopy.q.n = 3\nlet out = copy.q.n\nsay out\nexit\n",
    "let box = [[{n: 1}]]\nlet copy = box\nbox[0][0].n = 2\nsay copy.first.first.n\nexit\n",
    "let v: integer? = null\nlet a = {n: {m: v}}\na.n.m = 3\nsay (a.n otherwise {m: 2}).m\nexit\n",
  ];
  for (const source of shapes) {
    const files = [{ path: "main.tease", source }];
    let stopped = 0;
    for (const mode of MODES)
      for (let allowance = 1; allowance <= 1024; allowance *= 2) {
        const stops = () => stopSet(files, mode, ["hostValue"], allowance);
        const kept = stops();
        assert.deepEqual(
          kept,
          withEveryRecord(stops),
          `${source.split("\n")[1]} ${JSON.stringify(mode)} at demand ${allowance}`,
        );
        if ((kept?.stops.length ?? 0) > 0) stopped += 1;
      }
    assert.ok(stopped > 0, `${source.split("\n")[1]}: a decision stops`);
  }
});

/**
 * #1599: what a stop forgets by stands for a place until its last decision ends (`Contract.openDecisions`, `decided`).
 * Each binding is given two decisions and every other binding one; every value is read; every other binding's decision
 * ends, and one of the two of the binding to stop; the binding's key, or one below it, stops: every value then answers
 * as in a pass that starts with that key stopped, in both read orders and the four modes, so what was asked of the
 * place before its first decision ended is still forgotten.
 */
test("what a stop forgets by stands for a place until its last decision ends (#1599)", () => {
  const shapes = [
    "let box = [[{n: 1}]]\nlet copy = box\nsay copy.first.first.n\nexit\n",
    "let v: integer? = null\nlet a = {n: {m: v}}\nsay (a.n otherwise {m: 2}).m\nexit\n",
    "let a = {n: 1}\nsay [a][0].n\nexit\n",
  ];
  for (const source of shapes) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { program } = narrowingPass(request);
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    const bindings = program.places
      .filter((place) => place.kind.kind === "binding")
      .map((place) => place.id);
    const stops: { readonly place: PlaceId; readonly path: readonly string[] }[] = [];
    for (const place of bindings) stops.push({ place, path: [] });
    for (const value of values) {
      const { root, path } = program.targetRoot(value);
      if (bindings.includes(root) && path.length > 0) stops.push({ place: root, path });
    }
    for (const stop of stops)
      for (const [mode, inMode] of STOP_MODES)
        for (const order of ["source", "reversed"])
          inMode(() => {
            const where = `${source.split("\n").at(-3)} @${program.places[stop.place]!.label}.${stop.path.join(".")}, ${mode}, ${order}`;
            const read = (pass: CorePass, value: PlaceId) =>
              tagged(pass.solver.run(pass.contract.contractOfValue(value)));
            const own = order === "source" ? values : [...values].reverse();
            const pass = narrowingPass(request);
            pass.contract.openDecisions([
              ...bindings.map((root) => ({ root })),
              { root: stop.place },
            ]);
            for (const value of own) read(pass, value);
            for (const root of bindings) pass.contract.decided(root);
            pass.contract.stop(stop.place, stop.path);
            const after = new Map(own.map((value) => [value, read(pass, value)]));
            const fresh = narrowingPass(request);
            fresh.contract.stop(stop.place, stop.path);
            for (const value of values)
              assert.deepEqual(after.get(value), read(fresh, value), where);
          });
  }
});

/**
 * #1601's Astra r1 (R1): a demand a stop forgets and that is made again stays forgettable (`Solver.#forgettable`), since
 * what reached it before (an ask kept at a place still open, a reader edge kept from another demand) reaches it again.
 * Each value is read; one binding stops and its decisions end; every value is read again, the forgotten demands made
 * again; a second binding stops. What the second stop forgets, the answers and every charged counter equal those with
 * every record kept (`withEveryRecord`), in the four modes and both read orders: Astra's witness (`c`, then `a`, through
 * admission's groups) and her family of three sources, every ordered pair of their bindings.
 */
test("a demand made again after a forget stays forgettable until forgetting closes (#1599)", () => {
  const sources = [
    "let a: integer? = null\nlet b = 1\nlet c = a otherwise b\nlet d = [c]\nsay d.first\nexit\n",
    "let a = [{n: 1}]\nlet b = a\nlet c = [b.first, a.last]\nlet d = c.first.n\nsay d\nexit\n",
    "let a = [1]\nlet b = [2]\nlet c = a + b\nlet d = c.first\nsay d\nexit\n",
  ];
  const apart = new Set(["readerRecords", "stopAsks"]);
  interface Witnessed {
    readonly before: readonly string[][];
    readonly between: readonly string[][];
    readonly forgotten: readonly string[];
    readonly after: readonly string[][];
    readonly work: {
      readonly total: number;
      readonly counts: readonly (readonly [string, number])[];
      readonly apart: readonly (readonly [string, number])[];
    };
  }
  // (two stops with every value read before, between and after them; `groups`: the places opened by admission's own
  // groups, else one decision per binding)
  const run = (
    source: string,
    first: number,
    second: number,
    reversed: boolean,
    groups: boolean,
  ): Witnessed => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const pass = narrowingPass(request);
    const { program, contract, solver } = pass;
    const roots = program.places
      .filter((place) => place.kind.kind === "binding")
      .map((place) => place.id);
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    if (reversed) values.reverse();
    const decisions = groups
      ? new Consumers(pass).admission.groups()
      : roots.map((root) => ({ root }));
    contract.openDecisions(decisions);
    const ask = () =>
      values.map((value) => solver.run(contract.contractOfValue(value)).map(itemText));
    const kept = () =>
      [...new Set(solver.demandWork().map(({ key }) => key))]
        .filter((key) => solver.answer(key) !== undefined)
        .sort();
    const work = () => ({
      total: program.work.total,
      counts: [...program.work.counts()],
      apart: [...program.work.apartCounts()].filter(([counter]) => !apart.has(counter)),
    });
    const before = ask();
    contract.stop(roots[first]!, []);
    for (const decision of decisions)
      if (decision.root === roots[first]) contract.decided(decision.root);
    const between = ask();
    const memo = kept();
    contract.stop(roots[second]!, []);
    const forgotten = memo.filter((key) => solver.answer(key) === undefined);
    const after = ask();
    return { before, between, forgotten, after, work: work() };
  };
  for (const [index, source] of sources.entries()) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const labels = narrowingPass(request)
      .program.places.filter((place) => place.kind.kind === "binding")
      .map((place) => place.label);
    const pairs: (readonly [number, number, boolean])[] = [];
    // (Astra's witness: `c`, then `a`, through admission's groups)
    if (index === 0) pairs.push([labels.indexOf("c"), labels.indexOf("a"), true]);
    for (let first = 0; first < labels.length; first += 1)
      for (let second = 0; second < labels.length; second += 1)
        if (first !== second) pairs.push([first, second, false]);
    for (const [first, second, groups] of pairs)
      for (const mode of MODES)
        for (const reversed of [false, true])
          inMode(mode, () => {
            const where = `${source.split("\n")[2]} ${labels[first]} then ${labels[second]}${groups ? " (groups)" : ""} ${JSON.stringify(mode)}${reversed ? " reversed" : ""}`;
            assert.deepEqual(
              run(source, first, second, reversed, groups),
              withEveryRecord(() => run(source, first, second, reversed, groups)),
              where,
            );
          });
  }
});

/**
 * #1601's Codex r3 (R1): a run cut short at a demand's allowance drops what has not finished, after each pending read of
 * it keeps its reader as the read's return would have (`Solver.run`), so a demand made again after it and after a stop
 * is reached by the next stop as with every record kept. Codex's witness (every value read in one demand of a few
 * hundred units, which stops; `c` stops and its decision ends; every value is read again; `a` stops), at a few
 * allowances from that one up, in the four modes and both read orders: what the second stop forgets, every answer and
 * the charged counters equal those with every record kept (`withEveryRecord`). The oracle compares what production can
 * reach: complete runs and runs cut short at a demand's allowance; a run the analysis's budget stops closes forgetting
 * instead (`Solver.run`), so no forget follows it (`type-core-solver`).
 */
test("a run cut short keeps the readers its returns would have kept (#1599)", () => {
  const source =
    "let a: integer? = null\nlet b = 1\nlet c = a otherwise b\nlet d = [c]\nsay d.first\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  interface Witnessed {
    readonly cut: boolean;
    readonly before: readonly string[][];
    readonly forgotten: readonly string[];
    readonly after: readonly string[][];
    readonly total: number;
    readonly counts: readonly (readonly [string, number])[];
  }
  const run = (allowance: number, reversed: boolean): Witnessed => {
    const { program, contract, solver } = narrowingPass(request);
    const bindings = program.places.filter((place) => place.kind.kind === "binding");
    contract.openDecisions(bindings.map(({ id }) => ({ root: id })));
    const at = (label: string): PlaceId => bindings.find((place) => place.label === label)!.id;
    const values = program.places
      .filter((place) => place.kind.kind === "value" || place.kind.kind === "target")
      .map((place) => place.id);
    if (reversed) values.reverse();
    const ask = () =>
      values.map((value) => solver.run(contract.contractOfValue(value)).map(itemText));
    let cut = false;
    try {
      solver.demand(
        (function* () {
          for (const value of values) yield* contract.contractOfValue(value);
          return [];
        })(),
        allowance,
      );
    } catch (error) {
      if (!(error instanceof DemandExhausted)) throw error;
      cut = true;
    }
    contract.stop(at("c"), []);
    contract.decided(at("c"));
    const before = ask();
    const memo = [...new Set(solver.demandWork().map(({ key }) => key))]
      .filter((key) => solver.answer(key) !== undefined)
      .sort();
    contract.stop(at("a"), []);
    const forgotten = memo.filter((key) => solver.answer(key) === undefined);
    const after = ask();
    return {
      cut,
      before,
      forgotten,
      after,
      total: program.work.total,
      counts: [...program.work.counts()],
    };
  };
  let cut = 0;
  for (const allowance of [96, 192, 392, 600])
    for (const mode of MODES)
      for (const reversed of [false, true])
        inMode(mode, () => {
          const own = run(allowance, reversed);
          if (own.cut) cut += 1;
          assert.deepEqual(
            own,
            withEveryRecord(() => run(allowance, reversed)),
            `at ${allowance}, ${JSON.stringify(mode)}${reversed ? ", reversed" : ""}`,
          );
        });
  assert.ok(cut > 0, "a run is cut short");
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

/**
 * #1466, the families runner's stops area at demand allowance 256 (`1249-astra-r2-written-origins`,
 * `1249-astra-copy-and-cycle-cases`): a read one holder's source answers asks that source by reference,
 * so its decision costs what `main`'s does and stops where `main`'s does; a summary rebuilt from the path's record cost
 * the decision about 80 units more and stopped `c` at `next.n`, and `other` at `inner.tone`, which `main` completes.
 * Every stop set in the four modes is `main`'s (measured on 7d6c4d3d4: a regression oracle of these sources).
 */
test("a read its one holder's source answers stops where main's does at a small demand allowance (#1466)", () => {
  const written = (read: boolean): string =>
    [
      "let w:integer=1",
      "let first=w",
      "let alias=first",
      "let a={n: alias, next: null}",
      "a.next=a",
      'let b={next:{n:"text"}}',
      "let c=a",
      "c=b",
      ...(read ? ["say c.next.n"] : []),
      "exit",
    ].join("\n");
  const cycle = [
    "let a={tone:1,inner:null}",
    "a.inner=a",
    'let bad={inner:{tone:"bad"}}',
    "let other=bad",
    "other=a",
    "say other.inner.tone",
    "exit",
  ].join("\n");
  const tone = (decided: number) => [1, "other", "inner.tone", decided];
  const cases = [
    {
      source: written(false),
      globals: ["hostValue", "hostInit", "hostOther"],
      stops: [[], [], [], []],
    },
    {
      source: written(true),
      globals: ["hostValue", "hostInit", "hostOther"],
      stops: [[], [], [], []],
    },
    {
      source: cycle,
      globals: ["hostValue", "hostOther"],
      stops: [[tone(7)], [], [tone(1)], [tone(1)]],
    },
  ];
  for (const { source, globals, stops } of cases)
    MODES.forEach((mode, index) => {
      const set = stopSet([{ path: "main.tease", source }], mode, globals, 256);
      assert.deepEqual(set?.stops, stops[index], `${source}\nmode ${index}`);
    });
});

/**
 * The owner's one accepted relabel at a combined stop
 * (docs/specifications/type-inference-accepted-record/oracles.md#r4-322, #1595, the lead's rulings), each form accepted
 * alone and each condition alone refusing it. A stopped check under a more precise label than the reference's generic
 * one: E, the same root place with some `element` steps below it spelled `entry`; or E2, a place's own text whose path
 * up the compiler's projections is the reference's. Both labels are the compiler's own as recorded with each emitted
 * check (`labelIdentities`), never read back from a site, an expression or a name: a check at a method call names its
 * receiver (Codex r6's `xs["a"].add(...)`, `.clear()`, `xs.values[0].clear()`). The real cases are each program's first
 * relabel at a settled combined stop, proved by the natural analysis at that site and by the written type alone; the
 * unit cases change one part of a real one: the check, its location, its expected types or its words (2, 3), its
 * label's place or steps (3), its proof (1), or a label the recorder did not capture (refused and counted, never
 * inferred).
 */
test("a combined stop's more precise label is accepted only as the owner's three conditions allow (#1595)", () => {
  const mode = HELD_MODES[0]!;
  const same = (x: Obligation, u: Obligation): boolean =>
    x.kind === u.kind &&
    JSON.stringify(x.site) === JSON.stringify(u.site) &&
    x.boundary === u.boundary &&
    JSON.stringify(x.against) === JSON.stringify(u.against);
  // (a program's first relabel at a settled combined stop, demands up to 3, with both analyses' recorded labels)
  const relabel = (source: string) => {
    const c: HeldCase = { name: source, source, slice: true, values: [] };
    for (const demand of heldDemands(c, mode).filter((each) => each <= 3)) {
      const { reference, natural, stoppedAt } = combinedAnalyses(
        [{ path: "main.tease", source }],
        mode,
        demand,
      );
      for (const { allowance } of heldStops(c, mode, 1, demand)) {
        const stopped = stoppedAt(allowance);
        if (!stopped.budget.settled) continue;
        const owed = [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)];
        for (const u of reference.checks) {
          const x = owed.find((each) => same(each, u) && each.target !== u.target);
          if (x === undefined || owed.some((each) => JSON.stringify(each) === JSON.stringify(u)))
            continue;
          const [from, to] = [labelIdentities(reference)!, labelIdentities(stopped)!];
          return { u, x, graph: reference.graph, natural: natural.checks, from, to };
        }
      }
    }
    assert.fail(`no relabel: ${source}`);
  };
  const cases = [
    // (E at a method call, its receiver's label: Codex r6's witnesses)
    ['let xs: dict = dict {a: hostValue}\nxs["a"].add(hostOther)', "xs.element", "xs.entry"],
    ['let xs: dict = dict {a: [hostValue]}\nxs["a"].clear()', "xs.element", "xs.entry"],
    // (E2 at a method call: Codex r6's derived receiver)
    [
      "let xs: dict = dict {a: [hostValue]}\nxs.values[0].clear()",
      "xs.values.element",
      "xs.values[0]",
    ],
    // (E at a call's result; E2 at a binding and at a parameter)
    [
      'function build: integer dict {return dict {a: hostValue, b: 4}}\nsay "BEFORE"\nrepeat build()["a"] {say "ok"}',
      "build.result.element",
      "build.result.entry",
    ],
    [
      'let xs: dict = dict {a: hostValue, b: 4}\nsay "BEFORE"\nrepeat xs.values[0] {say "ok"}',
      "xs.values.element",
      "xs.values[0]",
    ],
    [
      'function show(xs: dict) {repeat xs.values[0] {say "ok"}}\nsay "BEFORE"\nshow(dict {a: hostValue})',
      "show.xs.values",
      "xs.values",
    ],
  ] as const;
  const found = cases.map(([program, reference, stopped]) => {
    const real = relabel(`${program}\nsay "AFTER"\nexit\n`);
    assert.deepEqual([real.u.target, real.x.target], [reference, stopped], program);
    const { u, x, graph, natural, from, to } = real;
    assert.equal(provenRelabel(u, [x], natural, graph, from, to), x, program);
    assert.equal(provenRelabel(u, [x], [], graph, from, to), x, `${program}: written`);
    return real;
  });
  const [entry, , own] = found;
  const { u, x, graph, natural, from, to } = entry!;
  const idOf = (labels: LabelIdentities, check: Obligation) => labels.of(check)!;
  const [root, read] = [idOf(from, u), idOf(own!.to, own!.x)];
  assert.deepEqual(
    [root.kind, root.steps, read.kind, read.steps],
    ["path", ["element"], "own", []],
  );
  // (2) another check, location or expected types under the label; (3) other words: refused before any label is read
  for (const other of [
    { ...x, kind: "integer-check" as const },
    { ...x, site: { ...x.site, end: x.site.end - 1 } },
    { ...x, boundary: true },
    { ...x, against: ["number" as const] },
    { ...x, on: "check that the count is a whole number" },
  ])
    assert.equal(
      provenRelabel(u, [other], natural, graph, from, to),
      undefined,
      JSON.stringify(other),
    );
  assert.deepEqual([...from.missing, ...to.missing], []);
  // (3) the label's place and steps: another root place, a step count or a step other than an element spelled `entry`,
  // own text with a step below it; a reference that is own text itself
  const other = [...Array(to.places).keys()].find(
    (place) => place !== root.place && to.site(place) !== null,
  )!;
  for (const label of [
    { kind: "path" as const, place: other, steps: ["entry"] },
    { kind: "path" as const, place: root.place, steps: ["element", "entry"] },
    { kind: "path" as const, place: root.place, steps: ["values"] },
    { kind: "own" as const, place: root.place, steps: ["entry"] },
  ])
    assert.equal(
      provenRelabel(u, [x], natural, graph, from, withLabels(to, [[x, label]])),
      undefined,
      JSON.stringify(label),
    );
  assert.equal(
    provenRelabel(u, [x], natural, graph, withLabels(from, [[u, { ...root, kind: "own" }]]), to),
    undefined,
  );
  // (3) with the natural analysis naming the stopped label there: an `entry` for a reference's property step, and the
  // read's own text where no derived list is on its path (the compiler spells that read's path)
  const element = [...Array(to.places).keys()].find((place) => {
    const path = to.climb(place);
    return path?.root === root.place && path.steps.join() === "element";
  })!;
  assert.ok(element !== undefined);
  assert.equal(
    provenRelabel(
      u,
      [x],
      natural,
      graph,
      withLabels(from, [[u, { ...root, steps: ["values"] }]]),
      withLabels(to, [[x, { kind: "path", place: root.place, steps: ["entry"] }]]),
    ),
    undefined,
  );
  assert.equal(
    provenRelabel(
      u,
      [x],
      natural,
      graph,
      from,
      withLabels(to, [[x, { kind: "own", place: element, steps: [] }]]),
    ),
    undefined,
  );
  // (3) E2: another expression's own text on the read's chain (its receiver, `xs.values`), own text with a step below
  // it, an `entry` path through the derived list
  {
    const { u, x, graph, natural, from, to } = own!;
    const receiver = [...Array(to.places).keys()].find((place) => {
      const path = to.climb(place);
      return path !== null && path.root === idOf(from, u).place && path.steps.join() === "values";
    })!;
    assert.ok(receiver !== undefined);
    for (const label of [
      { kind: "own" as const, place: receiver, steps: [] },
      { kind: "own" as const, place: read.place, steps: ["element"] },
      { kind: "path" as const, place: idOf(from, u).place, steps: ["values", "entry"] },
    ])
      assert.equal(
        provenRelabel(
          u,
          [x],
          label.kind === "path" ? [] : natural,
          graph,
          from,
          withLabels(to, [[x, label]]),
        ),
        undefined,
        JSON.stringify(label),
      );
  }
  // (1) neither proves it: a root place with no written type, the natural analysis naming it at another value's site,
  // otherwise or not at all
  const untyped = [...Array(to.places).keys()].find(
    (place) => place !== root.place && to.site(place) !== null && from.site(place) !== null,
  )!;
  const [bare, bareFrom] = [
    withLabels(to, [[x, { kind: "path", place: untyped, steps: ["entry"] }]]),
    withLabels(from, [[u, { kind: "path", place: untyped, steps: ["element"] }]]),
  ];
  const at = (target: string, site = x.site): Obligation => ({ ...x, target, site });
  assert.equal(provenRelabel(u, [x], [at(x.target)], graph, bareFrom, bare), x);
  assert.equal(provenRelabel(u, [x], [at(`${x.target}.f`)], graph, bareFrom, bare), x);
  for (const proof of [[], [at(x.target, { ...x.site, start: 0 })], [at(u.target)]])
    assert.equal(
      provenRelabel(u, [x], proof, graph, bareFrom, bare),
      undefined,
      JSON.stringify(proof),
    );
  // (a root's written type is its own declaration's, by its file and offsets: two files' locals at the same offsets,
  // each its own written type)
  {
    const sources = [
      'function f {\nlet ys: integer dict = dict {a: hostValue}\nrepeat ys[0] {say "a"}\n}\nf()\nexit\n',
      'function g {\nlet ys: integer[] = [hostValue, hostValue]\nrepeat ys[0] {say "a"}\n}\ng()\nexit\n',
    ];
    const answers = recordedAnalysis(
      sources.map((source, i) => ({ path: `${"ab"[i]!}.tease`, source })),
    );
    const labels = labelIdentities(answers)!;
    const roots = [...Array(labels.places).keys()].flatMap((place) => {
      const path = labels.climb(place);
      return path?.steps.join() === "element" ? [path.root] : [];
    });
    const rootIn = (file: number) => roots.find((each) => labels.site(each)?.file === file)!;
    const [ru, rx] = [
      { ...u, target: "ys.element", on: "check that ys.element is a whole number" },
      { ...u, target: "ys.entry", on: "check that ys.entry is a whole number" },
    ];
    const proved = (file: number) =>
      provenRelabel(
        ru,
        [rx],
        [],
        answers.graph,
        withLabels(labels, [[ru, { kind: "path", place: rootIn(file), steps: ["element"] }]]),
        withLabels(labels, [[rx, { kind: "path", place: rootIn(file), steps: ["entry"] }]]),
      );
    assert.equal(proved(0), rx);
    assert.equal(proved(1), undefined);
  }
  // (a stopped check whose label the recorder did not capture: refused and counted, never inferred)
  const unrecorded = { ...x, target: "xs.other", on: u.on.split(u.target).join("xs.other") };
  assert.equal(provenRelabel(u, [unrecorded], natural, graph, from, to), undefined);
  assert.deepEqual([...to.missing], [JSON.stringify(unrecorded)]);
  // (a read's path is the compiler's climb up its projections, linear in its length: twelve and twenty-three
  // selections within milliseconds)
  for (const length of [12, 23]) {
    const answers = recordedAnalysis([
      {
        path: "main.tease",
        source: `let xs: dict = dict {a: hostValue}\nrepeat xs.values${".first".repeat(length)} {say "a"}\nexit\n`,
      },
    ]);
    const labels = labelIdentities(answers)!;
    // (the read's own text: of the own labels its checks carry, the one deepest below its root)
    const deep = answers.checks
      .map((check) => labels.of(check))
      .filter((label) => label?.kind === "own")
      .sort(
        (a, b) =>
          (labels.climb(b!.place)?.steps.length ?? 0) - (labels.climb(a!.place)?.steps.length ?? 0),
      )[0];
    assert.ok(deep !== undefined && deep !== null, `${length}`);
    const started = performance.now();
    const path = labels.climb(deep.place);
    const took = performance.now() - started;
    assert.deepEqual(path?.steps, ["values", ...Array(length).fill("element")]);
    assert.ok(took < 100, `${length} selections: ${took} ms`);
  }
});

/**
 * After a program stop a label's step is spelled from a proof the stopped analysis holds (`labelDomain`, the lead's ruling
 * on #1595's HEAD 0): never from an open retained answer. A copy of an element of a list written without its element's
 * type, which every kind fits, read at every settled stop of a real run where its contract asked then is unsettled,
 * four modes: no label domain there.
 */
test("a label's step after a stop never rests on an open retained answer (#1595)", () => {
  const source =
    'let a: list = [hostValue]\nlet b = a[0]\nsay "BEFORE"\nsay "${b}"\nsay "AFTER"\nexit\n';
  const c: HeldCase = { name: "an open retained answer", source, slice: true, values: [] };
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  let open = 0;
  for (const mode of HELD_MODES)
    for (const { allowance } of heldStops(c, mode)) {
      let walk: Consumers | undefined;
      const check = Consumers.prototype.check;
      Consumers.prototype.check = function (this: Consumers) {
        walk = this;
        return check.call(this);
      };
      try {
        mode.run(() => withTestAllowance(allowance, () => analyseCore(request)));
      } finally {
        Consumers.prototype.check = check;
      }
      if (!walk!.settled) continue;
      const place = walk!.pass.program.places.find(
        (each) => each.kind.kind === "binding" && each.kind.name === "b",
      )!.id;
      const { work } = walk!.pass.program;
      work.apart(() => {
        const contract = walk!.run(walk!.pass.contract.contractOf(keyOf(place, [])));
        const retained = walk!.admission.retained(place, []);
        if (
          !contract.some(
            (item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0,
          ) ||
          retained?.tags.includes("unknown") !== true
        )
          return;
        open += 1;
        assert.equal(labelDomain(walk!, keyOf(place, [])), null, `${mode.name} @${allowance}`);
      });
    }
  // (the source reaches the open answer: the test is not vacuous)
  assert.ok(open > 0);
});

/**
 * A combined stop names a dictionary's value and a derived list's read as the unstopped analysis does (#1595, Codex r1's
 * B3 on #1687): the issue's witnesses, forward, at each stopping demand allowance up to 3, where the demand-only
 * analysis ran out of demand reading the key and spells it `element`: where a settled stop makes the check after it,
 * the stopped analysis owes it under the more precise label (`build.result.entry`, `xs.values[0]`). A check made before
 * the stop keeps the demand-only analysis's own.
 */
test("a combined stop spells a dictionary's value and a derived list's read as the unstopped analysis does (#1595)", () => {
  const witnesses = [
    {
      source:
        'function build: integer dict {return dict {a: hostValue, b: 4}}\nsay "BEFORE"\nrepeat build()["a"] {say "ok"}\nsay "AFTER"\nexit\n',
      precise: "build.result.entry",
    },
    {
      source:
        'let xs: dict = dict {a: hostValue, b: 4}\nsay "BEFORE"\nrepeat xs.values[0] {say "ok"}\nsay "AFTER"\nexit\n',
      precise: "xs.values[0]",
    },
  ];
  const mode = HELD_MODES[0]!;
  for (const { source, precise } of witnesses) {
    const c: HeldCase = { name: precise, source, slice: true, values: [] };
    let spelled = 0;
    for (const demand of heldDemands(c, mode).filter((each) => each <= 3)) {
      const { stoppedAt } = combinedAnalyses([{ path: "main.tease", source }], mode, demand);
      for (const { allowance } of heldStops(c, mode, 1, demand)) {
        const stopped = stoppedAt(allowance);
        if (!stopped.budget.settled) continue;
        const targets = [
          ...stopped.checks,
          ...stopped.budget.deferred.map((mark) => mark.obligation),
        ].map((check) => check.target);
        if (targets.includes(precise)) spelled += 1;
      }
    }
    assert.ok(spelled > 0, precise);
  }
});

/**
 * The written proof of a combined stop's more precise label, total over the compiler's label grammar (#1595, the lead's
 * ruling after Codex r3 on #1687). `keyLabel` (`consumers/names.ts`) makes every check's target:
 * - a root: a binding's name `N`, a function's parameter `F.P` or result `F.result` (an anonymous start is its own text,
 *   the same in both runs);
 * - each step below: a property's name; a selection, an index or a `get` spelled `element`, or `entry` where every kind
 *   of its owner is a dictionary (`elementStepOf`, whose kinds after a stop `labelDomain` gives); `values` or `keys`;
 * - where a `values` or `keys` step has a dictionary among its owner's kinds (`derivedChain`), the whole target is
 *   instead the value's own text: `N`, `P` or `F(...)`, each element step as written (`[e]`, `get(e)`, `first`, `last`,
 *   `random`).
 * So a stopped check's label is more precise than the demand-only reference's in exactly two productions, each with one
 * clause of the predicate (`provenRelabel`'s (3) recognizes the form, `relabelForm`; its (1) proves it from a written
 * type, `writtenProves`):
 * - E (`"entry"`): the reference's path with some `element` steps spelled `entry`, nothing else changed: each such
 *   step's owner a written dictionary, every kind of it, and no `values` or `keys` step on the way with a dictionary
 *   among its owner's kinds (there the compiler spells E2 instead);
 * - E2 (`"own"`): the value's own text where the reference spells the path, its root and every step as written, at
 *   least one `values` or `keys`: such a step on the way with a dictionary among its owner's written kinds.
 * The family: written types of lists, dictionaries, nullable dictionaries and unions of dictionaries nested up to three
 * deep (list, dict, dict of dicts, list of dicts, dict of lists, dict of lists of dicts, a list of nullable dicts, a
 * list of a union of dicts, an optional and a union container), at a `let`, a parameter and a result, and a root named
 * `values`; every chain down them, a `values` or `keys` step at each level or none (on a list, a property that derives
 * nothing); and for each chain every E label (each subset of its element steps), every step but an element spelled
 * `entry`, its E2 text, and E2 texts that mix in a generic `element` or an `entry` or spell another derived list. Each
 * pair's answer is read a second time from the shape alone, by the grammar (`expected`), never by the predicate's walk,
 * and the two agree on every pair. Codex r1's to r3's written shapes are members (a nested written dict, an optional
 * and a union container, a composed tail, an ordinary list, a nested derived chain).
 *
 * The reading is derived from the grammar above, read off the compiler's `keyLabel`, `elementStepOf` and
 * `derivedChain`, and from the shape's containers alone: an element step's owner is its level's container (a derived
 * list past `values` or `keys`, nothing known past a list's `values` or `keys`, a property), and a level's kinds are its
 * container's (a nullable dictionary's include `null`, a union's every member's). It is wrong where the grammar is: a
 * label form `keyLabel` makes that the grammar lacks, an `elementStepOf` or `derivedChain` rule it states otherwise (every
 * kind against some kind), or a container whose kinds it reads otherwise than `termAt` follows the written type. Its
 * "accept" answers are checked against the compiler itself outside CI: a sample of the family's programs compiled at
 * settled combined stops, every precise label `labelDomain` gives there one the reading accepts (#1687's evidence,
 * `produced.mjs`); its "refuse" answers stand on the grammar alone.
 */
test("a combined stop's more precise label is proved by its written type exactly as the label grammar allows (#1595)", () => {
  // (a level's container: a list, a dictionary, a nullable dictionary, a union of dictionaries)
  type Level = "list" | "dict" | "dict?" | "dicts";
  const shapes: { readonly levels: readonly Level[]; readonly written?: string }[] = [
    { levels: ["list"] },
    { levels: ["dict"] },
    { levels: ["dict", "dict"] },
    { levels: ["list", "dict"] },
    { levels: ["dict", "list"] },
    { levels: ["dict", "list", "dict"] },
    { levels: ["list", "dict?"], written: "integer dict?[]" },
    { levels: ["list", "dicts"], written: "(integer dict | integer[] dict)[]" },
    { levels: ["list", "dict"], written: "integer dict[]?" },
    { levels: ["list", "dict"], written: "integer dict[] | integer dict set" },
  ];
  const annotation = (levels: readonly Level[]) =>
    [...levels]
      .reverse()
      .reduce((type, level) => (level === "list" ? `${type}[]` : `${type} dict`), "integer");
  const roots = [
    {
      name: "xs",
      path: ["xs"],
      own: "xs",
      program: (t: string, v: string, read: string) =>
        `let xs: ${t} = ${v}\nrepeat ${read} {say "a"}\nexit\n`,
    },
    {
      name: "values",
      path: ["values"],
      own: "values",
      program: (t: string, v: string, read: string) =>
        `let values: ${t} = ${v}\nrepeat ${read} {say "a"}\nexit\n`,
    },
    {
      name: "parameter",
      path: ["show", "xs"],
      own: "xs",
      program: (t: string, _: string, read: string) =>
        `function show(xs: ${t}) {repeat ${read} {say "a"}}\nexit\n`,
    },
    {
      name: "result",
      path: ["build", "result"],
      own: "build()",
      program: (t: string, v: string, read: string) =>
        `function build: ${t} {return ${v}}\nrepeat ${read} {say "a"}\nexit\n`,
    },
  ];
  // (a value of the written type: each level's container holding one, `hostValue` at the bottom)
  const literal = (levels: readonly Level[]) =>
    [...levels]
      .reverse()
      .reduce(
        (value, level) => (level === "list" ? `[${value}]` : `dict {a: ${value}}`),
        "hostValue",
      );
  // (every chain down the levels: at each its element; at a dictionary its `values` then an element, or, last, its
  // `keys` then an element; at a list, last, its `values` or `keys`, a property no written type follows, then an
  // element; each step with its owner's container, a derived list's `derived`, past a property `unknown`)
  type Step = { readonly step: string; readonly owner: Level | "derived" | "unknown" };
  const chains = (levels: readonly Level[]): Step[][] => {
    const out: Step[][] = [];
    const down = (at: number, chain: Step[]) => {
      if (chain.length > 0) out.push(chain);
      if (at === levels.length) return;
      const level = levels[at]!;
      down(at + 1, [...chain, { step: "element", owner: level }]);
      if (level === "list") {
        for (const step of ["values", "keys"])
          out.push([...chain, { step, owner: level }, { step: "element", owner: "unknown" }]);
        return;
      }
      down(at + 1, [
        ...chain,
        { step: "values", owner: level },
        { step: "element", owner: "derived" },
      ]);
      if (at === levels.length - 1)
        out.push([...chain, { step: "keys", owner: level }, { step: "element", owner: "derived" }]);
    };
    down(0, []);
    return out;
  };
  // (the grammar's second reading, from the shape alone: a chain is derived where a `values` or `keys` step has a
  // dictionary among its owner's kinds; E where it is not and every `entry` has a dictionary owner, every kind of it;
  // E2 where it is, its own text exactly)
  const DERIVED_STEPS = new Set(["values", "keys"]);
  const hasDict = (owner: Step["owner"]) =>
    owner === "dict" || owner === "dict?" || owner === "dicts";
  const expected = (
    chain: readonly Step[],
    label: { form: string; entries?: readonly number[] },
  ) => {
    const derived = chain.some(
      ({ step, owner }) => (step === "values" || step === "keys") && hasDict(owner),
    );
    if (label.form === "E")
      return (
        !derived &&
        label.entries!.every(
          (i) =>
            chain[i]!.step === "element" &&
            (chain[i]!.owner === "dict" || chain[i]!.owner === "dicts"),
        )
      );
    return label.form === "E2" && derived;
  };
  const check = (target: string, site: SourceSite): Obligation => ({
    kind: "integer-check",
    target,
    against: ["integer"],
    on: `check that ${target} is a whole number before the read`,
    site,
    boundary: false,
  });
  const disagree: string[] = [];
  let pairs = 0;
  for (const shape of shapes)
    for (const root of roots) {
      if (root.name === "values" && shape.levels.join() !== "list,dict") continue;
      const written = shape.written ?? annotation(shape.levels);
      for (const chain of chains(shape.levels)) {
        // (the read the chain names, as a source writes it: a dictionary's index `["a"]`, a list's `[0]`; a real
        // program reading it, the checks at its site, its own text the source there)
        const spelled = (i: number, step: string) =>
          step !== "element"
            ? `.${step}`
            : ["dict", "dict?", "dicts"].includes(chain[i]!.owner)
              ? '["a"]'
              : "[0]";
        const read = root.own + chain.map(({ step }, i) => spelled(i, step)).join("");
        const program = root.program(written, literal(shape.levels), read);
        const start = program.indexOf(read);
        const at = { file: 0, start, end: start + read.length };
        const answers = recordedAnalysis([{ path: "main.tease", source: program }]);
        const labels = labelIdentities(answers)!;
        // (the read's place, the one whose path up the compiler's projections is the chain's, its root's place, and the
        // places on the way, its receivers: the identities the compiler's labels of it would carry)
        const generic = chain.map(({ step }) => step);
        const paths = [...Array(labels.places).keys()].flatMap((place) => {
          const path = labels.climb(place);
          return path === null ? [] : [{ place, ...path }];
        });
        const reads = paths.filter(({ steps }) => steps.join(".") === generic.join("."));
        assert.equal(reads.length, 1, `${written} ${root.name}: ${read}`);
        const { place, root: rootPlace } = reads[0]!;
        const receivers = paths.filter(
          ({ root: start, steps }) =>
            start === rootPlace &&
            steps.length > 0 &&
            steps.length < generic.length &&
            steps.every((step, i) => step === generic[i]),
        );
        for (const partial of [false, true]) {
          // (the reference generic, or already spelling `entry` at its first element step a dictionary owns, as a
          // reference that read part of its key settled does)
          const first = chain.findIndex(
            ({ step, owner }) => step === "element" && (owner === "dict" || owner === "dicts"),
          );
          if (partial && first < 0) continue;
          const steps = generic.map((step, i) => (partial && i === first ? "entry" : step));
          const reference: LabelIdentity = { kind: "path", place: rootPlace, steps };
          const labelled: { identity: LabelIdentity; form: string; entries?: readonly number[] }[] =
            [];
          // (E: each subset of the chain's steps spelled `entry`, element steps or not)
          for (let mask = 1; mask < 1 << chain.length; mask += 1) {
            const entries = chain.flatMap((_, i) =>
              (mask >> i) & 1 || (partial && i === first) ? [i] : [],
            );
            labelled.push({
              identity: {
                kind: "path",
                place: rootPlace,
                steps: generic.map((step, i) => (entries.includes(i) ? "entry" : step)),
              },
              form: "E",
              entries,
            });
          }
          // (E2: the read's own text; beside it labels the compiler never makes of it: own text with a step below it,
          // a receiver's own text, the path through another derived list)
          labelled.push({ identity: { kind: "own", place, steps: [] }, form: "E2" });
          labelled.push({ identity: { kind: "own", place, steps: ["element"] }, form: "other" });
          for (const receiver of receivers)
            labelled.push({
              identity: { kind: "own", place: receiver.place, steps: [] },
              form: "other",
            });
          for (const [i, step] of generic.entries())
            if (DERIVED_STEPS.has(step))
              labelled.push({
                identity: {
                  kind: "path",
                  place: rootPlace,
                  steps: generic.map((each, j) =>
                    j === i ? (step === "values" ? "keys" : "values") : each,
                  ),
                },
                form: "other",
              });
          // (each label once, by its first form)
          const seen = new Set([JSON.stringify(reference)]);
          const u = check(`${root.path.join(".")}.${steps.join(".")}`, at);
          for (const label of labelled) {
            const text = JSON.stringify(label.identity);
            if (seen.has(text)) continue;
            seen.add(text);
            pairs += 1;
            const x = check(`label ${pairs}`, at);
            const accepted =
              provenRelabel(
                u,
                [x],
                [],
                answers.graph,
                withLabels(labels, [[u, reference]]),
                withLabels(labels, [[x, label.identity]]),
              ) !== undefined;
            if (accepted !== expected(chain, label))
              disagree.push(
                `${written} ${root.name}: ${u.target} -> ${text} (${label.form}): walk ${accepted}`,
              );
          }
        }
      }
    }
  assert.deepEqual(disagree, []);
  assert.ok(pairs > 1000, `${pairs} pairs`);
});

/**
 * A combined stop's label after a call's result is one of the compiler's two precise forms, never half of each (#1595,
 * #1687): its recipe made wholly after the stop, and an owner's kinds read by one route (`labelKey`), a call's result
 * through an index into it as well. A read through an index into a call's result, then a derived list
 * (`build()["a"].values[0]`), and a derived list's element, then an index (`build().values[0]["a"]`), four modes, each
 * stopping demand allowance up to 3, every settled stop: each check the stopped analysis owes under another label than
 * the demand-only reference's own check there (the same kind, whole site, boundary and expected types) is one of the
 * label grammar's two forms of it, proved by the program's written types (`provenRelabel` with no natural analysis):
 * never an `entry` path through a dictionary's derived list, nor own text with a path step below it.
 */
test("a combined stop's label after a call's result is one precise form, made wholly after the stop (#1595)", () => {
  const sources = [
    'function build: integer dict dict {return dict {a: dict {a: hostValue}}}\nsay "BEFORE"\nrepeat build()["a"].values[0] {say "ok"}\nsay "AFTER"\nexit\n',
    'function build: integer dict dict {return dict {a: dict {a: hostValue}}}\nsay "BEFORE"\nrepeat build().values[0]["a"] {say "ok"}\nsay "AFTER"\nexit\n',
  ];
  const problems: string[] = [];
  let relabelled = 0;
  for (const source of sources)
    for (const mode of HELD_MODES) {
      const c: HeldCase = { name: "a call's result", source, slice: true, values: [] };
      for (const demand of heldDemands(c, mode).filter((each) => each <= 3)) {
        const { reference, stoppedAt } = combinedAnalyses(
          [{ path: "main.tease", source }],
          mode,
          demand,
        );
        for (const { allowance } of heldStops(c, mode, 1, demand)) {
          const stopped = stoppedAt(allowance);
          if (!stopped.budget.settled) continue;
          const owed = [
            ...stopped.checks,
            ...stopped.budget.deferred.map((mark) => mark.obligation),
          ];
          for (const u of reference.checks)
            for (const x of owed) {
              if (
                x.target === u.target ||
                x.kind !== u.kind ||
                JSON.stringify(x.site) !== JSON.stringify(u.site) ||
                x.boundary !== u.boundary ||
                JSON.stringify(x.against) !== JSON.stringify(u.against)
              )
                continue;
              relabelled += 1;
              // (one of the grammar's two forms of `u`, proved by the program's written types alone)
              if (
                provenRelabel(
                  u,
                  [x],
                  [],
                  reference.graph,
                  labelIdentities(reference),
                  labelIdentities(stopped),
                ) === undefined
              )
                problems.push(`${mode.name} @${demand}/${allowance}: ${u.target} -> ${x.target}`);
            }
        }
      }
    }
  assert.deepEqual([...new Set(problems)], []);
  assert.ok(relabelled > 0);
});

/**
 * A stopped operand check stands for a lost null check only as the lead's ruling (A) on #1688 allows
 * (`standsForNullCheck`). `null-divisors@4`
 * (`tests/families/messages/nested-carriers-and-diagnostic-work/selection-store-and-object-index-diagnostic-work.mjs`,
 * k = 4) under demand allowance 32, both reversed modes, at the settled decision stop of `xs`'s element: the natural
 * analysis owes at each divisor "check that xs.element is not null before /" against `integer` and `number`; the
 * stopped run owes an operand check there instead, against the same two kinds at the first three divisors, and also
 * against `duration`, `calendarDuration` and `angle` at the last, where the chain on its left is unknown too. The first
 * three stand for their null checks, reported apart (`standing check`); the last is a weaker check and stays lost;
 * every operand check is still its own content, so the extras are unchanged. The predicate's clauses each refuse alone.
 */
test("a stopped operand check stands for a lost null check only at its site, excluding null, within its kinds (#1688)", () => {
  const source = `let xs = [4, null]\nsay 1${" / xs[1]".repeat(4)}\nexit\n`;
  const c: HeldCase = { name: "null-divisors@4", source, slice: true, values: [] };
  for (const mode of HELD_MODES.filter((each) => each.name.startsWith("reversed"))) {
    const stopped = heldRun(c, mode, undefined, 32);
    assert.ok(stopped.answers.budget.settled, mode.name);
    const problems = stopProblems({
      unstopped: heldRun(c, mode),
      stopped,
      fitting: [],
      violating: [],
    });
    const of = (prefix: string) =>
      problems.filter((problem) => problem.startsWith(`${prefix} check `));
    // (the check a problem names first: a lost check's, or the null check a standing one stands for)
    const site = (problem: string) => {
      const text = problem.replace(/^(lost|standing) check /, "").split(" by ")[0]!;
      const check: Obligation = JSON.parse(text);
      return `${check.kind} ${check.site.start}-${check.site.end}`;
    };
    assert.deepEqual(
      of("standing").map(site),
      ["null-check 27-32", "null-check 35-40", "null-check 43-48"],
      mode.name,
    );
    assert.deepEqual(of("lost").map(site), ["null-check 51-56"], mode.name);
    // (each standing copy names its operand check, which stays an extra)
    for (const problem of of("standing")) {
      const operand = problem.slice(problem.indexOf(" by ") + 4);
      assert.ok(problems.includes(`extra check ${operand}`), problem);
    }
  }
  const nullCheck: Obligation = {
    kind: "null-check",
    target: "xs.element",
    against: ["integer", "number"],
    on: "check that xs.element is not null before /",
    site: { file: 0, start: 27, end: 32 },
    boundary: false,
  };
  const operand: Obligation = {
    kind: "operand",
    target: "xs[1]",
    against: ["integer", "number"],
    on: "check the operand of / when it runs",
    site: nullCheck.site,
    boundary: false,
  };
  assert.equal(standsForNullCheck(operand, nullCheck), true);
  assert.equal(standsForNullCheck({ ...operand, against: ["integer"] }, nullCheck), true);
  const others: Obligation[] = [
    { ...operand, against: ["integer", "number", "null"] },
    { ...operand, against: ["integer", "number", "duration"] },
    { ...operand, site: { file: 0, start: 35, end: 40 } },
    { ...operand, site: { file: 1, start: 27, end: 32 } },
    { ...operand, boundary: true },
    { ...operand, kind: "null-check" },
  ];
  for (const other of others)
    assert.equal(standsForNullCheck(other, nullCheck), false, JSON.stringify(other));
  assert.equal(standsForNullCheck(operand, { ...nullCheck, kind: "integer-check" }), false);
  // (the ledger: a standing pair is accounted for, the other checks still compared in order; each operand check stands
  // for one lost copy: a divisor whose null check and operand check both publish, the null check left out of the
  // stopped side, its other checks reversed, or its null check published twice on the unstopped side)
  {
    const source = "let xs = [4, null, hostValue]\nsay 1 / xs[1]\nrepeat hostOther {}\nexit\n";
    const run = heldRun({ name: "divisor", source, slice: true, values: [] }, HELD_MODES[0]!);
    const checks = run.answers.checks;
    const lost = checks.find(
      (check) => check.kind === "null-check" && check.on.endsWith(" before /"),
    )!;
    assert.ok(checks.some((check) => standsForNullCheck(check, lost)));
    const publishing = (each: StopRun, list: readonly Obligation[]): StopRun => ({
      ...each,
      answers: Object.defineProperty(Object.create(each.answers), "checks", { value: list }),
    });
    const others = checks.filter((check) => check !== lost);
    assert.ok(others.length >= 2);
    const judged = (unstopped: StopRun, stopped: StopRun) =>
      stopProblems({ unstopped, stopped, fitting: [], violating: [] }).map((problem) =>
        problem.replace(/ \{.*$/, ""),
      );
    assert.deepEqual(judged(run, publishing(run, others)), ["standing check"]);
    assert.deepEqual(judged(run, publishing(run, [...others].reverse())), [
      "standing check",
      "checks order",
    ]);
    assert.deepEqual(judged(publishing(run, [...checks, lost]), publishing(run, others)), [
      "standing check",
      "lost check",
    ]);
  }
  // (the same on a divisor whose own text spans two lines: Codex r2 on #1725)
  {
    const source = "say 1 / [4,\n null, hostValue][1]\nexit\n";
    const run = heldRun({ name: "multiline", source, slice: true, values: [] }, HELD_MODES[0]!);
    const checks = run.answers.checks;
    const lost = checks.find(
      (check) => check.kind === "null-check" && check.on.endsWith(" before /"),
    )!;
    assert.ok(lost.target.includes("\n"), lost.target);
    const others = checks.filter((check) => check !== lost);
    const stopped: StopRun = {
      ...run,
      answers: Object.defineProperty(Object.create(run.answers), "checks", { value: others }),
    };
    assert.deepEqual(
      stopProblems({ unstopped: run, stopped, fitting: [], violating: [] }).map((problem) =>
        problem.replace(/ \{[\s\S]*$/, ""),
      ),
      ["standing check"],
    );
  }
  // (its whole site: another end; the operator consumer's own two checks for one operator, never a receiver's check at
  // the operand's span, another operator's, or a null check whose words name another value; a domain admitting null,
  // `unknown` too, or one a name cannot compare: Codex r1 on #1725)
  const unmatched: (readonly [Obligation, Obligation])[] = [
    [{ ...operand, site: { file: 0, start: 27, end: 33 } }, nullCheck],
    [
      operand,
      { ...nullCheck, on: "check that xs is a list or a dict with .index before the read" },
    ],
    [{ ...operand, on: "check the operand of * when it runs" }, nullCheck],
    [operand, { ...nullCheck, target: "xs" }],
    [operand, { ...nullCheck, on: "check that xs.element is not null before *" }],
    [
      { ...operand, against: ["unknown"] },
      { ...nullCheck, against: ["unknown"] },
    ],
    [operand, { ...nullCheck, against: ["non-null"] }],
  ];
  for (const [other, check] of unmatched)
    assert.equal(standsForNullCheck(other, check), false, JSON.stringify([other, check]));
  // (a target that is a value's own text over several lines, its words whole)
  const multiline = "[4,\n null][1]";
  assert.equal(
    standsForNullCheck(
      { ...operand, target: multiline },
      { ...nullCheck, target: multiline, on: `check that ${multiline} is not null before /` },
    ),
    true,
  );
  // (a domain holding null stands for nothing, even where the null check's own kinds would hold it: the clause alone)
  assert.equal(
    standsForNullCheck(
      { ...operand, against: ["integer", "null"] },
      { ...nullCheck, against: ["integer", "number", "null"] },
    ),
    false,
  );
});

/**
 * #1741: a for loop's iterable and a repeat count, the other two consumers whose stopped run owes, for the null the
 * natural analysis proved, the check of the kinds its use needs (`standsForNullCheck`, pairs 2 and 3). Under demand
 * allowance 8 in every held mode, each witness's lost null check is a standing check by that consumer's replacement, at
 * its whole site on the same target with the same domain: the iterable's operand check against list, set, dict and
 * range, the count's integer check; Sol's allowance sweep found them as 13 contents in 379 copies (20 iterables, 359
 * counts, two of them `f1-astra-b1-cases` `astra::duplicates/integer?/8` and `/"bad"`). Each clause refuses alone, a
 * domain wider than the null check's by one kind included, by the predicate and through the ledger.
 */
test("a stopped iterable or repeat-count check stands for a lost null check only on its target, site and kinds (#1741)", () => {
  const duplicates = (value: string) =>
    `let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:${value},nest:{n:${value},keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n`;
  const witnesses: readonly (readonly [string, string, string])[] = [
    // (a `null` a handler may store: its null-check a warning, never the route rule's error, AD-1 and X7)
    [
      "iterable",
      "let l = [1]\ntimer async 1 s { l = null }\nfor x in l { say x }\nexit\n",
      "operand l 50-51",
    ],
    [
      "count",
      "let n = 2\ntimer async 1 s { n = null }\nrepeat n {}\nexit\n",
      "integer-check n 46-47",
    ],
    ["duplicates/8", duplicates("8"), "integer-check out.element.element.n 182-193"],
    ['duplicates/"bad"', duplicates('"bad"'), "integer-check out.element.element.n 190-201"],
  ];
  const named = (text: string) => {
    const check: Obligation = JSON.parse(text);
    return `${check.kind} ${check.target} ${check.site.start}-${check.site.end}`;
  };
  for (const [name, source, replacement] of witnesses)
    for (const mode of HELD_MODES) {
      const c: HeldCase = { name, source, slice: true, values: [] };
      const problems = stopProblems({
        unstopped: heldRun(c, mode),
        stopped: heldRun(c, mode, undefined, 8),
        fitting: [],
        violating: [],
      });
      const at = `${name} ${mode.name}`;
      assert.deepEqual(
        problems.filter((p) => p.startsWith("lost check ")).map((p) => p.slice(11)),
        [],
        at,
      );
      const standing = problems.filter((p) => p.startsWith("standing check "));
      assert.equal(standing.length, 1, at);
      assert.equal(named(standing[0]!.slice(standing[0]!.indexOf(" by ") + 4)), replacement, at);
      // (the replacing check is still its own content)
      assert.ok(
        problems.includes(`extra check ${standing[0]!.slice(standing[0]!.indexOf(" by ") + 4)}`),
        at,
      );
    }
  const iterableNull: Obligation = {
    kind: "null-check",
    target: "l",
    against: ["list", "set", "dict", "range"],
    on: "check that l is not null at the iterable of for",
    site: { file: 0, start: 44, end: 45 },
    boundary: false,
  };
  const iterable: Obligation = {
    ...iterableNull,
    kind: "operand",
    on: "check the operand l at the iterable of for when it runs",
  };
  const countNull: Obligation = {
    kind: "null-check",
    target: "n",
    against: ["integer"],
    on: "check that the repeat count is not null when it runs",
    site: { file: 0, start: 40, end: 41 },
    boundary: false,
  };
  const count: Obligation = {
    ...countNull,
    kind: "integer-check",
    on: "check that the repeat count is a whole number when it runs",
  };
  assert.equal(standsForNullCheck(iterable, iterableNull), true);
  assert.equal(standsForNullCheck({ ...iterable, against: ["list"] }, iterableNull), true);
  assert.equal(standsForNullCheck(count, countNull), true);
  const refused: (readonly [Obligation, Obligation])[] = [
    // (another target, spelled in the check's words as well: the same words on another value)
    [
      { ...iterable, target: "m", on: "check the operand m at the iterable of for when it runs" },
      iterableNull,
    ],
    [{ ...count, target: "m" }, countNull],
    // (another site, file or boundary)
    [{ ...iterable, site: { file: 0, start: 44, end: 46 } }, iterableNull],
    [{ ...count, site: { file: 1, start: 40, end: 41 } }, countNull],
    [{ ...count, boundary: true }, countNull],
    // (another consumer's words on either side, or the pair's checks crossed)
    [{ ...iterable, on: "check the operand l at the index of for when it runs" }, iterableNull],
    [iterable, { ...iterableNull, on: "check that l is not null before the read" }],
    [{ ...count, on: "check that the index is a whole number when it runs" }, countNull],
    [count, { ...countNull, on: "check that the index is not null when it runs" }],
    [{ ...count, kind: "operand" }, countNull],
    [{ ...iterable, kind: "integer-check" }, iterableNull],
    // (a domain admitting null, or unknown)
    [{ ...iterable, against: ["list", "null"] }, iterableNull],
    [
      { ...count, against: ["unknown"] },
      { ...countNull, against: ["unknown"] },
    ],
    // (a domain wider than the null check's by one kind: a weaker check, never one in other words)
    [iterable, { ...iterableNull, against: ["list", "set", "dict"] }],
    [{ ...count, against: ["integer", "number"] }, countNull],
  ];
  for (const [check, nullCheck] of refused)
    assert.equal(standsForNullCheck(check, nullCheck), false, JSON.stringify([check, nullCheck]));
  // (through the ledger: the count's replacement one kind wider stays a lost check, its null check unaccounted for)
  const c: HeldCase = { name: "count", source: witnesses[1]![1], slice: true, values: [] };
  const mode = HELD_MODES[0]!;
  const stopped = heldRun(c, mode, undefined, 8);
  const wider = stopped.answers.checks.map((check) =>
    check.kind === "integer-check" && check.target === "n"
      ? { ...check, against: ["integer", "number"] }
      : check,
  );
  const problems = stopProblems({
    unstopped: heldRun(c, mode),
    stopped: {
      ...stopped,
      answers: Object.defineProperty(Object.create(stopped.answers), "checks", { value: wider }),
    },
    fitting: [],
    violating: [],
  });
  assert.deepEqual(
    problems
      .filter((p) => /^(lost|standing) check /.test(p))
      .map((p) => `${p.split(" ")[0]} ${named(p.slice(p.indexOf("{")).split(" by ")[0]!)}`),
    ["lost null-check n 46-47"],
  );
});

/**
 * #1757 (the lead's ruling on #1741's sweep): a pass can decide one place's path twice (`1310-astra-probe-stops.mjs`
 * `chain/hostValue`: the root of `box`, 38 units and then 1 in the natural pass). The stop oracle compares such records
 * by their occurrence, refusing a comparison only where the two runs decide the key a different number of times, and
 * lists each repetition as a problem line (`repeated decision at …`), never a failure; why the core repeats is #1757's.
 */
test("a decision a pass makes twice is compared by its occurrence and listed apart, never a failure (#1757)", () => {
  const c: HeldCase = {
    name: "chain/hostValue",
    source: `let box = {last: null}\nbox.last = {first: null}\nbox.last.first = {n: 1}\nsay "BEFORE"\nbox.last.first.n = hostValue\nsay "AFTER"\nexit\n`,
    slice: true,
    values: [],
  };
  const mode = HELD_MODES[0]!;
  const unstopped = heldRun(c, mode);
  for (const demand of [8, 16, 256]) {
    const run = { unstopped, stopped: heldRun(c, mode, undefined, demand) };
    // (judged, the repetition compared by occurrence: no refusal, no line of it among the problems)
    const problems = stopProblems({ ...run, fitting: [], violating: [] });
    assert.ok(!problems.some((p) => p.startsWith("repeated decision")), `${demand}`);
    // (listed apart: the natural pass's repetitions, then the stopped one's where its units differ)
    const lines = repeatedDecisions(run);
    assert.deepEqual(
      lines.slice(0, 2),
      [
        "repeated decision at [5,[]]: units 38, 1, 1",
        'repeated decision at [5,["last"]]: units 305, 2',
      ],
      `${demand}`,
    );
    for (const line of lines)
      assert.match(
        line,
        /^repeated decision at \[\d+,\[[^\]]*\]\]: units \d+(, \d+)+$/,
        `${demand}`,
      );
  }
});

/**
 * #1323 (Codex r6): a folded group's provenance reads are shared work, and a demand stop that leaves one
 * suspended closes it (`closeShared`): with the sharing on, the stops at these demands lose no check main keeps.
 */
test("a stop that abandons a group's provenance read loses no check, with the sharing on (#1323)", () => {
  const cases = [
    [
      "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({p:[{extra:1,noise:read({p:[{extra:1,noise:0},{f0:1.5}]})},{f0:1.5}]})\nexit\n",
      64,
    ],
    [
      "function read(x:object) { let alias=x.p\nalias.extra=1\nx.p.extra=hostValue\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      32,
    ],
  ] as const;
  for (const [source, demand] of cases)
    for (const mode of HELD_MODES.slice(0, 2)) {
      const held: HeldCase = { name: "abandoned-provenance", source, slice: false, values: [] };
      const problems = stopProblems({
        unstopped: heldRun(held, mode),
        stopped: heldRun(held, mode, undefined, demand),
        fitting: [],
        violating: [],
      });
      assert.deepEqual(
        problems.filter((problem) => problem.startsWith("lost")),
        [],
        `${mode.name} at ${demand}`,
      );
    }
});

/**
 * #1708, A′: after a stop, a method receiver's words may follow a proven type (the declaration to the
 * leaf, `xs: integer dict` → `integer`: `xs.entry has .clear()`) where the demand-only reference spells the method
 * table's kinds (`xs.element is a list, a set, or a dict with .clear()`), and the stopped record stands as the proven
 * kinds and the proof's route derive it. At every settled stop of the witness, at demands 1 and 3 in the four modes, the
 * stop oracle accepts the pair on both sides of the inventory, and some stop pairs them.
 */
test("a stopped receiver's words may follow the declaration to its leaf, the pair one check on both sides (#1708)", () => {
  const witness: HeldCase = {
    name: "receiver-words",
    source:
      'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"].clear()\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const natural = (mode: (typeof HELD_MODES)[number]): Answers =>
    mode.run(() =>
      analyseCore(
        coreRequest([{ path: "main.tease", source: witness.source }], ["hostValue", "hostOther"])!,
      ),
    );
  let paired = 0;
  for (const mode of HELD_MODES)
    for (const demand of [1, 3]) {
      const reference = heldRun(witness, mode, undefined, demand);
      for (const { allowance } of heldStops(witness, mode, 4, demand)) {
        assert.deepEqual(
          heldProblems(witness, mode, allowance, reference, demand),
          [],
          `${mode.name} ${demand} @${allowance}`,
        );
        const stopped = heldRun(witness, mode, allowance, demand).answers;
        paired += combinedStopRule(witness, mode, reference, stopped).reworded.pairs.size;
        assert.deepEqual(
          combinedMarkProblems(reference.answers, natural(mode), stopped),
          [],
          `${mode.name} ${demand} @${allowance}: the inventory`,
        );
      }
    }
  assert.ok(paired > 0, "no stop paired the receiver's words");
});

/**
 * Refusals (#1708): the witness's own pair, each condition broken in turn, is refused: (1) kinds the
 * declaration does not prove; (2) another `against`; (3) a record field the proven kinds do not imply (a `present` after
 * the stop, an extra fitting type, a context neither route explains, another rule field) or a sentence its kinds do not
 * select; and a variant missing from the table.
 */
test("a stopped receiver's words are refused where a condition of r4.363 breaks (#1708)", () => {
  const witness: HeldCase = {
    name: "receiver-words",
    source:
      'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"].clear()\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const mode = HELD_MODES[0]!;
  const reference = heldRun(witness, mode, undefined, 3).answers;
  const found = heldStops(witness, mode, 1, 3)
    .map(({ allowance }) => heldRun(witness, mode, allowance, 3).answers)
    .find((answers) =>
      answers.budget.deferred.some((mark) => mark.obligation.on.includes(" has .clear()")),
    );
  assert.ok(found !== undefined, "no stop of the witness spells the leaf's words");
  const stopped = found;
  const u = reference.checks.find((check) => check.on.includes(".clear()"))!;
  const mark = stopped.budget.deferred.find((each) =>
    each.obligation.on.includes(" has .clear()"),
  )!;
  const x = mark.obligation;
  const [from, to] = [labelIdentities(reference), labelIdentities(stopped)];
  const owed = (answers: Answers) => [
    ...answers.checks,
    ...answers.budget.deferred.map((m) => m.obligation),
  ];
  assert.equal(provenRewording(u, owed(stopped), reference, stopped, from, to, []), x);
  // (the stopped mark replaced by a changed copy: its check `changed`, its record `record`)
  const tampered = (record: Partial<typeof mark>, changed: Obligation = x): Answers => ({
    ...stopped,
    budget: {
      ...stopped.budget,
      deferred: stopped.budget.deferred.map((each) =>
        each === mark ? { ...mark, ...record, obligation: changed } : each,
      ),
    },
  });
  // (the changed check keeps the recorded label of the one it replaces, so only the condition under test can refuse it)
  const refused = (record: Partial<typeof mark>, why: string, changed: Obligation = x): void => {
    const answers = tampered(record, changed);
    const labels = to === null ? null : withLabels(to, [[changed, to.of(x)!]]);
    assert.equal(
      provenRewording(u, owed(answers), reference, answers, from, labels, []),
      undefined,
      why,
    );
  };
  refused({ kinds: ["number"] }, "(1) kinds the declaration does not prove");
  refused({}, "(2) another against", { ...x, against: ["integer"] });
  refused({ present: "unproved" }, "(3) a present the stop does not ask");
  refused({ fits: ["integer"] }, "(3) a fitting type the kinds do not have");
  refused(
    { provenance: { ...mark.provenance, context: "loop" } },
    "(3) a context neither route explains",
  );
  refused(
    { rule: mark.rule.rule === "member" ? { ...mark.rule, use: "read" } : mark.rule },
    "(3) another rule field",
  );
  refused({}, "(3) a sentence its kinds do not select", {
    ...x,
    on: `check that ${x.target} is a list, a set, or a dict with .clear() before the call`,
  });
  // (Codex r1's B3 on #1759: an unknown's words are the method table's own takers, never any)
  const banana = { ...u, on: `check that ${u.target} is a banana with .clear() before the call` };
  const swapped: Answers = {
    ...reference,
    checks: reference.checks.map((each) => (each === u ? banana : each)),
    diagnostics: reference.diagnostics.map((d) =>
      "obligation" in d && d.obligation === u ? { ...d, obligation: banana } : d,
    ),
  };
  assert.equal(
    provenRewording(
      banana,
      owed(stopped),
      swapped,
      stopped,
      from === null ? null : withLabels(from, [[banana, from.of(u)!]]),
      to,
      [],
    ),
    undefined,
    "(3) an unknown's words not the method table's",
  );
  // (Codex r1's B2 on #1759: a label the declaration does not make, an `entry` of a list, is refused)
  assert.equal(
    provenRewording(
      u,
      owed(stopped),
      reference,
      stopped,
      from,
      to === null ? null : withLabels(to, [[x, { ...to.of(x)!, steps: ["entry", "entry"] }]]),
      [],
    ),
    undefined,
    "(1) a label the declaration does not make",
  );
  assert.equal(SENTENCE_VARIANTS["member"], "memberChecks");
  assert.equal(Object.keys(SENTENCE_VARIANTS).length, 17);
});

/**
 * Refusal controls (#1708, Sol's): a stop that changes the check itself is no wording: an operand's
 * `against` narrowed beside the receiver (`xs["a"] + hostOther`) or a fallback's expected domain (`xs["a"] otherwise
 * hostOther`) is never paired, whatever its words.
 */
test("a stop that changes an operand's or a fallback's expected domain is never paired as words (#1708)", () => {
  for (const source of [
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nsay xs["a"] + hostOther\nsay "AFTER"\nexit\n',
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nsay xs["a"] otherwise hostOther\nsay "AFTER"\nexit\n',
  ]) {
    const c: HeldCase = { name: "refused", source, slice: true, values: [] };
    const mode = HELD_MODES[0]!;
    const reference = heldRun(c, mode, undefined, 3);
    let changed = 0;
    for (const { allowance } of heldStops(c, mode, 2, 3)) {
      const stopped = heldRun(c, mode, allowance, 3).answers;
      const owed = [...stopped.checks, ...stopped.budget.deferred.map((m) => m.obligation)];
      // (the reference's checks whose site and kind the stop keeps with another expected domain: a changed check)
      const narrowed = new Set(
        reference.answers.checks
          .filter((u) =>
            owed.some(
              (x) =>
                x.kind === u.kind &&
                JSON.stringify(x.site) === JSON.stringify(u.site) &&
                JSON.stringify(x.against) !== JSON.stringify(u.against),
            ),
          )
          .map((u) => JSON.stringify(u)),
      );
      changed += narrowed.size;
      const pairs = combinedStopRule(c, mode, reference, stopped).reworded.pairs;
      for (const u of narrowed) assert.ok(!pairs.has(u), `${source} @${allowance}: ${u}`);
    }
    assert.ok(changed > 0, `${source}: no stop changes an expected domain`);
  }
});

/**
 * The drift guard (#1708, the lead's ruling on its HEAD 0): the sentence table and the derived record follow
 * the consumers as they are. The obligation sites whose words read kinds (a consumer's call of a word maker from the
 * messages, codes and paths apart) are the table's kind-reading entries, today `memberChecks`'s alone; and the sites
 * that set a record's read-derived fields (`fits`, `besides`, `present`, `keeps`, `provenance`) are the ones the derived
 * record mirrors or reads. A new one fails until the table or `derivedRecord` takes it.
 */
test("the sentence table and the derived record name every site that words or derives a record from kinds (#1708)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const enclosing = (node: ts.Node): string => {
    for (let at = node.parent; at !== undefined; at = at.parent)
      if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined)
        return at.name.getText();
    return "(module)";
  };
  const READ_FIELDS = new Set(["fits", "besides", "present", "keeps", "provenance"]);
  // (one file's sites: its words read from kinds, and its read-derived record fields)
  const sitesOf = (file: string, text: string, words: Set<string>, fields: Set<string>): void => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    // (the word makers a file imports from the messages, by their own names however it binds them: named, renamed,
    // the module's namespace or its default; codes and paths are no kind's words)
    const NOT_WORDS = new Set(["codeOf", "pathPhrase"]);
    const named = new Map<string, string>();
    const spaces = new Set<string>();
    for (const statement of source.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        /\/messages(\/[\w-]+)?\.js$/.test(statement.moduleSpecifier.text) &&
        statement.importClause !== undefined &&
        !statement.importClause.isTypeOnly
      ) {
        const clause = statement.importClause;
        if (clause.name !== undefined) spaces.add(clause.name.text);
        if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings))
          spaces.add(clause.namedBindings.name.text);
        if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings))
          for (const each of clause.namedBindings.elements)
            if (!each.isTypeOnly) named.set(each.name.text, (each.propertyName ?? each.name).text);
      }
    const consumer = file.includes(join("core", "consumers"));
    const visit = (node: ts.Node): void => {
      if (consumer && ts.isCallExpression(node)) {
        const callee = node.expression;
        const word = ts.isIdentifier(callee)
          ? (named.get(callee.text) ?? (spaces.has(callee.text) ? "default" : undefined))
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              spaces.has(callee.expression.text)
            ? callee.name.text
            : undefined;
        if (word !== undefined && !NOT_WORDS.has(word))
          words.add(`${basename(file)}:${enclosing(node)}`);
      }
      // (a sentence that spells a kind itself: a template interpolating an item's tag)
      if (consumer && ts.isTemplateExpression(node)) {
        let reads = false;
        const look = (each: ts.Node): void => {
          if (ts.isPropertyAccessExpression(each) && each.name.text === "tag") reads = true;
          ts.forEachChild(each, look);
        };
        for (const span of node.templateSpans) look(span.expression);
        if (reads) words.add(`${basename(file)}:${enclosing(node)}`);
      }
      // (a read-derived field set in an object, by an identifier, a quoted or a shorthand key)
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        READ_FIELDS.has(node.name.text) &&
        ts.isObjectLiteralExpression(node.parent)
      )
        fields.add(`${basename(file)}:${enclosing(node)}:${node.name.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  const words = new Set<string>();
  const fields = new Set<string>();
  for (const file of files(join(process.cwd(), "src/type-inference/core")))
    sitesOf(file, readFileSync(file, "utf8"), words, fields);
  // (Codex r1's B5 on #1759: each way a new site could hide, written as a consumer would, is found)
  const consumerFile = join(process.cwd(), "src/type-inference/core/consumers/control.ts");
  const controls: readonly (readonly [string, string, "words" | "fields"])[] = [
    [
      "renamed",
      'import { described as codeOf } from "../messages.js";\nfunction a(k) { return `is ${codeOf(k)}`; }',
      "words",
    ],
    [
      "namespace",
      'import * as m from "../messages.js";\nfunction a(k) { return `is ${m.described(k)}`; }',
      "words",
    ],
    [
      "default",
      'import words from "../messages/words.js";\nfunction a(k) { return `is ${words(k)}`; }',
      "words",
    ],
    [
      "inline",
      'function a(items) { return `saw ${items.map((item) => item.tag).join(" or ")}`; }',
      "words",
    ],
    ["quoted", 'function a(d) { return { ...d, "fits": [] }; }', "fields"],
  ];
  for (const [name, text, kind] of controls) {
    const [found, set] = [new Set<string>(), new Set<string>()];
    sitesOf(consumerFile, text, found, set);
    assert.ok((kind === "words" ? found : set).size > 0, `the guard misses a ${name} site`);
  }
  const tabled = Object.values(SENTENCE_VARIANTS).filter((site) => site !== null);
  assert.deepEqual([...words].sort(), tabled.map((site) => `receivers.ts:${site}`).sort());
  assert.deepEqual([...fields].sort(), [
    // (a published warning's `besides`, which `derivedRecord` recomputes from the stopped answers)
    "answers.ts:withBesides:besides",
    // (a kept value's types, asked only where an analysis ran to its end, as `present`)
    "diagnostics.ts:withFacts:keeps",
    "diagnostics.ts:withFacts:present",
    // (the messages read them; a record carries what they read)
    "messages.ts:coreMessage:keeps",
    "messages.ts:coreMessage:present",
    // (the record's serialized form)
    "result.ts:coreRecord:provenance",
    // (a kept value's types, as `diagnostics.ts`'s: the store contracts')
    "store-contracts.ts:#answerTask:keeps",
    "store-contracts.ts:expected:keeps",
    "warnings.ts:memberWarningFix:present",
    // (the warning's own: `fits` by the kinds that fit, `besides` none, `provenance` by the item read)
    // (the route rule's error: the fix of the warning it stands in for, its `fits` and `provenance` as `warning`'s)
    "warnings.ts:required:fits",
    "warnings.ts:required:provenance",
    "warnings.ts:warning:besides",
    "warnings.ts:warning:fits",
    "warnings.ts:warning:provenance",
  ]);
});

/**
 * #1708, Codex r1's B2 and B3 on #1759: each member form's words follow the proven leaf as its consumer
 * makes them: an element store (`has an element store`), a property store (`has a store of .p`), and a list's element
 * receiver, whose `element` label the list's own declaration proves (never an `entry`). Every 8th settled stop, four
 * modes, demand 3: the stop oracle clean.
 */
test("a store's and a list receiver's words follow the proven leaf at every member form (#1708)", () => {
  for (const source of [
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"][0] = hostOther\nsay "AFTER"\nexit\n',
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"].p = hostOther\nsay "AFTER"\nexit\n',
    'let xs: integer[] = [hostValue]\nsay "BEFORE"\nxs[0].clear()\nsay "AFTER"\nexit\n',
  ]) {
    const c: HeldCase = { name: "member-forms", source, slice: true, values: [] };
    for (const mode of HELD_MODES) {
      const reference = heldRun(c, mode, undefined, 3);
      for (const { allowance } of heldStops(c, mode, 8, 3)) {
        assert.deepEqual(
          heldProblems(c, mode, allowance, reference, 3),
          [],
          `${source} ${mode.name} @${allowance}`,
        );
        const stopped = heldRun(c, mode, allowance, 3).answers;
        for (const [, x] of combinedStopRule(c, mode, reference, stopped).reworded.pairs)
          if (source.includes("integer[]")) assert.ok(!x.includes(".entry"), x);
      }
    }
  }
});

/**
 * #1708, Codex r1's B2 on #1759: a list's element proves no dictionary entry. At a stop where the list
 * receiver's words follow its leaf, the stopped check relabelled `xs.entry` (its record and recorded label with it) is
 * refused: the label's own proof and the leaf's `entry` step both fail.
 */
test("a list receiver's check relabelled as a dictionary's entry is refused (#1708)", () => {
  const c: HeldCase = {
    name: "list-entry",
    source: 'let xs: integer[] = [hostValue]\nsay "BEFORE"\nxs[0].clear()\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const mode = HELD_MODES[0]!;
  const reference = heldRun(c, mode, undefined, 3);
  const owed = (answers: Answers) => [
    ...answers.checks,
    ...answers.budget.deferred.map((m) => m.obligation),
  ];
  let tried = 0;
  for (const { allowance } of heldStops(c, mode, 1, 3)) {
    const stopped = heldRun(c, mode, allowance, 3).answers;
    const [from, to] = [labelIdentities(reference.answers), labelIdentities(stopped)];
    const pairs = combinedStopRule(c, mode, reference, stopped).reworded.pairs;
    const u = reference.answers.checks.find((each) => pairs.has(JSON.stringify(each)));
    const mark = stopped.budget.deferred.find(
      (each) => JSON.stringify(each.obligation) === pairs.get(JSON.stringify(u)),
    );
    if (u === undefined || mark === undefined || to === null) continue;
    tried += 1;
    const x = mark.obligation;
    const entry = { ...x, target: "xs.entry", on: x.on.split(x.target).join("xs.entry") };
    const answers: Answers = {
      ...stopped,
      budget: {
        ...stopped.budget,
        deferred: stopped.budget.deferred.map((each) =>
          each === mark ? { ...mark, obligation: entry } : each,
        ),
      },
    };
    const labels = withLabels(to, [[entry, { ...to.of(x)!, steps: ["entry"] }]]);
    assert.equal(
      provenRewording(u, owed(answers), reference.answers, answers, from, labels, []),
      undefined,
      `@${allowance}`,
    );
  }
  assert.ok(tried > 0, "no stop pairs the list receiver's words");
});
