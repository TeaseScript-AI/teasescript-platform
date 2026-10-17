/**
 * The operations of dicts (V30 §40): one contract each, shared by the compiler, the runtime, and the editor. Lists and
 * sets have methods of the same names, such as `contains`, in `LIST_METHODS`; each has its own.
 */

import {
  argumentShapeProblem,
  getArgumentsProblem,
  positionalShape,
  type ArgumentProblem,
} from "./argument-rules.js";

/**
 * What an operation does with a key the dict does not have: it `fails` with runtime error `TSR061`
 * (`missingKeyMessage`), a compile error where the dict is written in the source, gives `false`, gives its `default`, or
 * `adds` the key.
 */
export type MissingKey = "fails" | "false" | "default" | "adds";

/**
 * A method of dicts: how it is called, what it gives, what it does to the dict it is called on, and its help. Each
 * argument without a name is a key, which is text (`dictKeyMessage`). A method without `changes` only reads the dict
 * and copies of its arguments.
 */
export interface DictMethod {
  readonly name: string;
  /** The positional parameters, which also give the number of positional arguments. */
  readonly parameters: readonly { readonly name: "key" }[];
  /** The named parameters: `get`'s `default:`, which it needs. */
  readonly named?: readonly string[];
  /** What it gives: `null`, a `boolean`, or the key's `value`, a copy for the place that keeps it, or the default. */
  readonly result: "null" | "boolean" | "value";
  readonly missing?: Exclude<MissingKey, "adds">;
  /** Whether it removes entries in place. A change reaches every place that holds the dict. */
  readonly changes?: "entries";
  /**
   * How it may decide the value type of a dict that no value decided yet, which the compiler checks again when the
   * script runs (the call's `typeCheck`): the `default:` it gives.
   */
  readonly decides?: "default";
  /** What the call does, for the editor's help. */
  readonly summary: string;
}

const key = { name: "key" } as const;

/** A table of contracts, each under its own name. */
function byName<
  const Table extends { readonly [Name in keyof Table]: DictMethod & { readonly name: Name } },
>(table: Table): Table {
  return table;
}

/** Each method of dicts by its name. */
export const DICT_METHODS = byName({
  contains: {
    name: "contains",
    parameters: [key],
    result: "boolean",
    missing: "false",
    summary: "Gives true when the dict has the key, and false when it does not.",
  },
  remove: {
    name: "remove",
    parameters: [key],
    result: "value",
    missing: "fails",
    changes: "entries",
    summary:
      "Removes the key and gives its value; the entries after it move up. A key the dict does not have is an error.",
  },
  clear: {
    name: "clear",
    parameters: [],
    result: "null",
    changes: "entries",
    summary: "Removes every entry of the dict, and gives null.",
  },
  get: {
    name: "get",
    parameters: [key],
    named: ["default"],
    result: "value",
    missing: "default",
    decides: "default",
    summary:
      "Gives the value of key, or the default when the dict does not have the key. The default may be of any type, and is evaluated only when it is used.",
  },
});

export type DictMethodName = keyof typeof DICT_METHODS;

export function isDictMethod(name: string): name is DictMethodName {
  return Object.hasOwn(DICT_METHODS, name);
}

/** The contract of a method of dicts called `name`, or `undefined`. */
export function dictMethod(name: string): DictMethod | undefined {
  return isDictMethod(name) ? DICT_METHODS[name] : undefined;
}

/** Whether a call of `name` changes the entries of the dict it is called on (see `DictMethod.changes`). */
export function changesEntries(name: string): boolean {
  return dictMethod(name)?.changes !== undefined;
}

/** The methods of dicts that only read the dict and copies of their arguments (see `DictMethod.changes`). */
export type ReadingDictMethod = {
  [Name in DictMethodName]: (typeof DICT_METHODS)[Name] extends { readonly changes: string }
    ? never
    : Name;
}[DictMethodName];

/** Whether a call of `name` on a dict only reads it and copies of its arguments (see `DictMethod.changes`). */
export function onlyReadsDict(name: string): name is ReadingDictMethod {
  const method = dictMethod(name);
  return method !== undefined && method.changes === undefined;
}

/**
 * The first problem with the names and the number of the arguments of a call of `method`, from the compiler and the
 * runtime (`TSR028`): `received` arguments without a name, and `named`, the names of the others.
 */
export function dictArgumentsProblem(
  method: DictMethod,
  received: number,
  named: readonly string[],
): ArgumentProblem | undefined {
  if (method.named !== undefined) return getArgumentsProblem("dict", received, named);
  return argumentShapeProblem(
    method.name,
    positionalShape(method.parameters.map((parameter) => parameter.name)),
    received,
    named,
  );
}

/** Why a dict has no method `name`, from the compiler and the runtime (`TSR016`). */
export function missingDictMethodMessage(name: string): string {
  if (name === "add")
    return "Dicts have no method 'add'. Store a value by its key, as in dict[key] = value.";
  return `Dicts have no method '${name}'. Use ${listed(Object.keys(DICT_METHODS))}.`;
}

/**
 * A property of dicts: what it gives, and its help. `keys` and `values` give a new list at each read, so a change of it
 * changes a copy that no variable holds (#941): `instead` says where to make it, on the dict as the source spells it.
 */
export type DictProperty = {
  readonly name: string;
  /** What it gives, for the editor's help. */
  readonly summary: string;
} & (
  | { readonly gives: "length" }
  | {
      /** A new list of the keys, or of copies of the values, in entry order. */
      readonly gives: "keys" | "values";
      readonly instead: (receiver: string) => string;
    }
);

function propertiesByName<
  const Table extends { readonly [Name in keyof Table]: DictProperty & { readonly name: Name } },
>(table: Table): Table {
  return table;
}

/** Each property of dicts by its name. */
export const DICT_PROPERTIES = propertiesByName({
  length: { name: "length", gives: "length", summary: "The number of entries of the dict." },
  keys: {
    name: "keys",
    gives: "keys",
    instead: (receiver) =>
      `Change the dict itself, as in '${receiver}[key] = value' or '${receiver}.remove(key)'.`,
    summary: "A new list of the keys of the dict, in entry order.",
  },
  values: {
    name: "values",
    gives: "values",
    instead: (receiver) => `Change the dict through its keys, as in '${receiver}[key]'.`,
    summary: "A new list of copies of the values of the dict, in the order of its keys.",
  },
});

export type DictPropertyName = keyof typeof DICT_PROPERTIES;

export function isDictProperty(name: string): name is DictPropertyName {
  return Object.hasOwn(DICT_PROPERTIES, name);
}

/** The contract of a property of dicts called `name`, or `undefined`. */
export function dictProperty(name: string): DictProperty | undefined {
  return isDictProperty(name) ? DICT_PROPERTIES[name] : undefined;
}

/** Whether a read of the property `name` of a dict gives a new list each time (see `DictProperty`). */
export function givesNewDictList(name: string): boolean {
  const gives = dictProperty(name)?.gives;
  return gives === "keys" || gives === "values";
}

/** Why a dict has no property `name`, from the compiler and the runtime (`TSR017`); `label` spells the dict, or `null`. */
export function missingDictPropertyMessage(name: string, label: string | null): string {
  return `Dicts have no property '${name}'. Use ${listed(Object.keys(DICT_PROPERTIES))}. To read a value by its key, write '${label ?? "dict"}[${JSON.stringify(name)}]'.`;
}

/**
 * Reading, storing, and going through the entries of a dict, which have no name of their own: how the source writes
 * each, what it does with a key the dict does not have, whether it changes the dict in place, and its help.
 */
export interface DictAccess {
  readonly syntax: string;
  readonly missing?: MissingKey;
  /** Whether it changes the entries in place. */
  readonly changes?: "entries";
  /** How runtime error `TSR088` names it, where it can make the dict hold more keys than a dict can. */
  readonly grows?: string;
  readonly summary: string;
}

/** `dict[key]`, `dict[key] = value`, and the two `for` loops over a dict. */
export const DICT_ACCESS = {
  read: {
    syntax: "dict[key]",
    missing: "fails",
    summary:
      "Gives the value of key, the dict's own, so a change through it reaches the dict. A key the dict does not have is an error.",
  },
  store: {
    syntax: "dict[key] = value",
    missing: "adds",
    changes: "entries",
    grows: "assigning to a new key",
    summary:
      "Stores a copy of value under key: in the key's position where the dict has it, and otherwise as a new entry at the end.",
  },
  keys: {
    syntax: "for key in dict",
    summary:
      "Goes through the keys of the dict, in entry order, as they were when the loop started.",
  },
  entries: {
    syntax: "for key, value in dict",
    summary:
      "Goes through the keys of the dict with a copy of each value, in entry order, as they were when the loop started.",
  },
} as const satisfies Readonly<Record<string, DictAccess>>;

/**
 * Why `given`, a value described so, cannot be a dict key, from the compiler and the runtime (`TSR062`): a key is text.
 * A `number` key names the fix with the key as the source spells it (`label`), or as `id`.
 */
export function dictKeyMessage(given: string, number: boolean, label: string | null): string {
  return `A dict key is text (string), but this is ${given}.${number ? ` Write a number key as text, as in "\${${label ?? "id"}}".` : ""}`;
}

/**
 * Why a dict has no key `shown`, quoted as a message quotes text from the script, from the compiler and the runtime
 * (`TSR061`), with the check that avoids it, such as `Check toys.contains(name) first.`: `owner` and `keyLabel` spell
 * the dict and the key as the source does, or are `null`, and the key is then named by its text.
 */
export function missingKeyMessage(
  shown: string,
  owner: string | null,
  keyLabel: string | null,
): string {
  const check = `contains(${keyLabel ?? shown})`;
  return `Dictionary has no key ${shown}. Check ${owner === null ? `it with ${check}` : `${owner}.${check}`} first.`;
}

/** `a, b, or c`. */
function listed(names: readonly string[]): string {
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}
