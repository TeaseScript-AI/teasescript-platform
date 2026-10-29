import { isScalarKind } from "../../../static-types.js";
import { hasIdentity, VALUE_KIND_NAMES, type ValueKind } from "../../../value-kinds.js";
import { SELECTED_TEXT, SELECTED_VALUE } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import {
  EMPTY,
  makeItem,
  marksOf,
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
 * F19a: the reference kinds (V30 §12, §37), the kinds whose values have an identity: a speaker and every handle; an
 * access through one has no modelled member.
 */
export const REFERENCE: ReadonlySet<ItemTag> = new Set(VALUE_KIND_NAMES.filter(hasIdentity));

export const COLLECTIONS: ReadonlySet<ItemTag> = new Set(["list", "set", "dict", "object"]);

/** An unknown with these reasons (TABLE §1). */
export function unknownItem(reasons: number, writer: Writer | null = null): Item {
  return makeItem("unknown", writer, { reasons });
}

/**
 * §3.2: the mark travels with the value through every transfer: an item a transfer makes from others (F7's declared
 * result, F10's conversion, F14's length, F27's key) is guarded, and possible, where one of them is.
 */
export function carried(item: Item, from: readonly Item[]): Item {
  const marks = marksOf(from);
  const guard = from.find((each) => each.guarded === true);
  return guard === undefined
    ? { ...item, ...marks }
    : { ...item, ...marks, cert: "pos", context: item.context ?? guard.context };
}

/** A typeless load's `default: null` beside its external data: the null carries the ingress's word (§3.4 r4.11). */
export function ingressNull(writer: Writer | null = null): Item {
  return makeItem("null", writer, { cert: "pos", word: "unknown" });
}

/**
 * F18 (r4.5), F19 (r4.1): the kinds a `load` or `fromJson` takes from its default's (the input): the default's own;
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

/** F19 (r4.1): a default holds only `null`, or nothing (`[ingressNull()]`, or none), on its completed kinds. */
export const ONLY_NULL: Decision = {
  choose: (input) => (input.every((item) => item.tag === "null") ? "null" : "other"),
  answer: (choice) => (choice === "null" ? [ingressNull()] : []),
};

/** F11 (r4.4): an object's own `first`, `last` or `random`, which the core does not read. */
export const OWN_SELECTION: Item = Object.freeze(
  makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
);

/** F19a: a reference's member, the runtime's. */
export const OPAQUE_MEMBER: Item = OWN_SELECTION;

/** F19a (r4.44): what a receiver's kinds hold beside them where its component decided it a reference (`RECEIVER`). */
export const HELD_REFERENCE: Item = Object.freeze(
  makeItem("unknown", null, { reasons: REASON.opaque }),
);

/**
 * Whether a receiver's item has a structure a step below is read from, through the stores into it: a record or a
 * collection. A scalar or `null` has none; a reference's members are the runtime's (F19a); an unknown's members are
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

/** F19a (r4.44): whether a receiver's kinds, as a `RECEIVER` demand answers them, are a reference's. */
export function heldReference(items: readonly Item[]): boolean {
  return items.includes(HELD_REFERENCE);
}

/**
 * A property no source holds (`selectionOf`): a quoted step that is no internal step's, so no identifier's
 * (`propertyStep`).
 */
export const ABSENT = "'absent";

/** The kinds that may have a member an unknown receiver is asked for (A7 r4.10). */
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
 * its owner's there (§4.6's normalization): a property or an index; never an iteration, a list's selection, a length,
 * a dict's lists or a temporal member, which answer by themselves.
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
 * #1278: whether a step is an author's property read as any property (F11), which a closed object of a selection answers
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

/** A stored or parsed collection may hold none. */
export function emptyAt(rest: readonly string[]): Item[] {
  return rest.at(-1) === "element" ? [EMPTY] : [];
}

/**
 * Host data at a path (C9; F19: a computed key's load too): unknown, and a collection there may hold none, whatever a
 * written type or a test later says of its elements (V30 §16).
 */
export function hostAt(rest: readonly string[]): Item[] {
  return [unknownItem(REASON.external), ...emptyAt(rest)];
}
