import type { TypeTerm } from "../../graph.js";
import { typeTags } from "../contract.js";
import { REASON, type Item, type ItemTag } from "../items.js";
import type { Decided } from "./model.js";

// What an item's kinds decide: which fit a destination, which contribute or decide, and which offend a decision.

/** The plain scalar kinds: an inferred root whose every store is of one family of them asks nothing. */
export const SCALAR: ReadonlySet<ItemTag> = new Set(["integer", "number", "string", "boolean"]);

export const NUMERIC: ReadonlySet<ItemTag> = new Set(["integer", "number"]);

/** The kinds that fit a destination of kind `ref` (C1, ADR 1.2): a whole number a number; an unknown anything. */
export function fits(tag: ItemTag, ref: ItemTag, written: boolean): boolean {
  return (
    tag === ref ||
    (tag === "integer" && ref === "number") ||
    (!written && tag === "number" && ref === "integer") ||
    tag === "unknown" ||
    // (an unrestricted destination, a written `list`'s element: every kind fits, V30 §13)
    ref === "unknown"
  );
}

export const concrete = (item: Item): boolean =>
  item.tag !== "null" && item.tag !== "unknown" && item.tag !== "empty";

export const isOpaque = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & (REASON.opaque | REASON.missing | REASON.budget)) !== 0;

export const isExternal = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & REASON.external) !== 0;

/** A value a store contributes to a place: an opaque or external unknown, never a source's missing field. */
export const contributes = (item: Item): boolean =>
  (isOpaque(item) || isExternal(item)) && item.reasons !== REASON.missing;

/** The items that decide (A2): definite, of a kind. */
export const deciding = (items: readonly Item[]): Item[] =>
  items.filter((item) => item.cert === "def" && concrete(item));

/** One family (A3): one kind, or whole numbers with numbers, with or without `null`. */
export function family(tags: readonly ItemTag[]): boolean {
  const kinds = tags.filter((tag) => tag !== "null");
  return kinds.length > 0 && (new Set(kinds).size === 1 || kinds.every((tag) => NUMERIC.has(tag)));
}

/** A number the place admits: one an internal contribution gives, never one possible solely through external data. */
export const admitsNumber = (item: Item): boolean => item.tag === "number" && item.extOnly !== true;

/** Whether items hold one a decision does not admit (A5: an offending kind; a `null` where none is admitted). */
export function offending(items: readonly Item[], decision: Decided): boolean {
  const tags = decision.tags ?? [];
  return items.some((item) =>
    item.tag === "null"
      ? !decision.nullable
      : item.tag === "unknown"
        ? contributes(item)
        : item.tag !== "empty" && !tags.some((tag) => fits(item.tag, tag, decision.byWritten)),
  );
}

/**
 * Whether contents may meet a written type at a path whatever stands first there (`Touches`' meeting test): each item fits it (a
 * `null` where it admits one, an unknown no external or opaque data), and where the contents' definite kinds decide
 * first (A2), each kind the type admits fits each of them; a written type unrestricted there admits everything, none
 * (`null`) nothing known.
 */
export function compatible(items: readonly Item[], term: TypeTerm | null): boolean {
  if (term === null) return false;
  const tags = typeTags(term);
  if (tags.includes("unknown")) return true;
  const kinds = tags.filter((tag) => tag !== "null");
  const decides = new Set<ItemTag>();
  for (const item of items) {
    if (item.tag === "null") {
      if (!tags.includes("null")) return false;
    } else if (item.tag === "unknown") {
      if (contributes(item)) return false;
    } else if (item.tag !== "empty") {
      if (!kinds.some((kind) => fits(item.tag, kind, true))) return false;
      if (item.cert === "def") decides.add(item.tag);
    }
  }
  for (const kind of kinds) for (const tag of decides) if (!fits(kind, tag, false)) return false;
  return true;
}
