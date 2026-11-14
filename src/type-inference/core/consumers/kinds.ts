import type { ValueKind } from "../../../value-kinds.js";
import * as clockTemporal from "../../adapters/clock-temporal.js";
import * as collections from "../../adapters/collections.js";
import * as handles from "../../adapters/handles.js";
import type { OperandView, OperationInputs } from "../../adapters/relation.js";
import * as text from "../../adapters/text.js";
import type { MemberRules } from "../../adapters/views.js";
import type { PlaceId } from "../../graph.js";
import { concrete, requiredKind } from "../admission.js";
import { family } from "../admission/kinds.js";
import type { Consumers } from "../consumers.js";
import { withoutEmpty } from "../exact-path.js";
import { kindsInOrder, REASON, type Item, type ItemTag } from "../items.js";
import type { ValueConstraint } from "../program.js";
import { OPERATOR_ROWS } from "../operator-table.js";
import type { RequiredKind } from "../result.js";

// The kinds and rules the consumers check against: the domains of operands, the members a view has, what is shown.

export const BOOLEAN: ReadonlySet<ItemTag> = new Set(["boolean"]);

export const TEXT: ReadonlySet<ItemTag> = new Set(["string"]);

/** The kinds `${...}` shows (V30 §8). */
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

/** The order an operand's domain lists the kinds of the operator table's rows in, as the rows name them. */
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

/** Whether a kind has the method, by the compiler's own member rules. */
export function hasMethod(kind: ItemTag, name: string): boolean {
  if (kind === "unknown" || kind === "empty") return false;
  return MEMBER_RULES.some(
    (rules) => rules.kinds.includes(kind) && rules.method(kind, name, NO_INPUTS) !== undefined,
  );
}

/** Whether a kind has the property: a list's or dict's `index` (V30 §16, §40), else by the compiler's member rules. */
export function hasProperty(kind: ItemTag, name: string): boolean {
  if (name === "index") return kind === "list" || kind === "dict";
  if (kind === "unknown" || kind === "empty") return false;
  return MEMBER_RULES.some(
    (rules) => rules.kinds.includes(kind) && rules.property(kind, name, NO_VIEW) !== undefined,
  );
}

/**
 * An operand's domain: the operator's rows' kinds at `index`, given the other operands' kinds; every row's when none
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

/**
 * The scalar literals whose kind is their own, known from the syntax without solving.
 */
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

/**
 * Whether kinds are of one type at most: whole numbers with numbers, `null` beside a type, `null` alone, or none.
 */
export function oneType(kinds: readonly ItemTag[]): boolean {
  return kinds.every((kind) => kind === "null") || family(kinds);
}

/**
 * The known types of a value as its contract holds them, its `null` included, in their one order: the alternatives an
 * answer brings (#1352); an unknown beside them adds none and never stands for one type. With whether the read stopped
 * at its demand allowance (`unsettledItem`), where the known types prove nothing of the rest (#1660).
 */
export function answerRead(
  walk: Consumers,
  value: PlaceId,
): { readonly kinds: ItemTag[]; readonly stopped: boolean } {
  const items = withoutEmpty(walk.run(walk.pass.contract.contractOfValueAt(value, [])));
  return {
    kinds: kindsInOrder(
      new Set(
        items.filter((item) => item.tag === "null" || concrete(item)).map((item) => item.tag),
      ),
    ),
    stopped: items.some(unsettledItem),
  };
}

/**
 * The rule of where a mixed answer travels (#1352): the operands whose value an operation's result is, unchanged,
 * where it takes them (V30 §18), both sides of an `otherwise` and a `get`'s default; none for any other value. An answer
 * reaches its destination through these alone; a literal's cell reaches it where the literal lands (`landingOf`).
 */
export function passedOperands(c: ValueConstraint | undefined): readonly PlaceId[] {
  return c?.kind === "fallback" ? [c.left, c.right] : c?.kind === "get" ? [c.fallback] : [];
}

/**
 * Per pass, the walk's record of the values a mixed answer reaches unchanged (`passedOperands`), the choice's own result
 * first, each with its known types where they are more than one, none where they are one, and of each such value or
 * choice whose read stopped at its demand allowance where its known types are one (`stopped`: the walk proved nothing
 * of it, #1352). Only the walk records, where its reads answer: a choice in a unit past the nesting limit is decided
 * only by the finishing walk, whose warnings are deferred into the stop's (TSV076) and never published, so no
 * published warning reads its record.
 */
const ANSWERED = new WeakMap<Consumers, Map<PlaceId, readonly ItemTag[] | "stopped">>();

/** `mixedChoice`'s record of a value and its answer types (none for one type), or that its read stopped. */
export function recordAnswer(
  walk: Consumers,
  value: PlaceId,
  types: readonly ItemTag[] | "stopped",
): void {
  let answered = ANSWERED.get(walk);
  if (answered === undefined) ANSWERED.set(walk, (answered = new Map()));
  answered.set(value, types);
}

/** Whether the stage recorded any answer of the pass: a mixed one, one it reaches, or a stopped read. */
export function anyRecorded(walk: Consumers): boolean {
  return ANSWERED.has(walk);
}

/**
 * What a new variable keeping a warning's subject declares (#1352, the kept-value fix of every warning), a proof in
 * three values whose only source of "no union" is a settled read (#1660): the union a settled read showed (`let value:
 * <union> = …`); none (`[]`, the plain `let`) where a settled read showed one type, or no answer reaches the subject;
 * `null` (unproved, the fix in words, never a plain `let`) where every read on the path stopped. Asked only where the
 * subject's value is found.
 */
export function keptTypes(walk: Consumers, value: PlaceId): readonly ItemTag[] | null {
  const recorded = ANSWERED.get(walk)?.get(value);
  if (recorded === undefined) return [];
  if (recorded !== "stopped") return recorded;
  const read = answerRead(walk, value);
  return read.stopped ? null : oneType(read.kinds) ? [] : read.kinds;
}
