import type { ValueKind } from "../../../value-kinds.js";
import * as clockTemporal from "../../adapters/clock-temporal.js";
import * as collections from "../../adapters/collections.js";
import * as handles from "../../adapters/handles.js";
import type { OperandView, OperationInputs } from "../../adapters/relation.js";
import * as text from "../../adapters/text.js";
import type { MemberRules } from "../../adapters/views.js";
import { requiredKind } from "../admission.js";
import { REASON, type Item, type ItemTag } from "../items.js";
import { OPERATOR_ROWS } from "../operator-table.js";
import type { RequiredKind } from "../result.js";

// The kinds and rules the consumers check against: the domains of operands, the members a view has, what is shown.

export const BOOLEAN: ReadonlySet<ItemTag> = new Set(["boolean"]);

export const TEXT: ReadonlySet<ItemTag> = new Set(["string"]);

/** C11: the kinds `${...}` shows (V30 §8). */
export const SHOWN: readonly ValueKind[] = [
  "string",
  "integer",
  "number",
  "boolean",
  "null",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "script",
  "regex",
];

/** The order an operand's domain lists the kinds of the operator table's rows in (F16), as the rows name them. */
const DOMAIN_ORDER: readonly ValueKind[] = [
  "integer",
  "number",
  "string",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "list",
];

const MEMBER_RULES: readonly MemberRules[] = [
  collections.MEMBER_RULES,
  text.MEMBER_RULES,
  handles.MEMBER_RULES,
  clockTemporal.MEMBER_RULES,
];

const NO_VIEW: OperandView = { alternatives: null, dynamic: null, known: undefined };

const NO_INPUTS: OperationInputs = {
  receiver: NO_VIEW,
  arguments: [],
  named: new Map(),
  evidence: undefined,
  view: () => NO_VIEW,
};

export function hasMethod(kind: ItemTag, name: string): boolean {
  if (kind === "unknown" || kind === "empty") return false;
  return MEMBER_RULES.some(
    (rules) => rules.kinds.includes(kind) && rules.method(kind, name, NO_INPUTS) !== undefined,
  );
}

/** C5b: a list's or dict's index (V30 §16, §40), else the compiler's member rules. */
export function hasProperty(kind: ItemTag, name: string): boolean {
  if (name === "index") return kind === "list" || kind === "dict";
  if (kind === "unknown" || kind === "empty") return false;
  return MEMBER_RULES.some(
    (rules) => rules.kinds.includes(kind) && rules.property(kind, name, NO_VIEW) !== undefined,
  );
}

/**
 * An operand's domain (C4): the operator's rows' kinds at `index`, given the other operands' kinds; every row's when none
 * takes them.
 */
export function operandDomain(
  rows: readonly (typeof OPERATOR_ROWS)[number][],
  operands: readonly (readonly Item[])[],
  index: number,
): RequiredKind[] {
  const taking = rows.filter((row) =>
    operands.every(
      (items, other) =>
        other === index ||
        items.some((item) => item.tag === "unknown" || row.operands[other] === item.tag),
    ),
  );
  return inDomainOrder((taking.length > 0 ? taking : rows).map((row) => row.operands[index]!)).map(
    (tag) => requiredKind(tag),
  );
}

/** A consumer's operand domain in the order the operator rows list it. */
function inDomainOrder(kinds: Iterable<ItemTag>): ItemTag[] {
  const rank = (kind: ItemTag): number => {
    const index = DOMAIN_ORDER.findIndex((candidate) => candidate === kind);
    return index === -1 ? DOMAIN_ORDER.length : index;
  };
  return [...new Set(kinds)].sort((a, b) => rank(a) - rank(b));
}

/** The literals whose kind is their own, the finishing path's one proof (`Consumers.valueItems`). */
export const LITERALS: ReadonlySet<string> = new Set([
  "numberLiteral",
  "booleanLiteral",
  "nullLiteral",
  "stringLiteral",
  "durationLiteral",
  "regexLiteral",
]);

/** Whether an item is the unknown a stop leaves where nothing is settled (`STOPPED`'s). */
export function unsettledItem(item: Item): boolean {
  return item.tag === "unknown" && (item.reasons & REASON.budget) !== 0;
}
