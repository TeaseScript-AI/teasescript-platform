import { dictMethod, dictProperty } from "../../dict-operations.js";
import { listMethod, listProperty } from "../../list-methods.js";
import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  NULL_TYPE,
  optional,
  resolved,
  STRING_TYPE,
} from "../../static-types.js";
import type { ValueKind } from "../../value-kinds.js";
import type { OperandView, OperationInputs, OperationResult } from "./relation.js";
import {
  alternativesOf,
  argument,
  dynamicResult,
  INVALID,
  joinOf,
  named,
  pathOf,
  projectionOf,
  RECEIVER,
  typeResult,
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

/** A dict's methods: `dictMethod` names what each gives; `get` needs its default (V30 §40) and gives a copy of either. */
function dictMethodResult(name: string, hasDefault: boolean): OperationResult | undefined {
  const contract = dictMethod(name);
  if (contract === undefined) return undefined;
  switch (contract.result) {
    case "null":
      return typeResult(NULL_TYPE);
    case "boolean":
      return typeResult(BOOLEAN_TYPE);
    case "value":
      if (contract.missing !== "default") return projectionOf(RECEIVER, "entry");
      return hasDefault
        ? alternativesOf(projectionOf(RECEIVER, "entry"), projectionOf(named("default")))
        : INVALID;
  }
}

/** A list's or set's methods, as `LIST_METHODS` names their results (`#collectionMethodType`, `#setOperationType`). */
function listMethodResult(
  kind: "list" | "set",
  name: string,
  hasDefault: boolean,
): OperationResult | undefined {
  const contract = listMethod(name);
  if (contract === undefined || !contract.receivers.includes(kind)) return undefined;
  switch (contract.result) {
    case "element":
      if (contract.decides === "default")
        return hasDefault
          ? alternativesOf(projectionOf(RECEIVER, "element"), projectionOf(named("default")))
          : INVALID;
      return projectionOf(RECEIVER, "element");
    case "list":
    case "set":
    case "same": {
      const made = contract.result === "same" ? kind : contract.result;
      // `union` holds the elements of both collections; the other operations keep the receiver's.
      return name === "union"
        ? joinOf(made, pathOf(RECEIVER, "element"), pathOf(argument(0), "element"))
        : joinOf(made, pathOf(RECEIVER, "element"));
    }
    default:
      return LIST_RESULT[contract.result];
  }
}

function method(
  kind: ValueKind,
  name: string,
  inputs: OperationInputs,
): OperationResult | undefined {
  const hasDefault = inputs.named.has("default");
  switch (kind) {
    case "range":
      return name === "toList" ? typeResult({ kind: "list", element: INTEGER_TYPE }) : undefined;
    case "dict":
      return dictMethodResult(name, hasDefault);
    case "list":
    case "set":
      return listMethodResult(kind, name, hasDefault);
    default:
      return undefined;
  }
}

const RULES: MemberRules = { kinds: ["list", "set", "dict", "object", "range"], property, method };

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
