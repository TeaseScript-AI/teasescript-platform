import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CheckpointError,
  completeAction,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  run,
  serializeCheckpoint,
  type InstructionPlan,
  type RuntimeSnapshot,
} from "../src/index.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { sayTexts } from "./helpers/runtime-events.js";

// A parameter without a type or default is unknown, so `pick(...)` gives a value the compiler cannot know.
const PICK = "function pick(value) {\n    return value\n}\n";

/** The runtime failure of a valid program as code, message, and the source its span covers. */
function failure(source: string) {
  const fault = runValidSource(source).snapshot.failure;
  return fault === null
    ? null
    : [fault.code, fault.message, source.slice(fault.span.start.offset, fault.span.end.offset)];
}

test("each typed place rejects a value of another type that the compiler cannot know", () => {
  for (const [statements, message, span] of [
    [
      'let count: integer = pick("x")',
      "'count' holds a whole number (integer), so it cannot take text (string).",
      'pick("x")',
    ],
    [
      "let count = 1\ncount = pick(2.5)",
      "'count' holds a whole number (integer), so it cannot take a number.",
      "pick(2.5)",
    ],
    [
      "let count = 1\ncount += pick(0.5)",
      "'count' holds a whole number (integer), so it cannot take a number.",
      "count += pick(0.5)",
    ],
    [
      'let items = [1, 2]\nitems[1] = pick("x")',
      "An element of 'items' holds a whole number (integer), so it cannot take text (string).",
      'pick("x")',
    ],
    [
      'let door = { locked: true }\ndoor.locked = pick("no")',
      "Property 'door.locked' holds true or false (boolean), so it cannot take text (string).",
      'pick("no")',
    ],
    [
      'let items = [1]\nitems.add(pick("x"))',
      "An element of 'items' holds a whole number (integer), so it cannot take text (string).",
      'pick("x")',
    ],
    [
      'let tags = set["a"]\ntags.add(pick(1))',
      "An element of 'tags' holds text (string), so it cannot take a whole number (integer).",
      "pick(1)",
    ],
    [
      "function shout(times = 1) {\n    return times\n}\nshout(times: pick(0.5))",
      "Parameter 'times' of 'shout' holds a whole number (integer), so it cannot take a number.",
      "pick(0.5)",
    ],
    [
      'function rest(seconds: number = pick("long")) {\n    return seconds\n}\nrest()',
      "Parameter 'seconds' of 'rest' holds a number, so it cannot take text (string).",
      'pick("long")',
    ],
    [
      // A `return` of an unknown value leaves an inferred result unknown, so the receiving place checks it.
      'function level(known: boolean) {\n    if known {\n        return 1\n    }\n    return pick("high")\n}\nlet count: integer = level(false)',
      "'count' holds a whole number (integer), so it cannot take text (string).",
      "level(false)",
    ],
    [
      "function score(base): integer {\n    return pick(base)\n}\nscore(2.5)",
      "The result of 'score' holds a whole number (integer), so it cannot take a number.",
      "pick(base)",
    ],
  ] as const) {
    assert.deepEqual(failure(`${PICK}${statements}\nexit`), ["TSR058", message, span], statements);
  }
});

test("a value with unknown parts is checked part by part", () => {
  for (const [statements, message] of [
    [
      "let values: integer[] = [pick(1), pick(true)]",
      "'values' holds a list (integer[]), so it cannot take a list with true or false (boolean) at [1].",
    ],
    [
      'let grid = [[1]]\ngrid = pick([[1], [2, pick("x")]])',
      "'grid' holds a list (integer[][]), so it cannot take a list with text (string) at [1][1].",
    ],
    [
      'let door = { locked: true, code: 1 }\ndoor = pick({ code: 2, locked: "no" })',
      "'door' holds an object, so it cannot take an object with text (string) at .locked.",
    ],
    [
      "let door = { locked: true }\ndoor = pick([true])",
      "'door' holds an object, so it cannot take a list.",
    ],
    [
      "let doors = [{ locked: true }]\ndoors.add(pick({ locked: 1 }))",
      "An element of 'doors' holds an object, so it cannot take an object with a whole number (integer) at .locked.",
    ],
    [
      "let best = null\nbest = 1\nbest = pick(2.5)",
      "'best' holds a whole number (integer) or null, so it cannot take a number.",
    ],
  ] as const) {
    assert.deepEqual(
      failure(`${PICK}${statements}\nexit`)?.slice(0, 2),
      ["TSR058", message],
      statements,
    );
  }
});

test("values that fit their place pass the runtime check unchanged", () => {
  const result = runValidSource(
    PICK +
      [
        // A whole number is an integer however it was written; an integer is also a number.
        "let count: integer = pick(2.0)",
        "let ratio: number = pick(3)",
        "let none: integer[] = pick([])",
        "let maybe: integer? = pick(null)",
        // An object type checks only the properties the value has.
        "let door = { locked: true }",
        "door = pick({ open: 1 })",
        // The place's type is decided after this check by the later first value.
        "let best = null",
        "best = pick(4)",
        "best = 5",
        "function shout(times = 1) {\n    return times\n}",
        "let shouted = shout(pick(3))",
        'say "${count} ${ratio} ${none.length} ${maybe} ${best} ${shouted}"',
        "exit",
      ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["2 3 0 null 5 3"]);
});

test("checked programs resume equivalently from a checkpoint at every instruction", () => {
  assertRuntimeResumeEquivalent(
    [
      "function slow(value) {",
      "    wait 1 s",
      "    return value",
      "}",
      "function shout(times: integer = slow(2)) {",
      "    return times",
      "}",
      "function rank(first: boolean): integer {",
      "    if first {",
      "        return 1",
      "    }",
      "    return slow(2)",
      "}",
      'let count: integer = load "count", default: slow(1)',
      "count += slow(3)",
      "let items = [count]",
      "items.add(slow(5))",
      "items[0] = slow(6)",
      "let door = { locked: true }",
      "door.locked = slow(false)",
      "let total = shout() + shout(slow(4)) + rank(false)",
      'say "${count} ${items[0]} ${items[1]} ${door.locked} ${total}"',
      "exit",
    ].join("\n"),
  );
});

test("a checked value from an interaction is checked when the answer resumes the script", () => {
  const plan = compileValidPlan(
    PICK + 'let count: integer = pick(askNumber "How many?")\nsay "${count}"\nexit',
  );
  const answer = (snapshot: RuntimeSnapshot, submittedText: string) => {
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction");
    const completed = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "number",
      payload: { kind: "submittedText", submittedText },
    });
    assert.equal(completed.outcome.kind, "completed");
    return run(plan, completed.snapshot);
  };
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  const restored = (): RuntimeSnapshot =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, waiting))).snapshot;
  for (const [submittedText, outcome] of [
    ["3", "3"],
    ["2.5", "'count' holds a whole number (integer), so it cannot take a number."],
  ] as const) {
    const direct = answer(waiting, submittedText);
    const resumed = answer(restored(), submittedText);
    assert.deepEqual(resumed.snapshot, direct.snapshot, submittedText);
    assert.deepEqual(resumed.events, direct.events, submittedText);
    assert.equal(
      direct.snapshot.failure?.message ?? sayTexts(direct).join(""),
      outcome,
      submittedText,
    );
  }
});

test("plan validation rejects malformed type checks at their paths", () => {
  const compiled = compileValidPlan(
    PICK +
      [
        "let maybe: integer? = pick(1)",
        "let items = [1]",
        "items.add(pick(2))",
        'let door = { locked: true, name: "x" }',
        "door = pick(door)",
        "exit",
      ].join("\n"),
  );
  type Mutable = Record<string, unknown>;
  const isMutable = (value: unknown): value is Mutable =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // Follows a validator path such as `$.instructions[3].typeCheck.type` to the object it names.
  const locate = (plan: unknown, path: string): Mutable => {
    let current = plan;
    for (const step of path.slice(2).split(/[.[\]]+/u)) {
      if (step === "") continue;
      if (Array.isArray(current)) current = current[Number(step)];
      else if (isMutable(current)) current = current[step];
      else assert.fail(path);
    }
    assert.ok(isMutable(current), path);
    return current;
  };

  const instruction = (plan: InstructionPlan, kind: string, name?: string): string =>
    `$.instructions[${plan.instructions.findIndex(
      (candidate) =>
        candidate.kind === kind &&
        (name === undefined || ("name" in candidate && candidate.name === name)),
    )}]`;
  const maybe = instruction(compiled, "declareBinding", "maybe");
  const door = `${instruction(compiled, "assign")}.typeCheck`;
  const add = `${instruction(compiled, "evaluate")}.expression`;
  const checkpoint = createCheckpoint(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  for (const [description, path, mutate, expected] of [
    [
      "unknown type kind",
      `${maybe}.typeCheck.type.members[0]`,
      (type: Mutable) => (type.kind = "whole"),
      `${maybe}.typeCheck.type.members[0].kind`,
    ],
    [
      "empty union",
      `${maybe}.typeCheck.type`,
      (type: Mutable) => (type.members = []),
      `${maybe}.typeCheck.type.members`,
    ],
    [
      "missing place",
      `${maybe}.typeCheck`,
      (check: Mutable) => delete check.place,
      `${maybe}.typeCheck.place`,
    ],
    [
      "empty place",
      `${maybe}.typeCheck`,
      (check: Mutable) => (check.place = ""),
      `${maybe}.typeCheck.place`,
    ],
    [
      "missing element",
      `${add}.typeCheck.type`,
      (type: Mutable) => (type.kind = "list"),
      `${add}.typeCheck.type.element`,
    ],
    [
      "duplicate property",
      `${door}.type`,
      (type: Mutable) => {
        assert.ok(Array.isArray(type.properties));
        type.properties = [...type.properties, type.properties[0]];
      },
      `${door}.type.properties[2].name`,
    ],
    [
      "property field",
      `${door}.type.properties[0]`,
      (property: Mutable) => (property.optional = true),
      `${door}.type.properties[0].optional`,
    ],
    [
      "check on another call",
      `${add}.callee`,
      (callee: Mutable) => (callee.name = "contains"),
      `${add}.typeCheck`,
    ],
    // The runtime reads the checked element's location from the one argument of `add`.
    ["add without its argument", add, (call: Mutable) => (call.arguments = []), `${add}.typeCheck`],
  ] as const) {
    const plan: unknown = structuredClone(compiled);
    mutate(locate(plan, path));
    const errors = validateInstructionPlan(plan).errors.map((error) => [error.code, error.path]);
    assert.deepEqual(errors, [["TSC002", expected]], description);
    assert.throws(
      () => restoreCheckpoint({ ...checkpoint, plan }),
      (error: unknown) =>
        error instanceof CheckpointError &&
        error.info.code === "TSK002" &&
        error.info.path === `$.plan${expected.slice(1)}`,
      description,
    );
  }
});

test("deep values and types are checked without exhausting the native stack", () => {
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import * as m from ${JSON.stringify(moduleUrl)};
    const depth = 2048;
    const deep = (leaf) => {
      let value = leaf;
      for (let level = 0; level < depth; level++) value = { kind: 'list', items: [value] };
      return value;
    };
    const source = 'let value = ' + '['.repeat(depth) + '1' + ']'.repeat(depth) + '\\nvalue = load "k"\\nexit';
    const compiled = m.compileSource(source);
    assert.deepEqual(compiled.diagnostics, []);
    const failures = [deep(2), deep('x')].map((stored) => {
      const snapshot = m.createFreshRuntimeSnapshot(compiled.plan, { scriptStorage: [{ key: 'k', value: stored }] });
      m.restoreCheckpoint(m.createCheckpoint(compiled.plan, snapshot));
      return m.run(compiled.plan, snapshot).snapshot.failure;
    });
    assert.equal(failures[0], null);
    assert.equal(failures[1].code, 'TSR058');
    assert.ok(failures[1].message.endsWith('so it cannot take a list with text (string) at ' + '[0]'.repeat(depth) + '.'));
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
});
