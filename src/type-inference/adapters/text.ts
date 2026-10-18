import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  optional,
  STRING_TYPE,
  type StaticType,
} from "../../static-types.js";
import { isTextMethod, TEXT_METHODS, type TextResult } from "../../text-operations.js";
import type { ValueKind } from "../../value-kinds.js";
import type { OperationResult } from "./relation.js";
import { typeResult, type MemberAnswer, type MemberRules } from "./views.js";

/**
 * The members of text (O4 stage 2b), as `memberPropertyType` and `memberMethodType` of the legacy checker give them:
 * `length` is an integer, and each method of `TEXT_METHODS` gives a new value of its result. What the visitor reports
 * about a method's arguments, their kinds, their number and the domains of their known values, is checking-only.
 * `join` is a method of lists.
 */
const TEXT_RESULTS: Readonly<Record<TextResult, StaticType>> = {
  string: STRING_TYPE,
  integer: INTEGER_TYPE,
  "integer?": optional(INTEGER_TYPE),
  boolean: BOOLEAN_TYPE,
  "string[]": { kind: "list", element: STRING_TYPE },
  "string?": optional(STRING_TYPE),
  // The groups of a match, or null without one; a group that did not take part is null.
  "string?[]?": optional({ kind: "list", element: optional(STRING_TYPE) }),
};

function property(kind: ValueKind, name: string): MemberAnswer | undefined {
  return kind === "string" && name === "length" ? typeResult(INTEGER_TYPE) : undefined;
}

function method(kind: ValueKind, name: string): OperationResult | undefined {
  return kind === "string" && isTextMethod(name)
    ? typeResult(TEXT_RESULTS[TEXT_METHODS[name].result])
    : undefined;
}

const RULES: MemberRules = { kinds: ["string"], property, method };

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
