import assert from "node:assert/strict";
import test from "node:test";

import type { Expression, FunctionDeclaration, Identifier, Statement } from "../src/ast.js";
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

test("avoids superlinear subtree scans while lowering nested expressions", () => {
  // A user call at the deepest leaf makes every enclosing level take the instruction-emitting
  // lowering path, which classifies each subtree (#381). The pure chain takes the direct path.
  for (const leafCallsUserFunction of [true, false]) {
    const reads32 = compileCountedBinaryChain(32, leafCallsUserFunction);
    const reads64 = compileCountedBinaryChain(64, leafCallsUserFunction);
    const reads128 = compileCountedBinaryChain(128, leafCallsUserFunction);

    // For reads = a * n + b, doubling n doubles the increment; rescanning every
    // subtree (a * n ** 2) quadruples it. Fixed overhead and the coefficient may change.
    const firstIncrement = reads64 - reads32;
    const secondIncrement = reads128 - reads64;
    const counts = `${String(leafCallsUserFunction)}: ${reads32}, ${reads64}, ${reads128}`;
    assert.ok(reads32 > 0 && firstIncrement > 0, counts);
    assert.ok(secondIncrement < firstIncrement * 3, counts);
  }
});

test("preserves ordered user calls and interaction resume through the public source path", () => {
  const plan = compiled(
    [
      "let order = []",
      "function mark(value) { order.add(value)\nreturn value }",
      'function combine(first, second, third) { return "${first}:${second}:${third}" }',
      'let answer = combine(mark("before"), askText, mark("after"))',
      'say "${answer}|${order[0]}|${order[1]}", instant',
      "exit",
    ].join("\n"),
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

function compileCountedBinaryChain(binaryCount: number, leafCallsUserFunction: boolean): number {
  let childReads = 0;
  const callee: Identifier = { kind: "identifier", name: "leaf", span };
  const declaration: FunctionDeclaration = {
    kind: "functionDeclaration",
    global: false,
    name: callee,
    parameters: [],
    returnTypeAnnotation: null,
    body: { kind: "block", statements: [], span },
    span,
  };
  let expression: Expression = leafCallsUserFunction
    ? { kind: "callExpression", callee, arguments: [], argumentStyle: "none", span }
    : numberLiteral(0);
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
  new InstructionCompiler([declaration]).compileStatements([statement]);
  return childReads;
}

function numberLiteral(value: number): Expression {
  return { kind: "numberLiteral", raw: String(value), value, numericType: "integer", span };
}
