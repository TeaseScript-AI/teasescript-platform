import {
  isListFunction,
  LIST_FUNCTION_CONTRACTS,
  listValueKind,
  takesValues,
  type ListFunction,
  type ListValueKind,
} from "../../list-function-rules.js";
import {
  DURATION_TYPE,
  INTEGER_TYPE,
  isScalar,
  members,
  NUMBER_TYPE,
  PropertyTable,
  resolved,
  union,
  UNKNOWN_TYPE,
  valueKindOfType,
  type StaticType,
} from "../../static-types.js";
import { minMaxOfValues } from "./numeric.js";
import type {
  OperandView,
  OperationInputs,
  OperationRelation,
  OperationResult,
} from "./relation.js";
import {
  closedType,
  dynamicFrom,
  dynamicResult,
  INVALID,
  isBottom,
  typeResult,
  UNCONSTRAINED,
  writtenSelector,
} from "./views.js";

/**
 * The list functions (O4 stage 2b), as `listFunctionType` of `list-function-checks.ts` gives them: a statistic's
 * kind is the kind of the list's values, or of the property a written `by:` selects, promoted from integers where
 * the contract says; a regression is an object of its line; a prediction is a number or a duration like the line's
 * intercept. A selector is read from the `selectors` evidence, as the legacy reads it from the source, never from
 * the general fold. What the legacy reports and recovers from with `unknown` is `invalid` here; a value it cannot
 * know is `dynamic`.
 */
type ReadKind = ListValueKind | "integer";
type ListFunctionName = keyof typeof LIST_FUNCTION_CONTRACTS;

/** The values a statistic reads: the list's elements, or the selected property of each, as a closed type or not. */
function valuesOf(
  list: OperandView,
  inputs: OperationInputs,
  selector: string,
): { readonly type: StaticType } | { readonly result: OperationResult } {
  if (isBottom(list)) return { result: UNCONSTRAINED };
  const closed = closedType(list);
  if (closed === null) return { result: dynamicFrom(list, "unknown member") };
  const parts = members(closed).map(resolved);
  if (parts.some((part) => part.kind !== "list")) return { result: INVALID };
  const element = union(parts.map((part) => (part.kind === "list" ? part.element : UNKNOWN_TYPE)));
  if (!inputs.named.has(selector)) return { type: element };
  const key = writtenSelector(inputs.evidence, selector);
  const elements = members(element).map(resolved);
  // Every element must be an object; the property's type is what the objects give it, or not known.
  if (elements.some((member) => member.kind !== "object")) return { result: INVALID };
  // A selector the legacy cannot see, or a property the objects do not show: values of no known kind.
  if (key === null) return { type: UNKNOWN_TYPE };
  const found: StaticType[] = [];
  for (const member of elements) {
    const value = member.kind === "object" ? member.properties?.get(key) : undefined;
    if (value === undefined) return { type: UNKNOWN_TYPE };
    found.push(value);
  }
  return { type: found.length === 0 ? UNKNOWN_TYPE : union(found) };
}

/** The one kind of the values, as `valueKind` of the legacy check decides it, or why there is none. */
function kindOfValues(
  type: StaticType,
  allowed: readonly ListValueKind[],
): { readonly kind: ReadKind } | { readonly result: OperationResult } {
  const parts = members(type).map(resolved);
  if (parts.some((part) => part.kind === "unknown" || part.kind === "open"))
    return { result: dynamicResult("unknown member") };
  const kinds = new Set<ReadKind>();
  for (const part of parts) {
    const valueKind = valueKindOfType(part);
    const listKind = valueKind === undefined ? undefined : listValueKind(valueKind);
    if (listKind === undefined || !allowed.includes(listKind)) return { result: INVALID };
    kinds.add(valueKind === "integer" ? "integer" : listKind);
  }
  if (kinds.size === 1) return { kind: [...kinds][0]! };
  if (kinds.size === 2 && kinds.has("integer") && kinds.has("number")) return { kind: "number" };
  return { result: INVALID };
}

function typeOfKind(kind: ReadKind): StaticType {
  if (kind === "integer") return INTEGER_TYPE;
  if (kind === "number") return NUMBER_TYPE;
  return { kind: "scalar", name: kind };
}

function statistic(
  contract: ListFunction & { readonly takes: "values" },
  inputs: OperationInputs,
): OperationResult {
  const list = inputs.arguments[0];
  if (list === undefined) return INVALID;
  const values = valuesOf(list, inputs, "by");
  if ("result" in values) return values.result;
  const kind = kindOfValues(values.type, contract.values);
  if ("result" in kind) return kind.result;
  if (kind.kind === "integer" && contract.integers === "number") return typeResult(NUMBER_TYPE);
  return typeResult(typeOfKind(kind.kind));
}

/** The amount kind of regression values, or `undefined` when the legacy reports and carries on with unknown fields. */
function amountOf(
  list: OperandView,
  inputs: OperationInputs,
  selector: string,
  allowed: readonly ListValueKind[],
): { readonly kind: ReadKind | undefined } | { readonly result: OperationResult } {
  const values = valuesOf(list, inputs, selector);
  // A list that is no list, or elements that are no objects: the legacy reports and keeps unknown fields.
  if ("result" in values)
    return values.result.kind === "invalid" ? { kind: undefined } : { result: values.result };
  const kind = kindOfValues(values.type, allowed);
  return "result" in kind ? { kind: undefined } : { kind: kind.kind };
}

/** `linearRegression`: the object of the line; a value or selection the check rejects leaves its fields unknown. */
function regression(
  contract: ListFunction & { readonly takes: "points" },
  inputs: OperationInputs,
): OperationResult {
  const list = inputs.arguments[0];
  if (list === undefined) return INVALID;
  // `x:` without `y:` is a malformed call (the legacy reports and gives unknown).
  if (inputs.named.has("x") && !inputs.named.has("y")) return INVALID;
  const ys = amountOf(list, inputs, "y", contract.values);
  if ("result" in ys) return ys.result;
  const amount =
    ys.kind === undefined ? UNKNOWN_TYPE : ys.kind === "duration" ? DURATION_TYPE : NUMBER_TYPE;
  let start: StaticType = INTEGER_TYPE;
  if (inputs.named.has("x")) {
    const xs = amountOf(list, inputs, "x", contract.positions);
    if ("result" in xs) return xs.result;
    start = xs.kind === undefined ? UNKNOWN_TYPE : typeOfKind(xs.kind);
  }
  return typeResult({
    kind: "object",
    properties: new PropertyTable([
      ["slope", amount],
      ["intercept", amount],
      ["r2", NUMBER_TYPE],
      ["start", start],
    ]),
  });
}

function prediction(inputs: OperationInputs): OperationResult {
  const line = inputs.arguments[0];
  if (line === undefined || inputs.arguments[1] === undefined) return INVALID;
  if (isBottom(line)) return UNCONSTRAINED;
  const closed = closedType(line);
  if (closed === null) return dynamicFrom(line, "unknown member");
  const object = resolved(closed);
  if (object.kind !== "object") return INVALID;
  if (object.properties === null) return dynamicResult("unwritten parts");
  const intercept = object.properties.get("intercept");
  if (intercept === undefined || !object.properties.has("slope") || !object.properties.has("start"))
    return INVALID;
  const amount = resolved(intercept);
  if (isScalar(amount, "duration")) return typeResult(DURATION_TYPE);
  if (isScalar(amount, "integer", "number")) return typeResult(NUMBER_TYPE);
  // An intercept of no known kind, as a regression over an unseen selector gives: no known result. An intercept of
  // another kind is a line that predicts nothing: the legacy gives unknown without a report, the candidate no value.
  return amount.kind === "unknown" || amount.kind === "open"
    ? dynamicResult("unknown member")
    : INVALID;
}

function relation(name: ListFunctionName, contract: ListFunction): OperationRelation {
  return {
    contract: { family: "listFunction", name },
    result(inputs: OperationInputs): OperationResult {
      switch (contract.takes) {
        case "values": {
          // `min` and `max` of two or more values, or of one value that is no list, take their arguments' values.
          const single = inputs.arguments.length === 1 ? inputs.arguments[0]! : undefined;
          const list =
            single !== undefined &&
            (single.alternatives === null ||
              members(closedType(single)!).some((member) => resolved(member).kind === "list"));
          if (takesValues(name) && !list) return minMaxOfValues(inputs.arguments);
          return statistic(contract, inputs);
        }
        case "points":
          return regression(contract, inputs);
        case "line":
          return prediction(inputs);
      }
    },
  };
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map(
  Object.keys(LIST_FUNCTION_CONTRACTS)
    .filter(isListFunction)
    .map((name) => [name, relation(name, LIST_FUNCTION_CONTRACTS[name])]),
);
