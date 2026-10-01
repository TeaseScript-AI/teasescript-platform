import assert from "node:assert/strict";
import test from "node:test";

import type { ExpressionPlan, InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("assigns deterministic function and temporary IDs", () => {
  const source = [
    "function first { return 1 }",
    "function second { return 2 }",
    "let result = first() + second()",
  ].join("\n");
  const first = plan(source);
  const second = plan(source);

  assert.deepEqual(second, first);
  const ids = first.functions.map((definition) => definition.id);
  assert.equal(new Set(ids).size, ids.length);
  const calls = first.instructions.flatMap((instruction) =>
    instruction.kind === "callFunction" ? [instruction] : [],
  );
  assert.deepEqual(
    calls.map((call) => functionName(first, call.functionId)),
    ["first", "second"],
  );
  const destinations = calls.map((call) => call.destinationTemporary);
  assert.equal(new Set(destinations).size, destinations.length);
  assert.ok(destinations.every((id) => id >= 1 && id <= first.temporaryCount));
});

test("lowers nested calls and arguments in source order", () => {
  const compiled = plan(
    [
      "function first { return 1 }",
      "function second { return 2 }",
      "function outer(left, right) { return left + right }",
      "let result = outer(first(), second())",
    ].join("\n"),
  );
  const root = compiled.instructions.slice(0, compiled.rootEndInstruction);
  const calls = root.filter((instruction) => instruction.kind === "callFunction");

  assert.deepEqual(
    calls.map((instruction) => functionName(compiled, instruction.functionId)),
    ["first", "second", "outer"],
  );
  const outer = calls[2];
  assert.equal(outer?.kind, "callFunction");
  if (outer?.kind !== "callFunction") return;
  assert.deepEqual(
    outer.arguments.map((argument) => argument.parameterName),
    ["left", "right"],
  );
  const outerIndex = compiled.instructions.indexOf(outer);
  assert.deepEqual(
    outer.arguments.map((argument) => calledFunctionName(compiled, outerIndex, argument.value)),
    ["first", "second"],
  );
});

test("embeds synchronous call arguments without preparation instructions", () => {
  const compiled = plan(
    [
      "function combine(first, second, third) { return first + second + third }",
      "combine(1, 2, 3)",
    ].join("\n"),
  );
  const root = compiled.instructions.slice(0, compiled.rootEndInstruction);
  const callIndex = root.findIndex((instruction) => instruction.kind === "callFunction");
  const call = root[callIndex];
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
  assert.deepEqual(
    root.map((instruction) => instruction.kind),
    ["callFunction", "evaluate", "clearTemporary"],
  );
});

test("repeated synchronous multi-argument calls do not emit per-argument preparation", () => {
  const argumentCount = 12;
  const callCount = 25;
  const parameters = Array.from({ length: argumentCount }, (_, index) => `p${index}`).join(", ");
  const argumentsList = Array.from({ length: argumentCount }, (_, index) => String(index + 1)).join(
    ", ",
  );
  const compiled = plan(
    [
      `function sink(${parameters}) { return p0 }`,
      ...Array.from({ length: callCount }, () => `sink(${argumentsList})`),
    ].join("\n"),
  );
  const root = compiled.instructions.slice(0, compiled.rootEndInstruction);
  const calls = root.filter((instruction) => instruction.kind === "callFunction");

  assert.equal(calls.length, callCount);
  assert.equal(compiled.temporaryCount, callCount);
  assert.equal(root.filter((instruction) => instruction.kind === "storeTemporary").length, 0);
  assert.equal(root.filter((instruction) => instruction.kind === "clearTemporaries").length, 0);
  assert.ok(
    calls.every(
      (call) =>
        call.arguments.length === argumentCount &&
        call.arguments.every((argument) => argument.value.kind === "literal"),
    ),
  );
});

test("materializes only arguments that must survive a later user call", () => {
  const compiled = plan(
    [
      "function later { return 2 }",
      "function combine(first, second, third) { return first + second + third }",
      "combine(random(), later(), 3)",
    ].join("\n"),
  );
  const root = compiled.instructions.slice(0, compiled.rootEndInstruction);
  const outer = root.find(
    (instruction) =>
      instruction.kind === "callFunction" &&
      functionName(compiled, instruction.functionId) === "combine",
  );
  assert.equal(outer?.kind, "callFunction");
  if (outer?.kind !== "callFunction") return;

  assert.deepEqual(
    outer.arguments.map((argument) => argument.value.kind),
    ["temporary", "temporary", "literal"],
  );
  assert.equal(root.filter((instruction) => instruction.kind === "storeTemporary").length, 1);
  assert.equal(root.filter((instruction) => instruction.kind === "clearTemporaries").length, 1);
});

test("materializes a complete composite argument that emits instructions", () => {
  const compiled = plan(
    [
      "function inner { return 2 }",
      "function outer(value) { return value }",
      "outer(inner() + 1)",
    ].join("\n"),
  );
  const root = compiled.instructions.slice(0, compiled.rootEndInstruction);
  const outer = root.find(
    (instruction) =>
      instruction.kind === "callFunction" &&
      functionName(compiled, instruction.functionId) === "outer",
  );
  assert.equal(outer?.kind, "callFunction");
  if (outer?.kind !== "callFunction") return;

  // The whole `inner() + 1` value is stored before the outer call, passed by temporary, and
  // cleared after it.
  const argument = outer.arguments[0]!.value;
  assert.equal(argument.kind, "temporary");
  if (argument.kind !== "temporary") return;
  const outerIndex = root.indexOf(outer);
  const storeIndex = root.findIndex(
    (instruction) =>
      instruction.kind === "storeTemporary" && instruction.temporaryId === argument.temporaryId,
  );
  const store = root[storeIndex];
  assert.ok(store?.kind === "storeTemporary" && storeIndex < outerIndex);
  assert.equal(store.value.kind, "binary");
  if (store.value.kind !== "binary") return;
  assert.equal(calledFunctionName(compiled, storeIndex, store.value.left), "inner");
  assert.ok(
    root
      .slice(outerIndex + 1)
      .some(
        (instruction) =>
          (instruction.kind === "clearTemporaries" &&
            instruction.temporaryIds.includes(argument.temporaryId)) ||
          (instruction.kind === "clearTemporary" &&
            instruction.temporaryId === argument.temporaryId),
      ),
  );
});

test("lowers property receivers and assignment targets in source order", () => {
  const compiled = plan(
    [
      "let items = [0]",
      "function receiver { return items }",
      "function argument { return 1 }",
      "function indexFunction { return 0 }",
      "function valueFunction { return 7 }",
      "receiver().add(argument())",
      "items[indexFunction()] = valueFunction()",
    ].join("\n"),
  );
  const calls = compiled.instructions
    .slice(0, compiled.rootEndInstruction)
    .flatMap((instruction) =>
      instruction.kind === "callFunction" ? [functionName(compiled, instruction.functionId)] : [],
    );

  assert.deepEqual(calls, ["receiver", "argument", "indexFunction", "valueFunction"]);
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

  const nested = compiled.functions.find((definition) => definition.name === "nested")!;
  const consumers = compiled.instructions.flatMap(
    (instruction, index): [string, string | null][] => {
      const producer = (value: ExpressionPlan | undefined) =>
        calledFunctionName(compiled, index, value);
      if (instruction.kind === "jumpIfFalse") return [["if", producer(instruction.condition)]];
      if (instruction.kind === "loopStart") return [["while", producer(instruction.expression)]];
      if (instruction.kind === "say" && instruction.value.kind === "template") {
        const part = instruction.value.parts.find((candidate) => candidate.kind === "expression");
        return [["template", producer(part?.expression)]];
      }
      if (
        instruction.kind === "returnValue" &&
        index >= nested.entryInstruction &&
        index < nested.endInstruction
      ) {
        return [["nested return", producer(instruction.value)]];
      }
      return [];
    },
  );

  assert.deepEqual(consumers.sort(), [
    ["if", "truth"],
    ["nested return", "truth"],
    ["template", "nested"],
    ["while", "truth"],
  ]);
});

test("compiles defaults as executable prologues and inserts implicit returns", () => {
  const compiled = plan(
    [
      "function helper(value) { return value }",
      "function sample(required, optional = helper(2)) { say optional }",
      "sample(1)",
    ].join("\n"),
  );
  const sample = compiled.functions.find((definition) => definition.name === "sample")!;
  const prologue = compiled.instructions.slice(
    sample.entryInstruction,
    sample.bodyEntryInstruction,
  );

  assert.deepEqual(
    sample.parameters.map((parameter) => parameter.hasDefault),
    [false, true],
  );
  assert.ok(prologue.some((instruction) => instruction.kind === "bindSuppliedParameter"));
  // A supplied `optional` argument jumps over its whole default evaluation and binding.
  const guardIndex = compiled.instructions.findIndex(
    (instruction, index) =>
      index >= sample.entryInstruction &&
      instruction.kind === "prepareParameterDefault" &&
      instruction.parameterIndex === 1,
  );
  const guard = compiled.instructions[guardIndex];
  assert.ok(guard?.kind === "prepareParameterDefault");
  assert.ok(guard.target <= sample.bodyEntryInstruction);
  const skipped = compiled.instructions.slice(guardIndex + 1, guard.target);
  const binding = skipped.find((instruction) => instruction.kind === "bindDefaultParameter");
  assert.ok(binding?.kind === "bindDefaultParameter");
  assert.equal(binding.parameterIndex, 1);
  assert.equal(
    calledFunctionName(compiled, compiled.instructions.indexOf(binding), binding.value),
    "helper",
  );
  assert.equal(compiled.instructions[sample.implicitReturnInstruction]?.kind, "returnVoid");
});

test("accepts nested calls and short-circuit lowering inside defaults", () => {
  const compiled = plan(
    [
      "function truth { return true }",
      "function sample(value = truth() and truth()) { return value }",
      "say sample()",
    ].join("\n"),
  );

  assert.equal(validateInstructionPlan(compiled).valid, true);
  const sample = compiled.functions.find((definition) => definition.name === "sample")!;
  const prologue = compiled.instructions.slice(
    sample.entryInstruction,
    sample.bodyEntryInstruction,
  );
  const truthId = compiled.functions.find((definition) => definition.name === "truth")!.id;
  const truthCalls = prologue.flatMap((instruction, offset) =>
    instruction.kind === "callFunction" && instruction.functionId === truthId
      ? [sample.entryInstruction + offset]
      : [],
  );
  assert.equal(truthCalls.length, 2);
  const firstCall = truthCalls[0]!;
  const secondCall = truthCalls[1]!;
  // `and` evaluates the second operand only behind a guard after the first call.
  const guardIndex = compiled.instructions.findIndex(
    (instruction, index) =>
      index > firstCall && index < secondCall && instruction.kind === "jumpIfFalse",
  );
  const guard = compiled.instructions[guardIndex];
  assert.ok(guard?.kind === "jumpIfFalse");
  assert.ok(guard.target > secondCall);
  const bindings = prologue.flatMap((instruction, offset) =>
    instruction.kind === "bindDefaultParameter" ? [sample.entryInstruction + offset] : [],
  );
  assert.equal(bindings.length, 1);
  assert.ok(bindings[0]! >= guard.target);
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
  assertInvalid(duplicateId, "$.functions[1].id");

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
  assertInvalid(badTemporary, `${instructionPath(badTemporary, declaration)}.value.temporaryId`);

  const badReturn = mutable(original);
  const call = badReturn.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.ok(call?.kind === "callFunction");
  if (call?.kind === "callFunction") call.returnInstruction += 1;
  assertInvalid(badReturn, `${instructionPath(badReturn, call)}.returnInstruction`);

  const unknownFunction = mutable(original);
  const unknownCall = unknownFunction.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  );
  assert.ok(unknownCall?.kind === "callFunction");
  if (unknownCall?.kind === "callFunction") unknownCall.functionId = 999;
  assertInvalid(unknownFunction, `${instructionPath(unknownFunction, unknownCall)}.functionId`);

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
  assertInvalid(statementInDefault, `$.instructions[${clearIndex}]`);

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
    `${instructionPath(aliasedDestination, aliasedCall)}.destinationTemporary`,
  );

  const duplicateArgument = mutable(calls);
  const duplicateCall = duplicateArgument.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  )!;
  duplicateCall.arguments[1]!.parameterName = duplicateCall.arguments[0]!.parameterName;
  assertInvalid(
    duplicateArgument,
    `${instructionPath(duplicateArgument, duplicateCall)}.arguments[1].parameterName`,
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
  assertInvalid(emptyCleanup, `${instructionPath(emptyCleanup, emptyBatch)}.temporaryIds`);

  const duplicateCleanup = mutable(callsWithCleanup);
  const duplicateBatch = duplicateCleanup.instructions.find(
    (instruction) => instruction.kind === "clearTemporaries",
  )!;
  const duplicatePosition = duplicateBatch.temporaryIds.push(duplicateBatch.temporaryIds[0]!) - 1;
  assertInvalid(
    duplicateCleanup,
    `${instructionPath(duplicateCleanup, duplicateBatch)}.temporaryIds[${duplicatePosition}]`,
  );

  const unknownCleanup = mutable(callsWithCleanup);
  const unknownBatch = unknownCleanup.instructions.find(
    (instruction) => instruction.kind === "clearTemporaries",
  )!;
  unknownBatch.temporaryIds[0] = unknownCleanup.temporaryCount + 1;
  assertInvalid(unknownCleanup, `${instructionPath(unknownCleanup, unknownBatch)}.temporaryIds[0]`);

  const unpreparedAssignment = mutable(plan("let items = [0]\nitems[0] = 1"));
  const assignment = unpreparedAssignment.instructions.find(
    (instruction) => instruction.kind === "assign",
  );
  assert.ok(assignment?.kind === "assign" && assignment.target.kind === "index");
  assignment.target.index = { kind: "literal", value: 0, span: assignment.target.index.span };
  assertInvalid(
    unpreparedAssignment,
    `${instructionPath(unpreparedAssignment, assignment)}.target.index`,
  );
});

function functionName(compiled: InstructionPlan, id: number): string | undefined {
  return compiled.functions.find((definition) => definition.id === id)?.name;
}

/** Resolves the user function whose earlier call result supplies a temporary operand. */
function calledFunctionName(
  compiled: InstructionPlan,
  consumerIndex: number,
  value: ExpressionPlan | undefined,
): string | null {
  if (value?.kind !== "temporary") return null;
  const producers = compiled.instructions
    .slice(0, consumerIndex)
    .flatMap((instruction) =>
      instruction.kind === "callFunction" && instruction.destinationTemporary === value.temporaryId
        ? [instruction.functionId]
        : [],
    );
  assert.equal(producers.length, 1, `temporary ${value.temporaryId} producers`);
  return compiled.functions.find((definition) => definition.id === producers[0])?.name ?? null;
}

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

type MutablePlan = Mutable<InstructionPlan>;

function mutable(value: InstructionPlan): MutablePlan {
  // EVIDENCE: fixture: JSON round-trip preserves the plan shape while removing readonly ownership for malformed-field tests.
  return JSON.parse(JSON.stringify(value)) as MutablePlan;
}

function instructionPath(
  value: MutablePlan,
  instruction: MutablePlan["instructions"][number] | undefined,
): string {
  const index = instruction === undefined ? -1 : value.instructions.indexOf(instruction);
  assert.ok(index >= 0);
  return `$.instructions[${index}]`;
}

/** Requires the structured plan error for the corrupted field rather than its message wording. */
function assertInvalid(value: unknown, path: string): void {
  const validation = validateInstructionPlan(value);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => error.code === "TSC002" && error.path === path),
    `${path}: ${JSON.stringify(validation.errors)}`,
  );
}
