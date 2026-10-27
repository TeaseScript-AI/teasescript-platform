import { isStoredAngleRecord, type StoredAngle } from "../../angle.js";
import { isDictProperty } from "../../dict-operations.js";
import {
  isStoredCalendarDurationRecord,
  isStoredDurationRecord,
  type StoredCalendarDuration,
  type StoredDuration,
} from "../../duration.js";
import { captureExternalData, type ExternalDataFailure } from "../../external-data-capture.js";
import { compileRegex, isCanonicalRegexFlags } from "../../regex.js";
import { hasIdentity, VALUE_KIND_NAMES, VALUE_KINDS, valueKindOf } from "../../value-kinds.js";
import {
  isValidDate,
  isValidEpochMilliseconds,
  isValidTime,
  type DateFields,
  type DateTimeFields,
  type TimeFields,
} from "../../temporal.js";
import { isPlainRecord } from "./plain-data.js";
import { recordValidationTestWork } from "../../validation-testing.js";

export type SerializableRuntimeScalar = string | number | boolean | null;

export interface SerializableRuntimeList {
  readonly kind: "list";
  readonly items: SerializableRuntimeValue[];
}

export interface SerializableRuntimeObject {
  readonly kind: "object";
  readonly properties: SerializableRuntimeProperty[];
}

/** Unique members by `==`, in insertion order; a set may hold any value a list may hold. */
export interface SerializableRuntimeSet {
  readonly kind: "set";
  readonly items: SerializableRuntimeValue[];
}

/** A lookup table from text keys to values, in insertion order; a replaced entry keeps its position. */
export interface SerializableRuntimeDict {
  readonly kind: "dict";
  readonly entries: SerializableRuntimeDictEntry[];
}

export interface SerializableRuntimeDictEntry {
  readonly key: string;
  value: SerializableRuntimeValue;
}

export interface SerializableSpeakerReference {
  readonly kind: "speakerReference";
  readonly speakerId: number;
  readonly identifier: string;
}

export interface SerializableRuntimeRange {
  readonly kind: "range";
  readonly start: number;
  readonly end: number;
  readonly inclusive: boolean;
}

/** An exact duration in milliseconds (ADR 0026). */
export type SerializableRuntimeDuration = StoredDuration;

/** A calendar duration: whole calendar months and days, and an exact offset in milliseconds (ADR 0026). */
export type SerializableRuntimeCalendarDuration = StoredCalendarDuration;

/** An angle, as its size in degrees (V30 §13). */
export type SerializableRuntimeAngle = StoredAngle;

/** A local calendar date without a zone (V30 §35). */
export interface SerializableRuntimeDate extends DateFields {
  readonly kind: "date";
}

/** A local clock time without a zone. */
export interface SerializableRuntimeTime extends TimeFields {
  readonly kind: "time";
}

/** A local date and clock time without a zone; it follows the player's zone. */
export interface SerializableRuntimeDateTime extends DateTimeFields {
  readonly kind: "datetime";
}

/** A fixed moment, in whole milliseconds since 1970-01-01T00:00:00Z. */
export interface SerializableRuntimeAbsoluteDateTime {
  readonly kind: "absoluteDateTime";
  readonly epochMilliseconds: number;
}

export type SerializableRuntimeTemporal =
  | SerializableRuntimeDate
  | SerializableRuntimeTime
  | SerializableRuntimeDateTime
  | SerializableRuntimeAbsoluteDateTime;

/** An opaque script handle for one asynchronous timer record. */
export interface SerializableTimerHandle {
  readonly kind: "timerHandle";
  readonly timerId: number;
}

/** An opaque script handle for one audio or video playback record. */
export interface SerializableMediaHandle {
  readonly kind: "mediaHandle";
  readonly mediaId: number;
}

/** The opaque identifier of one permanent button, as `showPermanentButton` gives it. */
export interface SerializablePermanentButtonHandle {
  readonly kind: "permanentButtonHandle";
  readonly buttonId: number;
}

/**
 * An opaque script handle for one shown message, as a result-bearing `say` gives it: its ID is the sequence of that
 * `say` event. The message's current text is the snapshot's live record for it, which every copy of the handle reads.
 */
export interface SerializableMessageHandle {
  readonly kind: "messageHandle";
  readonly messageId: number;
}

/** An opaque script handle for the default camera's view, the snapshot's `cameraView`. */
export interface SerializableCameraViewHandle {
  readonly kind: "cameraView";
}

/**
 * A reference to a file of the project, which a transfer starts at its top, as `script(path)` makes it. It names the
 * file by path, so it keeps its meaning across sessions and plans; whether that file exists is checked where a transfer
 * uses it.
 */
export interface SerializableScriptReference {
  readonly kind: "script";
  readonly path: string;
}

/**
 * A regex (V30 §8): its RE2 pattern and its flags, any of `i`, `m`, and `s` in that order. It is immutable plain data,
 * valid within the regex limits; a search compiles it, and the compiled program is only a cache.
 */
export interface SerializableRegex {
  readonly kind: "regex";
  readonly source: string;
  readonly flags: string;
}

export interface SerializableRuntimeProperty {
  readonly name: string;
  value: SerializableRuntimeValue;
}

export type SerializableRuntimeValue =
  | SerializableRuntimeScalar
  | SerializableRuntimeList
  | SerializableRuntimeObject
  | SerializableRuntimeSet
  | SerializableRuntimeDict
  | SerializableRuntimeRange
  | SerializableRuntimeDuration
  | SerializableRuntimeCalendarDuration
  | SerializableRuntimeAngle
  | SerializableRuntimeTemporal
  | SerializableTimerHandle
  | SerializableMediaHandle
  | SerializablePermanentButtonHandle
  | SerializableMessageHandle
  | SerializableCameraViewHandle
  | SerializableSpeakerReference
  | SerializableScriptReference
  | SerializableRegex;

export class SerializableValueError extends Error {
  public constructor(
    readonly code: "cyclic" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "SerializableValueError";
  }
}

export function createSerializableList(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeList {
  // EVIDENCE: validation: cloneSerializableValue captures and validates the list and preserves its kind.
  return cloneSerializableValue({
    kind: "list",
    // EVIDENCE: validation: the readonly input is only read during capture; the result has independent mutable items.
    items: items as SerializableRuntimeValue[],
  }) as SerializableRuntimeList;
}

/** Creates an independent list from engine-owned, already validated values. */
export function createCapturedSerializableList(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeList {
  return { kind: "list", items: items.map((item) => cloneCapturedSerializableValue(item)) };
}

export function createSerializableObject(
  properties: readonly SerializableRuntimeProperty[],
): SerializableRuntimeObject {
  // EVIDENCE: validation: cloneSerializableValue captures and validates the object and preserves its kind.
  return cloneSerializableValue({
    kind: "object",
    // EVIDENCE: validation: the readonly properties are only read during capture into an independent result.
    properties: properties as SerializableRuntimeProperty[],
  }) as SerializableRuntimeObject;
}

/** Creates an independent object from engine-owned, already validated values. */
export function createCapturedSerializableObject(
  properties: readonly SerializableRuntimeProperty[],
): SerializableRuntimeObject {
  return {
    kind: "object",
    properties: properties.map((property) => ({
      name: property.name,
      value: cloneCapturedSerializableValue(property.value),
    })),
  };
}

export function createSerializableSet(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeSet {
  const capture = captureExternalData(items, "$.items");
  if (!capture.ok) throw serializableCaptureError(capture.failure);
  if (!Array.isArray(capture.value)) {
    throw new SerializableValueError("invalid", "Serializable set items must be an array.");
  }

  const failure = validateSerializableValueInternal({ kind: "list", items: capture.value }, "$");
  if (failure !== null) throw new SerializableValueError("invalid", failure);
  // EVIDENCE: validation: the captured items were just validated as runtime values.
  const captured = capture.value as SerializableRuntimeValue[];
  // The capture made new items that nothing else holds, so the set takes them as they are.
  const set: SerializableRuntimeSet = { kind: "set", items: [] };
  for (const item of captured) addOwnedSerializableSetValue(set, item);
  return set;
}

/** Creates a set of copies of engine-owned, already validated values; the first of equal values is kept. */
export function createCapturedSerializableSet(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeSet {
  const set: SerializableRuntimeSet = { kind: "set", items: [] };
  for (const item of items) addSerializableSetValue(set, item);
  return set;
}

export function cloneSerializableValue(value: SerializableRuntimeValue): SerializableRuntimeValue {
  const captured = captureAndValidateSerializableValue(value);
  if (captured.failure !== null) {
    throw new SerializableValueError(
      captured.failure.includes("cyclic runtime value") ? "cyclic" : "invalid",
      captured.failure,
    );
  }
  return captured.value!;
}

/**
 * Clones already captured/validated engine data without a second validation pass. Validated data holds only finite
 * numbers, text, truth values, and `null` as primitives, so a primitive is a scalar and is its own copy.
 */
export function cloneCapturedSerializableValue(
  value: SerializableRuntimeValue,
): SerializableRuntimeValue {
  if (typeof value !== "object" || value === null) return value;
  const root = cloneSerializableNode(value);
  if (!isComposite(value)) return root;

  const work: Array<readonly [CompositeValue, CompositeValue]> = [
    [
      value,
      // EVIDENCE: validation: the non-scalar root clone preserves the composite kind of the source.
      root as CompositeValue,
    ],
  ];
  // Each nested record is cloned into its slot; a nested composite is queued to fill its own slots.
  const cloneInto = (nested: SerializableRuntimeRecord): SerializableRuntimeValue => {
    const cloned = cloneSerializableNode(nested);
    if (isComposite(nested)) {
      // EVIDENCE: validation: cloneSerializableNode preserves the composite kind checked on nested.
      work.push([nested, cloned as CompositeValue]);
    }
    return cloned;
  };
  let copiedItems = 0;
  while (work.length > 0) {
    const [source, target] = work.pop()!;
    if (source.kind === "list" || source.kind === "set") {
      // The clone starts with the source's items, so only a record is replaced by its own copy.
      const items = source.items;
      copiedItems += items.length;
      // EVIDENCE: validation: work pairs each list or set source with its newly allocated clone of the same kind.
      const targetItems = (target as SerializableRuntimeList | SerializableRuntimeSet).items;
      // The length is read once: item arrays come in several V8 representations, so a load per round is megamorphic.
      for (let index = 0, length = items.length; index < length; index += 1) {
        const item = items[index]!;
        if (typeof item === "object" && item !== null) targetItems[index] = cloneInto(item);
      }
    } else if (source.kind === "dict") {
      // EVIDENCE: validation: work pairs each dict source with its newly allocated dict clone.
      const targetEntries = (target as SerializableRuntimeDict).entries;
      for (let index = 0; index < source.entries.length; index += 1) {
        const entry = source.entries[index]!;
        const entryValue = entry.value;
        targetEntries[index] = {
          key: entry.key,
          value:
            typeof entryValue === "object" && entryValue !== null
              ? cloneInto(entryValue)
              : entryValue,
        };
      }
    } else {
      // EVIDENCE: validation: the remaining composite source and its paired clone are objects.
      const targetProperties = (target as SerializableRuntimeObject).properties;
      for (let index = 0; index < source.properties.length; index += 1) {
        const property = source.properties[index]!;
        const propertyValue = property.value;
        targetProperties[index] = {
          name: property.name,
          value:
            typeof propertyValue === "object" && propertyValue !== null
              ? cloneInto(propertyValue)
              : propertyValue,
        };
      }
    }
  }
  if (copiedItems > 0) recordValidationTestWork("copiedListItems", copiedItems);
  return root;
}

/** A value that is not a scalar: a record with a `kind`. */
type SerializableRuntimeRecord = Exclude<SerializableRuntimeValue, SerializableRuntimeScalar>;

/** A value that holds other values of any kind, which a copy copies in turn. */
type CompositeValue =
  | SerializableRuntimeList
  | SerializableRuntimeSet
  | SerializableRuntimeObject
  | SerializableRuntimeDict;

/** The `kind` of each record that holds other values, whose `==` compares its parts (`VALUE_KINDS`). */
const COMPOSITE_RECORDS: ReadonlySet<string> = new Set(
  VALUE_KIND_NAMES.filter((kind) => VALUE_KINDS[kind].equality === "parts").map(
    (kind) => VALUE_KINDS[kind].stored,
  ),
);

function isComposite(value: SerializableRuntimeRecord): value is CompositeValue {
  return COMPOSITE_RECORDS.has(value.kind);
}

/**
 * Whether a value holds one with an identity (`hasIdentity`), a speaker reference or a handle: identities the runtime
 * allocates for the current session, which host data and stored values cannot carry. Lists, sets, objects, and dicts are
 * checked iteratively at every depth.
 */
export function containsRuntimeIdentity(value: SerializableRuntimeValue): boolean {
  return findRuntimeIdentity(value) !== null;
}

/**
 * The first value with an identity in `value`, a speaker reference or a handle, which exist only in the session: in
 * the order the value is written, as the compiler meets the parts of its type, so a message names the same one.
 */
export function findRuntimeIdentity(
  value: SerializableRuntimeValue,
): SerializableRuntimeValue | null {
  const work: SerializableRuntimeValue[] = [value];
  while (work.length > 0) {
    const current = work.pop()!;
    if (typeof current !== "object" || current === null) continue;
    if (hasIdentity(valueKindOf(current))) return current;
    // Pushed last first, so that the first part is taken next.
    switch (current.kind) {
      case "list":
      case "set":
        for (let index = current.items.length - 1; index >= 0; index -= 1)
          work.push(current.items[index]!);
        break;
      case "object":
        for (let index = current.properties.length - 1; index >= 0; index -= 1)
          work.push(current.properties[index]!.value);
        break;
      case "dict":
        for (let index = current.entries.length - 1; index >= 0; index -= 1)
          work.push(current.entries[index]!.value);
        break;
      default:
        break;
    }
  }
  return null;
}

/**
 * A copy of a record without copies of the values it holds: a list or set starts with the source's items, and an object
 * or dict with empty slots. The caller copies the records it holds into it.
 */
function cloneSerializableNode(value: SerializableRuntimeRecord): SerializableRuntimeValue {
  switch (value.kind) {
    case "set":
      return { kind: "set", items: value.items.slice() };
    case "list":
      return { kind: "list", items: value.items.slice() };
    case "object":
      return { kind: "object", properties: new Array(value.properties.length) };
    case "dict":
      return { kind: "dict", entries: new Array(value.entries.length) };
    default:
      // A record without parts holds only its own fields.
      return { ...value };
  }
}

export function getSerializableProperty(
  object: SerializableRuntimeObject,
  name: string,
): SerializableRuntimeValue | undefined {
  return object.properties.find((property) => property.name === name)?.value;
}

/** Stores an independent value that is already captured and validated by the engine. */
export function setCapturedSerializableProperty(
  object: SerializableRuntimeObject,
  name: string,
  value: SerializableRuntimeValue,
): void {
  const existing = object.properties.find((property) => property.name === name);
  const copied = cloneCapturedSerializableValue(value);
  if (existing === undefined) object.properties.push({ name, value: copied });
  else existing.value = copied;
}

/**
 * The entries of a dict by key, so that finding a key does not compare it with every entry, and a dict literal of n keys
 * is built in work in proportion to n instead of n². A dict builds its index at its first key operation, in work in
 * proportion to its entries, as making it took: a copy, a restored dict, or one from the host is a new dict. `clear()`
 * drops it. The entries change only through the functions below, which keep the index exact. They stay the dict's value,
 * which checkpoints keep, and nothing reads the order of an index.
 */
const dictIndexes = new WeakMap<
  SerializableRuntimeDict,
  Map<string, SerializableRuntimeDictEntry>
>();

function dictIndex(dict: SerializableRuntimeDict): Map<string, SerializableRuntimeDictEntry> {
  let index = dictIndexes.get(dict);
  if (index === undefined) {
    index = new Map();
    for (const entry of dict.entries) index.set(entry.key, entry);
    dictIndexes.set(dict, index);
  }
  return index;
}

/** The entry of a dict key, or `undefined` when the dict has no such key. */
export function getSerializableDictEntry(
  dict: SerializableRuntimeDict,
  key: string,
): SerializableRuntimeDictEntry | undefined {
  return dictIndex(dict).get(key);
}

/**
 * Stores an engine-owned value that no other value shares, as it is, under a key: a new key is added at the end, and a
 * replaced entry keeps its position.
 */
export function setOwnedSerializableDictValue(
  dict: SerializableRuntimeDict,
  key: string,
  value: SerializableRuntimeValue,
): void {
  const index = dictIndex(dict);
  const existing = index.get(key);
  if (existing !== undefined) {
    existing.value = value;
    return;
  }
  const entry = { key, value };
  dict.entries.push(entry);
  index.set(key, entry);
}

/**
 * Stores an independent copy of an engine-owned value under a key: a new key is added at the end, and a replaced entry
 * keeps its position.
 */
export function setCapturedSerializableDictValue(
  dict: SerializableRuntimeDict,
  key: string,
  value: SerializableRuntimeValue,
): void {
  setOwnedSerializableDictValue(dict, key, cloneCapturedSerializableValue(value));
}

/**
 * A property of a dict (see `DICT_PROPERTIES`): its `length`, or a new list of its `keys` or of copies of its `values` in
 * entry order, or `undefined` for a name no property has.
 */
export function dictProperty(
  dict: SerializableRuntimeDict,
  name: string,
): SerializableRuntimeValue | undefined {
  if (!isDictProperty(name)) return undefined;
  switch (name) {
    case "length":
      return dict.entries.length;
    case "keys":
      return { kind: "list", items: dict.entries.map((entry) => entry.key) };
    case "values":
      return createCapturedSerializableList(dict.entries.map((entry) => entry.value));
    default: {
      const unhandled: never = name;
      throw new Error(`Dict property '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** Removes a key and returns its entry, or `undefined` when the dict has no such key; later entries move up. */
export function removeSerializableDictEntry(
  dict: SerializableRuntimeDict,
  key: string,
): SerializableRuntimeDictEntry | undefined {
  const index = dictIndex(dict);
  const entry = index.get(key);
  if (entry === undefined) return undefined;
  index.delete(key);
  dict.entries.splice(dict.entries.indexOf(entry), 1);
  return entry;
}

/** Removes every entry. */
export function clearSerializableDict(dict: SerializableRuntimeDict): void {
  dict.entries.length = 0;
  dictIndexes.delete(dict);
}

/** The index a dict has built, if any, for tests that compare it with the entries. */
export function builtSerializableDictIndex(
  dict: SerializableRuntimeDict,
): ReadonlyMap<string, SerializableRuntimeDictEntry> | undefined {
  return dictIndexes.get(dict);
}

/**
 * The member keys of a set, aligned with its items, kept between operations so that adding or finding a member keys only
 * that member instead of comparing it with every other one; removing one still shifts the later keys and items. A set's
 * items change only through the functions below and by `clear()`, which empties them, so a count that no longer matches
 * means the keys must be built again; a copy of a set builds its own when first needed.
 */
interface SetMembership {
  readonly keys: string[];
  readonly members: Set<string>;
}

const setMemberships = new WeakMap<SerializableRuntimeSet, SetMembership>();

function membership(set: SerializableRuntimeSet): SetMembership {
  const known = setMemberships.get(set);
  if (known !== undefined && known.keys.length === set.items.length) return known;
  const keys = set.items.map(valueKey);
  const built = { keys, members: new Set(keys) };
  setMemberships.set(set, built);
  return built;
}

/** Adds a copy of an engine-owned value unless the set already has an equal (`==`) member; returns whether it did. */
export function addSerializableSetValue(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  return addMember(set, value, true);
}

/**
 * Adds an engine-owned value that no other value shares, as it is, unless the set already has an equal (`==`) member;
 * returns whether it did.
 */
export function addOwnedSerializableSetValue(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  return addMember(set, value, false);
}

function addMember(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
  copy: boolean,
): boolean {
  const known = membership(set);
  const key = valueKey(value);
  if (known.members.has(key)) return false;
  known.members.add(key);
  known.keys.push(key);
  set.items.push(copy ? cloneCapturedSerializableValue(value) : value);
  return true;
}

export function removeSerializableSetValue(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  const known = membership(set);
  const key = valueKey(value);
  if (!known.members.has(key)) return false;
  const index = known.keys.indexOf(key);
  known.members.delete(key);
  known.keys.splice(index, 1);
  set.items.splice(index, 1);
  return true;
}

export function serializableSetContains(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  return membership(set).members.has(valueKey(value));
}

/** Removes every member. */
export function clearSerializableSet(set: SerializableRuntimeSet): void {
  set.items.length = 0;
  setMemberships.delete(set);
}

/**
 * A text that is equal for two values exactly when they are equal (`==`): the same kind and value, where objects and
 * dicts compare regardless of property or entry order and sets regardless of member order, and handles and speakers by
 * identity. Every text is prefix-free, so the texts of the parts of a value join without ambiguity. Deep values are
 * keyed without native recursion.
 */
export function valueKey(value: SerializableRuntimeValue): string {
  const leaf = leafKey(value);
  if (leaf !== undefined) return leaf;
  interface KeyFrame {
    readonly open: string;
    readonly close: string;
    /** Before each part: an object's property name or a dict's key, as text. */
    readonly labels: readonly string[] | null;
    readonly parts: readonly SerializableRuntimeValue[];
    /** For a set, whose members have no order: the member keys are sorted. */
    readonly unordered: boolean;
    readonly keys: string[];
  }
  const frame = (composite: CompositeValue): KeyFrame => {
    switch (composite.kind) {
      case "list":
        return keyFrame("[", "]", null, composite.items, false);
      case "set":
        return keyFrame("(", ")", null, composite.items, true);
      case "object": {
        const sorted = [...composite.properties].sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
        return keyFrame(
          "{",
          "}",
          sorted.map((property) => textKey(property.name)),
          sorted.map((property) => property.value),
          false,
        );
      }
      case "dict": {
        const sorted = [...composite.entries].sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        );
        return keyFrame(
          "<",
          ">",
          sorted.map((entry) => textKey(entry.key)),
          sorted.map((entry) => entry.value),
          false,
        );
      }
    }
  };
  const keyFrame = (
    open: string,
    close: string,
    labels: readonly string[] | null,
    parts: readonly SerializableRuntimeValue[],
    unordered: boolean,
  ): KeyFrame => ({ open, close, labels, parts, unordered, keys: [] });
  // EVIDENCE: invariant: leafKey keys every value that is not a list, set, object, or dict.
  const stack: KeyFrame[] = [frame(value as CompositeValue)];
  let key = "";
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    if (top.keys.length < top.parts.length) {
      const part = top.parts[top.keys.length]!;
      const known = leafKey(part);
      if (known !== undefined) {
        top.keys.push(known);
        continue;
      }
      // EVIDENCE: invariant: leafKey keys every value that is not a list, set, object, or dict.
      stack.push(frame(part as CompositeValue));
      continue;
    }
    stack.pop();
    if (top.unordered) top.keys.sort();
    let text = top.open;
    for (let index = 0; index < top.keys.length; index += 1)
      text += (top.labels?.[index] ?? "") + top.keys[index]!;
    text += top.close;
    if (stack.length === 0) key = text;
    else stack.at(-1)!.keys.push(text);
  }
  return key;
}

/** The key of a value that holds no other values, or `undefined` for a list, set, object, or dict. */
function leafKey(value: SerializableRuntimeValue): string | undefined {
  if (value === null) return "z";
  if (typeof value === "string") return textKey(value);
  if (typeof value === "number") return `n${numberText(value)};`;
  if (typeof value === "boolean") return value ? "t" : "f";
  switch (value.kind) {
    case "duration":
      return `u${numberText(value.milliseconds)};`;
    case "calendarDuration":
      return `U${numberText(value.months)}:${numberText(value.days)}:${numberText(value.milliseconds)};`;
    case "angle":
      return `a${numberText(value.degrees)};`;
    case "date":
      return `d${value.year}-${value.month}-${value.day};`;
    case "time":
      return `c${value.hour}:${value.minute}:${value.second}.${value.millisecond};`;
    case "datetime":
      return `D${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}.${value.millisecond};`;
    case "absoluteDateTime":
      return `T${value.epochMilliseconds};`;
    case "range":
      return `r${numberText(value.start)}:${numberText(value.end)}:${value.inclusive ? 1 : 0};`;
    case "speakerReference":
      return `p${value.speakerId};`;
    case "timerHandle":
      return `h${value.timerId};`;
    case "mediaHandle":
      return `m${value.mediaId};`;
    case "permanentButtonHandle":
      return `b${value.buttonId};`;
    case "messageHandle":
      return `g${value.messageId};`;
    case "cameraView":
      return "c;";
    case "script":
      return `x${textKey(value.path)}`;
    case "regex":
      return `e${textKey(value.source)}${textKey(value.flags)}`;
    default:
      return undefined;
  }
}

/** Text with its length first, so a key that holds it stays prefix-free. */
function textKey(text: string): string {
  return `s${text.length}:${text}`;
}

/** A number as `==` compares it: `-0` is `0`. */
function numberText(value: number): string {
  return String(value === 0 ? 0 : value);
}

/**
 * Structural equality. Objects compare property names and values regardless of property order, dicts compare keys and
 * values regardless of entry order, lists compare elements in order, and sets compare members regardless of insertion
 * order. Handles and speaker references compare identity, and regexes their pattern and flags.
 * Scalar children are compared as soon as their container is visited, before any nested list, object, or set, and
 * nested values use an explicit stack, so deep values never exhaust the native call stack.
 */
export function serializableEquals(
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
): boolean {
  const pending: DeferredComparison[] = [];
  if (!equalsOrDefer(left, right, pending)) return false;
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.kind === "set") {
      const members = membership(next.right).members;
      if (!next.left.items.every((item) => members.has(valueKey(item)))) return false;
    } else if (next.kind === "list") {
      for (let index = 0; index < next.left.items.length; index += 1) {
        if (!equalsOrDefer(next.left.items[index]!, next.right.items[index]!, pending))
          return false;
      }
    } else if (next.kind === "dict") {
      const rightValues = new Map(next.right.entries.map((entry) => [entry.key, entry.value]));
      for (const entry of next.left.entries) {
        if (!rightValues.has(entry.key)) return false;
        if (!equalsOrDefer(entry.value, rightValues.get(entry.key)!, pending)) return false;
      }
    } else {
      const rightValues = new Map(
        next.right.properties.map((property) => [property.name, property.value]),
      );
      for (const property of next.left.properties) {
        if (!rightValues.has(property.name)) return false;
        if (!equalsOrDefer(property.value, rightValues.get(property.name)!, pending)) return false;
      }
    }
  }
  return true;
}

type DeferredComparison =
  | {
      readonly kind: "list";
      readonly left: SerializableRuntimeList;
      readonly right: SerializableRuntimeList;
    }
  | {
      readonly kind: "object";
      readonly left: SerializableRuntimeObject;
      readonly right: SerializableRuntimeObject;
    }
  | {
      readonly kind: "set";
      readonly left: SerializableRuntimeSet;
      readonly right: SerializableRuntimeSet;
    }
  | {
      readonly kind: "dict";
      readonly left: SerializableRuntimeDict;
      readonly right: SerializableRuntimeDict;
    };

/**
 * Compares two values without descending: a pair of lists, sets, or dicts of equal length or objects with equal
 * property counts is queued in `pending`, and everything else is decided now.
 */
function equalsOrDefer(
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  pending: DeferredComparison[],
): boolean {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return left === right;
  switch (left.kind) {
    case "list":
      if (right.kind !== "list" || right.items.length !== left.items.length) return false;
      pending.push({ kind: "list", left, right });
      return true;
    case "object":
      if (right.kind !== "object" || right.properties.length !== left.properties.length)
        return false;
      pending.push({ kind: "object", left, right });
      return true;
    case "set":
      if (right.kind !== "set" || right.items.length !== left.items.length) return false;
      pending.push({ kind: "set", left, right });
      return true;
    case "dict":
      if (right.kind !== "dict" || right.entries.length !== left.entries.length) return false;
      pending.push({ kind: "dict", left, right });
      return true;
    case "range":
      return (
        right.kind === "range" &&
        right.start === left.start &&
        right.end === left.end &&
        right.inclusive === left.inclusive
      );
    case "duration":
      return right.kind === "duration" && right.milliseconds === left.milliseconds;
    case "calendarDuration":
      return (
        right.kind === "calendarDuration" &&
        right.milliseconds === left.milliseconds &&
        right.months === left.months &&
        right.days === left.days
      );
    case "angle":
      return right.kind === "angle" && right.degrees === left.degrees;
    case "date":
    case "time":
    case "datetime":
    case "absoluteDateTime":
      return right.kind === left.kind && leafKey(right) === leafKey(left);
    case "timerHandle":
      return right.kind === "timerHandle" && right.timerId === left.timerId;
    case "mediaHandle":
      return right.kind === "mediaHandle" && right.mediaId === left.mediaId;
    case "permanentButtonHandle":
      return right.kind === "permanentButtonHandle" && right.buttonId === left.buttonId;
    case "messageHandle":
      return right.kind === "messageHandle" && right.messageId === left.messageId;
    case "cameraView":
      return right.kind === "cameraView";
    case "speakerReference":
      return right.kind === "speakerReference" && right.speakerId === left.speakerId;
    case "script":
      return right.kind === "script" && right.path === left.path;
    case "regex":
      return right.kind === "regex" && right.source === left.source && right.flags === left.flags;
  }
}

export function validateSerializableValue(value: unknown, path = "$"): string | null {
  return captureAndValidateSerializableValue(value, path).failure;
}

/** Validates data that has already passed stable external capture. */
export function validateCapturedSerializableValue(value: unknown, path = "$"): string | null {
  return validateSerializableValueInternal(value, path);
}

interface CapturedSerializableValueResult {
  readonly value: SerializableRuntimeValue | null;
  readonly failure: string | null;
}

function captureAndValidateSerializableValue(
  value: unknown,
  path = "$",
): CapturedSerializableValueResult {
  const capture = captureExternalData(value, path);
  if (!capture.ok) {
    return Object.freeze({
      value: null,
      failure: serializableExternalDataFailureMessage(capture.failure),
    });
  }
  const failure = validateSerializableValueInternal(capture.value, path);
  return Object.freeze({
    // EVIDENCE: validation: validateSerializableValueInternal accepted the captured value when failure is null.
    value: failure === null ? (capture.value as SerializableRuntimeValue) : null,
    failure,
  });
}

function validateSerializableValueInternal(value: unknown, rootPath: string): string | null {
  interface ValuePath {
    readonly parent: ValuePath | null;
    readonly segment: string;
  }
  type ValidationWork =
    | { readonly kind: "value"; readonly value: unknown; readonly path: ValuePath | null }
    | {
        readonly kind: "list";
        readonly values: readonly unknown[];
        readonly index: number;
        readonly path: ValuePath | null;
      }
    | {
        readonly kind: "object";
        readonly properties: readonly unknown[];
        readonly index: number;
        readonly names: Set<string>;
        readonly path: ValuePath | null;
      }
    | {
        readonly kind: "dict";
        readonly entries: readonly unknown[];
        readonly index: number;
        readonly keys: Set<string>;
        readonly path: ValuePath | null;
      }
    | { readonly kind: "unique"; readonly set: unknown[]; readonly path: ValuePath | null }
    | { readonly kind: "leave"; readonly value: object };

  const active = new Set<object>();
  const work: ValidationWork[] = [{ kind: "value", value, path: null }];
  const nestedPath = (parent: ValuePath | null, segment: string): ValuePath => ({
    parent,
    segment,
  });
  const formatPath = (path: ValuePath | null): string => {
    const segments: string[] = [];
    for (let current = path; current !== null; current = current.parent) {
      segments.push(current.segment);
    }
    return `${rootPath}${segments.reverse().join("")}`;
  };

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "leave") {
      active.delete(item.value);
      continue;
    }
    if (item.kind === "unique") {
      // The members were validated before this item, so each has a key.
      const seen = new Set<string>();
      for (const member of item.set) {
        // EVIDENCE: validation: every member was validated as a runtime value before this work item.
        const key = valueKey(member as SerializableRuntimeValue);
        if (seen.has(key)) return `${formatPath(item.path)}.items contains a duplicate member.`;
        seen.add(key);
      }
      continue;
    }
    if (item.kind === "list") {
      if (item.index >= item.values.length) continue;
      work.push({ ...item, index: item.index + 1 });
      work.push({
        kind: "value",
        value: item.values[item.index],
        path: nestedPath(item.path, `.items[${item.index}]`),
      });
      continue;
    }
    if (item.kind === "dict") {
      if (item.index >= item.entries.length) continue;
      const entry = item.entries[item.index];
      const entryPath = nestedPath(item.path, `.entries[${item.index}]`);
      if (
        !isPlainRecord(entry) ||
        !hasOnlyKeys(entry, ["key", "value"]) ||
        typeof entry.key !== "string"
      ) {
        return `${formatPath(entryPath)} is malformed.`;
      }
      if (item.keys.has(entry.key)) return `${formatPath(entryPath)}.key is duplicated.`;
      item.keys.add(entry.key);
      work.push({ ...item, index: item.index + 1 });
      work.push({ kind: "value", value: entry.value, path: nestedPath(entryPath, ".value") });
      continue;
    }
    if (item.kind === "object") {
      if (item.index >= item.properties.length) continue;
      const property = item.properties[item.index];
      const propertyPath = nestedPath(item.path, `.properties[${item.index}]`);
      if (
        !isPlainRecord(property) ||
        !hasOnlyKeys(property, ["name", "value"]) ||
        typeof property.name !== "string" ||
        property.name.length === 0
      ) {
        return `${formatPath(propertyPath)} is malformed.`;
      }
      if (item.names.has(property.name)) return `${formatPath(propertyPath)}.name is duplicated.`;
      item.names.add(property.name);
      work.push({ ...item, index: item.index + 1 });
      work.push({ kind: "value", value: property.value, path: nestedPath(propertyPath, ".value") });
      continue;
    }

    const current = item.value;
    const path = (): string => formatPath(item.path);
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return `${path()} must be a finite number.`;
      continue;
    }
    if (!isPlainRecord(current) || typeof current.kind !== "string") {
      return `${path()} is not a JSON-safe runtime value.`;
    }
    if (active.has(current)) return `${path()} contains a cyclic runtime value.`;

    if (current.kind === "speakerReference") {
      // EVIDENCE: validation: the first condition checks speakerId with Number.isSafeInteger before comparison.
      if (
        !hasOnlyKeys(current, ["kind", "speakerId", "identifier"]) ||
        !Number.isSafeInteger(current.speakerId) ||
        (current.speakerId as number) < 0 ||
        typeof current.identifier !== "string" ||
        current.identifier.length === 0
      )
        return `${path()} contains a malformed speaker reference.`;
      continue;
    }
    if (
      current.kind === "duration" ||
      current.kind === "calendarDuration" ||
      current.kind === "angle" ||
      TEMPORAL_KEYS.has(current.kind)
    ) {
      const problem = timeRecordProblem(current);
      if (problem !== null) return `${path()} contains ${problem}.`;
      continue;
    }
    if (current.kind === "timerHandle") {
      // EVIDENCE: validation: Number.isSafeInteger establishes the numeric timer ID before comparison.
      if (
        !hasOnlyKeys(current, ["kind", "timerId"]) ||
        !Number.isSafeInteger(current.timerId) ||
        (current.timerId as number) < 1
      )
        return `${path()} contains a malformed timer handle.`;
      continue;
    }
    if (current.kind === "permanentButtonHandle") {
      // EVIDENCE: validation: Number.isSafeInteger establishes the numeric button ID before comparison.
      if (
        !hasOnlyKeys(current, ["kind", "buttonId"]) ||
        !Number.isSafeInteger(current.buttonId) ||
        (current.buttonId as number) < 1
      )
        return `${path()} contains a malformed permanent button identifier.`;
      continue;
    }
    if (current.kind === "messageHandle") {
      // EVIDENCE: validation: Number.isSafeInteger establishes the numeric message ID before comparison.
      if (
        !hasOnlyKeys(current, ["kind", "messageId"]) ||
        !Number.isSafeInteger(current.messageId) ||
        (current.messageId as number) < 1
      )
        return `${path()} contains a malformed message handle.`;
      continue;
    }
    if (current.kind === "cameraView") {
      if (!hasOnlyKeys(current, ["kind"]))
        return `${path()} contains a malformed camera view handle.`;
      continue;
    }
    if (current.kind === "mediaHandle") {
      // EVIDENCE: validation: Number.isSafeInteger establishes the numeric media ID before comparison.
      if (
        !hasOnlyKeys(current, ["kind", "mediaId"]) ||
        !Number.isSafeInteger(current.mediaId) ||
        (current.mediaId as number) < 1
      )
        return `${path()} contains a malformed media handle.`;
      continue;
    }
    if (current.kind === "script") {
      if (!hasOnlyKeys(current, ["kind", "path"]) || typeof current.path !== "string")
        return `${path()} contains a malformed script reference.`;
      continue;
    }
    if (current.kind === "regex") {
      if (
        !hasOnlyKeys(current, ["kind", "source", "flags"]) ||
        typeof current.source !== "string" ||
        typeof current.flags !== "string" ||
        !isCanonicalRegexFlags(current.flags)
      )
        return `${path()} contains a malformed regex.`;
      const compiled = compileRegex(current.source, current.flags);
      if (!compiled.ok)
        return `${path()} contains a regex that cannot be used: ${compiled.problem}`;
      continue;
    }
    if (current.kind === "range") {
      if (
        !hasOnlyKeys(current, ["kind", "start", "end", "inclusive"]) ||
        typeof current.start !== "number" ||
        !Number.isFinite(current.start) ||
        typeof current.end !== "number" ||
        !Number.isFinite(current.end) ||
        typeof current.inclusive !== "boolean"
      )
        return `${path()} contains a malformed range.`;
      continue;
    }
    if (current.kind === "list" || current.kind === "set") {
      if (!hasOnlyKeys(current, ["kind", "items"]))
        return `${path()} contains a malformed ${current.kind}.`;
      if (!Array.isArray(current.items)) return `${path()}.items must be an array.`;
      active.add(current);
      work.push({ kind: "leave", value: current });
      // A set's members are unique by `==`, which is checked once all of them are valid.
      if (current.kind === "set")
        work.push({ kind: "unique", set: current.items, path: item.path });
      work.push({ kind: "list", values: current.items, index: 0, path: item.path });
      continue;
    }
    if (current.kind === "dict") {
      if (!hasOnlyKeys(current, ["kind", "entries"])) return `${path()} contains a malformed dict.`;
      if (!Array.isArray(current.entries)) return `${path()}.entries must be an array.`;
      active.add(current);
      work.push({ kind: "leave", value: current });
      work.push({
        kind: "dict",
        entries: current.entries,
        index: 0,
        keys: new Set(),
        path: item.path,
      });
      continue;
    }
    if (current.kind === "object") {
      if (!hasOnlyKeys(current, ["kind", "properties"])) {
        return `${path()} contains a malformed object.`;
      }
      if (!Array.isArray(current.properties)) return `${path()}.properties must be an array.`;
      active.add(current);
      work.push({ kind: "leave", value: current });
      work.push({
        kind: "object",
        properties: current.properties,
        index: 0,
        names: new Set(),
        path: item.path,
      });
      continue;
    }
    return `${path()}.kind is unsupported.`;
  }
  return null;
}

const TEMPORAL_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["date", ["kind", "year", "month", "day"]],
  ["time", ["kind", "hour", "minute", "second", "millisecond"]],
  ["datetime", ["kind", "year", "month", "day", "hour", "minute", "second", "millisecond"]],
  ["absoluteDateTime", ["kind", "epochMilliseconds"]],
]);

/**
 * Why a duration, calendar duration, angle, date, time, datetime, or absolute date and time record is malformed, as a
 * phrase such as "a malformed date", or `null` when it is valid.
 */
function timeRecordProblem(value: Record<string, unknown>): string | null {
  if (value.kind === "duration")
    return isStoredDurationRecord(value) ? null : "a malformed duration";
  if (value.kind === "angle") return isStoredAngleRecord(value) ? null : "a malformed angle";
  if (value.kind === "calendarDuration")
    return isStoredCalendarDurationRecord(value) ? null : "a malformed calendar duration";
  const keys = typeof value.kind === "string" ? TEMPORAL_KEYS.get(value.kind) : undefined;
  if (keys === undefined)
    return typeof value.kind === "string" ? `a ${value.kind} value` : "a value without a kind";
  if (
    !hasOnlyKeys(value, keys) ||
    keys.some((key) => key !== "kind" && typeof value[key] !== "number")
  )
    return `a malformed ${value.kind}`;
  // Every field other than kind was just checked to be a number.
  const field = (key: string): number => Number(value[key]);
  const date = { year: field("year"), month: field("month"), day: field("day") };
  const time = {
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
    millisecond: field("millisecond"),
  };
  const valid =
    value.kind === "date"
      ? isValidDate(date)
      : value.kind === "time"
        ? isValidTime(time)
        : value.kind === "datetime"
          ? isValidDate(date) && isValidTime(time)
          : isValidEpochMilliseconds(field("epochMilliseconds"));
  return valid ? null : `a malformed ${value.kind}`;
}

function serializableCaptureError(failure: ExternalDataFailure): SerializableValueError {
  const message = serializableExternalDataFailureMessage(failure);
  return new SerializableValueError(failure.kind === "cycle" ? "cyclic" : "invalid", message);
}

function serializableExternalDataFailureMessage(failure: ExternalDataFailure): string {
  switch (failure.kind) {
    case "nonFiniteNumber":
      return `${failure.path} must be a finite number.`;
    case "cycle":
      return `${failure.path} contains a cyclic runtime value.`;
    case "nonJsonSafeValue":
    case "nonPlainObject":
      return `${failure.path} is not a JSON-safe runtime value.`;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
