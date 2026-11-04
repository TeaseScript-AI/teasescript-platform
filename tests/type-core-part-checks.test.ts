import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import { INSTRUCTION_PLAN_VERSION, type InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import {
  createSerializableList,
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../src/runtime/values/serializable-values.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { HELD_MODES } from "./helpers/type-core-held-host.js";

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
