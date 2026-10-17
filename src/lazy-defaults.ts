import type { CallExpression, NamedArgument } from "./ast.js";
import { CONVERSION_RESULTS, type ConversionName } from "./conversions.js";

/**
 * The calls whose `default:` runs only when it is used (owner decision, 2026-10-16): a conversion uses it for a value it
 * cannot convert (V30 §13), `toRegex` for text that is no valid pattern (§8), `fromJson` and `fromBase64` for text that
 * does not read (§13), `fileFromBase64` for text that is no file (§33), `decryptText` and `decryptFile` for a lock they
 * do not open (§13), and the `get` method of a list or dict for a position or key it does not have (§16, §40). `load`
 * and `otherwise` keep their own forms of the rule (§25, §18).
 */
export type LazyDefaultOperation =
  | ConversionName
  | "toRegex"
  | "fromJson"
  | "fromBase64"
  | "fileFromBase64"
  | "decryptText"
  | "decryptFile"
  | "get";

const LAZY_DEFAULT_FUNCTIONS: ReadonlySet<string> = new Set([
  ...CONVERSION_RESULTS.keys(),
  "toRegex",
  "fromJson",
  "fromBase64",
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
