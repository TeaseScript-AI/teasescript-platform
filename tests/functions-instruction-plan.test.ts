import assert from "node:assert/strict";
import test from "node:test";

import type { ExpressionPlan, Instruction, InstructionPlan } from "../src/plan/model.js";
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
  assert.deepEqual(
    first.functions.map((definition) => [definition.id, definition.name]),
    [
      [1, "first"],
      [2, "second"],
    ],
  );
  assert.equal(first.temporaryCount, 2);
  assert.deepEqual(
    first.instructions
      .filter((instruction) => instruction.kind === "callFunction")
      .map((instruction) => [instruction.functionId, instruction.destinationTemporary]),
    [
      [1, 1],
      [2, 2],
    ],
  );
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
    calls.map((instruction) => instruction.functionId),
    [1, 2, 3],
  );
  const outer = calls[2];
  assert.equal(outer?.kind, "callFunction");
  if (outer?.kind !== "callFunction") return;
  assert.deepEqual(
    outer.arguments.map((argument) => argument.parameterName),
    ["left", "right"],
  );
  assert.equal(outer.arguments[0]!.value.kind, "temporary");
  assert.equal(outer.arguments[1]!.value.kind, "temporary");
  if (
    outer.arguments[0]!.value.kind === "temporary" &&
    outer.arguments[1]!.value.kind === "temporary"
  ) {
    assert.ok(outer.arguments[0]!.value.temporaryId < outer.arguments[1]!.value.temporaryId);
  }
  const destinationOf = (name: string) => {
    const id = compiled.functions.find((definition) => definition.name === name)?.id;
    const call = calls.find(
      (instruction) => instruction.kind === "callFunction" && instruction.functionId === id,
    );
    return call?.kind === "callFunction" ? call.destinationTemporary : null;
  };
  assert.deepEqual(
    outer.arguments.map((argument) =>
      argument.value.kind === "temporary" ? argument.value.temporaryId : null,
    ),
    [destinationOf("first"), destinationOf("second")],
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
    (instruction) => instruction.kind === "callFunction" && instruction.functionId === 2,
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
    (instruction) => instruction.kind === "callFunction" && instruction.functionId === 2,
  );
  assert.equal(outer?.kind, "callFunction");
  if (outer?.kind !== "callFunction") return;

  assert.equal(outer.arguments[0]!.value.kind, "temporary");
  assert.deepEqual(
    root.map((instruction) => instruction.kind),
    [
      "callFunction",
      "storeTemporary",
      "callFunction",
      "clearTemporaries",
      "evaluate",
      "clearTemporary",
    ],
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
    .filter((instruction) => instruction.kind === "callFunction")
    .map((instruction) => instruction.functionId);

  assert.deepEqual(calls, [1, 2, 3, 4]);
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

test("compiles defaults as executable prologues and inserts implicit returns", () => {
  const compiled = plan(
    [
      "function helper(value) { return value }",
      "function sample(required, optional = helper(2)) { say optional }",
      "sample(1)",
    ].join("\n"),
  );
  const sample = compiled.functions.find((definition) => definition.name === "sample")!;
  const helper = compiled.functions.find((definition) => definition.name === "helper")!;
  const prologue = compiled.instructions.slice(
    sample.entryInstruction,
    sample.bodyEntryInstruction,
  );

  assert.deepEqual(
    sample.parameters.map((parameter) => parameter.hasDefault),
    [false, true],
  );
  assert.ok(prologue.some((instruction) => instruction.kind === "bindSuppliedParameter"));
  assert.ok(prologue.some((instruction) => instruction.kind === "prepareParameterDefault"));
  assert.ok(prologue.some((instruction) => instruction.kind === "callFunction"));
  assert.ok(prologue.some((instruction) => instruction.kind === "bindDefaultParameter"));
  assert.equal(compiled.instructions[sample.implicitReturnInstruction]?.kind, "returnVoid");

  const optional = sample.parameters.findIndex((parameter) => parameter.name === "optional");
  const [guardIndex] = prologueIndexes(
    compiled,
    sample,
    (instruction) =>
      instruction.kind === "prepareParameterDefault" && instruction.parameterIndex === optional,
  );
  const [callIndex] = prologueIndexes(
    compiled,
    sample,
    (instruction) => instruction.kind === "callFunction" && instruction.functionId === helper.id,
  );
  const [bindIndex] = prologueIndexes(
    compiled,
    sample,
    (instruction) =>
      instruction.kind === "bindDefaultParameter" && instruction.parameterIndex === optional,
  );
  const guard = compiled.instructions[guardIndex!];
  const call = compiled.instructions[callIndex!];
  const bind = compiled.instructions[bindIndex!];
  assert.ok(
    guard?.kind === "prepareParameterDefault" &&
      call?.kind === "callFunction" &&
      bind?.kind === "bindDefaultParameter",
  );
  // An omitted argument runs the default call and binding; a supplied one jumps past both.
  assert.ok(guardIndex! < callIndex! && callIndex! < bindIndex! && bindIndex! < guard.target);
  assert.ok(guard.target <= sample.bodyEntryInstruction);
  assert.equal(
    bind.value.kind === "temporary" ? bind.value.temporaryId : null,
    call.destinationTemporary,
  );
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
  assert.ok(prologue.some((instruction) => instruction.kind === "jumpIfFalse"));
  assert.equal(
    prologue.filter((instruction) => instruction.kind === "bindDefaultParameter").length,
    1,
  );
  const truth = compiled.functions.find((definition) => definition.name === "truth")!;
  const [firstCall, secondCall] = prologueIndexes(
    compiled,
    sample,
    (instruction) => instruction.kind === "callFunction" && instruction.functionId === truth.id,
  );
  const [guardIndex] = prologueIndexes(
    compiled,
    sample,
    (instruction) => instruction.kind === "jumpIfFalse",
  );
  const [bindIndex] = prologueIndexes(
    compiled,
    sample,
    (instruction) => instruction.kind === "bindDefaultParameter",
  );
  const guard = compiled.instructions[guardIndex!];
  const first = compiled.instructions[firstCall!];
  assert.ok(guard?.kind === "jumpIfFalse" && first?.kind === "callFunction");
  // A false first operand skips the second call and still reaches the default binding.
  assert.ok(firstCall! < guardIndex! && guardIndex! < secondCall!);
  assert.ok(secondCall! < guard.target && guard.target <= bindIndex!);
  // The guard reads the stored result of the first call, not an unrelated or constant value.
  assert.ok(guard.condition.kind === "temporary");
  const conditionTemporary = guard.condition.temporaryId;
  const conditionStores = compiled.instructions
    .slice(firstCall! + 1, guardIndex!)
    .filter(
      (instruction) =>
        instruction.kind === "storeTemporary" && instruction.temporaryId === conditionTemporary,
    );
  assert.equal(conditionStores.length, 1);
  const conditionStore = conditionStores[0];
  assert.ok(conditionStore?.kind === "storeTemporary");
  assert.equal(
    conditionStore.value.kind === "temporary" ? conditionStore.value.temporaryId : null,
    first.destinationTemporary,
  );
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
  assertInvalid(duplicateId, /Function IDs|ranges/u);

  const badEntry = mutable(original);
  badEntry.functions[0]!.entryInstruction = 999;
  assertInvalid(badEntry, /range|entry/u);

  const badTemporary = mutable(original);
  const declaration = badTemporary.instructions.find(
    (instruction) => instruction.kind === "declareBinding",
  );
  assert.ok(declaration?.kind === "declareBinding");
  if (declaration?.kind === "declareBinding") {
    // EVIDENCE: fixture: expose the compiler-produced temporary reference for malformed-ID validation.
    (declaration.value as { temporaryId: number }).temporaryId = 999;
  }
  assertInvalid(badTemporary, /Temporary/u);

  const badReturn = mutable(original);
  const call = badReturn.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.ok(call?.kind === "callFunction");
  if (call?.kind === "callFunction") call.returnInstruction += 1;
  assertInvalid(badReturn, /return target/u);

  const unknownFunction = mutable(original);
  const unknownCall = unknownFunction.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  );
  assert.ok(unknownCall?.kind === "callFunction");
  if (unknownCall?.kind === "callFunction") unknownCall.functionId = 999;
  assertInvalid(unknownFunction, /unknown function/u);

  const malformedPrologue = mutable(original);
  const prepare = malformedPrologue.instructions.find(
    (instruction) => instruction.kind === "beginFunctionDefaults",
  );
  assert.ok(prepare?.kind === "beginFunctionDefaults");
  const malformedPrepare: { kind: string } = prepare;
  malformedPrepare.kind = "enterFunctionBody";
  assertInvalid(malformedPrologue, /prologue|entry/u);
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
  assertInvalid(statementInDefault, /default-expression region/u);

  const suppliedInBody = mutable(defaults);
  suppliedInBody.instructions[sample.bodyEntryInstruction] = {
    kind: "bindSuppliedParameter",
    functionId: sample.id,
    parameterIndex: 0,
    span: suppliedInBody.instructions[sample.bodyEntryInstruction]!.span,
  };
  assertInvalid(suppliedInBody, /prologue instruction.*body/u);

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
  assertInvalid(returnBeforeBody, /default-expression region|default/u);

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
  assertInvalid(aliasedDestination, /must not alias/u);

  const duplicateArgument = mutable(calls);
  const duplicateCall = duplicateArgument.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  )!;
  duplicateCall.arguments[1]!.parameterName = duplicateCall.arguments[0]!.parameterName;
  assertInvalid(duplicateArgument, /more than once/u);

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
  assertInvalid(emptyCleanup, /non-empty array/u);

  const duplicateCleanup = mutable(callsWithCleanup);
  const duplicateBatch = duplicateCleanup.instructions.find(
    (instruction) => instruction.kind === "clearTemporaries",
  )!;
  duplicateBatch.temporaryIds.push(duplicateBatch.temporaryIds[0]!);
  assertInvalid(duplicateCleanup, /must not contain duplicates/u);

  const unknownCleanup = mutable(callsWithCleanup);
  const unknownBatch = unknownCleanup.instructions.find(
    (instruction) => instruction.kind === "clearTemporaries",
  )!;
  unknownBatch.temporaryIds[0] = unknownCleanup.temporaryCount + 1;
  assertInvalid(unknownCleanup, /Temporary/u);

  const unpreparedAssignment = mutable(plan("let items = [0]\nitems[0] = 1"));
  const assignment = unpreparedAssignment.instructions.find(
    (instruction) => instruction.kind === "assign",
  );
  assert.ok(assignment?.kind === "assign" && assignment.target.kind === "index");
  assignment.target.index = { kind: "literal", value: 0, span: assignment.target.index.span };
  assertInvalid(unpreparedAssignment, /indexes must be prepared/u);
});

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

type MutablePlan = Mutable<InstructionPlan>;

function prologueIndexes(
  compiled: InstructionPlan,
  definition: InstructionPlan["functions"][number],
  predicate: (instruction: Instruction) => boolean,
): number[] {
  const indexes: number[] = [];
  for (
    let index = definition.entryInstruction;
    index < definition.bodyEntryInstruction;
    index += 1
  ) {
    if (predicate(compiled.instructions[index]!)) indexes.push(index);
  }
  return indexes;
}

function mutable(value: InstructionPlan): MutablePlan {
  // EVIDENCE: fixture: JSON round-trip preserves the plan shape while removing readonly ownership for malformed-field tests.
  return JSON.parse(JSON.stringify(value)) as MutablePlan;
}

function assertInvalid(value: unknown, message: RegExp): void {
  const validation = validateInstructionPlan(value);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => message.test(error.message)),
    JSON.stringify(validation.errors),
  );
}
