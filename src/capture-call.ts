import type { Expression, InteractionExpression, Program } from "./ast.js";
import { conversionWaitsForFiles, isConversion } from "./conversions.js";

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
 * Whether an expression is a call that may use the Player's file store (V30 §13 and §33): `fileFromBase64(...)`,
 * `fileToBase64(...)`, `hashFile(...)`, or a conversion that takes `files:` without a literal `files: false`. Like
 * `takePhoto()` it may wait for the Player, so it lowers to a file store instruction.
 */
export function isFileStoreCall(expression: Expression): boolean {
  if (expression.kind !== "callExpression" || expression.callee.kind !== "identifier") return false;
  const name = expression.callee.name;
  if (name === "fileFromBase64" || name === "fileToBase64" || name === "hashFile") return true;
  if (!isConversion(name)) return false;
  // Only a plain `false`, which plan validation recognizes as a literal; any other `files:` is read when it runs.
  return conversionWaitsForFiles(
    name,
    expression.arguments.some(
      (argument) =>
        argument.kind === "namedArgument" &&
        argument.name.name === "files" &&
        argument.value.kind === "booleanLiteral" &&
        !argument.value.value,
    ),
  );
}

/** The calls that lock and open text and stored files (V30 §13), which `lock` instructions run. */
export const LOCK_CALLS: ReadonlySet<string> = new Set([
  "encryptText",
  "encryptFile",
  "decryptText",
  "decryptFile",
]);

/**
 * Whether an expression is `encryptText(...)`, `encryptFile(...)`, `decryptText(...)`, or `decryptFile(...)` (V30 §13).
 * Like `takePhoto()` it waits for the Player, which may ask the player first, so it lowers to a lock instruction.
 */
export function isLockCall(expression: Expression): boolean {
  return (
    expression.kind === "callExpression" &&
    expression.callee.kind === "identifier" &&
    LOCK_CALLS.has(expression.callee.name)
  );
}

/**
 * The `askPassword(...)` written directly as the `password:` of a lock call, also in parentheses, or `null` (V30 §13). It
 * asks in the Player's own password field, so the typed text is the password and never becomes a script value.
 */
export function directPasswordField(expression: Expression): InteractionExpression | null {
  let node = expression;
  while (node.kind === "parenthesizedExpression") node = node.expression;
  return node.kind === "interactionExpression" && node.interactionKind === "password" ? node : null;
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
