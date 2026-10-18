import {
  handleMethod,
  handleProperty,
  isHandleKind,
  type HandleValueType,
} from "../../handle-members.js";
import {
  DURATION_TYPE,
  NULL_TYPE,
  NUMBER_TYPE,
  optional,
  STRING_TYPE,
  type StaticType,
} from "../../static-types.js";
import type { ValueKind } from "../../value-kinds.js";
import type { OperationResult } from "./relation.js";
import { typeResult, type MemberAnswer, type MemberRules } from "./views.js";

/**
 * The members of timers, media, cameras, messages and permanent buttons (O4 stage 2b), as `handlePropertyType` and
 * `memberMethodType` of the legacy checker give them from `HANDLE_MEMBERS`: a property is computed from the state
 * the handle names when it is read, also null where it is `nullable` (a timer's `label`), and every method gives
 * null. What the visitor reports about a method's arguments is checking-only.
 */
const VALUE_TYPES: Readonly<Record<HandleValueType, StaticType>> = {
  duration: DURATION_TYPE,
  string: STRING_TYPE,
  number: NUMBER_TYPE,
};

function property(kind: ValueKind, name: string): MemberAnswer | undefined {
  const contract = isHandleKind(kind) ? handleProperty(kind, name) : undefined;
  if (contract === undefined) return undefined;
  const type = VALUE_TYPES[contract.type];
  return typeResult(contract.nullable === true ? optional(type) : type);
}

function method(kind: ValueKind, name: string): OperationResult | undefined {
  return isHandleKind(kind) && handleMethod(kind, name) !== undefined
    ? typeResult(NULL_TYPE)
    : undefined;
}

const RULES: MemberRules = {
  kinds: ["timer", "media", "camera", "messageHandle", "permanentButton"],
  property,
  method,
};

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
