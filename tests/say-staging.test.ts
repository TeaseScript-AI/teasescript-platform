import assert from "node:assert/strict";
import test from "node:test";

import type { ExpressionPlan, InstructionPlan, SayInstruction } from "../src/plan/model.js";
import { withRegexWorkLimit } from "../src/regex-engine.js";
import { createCheckpoint, serializeCheckpoint } from "../src/runtime/snapshot/checkpoint.js";
import { executeValidatedInstruction } from "../src/runtime/engine.js";
import { captureExecutableData } from "../src/runtime/operations/support.js";
import { sayStagesSelectively } from "../src/runtime/instructions/say-staging.js";
import { CLOCK_CONTRACTS, TEMPORAL_METHODS } from "../src/temporal-builtins.js";
import { TEXT_METHODS } from "../src/text-operations.js";
import {
  builtSerializableDictIndex,
  type SerializableRuntimeDict,
  type SerializableRuntimeValue,
} from "../src/runtime/values/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { isDict } from "../src/runtime/values/value-predicates.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { withDeepSayStaging } from "./helpers/deep-say-staging.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import {
  assertRuntimeResumeEquivalent,
  type RuntimeResumeEquivalenceOptions,
} from "./helpers/runtime-equivalence.js";

/*
 * A say whose expressions only read state stages on copies of the few parts it changes in place instead of a deep copy
 * of the whole state. Both stagings must give the same events and states at every boundary, also when the say is
 * rejected after its expressions ran, and the selective one must leave unrelated values where they are.
 */

const DECLARATIONS = [
  'let items = ["a", "b", "c"]',
  'let lookup = dict { "a": 1, "b": 2 }',
  'let person = { name: "Ann", age: 30 }',
  "let count = 3",
  "let done = false",
  "let pause = 1 s",
  'let tint = "blue"',
  'let mixed: (integer | string)[] = [1, "a"]',
  "let durations = [1 s, 2 s]",
  "function twice(value) {\n  return value * 2\n}",
  'function grow {\n  items.add("d")\n  return 1\n}',
];

function says(plan: InstructionPlan): SayInstruction[] {
  return plan.instructions.filter((instruction) => instruction.kind === "say");
}

/** Whether each say of `lines`, written after the shared declarations, stages selectively. */
function staging(lines: readonly string[], builtins: readonly string[] = []): boolean[] {
  const plan = compileValidPlan([...DECLARATIONS, ...lines, "exit"].join("\n"), { builtins });
  return says(plan).map(sayStagesSelectively);
}

test("a say whose expressions only read, compute, and draw stages selectively", () => {
  const lines = [
    "say count",
    "say person.name",
    "say items[0]",
    'say lookup["b"]',
    'say "${person.name} has ${count * 2 + 1} of ${items.length}, ${count > 2}, ${-count}, ${not done}"',
    "say (count)",
    "say mixed[0] is integer",
    'say [count, 2]\nsay { a: count }\nsay set[1, count]\nsay dict { "k": count }',
    "say 2 s\nsay count s",
    'say items.random\nsay "${items}"\nsay random()\nsay randomInteger(1..=6)',
    'say person.name.uppercase()\nsay items.join(", ")\nsay items.take(2)\nsay items.contains("a")',
    'say lookup.get("z", default: 0)\nsay lookup.keys\nsay toString(count)\nsay max(count, 5)',
    // JSON and Base64 without files, and hashText, only read their arguments.
    'say toJson(lookup, files: false)\nsay "${fromJson(toJson(person, files: false), default: null, files: false)}"',
    'say toBase64(person.name)\nsay fromBase64("QW5u", default: "")\nsay hashText(person.name)',
    'say (load "k", default: count)',
    // A user function runs in instructions before the say, which reads its result.
    'say "${twice(count)}"',
    'say "x", pause\nsay "x", 2 s\nsay prose(color: tint) "x"',
    // Regex searches only read their text and regex, and a regex is a plain value (V30 §8).
    "say /a+/i\nsay toRegex(tint, default: null)\nsay tint.matches(/b.*/)\nsay tint.contains(/u/)",
    "say tint.find(/[aeiou]/)\nsay tint.capture(/(b)(l)?/)\nsay tint.indexOf(/e/)",
    'say tint.findAll(/[aeiou]/)\nsay tint.split(/u/)\nsay tint.replace(/(b)/, "$1$1")\nsay tint.lastIndexOf(/e/)',
  ];
  const results = staging(lines);
  assert.equal(results.length, 46);
  assert.deepEqual(
    results.flatMap((admitted, index) => (admitted ? [] : [index])),
    [],
  );
});

test("a say that calls a method of text stages selectively, unless a list's method of that name changes the list", () => {
  const argument = {
    text: '"b"',
    textOrRegex: '"b"',
    regex: "/b/",
    position: "0",
    count: "1",
  } as const;
  const lines = Object.entries(TEXT_METHODS).map(
    ([name, method]) =>
      `say tint.${name}(${method.parameters.map((parameter) => argument[parameter.kind]).join(", ")})`,
  );
  // Every method of text only reads, but `reverse` reverses a list in place, and the plan does not know the receiver.
  assert.deepEqual(
    staging(lines),
    Object.keys(TEXT_METHODS).map((name) => name !== "reverse"),
  );
});
test("a say that reads the clock or calls a method of a date or time value stages selectively", () => {
  // A clock read reads the session clock, and a method of a date or time value only reads it (see `ClockFunction` and
  // `TemporalMethod`); neither changes a value.
  const clock = Object.keys(CLOCK_CONTRACTS).map((name) => `say ${name}()`);
  const value = {
    date: "getDate()",
    time: "getTime()",
    datetime: "getDateTime()",
    absoluteDateTime: "getAbsoluteDateTime()",
  } as const;
  const methods = Object.entries(TEMPORAL_METHODS).flatMap(([name, method]) =>
    method.receivers.map((kind) => `say ${value[kind]}.${name}()`),
  );
  const results = staging([...clock, ...methods]);
  assert.equal(results.length, clock.length + methods.length);
  assert.ok(results.every(Boolean));
});

test("a say whose expressions may change state, or whose calls are unknown, stages deeply", () => {
  const lines = [
    "say items.removeFirst()",
    "say items.removeLast()",
    "say items.removeAt(0)",
    'say lookup.remove("a")',
    'say "${count} ${items.removeFirst()}"',
    "say items.join(items.removeFirst())",
    // The call after it prepares a reference to the receiver.
    "say items.join(toString(grow()))",
    'say "x", durations.removeFirst()',
    "say host(count)",
  ];
  assert.deepEqual(
    staging(lines, ["host"]),
    lines.map(() => false),
  );

  // Each method that changes a collection or a handle, called in place of a read; a say can show few of their results.
  const [say] = says(compileValidPlan(`${DECLARATIONS.join("\n")}\nsay items\nexit`));
  const receiver = say!.value;
  const span = receiver.span;
  const withValue = (value: ExpressionPlan): SayInstruction => ({ ...say!, value });
  const method = (name: string): ExpressionPlan => ({
    kind: "call",
    callee: { kind: "property", object: receiver, name, span },
    arguments: [],
    span,
  });
  for (const name of [
    "add",
    "addAll",
    "remove",
    "removeAt",
    "removeFirst",
    "removeLast",
    "clear",
    "sort",
    "shuffle",
    "reverse",
    "pause",
    "resume",
    "stop",
  ])
    assert.equal(sayStagesSelectively(withValue(method(name))), false, name);
  assert.equal(sayStagesSelectively(withValue(method("join"))), true, "join reads");
  assert.equal(
    sayStagesSelectively(withValue({ kind: "preparedReference", temporaryId: 1, span })),
    false,
    "a prepared reference",
  );
  // EVIDENCE: JSON gives a node of a kind that no plan has, which stands for a kind added later.
  const unknownKind = JSON.parse(JSON.stringify({ kind: "unknown", span })) as ExpressionPlan;
  assert.equal(sayStagesSelectively(withValue(unknownKind)), false, "an unknown kind");
});

/**
 * Runs `source` with selective and with deep staging, each resumed from a restored checkpoint at every boundary, and
 * requires the same events and the same checkpoint at every boundary. Returns the selective run.
 */
function assertStagingsAgree(source: string, options: RuntimeResumeEquivalenceOptions = {}) {
  const plan = compileValidPlan(source);
  assert.ok(
    says(withDeepSayStaging(plan)).some((say, index) => say !== says(plan)[index]),
    "the source has a say that stages selectively",
  );
  const selective = assertRuntimeResumeEquivalent(source, options);
  const deep = assertRuntimeResumeEquivalent(source, {
    ...options,
    transformPlan: withDeepSayStaging,
  });
  assert.deepEqual(deep.events, selective.events);
  assert.equal(deep.boundaries.length, selective.boundaries.length);
  const checkpoint = (snapshot: RuntimeSnapshot) =>
    serializeCheckpoint(createCheckpoint(plan, snapshot));
  selective.boundaries.forEach((snapshot, index) =>
    assert.equal(
      checkpoint(deep.boundaries[index]!),
      checkpoint(snapshot),
      `boundary ${index + 1}`,
    ),
  );
  return selective;
}

test("selective and deep staging give the same events and states", () => {
  assertStagingsAgree(
    [
      'speaker vera {\n  displayName: "Vera"\n  color: "red"\n}',
      ...DECLARATIONS,
      'say as vera "${speaker.displayName}: ${person.name} has ${count * 2 + 1} of ${items.length}, ${lookup["b"]}"',
      'say "${items.random} ${["x", "y", "z"]} ${randomInteger(1..=6)} ${round(random() * 10)}"',
      'say items.join(", ").uppercase()',
      'say "${toString(count)} ${items.take(2).join()} ${person.name.padStart(5, ".")}", pause',
      'say prose(color: tint) "${twice(count)} left"',
      'say "${tint.capture(/(b)(l)?/)} ${tint.find(/[aeiou]+/)} ${tint.matches(toRegex("b.*", default: /x/))}"',
      'say "${tint.findAll(/[aeiou]/).join()} ${tint.split(/u/).join()} ${tint.replace(/(b)/, "$1$1")} ${tint.lastIndexOf(/e/)}"',
      "say lookup",
      'say "${toJson(lookup, files: false)} ${toBase64(person.name)} ${fromBase64("QW5u", default: "")} ${hashText(person.name)}"',
      'say "${fromJson(toJson(items, files: false), default: null, files: false)}"',
      "exit",
    ].join("\n"),
  );
});

test("a say rejected after its expressions ran keeps nothing, with either staging", () => {
  const pacing = "function dynamic(value) {\n    return value\n}\nlet pacing = dynamic(-1 s)";
  for (const source of [
    // Draws and a dict lookup, then a pacing that fails.
    [...DECLARATIONS, pacing, 'say "${items.random} ${random()} ${lookup["a"]}", pacing'],
    // A draw, then an index that fails.
    [...DECLARATIONS, 'say "${random()} ${items[3]}"'],
    // A speaker warning, then a pacing that fails.
    ["speaker vera { }", ...DECLARATIONS, pacing, 'say as vera "${count}", pacing'],
    // A message handle, then a pacing that fails.
    [...DECLARATIONS, pacing, 'let line = say "${count}", pacing'],
  ]) {
    const { events, finalSnapshot } = assertStagingsAgree([...source, "exit"].join("\n"), {
      ending: "failed",
      seed: 77,
    });
    assert.deepEqual(
      events.map((event) => event.kind),
      ["runtimeFailure"],
    );
    assert.equal(finalSnapshot.rng.state, 77);
    assert.deepEqual(finalSnapshot.warnedSpeakerIds, []);
    assert.deepEqual(finalSnapshot.liveMessages, []);
  }
  // A draw, then a regex operation that needs too much work (V30 §8).
  withRegexWorkLimit(100, () => {
    const { finalSnapshot } = assertStagingsAgree(
      [...DECLARATIONS, 'say "${random()} ${tint.findAll(/./)}"', "exit"].join("\n"),
      { ending: "failed", seed: 77 },
    );
    assert.equal(finalSnapshot.failure?.code, "TSR087");
    assert.equal(finalSnapshot.rng.state, 77);
  });
});

test("a say rejected for 'speaker' without a speaker keeps nothing, with either staging", () => {
  // The default speaker is set only on a path that does not run, so the say has none.
  const unset = ['speaker vera { title: "Miss" }', "if done {\n  speaker vera\n}"];
  const reads = [
    'say "${random()} ${speaker.title}"',
    'let line = say "${items.random} ${speaker.title.uppercase()}"',
  ];
  assert.deepEqual(staging([...unset, ...reads]), [true, true]);
  for (const read of reads) {
    const { events, finalSnapshot } = assertStagingsAgree(
      [...DECLARATIONS, ...unset, read, "exit"].join("\n"),
      { ending: "failed", seed: 77 },
    );
    assert.deepEqual(
      events.map((event) => event.kind),
      ["runtimeFailure"],
    );
    assert.equal(finalSnapshot.failure?.code, "TSR071");
    assert.equal(finalSnapshot.rng.state, 77);
    assert.equal(finalSnapshot.contextualSpeaker, null);
    assert.deepEqual(finalSnapshot.liveMessages, []);
  }
});

test("speaker warnings, message handles, and timer blocks stage alike either way", () => {
  // The first say warns that vera has no display name; the later ones do not warn again.
  assertStagingsAgree(
    [
      "speaker vera { }",
      ...DECLARATIONS,
      'say as vera "${count}"',
      'say as vera "${count + 1}", pause',
      "exit",
    ].join("\n"),
  );
  assertStagingsAgree(
    [
      ...DECLARATIONS,
      'let line = say "${count} left", instant',
      'line.text = "${count - 1} left"',
      "let echo = say line.text",
      'say "${echo.text}!"',
      "exit",
    ].join("\n"),
  );
  assertStagingsAgree(
    [
      ...DECLARATIONS,
      "timer(duration: 1 s, async: true) {",
      '  say "Tick ${count} ${items.random}"',
      "}",
      "wait 2 s",
      'say "done ${count}"',
      "exit",
    ].join("\n"),
  );
});

function binding(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const found = snapshot.frames[0]!.bindings.find((candidate) => candidate.name === name);
  assert.ok(found !== undefined, name);
  return found.value;
}

function dictBinding(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeDict {
  const value = binding(snapshot, name);
  assert.ok(isDict(value), name);
  return value;
}

test("a selectively staged say leaves unrelated values in place, and a dict keeps its key index", () => {
  const source = [
    ...DECLARATIONS,
    // The lookup builds the dict's key index.
    'say "${lookup["a"]}"',
    'say "${count} of ${person.name}"',
    "exit",
  ].join("\n");
  for (const [staged, transform] of [
    ["selectively", (plan: InstructionPlan) => plan],
    ["deeply", withDeepSayStaging],
  ] as const) {
    const compiled = transform(compileValidPlan(source));
    const { plan, snapshot } = captureExecutableData(
      compiled,
      createImmediatePacingRuntimeSnapshot(compiled),
    );
    const sayIndexes = plan.instructions.flatMap((instruction, index) =>
      instruction.kind === "say" ? [index] : [],
    );
    while (snapshot.nextInstruction !== sayIndexes[1]) executeValidatedInstruction(plan, snapshot);
    const items = binding(snapshot, "items");
    const lookup = dictBinding(snapshot, "lookup");
    const index = builtSerializableDictIndex(lookup);
    assert.notEqual(index, undefined, `${staged}: the lookup built an index`);
    assert.equal(executeValidatedInstruction(plan, snapshot).events.length, 1);
    const shared = staged === "selectively";
    assert.equal(binding(snapshot, "items") === items, shared, `${staged}: the list`);
    assert.equal(binding(snapshot, "lookup") === lookup, shared, `${staged}: the dict`);
    assert.equal(
      builtSerializableDictIndex(dictBinding(snapshot, "lookup")) === index,
      shared,
      `${staged}: the dict's key index`,
    );
  }
});
