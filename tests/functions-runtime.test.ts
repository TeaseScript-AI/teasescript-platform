import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/instructions.js";
import { run } from "../src/runtime/engine.js";
import type {
  SerializableRuntimeList,
  SerializableRuntimeObject,
  SerializableRuntimeSet,
  SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";

test("executes positional and named function calls with returned values", () => {
  const result = runSource([
    "function add(left, right) { return left + right }",
    "function subtract(left, right) { return left - right }",
    "say add(2, 3)",
    "say subtract(right: 2, left: 7)",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["5", "5"]);
  assert.deepEqual(result.snapshot.callFrames, []);
  assert.deepEqual(result.snapshot.temporaries, []);
});

test("binds defaults per invocation after all supplied parameters", () => {
  const result = runSource([
    "let counter = 0",
    "function next { counter = counter + 1\nreturn counter }",
    "function describe(name, title = name, count = next()) {",
    "  return `${title}:${name}:${count}`",
    "}",
    'say describe("pet")',
    'say describe(name: "Alex", title: "puppy")',
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["pet:pet:1", "puppy:Alex:2"]);
});

test("bare and implicit returns produce null", () => {
  const result = runSource([
    "function bare { return }",
    'function implicit { say "inside" }',
    "say bare()",
    "say implicit()",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["null", "inside", "null"]);
});

test("parameters are deep copies of caller lists, objects, and sets", () => {
  const result = runSource([
    "let listValue = [[1]]",
    "let objectValue = { nested: [1] }",
    "let setValue = set[1, 2]",
    "function mutate(listInput, objectInput, setInput) {",
    "  listInput[0][0] = 9",
    "  objectInput.nested[0] = 9",
    "  setInput.add(3)",
    "}",
    "mutate(listValue, objectValue, setValue)",
  ].join("\n"));

  assert.deepEqual(rootValue(result.snapshot, "listValue"), {
    kind: "list",
    items: [{ kind: "list", items: [1] }],
  });
  assert.deepEqual(rootValue(result.snapshot, "objectValue"), {
    kind: "object",
    properties: [{ name: "nested", value: { kind: "list", items: [1] } }],
  });
  assert.deepEqual((rootValue(result.snapshot, "setValue") as SerializableRuntimeSet).items, [1, 2]);
});

test("returned lists, objects, and sets are independent deep copies", () => {
  const result = runSource([
    "let sourceList = [[1]]",
    "let sourceObject = { nested: [1] }",
    "let sourceSet = set[1, 2]",
    "function listCopy { return sourceList }",
    "function objectCopy { return sourceObject }",
    "function setCopy { return sourceSet }",
    "let copiedList = listCopy()",
    "let copiedObject = objectCopy()",
    "let copiedSet = setCopy()",
    "copiedList[0][0] = 9",
    "copiedObject.nested[0] = 9",
    "copiedSet.add(3)",
  ].join("\n"));

  assert.deepEqual(
    ((rootValue(result.snapshot, "sourceList") as SerializableRuntimeList).items[0] as SerializableRuntimeList).items,
    [1],
  );
  assert.deepEqual(
    objectProperty(rootValue(result.snapshot, "sourceObject") as SerializableRuntimeObject, "nested"),
    { kind: "list", items: [1] },
  );
  assert.deepEqual((rootValue(result.snapshot, "sourceSet") as SerializableRuntimeSet).items, [1, 2]);
  assert.deepEqual((rootValue(result.snapshot, "copiedSet") as SerializableRuntimeSet).items, [1, 2, 3]);
});

test("speaker parameters preserve speaker identity", () => {
  const result = runSource([
    'speaker vera { displayName: "Vera"\ntitle: "Mistress" }',
    "function rename(character) { character.title = \"Director\"\nreturn character }",
    "let returned = rename(vera)",
    "say returned.title",
    "say vera.title",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["Director", "Director"]);
});

test("early return unwinds if and every loop kind", () => {
  const result = runSource([
    "function fromIf { if true { return 1 }\nreturn 9 }",
    "function fromRepeat { repeat 3 { return 2 }\nreturn 9 }",
    "function fromFor { for item in [3, 4] { return item }\nreturn 9 }",
    "function fromWhile { while true { return 4 }\nreturn 9 }",
    "say fromIf()",
    "say fromRepeat()",
    "say fromFor()",
    "say fromWhile()",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["1", "2", "3", "4"]);
  assert.equal(result.snapshot.frames.length, 1);
  assert.deepEqual(result.snapshot.loopFrames, []);
});

test("supports nested calls in arithmetic and templates", () => {
  const result = runSource([
    "function one { return 1 }",
    "function add(left, right) { return left + right }",
    "say one() + add(one(), one())",
    "say `nested:${add(one(), one())}`",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["3", "nested:2"]);
});

test("preserves left-to-right call and named-argument side effects", () => {
  const result = runSource([
    "let order = []",
    "function mark(value) { order.add(value)\nreturn value }",
    "function combine(left, right) { return `${left}${right}` }",
    'say combine(mark("a"), mark("b"))',
    'say combine(right: mark("d"), left: mark("c"))',
    "say `${order[0]}${order[1]}${order[2]}${order[3]}`",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["ab", "cd", "abdc"]);
});

test("functions read and assign package-global variables without leaking locals", () => {
  const result = runSource([
    "let total = 1",
    "function increase(value) {",
    "  let local = value",
    "  total = total + local",
    "  return total",
    "}",
    "say increase(2)",
    "say total",
  ].join("\n"));

  assert.deepEqual(sayTexts(result), ["3", "3"]);
  assert.equal(result.snapshot.frames[0]?.bindings.some((binding) => binding.name === "local"), false);
});

test("supports direct and mutual recursion through explicit frames", () => {
  const direct = runSource([
    "function factorial(value) {",
    "  if value <= 1 { return 1 }",
    "  return value * factorial(value - 1)",
    "}",
    "say factorial(6)",
  ].join("\n"));
  assert.deepEqual(sayTexts(direct), ["720"]);

  const mutual = runSource([
    "function even(value) { if value == 0 { return true }\nreturn odd(value - 1) }",
    "function odd(value) { if value == 0 { return false }\nreturn even(value - 1) }",
    "say even(8)",
    "say odd(8)",
  ].join("\n"));
  assert.deepEqual(sayTexts(mutual), ["true", "false"]);
});

test("fails structurally at configured call depth", () => {
  const compiled = plan("function recurse { return recurse() }\nrecurse()");
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { maxCallDepth: 8 }),
  );

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR047");
  assert.ok(result.snapshot.failure?.span.start.offset !== undefined);
});

test("instruction budgets still stop recursive execution", () => {
  const compiled = plan("function recurse { return recurse() }\nrecurse()");
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    {},
    { instructionBudget: 20 },
  );

  assert.equal(result.snapshot.failure?.code, "TSR037");
});

test("exit inside nested calls terminates the complete execution", () => {
  const result = runSource([
    "function inner { exit }",
    "function outer { inner()\nreturn 1 }",
    "outer()",
    'say "unreachable"',
  ].join("\n"));

  assert.deepEqual(result.events.map((event) => event.kind), ["exit"]);
  assert.deepEqual(result.snapshot.callFrames, []);
  assert.deepEqual(result.snapshot.loopFrames, []);
  assert.equal(result.snapshot.frames.length, 1);
});

test("break and continue cannot cross function boundaries", () => {
  for (const keyword of ["break", "continue"]) {
    const result = compileSource([
      `function invalid { ${keyword} }`,
      "repeat 1 { invalid() }",
    ].join("\n"));
    assert.equal(result.plan, null);
    assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV008"));
  }
});

function runSource(source: string) {
  const compiled = plan(source);
  return run(compiled, createFreshRuntimeSnapshot(compiled));
}

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function sayTexts(result: ReturnType<typeof run>): string[] {
  return result.events
    .filter((event) => event.kind === "say")
    .map((event) => event.text);
}

function rootValue(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const binding = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(binding !== undefined);
  return binding.value;
}

function objectProperty(
  object: SerializableRuntimeObject,
  name: string,
): SerializableRuntimeValue {
  const property = object.properties.find((item) => item.name === name);
  assert.ok(property !== undefined);
  return property.value;
}
