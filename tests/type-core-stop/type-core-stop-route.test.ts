import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSourceWithBackend } from "../../src/compiler.js";
import type { Expression } from "../../src/ast.js";
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
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import type { FlowNode } from "../../src/type-inference/core/flow-graph.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import {
  heldDemands,
  heldRun,
  heldStops,
  HELD_MODES,
  testedStops,
  type HeldCase,
} from "../helpers/type-core-held-host.js";
import { sampled } from "../helpers/sweep.js";
import { stopIdentity } from "../helpers/type-core-oracles.js";
import { plannedContent } from "../helpers/type-core-route.js";
import { type StopRun } from "../helpers/type-core-stop-oracle.js";
import {
  OPTIONS,
  ALLOWANCE,
  inBothOrders,
  compiled,
  ran,
  UNDECIDED,
  analysisTotal,
  LOST_CHECK,
  DEFAULT_LOST,
} from "../helpers/type-core/type-core-stop-setup.js";

/*
 * The program stop through the candidate route, in its three layers (the owner's D4, option a′; the
 * runtime-check evidence rule of `docs/TESTING.md`): at a small test allowance the analysis stops, and the program still
 * compiles. The decision: a check that waits on the stop is moved to the runtime, with the reason its value gives (host
 * data its own, as unstopped; a value the stop leaves undecided `budget`), one warning says so, and a
 * literal's error found by the finishing path stands. The plan: the moved check stands at its site. The
 * execution: a value that fits reaches the next effect; one that does not stops at the check.
 */

/** (a): a typed parse's or load's default a stop left open declines (#1767, #1775's rule (R)). */
const OPEN_BY_STOP = "a typed parse's or load's default that a stop left open";

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
        // declines; a settled one that loses the `otherwise` fallback's requirement declines at it, #2183; every
        // published plan reads as unstopped)
        const unsettled = unsettledAt(source, stop, mode);
        let plan;
        try {
          ({ plan } = mode.run(() =>
            stop(() => compileSourceWithBackend(source, { globals: [] }, CORE_BACKEND)),
          ));
        } catch (error) {
          assert.ok(
            error instanceof CandidateOutsideSlice &&
              (unsettled
                ? error.what === UNDECIDED
                : error.what === LOST_CHECK ||
                  (source.includes("otherwise") && error.what === DEFAULT_LOST)),
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

test("a stop's unchecked region gives words for a fix's code in it, never code it would hide", () => {
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
