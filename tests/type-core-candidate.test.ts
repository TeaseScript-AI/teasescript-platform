import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  compileProject,
  compileProjectWithBackend,
  compileSource,
  compileSourceWithBackend,
  type CompilationResult,
} from "../src/compiler.js";
import { REPEAT_COUNT_RULE } from "../src/loop-rules.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-construction.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import type { TypeAnalysisRequest, TypeCheckResult } from "../src/type-inference/backend.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { nodeOf, SliceIndex } from "../src/type-inference/core/consumer.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { analyzeTypes } from "../src/type-inference/index.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture } from "./helpers/type-core-fixture.js";

// The coarse core on the test-only candidate route (the port plan's S5): source, candidate compile, plan, runtime.

const OPTIONS = { globals: ["hostValue"] };

function candidate(source: string): CompilationResult {
  return compileSourceWithBackend(source, OPTIONS, CORE_BACKEND);
}

/** The result of `compile`, or `null` for a program outside the candidate's slice. */
function insideSlice<T>(compile: () => T): T | null {
  try {
    return compile();
  } catch (error) {
    if (error instanceof CandidateOutsideSlice) return null;
    throw error;
  }
}

/** The diagnostics as these tests compare them: severity, code and start offset. */
function sited(result: Pick<CompilationResult, "diagnostics">): string[] {
  return result.diagnostics.map(
    (diagnostic) => `${diagnostic.severity} ${diagnostic.code}@${diagnostic.span.start.offset}`,
  );
}

/** `run` in the source order and with the consumers' and the solver's orders reversed: the two results, equal. */
function inBothOrders<T>(run: () => T): T {
  const forward = run();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), run),
  );
  assert.deepEqual(reversed, forward);
  return forward;
}

/** A run of `plan` to its end without reading pauses, with `hostValue`: its status, messages and failure. */
function runWith(plan: InstructionPlan, hostValue: SerializableRuntimeValue) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    status: result.snapshot.status,
    says: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  };
}

/** The spans of the instructions that check the value they store (`typeCheck`), as `start:end`. */
function checkedStores(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.typeCheck !== undefined
      ? [`${instruction.span.so}:${instruction.span.eo}`]
      : [],
  );
}

test("every record of the set inside the slice compiles on the candidate route as the record expects", () => {
  const kinds: Readonly<Record<string, string>> = {
    TSV041: "written-target",
    TSV011: "integer-use",
    TSV043: "integer-use",
  };
  const accepted: string[] = [];
  for (const record of readFixture()) {
    const result = insideSlice(() =>
      compileProjectWithBackend(record.files, OPTIONS, CORE_BACKEND),
    );
    if (result === null) continue;
    accepted.push(record.name);
    // C1 (`written-target`) under TSV041 and C2 (`integer-use`) under TSV011 for a count and TSV043 for a list index,
    // each an error or a runtime-checked warning (D3 (a)), at the record's sites
    assert.deepEqual(
      result.diagnostics
        .filter((diagnostic) => kinds[diagnostic.code] !== undefined)
        .map(
          (diagnostic) =>
            `${diagnostic.severity} ${kinds[diagnostic.code]} ${diagnostic.path}@${diagnostic.span.start.offset}`,
        )
        .sort(),
      record.expected.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.class === "compile-error" ? "error" : "warning"} ${diagnostic.kind} ` +
            `${diagnostic.site.file}@${diagnostic.site.offset}`,
        )
        .sort(),
      record.name,
    );
    assert.equal(result.plan === null, record.expected.outcome === "compile-error", record.name);
    if (result.plan === null) continue;
    // C1's and C9's checks run where the store that holds their site stores its value (S3 §4); C2's need no plan content,
    // nor a boundary check against `unknown`, the runtime's validation of representable external data for every plan
    assert.equal(record.files.length, 1, record.name);
    const stores = result.plan.instructions.filter(
      (instruction) => instruction.kind === "declareBinding" || instruction.kind === "assign",
    );
    const owed = new Set(
      record.expected.checks
        .filter(
          (check) =>
            check.kind === "copy-type" &&
            !(check.against.length === 1 && check.against[0] === "unknown"),
        )
        .map((check) => {
          const store = stores
            .filter(({ span }) => span.so <= check.site.offset && check.site.offset < span.eo)
            .sort((a, b) => a.span.eo - a.span.so - (b.span.eo - b.span.so))[0];
          assert.ok(store !== undefined, `${record.name}: a store holds the check`);
          return `${store.span.so}:${store.span.eo}`;
        }),
    );
    assert.deepEqual(checkedStores(result.plan).sort(), [...owed].sort(), record.name);
  }
  // a record of the set for each cell of the slice (the pull request lists every record inside it)
  for (const name of [
    "cp9-cells/F1/let",
    "cp9-cells/F2/written-pass",
    "cp9-cells/F2/written-fail",
    "cp9-cells/F3/whole",
    "cp9-cells/F12/0",
    "cp9-cells/X1/dead",
    "cp9-cells/X5/outside-definition",
    "cp9-cells/C1/fail",
    "cp9-cells/C2/fail",
    "cp9-cells/A1/fail",
    "cp9-cells/A3/numeric-family",
    "cp9-cells/P7/repeat-zero",
    "cp9-cells/review/list-position-absent",
    "cp9-cells/r7-bugs/m2/host-local",
    "cp9-cells/r8/written-list/mixed",
  ])
    assert.ok(accepted.includes(name), `${name} inside the slice`);
});

test("C1's copy check and C9's boundary check run where external data enters a written place", () => {
  // the shape of the set's `s4/choice-external/written` with a literal for the choice: the warning and the boundary
  // check at the external value inside the literal, one check on the store
  const source =
    'let picked: integer = [hostValue, 1][0]\nsay "picked"\nrepeat picked {\n  say "turn"\n}\nexit\n';
  const compiled = candidate(source);
  assert.deepEqual(sited(compiled), ["warning TSV041@23"]);
  assert.ok(compiled.plan !== null);
  assert.deepEqual(checkedStores(compiled.plan), ["0:39"]);
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
  assert.equal(runWith(compiled.plan, 1.5).failure, "TSR058@22:39");

  // the literal analogue of r4.29: the element's check against the written element type, `null` admitted
  const pool = candidate("let pool: integer?[] = [hostValue, null, 7]\nexit\n");
  assert.deepEqual(sited(pool), ["warning TSV041@24"]);
  assert.ok(pool.plan !== null);
  assert.equal(runWith(pool.plan, null).status, "halted");
  assert.equal(runWith(pool.plan, 3).status, "halted");
  assert.equal(runWith(pool.plan, "x").failure, "TSR058@23:43");

  // the root compile, on the production default, does not warn: the candidate is reached only by its entry
  assert.deepEqual(sited(compileSource(source, OPTIONS)), []);

  // in the core's record, one boundary check per ingress, where it lands: the whole value's place, not each place below
  // it (TABLE §4 C9; these whole-collection shapes are outside the slice, the literal's element inside it)
  for (const [shape, ...boundaries] of [
    ["let pool: integer[] = hostValue\nexit\n", 'pool ["list"] @22'],
    ["let xs: integer[][] = [hostValue]\nexit\n", 'xs.element ["list"] @23'],
    ["let pool: integer?[] = [hostValue, null, 7]\nexit\n", 'pool.element ["integer","null"] @24'],
    // two ingresses in one literal brought by one store: one check for the store, at the first (TABLE §4 C9: one per
    // ingress store; r4.35)
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
      ["10:23"],
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
      ["0:23"],
      [
        [2, null],
        ["bad", "TSR058@9:23"],
      ],
    ],
    [
      "let xs = [[1, hostValue]]\nrepeat xs[0][0] {}\nexit\n",
      ["warning TSV011@33", "warning TSV041@14"],
      ["0:25"],
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
      ["40:58"],
      [[null, "TSR058@47:58"]],
    ],
    [
      'let typed: integer = 1\nlet copy = typed\ncopy = [2, 2.5][0]\ncopy = hostValue\nsay "after store"\nexit\n',
      ["warning TSV041@47", "warning TSV041@66"],
      ["40:58", "59:75"],
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
      ["44:66"],
      [[null, "TSR058@51:66"]],
    ],
    [
      'let typed: integer[] = [1]\nlet copy = typed\ncopy = [[1], [2.5]][0]\ncopy = hostValue\nsay "after store"\nexit\n',
      ["warning TSV041@51", "warning TSV041@74", "warning TSV041@74"],
      ["44:66", "67:83"],
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
    ['let a = [1]\nlet b = ["bad"]\nlet xs = [a, b]\nexit\n', ["error TSV041@41"], null, []],
    ['let a = [1]\nlet b = ["bad"]\nlet xs = [[a], [b]]\nexit\n', ["error TSV041@43"], null, []],
    ['let a = [1]\nlet b = ["bad"]\nlet xs = a\nxs = b\nexit\n', ["error TSV041@44"], null, []],
    ['let a = [1]\nlet b = [2.5]\nlet xs = [a, b]\nsay "after"\nexit\n', [], [], [[2, null]]],
    // C9: external data stored whole into a written collection, checked there with its elements
    [
      "let pool: integer[] = hostValue\nexit\n",
      ["warning TSV041@22", "warning TSV041@22"],
      ["0:31"],
      [
        [list(1, 2), null],
        [list("x"), "TSR058@22:31"],
        ["x", "TSR058@22:31"],
      ],
    ],
    // C9 r4.10: a host value a consumer reads directly is checked at the read, the runtime's own validation; C2 at the use
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
    const compiled = inBothOrders(() => {
      const result = candidate(source);
      return {
        diagnostics: sited(result),
        checked: result.plan === null ? null : checkedStores(result.plan),
      };
    });
    assert.deepEqual(compiled.diagnostics.sort(), [...diagnostics].sort(), source);
    assert.deepEqual(compiled.checked, checked, source);
    const plan = candidate(source).plan;
    for (const [value, failure] of runs) {
      assert.ok(plan !== null, source);
      assert.equal(
        runWith(plan, value).failure,
        failure,
        `${source} with ${JSON.stringify(value)}`,
      );
    }
  }
});

test("external data a literal carries is warned and checked at its store before any later effect, read or not (the owner's F1)", () => {
  // per program C1's warning at the host expression, the store checks and, per host value, the run's messages and
  // failure: no consumer reads the list
  for (const [source, warnings, checked, runs] of [
    [
      'let xs = [1, hostValue]\nsay "AFTER"\nexit\n',
      ["warning TSV041@13"],
      ["0:23"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@9:23"],
      ],
    ],
    [
      'let xs = [hostValue, 1]\nsay "AFTER"\nexit\n',
      ["warning TSV041@10"],
      ["0:23"],
      [
        [2, ["AFTER"], null],
        [1.5, [], "TSR058@9:23"],
      ],
    ],
    [
      'let xs = [[1], [hostValue]]\nsay "AFTER"\nexit\n',
      ["warning TSV041@16"],
      ["0:27"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@9:27"],
      ],
    ],
    [
      'let ys = [1, hostValue]\nlet xs = ys\nsay "AFTER"\nexit\n',
      ["warning TSV041@13"],
      ["0:23"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@9:23"],
      ],
    ],
    // named, the same (round 10 B1)
    [
      'let a = hostValue\nlet xs = [1, a]\nsay "AFTER"\nexit\n',
      ["warning TSV041@27"],
      ["18:33"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@27:33"],
      ],
    ],
    // host data alone admits no type: nothing to check it against
    ['let xs = [hostValue, hostValue]\nsay "AFTER"\nexit\n', [], [], [["bad", ["AFTER"], null]]],
  ] as const) {
    const compiled = inBothOrders(() => {
      const result = candidate(source);
      return {
        diagnostics: sited(result),
        checked: result.plan === null ? null : checkedStores(result.plan),
      };
    });
    assert.deepEqual(compiled, { diagnostics: warnings, checked }, source);
    const plan = candidate(source).plan;
    assert.ok(plan !== null, source);
    for (const [value, says, failure] of runs) {
      const ran = runWith(plan, value);
      assert.deepEqual(
        { says: ran.says, failure: ran.failure },
        { says, failure },
        `${source} with ${JSON.stringify(value)}`,
      );
    }
  }
});

test("C1 warns where some kind of the stored value fits and errs only where none does, in both orders (r4.46)", () => {
  // a list literal's element at an index: the items `integer` and `number`, both definite, one fitting; with a host value
  // the external item beside a `number`, and C9's boundary check at the host value. The context words (§3.4): the
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
    assert.deepEqual(checkedStores(compiled.plan), [`0:${source.indexOf("\n")}`], source);
    const end = source.indexOf("\n");
    if (passing === null)
      assert.deepEqual(runWith(compiled.plan, null), {
        status: "halted",
        says: ["selected"],
        failure: null,
      });
    else {
      assert.deepEqual(runWith(compiled.plan, passing).says, ["selected"], source);
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
  assert.equal(runWith(fractional.plan, null).failure, "TSR058@22:33");
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

test("the candidate hears of each file it walks, as the production default does", () => {
  const request = coreRequest([
    { path: "main.tease", source: "let first = 1\nexit\n" },
    { path: "other.tease", source: "let other = 2\nexit\n" },
  ]);
  assert.ok(request !== null);
  const heard = (backend?: typeof CORE_BACKEND): number[] => {
    const files: number[] = [];
    analyzeTypes({ ...request, onFile: (file) => files.push(file) }, backend);
    return files;
  };
  assert.deepEqual(heard(), [0, 1]);
  assert.deepEqual(heard(CORE_BACKEND), [0, 1]);
});

test("C2's integer check warns with TSV011 at a count and TSV043 at a list index, and runs at the use", () => {
  const count = candidate(
    'let count: number = hostValue\nsay "ready"\nrepeat count {\n  say "turn"\n}\nexit\n',
  );
  assert.deepEqual(sited(count), ["warning TSV041@20", "warning TSV011@49"]);
  assert.ok(count.diagnostics[1]!.message.startsWith(REPEAT_COUNT_RULE));
  assert.ok(count.plan !== null);
  assert.deepEqual(runWith(count.plan, 2).says, ["ready", "turn", "turn"]);
  assert.deepEqual(runWith(count.plan, 2.5), {
    status: "failed",
    says: ["ready"],
    failure: "TSR043@49:54",
  });
  assert.equal(runWith(count.plan, "x").failure, "TSR058@20:29");

  const index = candidate(
    "let rows = [10, 20]\nlet at: number = hostValue\nrepeat rows[at] {}\nexit\n",
  );
  assert.deepEqual(sited(index), ["warning TSV041@37", "warning TSV043@59"]);
  assert.ok(index.plan !== null);
  assert.equal(runWith(index.plan, 1).status, "halted");
  assert.equal(runWith(index.plan, 0.5).failure, "TSR024@59:61");
  assert.equal(runWith(index.plan, 2).failure, "TSR025@59:61");

  // the proven cases stay errors under the same codes
  assert.deepEqual(sited(candidate("let n = 2.5\nrepeat n {}\nexit\n")), ["error TSV011@19"]);
  assert.deepEqual(sited(candidate("let n: integer = 2.5\nexit\n")), ["error TSV041@17"]);
  assert.deepEqual(sited(candidate("let xs = [10, 20]\nlet i = 1.5\nrepeat xs[i] {}\nexit\n")), [
    "error TSV043@40",
  ]);
  // in parentheses the diagnostic stands at the content (§3.4), once, and names the index's rule
  assert.deepEqual(sited(candidate("let n = 2.5\nrepeat (n) {}\nexit\n")), ["error TSV011@20"]);
  const parenthesized = candidate(
    "let rows = [10, 20]\nlet at = 0.5\nrepeat rows[(at)] {}\nexit\n",
  );
  assert.deepEqual(sited(parenthesized), ["error TSV043@46"]);
  assert.match(parenthesized.diagnostics[0]!.message, /^A list index must be a whole number/);
});

test("parentheses answer for their content: a parenthesised count and index read as bare ones (S3 3.4)", () => {
  // the flow graph's node of a parenthesised expression is its content's, the value the parentheses hold
  const source = "let n = 2\nrepeat ((n)) {}\nlet xs = [1, 2]\nlet y = xs[(n)]\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const answers = analyseCore(request);
  const index = new SliceIndex(request.files.map((file) => file.program));
  for (const expression of index.expressions)
    if (expression.kind === "parenthesizedExpression")
      assert.deepEqual(
        answers.at(nodeOf(answers, index, expression))?.items.map((item) => item.tag),
        ["integer"],
        source.slice(expression.span.start.offset, expression.span.end.offset),
      );
  // on the candidate route: the content's site, the kinds the core names, and the check at the content
  const count = inBothOrders(() => candidate("repeat ((2.5)) {}\nexit\n").diagnostics);
  assert.deepEqual(sited({ diagnostics: count }), ["error TSV011@9"]);
  assert.match(count[0]!.message, /but '2\.5' is a number\.$/);
  const listed = inBothOrders(
    () => candidate("let xs = [1, 2]\nlet y = xs[(0.5)]\nexit\n").diagnostics,
  );
  assert.deepEqual(sited({ diagnostics: listed }), ["error TSV043@28"]);
  assert.match(listed[0]!.message, /but '0\.5' is a number\.$/);
  const host = candidate("repeat ((hostValue)) {}\nexit\n");
  assert.deepEqual(sited(host), ["warning TSV011@9"]);
  assert.ok(host.plan !== null);
  assert.equal(runWith(host.plan, 2).status, "halted");
  assert.equal(runWith(host.plan, 1.5).failure, "TSR043@9:18");
  const hostIndex = candidate("let xs = [1, 2]\nlet y = xs[(hostValue)]\nexit\n");
  assert.deepEqual(sited(hostIndex), ["warning TSV043@28"]);
  assert.ok(hostIndex.plan !== null);
  assert.equal(runWith(hostIndex.plan, 1).status, "halted");
  assert.equal(runWith(hostIndex.plan, 0.5).failure, "TSR024@28:37");
});

test("a projection of a literal carries its elements' types and host data on the candidate route (round 11)", () => {
  // A8 through the projection, direct and named; A2 across a change of the named list; C1 and C9 at the store, before
  // any later effect
  for (const [source, diagnostics] of [
    ['let xs = [[[1]][0], [["bad"]][0]]\nsay "AFTER"\nexit\n', ["error TSV041@20"]],
    [
      'let v1 = [1]\nlet v2 = ["bad"]\nlet xs = [[v1][0], [v2][0]]\nsay "AFTER"\nexit\n',
      ["error TSV041@49"],
    ],
    [
      'let a = [1]\nlet xs = []\nxs = [[a][0], [[1]][0]]\na = ["bad"]\nxs = [[a][0], [[1]][0]]\nexit\n',
      ["error TSV041@53"],
    ],
  ] as const)
    assert.deepEqual(
      inBothOrders(() => sited(candidate(source))),
      diagnostics,
      source,
    );
  const host = 'let a = [hostValue]\nlet xs = [[[1]][0], [a][0]]\nsay "AFTER"\nexit\n';
  const compiled = inBothOrders(() => {
    const result = candidate(host);
    return {
      diagnostics: sited(result),
      checked: result.plan === null ? null : checkedStores(result.plan),
    };
  });
  assert.deepEqual(compiled.diagnostics, ["warning TSV041@29"]);
  const plan = candidate(host).plan;
  assert.ok(plan !== null);
  assert.deepEqual(runWith(plan, 2).says, ["AFTER"]);
  const bad = runWith(plan, "bad");
  assert.deepEqual({ says: bad.says, failed: bad.failure !== null }, { says: [], failed: true });
});

test("a projected written integer list stays strict on the candidate route (A4, round 15 B3)", () => {
  const source = 'let typed: integer[] = [1]\nlet xs = [typed][0]\nxs = [2.5]\nsay "AFTER"\nexit\n';
  assert.deepEqual(
    inBothOrders(() => sited(candidate(source))),
    [`error TSV041@${source.indexOf("2.5")}`],
  );
  assert.equal(candidate(source).plan, null);
});

test("a projection of a written nested list stays strict on the candidate route (A4, F12, Astra r2 B2)", () => {
  const source =
    'let source: integer[][] = [[4]]\nlet result = source[0]\nresult = [3.5]\nsay "AFTER"\nexit\n';
  assert.deepEqual(
    inBothOrders(() => sited(candidate(source))),
    [`error TSV041@${source.indexOf("3.5")}`],
  );
  assert.equal(candidate(source).plan, null);
});

test("a written scalar a singleton literal gives stays strict on the candidate route (A4, Codex r16 B1)", () => {
  const source = 'let typed: integer = 1\nlet xs = [typed][0]\nxs = 2.5\nsay "AFTER"\nexit\n';
  assert.deepEqual(
    inBothOrders(() => sited(candidate(source))),
    [`error TSV041@${source.lastIndexOf("2.5")}`],
  );
  assert.equal(candidate(source).plan, null);
});

/** The admitted type of the place a statement starting with `start` declares: its kinds and its decider's offset. */
function admittedOf(source: string, start: string): string {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const answers = analyseCore(request);
  for (const node of answers.graph.nodes) {
    if (node.kind !== "statement" || node.span === null) continue;
    if (!source.slice(node.span.start.offset, node.span.end.offset).startsWith(start)) continue;
    const place = answers.at(node)?.place;
    assert.ok(place, `${source}: ${start}'s place`);
    const admitted = answers.place(place.id).admitted;
    return admitted.by === "decided"
      ? `decided ${admitted.kinds.join("|")}@${admitted.decider?.start ?? "-"}`
      : admitted.by;
  }
  throw new Error(`${source}: no statement ${start}`);
}

test("a place published with a kind checks the external data stored into it, named or inline, at any endpoint (A7, C9 r4.12, r4.50 (1), R4-F1)", () => {
  // the external reviewer's endpoint matrix: per kind (a known element, a fitting and a bad host value), projection
  // (an index, a nested index, parentheses, an index held in a variable), host data inline or named, and without or
  // with a later store: the place is decided by the known element (or the later store), named data warns where it is
  // read with its check, inline data has its boundary, the declaration's store is checked, and the bad value stops
  // there before AFTER while the fitting one reaches it
  const kinds = [
    ["1", 2, "bad"],
    ['"a"', "b", 1],
    ["true", false, "bad"],
  ] as const;
  const forms = [
    (data: string): string => `[K, ${data}][1]`,
    (data: string): string => `[[K, ${data}]][0][1]`,
    (data: string): string => `([K, ${data}])[1]`,
    (data: string): string => `[K, ${data}][i]`,
  ];
  let shapes = 0;
  for (const [known, good, bad] of kinds)
    for (const [index, form] of forms.entries())
      for (const named of [false, true])
        for (const later of [false, true]) {
          const lines = [
            ...(named ? ["let raw = hostValue"] : []),
            ...(index === 3 ? ["let i = 1"] : []),
            `let out = ${form(named ? "raw" : "hostValue").replace("K", known)}`,
            ...(later ? [`out = ${known}`] : []),
            'say "AFTER"',
            "exit",
          ];
          const source = `${lines.join("\n")}\n`;
          const declaration = source.indexOf("let out");
          const decider = later ? source.lastIndexOf(known) : source.indexOf(known, declaration);
          const kind = known === "1" ? "integer" : known === "true" ? "boolean" : "string";
          assert.equal(admittedOf(source, "let out"), `decided ${kind}@${decider}`, source);
          // (named data warns where it is read; with a later decider, C1 warns at the stored value, inline data at
          // its host value)
          const value = declaration + "let out = ".length;
          const data = named ? source.indexOf("raw", declaration) : source.indexOf("hostValue");
          const warned = named ? (later ? value : data) : later ? data : null;
          const compiled = inBothOrders(() => {
            const result = candidate(source);
            return {
              diagnostics: sited(result),
              declarationChecked:
                result.plan !== null &&
                checkedStores(result.plan).some((span) => span.startsWith(`${declaration}:`)),
            };
          });
          assert.deepEqual(
            compiled,
            {
              diagnostics: warned === null ? [] : [`warning TSV041@${warned}`],
              declarationChecked: true,
            },
            source,
          );
          const plan = candidate(source).plan;
          assert.ok(plan !== null, source);
          assert.deepEqual(
            runWith(plan, good).says,
            ["AFTER"],
            `${source} with ${JSON.stringify(good)}`,
          );
          const stopped = runWith(plan, bad);
          assert.deepEqual(
            { says: stopped.says, code: stopped.failure?.split("@")[0] ?? null },
            { says: [], code: "TSR058" },
            `${source} with ${JSON.stringify(bad)}`,
          );
          shapes += 1;
        }
  assert.equal(shapes, 48);
  // the controls: host data alone admits no kind (nothing to check it against), known elements need no check
  for (const [source, admitted] of [
    ['let raw = hostValue\nlet out = [raw][0]\nsay "AFTER"\nexit\n', "undecided"],
    ['let out = [1, 2][1]\nsay "AFTER"\nexit\n', "decided integer@10"],
  ] as const) {
    assert.equal(admittedOf(source, "let out"), admitted, source);
    assert.deepEqual(
      inBothOrders(() => sited(candidate(source))),
      [],
      source,
    );
    const plan = candidate(source).plan;
    assert.ok(plan !== null, source);
    assert.deepEqual(checkedStores(plan), [], source);
    assert.deepEqual(runWith(plan, "bad").says, ["AFTER"], source);
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
  const compiled = candidate(
    'let count: number = hostValue\nsay "checked"\nrepeat count {\n  say "turn"\n}\nexit\n',
  );
  assert.ok(compiled.plan !== null);
  const plan = compiled.plan;
  for (const [hostValue, ending] of [
    [2, "halted"],
    [2.5, "failed"],
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
    if (ending === "failed")
      assert.ok(
        resumed.events.some((event) => event.kind === "runtimeFailure" && event.code === "TSR043"),
      );
    else
      assert.deepEqual(
        resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
        ["turn", "turn"],
      );
  }
});

test("a program outside the slice throws at its first construct outside it", () => {
  for (const [source, offset] of [
    // a statement outside the slice
    ["let total = 0\nfor value in [1, 2] {\n  total = value\n}\nexit\n", 14],
    // another consumer: a condition that is no boolean (C3)
    ['if 1 {\n  say "never"\n}\nexit\n', 3],
    // a possible null, whose required check comes with narrowing (S10)
    ["let flag = true\nlet n: integer? = null\nif flag {\n  n = 2\n}\nrepeat n {}\nexit\n", 66],
    // lists nested as deep as the facts' walk (256 levels), inferred or written
    [
      `let a = ${"[".repeat(256)}1${"]".repeat(256)}\na = ${"[".repeat(256)}"bad"${"]".repeat(256)}\nexit\n`,
      4,
    ],
    [`let a: integer${"[]".repeat(256)} = []\nexit\n`, 7],
  ] as const) {
    assert.throws(
      () => candidate(source),
      (error) =>
        error instanceof CandidateOutsideSlice &&
        error.path === "main.tease" &&
        error.site.file === 0 &&
        error.site.start === offset,
      source,
    );
  }
});

test("the candidate's side outputs follow the flow graph's literal facts and the kept checks", () => {
  const source =
    'if true {\n  say "a"\n} else {\n  say "b"\n}\nrepeat 0 {\n  say "c"\n}\nrepeat 1 {\n  exit\n}\nsay "d"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const checked: TypeCheckResult = CORE_BACKEND.analyze(request).checked;
  assert.deepEqual(
    [...checked.ways.paths].map(([statement, ways]) => [statement.span.start.offset, ...ways]),
    [
      [0, true, false],
      [41, false, true],
      [64, true, false],
    ],
  );
  assert.deepEqual(
    [...checked.unreachable]
      .map((statement) => `${statement.kind}@${statement.span.start.offset}`)
      .sort(),
    ["exitStatement@92", "sayStatement@31", "sayStatement@54", "sayStatement@84"],
  );
  // the checks after the plan read them as they read the production default's: the same warnings
  assert.deepEqual(sited(candidate(source)), sited(compileSource(source, OPTIONS)));

  // the kept checks the slice reaches: a known repeat count the runtime cannot count, a message's markup colour
  const large = candidate("let n = 9007199254740992\nrepeat n {}\nexit\n");
  assert.deepEqual(sited(large), ["error TSV011@32"]);
  assert.match(large.diagnostics[0]!.message, /Use a smaller count\.$/);
  assert.deepEqual(sited(candidate('say "[color=bad]x[/color]"\nexit\n')), ["error TSC008@4"]);
});

test("the candidate's facts list every binding, read and value of the program with the core's types", () => {
  const request = coreRequest([
    {
      path: "main.tease",
      source: "let n: integer = 1\nlet xs = [1, 2.5]\nrepeat xs[0] {}\nexit\n",
    },
  ]);
  assert.ok(request !== null);
  const facts = CORE_BACKEND.analyze(request).facts();
  const at = (start: number, end: number) => ({ file: 0, start, end });
  assert.deepEqual(facts.bindings, [
    { site: at(0, 18), kind: "letStatement", name: "n", type: "integer" },
    // A3: the settled family of the elements
    { site: at(19, 36), kind: "letStatement", name: "xs", type: "list<number>" },
  ]);
  assert.deepEqual(facts.reads, [{ site: at(44, 46), name: "xs", binding: at(19, 36) }]);
  assert.deepEqual(
    facts.values.map((value) => [value.site.start, value.kind, value.type]),
    [
      [17, "numberLiteral", "integer"],
      [28, "listLiteral", "list<number>"],
      [29, "numberLiteral", "integer"],
      [32, "numberLiteral", "number"],
      [44, "identifier", "list<number>"],
      // F12: an element read takes the element's contract, the family of both
      [44, "indexExpression", "number"],
      [47, "numberLiteral", "integer"],
    ],
  );
  assert.deepEqual(
    [facts.functions, facts.speakers, facts.uncheckedProperties, facts.storage],
    [[], [], [], []],
  );

  // one level less than the walk: complete to the element kind
  const deep = coreRequest([
    { path: "main.tease", source: `let a = ${"[".repeat(255)}1${"]".repeat(255)}\nexit\n` },
  ]);
  assert.ok(deep !== null);
  assert.equal(
    CORE_BACKEND.analyze(deep).facts().bindings[0]!.type,
    `${"list<".repeat(255)}integer${">".repeat(255)}`,
  );

  // parentheses, nested element reads and a kind without parts keep their whole types
  const shapes = coreRequest([
    {
      path: "main.tease",
      source:
        "let a = (1)\nlet b = [(2)]\nlet c = [[[[3]]]][0]\nlet r: range = hostValue\nlet q: range = r\nexit\n",
    },
  ]);
  assert.ok(shapes !== null);
  const shaped = CORE_BACKEND.analyze(shapes);
  assert.deepEqual(sited({ diagnostics: shaped.checked.diagnostics.flat() }), [
    "warning TSV041@62",
  ]);
  const typed = shaped.facts();
  assert.deepEqual(
    typed.bindings.map((binding) => `${binding.name}: ${binding.type}`),
    ["a: integer", "b: list<integer>", "c: list<list<list<integer>>>", "r: range", "q: range"],
  );
  assert.deepEqual(
    typed.values
      .filter((value) =>
        ["parenthesizedExpression", "indexExpression", "identifier"].includes(value.kind),
      )
      .map((value) => `${value.site.start} ${value.kind} ${value.type}`),
    [
      "8 parenthesizedExpression integer",
      "21 parenthesizedExpression integer",
      "34 indexExpression list<list<list<integer>>>",
      "62 identifier unknown",
      "87 identifier range",
    ],
  );
});

test("a program the work allowance stops after its analysis is rejected, never accepted without its facts", () => {
  const request = coreRequest([
    {
      path: "main.tease",
      source: "let xs: integer?[] = [hostValue, null, 7]\nlet n = 1\nrepeat n {}\nexit\n",
    },
  ]);
  assert.ok(request !== null);
  const outcomes = new Set<string>();
  for (let allowance = 20; allowance <= 4_000; allowance += 20) {
    const outcome = insideSlice(() =>
      withTestAllowance(allowance, () => CORE_BACKEND.analyze(request)),
    );
    if (outcome === null) outcomes.add("rejected");
    else {
      assert.doesNotThrow(() => outcome.facts(), String(allowance));
      outcomes.add("accepted");
    }
  }
  assert.deepEqual([...outcomes].sort(), ["accepted", "rejected"]);
});

/** A type check result as JSON-safe data, its syntax keys by their spans. */
function checkedData(checked: TypeCheckResult): string {
  const span = (node: {
    readonly span: { readonly start: { offset: number }; readonly end: { offset: number } };
  }): string => `${node.span.start.offset}:${node.span.end.offset}`;
  return JSON.stringify({
    diagnostics: checked.diagnostics,
    runtimeChecks: [...checked.runtimeChecks].map(([site, plan]) => [span(site), plan]),
    formShapes: [...checked.formShapes].map(([site, shape]) => [span(site), shape]),
    paths: [...checked.ways.paths].map(([site, ways]) => [span(site), ways]),
    operands: [...checked.ways.operands],
    unreachable: [...checked.unreachable].map(span),
    speakerFlow: [[...checked.speakerFlow.reads], [...checked.speakerFlow.stores]],
    storageTypes: checked.storageTypes,
  });
}

test("the legacy analysis gives the same result with and without each file's source and picks", () => {
  let compared = 0;
  for (const [position, record] of readFixture().entries()) {
    if (position % 4 !== 0) continue;
    // separate parses, so that nothing one analysis keeps on the syntax reaches the other
    const withInput = coreRequest(record.files);
    const without = coreRequest(record.files);
    if (withInput === null || without === null) continue;
    const plain: TypeAnalysisRequest = {
      ...without,
      files: without.files.map(({ path, program }) => ({ path, program })),
    };
    const full = analyzeTypes(withInput);
    const bare = analyzeTypes(plain);
    assert.equal(checkedData(full.checked), checkedData(bare.checked), record.name);
    assert.equal(JSON.stringify(full.facts()), JSON.stringify(bare.facts()), record.name);
    compared += 1;
  }
  assert.ok(compared > 300, `${compared} records compared`);
});

/** The TypeScript, JavaScript and Vue sources under `directory`, without built or installed code. */
function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.(ts|mts|js|mjs|vue)$/.test(name) ? [path] : [];
  });
}

test("no production code selects the core: only tests reach the candidate entry", () => {
  const root = process.cwd();
  for (const directory of ["src", "playground", "player", "tools"])
    for (const file of sourcesUnder(join(root, directory))) {
      const relative = file.slice(root.length + 1);
      const text = readFileSync(file, "utf8");
      if (relative !== "src/compiler.ts")
        assert.ok(!/compile(Source|Project)WithBackend\s*\(/.test(text), relative);
      if (!relative.startsWith("src/type-inference/core/"))
        assert.ok(!/core\/backend\.js|CORE_BACKEND/.test(text), relative);
    }
  // the root compilers pass no backend: their result is the production default's
  const project = [{ path: "main.tease", source: "let n: integer = hostValue\nexit\n" }];
  assert.deepEqual(sited(compileProject(project, OPTIONS)), []);
  assert.deepEqual(sited(compileProjectWithBackend(project, OPTIONS, CORE_BACKEND)), [
    "warning TSV041@17",
  ]);
});
