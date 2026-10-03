import type { PlanSourceLocation, StorageTypePlan, ValueTypePlan } from "../plan/model.js";
import type { SourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import {
  cloneCapturedSerializableValue,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./serializable-values.js";

/** One key of the session's view of script storage; the stored value is never `null`. */
export interface RuntimeScriptStorageEntrySnapshot {
  readonly key: string;
  value: SerializableRuntimeValue;
}

/** The runtime view of script storage that the engine reads and changes. */
interface ScriptStorageView {
  readonly scriptStorage: RuntimeScriptStorageEntrySnapshot[];
}

export const LOAD_KEY_MESSAGE =
  "Storage key must be a string. To compare the loaded value, write '(load \"k\") == null'.";
export const WRITE_KEY_MESSAGE = "Storage key must be a string.";

export function storageKey(
  value: SerializableRuntimeValue,
  message: string,
  span: SourceSpan | PlanSourceLocation,
): string {
  if (typeof value !== "string") throw fault("TSR054", message, span);
  return value;
}

/**
 * The entry for a key. The view is kept sorted by key in UTF-16 code-unit order, so lookups and writes do not scan
 * every entry and the representation does not depend on the order of earlier writes.
 */
export function findScriptStorageEntry(
  view: ScriptStorageView,
  key: string,
): RuntimeScriptStorageEntrySnapshot | undefined {
  const position = entryPosition(view.scriptStorage, key);
  return view.scriptStorage[position]?.key === key ? view.scriptStorage[position] : undefined;
}

/** Stores a copy of a persistable value, or removes the key when the value is `null`. */
export function writeScriptStorage(
  view: ScriptStorageView,
  key: string,
  value: SerializableRuntimeValue,
): void {
  const entries = view.scriptStorage;
  const position = entryPosition(entries, key);
  const present = entries[position]?.key === key;
  if (value === null) {
    if (present) entries.splice(position, 1);
    return;
  }
  const stored = cloneCapturedSerializableValue(value);
  if (present) entries[position]!.value = stored;
  else entries.splice(position, 0, { key, value: stored });
}

/** Host-supplied entries in the view's key order; the entries were validated to have unique keys. */
export function sortScriptStorage(
  entries: readonly RuntimeScriptStorageEntrySnapshot[],
): RuntimeScriptStorageEntrySnapshot[] {
  return [...entries].sort((left, right) => (left.key < right.key ? -1 : 1));
}

/** The first position whose key is not below `key`. */
function entryPosition(entries: readonly RuntimeScriptStorageEntrySnapshot[], key: string): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]!.key < key) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function assertPersistable(
  value: SerializableRuntimeValue,
  span: SourceSpan | PlanSourceLocation,
): void {
  if (!isPersistable(value)) {
    throw fault(
      "TSR055",
      "save cannot store a timer handle, media handle, or speaker reference; they exist only in the current session.",
      span,
    );
  }
}

/** Rejects a stored value that does not match the declared type of a direct `let x: T = load ...`. */
export function assertStoredType(
  entry: RuntimeScriptStorageEntrySnapshot,
  type: StorageTypePlan,
  span: SourceSpan | PlanSourceLocation,
): void {
  const value = entry.value;
  const matches =
    type.collection === null
      ? matchesScalarType(value, type.name)
      : typeof value === "object" &&
        value !== null &&
        value.kind === type.collection &&
        value.items.every((item) => matchesScalarType(item, type.name));
  if (!matches) {
    const suffix = type.collection === "list" ? "[]" : type.collection === "set" ? " set" : "";
    throw fault(
      "TSR056",
      `Stored value for ${JSON.stringify(entry.key)} does not match the declared type ${type.name}${suffix}.`,
      span,
    );
  }
}

/**
 * Validates host-supplied or restored script storage: an array of `{ key, value }` entries with unique string keys
 * and persistable, non-null values. A runtime view (`sorted`) must also be in key order. Returns the first failure
 * message, or `null`.
 */
export function validateScriptStorageEntries(
  value: unknown,
  path: string,
  sorted = false,
): string | null {
  if (!Array.isArray(value)) return `${path} must be an array of { key, value } entries.`;
  const keys = new Set<string>();
  let previousKey: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const entryPath = `${path}[${index}]`;
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "key") ||
      !Object.hasOwn(entry, "value")
    ) {
      return `${entryPath} must be an object with exactly the fields key and value.`;
    }
    // EVIDENCE: validation: the guard above proved a plain object with exactly own key and value fields.
    const { key, value: stored } = entry as { key: unknown; value: unknown };
    if (typeof key !== "string") return `${entryPath}.key must be a string.`;
    if (keys.has(key)) return `${path} contains the key ${JSON.stringify(key)} more than once.`;
    if (sorted && previousKey !== null && !(previousKey < key))
      return `${path} must be sorted by key.`;
    keys.add(key);
    previousKey = key;
    const failure = validateCapturedSerializableValue(stored, `${entryPath}.value`);
    if (failure !== null) return failure;
    // EVIDENCE: validation: validateCapturedSerializableValue accepted this stored value above.
    const valid = stored as SerializableRuntimeValue;
    if (valid === null) return `${entryPath}.value must not be null; an absent key has no entry.`;
    if (!isPersistable(valid)) {
      return `${entryPath}.value contains a timer handle, media handle, or speaker reference.`;
    }
  }
  return null;
}

export function cloneScriptStorage(
  entries: readonly RuntimeScriptStorageEntrySnapshot[],
): RuntimeScriptStorageEntrySnapshot[] {
  return entries.map((entry) => ({
    key: entry.key,
    value: cloneCapturedSerializableValue(entry.value),
  }));
}

/** Whether a value fits a variable's type (V30 §12); a list or set must contain only matching elements. */
export function matchesValueType(value: SerializableRuntimeValue, type: ValueTypePlan): boolean {
  if (value === null) return type.optional;
  if (type.collection === null) return matchesScalarType(value, type.name);
  return (
    typeof value === "object" &&
    value.kind === type.collection &&
    value.items.every((item) => matchesScalarType(item, type.name))
  );
}

/** The author-facing name of a checked variable type, as in an annotation. */
export function valueTypeName(type: ValueTypePlan): string {
  const collection =
    type.collection === "list"
      ? `${type.name}[]`
      : type.collection === "set"
        ? `${type.name} set`
        : type.name;
  return type.optional ? `${collection}?` : collection;
}

/** A plain-language description of a runtime value's kind, matching the compiler's wording. */
export function describeRuntimeValue(value: SerializableRuntimeValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return "text (string)";
  if (typeof value === "boolean") return "true or false (boolean)";
  if (typeof value === "number")
    return Number.isInteger(value)
      ? "a whole number (integer)"
      : "a number with a fraction (number)";
  switch (value.kind) {
    case "object":
      return "an object";
    case "timerHandle":
      return "a timer handle";
    case "mediaHandle":
      return "a media handle";
    case "speakerReference":
      return "a speaker";
    default:
      return `a ${value.kind}`;
  }
}

function matchesScalarType(
  value: SerializableRuntimeValue,
  name: StorageTypePlan["name"],
): boolean {
  switch (name) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "duration":
      return typeof value === "object" && value !== null && value.kind === "duration";
    case "date":
    case "time":
    case "datetime":
      // These types have no runtime representation yet, so no stored value can match them.
      return false;
  }
}

/** Plain data without session-only values; lists and objects are checked iteratively at every depth. */
function isPersistable(value: SerializableRuntimeValue): boolean {
  const work: SerializableRuntimeValue[] = [value];
  while (work.length > 0) {
    const current = work.pop()!;
    if (typeof current !== "object" || current === null) continue;
    switch (current.kind) {
      case "timerHandle":
      case "mediaHandle":
      case "speakerReference":
        return false;
      case "list":
        for (const item of current.items) work.push(item);
        break;
      case "object":
        for (const property of current.properties) work.push(property.value);
        break;
      case "set":
      case "range":
      case "duration":
        break;
    }
  }
  return true;
}

function fault(code: string, message: string, span: SourceSpan | PlanSourceLocation): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
