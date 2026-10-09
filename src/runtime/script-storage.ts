import type { InstructionPlan, PlanSourceLocation, TypePlan } from "../plan/model.js";
import type { SourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { messageText } from "./text-length.js";
import { copySpan } from "./operations/support.js";
import {
  cloneCapturedSerializableValue,
  containsRuntimeIdentity,
  findRuntimeIdentity,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import { describeRuntimeValue, isMessageHandle } from "./value-predicates.js";
import { describeShownValue } from "./value-types.js";

/** One key of the session's view of script storage; the stored value is never `null`. */
export interface RuntimeScriptStorageEntrySnapshot {
  readonly key: string;
  value: SerializableRuntimeValue;
}

/** The runtime view of script storage that the engine reads and changes. */
interface ScriptStorageView {
  readonly scriptStorage: RuntimeScriptStorageEntrySnapshot[];
}

/** `value` as the key that `use` loads, saves, or deletes: `TSR054` unless it is text. */
export function storageKey(
  value: SerializableRuntimeValue,
  use: "load" | "save" | "delete",
  span: SourceSpan | PlanSourceLocation,
): string {
  if (typeof value === "string") return value;
  const fix =
    typeof value === "number"
      ? ` Use "${value}" as the key, or convert it with toString(...).`
      : use === "load" && typeof value === "boolean"
        ? ` If you meant to compare the loaded value, write 'load("k", default: null) == null'.`
        : " Use text as the key.";
  throw fault(
    "TSR054",
    `Cannot ${use} with key ${typeof value === "boolean" ? value : describeShownValue(value)}: storage keys must be text (string).${fix}`,
    span,
  );
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

/** The type a storage key's value has to fit (ADR 0021 §6), from the plan's key-ordered table, if the key has one. */
export function storageKeyType(plan: InstructionPlan, key: string): TypePlan | undefined {
  const types = plan.storageTypes;
  let low = 0;
  let high = types.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (types[middle]!.key < key) low = middle + 1;
    else high = middle;
  }
  return types[low]?.key === key ? types[low]!.type : undefined;
}

/** How a runtime type error names a storage key whose type a saved value or default does not fit. */
export function storageKeyPlace(key: string): string {
  return `storage key ${JSON.stringify(key)}`;
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
  const identity = findRuntimeIdentity(value);
  if (identity !== null) {
    const kind = describeRuntimeValue(identity);
    const fix = isMessageHandle(identity)
      ? " Save the message's text instead."
      : " Save values such as text, numbers, or lists instead.";
    throw fault(
      "TSR055",
      identity === value
        ? `save cannot store ${kind}: it exists only in the current session.${fix}`
        : `save cannot store this value: it holds ${kind}, which exists only in the current session.${fix}`,
      span,
    );
  }
}

/** The value tags of earlier Players and the tags they now have (ADR 0026). */
const RENAMED_VALUE_KINDS: ReadonlyMap<string, string> = new Map([
  ["timestamp", "absoluteDateTime"],
]);

/**
 * Upgrades, in place, saved values that an earlier Player wrote, before they are validated: a `timestamp` becomes an
 * `absoluteDateTime` with the same moment. Saved values outlive the plan and snapshot formats, so a value is read as
 * what it meant when it was saved and never dropped. `stored` is freshly read data, such as parsed JSON, which this
 * walks without recursion; anything else in it is left to validation.
 */
export function upgradeStoredScriptValues(stored: unknown): void {
  const pending: unknown[] = [stored];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next !== "object" || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
      continue;
    }
    // EVIDENCE: validation: the guards above proved a non-array object; only its own enumerable fields are read.
    const record = next as Record<string, unknown>;
    const renamed =
      typeof record.kind === "string" ? RENAMED_VALUE_KINDS.get(record.kind) : undefined;
    if (renamed !== undefined) record.kind = renamed;
    for (const field of Object.values(record)) pending.push(field);
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
    if (keys.has(key))
      return `${path} contains the key ${JSON.stringify(messageText(key))} more than once.`;
    if (sorted && previousKey !== null && !(previousKey < key))
      return `${path} must be sorted by key.`;
    keys.add(key);
    previousKey = key;
    const failure = validateCapturedSerializableValue(stored, `${entryPath}.value`);
    if (failure !== null) return failure;
    // EVIDENCE: validation: validateCapturedSerializableValue accepted this stored value above.
    const valid = stored as SerializableRuntimeValue;
    if (valid === null) return `${entryPath}.value must not be null. An absent key has no entry.`;
    if (containsRuntimeIdentity(valid)) {
      return `${entryPath}.value contains a timer, media, or message handle or a speaker reference.`;
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

function fault(code: string, message: string, span: SourceSpan | PlanSourceLocation): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
