import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  validateInstructionPlan,
  type InstructionPlan,
} from "../src/instructions.js";

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
    [[1, "first"], [2, "second"]],
  );
  assert.equal(first.temporaryCount, 2);
  assert.deepEqual(
    first.instructions
      .filter((instruction) => instruction.kind === "callFunction")
      .map((instruction) => [instruction.functionId, instruction.destinationTemporary]),
    [[1, 1], [2, 2]],
  );
});

test("lowers nested calls and arguments in source order", () => {
  const compiled = plan([
    "function first { return 1 }",
    "function second { return 2 }",
    "function outer(left, right) { return left + right }",
    "let result = outer(first(), second())",
  ].join("\n"));
  const root = compiled.instructions.slice(0, compiled.rootEndInstruction);
  const calls = root.filter((instruction) => instruction.kind === "callFunction");

  assert.deepEqual(calls.map((instruction) => instruction.functionId), [1, 2, 3]);
  const outer = calls[2];
  assert.equal(outer?.kind, "callFunction");
  if (outer?.kind !== "callFunction") return;
  assert.deepEqual(outer.arguments.map((argument) => argument.parameterName), [
    "left",
    "right",
  ]);
  assert.ok(outer.arguments[0]!.temporaryId < outer.arguments[1]!.temporaryId);
});

test("lowers property receivers and assignment targets in source order", () => {
  const compiled = plan([
    "let items = [0]",
    "function receiver { return items }",
    "function argument { return 1 }",
    "function indexFunction { return 0 }",
    "function valueFunction { return 7 }",
    "receiver().add(argument())",
    "items[indexFunction()] = valueFunction()",
  ].join("\n"));
  const calls = compiled.instructions
    .slice(0, compiled.rootEndInstruction)
    .filter((instruction) => instruction.kind === "callFunction")
    .map((instruction) => instruction.functionId);

  assert.deepEqual(calls, [1, 2, 3, 4]);
});

test("lowers calls in templates, conditions, loop conditions, and returns", () => {
  const compiled = plan([
    "function truth { return true }",
    "function nested { return truth() }",
    "if truth() { say `value ${nested()}` }",
    "while truth() { break }",
  ].join("\n"));

  assert.ok(compiled.instructions.some((instruction) => instruction.kind === "jumpIfFalse"));
  assert.ok(compiled.instructions.some((instruction) => instruction.kind === "loopStart"));
  assert.ok(compiled.instructions.some((instruction) => instruction.kind === "returnValue"));
  assert.ok(
    compiled.instructions.some(
      (instruction) =>
        instruction.kind === "say" &&
        instruction.value.kind === "template" &&
        instruction.value.parts.some(
          (part) => part.kind === "expression" && part.expression.kind === "temporary",
        ),
    ),
  );
});

test("compiles defaults as executable prologues and inserts implicit returns", () => {
  const compiled = plan([
    "function helper { return 2 }",
    "function sample(required, optional = helper()) { say optional }",
    "sample(1)",
  ].join("\n"));
  const sample = compiled.functions[1]!;
  const prologue = compiled.instructions.slice(
    sample.entryInstruction,
    sample.bodyEntryInstruction,
  );

  assert.deepEqual(sample.parameters.map((parameter) => parameter.hasDefault), [false, true]);
  assert.ok(prologue.some((instruction) => instruction.kind === "bindSuppliedParameter"));
  assert.ok(prologue.some((instruction) => instruction.kind === "prepareParameterDefault"));
  assert.ok(prologue.some((instruction) => instruction.kind === "callFunction"));
  assert.ok(prologue.some((instruction) => instruction.kind === "bindDefaultParameter"));
  assert.equal(compiled.instructions[sample.implicitReturnInstruction]?.kind, "returnVoid");
});

test("accepts nested calls and short-circuit lowering inside defaults", () => {
  const compiled = plan([
    "function truth { return true }",
    "function sample(value = truth() and truth()) { return value }",
    "say sample()",
  ].join("\n"));

  assert.equal(validateInstructionPlan(compiled).valid, true);
  const sample = compiled.functions.find((definition) => definition.name === "sample")!;
  const prologue = compiled.instructions.slice(sample.entryInstruction, sample.bodyEntryInstruction);
  assert.ok(prologue.some((instruction) => instruction.kind === "jumpIfFalse"));
  assert.equal(
    prologue.filter((instruction) => instruction.kind === "bindDefaultParameter").length,
    1,
  );
});

test("function plans survive JSON round trips with preserved spans", () => {
  const original = plan("function add(left, right) { return left + right }\nlet result = add(2, 3)");
  const restored = JSON.parse(JSON.stringify(original)) as unknown;

  assert.deepEqual(restored, original);
  assert.equal(validateInstructionPlan(restored).valid, true);
  assert.deepEqual(original.functions[0]?.declarationSpan, {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 49, line: 0, column: 49 },
  });
  const call = original.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.deepEqual(
    call === undefined ? null : [call.span.start.offset, call.span.end.offset],
    [63, 72],
  );
});

test("rejects malformed v3 function metadata, targets, and temporaries", () => {
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
    (declaration.value as { temporaryId: number }).temporaryId = 999;
  }
  assertInvalid(badTemporary, /Temporary/u);

  const badReturn = mutable(original);
  const call = badReturn.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  );
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
  assert.ok(prepare !== undefined);
  prepare.kind = "enterFunctionBody";
  assertInvalid(malformedPrologue, /prologue|entry/u);
});

test("rejects malformed function regions and aliased call temporaries", () => {
  const defaults = plan([
    "function helper { return 1 }",
    "function sample(value = helper()) { say value\nreturn value }",
    "say sample()",
  ].join("\n"));
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
  const bind = returnBeforeBody.instructions[bindIndex]!;
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
  aliasedCall.destinationTemporary = aliasedCall.arguments[0]!.temporaryId;
  assertInvalid(aliasedDestination, /must not alias/u);

  const duplicateArgument = mutable(calls);
  const duplicateCall = duplicateArgument.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  )!;
  duplicateCall.arguments[1]!.temporaryId = duplicateCall.arguments[0]!.temporaryId;
  assertInvalid(duplicateArgument, /temporary IDs must be unique/u);

  const unpreparedAssignment = mutable(plan("let items = [0]\nitems[0] = 1"));
  const assignment = unpreparedAssignment.instructions.find(
    (instruction) => instruction.kind === "assign",
  )!;
  assignment.target.index = {
    kind: "literal",
    value: 0,
    span: assignment.target.index.span,
  };
  assertInvalid(unpreparedAssignment, /indexes must be prepared/u);
});

test("rejects instruction-plan versions 1 and 2", () => {
  for (const version of [1, 2]) {
    const legacy = mutable(plan("exit")) as { version: number };
    legacy.version = version;
    const validation = validateInstructionPlan(legacy);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "TSC001"));
  }
});

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

type MutablePlan = {
  -readonly [Key in keyof InstructionPlan]: Key extends "functions" | "instructions"
    ? Array<Record<string, any>>
    : InstructionPlan[Key];
};

function mutable(value: InstructionPlan): MutablePlan {
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
