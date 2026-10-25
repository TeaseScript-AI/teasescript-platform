import { dictMethod, dictProperty, type DictMethod } from "../../dict-operations.js";
import { kindsWithMethod } from "../../handle-members.js";
import { listMethod, listProperty, type ListMethod } from "../../list-methods.js";
import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  isKnown,
  isScalar,
  NULL_TYPE,
  optional,
  resolved,
  STRING_TYPE,
  union,
  UNKNOWN_TYPE,
  type StaticType,
} from "../../static-types.js";
import { joinTypes } from "../../static-types/join.js";
import type { ValueKind } from "../../value-kinds.js";
import type { OperandView, OperationInputs, OperationResult } from "./relation.js";
import {
  alternativesOf,
  dynamicResult,
  INVALID,
  isBottom,
  joinOf,
  named,
  pathOf,
  projectionOf,
  RECEIVER,
  restrictedTo,
  typeResult,
  UNCONSTRAINED,
  viewMembers,
  type MemberAnswer,
  type MemberRules,
} from "./views.js";

/**
 * The members of lists, sets, dicts, objects and ranges (O4 stage 2b), as `memberPropertyType` and
 * `memberMethodType` of the legacy checker give them, written as relations: a list's element properties are held
 * parts of the list, a set's are copies, a dict's `values` is a new list of copies, and a method that gives an
 * element gives a copy (`#collectionMethodType`, `#setOperationType`). `get` keeps its default off the receiver (Q2):
 * the result is the element or the default.
 */
const LIST_RESULT: Record<string, OperationResult> = {
  null: typeResult(NULL_TYPE),
  boolean: typeResult(BOOLEAN_TYPE),
  integer: typeResult(INTEGER_TYPE),
  "integer?": typeResult(optional(INTEGER_TYPE)),
  string: typeResult(STRING_TYPE),
};

function property(kind: ValueKind, name: string, receiver: OperandView): MemberAnswer | undefined {
  switch (kind) {
    case "list":
    case "set": {
      const contract = listProperty(name);
      if (contract === undefined) return undefined;
      if (contract.gives === "length") return typeResult(INTEGER_TYPE);
      // A list's element is read from the list; a set member as a copy (ADR 0014).
      return kind === "list"
        ? { kind: "held", step: "element" }
        : projectionOf(RECEIVER, "element");
    }
    case "dict":
      switch (dictProperty(name)?.gives) {
        case "length":
          return typeResult(INTEGER_TYPE);
        case "keys":
          return typeResult({ kind: "list", element: STRING_TYPE });
        case "values":
          return joinOf("list", pathOf(RECEIVER, "entry"));
        default:
          return undefined;
      }
    case "object": {
      // The written properties are held parts; an object whose properties are not known may hold any.
      let held = false;
      let open = false;
      for (const member of viewMembers(receiver)) {
        const object = resolved(member);
        if (object.kind !== "object") continue;
        if (object.properties === null) open = true;
        else if (object.properties.has(name)) held = true;
      }
      if (held) return { kind: "held", step: { property: name } };
      return open ? dynamicResult("unwritten parts") : undefined;
    }
    default:
      return undefined;
  }
}

/** Whether the receiver may be a handle whose `remove()` takes no argument (the legacy's `removable`). */
function removable(receiver: OperandView): boolean {
  const handles: readonly string[] = kindsWithMethod("remove");
  return viewMembers(receiver).some((member) => handles.includes(resolved(member).kind));
}

/**
 * The legacy's shape problems of a list or set method (`shapeProblems`, `methodShapeProblems`): any named argument,
 * or a count outside the parameters, except `remove()` without an argument on a receiver that may be a handle. For
 * `get`, `getProblems`: one index and a `default:`, no other name.
 */
function listShapeFails(
  contract: ListMethod,
  inputs: OperationInputs,
  mayRemove: boolean,
): boolean {
  if (contract.named !== undefined) {
    if ([...inputs.named.keys()].some((name) => name !== "default")) return true;
    return !(inputs.arguments.length === 1 && inputs.named.size === 1);
  }
  if (inputs.named.size > 0) return true;
  const required = contract.parameters.filter((parameter) => parameter.optional !== true).length;
  const count = inputs.arguments.length;
  if (count >= required && count <= contract.parameters.length) return false;
  return !(mayRemove && contract.name === "remove" && count === 0);
}

/**
 * The legacy's argument-kind problems (`argumentKindProblems`), read once the shape fits: a count that may be null,
 * or that is no whole number; a list or collection argument with a known member that is no list (nor set, for a
 * collection). An argument the rule reads that is still bottom is waited for.
 */
function argumentKindFails(contract: ListMethod, inputs: OperationInputs): boolean | "bottom" {
  for (const [index, parameter] of contract.parameters.entries()) {
    const argument = inputs.arguments[index];
    if (argument === undefined) break;
    if (parameter.kind !== "count" && parameter.kind !== "list" && parameter.kind !== "collection")
      continue;
    if (isBottom(argument)) return "bottom";
    if (argument.dynamic !== null) continue;
    const all = viewMembers(argument);
    if (parameter.kind === "count") {
      const passing = all.filter((member) => member.kind !== "null");
      const whole = (member: StaticType) => isScalar(member, "integer");
      if (passing.length > 0 && passing.length < all.length && passing.every(whole)) return true;
      if (all.some((member) => !whole(member))) return true;
      continue;
    }
    const used = all.filter((member) => member.kind !== "null");
    const members = (used.length === 0 ? all : used).map(resolved);
    if (
      !members.every(
        (member) =>
          !isKnown(member) ||
          member.kind === "list" ||
          (parameter.kind === "collection" && member.kind === "set"),
      )
    )
      return true;
  }
  return false;
}

/** The members of a view for use (`forUse`): without null, unless null is all there is. */
function useOf(view: OperandView): readonly StaticType[] {
  const all = viewMembers(view);
  const used = all.filter((member) => member.kind !== "null");
  return (used.length === 0 ? all : used).map(resolved);
}

/**
 * The legacy's shape gate of a dict method (`#checkDictArguments`, `dictArgumentsProblem`), which takes the value
 * away only from a receiver that is a dict alone (`isDictReceiver`); beside other kinds the shape problem is reported
 * (`dictMethodProblems`) and the dict's value kept.
 */
function dictShapeFails(contract: DictMethod, inputs: OperationInputs): boolean {
  if (contract.named !== undefined) {
    if ([...inputs.named.keys()].some((name) => name !== "default")) return true;
    return !(inputs.arguments.length === 1 && inputs.named.size === 1);
  }
  return inputs.named.size > 0 || inputs.arguments.length !== contract.parameters.length;
}

/** A dict's methods: `dictMethod` names what each gives; `get` needs its default (V30 §40) and gives a copy of either. */
function dictMethodResult(name: string, inputs: OperationInputs): OperationResult | undefined {
  const contract = dictMethod(name);
  if (contract === undefined) return undefined;
  const known = viewMembers(inputs.receiver!).filter(
    (member) => member.kind !== "null" && isKnown(member),
  );
  const dictAlone = known.length > 0 && known.every((member) => resolved(member).kind === "dict");
  if (dictAlone && dictShapeFails(contract, inputs)) return INVALID;
  switch (contract.result) {
    case "null":
      return typeResult(NULL_TYPE);
    case "boolean":
      return typeResult(BOOLEAN_TYPE);
    case "value":
      if (contract.missing !== "default") return projectionOf(RECEIVER, "entry");
      return inputs.named.has("default")
        ? alternativesOf(projectionOf(RECEIVER, "entry"), projectionOf(named("default")))
        : INVALID;
  }
}

/**
 * `intersection`, `union` and `difference`, as `#collectionMethodType` and `#setOperationType` decide them, per
 * member of the receiver's kind, the results unioned: the problems first (the shape, then the arguments' kinds); an
 * argument that may be null, when there is no problem, needs a check first and leaves the elements unknown; then a
 * new collection of the member's kind: for `union` with a first written argument (positional or named), the elements
 * of both join as in a list literal, and a member of the argument that is no collection (null alone included), an
 * element the compiler cannot know, or a mix leaves the elements unknown (reported where it mixes); an empty
 * collection's element, which nothing was stored into, adds nothing; the other operations keep the member's element.
 */
function setOperation(
  kind: "list" | "set",
  contract: ListMethod,
  inputs: OperationInputs,
): OperationResult {
  const unknownElements: StaticType = { kind, element: UNKNOWN_TYPE };
  const first = inputs.arguments[0] ?? inputs.named.values().next().value;
  const shaped = !listShapeFails(contract, inputs, removable(inputs.receiver!));
  const kinds = shaped ? argumentKindFails(contract, inputs) : false;
  if (kinds === "bottom") return UNCONSTRAINED;
  const problems = !shaped || kinds;
  if (!problems && first !== undefined) {
    if (isBottom(first)) return UNCONSTRAINED;
    if (first.dynamic === null) {
      const all = viewMembers(first);
      const passing = all.filter((member) => member.kind !== "null");
      if (passing.length > 0 && passing.length < all.length) return typeResult(unknownElements);
    }
  }
  const owns = viewMembers(restrictedTo(inputs.receiver!, kind)).flatMap((member) => {
    const value = resolved(member);
    return value.kind === "list" || value.kind === "set" ? [resolved(value.element)] : [];
  });
  if (owns.length === 0) return INVALID;
  if (contract.name === "union" && first !== undefined && isBottom(first)) return UNCONSTRAINED;
  const result = (own: StaticType): StaticType => {
    if (contract.name !== "union" || first === undefined) return { kind, element: own };
    if (first.dynamic !== null) return unknownElements;
    const others: StaticType[] = [];
    for (const member of useOf(first)) {
      if (member.kind !== "list" && member.kind !== "set") return unknownElements;
      others.push(resolved(member.element));
    }
    if (own.kind === "unknown" || others.some((other) => other.kind === "unknown"))
      return unknownElements;
    const parts = [own, ...others].filter((part) => part.kind !== "never");
    if (parts.length === 0) return { kind, element: own };
    const element = joinTypes(parts);
    return element === undefined ? unknownElements : { kind, element };
  };
  return typeResult(union(owns.map(result)));
}

/**
 * A list's or set's methods, as `LIST_METHODS` names their results (`#collectionMethodType`): `get` has no value when
 * its shape is wrong or its default is missing (its index and default are the visitor's checks); the other methods
 * keep their result beside a report of the shape or of an argument's kind.
 */
function listMethodResult(
  kind: "list" | "set",
  name: string,
  inputs: OperationInputs,
): OperationResult | undefined {
  const contract = listMethod(name);
  if (contract === undefined || !contract.receivers.includes(kind)) return undefined;
  if (contract.result === "element" && contract.decides === "default")
    return listShapeFails(contract, inputs, false)
      ? INVALID
      : alternativesOf(projectionOf(RECEIVER, "element"), projectionOf(named("default")));
  if (contract.parameters[0]?.kind === "collection") return setOperation(kind, contract, inputs);
  switch (contract.result) {
    case "element":
      return projectionOf(RECEIVER, "element");
    case "list":
    case "set":
    case "same":
      return joinOf(
        contract.result === "same" ? kind : contract.result,
        pathOf(RECEIVER, "element"),
      );
    default:
      return LIST_RESULT[contract.result];
  }
}

function method(
  kind: ValueKind,
  name: string,
  inputs: OperationInputs,
): OperationResult | undefined {
  switch (kind) {
    case "range":
      return name === "toList" ? typeResult({ kind: "list", element: INTEGER_TYPE }) : undefined;
    case "dict":
      return dictMethodResult(name, inputs);
    case "list":
    case "set":
      return listMethodResult(kind, name, inputs);
    default:
      return undefined;
  }
}

const RULES: MemberRules = { kinds: ["list", "set", "dict", "object", "range"], property, method };

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
