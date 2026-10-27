import { CONVERSIONS, isConversion, type ConversionResult } from "../../conversions.js";
import { dictMethod, dictProperty } from "../../dict-operations.js";
import { listMethod, listProperty } from "../../list-methods.js";
import {
  CALENDAR_DURATION_PARTS,
  CLOCK_CONTRACTS,
  hasTemporalField,
  hasTemporalMethod,
  isCalendarDurationPart,
  isClockFunction,
  isTemporalKind,
  TEMPORAL_FIELDS,
  TEMPORAL_METHODS,
} from "../../temporal-builtins.js";
import { isTextMethod, TEXT_METHODS, type TextResult } from "../../text-operations.js";
import type { ValueKind } from "../../value-kinds.js";

/*
 * What each built-in operation does to the values the coarse core follows, by semantic category (the owner's
 * extensibility criterion, 2026-10-24: PLAN §6a, S3 revision 8 §2). The generic core (definitions, contract, exact
 * path, values, answers) reads an operation's category, never its name: a new method that uses a mechanism the core
 * already has is a new row of a table (below), with its language rules in the adapter layer (`consumers.ts`), and no
 * change to the core. A new mechanism (a new kind of definition, a new transfer, a new loop form, a new certainty rule)
 * is a change to the core. The rows are the model's (`points14.mjs`: `METHOD_RESULT`, `REMOVALS`, `SELECTIONS`,
 * `ASKED`, the conversions). The selections, the conversions, and what a method does to its receiver's elements come
 * from the language's own tables (`list-methods.ts`, `dict-operations.ts`, `conversions.ts`), which the compiler and
 * the runtime read too, so a method that removes or clears is a row of its contracts alone; the other methods' results
 * are rows here, which `tests/type-core-method-categories.test.ts` checks against the contracts.
 */

/** What a method of a collection does and gives. */
export interface MethodCategory {
  /**
   * What it does to the elements of its receiver in place, as its contracts say (`ListMethod.changes`,
   * `DictMethod.changes`): `clears` leaves none (F6), `removes` may take any of them, so every remaining one is possible
   * and none may remain (F7).
   */
  readonly receiver?: "clears" | "removes";
  readonly gives:
    /** F25: its declared result, on a collection (on text, `declaredResult`). */
    | { readonly kind: "declared"; readonly kinds: readonly ValueKind[] }
    /** F7: an element it removed (from a dict, its value), or `null` from a list or set where `null` says so. */
    | { readonly kind: "removed"; readonly fromList: "element" | "null" }
    /** F10: a new list or set of the receiver's elements, which may hold none where it takes a count. */
    | { readonly kind: "copy"; readonly into: "list" | "set"; readonly mayHoldNone: boolean };
}

const declared = (...kinds: readonly ValueKind[]): MethodCategory => ({
  gives: { kind: "declared", kinds },
});

/** The methods of the built-in values the core models that remove none of their receiver's elements, by name. */
const METHODS: Readonly<Record<string, MethodCategory>> = {
  contains: declared("boolean"),
  count: declared("integer"),
  indexOf: declared("integer", "null"),
  lastIndexOf: declared("integer", "null"),
  join: declared("string"),
  uppercase: declared("string"),
  lowercase: declared("string"),
  trim: declared("string"),
  sort: declared("null"),
  shuffle: declared("null"),
  reverse: declared("null"),
  toSet: { gives: { kind: "copy", into: "set", mayHoldNone: false } },
  toList: { gives: { kind: "copy", into: "list", mayHoldNone: false } },
  take: { gives: { kind: "copy", into: "list", mayHoldNone: true } },
  takeLast: { gives: { kind: "copy", into: "list", mayHoldNone: true } },
};

/** F6: a method that clears its receiver gives `null`. */
const CLEARS: MethodCategory = { receiver: "clears", gives: { kind: "declared", kinds: ["null"] } };

/** F7: a method that removes gives what it removed, or `null` from a list or set where its list contract says so. */
const REMOVES: Readonly<Record<"element" | "null", MethodCategory>> = {
  element: { receiver: "removes", gives: { kind: "removed", fromList: "element" } },
  null: { receiver: "removes", gives: { kind: "removed", fromList: "null" } },
};

/**
 * A method's category, or `undefined` for one the core does not model (its result is the runtime's): a method that
 * removes or clears its receiver's elements has its category from its contracts; one that adds them is a store into
 * them (`collector.ts`).
 */
export function methodCategory(name: string): MethodCategory | undefined {
  const list = listMethod(name);
  const changes = list?.changes ?? dictMethod(name)?.changes;
  if (changes === "clears") return CLEARS;
  if (changes === "removes") return REMOVES[list?.result === "null" ? "null" : "element"];
  return Object.hasOwn(METHODS, name) ? METHODS[name] : undefined;
}

/** The results of text's methods as declared kinds, for the results a method with a declared result has. */
const TEXT_RESULTS: Readonly<Partial<Record<TextResult, readonly ValueKind[]>>> = {
  boolean: ["boolean"],
  integer: ["integer"],
  "integer?": ["integer", "null"],
  string: ["string"],
  "string?": ["string", "null"],
};

/**
 * F25: what a method with a declared result (`kinds`, a collection's) gives on a receiver of `receiver`'s kind: on text,
 * its text contract's result where text has the method (`reverse` gives text, a list's gives `null`); on an unknown
 * receiver, either one.
 */
export function declaredResult(
  name: string,
  kinds: readonly ValueKind[],
  receiver: string,
): readonly ValueKind[] {
  const text = isTextMethod(name) ? TEXT_RESULTS[TEXT_METHODS[name].result] : undefined;
  if (text === undefined || (receiver !== "string" && receiver !== "unknown")) return kinds;
  return receiver === "string" ? text : [...new Set([...kinds, ...text])];
}

/**
 * V30 §6, F10, F27: the element a value holds by its kind alone, which a loop visits and a copy of its elements
 * (`toList`) holds: a range's whole numbers, as many as its bounds give and so maybe none, as the range-to-list
 * transfer does not use the bounds (P7 proves only a direct loop's entry). A list's or a set's elements are its own,
 * read below it.
 */
const KIND_ELEMENTS: Readonly<Record<string, ValueKind>> = { range: "integer" };

export function kindElement(kind: string): ValueKind | undefined {
  return Object.hasOwn(KIND_ELEMENTS, kind) ? KIND_ELEMENTS[kind] : undefined;
}

/** C6, F11: whether a property of a list or set selects one of its elements (on an object, its own property). */
export function selectsElement(property: string): boolean {
  return listProperty(property)?.gives === "element";
}

/** F14: whether a property gives the length of a text or a collection (on an object, its own property). */
export function measuresLength(property: string): boolean {
  return listProperty(property)?.gives === "length";
}

/**
 * TABLE r4.46 (2): a dict's property that gives a new list each read, by what the list holds: the dict's values
 * (`values`) or its keys, text (`keys`); on an object, a property of that name is its own (F11).
 */
export function dictList(property: string): "values" | "keys" | undefined {
  const gives = dictProperty(property)?.gives;
  return gives === "values" || gives === "keys" ? gives : undefined;
}

/**
 * A built-in property with a declared result per receiver kind: a temporal value's field or a calendar duration's part
 * (V30 §35), read from the language's tables; `undefined` where a receiver of the kind has no such property.
 */
export function declaredProperty(kind: string, name: string): ValueKind | undefined {
  if (kind === "calendarDuration")
    return isCalendarDurationPart(name) ? CALENDAR_DURATION_PARTS[name].result : undefined;
  return isTemporalKind(kind) && hasTemporalField(kind, name)
    ? TEMPORAL_FIELDS[name].result
    : undefined;
}

/** r4.47 (5): a clock read's declared kind (V30 §35), as an ask's declared answer, with no external data in it. */
export function clockResult(name: string): ValueKind | undefined {
  return isClockFunction(name) ? CLOCK_CONTRACTS[name].result : undefined;
}

/**
 * F25: a method with a declared result per receiver kind that the categories above do not give: a temporal value's
 * (V30 §35), read from the language's table; `undefined` where a receiver of the kind has no such method.
 */
export function declaredMethod(kind: string, name: string): ValueKind | undefined {
  return isTemporalKind(kind) && hasTemporalMethod(kind, name)
    ? TEMPORAL_METHODS[name].result
    : undefined;
}

/**
 * The first step of a path from `from` on that a built-in value answers by itself, wherever the path ends: a dict's
 * `values` or `keys`, or a declared property; -1 for none.
 */
export function memberStep(path: readonly string[], from: number): number {
  for (let index = from; index < path.length; index += 1) {
    const step = path[index]!;
    if (
      dictList(step) !== undefined ||
      Object.hasOwn(TEMPORAL_FIELDS, step) ||
      isCalendarDurationPart(step)
    )
      return index;
  }
  return -1;
}

/**
 * F25, F19a: what the other interactions give, the adapters' fixed results: a button's or a popup's duration, a
 * permanent button's or a camera's handle.
 */
const SHOWN: Readonly<Record<string, ValueKind>> = {
  showButton: "duration",
  showPopup: "duration",
  showPermanentButton: "permanentButton",
  showCamera: "camera",
};

export function shownResult(name: string): ValueKind | undefined {
  return Object.hasOwn(SHOWN, name) ? SHOWN[name] : undefined;
}

/** The members of the built-in values that give a declared result whatever their receiver: F14's `length`. */
const MEMBERS: Readonly<Record<string, readonly ValueKind[]>> = { length: ["integer"] };

export function memberResult(name: string): readonly ValueKind[] | undefined {
  return Object.hasOwn(MEMBERS, name) ? MEMBERS[name] : undefined;
}

/**
 * What an interaction gives: F25's declared answer, or one of its options' values (`askChoice`): authored options give
 * their authored kinds, and only an option from external data (a host read, a load, `fromJson`) brings it in, at that
 * option (C9, TABLE r4.42–r4.43). Any other interaction's answer is the runtime's.
 */
export type InteractionCategory =
  { readonly kind: "asks"; readonly result: ValueKind } | { readonly kind: "options" };

/** The interactions with a declared answer, by the collector's interaction kinds: the oracle's adapter rows. */
const ASKS: Readonly<Record<string, ValueKind>> = {
  text: "string",
  password: "string",
  number: "number",
  integer: "integer",
  date: "date",
  time: "time",
  datetime: "datetime",
  boolean: "boolean",
};

export function interactionCategory(name: string): InteractionCategory | undefined {
  if (Object.hasOwn(ASKS, name)) return { kind: "asks", result: ASKS[name]! };
  return name === "choice" ? { kind: "options" } : undefined;
}

/** What a conversion gives: a value of its result kind (with its default or `null`), or parsed external data. */
export type ConversionCategory =
  | {
      readonly kind: "converts";
      readonly result: ConversionResult;
      /** Without a default, `null` where the conversion cannot use its value. */
      readonly optional: boolean;
    }
  /** F18, F19: the data a text holds (`fromJson`), typed by a written type or its default. */
  | { readonly kind: "parses" };

export function conversionCategory(name: string): ConversionCategory | undefined {
  if (!isConversion(name)) return undefined;
  const conversion = CONVERSIONS[name];
  if (conversion.result === "unknown") return { kind: "parses" };
  return {
    kind: "converts",
    result: conversion.result,
    optional: conversion.fallback?.type === "optional",
  };
}

/** What a core built-in that is no conversion gives: a script reference, or text. */
const BUILTINS: Readonly<Record<string, ValueKind>> = { script: "script" };

export function builtinResult(name: string): ValueKind {
  return Object.hasOwn(BUILTINS, name) ? BUILTINS[name]! : "string";
}
