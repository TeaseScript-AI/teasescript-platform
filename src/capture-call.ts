import type { Expression, Program } from "./ast.js";

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

/**
 * Whether an expression is the accepted `askImage(...)` call (V30 §20). Like `takePhoto()` it looks like an ordinary
 * call, but it waits for the player's image and therefore lowers to an interaction.
 */
export function isAskImageCall(expression: Expression): boolean {
  return (
    expression.kind === "callExpression" &&
    expression.callee.kind === "identifier" &&
    expression.callee.name === "askImage"
  );
}

/**
 * Whether an expression is the accepted `askBooleans(...)` call (V30 §20): a form of one toggle per text, which lowers
 * to a form interaction.
 */
export function isAskBooleansCall(expression: Expression): boolean {
  return (
    expression.kind === "callExpression" &&
    expression.callee.kind === "identifier" &&
    expression.callee.name === "askBooleans"
  );
}

/** Whether any of the programs takes a photo with `tags:`, which joins the image catalog at runtime (ADR 0023). */
export function capturesTaggedPhotos(programs: readonly Program[]): boolean {
  const work: unknown[] = [...programs];
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) work.push(item);
      continue;
    }
    // Spans and positions, the only AST objects without a kind, hold no calls.
    if (!("kind" in value)) continue;
    if (value.kind === "callExpression" && "callee" in value && "arguments" in value) {
      const callee = value.callee;
      if (
        typeof callee === "object" &&
        callee !== null &&
        "kind" in callee &&
        callee.kind === "identifier" &&
        "name" in callee &&
        callee.name === "takePhoto" &&
        Array.isArray(value.arguments) &&
        value.arguments.length > 0
      )
        return true;
    }
    for (const nested of Object.values(value)) work.push(nested);
  }
  return false;
}
