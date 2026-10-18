import { LOCK_CALLS } from "../../capture-call.js";
import { CONVERSIONS, FILE_TEXT_FUNCTIONS, type Conversion } from "../../conversions.js";
import { CONVERSION_FUNCTIONS } from "../../language-facts.js";
import {
  isAssignable,
  isKnown,
  optional,
  SCRIPT_TYPE,
  STRING_TYPE,
  type StaticType,
} from "../../static-types.js";
import type { OperationInputs, OperationRelation, OperationResult } from "./relation.js";
import {
  alternativesOf,
  closedType,
  dynamicResult,
  isBottom,
  named,
  projectionOf,
  typeResult,
} from "./views.js";

/**
 * The conversions and the file, hash and lock calls, `escapeMarkup` and `script` (O4 stage 2b), as `#conversionType`
 * and `#builtinType` of the legacy checker give them: a value of the call's result kind, or with a `default:` the
 * call may give, the result or a copy of the default. What JSON holds is known only when the script runs. The
 * argument's kind is the visitor's check: the result stands whatever it reports. A conversion is keyed by
 * `conversion.<name>`; a builtin by its name, which `index.ts` tells from an injected host builtin's.
 */

/** A result or a copy of the call's `default:`. */
const RESULT_OR_DEFAULT = (result: StaticType): OperationResult =>
  alternativesOf(typeResult(result), projectionOf(named("default")));

/** A conversion's result, by its `default:` policy (`CallDefault.type`). */
function conversionResult(conversion: Conversion, inputs: OperationInputs): OperationResult {
  // What JSON holds is known only when the script runs; a written `default:` is a known value the call may give
  // instead, so its copy joins the result (a known null makes it optional: the owner's Q3.2c, O4 stage 3a).
  if (conversion.result === "unknown")
    return inputs.named.has("default")
      ? alternativesOf(dynamicResult("json"), projectionOf(named("default")))
      : dynamicResult("json");
  const result: StaticType = { kind: "scalar", name: conversion.result };
  const fallback = inputs.named.get("default");
  switch (conversion.fallback?.type) {
    case "any":
      return fallback === undefined ? typeResult(result) : RESULT_OR_DEFAULT(result);
    case "optional": {
      // A default the compiler knows fits the result or null is given as it is; any other, or none, makes it optional.
      if (fallback === undefined) return typeResult(optional(result));
      // A default with no evidence yet (a lazy operand: it runs only when the conversion fails) does not hold the
      // result back: the result stands alone, the lower bound of every answer a typed default gives (the default's
      // copy when it fits, null when it does not), so the answer only grows as the default's type arrives (O4 stage 3a).
      if (isBottom(fallback)) return typeResult(result);
      const type = fallback.dynamic === null ? closedType(fallback) : null;
      return type !== null && isKnown(type) && isAssignable(optional(result), type)
        ? RESULT_OR_DEFAULT(result)
        : typeResult(optional(result));
    }
    default:
      return typeResult(result);
  }
}

/** Text, or with a `default:` the call may give (a stored file from Base64 text, a lock call), text or a copy of it. */
function textResult(defaulted: boolean): (inputs: OperationInputs) => OperationResult {
  return (inputs) =>
    defaulted && inputs.named.has("default")
      ? RESULT_OR_DEFAULT(STRING_TYPE)
      : typeResult(STRING_TYPE);
}

const BUILTINS: readonly (readonly [string, (inputs: OperationInputs) => OperationResult])[] = [
  ...[...FILE_TEXT_FUNCTIONS].map(
    ([name, shape]) => [name, textResult(shape.fallback !== null)] as const,
  ),
  // A lock call's written default is given beside the text, also by an encrypt call, which reports it.
  ...[...LOCK_CALLS].map((name) => [name, textResult(true)] as const),
  ["escapeMarkup", textResult(false)],
  ["script", () => typeResult(SCRIPT_TYPE)],
];

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map<string, OperationRelation>(
  [
    ...CONVERSION_FUNCTIONS.map((name): [string, OperationRelation] => [
      `conversion.${name}`,
      {
        contract: { family: "conversion", name },
        result: (inputs) => conversionResult(CONVERSIONS[name], inputs),
      },
    ]),
    ...BUILTINS.map(([name, result]): [string, OperationRelation] => [
      name,
      { contract: { family: "builtin", name }, result },
    ]),
  ],
);
