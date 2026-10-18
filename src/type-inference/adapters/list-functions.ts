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
  isKnown,
  isNumeric,
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
  OperandRef,
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
  pathOf,
  typeResult,
  UNCONSTRAINED,
  viewMembers,
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

/**
 * The members of a view for use (the legacy's `forUse`): without null, which the check reports (rule 1.9) and leaves
 * out, unless null is all there is, which the check then sees.
 */
function useOf(view: OperandView): readonly StaticType[] {
  const all = viewMembers(view);
  const kept = all.filter((member) => member.kind !== "null");
  return kept.length === 0 ? all : kept;
}

/** A type of no known kind: what the legacy cannot know, a slot not decided yet, or one nothing was stored into. */
function unknownPart(type: StaticType): boolean {
  return !isKnown(type);
}

/**
 * The legacy's `shape`: a named argument the contract does not take, or a positional count it does not take, is
 * reported and the call has no value.
 */
function misshapen(contract: ListFunction, inputs: OperationInputs): boolean {
  return (
    [...inputs.named.keys()].some((name) => !contract.named.includes(name)) ||
    inputs.arguments.length !== contract.parameters.length
  );
}

/**
 * The values a statistic or a regression reads, as `valuesType` of the legacy check gives them: the list's elements,
 * or the property a selector names in each. The selector's name is checked whatever the list is, then the list, then
 * the elements; a value the legacy cannot know is `dynamic` of its provenance, and one it reports is `invalid`.
 */
function valuesOf(
  list: OperandView,
  ref: OperandRef,
  inputs: OperationInputs,
  selector: string,
): { readonly type: StaticType } | { readonly result: OperationResult } {
  const named = inputs.named.get(selector);
  let key: string | null | undefined;
  if (named !== undefined) {
    if (isBottom(named)) return { result: UNCONSTRAINED };
    // A selector that is no text is reported; one the legacy cannot see, or cannot know, names no property.
    if (named.dynamic === null && !useOf(named).every((member) => isScalar(member, "string")))
      return { result: INVALID };
    key = named.dynamic === null ? writtenSelector(inputs.evidence, selector) : undefined;
  }
  // The selector's name is checked whatever the list is; the list is read after it.
  if (isBottom(list)) return { result: UNCONSTRAINED };
  const lists = useOf(list);
  if (list.dynamic === null && lists.some((member) => member.kind !== "list"))
    return { result: INVALID };
  const element =
    list.dynamic === null
      ? union(lists.map((member) => (member.kind === "list" ? member.element : UNKNOWN_TYPE)))
      : UNKNOWN_TYPE;
  if (named === undefined)
    return list.dynamic === null
      ? { type: element }
      : { result: dynamicFrom(list, "unknown member") };
  const parts = members(element).map(resolved);
  // Every element the legacy knows must be an object, also when the property's type stays unknown.
  if (parts.some((member) => !unknownPart(member) && member.kind !== "object"))
    return { result: INVALID };
  if (key === undefined) return { result: dynamicFrom(named, "unknown member") };
  if (key === null) return { result: dynamicResult("unknown member") };
  if (list.dynamic !== null) return { result: dynamicFrom(list, "unknown member") };
  for (const member of parts) {
    if (member.kind !== "object") return { result: dynamicResult("unknown member") };
    // ones whose properties the legacy does not know may still gain the property
    if (member.properties === null) return { result: dynamicResult("unknown member") };
  }
  if (parts.length === 0) return { result: dynamicResult("unknown member") };
  // The property is read as a leaf of the elements, one alternative per ask; the objects have it, or the legacy
  // reports at the end that they never can.
  const leaf = inputs.leaf(pathOf(ref, "element", { property: key }));
  if (leaf === null) return { result: INVALID };
  if (isBottom(leaf)) return { result: UNCONSTRAINED };
  if (leaf.dynamic !== null) return { result: dynamicFrom(leaf, "unknown member") };
  return { type: closedType(leaf)! };
}

/** The one kind of the values, as `valueKind` of the legacy check decides it, or why there is none. */
function kindOfValues(
  type: StaticType,
  allowed: readonly ListValueKind[],
): { readonly kind: ReadKind } | { readonly result: OperationResult } {
  const parts = members(type).map(resolved);
  if (parts.length === 0 || parts.some(unknownPart))
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
  if (misshapen(contract, inputs)) return INVALID;
  const list = inputs.arguments[0]!;
  // Its other numbers, such as a percentage, are the visitor's check: one that is no number is reported and the
  // statistic still has its kind.
  const values = valuesOf(list, { argument: 0 }, inputs, "by");
  if ("result" in values) return values.result;
  // A list known to be too short is reported (`checkFewest`), and the statistic still has its kind.
  const kind = kindOfValues(values.type, contract.values);
  if ("result" in kind) return kind.result;
  if (kind.kind === "integer" && contract.integers === "number") return typeResult(NUMBER_TYPE);
  return typeResult(typeOfKind(kind.kind));
}

/**
 * The amount kind of regression values, or `undefined` where the legacy carries on with unknown fields: a value it
 * reports, or one it cannot know. A bottom input waits.
 */
function amountOf(
  list: OperandView,
  inputs: OperationInputs,
  selector: string,
  allowed: readonly ListValueKind[],
): { readonly kind: ReadKind | undefined } | { readonly result: OperationResult } {
  const values = valuesOf(list, { argument: 0 }, inputs, selector);
  if ("result" in values)
    return values.result.kind === "unconstrained" ? { result: values.result } : { kind: undefined };
  const kind = kindOfValues(values.type, allowed);
  return "result" in kind ? { kind: undefined } : { kind: kind.kind };
}

/** `linearRegression`: the object of the line; a value or selection the check rejects, or cannot know, leaves its fields unknown. */
function regression(
  contract: ListFunction & { readonly takes: "points" },
  inputs: OperationInputs,
): OperationResult {
  if (misshapen(contract, inputs)) return INVALID;
  const list = inputs.arguments[0]!;
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

/** `predict`, in the order `predictType` of the legacy check decides: the x, then the line, then the intercept's kind. */
function prediction(
  contract: ListFunction & { readonly takes: "line" },
  inputs: OperationInputs,
): OperationResult {
  if (misshapen(contract, inputs)) return INVALID;
  const line = inputs.arguments[0]!;
  const x = inputs.arguments[1]!;
  // Whatever the line, each kind the x may be is a number or a date and time value; null alone is no x. The x is
  // read first, as the legacy reads it, and the line only after it passes.
  if (isBottom(x)) return UNCONSTRAINED;
  const xs = useOf(x);
  if (x.dynamic === null && xs.length === 0) return INVALID;
  if (
    x.dynamic === null &&
    xs.some(
      (member) =>
        !unknownPart(member) &&
        !contract.positions.some(
          (kind) => isScalar(member, kind) || (kind === "number" && isScalar(member, "integer")),
        ),
    )
  )
    return INVALID;
  if (isBottom(line)) return UNCONSTRAINED;
  if (line.dynamic !== null) return dynamicFrom(line, "unknown member");
  const object = resolved(union(useOf(line)));
  if (unknownPart(object)) return dynamicResult("unknown member");
  // the line's parts are read as leaves of it, one alternative per ask; a part it does not have is absent
  const leaves = ["slope", "intercept", "start"].map((key) =>
    object.kind === "object" ? inputs.leaf(pathOf({ argument: 0 }, { property: key })) : null,
  );
  if (leaves.some((leaf) => leaf !== null && isBottom(leaf))) return UNCONSTRAINED;
  const dynamicLeaf = leaves.find((leaf) => leaf !== null && leaf.dynamic !== null);
  if (dynamicLeaf !== undefined && dynamicLeaf !== null)
    return dynamicFrom(dynamicLeaf, "unknown member");
  const property = (index: number): StaticType | undefined => {
    const leaf = leaves[index]!;
    return leaf === null ? undefined : closedType(leaf)!;
  };
  const intercept = property(1);
  const start = property(2);
  const fields = [property(0), intercept, start];
  // A line whose slope, intercept or start may be null is reported.
  if (
    fields.some((field) => field !== undefined && members(field).some((one) => one.kind === "null"))
  )
    return INVALID;
  if (
    object.kind !== "object" ||
    (object.properties !== null &&
      (intercept === undefined || property(0) === undefined || start === undefined))
  )
    return INVALID;
  // An x that does not fit the line's start is reported, and the prediction still has the intercept's kind.
  const amount = intercept === undefined ? undefined : resolved(intercept);
  if (amount !== undefined && isScalar(amount, "duration")) return typeResult(DURATION_TYPE);
  if (amount !== undefined && isNumeric(amount)) return typeResult(NUMBER_TYPE);
  // An intercept the legacy cannot know, or of a kind that predicts nothing: unknown without a report.
  return dynamicResult("unknown member");
}

function relation(name: ListFunctionName, contract: ListFunction): OperationRelation {
  return {
    contract: { family: "listFunction", name },
    result(inputs: OperationInputs): OperationResult {
      switch (contract.takes) {
        case "values": {
          // `min` and `max` of two or more values, or of one value that is no list, take their arguments' values;
          // one value that may be a list, or that the compiler cannot know, is read as the list form (the legacy's
          // dispatch counts a member it does not know as a list).
          const single = inputs.arguments.length === 1 ? inputs.arguments[0]! : undefined;
          // A single value still bottom gives no evidence for either form of `min`/`max`: the relation waits.
          if (takesValues(name) && single !== undefined && isBottom(single)) return UNCONSTRAINED;
          const list =
            single !== undefined &&
            (single.dynamic !== null ||
              viewMembers(single).some(
                (member) => !isKnown(member) || resolved(member).kind === "list",
              ));
          // The legacy folds every argument of the value form, the named ones too (reported as unknown names).
          if (takesValues(name) && !list)
            return minMaxOfValues([...inputs.arguments, ...inputs.named.values()]);
          return statistic(contract, inputs);
        }
        case "points":
          return regression(contract, inputs);
        case "line":
          return prediction(contract, inputs);
      }
    },
  };
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map(
  Object.keys(LIST_FUNCTION_CONTRACTS)
    .filter(isListFunction)
    .map((name) => [name, relation(name, LIST_FUNCTION_CONTRACTS[name])]),
);
