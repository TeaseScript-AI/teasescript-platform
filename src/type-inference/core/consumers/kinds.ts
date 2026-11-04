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

/** Whether kinds are of one type at most (A3's family: whole numbers with numbers, `null` beside a type, or none). */
export function oneType(kinds: readonly ItemTag[]): boolean {
  return kinds.every((kind) => kind === "null") || family(kinds);
}

/**
 * The known types of a value as its contract holds them, its `null` included, in their one order: the alternatives an
 * answer brings (#1352); an unknown beside them adds none and never stands for one type.
 */
export function knownKinds(walk: Consumers, value: PlaceId): ItemTag[] {
  return kindsInOrder(
    new Set(
      withoutEmpty(walk.run(walk.pass.contract.contractOfValueAt(value, [])))
        .filter((item) => item.tag === "null" || concrete(item))
        .map((item) => item.tag),
    ),
  );
}

/**
 * V30 §19: the types an `askChoice`'s buttons return where they are more than one (whole numbers with numbers are one,
 * `null` beside a type makes it optional, ADR 0021 1.2, 1.3), its `null` among them, in their one order: the types a
 * place keeps only where it is declared with their union; `null` for any other value. The known values decide it,
 * whatever a button the script cannot know adds, as the current checker's `#reportMixedChoice` does.
 */
export function mixedAnswer(walk: Consumers, value: PlaceId): readonly ItemTag[] | null {
  const c = walk.pass.program.opOf.get(value);
  if (c?.kind !== "operation" || c.evidence?.kind !== "choice") return null;
  const tags = knownKinds(walk, value);
  return oneType(tags) ? null : tags;
}

/**
 * The rule of where a mixed answer travels (#1352): the operands whose value an operation's result is, unchanged,
 * where it takes them (V30 §18), both sides of an `otherwise` and a `get`'s default; none for any other value. An answer
 * reaches its destination through these alone; a literal's cell reaches it where the literal lands (`landingOf`).
 */
export function passedOperands(c: ValueConstraint | undefined): readonly PlaceId[] {
  return c?.kind === "fallback" ? [c.left, c.right] : c?.kind === "get" ? [c.fallback] : [];
}

/** Per pass, the values a mixed answer reaches unchanged (`passedOperands`), as `mixedChoice` found them. */
const CARRIED = new WeakMap<Consumers, Set<PlaceId>>();

/** `mixedChoice`'s record of a value a mixed answer reaches unchanged, the choice's own result among them. */
export function markCarried(walk: Consumers, value: PlaceId): void {
  let carried = CARRIED.get(walk);
  if (carried === undefined) CARRIED.set(walk, (carried = new Set()));
  carried.add(value);
}

/** Whether a mixed answer reaches any value of the pass (`markCarried`). */
export function anyCarried(walk: Consumers): boolean {
  return (CARRIED.get(walk)?.size ?? 0) > 0;
}

/**
 * What a new variable keeping a warning's subject declares (#1352, the kept-value fix of every warning): the known
 * types of a mixed answer the subject holds, a value the walk's reach from a mixed choice met (`markCarried`) or a
 * mixed choice itself; else none (`[]`: a `let` without a type infers no union there, at no cost). Asked only where
 * the subject's value is found; where it is not, `anyCarried` says whether a plain `let` is still proved.
 */
export function keptTypes(walk: Consumers, value: PlaceId): readonly ItemTag[] {
  if (CARRIED.get(walk)?.has(value) === true) {
    const own = knownKinds(walk, value);
    return oneType(own) ? [] : own;
  }
  return mixedAnswer(walk, value) ?? [];
}
