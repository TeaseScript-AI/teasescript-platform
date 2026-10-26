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
import type { InstructionPlan, TypePlan } from "../src/plan/model.js";
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
import { CARRIER_KINDS, type CarrierKind } from "../src/type-inference/core/carriers.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { nodeOf, SliceIndex } from "../src/type-inference/core/consumer.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { analyzeTypes } from "../src/type-inference/index.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import {
  companions,
  derive,
  evaluate,
  Underivable,
  type CheckEvent,
  type PredictedRun,
} from "./helpers/type-core-derived.js";
import { heldBack, readFixture } from "./helpers/type-core-fixture.js";
import {
  assignments,
  derivedStores,
  DOMAIN,
  plannedStores,
  runGlobals,
} from "./helpers/type-core-route.js";
import { recordDifferences, recordOf } from "./helpers/type-core-records.js";
import { BOTH, owed, records, type Endpoint, type RuleClass } from "./helpers/type-core-rule.js";
import { WRITTEN_COPY_MATRIX } from "./helpers/type-core-witnesses.js";

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
  return inBothOrdersAs(run, (result) => result)[0];
}

/**
 * `inBothOrders` with the two results compared as `project` gives them: the forward result whole, and its projection.
 * A test that runs the forward plan compiles no third time: each run starts from a fresh snapshot.
 */
function inBothOrdersAs<R, T>(run: () => R, project: (result: R) => T): readonly [R, T] {
  const forward = run();
  const projected = project(forward);
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => project(run()),
    ),
  );
  assert.deepEqual(reversed, projected);
  return [forward, projected];
}

/** A run of `plan` to its end without reading pauses, with `hostValue`: its status, messages and failure. */
function runWith(plan: InstructionPlan, hostValue: SerializableRuntimeValue) {
  const { said, ...ran } = runSited(plan, hostValue);
  return { ...ran, says: said.map(({ text }) => text) };
}

/** `runWith`'s run, each message with the offset its statement starts at: an effect's place in the source. */
function runSited(plan: InstructionPlan, hostValue: SerializableRuntimeValue) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    status: result.snapshot.status,
    said: result.events.flatMap((event) =>
      event.kind === "say" ? [{ text: event.text, at: event.span.start.offset }] : [],
    ),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  };
}

/**
 * The run oracle of an enforcement test (TABLE r4.59): per host value its expected failure, `CODE@start:end`, or `null`.
 * A run without one says exactly `said` and halts at the end; a run with one ends failed with exactly it, nothing said
 * by a statement at or after the failing check's start.
 */
function assertRuns(
  plan: InstructionPlan,
  name: string,
  said: readonly string[],
  runs: readonly (readonly [SerializableRuntimeValue, string | null])[],
): void {
  for (const [value, failure] of runs) {
    const ran = runSited(plan, value);
    const start = failure === null ? -1 : Number(/@(\d+):/.exec(failure)![1]);
    assert.deepEqual(
      {
        status: ran.status,
        failure: ran.failure,
        said: ran.said.flatMap(({ text, at }) => (at >= start ? [text] : [])),
      },
      {
        status: failure === null ? "halted" : "failed",
        failure,
        said: failure === null ? said : [],
      },
      `${name} with ${JSON.stringify(value)}`,
    );
  }
}

/** A plan's stores that check their value (`typeCheck`): per instruction, its file, span and checked type. */
function typeChecks(
  plan: InstructionPlan,
): { readonly file: string; readonly so: number; readonly eo: number; readonly type: TypePlan }[] {
  const out: { file: string; so: number; eo: number; type: TypePlan }[] = [];
  for (const [index, instruction] of plan.instructions.entries())
    if (
      (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
      instruction.typeCheck !== undefined
    )
      out.push({
        file:
          plan.files.find((file) => file.startInstruction <= index && index < file.endInstruction)
            ?.path ?? "",
        so: instruction.span.so,
        eo: instruction.span.eo,
        type: instruction.typeCheck.type,
      });
  return out;
}

/** A checked type in full, as these tests compare it: `integer`, `list<list<integer>>`, `{name: string}`, `a|b`. */
function typeText(type: TypePlan | null): string {
  if (type === null) return "any";
  if (type.kind === "union") return type.members.map(typeText).join("|");
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return `${type.kind}<${typeText(type.element)}>`;
  if (type.kind === "object")
    return `{${type.properties.map(({ name, type: of }) => `${name}: ${typeText(of)}`).join(", ")}}`;
  return type.kind;
}

/** A plan's checked stores, each as `start:end type`: the store that checks, and the whole type it checks. */
function checksOf(plan: InstructionPlan): string[] {
  return typeChecks(plan).map(({ so, eo, type }) => `${so}:${eo} ${typeText(type)}`);
}

/**
 * The reached fixture, derived from its records (S6-CARRIERS revision 5, §5.2; TABLE r4.59; the lead's answer 3). Every
 * record of the positive list (the cells test's: all but those `heldBack` names) is tried on the candidate route in both
 * orders. A record the route accepts is checked in four layers, each derived from the record and its source alone:
 * - **records:** its C1 and C2 diagnostics at their whole sites, its obligations exactly (the cells test's comparison),
 *   and a plan exactly where it is not a compile error, alike on the one-file route;
 * - **discharges:** each obligation discharged by one rule (`derive`), a checked store or the runtime;
 * - **checked stores:** the plan's are exactly the derived ones, target, spans and whole type;
 * - **runs:** the original as written, its outcome with each host input at the value that fits the earliest check it
 *   feeds, and the original and every companion under every assignment of the domain to their host inputs, each
 *   predicted by the rules and run on the engine. A companion keeps its record's spans, kinds and decisions, so it
 *   compiles on the route with the record's derived checked stores, or the test fails (Codex r20 H1).
 * Each discharge is then classified by the runs: violable (a run fails there), preempted (a value that violates it
 * always fails an earlier check first), not violable (no derived value violates it) or unreachable (no run evaluates
 * it). A record the route rejects (`CandidateOutsideSlice`) is counted by its first construct outside the slice.
 */
test("every positive-list record the candidate route reaches plans and runs as its record derives, in both orders (§5.2, r4.59)", (t) => {
  const kinds: Readonly<Record<string, string>> = {
    TSV041: "written-target",
    TSV011: "integer-use",
    TSV043: "integer-use",
  };
  const accepted: string[] = [];
  const outside = new Map<string, number>();
  const classes = new Map<string, number>();
  const originals = new Map<string, string | null>();
  const classOf = new Map<string, string>();
  const companionRuns = new Map<string, PredictedRun[]>();
  let positive = 0;
  let plans = 0;
  let runs = 0;
  for (const record of readFixture()) {
    if (heldBack(record) !== null) continue;
    positive += 1;
    let result: ReturnType<typeof compileProjectWithBackend>;
    try {
      result = inBothOrders(() => compileProjectWithBackend(record.files, OPTIONS, CORE_BACKEND));
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      const what = record.files.length > 1 ? "several files" : error.what.replace(/^this /, "");
      outside.set(what, (outside.get(what) ?? 0) + 1);
      continue;
    }
    accepted.push(record.name);
    assert.equal(record.files.length, 1, `${record.name}: one file`);
    const source = record.files[0]!.source;
    // records: the diagnostics at their whole sites, the obligations exactly, alike on the one-file route
    const diagnosed = (compiled: Pick<CompilationResult, "diagnostics">): string[] =>
      compiled.diagnostics
        .filter((diagnostic) => kinds[diagnostic.code] !== undefined)
        .map(
          (diagnostic) =>
            `${diagnostic.severity} ${kinds[diagnostic.code]} ` +
            `${diagnostic.span.start.offset}:${diagnostic.span.end.offset}`,
        )
        .sort();
    assert.deepEqual(
      diagnosed(result),
      record.expected.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.class === "compile-error" ? "error" : "warning"} ${diagnostic.kind} ` +
            `${diagnostic.site.offset}:${diagnostic.site.end}`,
        )
        .sort(),
      record.name,
    );
    const request = coreRequest(record.files);
    assert.ok(request !== null, record.name);
    assert.deepEqual(recordDifferences(record.expected, compactAnalysis(request)), [], record.name);
    assert.equal(result.plan === null, record.expected.outcome === "compile-error", record.name);
    const single = inBothOrders(() => candidate(source));
    assert.deepEqual(diagnosed(single), diagnosed(result), `${record.name}: the one-file route`);
    if (result.plan === null) continue;
    plans += 1;
    // discharges and checked stores, by rule (a construct the rules do not cover fails here, named)
    const derived = (() => {
      try {
        return derive(source, record.expected);
      } catch (error) {
        if (error instanceof Underivable)
          throw new Error(`${record.name}: underivable: ${error.message}`);
        throw error;
      }
    })();
    const { stores, discharges } = derived;
    assert.deepEqual(
      plannedStores(result.plan),
      derivedStores(stores),
      `${record.name}: the checked stores`,
    );
    assert.deepEqual(
      plannedStores(single.plan!),
      derivedStores(stores),
      `${record.name}: the one-file route's`,
    );
    // runs: the original, as written, each input at the value fitting the earliest check it feeds
    const fitting =
      DOMAIN.find((value) => {
        const fed = evaluate(source, stores, { hostValue: value }, true).events.find((event) =>
          event.from.has("hostValue"),
        );
        return fed === undefined || fed.fits;
      }) ?? DOMAIN[0]!;
    const original = runGlobals(result.plan, { hostValue: fitting });
    assert.deepEqual(
      original,
      evaluate(source, stores, { hostValue: fitting }).run,
      `${record.name}: the original`,
    );
    originals.set(record.name, original.failure);
    runs += 1;
    // the companions with the same checked stores, under every assignment of their inputs
    const observed: { run: PredictedRun; events: readonly CheckEvent[] }[] = [];
    // the original under every assignment of its host input too: a violating value stops at its check, as derived
    for (const inputs of assignments(["hostValue"])) {
      const ran = runGlobals(result.plan, inputs);
      assert.deepEqual(
        ran,
        evaluate(source, stores, inputs).run,
        `${record.name}, the original with ${JSON.stringify(inputs)}`,
      );
      observed.push({ run: ran, events: evaluate(source, stores, inputs, true).events });
      runs += 1;
    }
    for (const companion of companions(source)) {
      const compiled = insideSlice(() =>
        inBothOrders(() =>
          compileSourceWithBackend(
            companion.source,
            { globals: [...companion.globals] },
            CORE_BACKEND,
          ),
        ),
      );
      const at = `${record.name}, companion ${companion.label}`;
      assert.ok(compiled !== null, `${at}: inside the slice`);
      assert.ok(compiled.plan !== null, `${at}: a plan`);
      assert.deepEqual(
        plannedStores(compiled.plan),
        derivedStores(stores),
        `${at}: the checked stores`,
      );
      for (const inputs of assignments(companion.globals)) {
        const ran = runGlobals(compiled.plan, inputs);
        assert.deepEqual(
          ran,
          evaluate(companion.source, stores, inputs).run,
          `${record.name}, companion ${companion.label}, with ${JSON.stringify(inputs)}`,
        );
        observed.push({
          run: ran,
          events: evaluate(companion.source, stores, inputs, true).events,
        });
        companionRuns.set(record.name, [...(companionRuns.get(record.name) ?? []), ran]);
        runs += 1;
      }
    }
    // each discharge classified by the runs: a store's at its value, the runtime's at its use
    for (const discharge of discharges) {
      if (discharge.by === "native" && discharge.what === "representable") {
        classes.set(
          "not violable (representable)",
          (classes.get("not violable (representable)") ?? 0) + 1,
        );
        continue;
      }
      const named =
        discharge.by === "store"
          ? `${discharge.store.valueSo}:${discharge.store.valueEo}`
          : discharge.site;
      const key = `${record.name}#${named}`;
      if (classOf.has(key)) continue;
      const at = `@${named}`;
      const verdict = observed.some(({ run: ran }) => ran.failure?.endsWith(at) === true)
        ? "violable"
        : observed.some(({ events }) => events.some((event) => event.site === named && !event.fits))
          ? "preempted"
          : observed.some(({ events }) => events.some((event) => event.site === named))
            ? "not violable"
            : "unreachable";
      classOf.set(key, verdict);
      classes.set(verdict, (classes.get(verdict) ?? 0) + 1);
    }
  }
  const counted = [...outside.values()].reduce((sum, count) => sum + count, 0);
  const listed = (map: ReadonlyMap<string, number>): string =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .map(([what, count]) => `${what} ${count}`)
      .join(", ");
  t.diagnostic(
    `${positive} positive-list records: ${accepted.length} on the candidate route, ${plans} with a plan, ${runs} ` +
      `runs predicted and run; discharges: ${listed(classes)}; outside the candidate slice until S7–S9b: ` +
      listed(outside),
  );
  assert.equal(accepted.length + counted, positive);
  // the literal witnesses of the rules (§5.2): each class and each original outcome the note names
  const verdicts: readonly (readonly [string, string, string])[] = [
    ["cp9-cells/r6-bugs/admission/use-before-overwrite", "38:43", "preempted"],
    ["cp9-cells/r6-bugs/admission/use-before-overwrite", "12:30", "violable"],
    ["cp9-cells/s4/s6/owner/ingress/dead-consumer", "42:47", "unreachable"],
    ["cp9-cells/s4/s6/owner/ingress/dead-consumer", "9:23", "violable"],
    ["cp9-cells/s4/followup/fit/literal-mixed-repeat", "7:18", "violable"],
    ["cp9-cells/r46/m3/two-ingress-targets", "59:63", "violable"],
    ["cp9-cells/r46/m3/two-ingress-targets", "80:84", "violable"],
  ];
  for (const [name, at, verdict] of verdicts)
    assert.equal(classOf.get(`${name}#${at}`), verdict, `${name} at ${at}`);
  for (const [name, failure] of [
    ["cp9-cells/X5/outside-definition", "TSR043@28:29"],
    ["cp9-cells/r46/m3/two-ingress-targets", "TSR058@80:84"],
    ["cp9-cells/review/list-position-absent", "TSR025@33:34"],
    ["cp9-cells/r46/m3/empty-index", "TSR025@30:31"],
    ["cp9-cells/s4/followup/fit/literal-mixed-repeat", null],
  ] as const)
    assert.equal(originals.get(name), failure, `${name}: the original`);
  // a companion gives what the original cannot: X5's integer writer and two-ingress-targets' independent inputs halt
  for (const name of ["cp9-cells/X5/outside-definition", "cp9-cells/r46/m3/two-ingress-targets"])
    assert.ok(
      companionRuns
        .get(name)
        ?.some((ran) => ran.status === "halted" && ran.said.at(-1)?.text === "AFTER"),
      `${name}: a fitting companion says AFTER and halts`,
    );
  // a record of the set for each cell of the slice (the pull request lists every record inside it; stage 3b's
  // `r7-bugs/m2/host-local` waits with S10)
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

  // the literal analogue of r4.29: the element's check against the written element type, `null` admitted
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
    ['let a = [1]\nlet b = ["bad"]\nlet xs = [a, b]\nexit\n', ["error TSV041@41"], null, []],
    ['let a = [1]\nlet b = ["bad"]\nlet xs = [[a], [b]]\nexit\n', ["error TSV041@43"], null, []],
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
  // failure: no consumer reads the list
  for (const [source, warnings, checked, runs] of [
    [
      'let xs = [1, hostValue]\nsay "AFTER"\nexit\n',
      ["warning TSV041@13"],
      ["0:23 list<integer>"],
      [
        [2, ["AFTER"], null],
        ["bad", [], "TSR058@9:23"],
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
  assert.deepEqual(checksOf(count.plan), ["0:29 number"]);
  assert.deepEqual(runWith(count.plan, 2), {
    status: "halted",
    says: ["ready", "turn", "turn"],
    failure: null,
  });
  assert.deepEqual(runWith(count.plan, 2.5), {
    status: "failed",
    says: ["ready"],
    failure: "TSR043@49:54",
  });
  assertRuns(count.plan, "the count", ["ready", "turn", "turn"], [["x", "TSR058@20:29"]]);

  const index = candidate(
    "let rows = [10, 20]\nlet at: number = hostValue\nrepeat rows[at] {}\nexit\n",
  );
  assert.deepEqual(sited(index), ["warning TSV041@37", "warning TSV043@59"]);
  assert.ok(index.plan !== null);
  assert.deepEqual(checksOf(index.plan), ["20:46 number"]);
  assertRuns(
    index.plan,
    "the index",
    [],
    [
      [1, null],
      [0.5, "TSR024@59:61"],
      [2, "TSR025@59:61"],
      ["x", "TSR058@37:46"],
    ],
  );

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
  assertRuns(
    host.plan,
    "the parenthesised count",
    [],
    [
      [2, null],
      [1.5, "TSR043@9:18"],
    ],
  );
  const hostIndex = candidate("let xs = [1, 2]\nlet y = xs[(hostValue)]\nexit\n");
  assert.deepEqual(sited(hostIndex), ["warning TSV043@28"]);
  assert.ok(hostIndex.plan !== null);
  assertRuns(
    hostIndex.plan,
    "the parenthesised index",
    [],
    [
      [1, null],
      [0.5, "TSR024@28:37"],
    ],
  );
});

/**
 * §5.2's evaluator against the engine where a value is parenthesised (Codex r20 H4): a count's, an index's and a checked
 * store's failure is sited at the content, as the engine reports it, and the store's checked value span with it.
 */
test("the derived evaluator sites a parenthesised value's failure at its content, as the engine does (§5.2, H4)", () => {
  for (const [source, hostValue, failure] of [
    ['repeat (hostValue) {\n  say "RUN"\n}\nexit\n', 2.5, "TSR043@8:17"],
    ["let xs = [1, 2]\nlet y = xs[(hostValue)]\nexit\n", 0.5, "TSR024@28:37"],
    ['let out = ([1, hostValue][1])\nsay "AFTER"\nexit\n', "text", "TSR058@11:28"],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { stores } = derive(source, compactAnalysis(request));
    const compiled = inBothOrders(() => candidate(source));
    assert.ok(compiled.plan !== null, source);
    assert.deepEqual(plannedStores(compiled.plan), derivedStores(stores), source);
    const ran = runGlobals(compiled.plan, { hostValue });
    assert.equal(ran.failure, failure, source);
    assert.deepEqual(ran, evaluate(source, stores, { hostValue }).run, source);
  }
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
  const [{ plan }, compiled] = inBothOrdersAs(
    () => candidate(host),
    (result) => ({
      diagnostics: sited(result),
      checked: result.plan === null ? null : checksOf(result.plan),
    }),
  );
  assert.deepEqual(compiled, {
    diagnostics: ["warning TSV041@29"],
    checked: ["20:47 list<list<integer>>"],
  });
  assert.ok(plan !== null);
  assert.deepEqual(runWith(plan, 2), { status: "halted", says: ["AFTER"], failure: null });
  assert.deepEqual(runWith(plan, "bad"), { status: "failed", says: [], failure: "TSR058@29:47" });
});

test("a projected written integer list stays strict on the candidate route (A4, round 15 B3)", () => {
  const source = 'let typed: integer[] = [1]\nlet xs = [typed][0]\nxs = [2.5]\nsay "AFTER"\nexit\n';
  const [compiled, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
  assert.deepEqual(diagnostics, [`error TSV041@${source.indexOf("2.5")}`]);
  assert.equal(compiled.plan, null);
});

test("a projection of a written nested list stays strict on the candidate route (A4, F12, Astra r2 B2)", () => {
  const source =
    'let source: integer[][] = [[4]]\nlet result = source[0]\nresult = [3.5]\nsay "AFTER"\nexit\n';
  const [compiled, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
  assert.deepEqual(diagnostics, [`error TSV041@${source.indexOf("3.5")}`]);
  assert.equal(compiled.plan, null);
});

test("a written scalar a singleton literal gives stays strict on the candidate route (A4, Codex r16 B1)", () => {
  const source = 'let typed: integer = 1\nlet xs = [typed][0]\nxs = 2.5\nsay "AFTER"\nexit\n';
  const [compiled, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
  assert.deepEqual(diagnostics, [`error TSV041@${source.lastIndexOf("2.5")}`]);
  assert.equal(compiled.plan, null);
});

/** The admitted type of the binding `name` at `path`: its kinds and its decider's offset. */
function admittedOf(source: string, name: string, path: readonly string[] = []): string {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  // (the core numbers its places alike in every analysis of a request)
  const place = new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === name,
  );
  assert.ok(place !== undefined, `${source}: ${name}'s place`);
  const admitted = analyseCore(request).place(place.id, path).admitted;
  return admitted.by === "decided"
    ? `decided ${admitted.kinds.join("|")}@${admitted.decider?.start ?? "-"}`
    : admitted.by;
}

test("a place published with a kind checks the external data stored into it, named or inline, at any endpoint (A7, C9 r4.12, r4.50 (1), R4-F1)", () => {
  // the external reviewer's endpoint matrix: per kind (a known element, a fitting host value and bad ones, an integer's
  // fractional one too), projection (an index, a nested index, parentheses, an index held in a variable), host data
  // inline or named, and without or with a later store: the place is decided by the known element (or the later store),
  // named data warns where it is read with its check, inline data has its boundary, the declaration's store alone checks
  // the kind, a bad value fails at the declaration's value with nothing said, and the fitting one says AFTER and halts
  const kinds = [
    ["1", 2, ["bad", 2.5]],
    ['"a"', "b", [1]],
    ["true", false, ["bad"]],
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
          assert.equal(admittedOf(source, "out"), `decided ${kind}@${decider}`, source);
          // (named data warns where it is read; with a later decider, C1 warns at the stored value, inline data at
          // its host value)
          const value = declaration + "let out = ".length;
          const end = source.indexOf("\n", declaration);
          const data = named ? source.indexOf("raw", declaration) : source.indexOf("hostValue");
          const warned = named ? (later ? value : data) : later ? data : null;
          const [{ plan }, compiled] = inBothOrdersAs(
            () => candidate(source),
            (result) => ({
              diagnostics: sited(result),
              checks: result.plan === null ? null : checksOf(result.plan),
            }),
          );
          assert.deepEqual(
            compiled,
            {
              diagnostics: warned === null ? [] : [`warning TSV041@${warned}`],
              checks: [`${declaration}:${end} ${kind}`],
            },
            source,
          );
          assert.ok(plan !== null, source);
          assert.deepEqual(
            runWith(plan, good),
            { status: "halted", says: ["AFTER"], failure: null },
            `${source} with ${JSON.stringify(good)}`,
          );
          for (const refused of bad)
            assert.deepEqual(
              runWith(plan, refused),
              { status: "failed", says: [], failure: `TSR058@${value}:${end}` },
              `${source} with ${JSON.stringify(refused)}`,
            );
          shapes += 1;
        }
  assert.equal(shapes, 48);
  // the controls: host data alone admits no kind (nothing to check it against), known elements need no check
  for (const [source, admitted] of [
    ['let raw = hostValue\nlet out = [raw][0]\nsay "AFTER"\nexit\n', "undecided"],
    ['let out = [1, 2][1]\nsay "AFTER"\nexit\n', "decided integer@10"],
  ] as const) {
    assert.equal(admittedOf(source, "out"), admitted, source);
    const [{ plan }, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
    assert.deepEqual(diagnostics, [], source);
    assert.ok(plan !== null, source);
    assert.deepEqual(checksOf(plan), [], source);
    assert.deepEqual(
      runWith(plan, "bad"),
      { status: "halted", says: ["AFTER"], failure: null },
      source,
    );
  }
});

/**
 * Per carrier kind, the ways a declaration gives host data through the carrier beside a known integer, each at a scalar
 * endpoint (the place's value) and at a collection one (its element): the data inside a literal operand, the whole
 * operand, the operation's own read, or the receiver whose member the runtime reads (F15, r4.60: the destination's own
 * check beside C5's obligation on the receiver). `lists` counts the lists around the host value at each endpoint;
 * `read` names the read that brings the data into the declaration where it is not the data's (a loop variable).
 */
interface CarrierShape {
  readonly data: string;
  readonly scalar: string;
  readonly collection: string | { readonly none: string };
  /** Where the data stands by the rule function's terms (§5.1's rows), per endpoint where they differ. */
  readonly rule: Rule | ((endpoint: Endpoint) => Rule);
  readonly lists?: readonly [scalar: number, collection: number];
  readonly read?: string;
}

/** A shape's class for the rule function (`owed`): its data's row and the carrier's facts. */
type Rule = Omit<RuleClass, "carrier" | "placement" | "form" | "endpoints">;

const CARRIER_SHAPES: Readonly<Record<CarrierKind, readonly CarrierShape[]>> = {
  projection: [
    {
      data: "in a literal",
      scalar: "let out = [1, D][1]",
      collection: "let out = [[1, D]][0]",
      rule: { data: "cell", declares: true },
    },
    {
      data: "a member",
      scalar: "let out = [1, D[0]][1]",
      collection: "let out = [[1], D[0]][1]",
      lists: [1, 2],
      rule: { data: "member", declares: true, member: (h) => `${h}[0]` },
    },
  ],
  iteration: [
    {
      data: "in a literal",
      scalar: "for entry in [1, D] {\n  let out = entry\n  LATER\n}",
      collection: "for entry in [[1, D]] {\n  let out = entry\n  LATER\n}",
      rule: { data: "loop-cell", loop: true },
    },
    {
      data: "a member",
      scalar: "for entry in D {\n  let out = [1, entry][1]\n  LATER\n}",
      collection: "for entry in D {\n  let out = [[1], entry][1]\n  LATER\n}",
      lists: [1, 2],
      read: "entry",
      rule: { data: "loop-operand", loop: true, declares: true },
    },
  ],
  otherwise: [
    {
      data: "the operand",
      scalar: "let out = D otherwise 1",
      collection: "let out = D otherwise [1]",
      lists: [0, 1],
      rule: { data: "whole" },
    },
  ],
  get: [
    {
      data: "in a literal",
      scalar: "let out = [1, D].get(1, default: 1)",
      collection: "let out = [[1, D]].get(0, default: [])",
      rule: { data: "cell", declares: true },
    },
    {
      data: "a member",
      scalar: "let out = D.get(0, default: 1)",
      collection: "let out = D.get(0, default: [1])",
      lists: [1, 2],
      rule: { data: "member", member: (h, k) => `${h}.get(0, default: ${k})` },
    },
  ],
  "load default": [
    {
      data: "its own read",
      scalar: 'let out = load("k", default: [1, D][1])',
      collection: 'let out = load("k", default: [1, D])',
      rule: { data: "typed", own: (k, _, h) => (k === "1" ? `[1, ${h}][1]` : `[1, ${h}]`) },
    },
  ],
  "parse default": [
    {
      data: "its own read",
      scalar: 'let out = fromJson("1", default: [1, D][1])',
      collection: 'let out = fromJson("[]", default: [1, D])',
      rule: { data: "typed", own: (k, _, h) => (k === "1" ? `[1, ${h}][1]` : `[1, ${h}]`) },
    },
  ],
  copy: [
    {
      data: "in a literal",
      scalar: "let out = [1, D].take(2)[1]",
      collection: "let out = [1, D].take(2)",
      rule: { data: "cell", declares: true },
    },
    {
      data: "a member",
      scalar: "let out = [1, D.take(1)[0]][1]",
      collection: "let out = [[1], D.take(1)][1]",
      lists: [1, 1],
      // (the copy is what the operation reads of its receiver, the member C1 sits at: r4.60)
      rule: { data: "member", declares: true, member: (h) => `${h}.take(1)`, listed: true },
    },
  ],
  removal: [
    {
      data: "in a literal",
      scalar: "let out = [1, D].removeFirst()",
      collection: "let out = [[1, D]].removeFirst()",
      rule: { data: "cell", combining: true },
    },
    {
      data: "a member",
      scalar: "let out = [1, D.removeFirst()][1]",
      collection: "let out = [[1], D.removeFirst()][1]",
      lists: [1, 2],
      rule: { data: "member", declares: true, member: (h) => `${h}.removeFirst()` },
    },
  ],
  concatenation: [
    {
      data: "the operand",
      scalar: "let out = ([1] + D)[1]",
      collection: "let out = [1] + D",
      lists: [1, 1],
      // (an element of the result is a member of the data; the result itself a list whatever the data holds)
      rule: (endpoint) =>
        endpoint === "scalar"
          ? { data: "through", combining: true }
          : { data: "whole", combining: true, listed: true },
    },
  ],
  choice: [
    {
      data: "an option",
      scalar: "let out = askChoice 1, D",
      collection: { none: "a button's value is never a list or a set (V30 §19, TSV029)" },
      rule: { data: "cell" },
    },
  ],
};

/**
 * Invariant O over the carrier table (`carriers.ts`), without exception (r4.60): each kind of `CARRIER_KINDS` has its
 * shapes, each named or inline, without and with a later store, in both orders. The place is admitted an integer where
 * the data stands (published or decided), and the shape's complete multiset of C1, C9 and C10 records is what the rule
 * function owes (`type-core-rule.ts`, §5.1): named data A7's `copy-type` warning and check (r4.50 (1)) beside its source's
 * own boundary, inline data C9's boundary or C1's check (r4.12, r4.63 (1)), a member's C1 at what is read of it (r4.60),
 * data in the operation's own read the operation's boundary (C10, r4.57), every site and multiplicity (Astra r5 D2).
 * Where the candidate route reaches a shape (TABLE r4.59), its plan checks the declaration against the whole type, a
 * fitting value says AFTER and halts, and each bad one fails at the declaration's value with nothing said; a shape
 * outside the slice is proved at the answers, the route's reason reported.
 */
test("every carrier kind leaves an obligation for the external data it gives a place admitted a kind (O, A7, C9 r4.12, C10, r4.59)", (t) => {
  assert.deepEqual(Object.keys(CARRIER_SHAPES).sort(), [...CARRIER_KINDS].sort());
  const outside = new Map<string, string>();
  const none: string[] = [];
  let shapes = 0;
  let routed = 0;
  for (const kind of CARRIER_KINDS)
    for (const { data: placed, scalar, collection, rule, lists = [0, 0], read } of CARRIER_SHAPES[
      kind
    ])
      for (const [endpoint, template, wrap] of [
        ["scalar", scalar, lists[0]],
        ["collection", collection, lists[1]],
      ] as const) {
        if (typeof template !== "string") {
          none.push(`${kind} at a collection: ${template.none}`);
          continue;
        }
        const shape: string = template;
        for (const named of [false, true])
          for (const later of [false, true]) {
            const store = endpoint === "scalar" ? "out = 1" : "out = [1]";
            const filled = shape.replace("D", named ? "raw" : "hostValue");
            const body: string = filled.includes("LATER")
              ? filled.replace(later ? "LATER" : /\n *LATER/, later ? store : "")
              : `${filled}${later ? `\n${store}` : ""}`;
            const source: string = `${named ? "let raw = hostValue\n" : ""}${body}\nsay "AFTER"\nexit\n`;
            const name =
              `${kind}, the data ${placed}, at a ${endpoint}, ${named ? "named" : "inline"}` +
              (later ? ", a later store" : "");
            // the data's read, and the statement that holds it: its place and its value
            const data =
              read !== undefined
                ? source.indexOf(read, source.indexOf("let out"))
                : named
                  ? source.indexOf("raw", source.indexOf("\n"))
                  : source.indexOf("hostValue");
            const holder = source.lastIndexOf("\n", data) + 1;
            const end = source.indexOf("\n", holder);
            const [opening] = /^ *(?:let|for) \w+ (?:=|in) /.exec(source.slice(holder))!;
            const value = holder + opening.length;
            // the complete C1, C9 and C10 multiset the rule function owes (S6-CARRIERS §5.1), the named source's own
            // boundary, every site and multiplicity included, in both orders (Astra r5 D2)
            const owes = typeof rule === "function" ? rule(endpoint) : rule;
            assert.deepEqual(
              records(source),
              owed(
                { carrier: kind, placement: placed, form: () => "", endpoints: BOTH, ...owes },
                endpoint,
                named,
                later,
                source,
                "raw",
              ),
              name,
            );
            assert.equal(
              admittedOf(source, "out", endpoint === "scalar" ? [] : ["element"]).split("@")[0],
              "decided integer",
              name,
            );
            shapes += 1;
            let compiled: readonly [
              CompilationResult,
              { readonly checks: readonly string[] | null },
            ];
            try {
              compiled = inBothOrdersAs(
                () => candidate(source),
                (result) => ({ checks: result.plan === null ? null : checksOf(result.plan) }),
              );
            } catch (error) {
              if (!(error instanceof CandidateOutsideSlice)) throw error;
              outside.set(`${kind} (${placed})`, error.what.replace(/^this /, ""));
              continue;
            }
            const [result, { checks }] = compiled;
            assert.deepEqual(
              checks,
              [`${holder}:${end} ${endpoint === "scalar" ? "integer" : "list<integer>"}`],
              name,
            );
            const plan = result.plan!;
            const host = (
              scalar: SerializableRuntimeValue,
              depth = wrap,
            ): SerializableRuntimeValue =>
              depth === 0 ? scalar : { kind: "list", items: [host(scalar, depth - 1)] };
            assert.deepEqual(
              runWith(plan, host(2)),
              { status: "halted", says: ["AFTER"], failure: null },
              `${name} with 2`,
            );
            for (const bad of ["bad", 2.5])
              assert.deepEqual(
                runWith(plan, host(bad)),
                { status: "failed", says: [], failure: `TSR058@${value}:${end}` },
                `${name} with ${JSON.stringify(bad)}`,
              );
            routed += 1;
          }
      }
  t.diagnostic(
    `${shapes} shapes, ${routed} on the candidate route; outside the slice until S7–S9b (the answers only): ` +
      [...outside].map(([shape, what]) => `${shape}: ${what}`).join(", ") +
      `; no shape: ${none.join("; ")}`,
  );
});

/**
 * A copy of a written binding keeps its type beside an unwritten copy of the same source (A4, TABLE r4.72, Astra r5
 * B1): `let a = raw`, `let b: integer[] = raw`, then `out` takes both, and a later store brings other host data. The
 * written copy decides `out`'s element by `integer[]`, whichever copy comes first, at depths one and two: each of the
 * three stores owes its C1 against the whole written type, the host data its boundary; the plan checks every store; the
 * fitting host value says AFTER and each bad one fails at the third store's value, nothing said.
 */
test("a copy of a written binding keeps its type beside a copy of the same source, in both orders (A4, TABLE r4.72)", () => {
  for (const nested of [false, true])
    for (const [first, second] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const wrap = (text: string): string => (nested ? `[${text}]` : text);
      const source =
        `let raw = [${wrap("hostValue")}]\nlet a = raw\nlet b: integer[]${nested ? "[]" : ""} = raw\n` +
        `let out = ${first}\nout = ${second}\nout = [${wrap("otherHost")}]\nsay "AFTER"\nexit\n`;
      const name = `${nested ? "depth two" : "depth one"}, ${first} then ${second}`;
      const target = nested ? "out.element.element" : "out.element";
      const at = (text: string, from = 0): string => {
        const start = source.indexOf(text, from);
        return `${start}:${start + text.length}`;
      };
      const host = at("otherHost");
      const tail = source.indexOf("out = [");
      const checks = inBothOrders(() => {
        const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "otherHost"]);
        assert.ok(request !== null, name);
        return compactAnalysis(request)
          .checks.filter((check) => check.target === target && check.kind === "copy-type")
          .map(
            (check) =>
              `${check.boundary ? "B" : "C"} [${check.against.join("|")}] ${check.site.offset}:${check.site.end}`,
          )
          .sort();
      });
      assert.deepEqual(
        checks,
        [
          `C [integer] ${at(first, source.indexOf("let out = "))}`,
          `C [integer] ${at(second, source.indexOf("\nout = "))}`,
          `C [integer] ${host}`,
          `B [integer] ${host}`,
        ].sort(),
        name,
      );
      const options = { globals: ["hostValue", "otherHost"] };
      const plan = inBothOrders(() => compileSourceWithBackend(source, options, CORE_BACKEND).plan);
      assert.ok(plan !== null, name);
      const type = nested ? "list<list<integer>>" : "list<integer>";
      // (each statement's span: `b`'s declaration, which holds host data under its written type, and out's three stores)
      const line = (text: string): string => {
        const start = source.indexOf(text);
        return `${start}:${source.indexOf("\n", start)} ${type}`;
      };
      assert.deepEqual(
        checksOf(plan),
        [line("let b"), line("let out"), line(`out = ${second}`), line("out = [")],
        `${name}: b's store and every store of out checked`,
      );
      const end = source.indexOf("\n", tail);
      for (const otherHost of [1, 2.5, "bad"]) {
        const result = run(
          plan,
          createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue: 1, otherHost } }),
        );
        const failure = result.events.find((event) => event.kind === "runtimeFailure");
        assert.deepEqual(
          {
            status: result.snapshot.status,
            says: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
            failure:
              failure?.kind === "runtimeFailure"
                ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
                : null,
          },
          otherHost === 1
            ? { status: "halted", says: ["AFTER"], failure: null }
            : { status: "failed", says: [], failure: `TSR058@${tail + 6}:${end}` },
          `${name} with ${JSON.stringify(otherHost)}`,
        );
      }
    }
});

/**
 * A checked store followed by an effect inside a branch (S6-CARRIERS §5.3, Astra r5 D3): the declaration owes exactly
 * its C1 and its boundary, the plan checks it against `integer` before the branch, the fitting host value says AFTER
 * and halts, and each bad one fails at the declaration's value before the branch's effect, nothing said.
 */
test("a checked store's check runs before an effect inside a later branch (S6-CARRIERS §5.3)", () => {
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
 * A2 with F17b and A8: of a literal's elements, one read the literal's `get` never gives and a direct read of the same
 * snapshot beside it, the direct read decides; a walk's stop shares another's only through the same operations, selected
 * alike (Astra r5 D1): the decider is the direct `raw` at 68:71, never the later `"tail"`.
 */
test("a decider beside an unselected read of its source is the selected read itself (A2, F17b, Astra r5 D1)", () => {
  const source =
    'let raw = hostValue\nraw = 1\nlet out = [[raw].get(9, default: null), raw, "tail"]\nrepeat out[0] {}\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const place = new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === "out",
  )!;
  assert.deepEqual(
    inBothOrders(() => analyseCore(request).place(place.id, ["element"]).admitted),
    { by: "decided", kinds: ["integer", "null"], decider: { file: 0, start: 68, end: 71 } },
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
 * AD-3 (TABLE r4.52; X1 drops flow facts, never a written type): host data stored into a written place in dead code (a
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
 * The owner's rule (TABLE r4.59) over a sample of the cells the candidate route reaches: host data, its slice's ingress,
 * inline and named, into a written, a decided and a published place, at a scalar and at a collection endpoint. Each
 * program compiles alike in both orders and checks exactly the store that brings the data, against the whole type its
 * place holds there (the host value's kind at the value's position: an element's, a nested element's). A fitting host
 * value says AFTER and halts; each bad one fails at that store's value with TSR058, nothing said.
 */
test("a sample of the slice's cells checks host data in the plan and stops a bad value before the next effect (r4.59)", () => {
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
      "decided list element, inline",
      "let xs = [1, hostValue]",
      "",
      "list<integer>",
      2,
      ["bad", 2.5],
    ],
    [
      "decided list element, named",
      "let raw = hostValue\nlet xs = [1, raw]",
      "let xs",
      "list<integer>",
      2,
      ["bad", 2.5],
    ],
    [
      "decided nested list element, inline",
      "let xs = [[1], [hostValue]]",
      "",
      "list<list<integer>>",
      2,
      ["bad", 2.5],
    ],
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
    'let count: number = hostValue\nsay "checked"\nrepeat count {\n  say "turn"\n}\nexit\n';
  const compiled = candidate(source);
  assert.ok(compiled.plan !== null);
  const plan = compiled.plan;
  assert.deepEqual(checksOf(plan), ["0:29 number"]);
  // (the repeat's own count check, the runtime's: TSR043 at the count, nothing said after it)
  const count = source.indexOf("count {");
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
