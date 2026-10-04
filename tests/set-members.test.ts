import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { createCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";

/** Hides a value's type from the compiler, so a check reaches the runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

function says(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function failure(source: string): [string, string] | null {
  const failed = runValidSource(source).snapshot.failure;
  return failed === null ? null : [failed.code, failed.message];
}

function codes(source: string): [string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("a set of lists, objects, dicts, or sets keeps the first of members equal by ==, in insertion order", () => {
  assert.deepEqual(
    says(
      [
        "let groups = set[[1, 2], [2, 1], [1, 2]]",
        "say groups",
        // Objects and dicts are equal in any property or entry order, and sets in any member order.
        'let doors = set[{ name: "front", locked: true }, { locked: true, name: "front" }, { name: "back" }]',
        "say doors",
        "let tables = set[dict{ a: 1, b: 2 }, dict{ b: 2, a: 1 }]",
        "say tables",
        "let nested = set[set[1, 2], set[2, 1], set[3]]",
        "say nested",
        // Integers and numbers, and -0 and 0, are equal by ==, so they are one member.
        "let numbers = set[[1], [1.0], [-0], [0]]",
        "say numbers",
        "say groups.length",
        "exit",
      ].join("\n"),
    ),
    [
      "[[1, 2], [2, 1]]",
      '[{ name: "front", locked: true }, { name: "back" }]',
      '[dict{ "a": 1, "b": 2 }]',
      "[[1, 2], [3]]",
      "[[1], [0]]",
      "2",
    ],
  );
});

test("add, contains, remove, and the set operations compare composite members with ==", () => {
  assert.deepEqual(
    says(
      [
        'let doors = set[{ name: "front" }]',
        'doors.add({ name: "back" })',
        'doors.add({ name: "front" })',
        "say doors.length",
        'say doors.contains({ name: "back" })',
        'say doors.contains({ name: "side" })',
        'doors.remove({ name: "front" })',
        'doors.remove({ name: "nowhere" })',
        "say doors",
        "let a = set[[1], [2], [3]]",
        "let b = set[[3], [4]]",
        "say a.intersection(b)",
        "say a.union(b)",
        "say a.difference(b)",
        // A list keeps duplicates; its set operations give each element once, like a set's.
        "say [[1], [1], [2]].union([[2], [5]])",
        "say [[1], [1], [2]].toSet()",
        "say a.toList()",
        "say a == set[[3], [1], [2]]",
        "say a == set[[1], [2]]",
        "exit",
      ].join("\n"),
    ),
    [
      "2",
      "true",
      "false",
      '[{ name: "back" }]',
      "[[3]]",
      "[[1], [2], [3], [4]]",
      "[[1], [2]]",
      "[[1], [2], [5]]",
      "[[1], [2]]",
      "[[1], [2], [3]]",
      "true",
      "false",
    ],
  );
});

test("a member is copied on insert, and first, last, random, and iteration give copies", () => {
  assert.deepEqual(
    says(
      [
        "let item = [1]",
        "let holder = set[item]",
        "holder.add([2])",
        "item.add(9)",
        "say holder",
        // Changing a read member changes only the copy, so the set keeps its members and their uniqueness.
        "holder.first.add(2)",
        "holder.last.add(1)",
        "let member = holder.first",
        "member.add(5)",
        "for value in holder {",
        "    value.add(7)",
        "}",
        "say holder",
        "say holder.contains([1])",
        "let doors = set[{ open: false }]",
        "doors.first.open = true",
        "say doors",
        "exit",
      ].join("\n"),
    ),
    ["[[1], [2]]", "[[1], [2]]", "true", "[{ open: false }]"],
  );
});

test("what changes a read set member decides and widens nothing in the set, unlike a list element", () => {
  for (const selector of ["first", "last", "random"])
    assert.deepEqual(
      says(`${DYNAMIC}let s = set[[]]\ns.${selector}.add("x")\ns.add(dynamic([1]))\nsay s\nexit`),
      ["[[], [1]]"],
      selector,
    );
  assert.deepEqual(
    says(
      `${DYNAMIC}let s = set[{ items: [] }]\ns.first.items.add("x")\ns.add(dynamic({ items: [1] }))\nsay s\nexit`,
    ),
    ["[{ items: [] }, { items: [1] }]"],
  );
  // A read member is a computed value like a literal, so a number does not widen the set's integer lists.
  assert.deepEqual(codes("let s = set[[1]]\ns.first.add(2.5)\nlet xs: integer[] = s.first\nexit"), [
    ["TSV041", "2.5"],
  ]);
  // A list element is a place: what changes it also changes the list and its element type.
  assert.deepEqual(says('let l = [[]]\nl.first.add("x")\nsay l\nexit'), ['[["x"]]']);
  assert.deepEqual(codes("let l = [[1]]\nl.first.add(2.5)\nlet xs: integer[] = l.first\nexit"), [
    ["TSV041", "l.first"],
  ]);
});

test("collections nest in every direction", () => {
  assert.deepEqual(
    says(
      [
        "let listsInLists = [[1, 2], [3]]",
        "let setsInLists = [set[1], set[1, 2]]",
        "let listsInSets = set[[1], [1]]",
        "let setsInSets = set[set[1], set[1]]",
        "let dictsInSets = set[dict{ a: [1] }, dict{ a: [1] }]",
        "let objectsInSets = set[{ tags: set[1] }]",
        "let setsInDicts = dict{ first: set[[1]], second: set[] }",
        "let listsInDicts = dict{ a: [1, 2] }",
        "let dictsInLists = [dict{ a: set[1] }]",
        "let setsInObjects = { members: set[{ n: 1 }] }",
        "say listsInLists",
        "say setsInLists",
        "say listsInSets",
        "say setsInSets",
        "say dictsInSets",
        "say objectsInSets",
        "say setsInDicts",
        "say listsInDicts",
        "say dictsInLists",
        "say setsInObjects",
        'setsInDicts["second"].add([2])',
        'say setsInDicts["second"]',
        "exit",
      ].join("\n"),
    ),
    [
      "[[1, 2], [3]]",
      "[[1], [1, 2]]",
      "[[1]]",
      "[[1]]",
      '[dict{ "a": [1] }]',
      "[{ tags: [1] }]",
      'dict{ "first": [[1]], "second": [] }',
      'dict{ "a": [1, 2] }',
      '[dict{ "a": [1] }]',
      "{ members: [{ n: 1 }] }",
      "[[2]]",
    ],
  );
  // Element types of sets follow the list rules.
  assert.deepEqual(codes("let groups: integer[] set = set[[1], [2]]\ngroups.add([3])\nexit"), []);
  assert.deepEqual(codes('let groups = set[[1]]\ngroups.add(["x"])\nexit'), [["TSV041", '"x"']]);
  assert.deepEqual(
    codes("let groups = set[[1], [2.5]]\nlet first: integer[] = groups.first\nexit"),
    [["TSV041", "groups.first"]],
  );
  assert.deepEqual(failure(`${DYNAMIC}let groups: integer[] set = dynamic(set[["x"]])\nexit`), [
    "TSR058",
    "'groups' holds a set (integer[] set), so it cannot take a set with text (string) at [0][0].",
  ]);
});

test("speakers and handles are set members by identity, like list elements, and stay in the session", () => {
  assert.deepEqual(
    says(
      [
        "speaker vera {}",
        "speaker mira {}",
        "let voices = set[vera, mira, vera]",
        "say voices",
        "let beat = timer async 10 s",
        "let clocks = set[beat, beat]",
        "say clocks.length",
        "exit",
      ].join("\n"),
    ),
    ["[<speaker vera>, <speaker mira>]", "1"],
  );
  assert.deepEqual(
    failure(`${DYNAMIC}speaker vera {}\nsave dynamic(set[vera]) as "voices"\nexit`)?.[0],
    "TSR055",
  );
});

test("choose gives one button per member of a set of choice objects, like a list without duplicates", () => {
  const source = [
    'let options = set[{ value: 1, text: "Kneel" }, { value: 1, text: "Kneel" }, { value: 2, text: "Beg" }]',
    "let answer = choose options",
    "say [answer]",
    "exit",
  ].join("\n");
  const plan = compileValidPlan(source);
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  assert.deepEqual(
    action.ui.options.map((option) => [option.text, option.value]),
    [
      ["Kneel", 1],
      ["Beg", 2],
    ],
  );
  const completed = completeAction(plan, pending.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  const finished = run(plan, completed.snapshot);
  assert.deepEqual(
    finished.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["[2]"],
  );
});

test("storage keeps sets of composite members, and a checkpoint restores them or rejects duplicates", () => {
  assert.deepEqual(
    says(
      [
        'save set[{ name: "front", tags: set[[1]] }, { name: "back", tags: set[] }] as "doors"',
        'let doors: set = load "doors"',
        "say doors",
        'say doors.contains({ tags: set[], name: "back" })',
        "exit",
      ].join("\n"),
    ),
    ['[{ name: "front", tags: [[1]] }, { name: "back", tags: [] }]', "true"],
  );
  assertRuntimeResumeEquivalent(
    [
      'let doors = set[{ name: "front", locked: true }]',
      'doors.add({ name: "back", locked: false })',
      'doors.add({ locked: true, name: "front" })',
      'say doors.contains({ name: "back", locked: false })',
      'doors.remove({ name: "front", locked: true })',
      "let groups = set[set[[1]], set[[2]]]",
      "for group in groups {",
      "    say group",
      "}",
      'say doors.union(set[{ name: "side" }])',
      "exit",
    ].join("\n"),
  );

  const plan = compileValidPlan(
    "let doors = set[{ a: 1, b: 2 }, { a: 3 }]\nwait 1 s\nsay doors\nexit",
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(waiting.snapshot.status, "waiting");
  const serialized = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  const corrupt = (mutate: (snapshot: RuntimeSnapshot) => void) => {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid runtime snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: RuntimeSnapshot };
    mutate(json.snapshot);
    assertCheckpointRejected(json, "TSK002");
  };
  const doors = (snapshot: RuntimeSnapshot) => {
    const found = snapshot.frames[0]!.bindings.find((entry) => entry.name === "doors")?.value;
    assert.ok(typeof found === "object" && found !== null && found.kind === "set");
    return found;
  };
  // Two members equal by ==, also with their properties in another order, are not a valid set.
  corrupt((snapshot) => {
    doors(snapshot).items.push({ kind: "object", properties: [{ name: "a", value: 3 }] });
  });
  corrupt((snapshot) => {
    doors(snapshot).items.push({
      kind: "object",
      properties: [
        { name: "b", value: 2 },
        { name: "a", value: 1 },
      ],
    });
  });
  // A member is validated like a list element.
  corrupt((snapshot) => {
    doors(snapshot).items.push({ kind: "list", items: [Number.NaN] });
  });
});
