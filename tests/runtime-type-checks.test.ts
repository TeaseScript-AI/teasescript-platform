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
      `'count' holds a whole number (integer), so it cannot take text (string) "x".`,
      'pick("x")',
    ],
    [
      "let count = 1\ncount = pick(2.5)",
      "'count' holds a whole number (integer), so it cannot take 2.5. Round it with floor(...), round(...), or ceil(...) first.",
      "pick(2.5)",
    ],
    [
      "let count = 1\ncount += pick(0.5)",
      "'count' holds a whole number (integer), so it cannot take 1.5. Round it with floor(...), round(...), or ceil(...) first.",
      "count += pick(0.5)",
    ],
    [
      'let items = [1, 2]\nitems[1] = pick("x")',
      `An element of 'items' holds a whole number (integer), so it cannot take text (string) "x".`,
      'pick("x")',
    ],
    [
      'let door = { locked: true }\ndoor.locked = pick("no")',
      `Property 'door.locked' holds true or false (boolean), so it cannot take text (string) "no".`,
      'pick("no")',
    ],
    [
      'let items = [1]\nitems.add(pick("x"))',
      `An element of 'items' holds a whole number (integer), so it cannot take text (string) "x".`,
      'pick("x")',
    ],
    [
      'let tags = set["a"]\ntags.add(pick(1))',
      "An element of 'tags' holds text (string), so it cannot take 1. Convert it with toString(...) first.",
      "pick(1)",
    ],
    [
      "function shout(times = 1) {\n    return times\n}\nshout(times: pick(0.5))",
      "Parameter 'times' of 'shout' holds a whole number (integer), so it cannot take 0.5. Round it with floor(...), round(...), or ceil(...) first.",
      "pick(0.5)",
    ],
    [
      'function rest(seconds: number = pick("long")) {\n    return seconds\n}\nrest()',
      `Parameter 'seconds' of 'rest' holds a number, so it cannot take text (string) "long".`,
      'pick("long")',
    ],
    [
      // A `return` of an unknown value leaves an inferred result unknown, so the receiving place checks it.
      'function level(known: boolean) {\n    if known {\n        return 1\n    }\n    return pick("high")\n}\nlet count: integer = level(false)',
      `'count' holds a whole number (integer), so it cannot take text (string) "high".`,
      "level(false)",
    ],
    [
      "function score(base): integer {\n    return pick(base)\n}\nscore(2.5)",
      "The result of 'score' holds a whole number (integer), so it cannot take 2.5. Round it with floor(...), round(...), or ceil(...) first.",
      "pick(base)",
    ],
  ] as const) {
    assert.deepEqual(failure(`${PICK}${statements}\nexit`), ["TSR058", message, span], statements);
  }
});

test("an arithmetic operand that is not a number names the operand, the value, and the fix", () => {
  for (const [statements, message, span] of [
    [
      "function share(total, count) {\n    return total / count\n}\nsay share(10, null)",
      "'total / count' needs a number for 'count', but received null. Check that 'count' is not null before using it.",
      "count",
    ],
    [
      'say 2 * pick("3")',
      "'*' needs a number on its right side, but received text (string) \"3\". Convert the text with toNumber(...) first.",
      'pick("3")',
    ],
    [
      'let level = pick("high")\nsay -level',
      "'-level' needs a number for 'level', but received text (string) \"high\". Use a number instead.",
      "level",
    ],
    [
      "let last = pick(null)\nfor step in 1..last {\n}",
      "'1..last' needs a number for 'last', but received null. Check that 'last' is not null before using it.",
      "last",
    ],
  ] as const) {
    assert.deepEqual(failure(`${PICK}${statements}\nexit`), ["TSR027", message, span], statements);
  }
});

test("a condition, comparison, or loop value of the wrong kind names the value and the fix", () => {
  for (const [statements, code, message, span] of [
    [
      "let ready = pick(null)\nif ready {\n}",
      "TSR026",
      "A condition must be true or false (boolean), but 'ready' is null. Compare it instead, such as 'ready == true'.",
      "ready",
    ],
    [
      "let count = pick(3)\nwhile count {\n}",
      "TSR026",
      "A condition must be true or false (boolean), but 'count' is 3. Compare it instead, such as 'count > 0'.",
      "count",
    ],
    [
      'let answer = pick("yes")\nsay true and answer',
      "TSR026",
      `'and' needs true or false (boolean) values, but 'answer' is text (string) "yes". Compare it instead, such as 'answer != ""'.`,
      "answer",
    ],
    [
      // An operand beside a call is kept until the call returns, and checked there.
      "let level = pick(1)\nsay level or pick(2) > 1",
      "TSR026",
      "'and' and 'or' need true or false (boolean) values, but 'level' is 1. Compare it instead, such as 'level > 0'.",
      "level",
    ],
    [
      "let score = pick(null)\nsay score < 10",
      "TSR009",
      "'<' compares two numbers, two texts, or two durations, but these are null and 10. Check that 'score' is not null first.",
      "score < 10",
    ],
    [
      "let times = pick(2.5)\nrepeat times {\n}",
      "TSR043",
      "A repeat count must be a whole number (integer) of at least 0, but 'times' is 2.5. Round it with floor(...), round(...), or ceil(...) first.",
      "times",
    ],
    [
      "let items = pick(5)\nfor item in items {\n}",
      "TSR044",
      "A 'for' loop goes through a list, set, dict, or range, but 'items' is 5. To count up to it, write a range, such as '1..=items'.",
      "items",
    ],
    [
      "let last = pick(2.5)\nfor step in 1..last {\n}",
      "TSR045",
      "A 'for' loop needs a range of whole numbers, but this range is 1..2.5. Round its bounds with floor(...), round(...), or ceil(...) first.",
      "1..last",
    ],
  ] as const) {
    assert.deepEqual(failure(`${PICK}${statements}\nexit`), [code, message, span], statements);
  }
});

test("an index or member that a value does not have names the value, its bounds, and the fix", () => {
  for (const [statements, code, message, span] of [
    [
      "let items = [1, 2, 3]\nlet i = pick(3)\nsay items[i]",
      "TSR025",
      "Cannot read 'items[i]': 'i' is 3, and 'items' has 3 elements, so its indexes run from 0 through 2. Check the index against 'items.length' first.",
      "i",
    ],
    [
      "let items = [1, 2]\nitems[pick(5)] = 1",
      "TSR025",
      "Cannot assign to index 5: 'items' has 2 elements, so its indexes run from 0 through 1. Check the index against 'items.length' first.",
      "pick(5)",
    ],
    [
      "let items = pick([])\nsay items[0]",
      "TSR025",
      "Cannot read 'items[0]': 'items' is empty. Check 'items.length' first.",
      "0",
    ],
    [
      "let items = [1]\nlet i = pick(1.5)\nsay items[i]",
      "TSR024",
      "A list index must be a whole number (integer), but 'i' is 1.5. Round it with floor(...), round(...), or ceil(...) first.",
      "i",
    ],
    [
      "let tags = pick(set[1])\nsay tags[0]",
      "TSR004",
      "Only a list or a dict can be indexed, but 'tags' is a set. Copy it into a list with toList() first.",
      "tags[0]",
    ],
    [
      "let level = pick(5)\nsay level[0]",
      "TSR008",
      "Only a list or a dict can be indexed, but 'level' is 5.",
      "level[0]",
    ],
    [
      "let level = pick(5)\nlevel.name = 1",
      "TSR003",
      "Only objects, speakers, camera views, and handles for timers, media, and messages have assignable properties, but 'level' is 5.",
      "level.name",
    ],
    [
      "let door = pick({ open: true, code: 1 })\nsay door.lock",
      "TSR017",
      "'door' has no property 'lock'. Its properties are 'open' and 'code'.",
      "door.lock",
    ],
    [
      // The index removes the element that the statement then changes.
      "let a = [[[1]], [[2], [3]]]\na[1][a.removeLast().length - 1].add(4)",
      "TSR025",
      "The list element this statement changes no longer exists: something in the same statement removed position 1. Make the change in a separate statement.",
      "a[1][a.removeLast().length - 1]",
    ],
    [
      "let empty = pick({})\nsay empty.lock",
      "TSR017",
      "'empty' has no properties, so it has no 'lock'.",
      "empty.lock",
    ],
    [
      "let wide = pick({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1, j: 1, k: 1, l: 1 })\nsay wide.lock",
      "TSR017",
      "'wide' has no property 'lock'. Its properties are 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', and 2 more.",
      "wide.lock",
    ],
    [
      "speaker vera {}\nlet who = pick(vera)\nsay who.mood",
      "TSR017",
      "Speaker 'vera' has no property 'mood'.",
      "who.mood",
    ],
    [
      'let items = pick([1])\nsay items["1"]',
      "TSR024",
      'A list index must be a whole number (integer), but this is text (string) "1". Convert the text with toInteger(...) first.',
      '"1"',
    ],
    [
      "let items = pick([1])\nsay items.size",
      "TSR017",
      "Lists have no property 'size'. Use length, first, last, or random.",
      "items.size",
    ],
    [
      "let items = [1]\nitems.add(value: pick(1))",
      "TSR015",
      "add() takes its arguments without names. Remove 'value:'.",
      "items.add(value: pick(1))",
    ],
  ] as const) {
    assert.deepEqual(failure(`${PICK}${statements}\nexit`), [code, message, span], statements);
  }
});

test("a value with unknown parts is checked part by part", () => {
  for (const [statements, message] of [
    [
      "let values: integer[] = [pick(1), pick(true)]",
      "'values' holds a list (integer[]), so it cannot take a list with true (boolean) at [1].",
    ],
    [
      'let grid = [[1]]\ngrid = pick([[1], [2, pick("x")]])',
      `'grid' holds a list (integer[][]), so it cannot take a list with text (string) "x" at [1][1].`,
    ],
    [
      'let door = { locked: true, code: 1 }\ndoor = pick({ code: 2, locked: "no" })',
      `'door' holds an object, so it cannot take an object with text (string) "no" at .locked.`,
    ],
    [
      "let door = { locked: true }\ndoor = pick([true])",
      "'door' holds an object, so it cannot take a list.",
    ],
    [
      "let doors = [{ locked: true }]\ndoors.add(pick({ locked: 1 }))",
      "An element of 'doors' holds an object, so it cannot take an object with a whole number (integer) 1 at .locked.",
    ],
    [
      "let best = null\nbest = 1\nbest = pick(2.5)",
      "'best' holds a whole number (integer) or null, so it cannot take 2.5. Round it with floor(...), round(...), or ceil(...) first.",
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
    [
      "2.5",
      "'count' holds a whole number (integer), so it cannot take 2.5. Round it with floor(...), round(...), or ceil(...) first.",
    ],
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
    const source = 'let value = ' + '['.repeat(depth) + '1' + ']'.repeat(depth) + '\\nvalue = load "k" + "", default: value\\nexit';
    const compiled = m.compileSource(source);
    assert.deepEqual(compiled.diagnostics, []);
    const failures = [deep(2), deep('x')].map((stored) => {
      const snapshot = m.createFreshRuntimeSnapshot(compiled.plan, { scriptStorage: [{ key: 'k', value: stored }] });
      m.restoreCheckpoint(m.createCheckpoint(compiled.plan, snapshot));
      return m.run(compiled.plan, snapshot).snapshot.failure;
    });
    assert.equal(failures[0], null);
    assert.equal(failures[1].code, 'TSR058');
    assert.ok(failures[1].message.endsWith('so it cannot take a list with text (string) "x" at ' + '[0]'.repeat(depth) + '.'));
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
});
