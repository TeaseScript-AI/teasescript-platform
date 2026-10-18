import { dictMethod, dictProperty } from "../../dict-operations.js";
import { listMethod, listProperty, type ListMethod } from "../../list-methods.js";
import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  isKnown,
  joinTypes,
  NULL_TYPE,
  optional,
  resolved,
  STRING_TYPE,
  union,
  UNKNOWN_TYPE,
  type StaticType,
} from "../../static-types.js";
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

/**
 * The legacy's shape gate of a dict method (`#checkDictArguments`) and of a list's `get` (`getProblems`): a name the
 * method does not take, or another positional count, is reported and the call has no value.
 */
function misshapen(
  inputs: OperationInputs,
  parameters: number,
  named: readonly string[] | undefined,
): boolean {
  return (
    [...inputs.named.keys()].some((name) => !(named ?? []).includes(name)) ||
    inputs.arguments.length !== parameters
  );
}

/**
 * A dict's methods: `dictMethod` names what each gives; `get` needs its default (V30 §40) and gives a copy of either.
 * The legacy's shape gate (`#checkDictArguments`) takes the value away only from a receiver that is a dict alone
 * (`isDictReceiver`); beside other kinds the shape problem is reported and the dict's value kept.
 */
function dictMethodResult(name: string, inputs: OperationInputs): OperationResult | undefined {
  const contract = dictMethod(name);
  if (contract === undefined) return undefined;
  const known = viewMembers(inputs.receiver!).filter(
    (member) => member.kind !== "null" && isKnown(member),
  );
  const dictAlone = known.length > 0 && known.every((member) => resolved(member).kind === "dict");
  if (dictAlone && misshapen(inputs, contract.parameters.length, contract.named)) return INVALID;
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
 * `intersection`, `union` and `difference` (`#setOperationType`), per member of the receiver's kind: a new collection
 * of that kind. `union` holds the elements of both, so their types join as in a list literal, and a member of the
 * argument that is no collection, an element the compiler cannot know, or a mix leaves the elements unknown (the
 * legacy's recovery, reported where it mixes); the other operations keep the member's element. An argument that may
 * be null needs a check first and leaves the elements unknown, when the call's shape passed; an empty collection
 * adds no element.
 */
function setOperation(
  kind: "list" | "set",
  contract: ListMethod,
  inputs: OperationInputs,
): OperationResult {
  const receiver = restrictedTo(inputs.receiver!, kind);
  const other = inputs.arguments[0];
  const unknownElements: StaticType = { kind, element: UNKNOWN_TYPE };
  const shaped = !misshapen(inputs, contract.parameters.length, contract.named);
  if (other !== undefined && isBottom(other)) return UNCONSTRAINED;
  if (shaped && other !== undefined && other.dynamic === null) {
    const all = viewMembers(other);
    const passing = all.filter((member) => member.kind !== "null");
    if (passing.length > 0 && passing.length < all.length) return typeResult(unknownElements);
  }
  const owns = viewMembers(receiver).flatMap((member) => {
    const value = resolved(member);
    return value.kind === "list" || value.kind === "set" ? [resolved(value.element)] : [];
  });
  if (owns.length === 0) return INVALID;
  const result = (own: StaticType): StaticType => {
    if (contract.name !== "union" || other === undefined) return { kind, element: own };
    if (other.dynamic !== null) return unknownElements;
    const others: StaticType[] = [];
    for (const member of viewMembers(other).map(resolved)) {
      if (member.kind === "null") continue;
      if (member.kind !== "list" && member.kind !== "set") return unknownElements;
      others.push(resolved(member.element));
    }
    // An empty collection (an element nothing was stored into) adds no element.
    const parts = [own, ...others].filter((part) => part.kind !== "never");
    if (parts.some((part) => part.kind === "unknown")) return unknownElements;
    if (parts.length === 0) return { kind, element: own };
    const element = joinTypes(parts);
    return element === undefined ? unknownElements : { kind, element };
  };
  return typeResult(union(owns.map(result)));
}

/** A list's or set's methods, as `LIST_METHODS` names their results (`#collectionMethodType`, `#setOperationType`). */
function listMethodResult(
  kind: "list" | "set",
  name: string,
  inputs: OperationInputs,
): OperationResult | undefined {
  const contract = listMethod(name);
  if (contract === undefined || !contract.receivers.includes(kind)) return undefined;
  // `get` has no value when its shape is wrong or its default is missing; the other methods keep their result
  // beside a shape report (the visitor's check).
  if (contract.result === "element" && contract.decides === "default")
    return misshapen(inputs, contract.parameters.length, contract.named) ||
      !inputs.named.has("default")
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
