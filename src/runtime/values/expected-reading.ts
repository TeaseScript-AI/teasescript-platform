import type { TypePlan } from "../../plan/model.js";
import {
  cloneCapturedSerializableValue,
  getSerializableDictEntry,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import { isDict, isList, isObject, isSet } from "./value-predicates.js";
import { matchesValueType } from "./value-types.js";
import { VALUE_KIND_NAMES } from "../../value-kinds.js";

/*
 * Reading a value as the type a script expects of it, field by field (ADR 0021 rules 2.6 and 6.5): what `fromJson`
 * reads, and what a `load` finds stored. JSON reads a JSON object, which parses to a dict, as an object where the type
 * is one; a stored value is read as it is. Deep values are read without native recursion.
 */

/** A field of a record that the default supplies: its path from the record, and what the record holds there. */
export interface MissingField {
  readonly path: readonly string[];
  /** The value found there, or `undefined` for a missing field. */
  readonly found: SerializableRuntimeValue | undefined;
  /** The type the field is read as. */
  readonly type: TypePlan;
}

/**
 * How a value reads as a type: whole, as the type reads it (JSON objects as objects); as a record whose listed `fields`
 * the default supplies, a nested object's by its own fields; or not at all, which takes the whole default.
 */
export type ExpectedReading =
  | { readonly kind: "whole"; readonly value: SerializableRuntimeValue }
  | { readonly kind: "fields"; readonly fields: readonly MissingField[] }
  | { readonly kind: "none" };

/**
 * Whether `type` takes every value: the type of a property that nothing settles, a `null` in an object default (F18),
 * which JSON may leave out without a warning (ADR 0021 rule 2.6).
 */
export function takesEveryValue(type: TypePlan): boolean {
  if (type.kind !== "union") return false;
  const open = new Set(
    type.members.flatMap((member) =>
      member.kind === "object"
        ? member.properties.length === 0
          ? ["object"]
          : []
        : "element" in member
          ? member.element === null
            ? [member.kind]
            : []
          : [member.kind],
    ),
  );
  return VALUE_KIND_NAMES.every((kind) => open.has(kind));
}

/** A record's fields by name: an object's properties, indexed once, or for JSON a dict's entries, which are. */
function fieldsOf(
  record: SerializableRuntimeValue,
  json: boolean,
): (name: string) => SerializableRuntimeValue | undefined {
  if (isObject(record)) {
    const fields = new Map(record.properties.map((property) => [property.name, property.value]));
    return (name) => fields.get(name);
  }
  if (json && isDict(record)) return (name) => getSerializableDictEntry(record, name)?.value;
  return () => undefined;
}

/** Whether a value is a record that an object type reads field by field: an object, or for JSON a dict. */
function isRecordValue(value: SerializableRuntimeValue, json: boolean): boolean {
  return isObject(value) || (json && isDict(value));
}

/** The member of a union that reads `part` by its kind (`readWhole`), or `undefined`. */
function memberFor(
  part: SerializableRuntimeValue,
  members: readonly TypePlan[],
): TypePlan | undefined {
  if (isList(part)) return members.find((member) => member.kind === "list");
  if (isSet(part)) return members.find((member) => member.kind === "set");
  if (isRecordValue(part, true))
    return (
      members.find((member) => member.kind === "object") ??
      (isDict(part) ? members.find((member) => member.kind === "dict") : undefined)
    );
  return undefined;
}

/**
 * `value` read whole as `type`, or `undefined` where it does not fit. A stored value fits as the runtime type checks
 * take it (`matchesValueType`). JSON is read as the type: a dict where the type is an object becomes an object of the
 * type's properties, each of which it must have, its other keys left out, and lists, sets and dicts are read element by
 * element; a union reads a value that fits it as it is, and otherwise as its member of the value's own kind: a record
 * as its object member (else its dict member), a list as its list member, a set as its set member (the core's expected
 * types have one member of each kind at most at each level).
 */
function readWhole(
  value: SerializableRuntimeValue,
  type: TypePlan,
  json: boolean,
): SerializableRuntimeValue | undefined {
  const fits = matchesValueType(value, type);
  if (fits || !json) return fits ? value : undefined;
  interface Frame {
    /** The parts to read, each with its type, and what the frame builds of their results. */
    readonly parts: readonly (readonly [SerializableRuntimeValue, TypePlan])[];
    readonly build: (read: readonly SerializableRuntimeValue[]) => SerializableRuntimeValue;
    readonly results: SerializableRuntimeValue[];
  }
  /** The frame that reads `part` as `of`, or the part's result where it needs none (`undefined`: it does not fit). */
  const open = (
    part: SerializableRuntimeValue,
    of: TypePlan,
  ): Frame | { readonly result: SerializableRuntimeValue | undefined } => {
    if (matchesValueType(part, of)) return { result: part };
    const member = of.kind === "union" ? memberFor(part, of.members) : of;
    if (member === undefined) return { result: undefined };
    if (member.kind === "object") {
      const object = member;
      if (!isRecordValue(part, true)) return { result: undefined };
      const parts: (readonly [SerializableRuntimeValue, TypePlan])[] = [];
      const fieldOf = fieldsOf(part, true);
      for (const property of object.properties) {
        const field = fieldOf(property.name);
        if (field === undefined) return { result: undefined };
        parts.push([field, property.type]);
      }
      return {
        parts,
        build: (read) => ({
          kind: "object",
          properties: object.properties.map((property, index) => ({
            name: property.name,
            value: read[index]!,
          })),
        }),
        results: [],
      };
    }
    if ((member.kind === "list" || member.kind === "set") && member.element !== null) {
      const items =
        member.kind === "list"
          ? isList(part)
            ? part.items
            : null
          : isSet(part)
            ? part.items
            : null;
      if (items === null) return { result: undefined };
      const { kind, element } = member;
      return {
        parts: items.map((item) => [item, element] as const),
        build: (read) => ({ kind, items: [...read] }),
        results: [],
      };
    }
    if (member.kind === "dict" && member.element !== null && isDict(part)) {
      const { element } = member;
      return {
        parts: part.entries.map((entry) => [entry.value, element] as const),
        build: (read) => ({
          kind: "dict",
          entries: part.entries.map((entry, index) => ({ key: entry.key, value: read[index]! })),
        }),
        results: [],
      };
    }
    return { result: undefined };
  };
  const first = open(value, type);
  if ("result" in first) return first.result;
  const frames: Frame[] = [first];
  for (;;) {
    const frame = frames[frames.length - 1]!;
    if (frame.results.length === frame.parts.length) {
      frames.pop();
      const built = frame.build(frame.results);
      if (frames.length === 0) return built;
      frames[frames.length - 1]!.results.push(built);
      continue;
    }
    const [part, of] = frame.parts[frame.results.length]!;
    const next = open(part, of);
    if (!("result" in next)) frames.push(next);
    else if (next.result === undefined) return undefined;
    else frame.results.push(next.result);
  }
}

/** A place in JSON that holds a part, with the type it is read as there and its field path from a repaired record. */
interface KeptSlot {
  readonly part: SerializableRuntimeValue;
  readonly set: (value: SerializableRuntimeValue) => void;
  /** `null`: every part of it is kept as it is. */
  readonly type: TypePlan | null;
  /** The record's field path that a field reading names, or `null` below a field that reads whole. */
  readonly path: readonly string[] | null;
}

/**
 * Replaces in place each text of `value`, parsed JSON, that a reading as `type` keeps (ADR 0021 rule 2.6) by what
 * `replace` gives for it, and returns the value: the parts the reading takes, as `readExpected` and `readWhole` take
 * them. A key the type leaves out, a field the default supplies, and JSON that does not read keep their texts, so a
 * file store stores the files of what the call keeps, and nothing else (`actions/file-store.ts`). The reading of the
 * result is the reading of `value`: a replaced text is still text.
 */
export function replaceKeptTexts(
  value: SerializableRuntimeValue,
  type: TypePlan,
  replace: (text: string) => string | undefined,
): SerializableRuntimeValue {
  const reading = readExpected(value, type, true);
  if (reading.kind === "none") return value;
  const supplied = new Set(
    reading.kind === "fields" ? reading.fields.map((field) => field.path.join("\u0000")) : [],
  );
  let root = value;
  const pending: KeptSlot[] = [
    {
      part: value,
      set: (replaced) => {
        root = replaced;
      },
      type,
      path: reading.kind === "fields" ? [] : null,
    },
  ];
  const below = (path: readonly string[] | null, name: string): readonly string[] | null =>
    path === null ? null : [...path, name];
  for (let slot = pending.pop(); slot !== undefined; slot = pending.pop()) {
    const { part, type: of, path } = slot;
    if (path !== null && path.length > 0 && supplied.has(path.join("\u0000"))) continue;
    if (typeof part === "string") {
      if (of !== null && !matchesValueType(part, of)) continue;
      const replaced = replace(part);
      if (replaced !== undefined) slot.set(replaced);
      continue;
    }
    if (!isList(part) && !isDict(part)) continue;
    // kept whole where it fits as it is (below a field reading's record), else read by its type's member of its kind
    let member: TypePlan | null = null;
    if (of !== null && !(path === null && matchesValueType(part, of))) {
      const found = of.kind === "union" ? memberFor(part, of.members) : of;
      if (found === undefined) continue;
      member = found;
    }
    if (isList(part)) {
      if (member !== null && member.kind !== "list") continue;
      const element = member === null ? null : member.element;
      const { items } = part;
      // last first, so that the stack gives the parts in reading order
      for (let index = items.length - 1; index >= 0; index -= 1)
        pending.push({
          part: items[index] ?? null,
          set: (replaced) => {
            items[index] = replaced;
          },
          type: element,
          path: null,
        });
      continue;
    }
    if (member !== null && member.kind !== "dict" && member.kind !== "object") continue;
    const listed =
      member?.kind === "object"
        ? new Map(member.properties.map((property) => [property.name, property.type]))
        : null;
    for (const entry of [...part.entries].reverse()) {
      // an object type keeps its listed properties only, the others left out
      const listedType = listed?.get(entry.key);
      if (listed !== null && listedType === undefined) continue;
      pending.push({
        part: entry.value,
        set: (replaced) => {
          entry.value = replaced;
        },
        type: listedType ?? (member?.kind === "dict" ? member.element : null),
        path: listed !== null ? below(path, entry.key) : null,
      });
    }
  }
  return root;
}

/**
 * How `value` reads as `type` (see `ExpectedReading`). Only an object type reads by field: a record whose every listed
 * field reads whole is whole; otherwise each missing field, or one that does not read whole, is the default's, a nested
 * object's by its own fields where it is a record too, in the type's order. Any other type reads whole or not at all.
 */
export function readExpected(
  value: SerializableRuntimeValue,
  type: TypePlan,
  json: boolean,
): ExpectedReading {
  if (type.kind !== "object" || !isRecordValue(value, json)) {
    const whole = type.kind === "object" ? undefined : readWhole(value, type, json);
    return whole === undefined ? { kind: "none" } : { kind: "whole", value: whole };
  }
  const fields: MissingField[] = [];
  const frames: {
    readonly fieldOf: (name: string) => SerializableRuntimeValue | undefined;
    readonly type: Extract<TypePlan, { kind: "object" }>;
    readonly path: readonly string[];
    next: number;
  }[] = [{ fieldOf: fieldsOf(value, json), type, path: [], next: 0 }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.next === frame.type.properties.length) {
      frames.pop();
      continue;
    }
    const property = frame.type.properties[frame.next++]!;
    const path = [...frame.path, property.name];
    const found = frame.fieldOf(property.name);
    if (found === undefined) fields.push({ path, found, type: property.type });
    else if (property.type.kind === "object" && isRecordValue(found, json))
      frames.push({ fieldOf: fieldsOf(found, json), type: property.type, path, next: 0 });
    else if (readWhole(found, property.type, json) === undefined)
      fields.push({ path, found, type: property.type });
  }
  if (fields.length > 0) return { kind: "fields", fields };
  const whole = readWhole(value, type, json);
  return whole === undefined ? { kind: "none" } : { kind: "whole", value: whole };
}

/**
 * The record `candidate` repaired from `fallback` as `type` reads it (ADR 0021 rules 2.6 and 6.5): each listed field
 * that reads whole is the candidate's, read as the type reads it; a nested object that is a record in both is repaired
 * the same way; any other field is the fallback's. A stored record keeps its other fields and is copied, never changed;
 * JSON keeps only the listed ones. A candidate or fallback that is no record gives the fallback.
 */
export function repairedRecord(
  candidate: SerializableRuntimeValue,
  fallback: SerializableRuntimeValue,
  type: TypePlan,
  json: boolean,
): SerializableRuntimeValue {
  if (type.kind !== "object" || !isRecordValue(candidate, json) || !isObject(fallback))
    return fallback;
  // a stored record's copy keeps its other fields; JSON builds an object of the listed ones
  // EVIDENCE: invariant: a stored record is an object (`isRecordValue` without JSON), and so is its copy.
  const root: SerializableRuntimeObject = json
    ? { kind: "object", properties: [] }
    : (cloneCapturedSerializableValue(candidate) as SerializableRuntimeObject);
  const pending: {
    readonly candidate: (name: string) => SerializableRuntimeValue | undefined;
    readonly fallback: (name: string) => SerializableRuntimeValue | undefined;
    readonly type: Extract<TypePlan, { kind: "object" }>;
    readonly into: SerializableRuntimeObject;
  }[] = [
    { candidate: fieldsOf(candidate, json), fallback: fieldsOf(fallback, false), type, into: root },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    // the copy's own fields, indexed once, where a field of the record is replaced or added
    const into = new Map(next.into.properties.map((property) => [property.name, property]));
    const put = (name: string, value: SerializableRuntimeValue): void => {
      const copied = cloneCapturedSerializableValue(value);
      const existing = into.get(name);
      if (existing !== undefined) existing.value = copied;
      else {
        const property = { name, value: copied };
        next.into.properties.push(property);
        into.set(name, property);
      }
    };
    for (const property of next.type.properties) {
      const found = next.candidate(property.name);
      const given = next.fallback(property.name);
      if (
        found !== undefined &&
        given !== undefined &&
        property.type.kind === "object" &&
        isRecordValue(found, json) &&
        isObject(given)
      ) {
        // the copy holds the stored field already; JSON's starts empty
        let below = into.get(property.name)?.value;
        if (below === undefined) {
          below = { kind: "object", properties: [] };
          const added = { name: property.name, value: below };
          next.into.properties.push(added);
          into.set(property.name, added);
        }
        pending.push({
          candidate: fieldsOf(found, json),
          fallback: fieldsOf(given, false),
          type: property.type,
          // EVIDENCE: invariant: the field is the stored object's copy or the empty object just added.
          into: below as SerializableRuntimeObject,
        });
        continue;
      }
      const whole = found === undefined ? undefined : readWhole(found, property.type, json);
      // a stored field that reads whole is in the copy already
      if (whole !== undefined && !json) continue;
      const value = whole ?? given;
      if (value !== undefined) put(property.name, value);
    }
  }
  return root;
}
