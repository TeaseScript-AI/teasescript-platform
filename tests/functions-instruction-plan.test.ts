import assert from "node:assert/strict";
import test from "node:test";

import type { ExpressionPlan, Instruction, InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { runValidSource as runSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

test("assigns deterministic function and temporary IDs", () => {
  const source = [
    "function first { return 1 }",
    "function second { return 2 }",
    "let result = first() + second()",
    "result = result + 1",
    'say "${result}"',
    "exit",
  ].join("\n");
  const first = plan(source);
  const second = plan(source);

  assert.deepEqual(second, first);
  const ids = first.functions.map((definition) => definition.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    first.functions.map((definition) => definition.name),
    ["first", "second"],
  );
  const calls = first.instructions.filter((instruction) => instruction.kind === "callFunction");
  assert.deepEqual(
    calls.map((instruction) => functionName(first, instruction.functionId)),
    ["first", "second"],
  );
  // Both results are live at the addition, so they need independent destinations.
  const destinations = calls.map((instruction) => instruction.destinationTemporary);
  assert.equal(new Set(destinations).size, 2);
});

test("embeds synchronous call arguments without preparation instructions", () => {
  // Scoped regression oracle for a plan-size optimization, not a product limit or compatibility
  // contract. Review and update this baseline when an intentional lowering change legitimately
  // moves it.
  const compiled = plan(
    [
      "function combine(first, second, third) { return first + second + third }",
      "combine(1, 2, 3)",
    ].join("\n"),
  );
  const root = compiled.instructions.slice(0, compiled.rootEndInstruction);
  const call = root.find((instruction) => instruction.kind === "callFunction");
  assert.equal(call?.kind, "callFunction");
  if (call?.kind !== "callFunction") return;

  assert.deepEqual(
    call.arguments.map((argument) =>
      argument.value.kind === "literal" ? argument.value.value : undefined,
    ),
    [1, 2, 3],
  );
  assert.equal(root.filter((instruction) => instruction.kind === "storeTemporary").length, 0);
  assert.equal(root.filter((instruction) => instruction.kind === "clearTemporaries").length, 0);
});

test("evaluates composite and nested user-call arguments in source order", () => {
  const result = runSource(
    [
      "let order = []",
      "function mark(value) { order.add(value)\nreturn value }",
      'function pair(left, right) { return "${left}-${right}" }',
      "say pair(mark(2) + 1, 5)",
      "say pair(mark(3), mark(4) * 2)",
      'say "${order[0]}${order[1]}${order[2]}"',
    ].join("\n"),
  );

  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(sayTexts(result), ["3-5", "3-8", "234"]);
  assert.deepEqual(result.snapshot.temporaries, []);
});

test("lowers calls in templates, conditions, loop conditions, and returns", () => {
  const compiled = plan(
    [
      "function truth { return true }",
      "function nested { return truth() }",
      'if truth() { say "value ${nested()}" }',
      "while truth() { break }",
    ].join("\n"),
  );
  const { instructions } = compiled;
  // Names the function whose earlier call writes the temporary that the consumer reads.
  const calledFor = (consumer: number, value: ExpressionPlan) => {
    const callIndex = instructions.findIndex(
      (instruction) =>
        instruction.kind === "callFunction" &&
        value.kind === "temporary" &&
        instruction.destinationTemporary === value.temporaryId,
    );
    const call = instructions[callIndex];
    return callIndex < consumer && call?.kind === "callFunction"
      ? compiled.functions.find((definition) => definition.id === call.functionId)?.name
      : null;
  };
  const nested = compiled.functions.find((definition) => definition.name === "nested")!;
  const consumers = instructions.flatMap((instruction, index) => {
    switch (instruction.kind) {
      case "jumpIfFalse":
        return [["condition", calledFor(index, instruction.condition)]];
      case "loopStart":
        return [["loop", calledFor(index, instruction.expression)]];
      case "say":
        return instruction.value.kind === "template"
          ? instruction.value.parts.flatMap((part) =>
              part.kind === "expression" ? [["template", calledFor(index, part.expression)]] : [],
            )
          : [];
      case "returnValue":
        return index >= nested.entryInstruction && index < nested.endInstruction
          ? [["return", calledFor(index, instruction.value)]]
          : [];
      default:
        return [];
    }
  });

  assert.deepEqual(consumers, [
    ["condition", "truth"],
    ["template", "nested"],
    ["loop", "truth"],
    ["return", "truth"],
  ]);
});

test("evaluates a parameter default only when its argument is omitted", () => {
  const result = runSource(
    [
      "let counter = 0",
      "function next { counter = counter + 1\nreturn counter }",
      'function describe(name, count = next()) { return "${name}${count}" }',
      'say describe("a")',
      'say describe("b", 9)',
      'say describe("c")',
      "say counter",
    ].join("\n"),
  );

  assert.deepEqual(sayTexts(result), ["a1", "b9", "c2", "2"]);
});

test("keeps short-circuit evaluation of user calls inside parameter defaults", () => {
  const result = runSource(
    [
      'let calls = ""',
      'function falsy { calls = "${calls}f"\nreturn false }',
      'function mark { calls = "${calls}m"\nreturn true }',
      "function sample(value = falsy() and mark()) { return value }",
      "say sample()",
      "say sample(true)",
      'say "calls:${calls}"',
    ].join("\n"),
  );

  assert.deepEqual(sayTexts(result), ["false", "true", "calls:f"]);
});

test("function plans survive JSON round trips with preserved spans", () => {
  const original = plan(
    "function add(left, right) { return left + right }\nlet result = add(2, 3)",
  );
  const restored: unknown = JSON.parse(JSON.stringify(original));

  assert.deepEqual(restored, original);
  assert.equal(validateInstructionPlan(restored).valid, true);
  assert.deepEqual(original.functions[0]?.declarationSpan, {
    so: 0,
    sl: 0,
    sc: 0,
    eo: 49,
    el: 0,
    ec: 49,
  });
  const call = original.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.deepEqual(call === undefined ? null : [call.span.so, call.span.eo], [63, 72]);
});

test("rejects malformed function metadata, targets, and temporaries", () => {
  const original = plan("function value { return 1 }\nlet result = value()");

  const duplicateId = mutable(original);
  duplicateId.functions.push({ ...duplicateId.functions[0]! });
  assertInvalid(duplicateId, `$.functions[${duplicateId.functions.length - 1}].id`, "unique");

  const badEntry = mutable(original);
  badEntry.functions[0]!.entryInstruction = 999;
  assertInvalid(badEntry, "$.functions[0]");

  const badTemporary = mutable(original);
  const declaration = badTemporary.instructions.find(
    (instruction) => instruction.kind === "declareBinding",
  );
  assert.ok(declaration?.kind === "declareBinding");
  if (declaration?.kind === "declareBinding") {
    // EVIDENCE: fixture: expose the compiler-produced temporary reference for malformed-ID validation.
    (declaration.value as { temporaryId: number }).temporaryId = 999;
  }
  assertInvalid(
    badTemporary,
    `$.instructions[${firstIndex(badTemporary, "declareBinding")}].value.temporaryId`,
  );

  const badReturn = mutable(original);
  const call = badReturn.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.ok(call?.kind === "callFunction");
  if (call?.kind === "callFunction") call.returnInstruction += 1;
  assertInvalid(
    badReturn,
    `$.instructions[${firstIndex(badReturn, "callFunction")}].returnInstruction`,
  );

  const unknownFunction = mutable(original);
  const unknownCall = unknownFunction.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  );
  assert.ok(unknownCall?.kind === "callFunction");
  if (unknownCall?.kind === "callFunction") unknownCall.functionId = 999;
  assertInvalid(
    unknownFunction,
    `$.instructions[${firstIndex(unknownFunction, "callFunction")}].functionId`,
  );

  const malformedPrologue = mutable(original);
  const prepare = malformedPrologue.instructions.find(
    (instruction) => instruction.kind === "beginFunctionDefaults",
  );
  assert.ok(prepare?.kind === "beginFunctionDefaults");
  const malformedPrepare: { kind: string } = prepare;
  malformedPrepare.kind = "enterFunctionBody";
  assertInvalid(malformedPrologue, "$.functions[0].entryInstruction");
});

test("rejects malformed function regions and aliased call temporaries", () => {
  const defaults = plan(
    [
      "function helper { return 1 }",
      "function sample(value = helper()) { say value\nreturn value }",
      "say sample()",
    ].join("\n"),
  );
  const sample = defaults.functions.find((definition) => definition.name === "sample")!;

  const statementInDefault = mutable(defaults);
  const clearIndex = statementInDefault.instructions.findIndex(
    (instruction, index) =>
      index >= sample.entryInstruction &&
      index < sample.bodyEntryInstruction &&
      instruction.kind === "clearTemporary",
  );
  assert.ok(clearIndex >= 0);
  statementInDefault.instructions[clearIndex] = {
    kind: "returnVoid",
    span: statementInDefault.instructions[clearIndex]!.span,
  };
  assertInvalid(statementInDefault, `$.instructions[${clearIndex}]`, "default-expression region");

  const suppliedInBody = mutable(defaults);
  suppliedInBody.instructions[sample.bodyEntryInstruction] = {
    kind: "bindSuppliedParameter",
    functionId: sample.id,
    parameterIndex: 0,
    span: suppliedInBody.instructions[sample.bodyEntryInstruction]!.span,
  };
  assertInvalid(suppliedInBody, `$.instructions[${sample.bodyEntryInstruction}]`);

  const returnBeforeBody = mutable(defaults);
  const bindIndex = returnBeforeBody.instructions.findIndex(
    (instruction, index) =>
      index >= sample.entryInstruction &&
      index < sample.bodyEntryInstruction &&
      instruction.kind === "bindDefaultParameter",
  );
  assert.ok(bindIndex >= 0);
  const bind = returnBeforeBody.instructions[bindIndex];
  assert.ok(bind?.kind === "bindDefaultParameter");
  returnBeforeBody.instructions[bindIndex] = {
    kind: "returnValue",
    value: bind.value,
    span: bind.span,
  };
  assertInvalid(returnBeforeBody, `$.instructions[${bindIndex}]`);

  const calls = plan("function pair(left, right) { return left + right }\nsay pair(1, 2)");
  const aliasedDestination = mutable(calls);
  const aliasedCall = aliasedDestination.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  )!;
  aliasedCall.arguments[0]!.value = {
    kind: "temporary",
    temporaryId: aliasedCall.destinationTemporary,
    span: aliasedCall.arguments[0]!.value.span,
  };
  assertInvalid(
    aliasedDestination,
    `$.instructions[${firstIndex(aliasedDestination, "callFunction")}].destinationTemporary`,
  );

  const duplicateArgument = mutable(calls);
  const duplicateCall = duplicateArgument.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  )!;
  duplicateCall.arguments[1]!.parameterName = duplicateCall.arguments[0]!.parameterName;
  assertInvalid(
    duplicateArgument,
    `$.instructions[${firstIndex(duplicateArgument, "callFunction")}].arguments[1].parameterName`,
  );

  const callsWithCleanup = plan(
    [
      "function value { return 1 }",
      "function pair(left, right) { return left + right }",
      "say pair(value(), value())",
    ].join("\n"),
  );
  const emptyCleanup = mutable(callsWithCleanup);
  const emptyBatch = emptyCleanup.instructions.find(
    (instruction) => instruction.kind === "clearTemporaries",
  )!;
  emptyBatch.temporaryIds = [];
  assertInvalid(
    emptyCleanup,
    `$.instructions[${firstIndex(emptyCleanup, "clearTemporaries")}].temporaryIds`,
  );

  const duplicateCleanup = mutable(callsWithCleanup);
  const duplicateBatch = duplicateCleanup.instructions.find(
    (instruction) => instruction.kind === "clearTemporaries",
  )!;
  duplicateBatch.temporaryIds.push(duplicateBatch.temporaryIds[0]!);
  assertInvalid(
    duplicateCleanup,
    `$.instructions[${firstIndex(duplicateCleanup, "clearTemporaries")}].temporaryIds[${duplicateBatch.temporaryIds.length - 1}]`,
  );

  const unknownCleanup = mutable(callsWithCleanup);
  const unknownBatch = unknownCleanup.instructions.find(
    (instruction) => instruction.kind === "clearTemporaries",
  )!;
  unknownBatch.temporaryIds[0] = unknownCleanup.temporaryCount + 1;
  assertInvalid(
    unknownCleanup,
    `$.instructions[${firstIndex(unknownCleanup, "clearTemporaries")}].temporaryIds[0]`,
  );

  const unpreparedAssignment = mutable(plan("let items = [0]\nitems[0] = 1"));
  const assignment = unpreparedAssignment.instructions.find(
    (instruction) => instruction.kind === "assign",
  );
  assert.ok(assignment?.kind === "assign" && assignment.target.kind === "index");
  assignment.target.index = { kind: "literal", value: 0, span: assignment.target.index.span };
  assertInvalid(
    unpreparedAssignment,
    `$.instructions[${firstIndex(unpreparedAssignment, "assign")}].target.index`,
  );
});

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

type MutablePlan = Mutable<InstructionPlan>;

function functionName(compiled: InstructionPlan, id: number): string | undefined {
  return compiled.functions.find((definition) => definition.id === id)?.name;
}

function mutable(value: InstructionPlan): MutablePlan {
  // EVIDENCE: fixture: JSON round-trip preserves the plan shape while removing readonly ownership for malformed-field tests.
  return JSON.parse(JSON.stringify(value)) as MutablePlan;
}

function firstIndex(value: MutablePlan, kind: Instruction["kind"]): number {
  return value.instructions.findIndex((instruction) => instruction.kind === kind);
}

/**
 * Plan errors share TSC002, so the affected path identifies the rule; a short
 * fragment is added only where two rules report the same path.
 */
function assertInvalid(value: unknown, path: string, fragment?: string): void {
  const validation = validateInstructionPlan(value);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some(
      (error) =>
        error.code === "TSC002" &&
        error.path === path &&
        (fragment === undefined || error.message.includes(fragment)),
    ),
    `${path}: ${JSON.stringify(validation.errors)}`,
  );
}
