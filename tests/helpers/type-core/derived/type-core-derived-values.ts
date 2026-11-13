// The fixture's values as a run reads and shows them: a value's fit to a checked type, JSON read by kind and field, and
// the text a `say` shows.

import {
  DEFAULT_TEMPORAL_CONTEXT,
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
  localFields,
  presentDate,
  presentDateTime,
  presentTime,
} from "../../../../src/temporal.js";
import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import { Underivable, type DerivedType } from "./type-core-derived.js";

export function fitsType(value: SerializableRuntimeValue, type: DerivedType): boolean {
  if (type.kind === "union") return type.members.some((member) => fitsType(value, member));
  if (type.kind === "kinds")
    return type.kinds.some(
      (kind) =>
        kind === "unknown" ||
        (value === null
          ? kind === "null"
          : typeof value === "number"
            ? kind === "number" || (kind === "integer" && Number.isInteger(value))
            : typeof value === "string"
              ? kind === "string"
              : typeof value === "boolean"
                ? kind === "boolean"
                : kind === value.kind),
    );
  if (type.kind === "object")
    return (
      value !== null &&
      typeof value === "object" &&
      value.kind === "object" &&
      type.properties.every((property) => {
        const held = value.properties.find((entry) => entry.name === property.name);
        // Object admissions constrain fields that are present; C5 checks a required member at its access.
        return held === undefined || fitsType(held.value, property.type);
      })
    );
  return (
    typeof value === "object" &&
    value !== null &&
    value.kind === type.kind &&
    (value.kind === "dict"
      ? value.entries.every((entry) => type.element === null || fitsType(entry.value, type.element))
      : "items" in value &&
        value.items.every((item) => type.element === null || fitsType(item, type.element)))
  );
}

/** JSON's scalar/list/dict values, prior to reading an expected object type. */
export function jsonValue(raw: unknown): SerializableRuntimeValue {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw)) return { kind: "list", items: raw.map(jsonValue) };
  if (typeof raw === "object" && raw !== null)
    return {
      kind: "dict",
      entries: Object.entries(raw).map(([key, value]) => ({ key, value: jsonValue(value) })),
    };
  throw new Underivable("unrepresentable JSON");
}

/** Read by kind and by field; `undefined` asks for the default, whose fields may repair an object. */
export function readJson(
  value: SerializableRuntimeValue,
  type: DerivedType,
  fallback?: SerializableRuntimeValue,
): SerializableRuntimeValue | undefined {
  if (type.kind === "union") {
    for (const member of type.members) {
      const read = readJson(value, member, fallback);
      if (read !== undefined) return read;
    }
    return undefined;
  }
  if (type.kind === "object") {
    if (
      typeof value !== "object" ||
      value === null ||
      (value.kind !== "dict" && value.kind !== "object")
    )
      return undefined;
    const fields =
      value.kind === "dict"
        ? value.entries.map((entry) => ({ name: entry.key, value: entry.value }))
        : value.properties;
    const properties: { name: string; value: SerializableRuntimeValue }[] = [];
    for (const property of type.properties) {
      const held = fields.find((entry) => entry.name === property.name)?.value;
      const supplied =
        fallback !== null && typeof fallback === "object" && fallback?.kind === "object"
          ? fallback.properties.find((entry) => entry.name === property.name)?.value
          : undefined;
      const read = held === undefined ? undefined : readJson(held, property.type, supplied);
      if (read === undefined && supplied === undefined) return undefined;
      properties.push({ name: property.name, value: read === undefined ? supplied! : read });
    }
    if (type.keepExtra !== true) return { kind: "object", properties };
    // every key in the JSON's order, a listed one as read, those it lacks after them
    const read = (name: string) => properties.find((property) => property.name === name);
    return {
      kind: "object",
      properties: [
        ...fields.map((field) => read(field.name) ?? field),
        ...properties.filter((property) => !fields.some((field) => field.name === property.name)),
      ],
    };
  }
  if (
    type.kind !== "kinds" &&
    type.element !== null &&
    typeof value === "object" &&
    value !== null &&
    value.kind === type.kind
  ) {
    if (value.kind === "dict") {
      const entries = value.entries.map((entry) => ({
        key: entry.key,
        value: readJson(entry.value, type.element!),
      }));
      return entries.some((entry) => entry.value === undefined)
        ? undefined
        : {
            kind: "dict",
            entries: entries.map((entry) => ({ key: entry.key, value: entry.value! })),
          };
    }
    if ("items" in value) {
      const items = value.items.map((item) => readJson(item, type.element!));
      return items.some((item) => item === undefined)
        ? undefined
        : { kind: value.kind, items: items.filter((item) => item !== undefined) };
    }
  }
  return fitsType(value, type) ? value : undefined;
}

/** `say` uses scalars as text and other fixture values as escaped code-like notation (V30 §8). */
export function shown(value: SerializableRuntimeValue, nested = false): string {
  if (value === null || typeof value !== "object")
    return typeof value === "string" && nested ? JSON.stringify(value) : String(value);
  if (value.kind === "list" || value.kind === "set")
    return `[${value.items.map((item) => shown(item, true)).join(", ")}]`;
  if (value.kind === "object")
    return value.properties.length === 0
      ? "{}"
      : `{ ${value.properties.map((property) => `${/^[A-Za-z_][A-Za-z0-9_]*$/u.test(property.name) ? property.name : JSON.stringify(property.name)}: ${shown(property.value, true)}`).join(", ")} }`;
  if (value.kind === "dict")
    return value.entries.length === 0
      ? "dict{}"
      : `dict{ ${value.entries.map((entry) => `${JSON.stringify(entry.key)}: ${shown(entry.value, true)}`).join(", ")} }`;
  if (value.kind === "date")
    return nested
      ? `<date ${formatIsoDate(value)}>`
      : presentDate(DEFAULT_TEMPORAL_CONTEXT.presentation, value);
  if (value.kind === "time")
    return nested
      ? `<time ${formatIsoTime(value)}>`
      : presentTime(DEFAULT_TEMPORAL_CONTEXT.presentation, value);
  if (value.kind === "datetime")
    return nested
      ? `<datetime ${formatIsoDateTime(value)}>`
      : presentDateTime(DEFAULT_TEMPORAL_CONTEXT.presentation, value);
  if (value.kind === "absoluteDateTime") {
    if (nested) return `<absoluteDateTime ${formatIsoTimestamp(value.epochMilliseconds)}>`;
    const fields = localFields(DEFAULT_TEMPORAL_CONTEXT.zone, value.epochMilliseconds);
    if (!fields.ok)
      throw new Underivable("a displayed absolute date outside the frozen zone rules");
    return presentDateTime(DEFAULT_TEMPORAL_CONTEXT.presentation, fields.value);
  }
  throw new Underivable(`the display of ${value.kind}`);
}
