import assert from "node:assert/strict";
import test from "node:test";

import type { Expression, Statement } from "../src/ast.js";
import { InstructionCompiler } from "../src/compiler/lowering/compiler.js";
import {
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  run,
  serializeCheckpoint,
} from "../src/index.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";
import { compileValidPlan as compiled } from "./helpers/compile-valid-plan.js";

const span = createSourceSpan(createSourcePosition(0, 0, 0), createSourcePosition(1, 0, 1));

test("classifies nested lowering subtrees once", () => {
  const binaryCounts = [32, 64, 128];
  const childReads = binaryCounts.map(compileCountedBinaryChain);

  // Each child is read once during bottom-up classification and once during lowering.
  assert.deepEqual(
    childReads,
    binaryCounts.map((binaryCount) => binaryCount * 4 - 2),
  );
});

test("preserves ordered user calls and interaction resume through the public source path", () => {
  const plan = compiled(
    [
      "let order = []",
      "function mark(value) { order.add(value)\nreturn value }",
      "function combine(first, second, third) { return `${first}:${second}:${third}` }",
      'let answer = combine(mark("before"), askText, mark("after"))',
      "say `${answer}|${order[0]}|${order[1]}`, instant",
    ].join("\n"),
  );
  const rootCalls = plan.instructions
    .slice(0, plan.rootEndInstruction)
    .filter((instruction) => instruction.kind === "callFunction");
  assert.deepEqual(
    rootCalls.map((instruction) => instruction.functionId),
    [1, 1, 2],
  );
  assert.deepEqual(
    rootCalls[2]!.arguments.map((argument) => argument.value.kind),
    ["temporary", "temporary", "temporary"],
  );

  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const checkpoint = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
  );
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const request = {
    actionId: action.actionId,
    actionKind: "interaction" as const,
    interactionKind: "text" as const,
    payload: { kind: "submittedText" as const, submittedText: "answer" },
  };

  const uninterruptedCompletion = completeAction(plan, pending.snapshot, request);
  const restoredCompletion = completeAction(checkpoint.plan, checkpoint.snapshot, request);
  assert.equal(uninterruptedCompletion.outcome.kind, "completed");
  assert.deepEqual(restoredCompletion, uninterruptedCompletion);

  const uninterrupted = run(plan, uninterruptedCompletion.snapshot);
  const resumed = run(checkpoint.plan, restoredCompletion.snapshot);
  assert.deepEqual(resumed.events, uninterrupted.events);
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
  assert.equal(
    resumed.events.find((event) => event.kind === "say")?.text,
    "before:answer:after|before|after",
  );
});

function compileCountedBinaryChain(binaryCount: number): number {
  let childReads = 0;
  let expression: Expression = numberLiteral(0);
  for (let index = 1; index <= binaryCount; index += 1) {
    const left = expression;
    const right = numberLiteral(index);
    expression = {
      kind: "binaryExpression",
      operator: "+",
      get left() {
        childReads += 1;
        return left;
      },
      get right() {
        childReads += 1;
        return right;
      },
      span,
    };
  }

  const statement: Statement = {
    kind: "letStatement",
    name: { kind: "identifier", name: "result", span },
    typeAnnotation: null,
    initializer: expression,
    span,
  };
  new InstructionCompiler([]).compileStatements([statement]);
  return childReads;
}

function numberLiteral(value: number): Expression {
  return { kind: "numberLiteral", raw: String(value), value, numericType: "integer", span };
}
