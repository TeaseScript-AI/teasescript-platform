import assert from "node:assert/strict";

import type { ExpressionPlan, InstructionPlan, SayInstruction } from "../../src/plan/model.js";
import { sayStagesSelectively } from "../../src/runtime/instructions/say-staging.js";

/**
 * `plan` with each say that stages selectively made to stage on a deep copy of the state instead, so that a test can
 * compare both stagings of one script. One expression such a say evaluates, its value or for prepared text its
 * presentation or pacing, becomes `expression otherwise [].sort()`. For any value but null that gives the value without
 * evaluating the call, and for null it sorts an empty list that nothing refers to, which gives null again, so the say
 * runs the same. A method that changes its receiver keeps a say from staging selectively whether it runs or not. A say
 * that evaluates no expression stays as it is.
 */
export function withDeepSayStaging(plan: InstructionPlan): InstructionPlan {
  return {
    ...plan,
    instructions: plan.instructions.map((instruction) => {
      if (instruction.kind !== "say" || !sayStagesSelectively(instruction)) return instruction;
      const deep = deepened(instruction);
      assert.equal(sayStagesSelectively(deep), deep === instruction);
      return deep;
    }),
  };
}

function deepened(say: SayInstruction): SayInstruction {
  if (say.textTemporary === undefined) return { ...say, value: otherwiseSort(say.value) };
  if (say.presentation !== null) return { ...say, presentation: otherwiseSort(say.presentation) };
  if (typeof say.pacing === "object") return { ...say, pacing: otherwiseSort(say.pacing) };
  return say;
}

function otherwiseSort(expression: ExpressionPlan): ExpressionPlan {
  const span = expression.span;
  return {
    kind: "binary",
    operator: "otherwise",
    left: expression,
    right: {
      kind: "call",
      callee: {
        kind: "property",
        object: { kind: "list", elements: [], span },
        name: "sort",
        span,
      },
      arguments: [],
      span,
    },
    span,
  };
}
