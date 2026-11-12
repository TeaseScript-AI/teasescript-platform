// External data on the candidate route: checked where it enters a written place (C1, C9, S6), before any later effect,
// and across a checkpoint.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { run } from "../../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../../src/runtime/events.js";
import { observeTime } from "../../../src/runtime/operations/observe-time.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import { createFreshRuntimeSnapshot } from "../../../src/runtime/snapshot/snapshot-construction.js";
import type { RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";
import { type SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { recordDifferences, recordOf } from "../../helpers/type-core-records.js";
import { WRITTEN_COPY_MATRIX } from "../../helpers/type-core/type-core-witnesses.js";
import {
  OPTIONS,
  candidate,
  insideSlice,
  sited,
  inBothOrders,
  inBothOrdersAs,
  runWith,
  assertRuns,
  typeChecks,
  typeText,
  checksOf,
} from "../../helpers/type-core/type-core-candidate-setup.js";

test("C1's copy check and C9's boundary check run where external data enters a written place", () => {
  // the shape of the set's `s4/choice-external/written` with a literal for the choice: the warning and the boundary
  // check at the external value inside the literal, one check on the store
  const source =
    'let picked: integer = [hostValue, 1][0]\nsay "picked"\nrepeat picked {\n  say "turn"\n}\nexit\n';
  const compiled = candidate(source);
  assert.deepEqual(sited(compiled), ["warning TSV041@23"]);
  assert.ok(compiled.plan !== null);
  assert.deepEqual(checksOf(compiled.plan), ["0:39 integer"]);
  // a value that passes runs on; one that does not stops at the store with the runtime's error
  assert.deepEqual(runWith(compiled.plan, 2), {
    status: "halted",
    says: ["picked", "turn", "turn"],
    failure: null,
  });
  assert.deepEqual(runWith(compiled.plan, "x"), {
    status: "failed",
    says: [],
    failure: "TSR058@22:39",
  });
  assertRuns(compiled.plan, source, ["picked", "turn", "turn"], [[1.5, "TSR058@22:39"]]);

  // the literal's element check against the written element type, `null` admitted
  const pool = candidate("let pool: integer?[] = [hostValue, null, 7]\nexit\n");
  assert.deepEqual(sited(pool), ["warning TSV041@24"]);
  assert.ok(pool.plan !== null);
  assert.deepEqual(checksOf(pool.plan), ["0:43 list<integer|null>"]);
  assertRuns(
    pool.plan,
    "pool",
    [],
    [
      [null, null],
      [3, null],
      ["x", "TSR058@23:43"],
    ],
  );

  // the root compile, on the production default, does not warn: the candidate is reached only by its entry
  assert.deepEqual(sited(compileSource(source, OPTIONS)), []);

  // in the core's record, one boundary check per ingress, where it lands: the whole value's place, not each place below
  // it (C9; these whole-collection shapes are outside the slice, the literal's element inside it)
  for (const [shape, ...boundaries] of [
    ["let pool: integer[] = hostValue\nexit\n", 'pool ["list"] @22'],
    ["let xs: integer[][] = [hostValue]\nexit\n", 'xs.element ["list"] @23'],
    ["let pool: integer?[] = [hostValue, null, 7]\nexit\n", 'pool.element ["integer","null"] @24'],
    // two ingresses in one literal brought by one store: one check for the store, at the first (C9: one per
    // ingress store)
    ["let n: integer[] = [hostValue, hostValue]\nexit\n", 'n.element ["integer"] @20'],
    // two stores, two checks
    [
      "let n: integer[] = [hostValue]\nn = [hostValue]\nexit\n",
      'n.element ["integer"] @20',
      'n.element ["integer"] @36',
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source: shape }]);
    assert.ok(request !== null);
    assert.deepEqual(
      compactAnalysis(request)
        .checks.filter((check) => check.boundary)
        .map((check) => `${check.target} ${JSON.stringify(check.against)} @${check.site.offset}`)
        .sort(),
      boundaries,
      shape,
    );
  }
});

test("admission's decided types and C9's boundary checks compile and run on the candidate route (S6)", () => {
  const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
    kind: "list",
    items,
  });
  for (const [source, diagnostics, checked, runs] of [
    // A2: a decided type checks a later store, the boundary of the host value against it (C9), C2 at the count
    [
      "let n = 1\nn = hostValue\nrepeat n {}\nexit\n",
      ["warning TSV041@14", "warning TSV011@31"],
      ["10:23 integer"],
      [
        [2, null],
        [1.5, "TSR058@14:23"],
        ["x", "TSR058@14:23"],
      ],
    ],
    // A6: a definite contribution that does not fit is an error at the store
    ['let n = 1\nn = "x"\nexit\n', ["error TSV041@14"], null, []],
    // A4 and A8: a copy of a written binding is decided by its type, a literal's element checked against it
    ['let a: integer[] = []\nlet b = a\nb = ["bad"]\nexit\n', ["error TSV041@37"], null, []],
    ["let b = 1\nlet a: integer = 2\nb = a\nexit\n", [], [], []],
    // C9: external data in an inferred collection, checked at its store against the elements' admitted type, at any
    // depth (review r1: the plan held an element check of no type)
    [
      'let xs = [1, hostValue]\nsay "after ingress"\nrepeat xs[0] {}\nexit\n',
      ["warning TSV011@51", "warning TSV041@13"],
      ["0:23 list<integer>"],
      [
        [2, null],
        ["bad", "TSR058@9:23"],
      ],
    ],
    [
      "let xs = [[1, hostValue]]\nrepeat xs[0][0] {}\nexit\n",
      ["warning TSV011@33", "warning TSV041@14"],
      ["0:25 list<list<integer>>"],
      [
        [2, null],
        ["bad", "TSR058@9:25"],
      ],
    ],
    // A4: a copy of a written integer stays an integer where a number is possible (review r3: its plan took
    // `number`), at its store's check and at a later store's boundary check
    [
      'let typed: integer = 1\nlet copy = typed\ncopy = [2, 2.5][1]\nsay "after store"\nexit\n',
      ["warning TSV041@47"],
      ["40:58 integer"],
      [[null, "TSR058@47:58"]],
    ],
    [
      'let typed: integer = 1\nlet copy = typed\ncopy = [2, 2.5][0]\ncopy = hostValue\nsay "after store"\nexit\n',
      ["warning TSV041@47", "warning TSV041@66"],
      ["40:58 integer", "59:75 integer"],
      [
        [2, null],
        [2.5, "TSR058@66:75"],
      ],
    ],
    // A4: a copy of a written list keeps its element type where no read asks for it (review r4: the store's check and
    // a whole host value's took `list<number>`)
    [
      'let typed: integer[] = [1]\nlet copy = typed\ncopy = [[1], [2.5]][1]\nsay "after store"\nexit\n',
      ["warning TSV041@51"],
      ["44:66 list<integer>"],
      [[null, "TSR058@51:66"]],
    ],
    [
      'let typed: integer[] = [1]\nlet copy = typed\ncopy = [[1], [2.5]][0]\ncopy = hostValue\nsay "after store"\nexit\n',
      ["warning TSV041@51", "warning TSV041@74", "warning TSV041@74"],
      ["44:66 list<integer>", "67:83 list<integer>"],
      [
        [list(1), null],
        [list(2.5), "TSR058@74:83"],
      ],
    ],
    // A2, A4, A8: the earliest element decides a literal's elements, a later copy of a written integer fitting a number
    // (review: Astra's B2, a false error), nested too
    [
      'let whole: integer = 1\nlet xs = [2.5, whole]\nxs = [3.5]\nsay "after"\nexit\n',
      [],
      [],
      [[null, null]],
    ],
    [
      'let whole: integer = 1\nlet xs = [[2.5, whole]]\nxs = [[3.5]]\nsay "after"\nexit\n',
      [],
      [],
      [[null, null]],
    ],
    // A8 (the owner's F2): a named list in a literal brings its elements' type, as a literal one does; whole numbers
    // with numbers
    ['let a = [1]\nlet b = ["bad"]\nlet xs = [a, b]\nexit\n', ["error TSV044@41"], null, []],
    ['let a = [1]\nlet b = ["bad"]\nlet xs = [[a], [b]]\nexit\n', ["error TSV044@43"], null, []],
    ['let a = [1]\nlet b = ["bad"]\nlet xs = a\nxs = b\nexit\n', ["error TSV041@44"], null, []],
    ['let a = [1]\nlet b = [2.5]\nlet xs = [a, b]\nsay "after"\nexit\n', [], [], [[2, null]]],
    // C9: external data stored whole into a written collection, checked there with its elements
    [
      "let pool: integer[] = hostValue\nexit\n",
      ["warning TSV041@22", "warning TSV041@22"],
      ["0:31 list<integer>"],
      [
        [list(1, 2), null],
        [list("x"), "TSR058@22:31"],
        ["x", "TSR058@22:31"],
      ],
    ],
    // C9: a host value a consumer reads directly is checked at the read, the runtime's own validation; C2 at the use
    [
      "repeat hostValue {}\nexit\n",
      ["warning TSV011@7"],
      [],
      [
        [2, null],
        [1.5, "TSR043@7:16"],
      ],
    ],
  ] as const) {
    const [{ plan }, compiled] = inBothOrdersAs(
      () => candidate(source),
      (result) => ({
        diagnostics: sited(result),
        checked: result.plan === null ? null : checksOf(result.plan),
      }),
    );
    assert.deepEqual(compiled.diagnostics.sort(), [...diagnostics].sort(), source);
    assert.deepEqual(compiled.checked, checked, source);
    if (runs.length > 0) {
      assert.ok(plan !== null, source);
      // (its programs say each message once, in order)
      const said = [...source.matchAll(/say "([^"]*)"/g)].map((match) => match[1]!);
      assertRuns(plan, source, said, runs);
    }
  }
});

test("external data a literal carries is warned and checked at its store before any later effect, read or not (the owner's F1)", () => {
  // per program C1's warning at the host expression, the store checks and, per host value, the run's messages and
  // failure: no consumer reads the list (the first and the third program are also sample cells, their decided list
  // element and decided nested list element inline, checked here with its fraction too)
  for (const [source, warnings, checked, runs] of [
    [
      'let xs = [1, hostValue]\nsay "AFTER"\nexit\n',
      ["warning TSV041@13"],
      ["0:23 list<integer>"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@9:23"],
        [2.5, [], "TSR058@9:23"],
      ],
    ],
    [
      'let xs = [hostValue, 1]\nsay "AFTER"\nexit\n',
      ["warning TSV041@10"],
      ["0:23 list<integer>"],
      [
        [2, ["AFTER"], null],
        [1.5, [], "TSR058@9:23"],
      ],
    ],
    [
      'let xs = [[1], [hostValue]]\nsay "AFTER"\nexit\n',
      ["warning TSV041@16"],
      ["0:27 list<list<integer>>"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@9:27"],
        [2.5, [], "TSR058@9:27"],
      ],
    ],
    [
      'let ys = [1, hostValue]\nlet xs = ys\nsay "AFTER"\nexit\n',
      ["warning TSV041@13"],
      ["0:23 list<integer>"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@9:23"],
      ],
    ],
    // named, the same (round 10 B1)
    [
      'let a = hostValue\nlet xs = [1, a]\nsay "AFTER"\nexit\n',
      ["warning TSV041@27"],
      ["18:33 list<integer>"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@27:33"],
      ],
    ],
    // host data alone admits no type: nothing to check it against
    ['let xs = [hostValue, hostValue]\nsay "AFTER"\nexit\n', [], [], [["bad", ["AFTER"], null]]],
  ] as const) {
    const [{ plan }, compiled] = inBothOrdersAs(
      () => candidate(source),
      (result) => ({
        diagnostics: sited(result),
        checked: result.plan === null ? null : checksOf(result.plan),
      }),
    );
    assert.deepEqual(compiled, { diagnostics: warnings, checked }, source);
    assert.ok(plan !== null, source);
    for (const [value, says, failure] of runs)
      assert.deepEqual(
        runWith(plan, value),
        { status: failure === null ? "halted" : "failed", says, failure },
        `${source} with ${JSON.stringify(value)}`,
      );
  }
});

test("C1 warns where some kind of the stored value fits and errs only where none does, in both orders", () => {
  // a list literal's element at an index: the items `integer` and `number`, both definite, one fitting; with a host value
  // the external item beside a `number`, and C9's boundary check at the host value. The context words: the
  // element read that gathers several elements gives `member`, the host value its reason's `unknown`
  for (const [source, warnings, contexts, boundary, passing, failing] of [
    [
      'let result: integer = [2, 2.5][0]\nsay "selected"\nexit\n',
      ["warning TSV041@22"],
      ["written-target@22 member"],
      null,
      null,
      null,
    ],
    [
      'let result: integer = [2.5, 2][1]\nsay "selected"\nexit\n',
      ["warning TSV041@22"],
      ["written-target@22 member"],
      null,
      null,
      null,
    ],
    [
      'let result: integer = [hostValue, 2.5][0]\nsay "selected"\nexit\n',
      ["warning TSV041@22", "warning TSV041@23"],
      ["written-target@22 member", "written-target@23 unknown"],
      'result ["integer"] @23',
      3,
      1.5,
    ],
    [
      'let result: integer = [2.5, hostValue][1]\nsay "selected"\nexit\n',
      ["warning TSV041@22", "warning TSV041@28"],
      ["written-target@22 member", "written-target@28 unknown"],
      'result ["integer"] @28',
      3,
      "x",
    ],
  ] as const) {
    const compiled = inBothOrders(() => {
      const result = candidate(source);
      return { sited: sited(result), plan: result.plan };
    });
    assert.deepEqual(compiled.sited, warnings, source);
    assert.ok(compiled.plan !== null, source);
    // the destination's check on the store, which the selected value passes or fails at runtime
    const end = source.indexOf("\n");
    assert.deepEqual(checksOf(compiled.plan), [`0:${end} integer`], source);
    if (passing === null)
      assert.deepEqual(runWith(compiled.plan, null), {
        status: "halted",
        says: ["selected"],
        failure: null,
      });
    else {
      assert.deepEqual(
        runWith(compiled.plan, passing),
        { status: "halted", says: ["selected"], failure: null },
        source,
      );
      assert.deepEqual(
        runWith(compiled.plan, failing),
        { status: "failed", says: [], failure: `TSR058@22:${end}` },
        source,
      );
    }
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const record = inBothOrders(() => compactAnalysis(request));
    assert.deepEqual(
      record.diagnostics
        .map((diagnostic) => `${diagnostic.kind}@${diagnostic.site.offset} ${diagnostic.context}`)
        .sort(),
      contexts,
      source,
    );
    assert.deepEqual(
      record.checks
        .filter((check) => check.boundary)
        .map((check) => `${check.target} ${JSON.stringify(check.against)} @${check.site.offset}`),
      boundary === null ? [] : [boundary],
      source,
    );
  }
  // the selected value that does not fit stops at the store
  const fractional = candidate('let result: integer = [2, 2.5][1]\nsay "selected"\nexit\n');
  assert.ok(fractional.plan !== null);
  assert.deepEqual(checksOf(fractional.plan), ["0:33 integer"]);
  assertRuns(fractional.plan, "the fractional element", ["selected"], [[null, "TSR058@22:33"]]);
  // no kind fits: still the error, also for a literal's element written as `integer[]` (A8)
  for (const [source, error] of [
    ["let result: integer = [2.5, 3.5][0]\nexit\n", "error TSV041@22"],
    ["let result: integer = 2.5\nexit\n", "error TSV041@22"],
    ["let xs: integer[] = [2, 2.5]\nexit\n", "error TSV041@24"],
  ] as const) {
    const compiled = inBothOrders(() => {
      const result = candidate(source);
      return { sited: sited(result), plan: result.plan === null };
    });
    assert.deepEqual(compiled, { sited: [error], plan: true }, source);
  }
});

/**
 * A checked store followed by an effect inside a branch (S6-CARRIERS, Astra r5 D3): the declaration owes exactly
 * its C1 and its boundary, the plan checks it against `integer` before the branch, the fitting host value says AFTER
 * and halts, and each bad one fails at the declaration's value before the branch's effect, nothing said.
 */
test("a checked store's check runs before an effect inside a later branch (S6-CARRIERS)", () => {
  const source = 'let n: integer = hostValue\nif true {\n  say "AFTER"\n}\nexit\n';
  const record = inBothOrders(() =>
    compactAnalysis(coreRequest([{ path: "main.tease", source }])!),
  );
  assert.deepEqual(
    recordDifferences(
      recordOf(`outcome warning-runtime-check
        D written-target warning 17:26 unknown
        C copy-type n [integer] 17:26
        B copy-type n [integer] 17:26`),
      record,
    ),
    [],
  );
  const plan = inBothOrders(() => candidate(source).plan);
  assert.ok(plan !== null);
  assert.deepEqual(checksOf(plan), ["0:26 integer"]);
  assert.deepEqual(runWith(plan, 2), { status: "halted", says: ["AFTER"], failure: null });
  for (const bad of [2.5, "bad"])
    assert.deepEqual(
      runWith(plan, bad),
      { status: "failed", says: [], failure: "TSR058@17:26" },
      JSON.stringify(bad),
    );
});

/**
 * External round 7 B1 (the lead's ruling; A4, F17b; ADR 0021 1.3): a place a written type decides, itself or through
 * a copy taken before or after the host store, admits the written domain at every collection level, `null` included,
 * whatever kinds are stored; inferred places stay as their contributions decide. Over `WRITTEN_COPY_MATRIX`, in both
 * orders and with the sharing on and off: the place's admitted domain at each level and C9's `against` at each of its
 * targets (decision), the one checked store with the whole written type (plan), a fitting value and a written `null`
 * saying DONE, a misfit (a fraction or text for an integer, a `null` none is written for) stopping at TSR058 at the
 * store's value with nothing said (execution).
 */
test("a copy of a written collection admits its written domain at every level, null included (external r7 B1)", (t) => {
  const wrong: string[] = [];
  const sorted = (kinds: readonly string[]): string[] => [...kinds].sort();
  for (const c of WRITTEN_COPY_MATRIX) {
    const request = coreRequest([{ path: "main.tease", source: c.source }]);
    assert.ok(request !== null, c.name);
    const place = new CoreProgram(request).places.find(
      ({ kind }) => kind.kind === "binding" && kind.name === c.place,
    )!;
    const levelOf = (target: string): number =>
      target.split(".").filter((step) => step === "element").length;
    const expected = {
      levels: c.levels.map(sorted),
      checks: [`${c.store} ${c.checked}`],
      runs: [
        ...c.fits.map(() => ({ status: "halted", failure: null, says: ["DONE"] })),
        ...c.misfits.map(() => ({ status: "failed", failure: `TSR058@${c.value}`, says: [] })),
      ],
    };
    const observe = () => {
      const answers = analyseCore(request);
      const plan = candidate(c.source).plan!;
      return {
        levels: c.levels.map((_, level) => {
          const admitted = answers.place(place.id, Array<string>(level).fill("element")).admitted;
          return admitted.by === "undecided" ? ["undecided"] : sorted(admitted.kinds);
        }),
        against: answers.checks
          .filter((check) => check.boundary && check.target.split(".")[0] === c.place)
          .map((check) => ({ target: check.target, kinds: sorted(check.against) })),
        checks: checksOf(plan),
        runs: [...c.fits, ...c.misfits].map((value) => runWith(plan, value)),
      };
    };
    for (const shared of [true, false]) {
      const { against, ...observed } = inBothOrders(() =>
        shared ? observe() : withoutSharing(observe),
      );
      const name = `${c.name}${shared ? "" : " (no sharing)"}`;
      if (JSON.stringify(observed) !== JSON.stringify(expected))
        wrong.push(`${name}: ${JSON.stringify(observed)}`);
      for (const { target, kinds } of against)
        if (JSON.stringify(kinds) !== JSON.stringify(sorted(c.levels[levelOf(target)]!)))
          wrong.push(`${name}: C9 at ${target} against ${JSON.stringify(kinds)}`);
    }
  }
  t.diagnostic(
    `${WRITTEN_COPY_MATRIX.length} sources, each in both orders with the sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

/**
 * AD-3 (X1 drops flow facts, never a written type): host data stored into a written place in dead code (a
 * function nothing calls, after `exit`, a branch on `false`) is checked against the written domain, as in live code,
 * never against `unknown`. Per place and dead shape, the dead program and its live form (the function called; the
 * statements live), in both orders: the admitted domain at each collection level, the one boundary against the written
 * element kind at the host read, and, where the candidate route takes the program, the one checked store, the host
 * value's, with the whole written type.
 */
test("a dead store of host data into a written place is checked against its written domain, as live (AD-3)", (t) => {
  const sorted = (kinds: readonly string[]): string[] => [...kinds].sort();
  // per place: its name, the statements, its written kinds per level, and the store bringing the host value with the
  // whole type the plan checks there
  const places: readonly (readonly [
    what: string,
    name: string,
    body: string,
    levels: readonly (readonly string[])[],
    store: string,
    checked: string,
  ])[] = [
    [
      "a written scalar",
      "out",
      "let out: integer = 1\nout = hostValue",
      [["integer"]],
      "out = hostValue",
      "integer",
    ],
    [
      "a written list",
      "out",
      "let out: integer[] = [1]\nout = [hostValue]",
      [["list"], ["integer"]],
      "out = [hostValue]",
      "list<integer>",
    ],
    [
      "a written list of lists",
      "out",
      "let out: integer[][] = [[1]]\nout = [[hostValue]]",
      [["list"], ["list"], ["integer"]],
      "out = [[hostValue]]",
      "list<list<integer>>",
    ],
    [
      "a copy of a written list",
      "copy",
      "let typed: integer[] = [1]\nlet copy = typed\ncopy = [hostValue]",
      [["list"], ["integer"]],
      "copy = [hostValue]",
      "list<integer>",
    ],
  ];
  const indented = (body: string): string =>
    body
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  // per dead shape: the program with `body` dead, its live form, and whether the candidate route takes them (a function
  // is outside its slice)
  const shapes: readonly (readonly [
    string,
    (body: string) => string,
    (body: string) => string,
    boolean,
  ])[] = [
    [
      "a function nothing calls",
      (body) => `function use(x) {\n${indented(body)}\n}\nexit\n`,
      (body) => `function use(x) {\n${indented(body)}\n}\nuse(1)\nexit\n`,
      false,
    ],
    ["after exit", (body) => `exit\n${body}\n`, (body) => `${body}\nexit\n`, true],
    [
      "a branch on a literal false",
      (body) => `if false {\n${indented(body)}\n}\nexit\n`,
      (body) => `${body}\nexit\n`,
      true,
    ],
  ];
  const observe = (source: string, name: string, levels: number) => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const place = new CoreProgram(request).places.find(
      ({ kind }) => kind.kind === "binding" && kind.name === name,
    )!;
    const text = (start: number, end: number): string => `'${source.slice(start, end)}'`;
    return inBothOrders(() => {
      const answers = analyseCore(request);
      const plan = insideSlice(() => candidate(source))?.plan ?? null;
      return {
        levels: Array.from({ length: levels }, (_, level) => {
          const admitted = answers.place(place.id, Array<string>(level).fill("element")).admitted;
          return admitted.by === "undecided" ? ["undecided"] : sorted(admitted.kinds);
        }),
        boundaries: answers.checks
          .filter((check) => check.boundary)
          .map(
            (check) =>
              `${check.target} [${sorted(check.against).join(", ")}] ${text(check.site.start, check.site.end)}`,
          )
          .sort(),
        plan:
          plan === null
            ? null
            : typeChecks(plan).map(({ so, eo, type }) => `${text(so, eo)} ${typeText(type)}`),
      };
    });
  };
  const wrong: string[] = [];
  let plans = 0;
  for (const [what, name, body, levels, store, checked] of places)
    for (const [where, dead, live, planned] of shapes) {
      const element = levels.at(-1)!;
      const expected = {
        levels: levels.map(sorted),
        boundaries: [
          `${[name, ...Array<string>(levels.length - 1).fill("element")].join(".")} [${sorted(element).join(", ")}] 'hostValue'`,
        ],
        plan: planned ? [`'${store}' ${checked}`] : null,
      };
      if (planned) plans += 2;
      for (const [form, source] of [
        ["dead", dead(body)],
        ["live", live(body)],
      ] as const) {
        const found = observe(source, name, levels.length);
        if (JSON.stringify(found) !== JSON.stringify(expected))
          wrong.push(`${what}, ${where}, ${form}: ${JSON.stringify(found)}`);
      }
    }
  t.diagnostic(
    `${places.length * shapes.length * 2} programs, ${plans} planned on the candidate route`,
  );
  assert.deepEqual(wrong, []);
});

/**
 * The owner's rule over a sample of the cells the candidate route reaches: host data, its slice's ingress,
 * inline and named, into a written, a decided and a published place, at a scalar and at a collection endpoint. Each
 * program compiles alike in both orders and checks exactly the store that brings the data, against the whole type its
 * place holds there (the host value's kind at the value's position: an element's, a nested element's). A fitting host
 * value says AFTER and halts; each bad one fails at that store's value with TSR058, nothing said.
 */
test("a sample of the slice's cells checks host data in the plan and stops a bad value before the next effect", () => {
  const sample: readonly (readonly [
    name: string,
    body: string,
    store: string,
    type: string,
    good: SerializableRuntimeValue,
    bad: readonly SerializableRuntimeValue[],
  ])[] = [
    ["written scalar, inline", "let n: integer = hostValue", "", "integer", 2, ["bad", 2.5]],
    [
      "written scalar, named",
      "let raw = hostValue\nlet n: integer = raw",
      "let n",
      "integer",
      2,
      ["bad", 2.5],
    ],
    [
      "written list element, inline",
      "let xs: integer[] = [hostValue]",
      "",
      "list<integer>",
      2,
      ["bad", 2.5],
    ],
    [
      "written list element, named",
      "let raw = hostValue\nlet xs: integer[] = [raw]",
      "let xs",
      "list<integer>",
      2,
      [2.5],
    ],
    [
      "decided list element, named",
      "let raw = hostValue\nlet xs = [1, raw]",
      "let xs",
      "list<integer>",
      2,
      ["bad", 2.5],
    ],
    // (the decided list element and the decided nested list element, inline, are the owner's F1 test's first and third
    // programs, checked there with these values)
    ["decided scalar, a later store", "let n = hostValue\nn = 1", "", "integer", 2, ["bad", 2.5]],
    ["published scalar, inline", "let n = [1, hostValue][1]", "", "integer", 2, ["bad", 2.5]],
    [
      "published scalar, named",
      "let raw = hostValue\nlet n = [1, raw][1]",
      "let n",
      "integer",
      2,
      ["bad", 2.5],
    ],
    [
      "published text, named",
      'let raw = hostValue\nlet n = ["a", raw][1]',
      "let n",
      "string",
      "b",
      [1],
    ],
    [
      "published truth value, named",
      "let raw = hostValue\nlet n = [true, raw][1]",
      "let n",
      "boolean",
      false,
      ["bad"],
    ],
  ];
  for (const [name, body, store, type, good, bad] of sample) {
    const source = `${body}\nsay "AFTER"\nexit\n`;
    // (the checked store: the line that starts with `store`, its value after the `=`)
    const start = source.indexOf(store);
    const end = source.indexOf("\n", start);
    const value = source.indexOf("=", start) + 2;
    const [result, checks] = inBothOrdersAs(
      () => candidate(source),
      (compiled) => (compiled.plan === null ? null : checksOf(compiled.plan)),
    );
    assert.deepEqual(checks, [`${start}:${end} ${type}`], name);
    const plan = result.plan!;
    assert.deepEqual(
      runWith(plan, good),
      { status: "halted", says: ["AFTER"], failure: null },
      `${name} with ${JSON.stringify(good)}`,
    );
    for (const refused of bad)
      assert.deepEqual(
        runWith(plan, refused),
        { status: "failed", says: [], failure: `TSR058@${value}:${end}` },
        `${name} with ${JSON.stringify(refused)}`,
      );
  }
});

/** Runs a plan to its end, observing each reading pause's deadline: the events and the final snapshot. */
function finish(
  plan: InstructionPlan,
  start: RuntimeSnapshot,
): { readonly events: readonly InterpreterEvent[]; readonly snapshot: RuntimeSnapshot } {
  const events: InterpreterEvent[] = [];
  let snapshot = start;
  for (let rounds = 0; rounds < 100; rounds += 1) {
    const gate = snapshot.foregroundAction;
    if (snapshot.status === "waiting" && gate?.kind === "chatPacingGate") {
      const settled = observeTime(plan, snapshot, gate.deadlineMs);
      events.push(...settled.events);
      snapshot = settled.snapshot;
    }
    if (snapshot.status === "halted" || snapshot.status === "failed") return { events, snapshot };
    const result = run(plan, snapshot);
    events.push(...result.events);
    snapshot = result.snapshot;
  }
  assert.fail("the run did not end");
}

test("a checkpoint after a passed check resumes with the same state, and the later check still runs", () => {
  const source =
    'let count: integer = hostValue\nsay "checked"\nrepeat count {\n  say "turn"\n}\nexit\n';
  const compiled = candidate(source);
  assert.ok(compiled.plan !== null);
  const plan = compiled.plan;
  assert.deepEqual(checksOf(plan), ["0:30 integer"]);
  // (the repeat's own count check, the runtime's: TSR043 at the count, nothing said after it)
  const count = source.indexOf("count {");
  for (const [hostValue, ending] of [
    [2, "halted"],
    [-1, "failed"],
  ] as const) {
    // the store's check has passed when the session waits at the reading pause after it
    const waiting = run(plan, createFreshRuntimeSnapshot(plan, { globals: { hostValue } }));
    assert.equal(waiting.snapshot.status, "waiting");
    assert.deepEqual(
      waiting.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      ["checked"],
    );
    const direct = finish(plan, waiting.snapshot);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, waiting.snapshot)),
    );
    const resumed = finish(restored.plan, restored.snapshot);
    assert.deepEqual(resumed.events, direct.events, String(hostValue));
    assert.deepEqual(resumed.snapshot, direct.snapshot, String(hostValue));
    assert.equal(resumed.snapshot.status, ending);
    assert.deepEqual(
      resumed.events.flatMap((event) =>
        event.kind === "say"
          ? [event.text]
          : event.kind === "runtimeFailure"
            ? [`${event.code}@${event.span.start.offset}:${event.span.end.offset}`]
            : [],
      ),
      ending === "failed" ? [`TSR043@${count}:${count + "count".length}`] : ["turn", "turn"],
      String(hostValue),
    );
  }
});
