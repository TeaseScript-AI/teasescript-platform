import type { PlanSourceLocation, StorageTypePlan } from "../plan/model.js";
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
 * Key positions in the session's storage view for one runtime operation, so reads and writes do not scan every
 * entry. The view stays a plain entry array in snapshots; the index is rebuilt when that array is replaced, such as
 * after a staged `say` commits its cloned state.
 */
export class ScriptStorageIndex {
  #entries: RuntimeScriptStorageEntrySnapshot[] | null = null;
  readonly #positions = new Map<string, number>();

  public find(view: ScriptStorageView, key: string): RuntimeScriptStorageEntrySnapshot | undefined {
    const position = this.#positionsFor(view.scriptStorage).get(key);
    return position === undefined ? undefined : view.scriptStorage[position];
  }

  /** Stores a copy of a persistable value, or removes the key when the value is `null`. */
  public write(view: ScriptStorageView, key: string, value: SerializableRuntimeValue): void {
    const entries = view.scriptStorage;
    const positions = this.#positionsFor(entries);
    const position = positions.get(key);
    if (value === null) {
      if (position === undefined) return;
      // Move the last entry into the removed slot; entry order carries no meaning.
      const last = entries.pop()!;
      positions.delete(key);
      if (position < entries.length) {
        entries[position] = last;
        positions.set(last.key, position);
      }
      return;
    }
    const stored = cloneCapturedSerializableValue(value);
    if (position !== undefined) entries[position]!.value = stored;
    else {
      positions.set(key, entries.length);
      entries.push({ key, value: stored });
    }
  }

  #positionsFor(entries: RuntimeScriptStorageEntrySnapshot[]): Map<string, number> {
    if (this.#entries !== entries) {
      this.#entries = entries;
      this.#positions.clear();
      for (const [position, entry] of entries.entries()) this.#positions.set(entry.key, position);
    }
    return this.#positions;
  }
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
 * and persistable, non-null values. Returns the first failure message, or `null`.
 */
export function validateScriptStorageEntries(value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path} must be an array of { key, value } entries.`;
  const keys = new Set<string>();
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
    keys.add(key);
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
