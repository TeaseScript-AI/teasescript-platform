import type { CallExpression, NamedArgument } from "./ast.js";
import { takesDefault, type DefaultedConversion } from "./conversions.js";
import { CONVERSION_FUNCTIONS } from "./language-facts.js";

/**
 * The calls whose `default:` runs only when it is used (owner decision, 2026-10-16): a conversion that takes one
 * (`CONVERSIONS`) uses it for a value it cannot convert or text it cannot read (V30 §8, §13), `fileFromBase64` for text
 * that is no file (§33), `decryptText` and `decryptFile` for a lock they do not open (§13), and the `get` method of a
 * list or dict for a position or key it does not have (§16, §40). `load` and `otherwise` keep their own forms of the
 * rule (§25, §18).
 */
export type LazyDefaultOperation =
  DefaultedConversion | "fileFromBase64" | "decryptText" | "decryptFile" | "get";

const LAZY_DEFAULT_FUNCTIONS: ReadonlySet<string> = new Set([
  ...CONVERSION_FUNCTIONS.filter(takesDefault),
  "fileFromBase64",
  "decryptText",
  "decryptFile",
]);

export function isLazyDefaultOperation(value: unknown): value is LazyDefaultOperation {
  return value === "get" || (typeof value === "string" && LAZY_DEFAULT_FUNCTIONS.has(value));
}

/** The operation of a call with a function or method name, when its `default:` runs only when it is used. */
export function lazyDefaultOperation(name: string, method: boolean): LazyDefaultOperation | null {
  if (method) return name === "get" ? "get" : null;
  return name !== "get" && isLazyDefaultOperation(name) ? name : null;
}

/** The `default:` of a call when it runs only when the call needs it, or `null` when every argument runs before it. */
export function lazyDefaultArgument(
  call: CallExpression,
): { readonly operation: LazyDefaultOperation; readonly argument: NamedArgument } | null {
  let callee = call.callee;
  // Grouping does not change what is called: `(items.get)(0, default: x)` calls `items.get`.
  while (callee.kind === "parenthesizedExpression") callee = callee.expression;
  const operation =
    callee.kind === "identifier"
      ? lazyDefaultOperation(callee.name, false)
      : callee.kind === "propertyAccessExpression"
        ? lazyDefaultOperation(callee.property.name, true)
        : null;
  if (operation === null) return null;
  for (const argument of call.arguments)
    if (argument.kind === "namedArgument" && argument.name.name === "default")
      return { operation, argument };
  return null;
}
