import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend, compileSourceWithBackend } from "../../../src/compiler.js";
import { INSTRUCTION_PLAN_VERSION, type InstructionPlan } from "../../../src/plan/model.js";
import { validateInstructionPlan } from "../../../src/plan/validation.js";
import { run } from "../../../src/runtime/engine.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import {
  createSerializableList,
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withTestDemandAllowance } from "../../../src/type-inference/core/budget.js";
import { withoutRecords } from "../../../src/type-inference/core/consumers.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { planFileOf } from "../../helpers/site-keys.js";
import { completedCore, coreRequest } from "../../helpers/type-core-analysis.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";
import { partProblems } from "../../helpers/type-core-oracles.js";

/*
 * A typed part below a variable that holds host data (#1224, the lead's ruling (c)): the analysis owes the part's check
 * at each store that brings host data into the variable, and the store checks that part of the stored value
 * (`partChecks`) where its own check does not reach it. Three layers each (docs/TESTING.md, runtime-check evidence):
 * the owed obligation, the plan's part check, and the run with a fitting and a misfitting value, the same after a
 * checkpoint restore.
 */

const GLOBALS = ["hostInit", "hostValue"];

/** A plain JavaScript value as a runtime value: objects and lists built through the validating constructors. */
function value(of: unknown): SerializableRuntimeValue {
  if (Array.isArray(of)) return createSerializableList(of.map(value));
  if (of !== null && typeof of === "object")
    return createSerializableObject(
      Object.entries(of).map(([name, each]) => ({ name, value: value(each) })),
    );
  // EVIDENCE: invariant: the cases give only text, numbers, booleans and null beside objects and lists.
  return of as SerializableRuntimeValue;
}

/** Each store's part checks as `kind@start: path type place`, a path's steps as `.name` or `[]`. */
function partChecks(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.partChecks !== undefined
      ? instruction.partChecks.map(
          (part) =>
            `${instruction.kind}@${instruction.span.so} ${part.path.map((step) => ("property" in step ? `.${step.property}` : "[]")).join("")} ${JSON.stringify(part.type)} ${part.place}`,
        )
      : [],
  );
}

/** A run to its end, and the same run from a checkpoint taken before it starts: what it said and how it failed. */
function ran(plan: InstructionPlan, globals: Record<string, unknown>) {
  const snapshot = createImmediatePacingRuntimeSnapshot(plan, {
    globals: Object.fromEntries(Object.entries(globals).map(([name, of]) => [name, value(of)])),
  });
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  const [direct, resumed] = [run(plan, snapshot), run(restored.plan, restored.snapshot)].map(
    (result) => {
      const failure = result.events.find((event) => event.kind === "runtimeFailure");
      return {
        said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
        failure:
          failure?.kind === "runtimeFailure"
            ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset} ${failure.message}`
            : null,
      };
    },
  );
  assert.deepEqual(resumed, direct);
  return direct!;
}

/** The analysis's checks of parts below `root`, as `target [kinds] start:end`. */
function owed(source: string, root: string): string[] {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  return analyseCore(request)
    .checks.filter((check) => check.target.startsWith(`${root}.`))
    .map(
      (check) =>
        `${check.target} [${check.against.join(", ")}] ${check.site.start}:${check.site.end}`,
    );
}

function plan(source: string): InstructionPlan {
  const { plan, diagnostics } = compileSourceWithBackend(
    source,
    { globals: GLOBALS },
    CORE_BACKEND,
  );
  assert.ok(plan !== null, diagnostics.map((d) => d.code).join(","));
  assert.deepEqual(validateInstructionPlan(plan).errors, []);
  return plan;
}

/** A plan as JSON data a test edits before validation reads it. */
interface EditablePlan {
  readonly instructions: Record<string, unknown>[];
}

const at = (source: string, text: string): string => {
  const start = source.indexOf(text);
  return `${start}:${start + text.length}`;
};

test("a store of host data checks each typed part below it that the analysis owes, in three layers, in four modes (#1224)", () => {
  for (const c of [
    {
      // the issue's program: a written object below the variable, replaced by host data
      source:
        'let seed: object = {payload: 7}\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
      root: "copy",
      init: { open: {} },
      fits: { open: { x: 1 } },
      misfits: { open: 3 },
      sentence: "'copy.open' holds an object, so it cannot take 3.",
    },
    {
      source:
        'let seed: integer = 7\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
      root: "copy",
      init: { open: 1 },
      fits: { open: 2 },
      misfits: { open: "bad" },
      sentence: `'copy.open' holds a whole number (integer), so it cannot take text (string) "bad".`,
    },
    {
      // a deeper descendant
      source:
        'let seed: integer = 7\nlet copy = hostInit\ncopy.a.b = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
      root: "copy",
      init: { a: { b: 1 } },
      fits: { a: { b: 2 } },
      misfits: { a: { b: "x" } },
      sentence: `'copy.a.b' holds a whole number (integer), so it cannot take text (string) "x".`,
    },
    {
      // several decided children, one part check each
      source:
        'let s: integer = 7\nlet t: string = "x"\nlet copy = hostInit\ncopy.one = s\ncopy.two = t\ncopy = hostValue\nsay "REACHED"\nexit\n',
      root: "copy",
      init: { one: 1, two: "a" },
      fits: { one: 2, two: "b" },
      misfits: { one: 2, two: 2 },
      sentence:
        "'copy.two' holds text (string), so it cannot take 2. To use the value as text, put the value into a text with interpolation.",
    },
    {
      // the elements of a list below the variable
      source:
        'let seed: integer = 7\nlet copy = hostInit\ncopy.xs = [seed]\ncopy = hostValue\nsay "REACHED"\nexit\n',
      root: "copy",
      init: { xs: [1] },
      fits: { xs: [1, 2] },
      misfits: { xs: [1, "x"] },
      sentence: `An element of 'copy.xs' holds a whole number (integer), so it cannot take text (string) "x".`,
    },
    {
      // a property of the elements of a list below the variable, named in words as messages name such a path
      source:
        'let seed: integer = 7\nlet copy = hostInit\ncopy.xs = [{n: seed}]\ncopy = hostValue\nsay "REACHED"\nexit\n',
      root: "copy",
      init: { xs: [{ n: 1 }] },
      fits: { xs: [{ n: 2 }, {}] },
      misfits: { xs: [{ n: 2 }, { n: "x" }] },
      sentence: `'n' of an element of 'copy.xs' holds a whole number (integer), so it cannot take text (string) "x".`,
    },
    {
      // an open level below a checked root: its initializer's check does not reach the part, its store's has none
      source:
        'let seed: integer = 7\nlet copy = {inner: hostInit}\ncopy.inner.open = seed\ncopy.inner = hostValue\nsay "REACHED"\nexit\n',
      root: "copy",
      init: { open: 1 },
      fits: { open: 2 },
      misfits: { open: "x" },
      sentence: `'copy.inner.open' holds a whole number (integer), so it cannot take text (string) "x".`,
    },
  ]) {
    const { source, root } = c;
    const store = source.lastIndexOf("hostValue");
    const site = `${store}:${store + "hostValue".length}`;
    // the decision: the part's check, owed at the store, in every mode alike
    const decided = owed(source, root);
    assert.ok(
      decided.some((check) => check.endsWith(` ${site}`)),
      `${source}: ${decided.join("; ")}`,
    );
    for (const mode of HELD_MODES.slice(1))
      assert.deepEqual(
        mode.run(() => owed(source, root)),
        decided,
        `${source} (${mode.name})`,
      );
    // the plan: a part check at the store, the same in every mode
    const planned = plan(source);
    const parts = partChecks(planned);
    assert.ok(parts.length > 0, source);
    for (const mode of HELD_MODES.slice(1))
      assert.deepEqual(
        mode.run(() => partChecks(plan(source))),
        parts,
        `${source} (${mode.name})`,
      );
    // the run: a fitting value reaches the next effect; a misfitting part stops the store before it, with its sentence
    assert.deepEqual(ran(planned, { hostInit: c.init, hostValue: c.fits }), {
      said: ["REACHED"],
      failure: null,
    });
    assert.deepEqual(ran(planned, { hostInit: c.init, hostValue: c.misfits }), {
      said: [],
      failure: `TSR058@${site} ${c.sentence}`,
    });
    // host data at the first store is checked the same way, at its own site
    assert.match(
      ran(planned, { hostInit: c.misfits, hostValue: c.fits }).failure ?? "",
      /^TSR058@/u,
      source,
    );
  }
});

test("a store checks only the parts the analysis owes there, and a value without the part passes (#1224)", () => {
  const issue =
    'let seed: object = {payload: 7}\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n';
  // the part at the first store and the store that replaces the variable, each its own: path, type, place
  assert.deepEqual(partChecks(plan(issue)), [
    `declareBinding@${issue.indexOf("let copy")} .open {"kind":"object","properties":[]} 'copy.open'`,
    `assign@${issue.indexOf("copy = hostValue")} .open {"kind":"object","properties":[]} 'copy.open'`,
  ]);
  // a value that holds no such part, or is no object, is checked by nothing more than its variable's own type
  for (const replaced of [{}, 3, { other: 1 }])
    assert.deepEqual(ran(plan(issue), { hostInit: { open: {} }, hostValue: replaced }), {
      said: ["REACHED"],
      failure: null,
    });
  // nothing is owed below host data no store types: no part check
  assert.deepEqual(
    partChecks(plan('let copy = hostInit\ncopy.open = 1\ncopy = hostValue\nsay "REACHED"\nexit\n')),
    [],
  );
  assert.deepEqual(
    partChecks(plan('let copy = hostInit\ncopy = hostValue\nsay "REACHED"\nexit\n')),
    [],
  );
  // a root a literal decides is checked whole at its store, its part included: no part check beside it
  const literal =
    'let seed: object = {payload: 7}\nlet copy = {open: seed}\ncopy = hostValue\nsay "REACHED"\nexit\n';
  assert.deepEqual(partChecks(plan(literal)), []);
  assert.match(
    ran(plan(literal), { hostValue: { open: 3 } }).failure ?? "",
    new RegExp(`^TSR058@${at(literal, "hostValue")}`, "u"),
  );
});

/** The demands at which the stopped cases' decisions stop and the receiving completion completes them. */
const DEMANDS = [1, 16, 64];

test("after a demand stop, a store checks the parts the natural walk owes there, by the one rule (#1682)", () => {
  for (const c of [
    {
      name: "an open root",
      source:
        'let seed: object = {payload: 7}\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
      init: { open: {} },
      values: [{ open: 3 }, { open: { x: 1 } }, 3],
    },
    {
      // the replacement's own check `{}` does not reach the owed part below its open level
      name: "a checked root above an open level",
      source:
        'let seed: integer = 7\nlet copy = {inner: hostInit}\ncopy.inner.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
      init: { open: 1 },
      values: [{ inner: { open: "bad" } }, { inner: { open: 2 } }],
    },
    {
      // the natural walk owes `copy.open.n` alone: a value without `open` as an object passes, as unstopped
      name: "a part no stricter than the natural walk's",
      source:
        'let seed: integer = 7\nlet copy = hostInit\ncopy.open = {n: seed}\ncopy = hostValue\nsay "REACHED"\nexit\n',
      init: { open: { n: 1 } },
      values: [{ open: 3 }, { open: { n: "x" } }, { open: { n: 2 } }],
    },
  ]) {
    const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS);
    assert.ok(request !== null, c.name);
    const natural = plan(c.source);
    const naturalRuns = c.values.map((v) => ran(natural, { hostInit: c.init, hostValue: v }));
    assert.ok(partChecks(natural).length > 0, c.name);
    for (const mode of HELD_MODES)
      for (const demand of DEMANDS) {
        const at = `${c.name}, ${mode.name}, demand ${demand}`;
        const stopped = (): InstructionPlan =>
          withTestDemandAllowance(demand, () => plan(c.source));
        // (a decision stopped and the completion completed it, losing nothing)
        const answers: Answers = mode.run(() =>
          withTestDemandAllowance(demand, () => completedCore(request)),
        );
        const completion = answers.budget.closure;
        assert.ok(completion !== null, at);
        assert.equal(completion.counts.unsettled + completion.counts.capped, 0, at);
        // the plan: the natural store's parts, by the natural rule; the runs: as unstopped, also after a restore
        const planned = mode.run(stopped);
        assert.deepEqual(partChecks(planned), partChecks(natural), at);
        assert.deepEqual(partProblems(natural, planned), { problems: [], covered: [] }, at);
        assert.deepEqual(
          c.values.map((v) => ran(planned, { hostInit: c.init, hostValue: v })),
          naturalRuns,
          at,
        );
        // (with the completion's records left out, phase B's plan: no part at the stop)
        assert.deepEqual(
          partChecks(
            mode.run(() =>
              withoutRecords(
                { diagnostic: () => false, check: () => false, completion: true },
                stopped,
              ),
            ),
          ),
          [],
          at,
        );
      }
  }
});

test("at every stop a store's parts are the natural store's or fewer, never uncovered or stricter (#1682)", () => {
  // (the family over the part's depth, several children, elements and their properties, an open or a checked root, an
  // initializer, a replacement and a copy's store, and a literal whose whole check a stop drops: its part is one the
  // natural whole check covers, of the type that check has there)
  const covered: string[] = [];
  let parts = 0;
  let declined = 0;
  for (const source of [
    'let seed: integer = 7\nlet copy = hostInit\ncopy.a.b = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
    'let s: integer = 7\nlet t: string = "x"\nlet copy = hostInit\ncopy.one = s\ncopy.two = t\ncopy = hostValue\nsay "REACHED"\nexit\n',
    'let s: integer = 7\nlet t: string = "x"\nlet copy = hostInit\ncopy.two = t\ncopy.one = s\ncopy = hostValue\nsay "REACHED"\nexit\n',
    'let seed: integer = 7\nlet copy = hostInit\ncopy.xs = [seed]\ncopy = hostValue\nsay "REACHED"\nexit\n',
    'let seed: integer = 7\nlet copy = hostInit\ncopy.xs = [{n: seed}]\ncopy = hostValue\nsay "REACHED"\nexit\n',
    'let seed: integer = 7\nlet copy = {inner: hostInit}\ncopy.inner.open = seed\ncopy.inner = hostValue\nsay "REACHED"\nexit\n',
    'let seed: integer = 7\nlet copy = {known: 1, inner: hostInit}\ncopy.inner.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n',
    'let seed: integer = 7\nlet copy = hostInit\ncopy.open = seed\nlet other = copy\nother = hostValue\nsay "REACHED"\nexit\n',
    'let xs = [hostValue, 4]\nsay "BEFORE"\nsay xs[0]\nsay "AFTER"\nexit\n',
  ]) {
    const natural = plan(source);
    for (const mode of HELD_MODES)
      for (const demand of DEMANDS) {
        let planned: InstructionPlan;
        try {
          planned = mode.run(() => withTestDemandAllowance(demand, () => plan(source)));
        } catch (error) {
          // (a decision stopping in the restarted pass stops the analysis before admission settled: the stop leaves an
          // inferred store's check undecided and the plain gate declines, #2080 part 2)
          if (
            !(error instanceof CandidateOutsideSlice) ||
            error.what !== "a store whose check was left undecided at the budget"
          )
            throw error;
          const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
          assert.ok(request !== null);
          const { budget } = mode.run(() =>
            withTestDemandAllowance(demand, () => analyseCore(request)),
          );
          assert.ok(budget.exhausted !== null && !budget.settled, `${source} (${mode.name})`);
          declined += 1;
          continue;
        }
        const found = partProblems(natural, planned);
        assert.deepEqual(found.problems, [], `${source} (${mode.name}, demand ${demand})`);
        covered.push(...found.covered);
        parts += partChecks(planned).length;
      }
  }
  assert.ok(parts > 0);
  assert.ok(covered.length > 0);
  assert.ok(declined > 0, `${declined} declined`);
  assert.ok(
    covered.every((line) => line.endsWith(" =")),
    covered.join("; "),
  );
});

test("the invariant's projection walks nested unions, so a part stricter than the whole check is no covered one (#1682)", () => {
  // (a valid plan pair, not a compiled one, Codex r1's N1 on #1690: a whole check whose nested union holds an open object
  // accepts `{p: "bad"}`, a part `.p: integer` alone rejects it)
  const source = 'let copy = hostValue\nsay "REACHED"\nexit\n';
  const variant = (edit: (store: Record<string, unknown>) => void): InstructionPlan => {
    const copy: EditablePlan = JSON.parse(JSON.stringify(plan(source)));
    const store = copy.instructions.find(
      (instruction) => instruction["kind"] === "declareBinding",
    )!;
    edit(store);
    // (read back as a plan, which validation checks below)
    const edited: InstructionPlan = JSON.parse(JSON.stringify(copy));
    assert.deepEqual(validateInstructionPlan(edited).errors, []);
    return edited;
  };
  const whole = variant((store) => {
    store["typeCheck"] = {
      type: {
        kind: "union",
        members: [
          { kind: "union", members: [{ kind: "object", properties: [] }, { kind: "null" }] },
          { kind: "object", properties: [{ name: "p", type: { kind: "integer" } }] },
        ],
      },
      place: "'copy'",
    };
  });
  const part = variant((store) => {
    store["partChecks"] = [
      { path: [{ property: "p" }], type: { kind: "integer" }, place: "'copy.p'" },
    ];
  });
  assert.equal(ran(whole, { hostValue: { p: "bad" } }).failure, null);
  assert.match(ran(part, { hostValue: { p: "bad" } }).failure ?? "", /^TSR058@/u);
  const { problems, covered } = partProblems(whole, part);
  assert.equal(problems.length, 1, problems.join("; "));
  assert.deepEqual(covered, []);
});

test("a store is known by its file and offset: a part changed in one of two files with a store at one offset is caught (#1682)", () => {
  // (Astra r1's B1 on #1690: offsets are each file's own, so the two replacements below share one)
  const typed =
    'let seed: integer = 7\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n';
  const untyped =
    'let seed: integer = 7\nlet copy = hostInit\ncopy.open = 1000\ncopy = hostValue\nsay "REACHED"\nexit\n';
  assert.equal(typed.indexOf("copy = hostValue"), untyped.indexOf("copy = hostValue"));
  const files = [
    { path: "main.tease", source: typed },
    { path: "other.tease", source: untyped },
  ];
  const project = (): InstructionPlan => {
    const { plan, diagnostics } = compileProjectWithBackend(
      files,
      { globals: GLOBALS },
      CORE_BACKEND,
    );
    assert.ok(plan !== null, diagnostics.map((d) => d.code).join(","));
    return plan;
  };
  /** Each store's part checks as `file:kind@start path type`. */
  const parts = (planned: InstructionPlan): string[] =>
    planned.instructions.flatMap((instruction, index) =>
      (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
      instruction.partChecks !== undefined
        ? instruction.partChecks.map(
            (part) =>
              `${planned.files[planFileOf(planned, index)]!.path}:${instruction.kind}@${instruction.span.so} ${part.path.map((step) => ("property" in step ? `.${step.property}` : "[]")).join("")} ${JSON.stringify(part.type)}`,
          )
        : [],
    );
  const natural = project();
  const at = typed.indexOf("copy = hostValue");
  assert.ok(parts(natural).includes(`main.tease:assign@${at} .open {"kind":"integer"}`));
  assert.ok(!parts(natural).some((part) => part.startsWith("other.tease:")));
  for (const mode of HELD_MODES)
    for (const demand of DEMANDS) {
      const stopped = mode.run(() => withTestDemandAllowance(demand, project));
      assert.deepEqual(parts(stopped), parts(natural), `${mode.name}, demand ${demand}`);
      assert.deepEqual(
        partProblems(natural, stopped).problems,
        [],
        `${mode.name}, demand ${demand}`,
      );
    }
  // the harmful variant: the first file's part made stricter; the second file's store at the same offset has none
  const copy: EditablePlan = JSON.parse(JSON.stringify(natural));
  const store = copy.instructions.findIndex(
    (instruction, index) =>
      instruction["kind"] === "assign" &&
      Array.isArray(instruction["partChecks"]) &&
      natural.files[planFileOf(natural, index)]!.path === "main.tease",
  );
  assert.ok(store >= 0);
  copy.instructions[store]!["partChecks"] = [
    { path: [{ property: "open" }], type: { kind: "string" }, place: "'copy.open'" },
  ];
  const harmful: InstructionPlan = JSON.parse(JSON.stringify(copy));
  assert.deepEqual(validateInstructionPlan(harmful).errors, []);
  assert.equal(partProblems(natural, harmful).problems.length, 1);
});

test("a stopped store's parts from the settled pass and the completion come in the natural order (#1682)", () => {
  // (at demand 32 `copy.b.y`'s decision is the settled pass's and `copy.a.x`'s the completion's, at one site: the
  // natural order is the published one, `copy.a.x` first)
  const rows = (k: number, row: (i: number) => string): string =>
    Array.from({ length: k }, (_, i) => row(i)).join("\n");
  const source = `let s: integer = 7\nlet t: string = "x"\nlet copy = {a: hostInit, b: hostInit}\n${rows(8, () => "copy.a.x = s")}\n${rows(8, (i) => `let w${i} = copy.a`)}\ncopy.b.y = t\ncopy = hostValue\nsay "REACHED"\nexit\n`;
  const store = `assign@${source.indexOf("copy = hostValue")}`;
  const of = (planned: InstructionPlan): string[] =>
    partChecks(planned).filter((part) => part.startsWith(`${store} `));
  const natural = of(plan(source));
  assert.equal(natural.length, 2);
  for (const mode of HELD_MODES)
    for (const demand of [16, 32, 64])
      assert.deepEqual(
        of(mode.run(() => withTestDemandAllowance(demand, () => plan(source)))),
        natural,
        `${mode.name}, demand ${demand}`,
      );
});

test("plan validation refuses part checks of another shape and a plan of an older revision (#1224)", () => {
  const source =
    'let seed: object = {payload: 7}\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n';
  const planned = plan(source);
  const store = planned.instructions.findIndex(
    (instruction) => instruction.kind === "assign" && instruction.partChecks !== undefined,
  );
  assert.ok(store >= 0);
  const edited = (edit: (instruction: Record<string, unknown>) => void): EditablePlan => {
    const copy: EditablePlan = JSON.parse(JSON.stringify(planned));
    edit(copy.instructions[store]!);
    return copy;
  };
  const errors = (candidate: unknown): string[] =>
    validateInstructionPlan(candidate).errors.map((error) => `${error.code} ${error.path}`);
  // the revision before part checks has none: such a plan is an unsupported revision
  assert.deepEqual(errors({ ...planned, version: INSTRUCTION_PLAN_VERSION - 1 }), [
    "TSC010 $.version",
  ]);
  for (const [edit, path] of [
    [(i: Record<string, unknown>) => (i["partChecks"] = []), ".partChecks"],
    [
      (i: Record<string, unknown>) =>
        (i["partChecks"] = [{ path: [], type: { kind: "integer" }, place: "'x'" }]),
      ".partChecks[0].path",
    ],
    [
      (i: Record<string, unknown>) =>
        (i["partChecks"] = [{ path: [{ index: 0 }], type: { kind: "integer" }, place: "'x'" }]),
      ".partChecks[0].path[0]",
    ],
    [
      (i: Record<string, unknown>) =>
        (i["partChecks"] = [
          { path: [{ element: true }], type: { kind: "nothing" }, place: "'x'" },
        ]),
      ".partChecks[0].type",
    ],
    [
      (i: Record<string, unknown>) =>
        (i["partChecks"] = [{ path: [{ element: true }], type: { kind: "integer" } }]),
      ".partChecks[0].place",
    ],
    [
      (i: Record<string, unknown>) => {
        const parts = Array.isArray(i["partChecks"]) ? i["partChecks"] : [];
        i["partChecks"] = [...parts, ...parts];
      },
      ".partChecks[1]",
    ],
  ] as const)
    assert.ok(
      errors(edited(edit)).some((error) => error.startsWith("TSC002") && error.includes(path)),
      `${path}: ${errors(edited(edit)).join("; ")}`,
    );
});
