/**
 * The methods and properties of lists and sets (V30 §16): one contract each, shared by the compiler, the runtime, and
 * the editor. Text, dicts, ranges, handles, and date and time values have methods of some of the same names, such as
 * `contains`; each has its own.
 */

/** A kind of collection that has these methods and properties: a list, or a set. */
export type ListKind = "list" | "set";

/**
 * What an argument must be: any `value`, a `list`, a `collection` (a list or a set), an `index` of the list as
 * `list[index]` takes it, a `count`, a whole number of at least 0, or `text`.
 */
export type ListParameterKind = "value" | "list" | "collection" | "index" | "count" | "text";

export interface ListParameter {
  readonly name: string;
  readonly kind: ListParameterKind;
  readonly optional?: true;
}

/**
 * What a method gives: `null`, a `boolean`, an `integer`, an `integer?` (an index, or null where no element equals the
 * value), text, an `element` (one that leaves the list, or that `get` reads, as a copy for the place that keeps it), a
 * new `list` or `set` of copies of the elements, or a new collection of the receiver's kind (`same`).
 */
export type ListMethodResult =
  "null" | "boolean" | "integer" | "integer?" | "string" | "element" | "list" | "set" | "same";

/**
 * A method of lists, sets, or both: how it is called, what its arguments may be, what it gives, what it does to the
 * list or set it is called on, and its help. A method without `changes` or `draws` only reads its receiver and copies of
 * its arguments.
 */
export interface ListMethod {
  readonly name: string;
  /** The kinds that have the method. */
  readonly receivers: readonly ListKind[];
  /**
   * For a method only lists have, why a set has none and what to write instead; without it, the message names the
   * method only (`missingListMethodMessage`).
   */
  readonly notOnSet?: string;
  /** The positional parameters, which also give the number of positional arguments. */
  readonly parameters: readonly ListParameter[];
  /** The named parameters: `get`'s `default:`, which it needs. */
  readonly named?: readonly string[];
  readonly result: ListMethodResult;
  /**
   * What it does to its receiver in place: it `adds` elements, `removes` some or `clears` it, or only `reorders` its
   * elements, which only a list has. A change reaches every place that holds the receiver. The type core reads it too
   * (`methodCategory`).
   */
  readonly changes?: "adds" | "removes" | "clears" | "reorders";
  /** The draw it takes from the session generator (see `RandomDrawKind`), which a debug trace names. */
  readonly draws?: "shuffle";
  /** Whether it can make a list or set longer than the longest it is made from, so the length limit applies (`TSR088`). */
  readonly grows?: true;
  /**
   * How it may decide the element type of a list that no value decided yet, which the compiler checks again when the
   * script runs (the call's `typeCheck`): the `element` it adds, each element of the list it adds (`elements`), or the
   * `default:` it gives.
   */
  readonly decides?: "element" | "elements" | "default";
  /**
   * Whether a range has a method of this name too, so that a call of it may be the range's; the methods of text, dicts,
   * and handles are in `TEXT_METHODS`, `DICT_METHODS`, and `HANDLE_MEMBERS`.
   */
  readonly shared?: true;
  /** What the call does, for the editor's help. */
  readonly summary: string;
}

const value = { name: "value", kind: "value" } as const;
const other = { name: "other", kind: "collection" } as const;
const count = { name: "count", kind: "count" } as const;
const index = { name: "index", kind: "index" } as const;
const BOTH = ["list", "set"] as const;
const LIST = ["list"] as const;

/** A table of contracts, each under its own name. */
function byName<
  const Table extends { readonly [Name in keyof Table]: ListMethod & { readonly name: Name } },
>(table: Table): Table {
  return table;
}

/** Each method of lists and sets by its name. */
export const LIST_METHODS = byName({
  add: {
    name: "add",
    receivers: BOTH,
    parameters: [value],
    result: "null",
    changes: "adds",
    grows: true,
    decides: "element",
    summary:
      "Adds a copy of value at the end of a list, or to a set unless an equal (==) member is already in it, and gives null.",
  },
  addAll: {
    name: "addAll",
    receivers: LIST,
    parameters: [{ name: "other", kind: "list" }],
    result: "null",
    changes: "adds",
    grows: true,
    decides: "elements",
    summary:
      "Adds a copy of each element of the list other at the end of the list, as add does, and gives null. To add the members of a set, copy it into a list with toList() first.",
  },
  remove: {
    name: "remove",
    receivers: BOTH,
    parameters: [value],
    result: "null",
    changes: "removes",
    summary:
      "Removes the first element equal (==) to value from a list, or the equal member from a set, and gives null. Without one, a list stays unchanged and the developer log has a warning, and a set stays unchanged.",
  },
  removeAt: {
    name: "removeAt",
    receivers: LIST,
    parameters: [index],
    result: "element",
    changes: "removes",
    summary:
      "Removes the element at a zero-based index and gives it; the elements after it move forward. An index the list does not have is an error, as for list[index].",
  },
  removeFirst: {
    name: "removeFirst",
    receivers: LIST,
    parameters: [],
    result: "element",
    changes: "removes",
    summary: "Removes the first element of the list and gives it. An empty list is an error.",
  },
  removeLast: {
    name: "removeLast",
    receivers: LIST,
    parameters: [],
    result: "element",
    changes: "removes",
    summary: "Removes the last element of the list and gives it. An empty list is an error.",
  },
  clear: {
    name: "clear",
    receivers: BOTH,
    parameters: [],
    result: "null",
    changes: "clears",
    summary: "Removes every element of a list or member of a set, and gives null.",
  },
  sort: {
    name: "sort",
    receivers: LIST,
    notOnSet: setKeepsOrder("sort"),
    parameters: [],
    result: "null",
    changes: "reorders",
    summary:
      'Orders the list in place, ascending and stable, and gives null. The elements are all numbers, all text, which is ordered by Unicode code point so "B" comes before "a", all durations, all calendar durations of one family, all angles, or all date and time values of one kind.',
  },
  shuffle: {
    name: "shuffle",
    receivers: LIST,
    notOnSet: setKeepsOrder("shuffle"),
    parameters: [],
    result: "null",
    changes: "reorders",
    draws: "shuffle",
    summary:
      "Puts the list in a uniformly random order in place with the session's random numbers, and gives null. A list of fewer than two elements draws nothing.",
  },
  reverse: {
    name: "reverse",
    receivers: LIST,
    notOnSet: setKeepsOrder("reverse"),
    parameters: [],
    result: "null",
    changes: "reorders",
    summary: "Puts the list's elements in reverse order in place, and gives null.",
  },
  contains: {
    name: "contains",
    receivers: BOTH,
    parameters: [value],
    result: "boolean",
    summary:
      "Gives true when an element of the list, or a member of the set, is equal (==) to value.",
  },
  indexOf: {
    name: "indexOf",
    receivers: LIST,
    notOnSet: setHasNoPositions("indexOf"),
    parameters: [value],
    result: "integer?",
    summary:
      "Gives the index of the first element equal (==) to value, or null when no element is. Check the index before it is used as a number.",
  },
  lastIndexOf: {
    name: "lastIndexOf",
    receivers: LIST,
    notOnSet: setHasNoPositions("lastIndexOf"),
    parameters: [value],
    result: "integer?",
    summary:
      "Gives the index of the last element equal (==) to value, or null when no element is. Check the index before it is used as a number.",
  },
  count: {
    name: "count",
    receivers: LIST,
    notOnSet: "A set holds each member once, so it has no count(). Use contains(...) instead.",
    parameters: [value],
    result: "integer",
    summary: "Gives how many elements are equal (==) to value, 0 when none are.",
  },
  get: {
    name: "get",
    receivers: LIST,
    notOnSet: "A set has no positions, so it has no 'get()'. Use 'contains(...)' instead.",
    parameters: [index],
    named: ["default"],
    result: "element",
    decides: "default",
    summary:
      "Gives the element at index, or the default when the list has no such position: an index that is negative, past the end, or not a whole number. The default may be of any type, and is evaluated only when it is used.",
  },
  join: {
    name: "join",
    receivers: LIST,
    parameters: [{ name: "separator", kind: "text", optional: true }],
    result: "string",
    summary:
      'Gives the elements as text, separated by the text separator, ", " without one: ["pet", "puppy"].join() is "pet, puppy". The elements are values that ${...} shows on their own, shown as it shows them.',
  },
  intersection: {
    name: "intersection",
    receivers: BOTH,
    parameters: [other],
    result: "same",
    summary:
      "Gives a new list or set, of the receiver's kind, of its elements that are also in other, a list or a set: each once, in the receiver's order.",
  },
  union: {
    name: "union",
    receivers: BOTH,
    parameters: [other],
    result: "same",
    grows: true,
    summary:
      "Gives a new list or set, of the receiver's kind, of its elements followed by the new elements of other, a list or a set, in its order: each once.",
  },
  difference: {
    name: "difference",
    receivers: BOTH,
    parameters: [other],
    result: "same",
    summary:
      "Gives a new list or set, of the receiver's kind, of its elements that are not in other, a list or a set: each once, in the receiver's order.",
  },
  take: {
    name: "take",
    receivers: LIST,
    notOnSet: setHasNo("take"),
    parameters: [count],
    result: "list",
    summary:
      "Gives a new list of the first count elements, in order; count is a whole number of at least 0, and one beyond the length gives the whole list.",
  },
  takeLast: {
    name: "takeLast",
    receivers: LIST,
    notOnSet: setHasNo("takeLast"),
    parameters: [count],
    result: "list",
    summary:
      "Gives a new list of the last count elements, in order; count is a whole number of at least 0, and one beyond the length gives the whole list.",
  },
  toSet: {
    name: "toSet",
    receivers: LIST,
    parameters: [],
    result: "set",
    summary:
      "Gives a new set of the list's elements: each once, the first of equal (==) ones, in order.",
  },
  toList: {
    name: "toList",
    shared: true,
    receivers: ["set"],
    parameters: [],
    result: "list",
    summary: "Gives a new list of the set's members, in insertion order.",
  },
});

export type ListMethodName = keyof typeof LIST_METHODS;

export function isListMethod(name: string): name is ListMethodName {
  return Object.hasOwn(LIST_METHODS, name);
}

/** The methods that a list, or a set, has. */
export type MethodOf<Kind extends ListKind> = {
  [Name in ListMethodName]: Kind extends (typeof LIST_METHODS)[Name]["receivers"][number]
    ? Name
    : never;
}[ListMethodName];

/** Whether a list or set of `kind` has the method `name`. */
export function hasListMethod<Kind extends ListKind>(
  kind: Kind,
  name: string,
): name is MethodOf<Kind> {
  return listMethod(name)?.receivers.includes(kind) === true;
}

/** The contract of a method of lists and sets called `name`, or `undefined`. */
export function listMethod(name: string): ListMethod | undefined {
  return isListMethod(name) ? LIST_METHODS[name] : undefined;
}

/**
 * Whether a call of `name` changes the elements of the list or set it is called on: adds, removes, or clears them, not
 * only their order (see `ListMethod.changes`).
 */
export function changesElements(name: string): boolean {
  const changes = listMethod(name)?.changes;
  return changes !== undefined && changes !== "reorders";
}

/** Whether a call of `name` reorders the list it is called on (see `ListMethod.changes`). */
export function reordersList(name: string): boolean {
  return listMethod(name)?.changes === "reorders";
}

/**
 * Whether a call of `name` on a list or set only reads it and copies of its arguments: it changes nothing in place and
 * draws nothing.
 */
export function onlyReadsList(name: string): boolean {
  const method = listMethod(name);
  return method !== undefined && method.changes === undefined && method.draws === undefined;
}

function setKeepsOrder(name: string): string {
  return `A set keeps its insertion order, so it has no ${name}(). Copy it into a list with toList() first.`;
}

function setHasNoPositions(name: string): string {
  return `A set has no positions, so it has no ${name}(). Copy it into a list with toList() first.`;
}

function setHasNo(name: string): string {
  return `A set has no ${name}(). Copy it into a list with toList() first.`;
}

/** What `sort()` orders, as the runtime's check and the analysis state it. */
export const SORT_RULE = "sort() sorts numbers, text, durations, angles, or date and time values";

/** Why a list or set of `kind` has no method `name`, from the compiler and the runtime (`TSR016`). */
export function missingListMethodMessage(kind: ListKind, name: string): string {
  const method = listMethod(name);
  if (kind === "set" && method?.notOnSet !== undefined) return method.notOnSet;
  return `${kind === "list" ? "Lists" : "Sets"} have no method '${name}'.`;
}

/**
 * Why `name` cannot take `count`, a number, as the elements to take, or `undefined` when it can: a compile error when the
 * compiler can see it, and otherwise the same error (`TSV043`) at runtime.
 */
export function countProblem(name: string, count: number): string | undefined {
  return Number.isInteger(count) && count >= 0
    ? undefined
    : `${name}() needs a whole number of at least 0, not ${count}.`;
}

/**
 * Why an argument of the method `name` does not fit its parameter of `kind`, for a value described as `given`, which is
 * a `set`, a `range`, or another value: from the compiler and the runtime (`TSV043`).
 */
export function listArgumentMessage(
  name: string,
  kind: "list" | "collection" | "count",
  given: string,
  other: "set" | "range" | "other",
): string {
  if (kind === "count") return `${name}() needs a whole number (integer), not ${given}.`;
  const fix =
    other === "range"
      ? RANGE_LIST_FIX
      : other === "set" && kind === "list"
        ? " Copy a set into a list with toList() first."
        : "";
  return `${name}() needs ${kind === "list" ? "a list" : "a list or a set"}, not ${given}.${fix}`;
}

/** The fix for a range where a list is needed, as for a set (V30 §6). */
export const RANGE_LIST_FIX = " Make a list of its numbers with toList() first.";

/**
 * The call as the editor's help writes it, such as `list.take(count)`, `list.join([separator])`, or
 * `list.add(value)  or  set.add(value)`.
 */
export function listMethodSyntax(name: ListMethodName): string {
  const method: ListMethod = LIST_METHODS[name];
  const required = [
    ...method.parameters.filter((parameter) => !parameter.optional).map(({ name }) => name),
    ...(method.named ?? []).map((parameter) => `${parameter}: value`),
  ];
  const optional = method.parameters.filter((parameter) => parameter.optional);
  const call = `${name}(${required.join(", ")}${optional.map((parameter, index) => (required.length === 0 && index === 0 ? `[${parameter.name}]` : ` [, ${parameter.name}]`)).join("")})`;
  return method.receivers.map((kind) => `${kind}.${call}`).join("  or  ");
}

/**
 * A property of lists and sets (V30 §16): what it gives, and its help. An `element` is the list's own, so a change
 * through it reaches the list, and a copy of a set's member, so a change through it does not reach the set (ADR 0014).
 */
export type ListProperty = {
  readonly name: string;
  /** What it gives, for the editor's help. */
  readonly summary: string;
} & (
  | { readonly gives: "length" }
  | {
      readonly gives: "element";
      /** The runtime error of reading it from an empty list or set. */
      readonly empty: "TSR018" | "TSR019";
      /** The draw it takes from the session generator (see `RandomDrawKind`), which a debug trace names. */
      readonly draws?: "collectionRandom";
    }
);

function propertiesByName<
  const Table extends { readonly [Name in keyof Table]: ListProperty & { readonly name: Name } },
>(table: Table): Table {
  return table;
}

/** Each property of lists and sets by its name. */
export const LIST_PROPERTIES = propertiesByName({
  length: {
    name: "length",
    gives: "length",
    summary: "The number of elements of a list, or members of a set.",
  },
  first: {
    name: "first",
    gives: "element",
    empty: "TSR018",
    summary:
      "The first element of a list, or a copy of the first member of a set. An empty list or set is an error.",
  },
  last: {
    name: "last",
    gives: "element",
    empty: "TSR018",
    summary:
      "The last element of a list, or a copy of the last member of a set. An empty list or set is an error.",
  },
  random: {
    name: "random",
    gives: "element",
    empty: "TSR019",
    draws: "collectionRandom",
    summary:
      "An element chosen with the session's random numbers: of a list, or a copy of a member of a set. An empty list or set is an error.",
  },
});

export type ListPropertyName = keyof typeof LIST_PROPERTIES;

/** The properties that read an element of a list or set. */
export type ElementProperty = {
  [Name in ListPropertyName]: (typeof LIST_PROPERTIES)[Name]["gives"] extends "element"
    ? Name
    : never;
}[ListPropertyName];

function isListProperty(name: string): name is ListPropertyName {
  return Object.hasOwn(LIST_PROPERTIES, name);
}

/** The draws of the methods and properties of lists and sets, which a debug trace names (see `RandomDrawKind`). */
export type ListDrawKind = NonNullable<
  ListMethod["draws"] | Extract<ListProperty, { readonly gives: "element" }>["draws"]
>;

/** The draw that a call of the method `name`, or a read of the property `name`, of a list or set takes, or `undefined`. */
export function listDraw(name: string, member: "method" | "property"): ListDrawKind | undefined {
  if (member === "method") return listMethod(name)?.draws;
  const property = listProperty(name);
  return property?.gives === "element" ? property.draws : undefined;
}

/** The contract of a property of lists and sets called `name`, or `undefined`. */
export function listProperty(name: string): ListProperty | undefined {
  return isListProperty(name) ? LIST_PROPERTIES[name] : undefined;
}

/** Why a list or set of `kind` has no property `name`, from the compiler and the runtime (`TSR017`). */
export function missingListPropertyMessage(kind: ListKind, name: string): string {
  const names = Object.keys(LIST_PROPERTIES);
  return `${kind === "list" ? "Lists" : "Sets"} have no property '${name}'. Use ${names.slice(0, -1).join(", ")}, or ${names.at(-1)}.`;
}

/**
 * The code and message of reading the property `name` from an empty list or set of `kind`, as the source spells it
 * (`label`, or `null`): `TSR018` for `first` and `last`, and `TSR019` for `random`.
 */
export function emptyListPropertyFailure(
  name: ElementProperty,
  kind: ListKind,
  label: string | null,
): { readonly code: "TSR018" | "TSR019"; readonly message: string } {
  return {
    code: LIST_PROPERTIES[name].empty,
    message:
      label === null
        ? `Cannot read '.${name}' from an empty ${kind}. Check its length first.`
        : `Cannot read '${label}.${name}': '${label}' is empty. Check '${label}.length' first.`,
  };
}
