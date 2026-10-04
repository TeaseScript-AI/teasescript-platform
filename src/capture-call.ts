import type { Expression } from "./ast.js";

/**
 * Whether an expression is the accepted `takePhoto()` call. It looks like an ordinary call, but it waits for the
 * Player and therefore lowers to a capture instruction rather than a synchronous builtin call.
 */
export function isTakePhotoCall(expression: Expression): boolean {
  return (
    expression.kind === "callExpression" &&
    expression.callee.kind === "identifier" &&
    expression.callee.name === "takePhoto"
  );
}
