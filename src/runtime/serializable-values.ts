import { isStoredDurationRecord, type StoredDuration } from "../duration.js";
import { captureExternalData, type ExternalDataFailure } from "../external-data-capture.js";
import {
  isValidDate,
  isValidEpochMilliseconds,
  isValidTime,
  type DateFields,
  type DateTimeFields,
  type TimeFields,
} from "../temporal.js";

export type SerializableRuntimeScalar = string | number | boolean | null;

export interface SerializableRuntimeList {
  readonly kind: "list";
  readonly items: SerializableRuntimeValue[];
}

export interface SerializableRuntimeObject {
  readonly kind: "object";
  readonly properties: SerializableRuntimeProperty[];
}

export interface SerializableRuntimeSet {
  readonly kind: "set";
  readonly items: SerializableSetElement[];
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

/** A value a set can hold: a scalar or a date or time value. Membership compares kind and value. */
export type SerializableSetElement = SerializableRuntimeScalar | SerializableRuntimeTemporal;

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

/** A duration: exact milliseconds, and whole calendar `months` and `days` present only when they are not zero. */
export type SerializableRuntimeDuration = StoredDuration;

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
export interface SerializableRuntimeTimestamp {
  readonly kind: "timestamp";
  readonly epochMilliseconds: number;
}

export type SerializableRuntimeTemporal =
  | SerializableRuntimeDate
  | SerializableRuntimeTime
  | SerializableRuntimeDateTime
  | SerializableRuntimeTimestamp;

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
  | SerializableRuntimeTemporal
  | SerializableTimerHandle
  | SerializableMediaHandle
  | SerializableSpeakerReference;

export class SerializableValueError extends Error {
  public constructor(
    readonly code: "cyclic" | "invalid" | "setElement",
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
  return createCapturedSerializableSet(capture.value as SerializableRuntimeValue[]);
}

/** Creates a set from engine-owned, already validated values. */
export function createCapturedSerializableSet(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeSet {
  const set: SerializableRuntimeSet = { kind: "set", items: [] };
  const membership = new Set<string>();
  for (const item of items) addSerializableSetValue(set, item, membership);
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

/** Clones already captured/validated engine data without a second validation pass. */
export function cloneCapturedSerializableValue(
  value: SerializableRuntimeValue,
): SerializableRuntimeValue {
  if (isScalar(value)) return value;
  const root = cloneSerializableNode(value);
  if (!isComposite(value)) return root;

  const work: Array<readonly [CompositeValue, CompositeValue]> = [
    [
      value,
      // EVIDENCE: validation: the non-scalar root clone preserves the composite kind of the source.
      root as CompositeValue,
    ],
  ];
  // Each nested value is cloned into its slot; a nested composite is queued to fill its own slots.
  const cloneInto = (nested: SerializableRuntimeValue): SerializableRuntimeValue => {
    const cloned = cloneSerializableNode(nested);
    if (isComposite(nested)) {
      // EVIDENCE: validation: cloneSerializableNode preserves the composite kind checked on nested.
      work.push([nested, cloned as CompositeValue]);
    }
    return cloned;
  };
  while (work.length > 0) {
    const [source, target] = work.pop()!;
    if (source.kind === "list") {
      // EVIDENCE: validation: work pairs each list source with its newly allocated list clone.
      const targetItems = (target as SerializableRuntimeList).items;
      for (let index = 0; index < source.items.length; index += 1)
        targetItems[index] = cloneInto(source.items[index]!);
    } else if (source.kind === "dict") {
      // EVIDENCE: validation: work pairs each dict source with its newly allocated dict clone.
      const targetEntries = (target as SerializableRuntimeDict).entries;
      for (let index = 0; index < source.entries.length; index += 1) {
        const entry = source.entries[index]!;
        targetEntries[index] = { key: entry.key, value: cloneInto(entry.value) };
      }
    } else {
      // EVIDENCE: validation: the remaining composite source and its paired clone are objects.
      const targetProperties = (target as SerializableRuntimeObject).properties;
      for (let index = 0; index < source.properties.length; index += 1) {
        const property = source.properties[index]!;
        targetProperties[index] = { name: property.name, value: cloneInto(property.value) };
      }
    }
  }
  return root;
}

/** A value that holds other values of any kind, which a copy copies in turn. */
type CompositeValue = SerializableRuntimeList | SerializableRuntimeObject | SerializableRuntimeDict;

function isComposite(value: SerializableRuntimeValue): value is CompositeValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value.kind === "list" || value.kind === "object" || value.kind === "dict")
  );
}

/**
 * Whether a value holds a timer handle, media handle, or speaker reference: identities the runtime allocates for the
 * current session, which host data and stored values cannot carry. Lists, objects, and dicts are checked iteratively
 * at every depth.
 */
export function containsRuntimeIdentity(value: SerializableRuntimeValue): boolean {
  const work: SerializableRuntimeValue[] = [value];
  while (work.length > 0) {
    const current = work.pop()!;
    if (typeof current !== "object" || current === null) continue;
    switch (current.kind) {
      case "timerHandle":
      case "mediaHandle":
      case "speakerReference":
        return true;
      case "list":
        for (const item of current.items) work.push(item);
        break;
      case "object":
        for (const property of current.properties) work.push(property.value);
        break;
      case "dict":
        for (const entry of current.entries) work.push(entry.value);
        break;
      case "set":
      case "range":
      case "duration":
        break;
    }
  }
  return false;
}

function cloneSerializableNode(value: SerializableRuntimeValue): SerializableRuntimeValue {
  if (isScalar(value)) return value;
  switch (value.kind) {
    case "range":
      return { ...value };
    case "speakerReference":
    case "duration":
    case "date":
    case "time":
    case "datetime":
    case "timestamp":
    case "timerHandle":
    case "mediaHandle":
      return { ...value };
    case "set":
      // Date and time members and durations are records of their own; each copy gets new ones.
      return {
        kind: "set",
        items: value.items.map((item) =>
          item !== null && typeof item === "object" ? { ...item } : item,
        ),
      };
    case "list":
      return { kind: "list", items: new Array(value.items.length) };
    case "object":
      return { kind: "object", properties: new Array(value.properties.length) };
    case "dict":
      return { kind: "dict", entries: new Array(value.entries.length) };
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

/** The entry of a dict key, or `undefined` when the dict has no such key. */
export function getSerializableDictEntry(
  dict: SerializableRuntimeDict,
  key: string,
): SerializableRuntimeDictEntry | undefined {
  return dict.entries.find((entry) => entry.key === key);
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
  const existing = getSerializableDictEntry(dict, key);
  const copied = cloneCapturedSerializableValue(value);
  if (existing === undefined) dict.entries.push({ key, value: copied });
  else existing.value = copied;
}

/**
 * A dict's `length`, or a new list of its `keys` or of copies of its `values` in entry order, or `undefined` for
 * another name.
 */
export function dictProperty(
  dict: SerializableRuntimeDict,
  name: string,
): SerializableRuntimeValue | undefined {
  switch (name) {
    case "length":
      return dict.entries.length;
    case "keys":
      return { kind: "list", items: dict.entries.map((entry) => entry.key) };
    case "values":
      return createCapturedSerializableList(dict.entries.map((entry) => entry.value));
    default:
      return undefined;
  }
}

/** Removes a key and returns its entry, or `undefined` when the dict has no such key. */
export function removeSerializableDictEntry(
  dict: SerializableRuntimeDict,
  key: string,
): SerializableRuntimeDictEntry | undefined {
  const index = dict.entries.findIndex((entry) => entry.key === key);
  return index < 0 ? undefined : dict.entries.splice(index, 1)[0];
}

/** Adds an engine-owned value; `membership` holds the set's member keys when a caller adds many values. */
export function addSerializableSetValue(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
  membership?: Set<string>,
): boolean {
  assertSetElement(value);
  const seen = membership ?? new Set(set.items.map(setMemberKey));
  const key = setMemberKey(value);
  if (seen.has(key)) return false;
  seen.add(key);
  set.items.push(value !== null && typeof value === "object" ? { ...value } : value);
  return true;
}

export function removeSerializableSetValue(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  assertSetElement(value);
  const key = setMemberKey(value);
  const index = set.items.findIndex((item) => setMemberKey(item) === key);
  if (index < 0) return false;
  set.items.splice(index, 1);
  return true;
}

export function serializableSetContains(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  assertSetElement(value);
  const key = setMemberKey(value);
  return set.items.some((item) => setMemberKey(item) === key);
}

/** Whether a value can be a set member. */
export function isSetElement(value: SerializableRuntimeValue): value is SerializableSetElement {
  return value === null || typeof value !== "object" || isSetElementKind(value.kind);
}

/** The kinds of non-scalar values a set holds. */
function isSetElementKind(kind: unknown): boolean {
  return kind === "date" || kind === "time" || kind === "datetime" || kind === "timestamp";
}

/** A text that is equal for two set members exactly when they are the same kind and `==` value. */
function setMemberKey(value: SerializableSetElement): string {
  if (value === null) return "null";
  if (typeof value === "string") return `s${value}`;
  if (typeof value === "number") return `n${value === 0 ? 0 : value}`;
  if (typeof value === "boolean") return `b${value}`;
  switch (value.kind) {
    case "date":
      return `d${value.year}-${value.month}-${value.day}`;
    case "time":
      return `t${value.hour}:${value.minute}:${value.second}.${value.millisecond}`;
    case "datetime":
      return `D${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}.${value.millisecond}`;
    case "timestamp":
      return `T${value.epochMilliseconds}`;
  }
}

/**
 * Structural equality. Objects compare property names and values regardless of property order, dicts compare keys and
 * values regardless of entry order, lists compare elements in order, and sets compare members regardless of insertion
 * order. Handles and speaker references compare identity.
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
      const members = new Set(next.right.items.map(setMemberKey));
      if (!next.left.items.every((item) => members.has(setMemberKey(item)))) return false;
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
      return (
        right.kind === "duration" &&
        right.milliseconds === left.milliseconds &&
        (right.months ?? 0) === (left.months ?? 0) &&
        (right.days ?? 0) === (left.days ?? 0)
      );
    case "date":
    case "time":
    case "datetime":
    case "timestamp":
      return right.kind === left.kind && setMemberKey(right) === setMemberKey(left);
    case "timerHandle":
      return right.kind === "timerHandle" && right.timerId === left.timerId;
    case "mediaHandle":
      return right.kind === "mediaHandle" && right.mediaId === left.mediaId;
    case "speakerReference":
      return right.kind === "speakerReference" && right.speakerId === left.speakerId;
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
    if (current.kind === "duration" || TEMPORAL_KEYS.has(current.kind)) {
      const problem = setElementObjectProblem(current);
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
    if (current.kind === "set") {
      if (!hasOnlyKeys(current, ["kind", "items"])) return `${path()} contains a malformed set.`;
      if (!Array.isArray(current.items)) return `${path()}.items must be an array.`;
      const seen = new Set<string>();
      for (let index = 0; index < current.items.length; index += 1) {
        const nested: unknown = current.items[index];
        if (typeof nested === "number" && !Number.isFinite(nested))
          return `${path()}.items[${index}] must be a finite number.`;
        if (!isScalar(nested)) {
          const problem =
            isPlainRecord(nested) && isSetElementKind(nested.kind)
              ? setElementObjectProblem(nested)
              : "a value of another kind";
          if (problem !== null) return `${path()}.items[${index}] is not a set member: ${problem}.`;
        }
        // EVIDENCE: validation: the member is a finite scalar or passed setElementObjectProblem above.
        const key = setMemberKey(nested as SerializableSetElement);
        if (seen.has(key)) return `${path()}.items contains a duplicate member.`;
        seen.add(key);
      }
      continue;
    }
    if (current.kind === "list") {
      if (!hasOnlyKeys(current, ["kind", "items"])) return `${path()} contains a malformed list.`;
      if (!Array.isArray(current.items)) return `${path()}.items must be an array.`;
      active.add(current);
      work.push({ kind: "leave", value: current });
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

function assertSetElement(
  value: SerializableRuntimeValue,
): asserts value is SerializableSetElement {
  if (!isSetElement(value)) {
    throw new SerializableValueError(
      "setElement",
      "Sets may contain only string, boolean, integer, number, date, time, datetime, timestamp, or null values.",
    );
  }
}

const TEMPORAL_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["date", ["kind", "year", "month", "day"]],
  ["time", ["kind", "hour", "minute", "second", "millisecond"]],
  ["datetime", ["kind", "year", "month", "day", "hour", "minute", "second", "millisecond"]],
  ["timestamp", ["kind", "epochMilliseconds"]],
]);

/**
 * Why a duration, date, time, datetime, or timestamp record is malformed, as a phrase such as "a malformed date", or
 * `null` when it is valid. Other kinds are reported as not set members.
 */
function setElementObjectProblem(value: Record<string, unknown>): string | null {
  if (value.kind === "duration")
    return isStoredDurationRecord(value) ? null : "a malformed duration";
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

function isScalar(value: unknown): value is SerializableRuntimeScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
