import { isScalarKind } from "../../../static-types.js";
import { hasIdentity, VALUE_KIND_NAMES, type ValueKind } from "../../../value-kinds.js";
import { SELECTED_TEXT, SELECTED_VALUE } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import {
  EMPTY,
  makeItem,
  computedMarks,
  REASON,
  type Item,
  type ItemTag,
  type Writer,
} from "../items.js";
import { dictList, memberStep, measuresLength } from "../method-categories.js";
import { stepName } from "../program.js";
import type { Decision } from "../solver.js";

// The items and kinds the contract side builds: an unknown, a reference, a typed default's, a host's or an empty collection's.

/**
 * The reference kinds (V30 §12, §37), the kinds whose values have an identity: a speaker and every handle; an
 * access through one has no modelled member.
 */
export const REFERENCE: ReadonlySet<ItemTag> = new Set(VALUE_KIND_NAMES.filter(hasIdentity));

export const COLLECTIONS: ReadonlySet<ItemTag> = new Set(["list", "set", "dict", "object"]);

/** An unknown with `reasons`, a set of `REASON` bits. */
export function unknownItem(reasons: number, writer: Writer | null = null): Item {
  return makeItem("unknown", writer, { reasons });
}

/**
 * The mark travels with the value through every transfer: an item a transfer makes from others (a method's or a
 * member's declared result, a copy, a length, a loop's visit) is guarded, and possible, where one of them is.
 */
export function carried(item: Item, from: readonly Item[]): Item {
  // (a transfer's result is computed: never external data a test refined, `computedMarks`, #1073)
  const marks = computedMarks(from);
  const guard = from.find((each) => each.guarded === true);
  return guard === undefined
    ? { ...item, ...marks }
    : { ...item, ...marks, cert: "pos", context: item.context ?? guard.context };
}

/** A typeless load's `default: null` beside its external data: the null carries the ingress's word. */
export function ingressNull(writer: Writer | null = null): Item {
  return makeItem("null", writer, { cert: "pos", word: "unknown" });
}

/**
 * The kinds a `load` or `fromJson` takes from its default's (the input): the default's own;
 * `unknown` where it has none; `unknown` and, at the value itself, the ingress `null` (with the writer of the default's
 * `null` where `writer` asks) where it holds only `null` (a known `default: null` keeps null). A choice on the default's
 * completed kinds: a provisional default without kinds is not yet one without kinds.
 */
export function typedDefault(rest: readonly string[], writer: boolean): Decision {
  return {
    choose: (input) =>
      withoutEmpty(input).length === 0
        ? "none"
        : input.every((item) => item.tag === "null")
          ? "null"
          : "own",
    // (#1668: the default's own kinds (`own`, or open) keep its input's items, so its inclusions, qualified; `none`
    // (no kinds) and `null` (only nulls, which it replaces) keep none of them)
    flow: (choice, inclusions) =>
      choice === "none" || choice === "null"
        ? []
        : inclusions.map((inclusion) => ({
            ...inclusion,
            qualifiers: ["defaultChoice", ...inclusion.qualifiers],
          })),
    answer: (choice, input) => {
      if (choice === "none") return [unknownItem(REASON.external), ...withoutEmpty(input)];
      if (choice !== "null") return input;
      const first = input.find((item) => item.tag === "null");
      return [
        unknownItem(REASON.external),
        ...(rest.length === 0 ? [ingressNull(writer ? (first?.writer ?? null) : null)] : []),
        ...input.filter((item) => item.tag !== "null"),
      ];
    },
  };
}

/** A default holds only `null`, or nothing (`[ingressNull()]`, or none), on its completed kinds. */
export const ONLY_NULL: Decision = {
  choose: (input) => (input.every((item) => item.tag === "null") ? "null" : "other"),
  answer: (choice) => (choice === "null" ? [ingressNull()] : []),
  // (#1668: its answer is made anew, its input's items in neither choice's)
  flow: () => [],
};

/** An object's own `first`, `last` or `random`, which the core does not read. */
export const OWN_SELECTION: Item = Object.freeze(
  makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
);

/** A reference's member, the runtime's. */
export const OPAQUE_MEMBER: Item = OWN_SELECTION;

/** What a receiver's kinds hold beside them where its component decided it a reference (`RECEIVER`). */
export const HELD_REFERENCE: Item = Object.freeze(
  makeItem("unknown", null, { reasons: REASON.opaque }),
);

/**
 * Whether a receiver's item has a structure a step below is read from, through the stores into it: a record or a
 * collection. A scalar or `null` has none; a reference's members are the runtime's; an unknown's members are
 * unknown for its own reasons, from its own ingress (`belowUnknown`), whatever those reasons are.
 */
export function holdsBelow(item: Item): boolean {
  return (
    item.tag !== "unknown" &&
    item.tag !== "empty" &&
    item.tag !== "null" &&
    !isScalarKind(item.tag) &&
    !REFERENCE.has(item.tag)
  );
}

/** Whether a receiver's kinds, as a `RECEIVER` demand answers them, are a reference's. */
export function heldReference(items: readonly Item[]): boolean {
  return items.includes(HELD_REFERENCE);
}

/**
 * A property no source holds (`selectionOf`): a quoted step that is no internal step's, so no identifier's
 * (`propertyStep`).
 */
export const ABSENT = "'absent";

/** The kinds that may have a member an unknown receiver is asked for. */
export const MEMBER_KINDS: readonly ValueKind[] = [
  "string",
  "list",
  "set",
  "dict",
  "object",
  "range",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
];

/**
 * Whether a projection's step selects what its owner holds at the step's path, so the projection's contract below it is
 * its owner's there (a level member's normalization, `levelMember`): a property or an index; never an iteration, a
 * list's selection, a length, a dict's lists or a temporal member, which answer by themselves.
 */
export function plainStep(step: string): boolean {
  if (step === "index") return true;
  return (
    step !== "iteration" &&
    stepName(step) === step &&
    !measuresLength(step) &&
    dictList(step) === undefined &&
    memberStep([step], 0) < 0
  );
}

/**
 * #1278: whether a step is an author's property read as any property, which a closed object of a selection answers
 * by its names alone (`selectionPieces`): no element, index or selection step, nor a member a built-in value
 * answers by itself (`plainStep`).
 */
export function propertyOnly(step: string): boolean {
  return (
    step !== "index" &&
    step !== "element" &&
    step !== SELECTED_VALUE &&
    step !== SELECTED_TEXT &&
    plainStep(step)
  );
}

/**
 * #1605: whether a position (`positions.ts`) advances by a step: a property's, or an element's below a frontier that
 * passed a wrapper, so a key's element levels stand at its parent's position, never at its root and whole path again.
 * Any other step (a selection's value or text, a member a built-in value answers) is the key's own computation.
 */
export function positionStep(step: string): boolean {
  return step === "element" || propertyOnly(step);
}

/** A stored or parsed collection may hold none. */
export function emptyAt(rest: {
  readonly length: number;
  at(index: number): string | undefined;
}): Item[] {
  return rest.length > 0 && rest.at(rest.length - 1) === "element" ? [EMPTY] : [];
}

/**
 * Host data at a path (a computed key's load too): unknown, and a collection there may hold none, whatever a
 * written type or a test later says of its elements (V30 §16).
 */
export function hostAt(rest: {
  readonly length: number;
  at(index: number): string | undefined;
}): Item[] {
  return [unknownItem(REASON.external), ...emptyAt(rest)];
}
