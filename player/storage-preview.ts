import { durationParts, formatDuration } from "../src/duration.js";
import type { SerializableRuntimeValue } from "../src/index.js";
import {
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
} from "../src/temporal.js";
import { isCapturedMediaReference } from "./captured-media.js";

/**
 * One saved value as Player Debug's Storage tab previews it: its type, a one-line text, the captured photo it is, and
 * how many members a composite has. Members are previewed only when asked for, so a wide or deep value costs nothing
 * until it is expanded.
 */
export interface StoragePreview {
  readonly type: string;
  readonly text: string;
  /** The captured-media reference, when the value is a saved photo. */
  readonly photo: string | null;
  /** The number of members of a list, set, object or dict; `null` for other values. */
  readonly size: number | null;
}

/** One member of a composite value, with the label that names it: an index, a property name, or a dict key. */
export interface StorageMember {
  readonly label: string;
  readonly value: SerializableRuntimeValue;
}

const PREVIEW_TEXT_LENGTH = 80;

function shortText(text: string): string {
  return text.length <= PREVIEW_TEXT_LENGTH ? text : `${text.slice(0, PREVIEW_TEXT_LENGTH - 1)}…`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function storagePreview(value: SerializableRuntimeValue): StoragePreview {
  const preview = (type: string, text: string, size: number | null = null): StoragePreview =>
    Object.freeze({ type, text, photo: null, size });
  if (value === null) return preview("Nothing", "null");
  if (typeof value === "string")
    return isCapturedMediaReference(value)
      ? Object.freeze({ type: "Photo", text: "Captured or chosen image", photo: value, size: null })
      : preview("Text", shortText(JSON.stringify(value)));
  if (typeof value === "number")
    return preview(Number.isInteger(value) ? "Integer" : "Number", String(value));
  if (typeof value === "boolean") return preview("Yes/no", value ? "true" : "false");
  switch (value.kind) {
    case "list":
      return preview("List", plural(value.items.length, "item", "items"), value.items.length);
    case "set":
      return preview("Set", plural(value.items.length, "item", "items"), value.items.length);
    case "object":
      return preview(
        "Object",
        plural(value.properties.length, "property", "properties"),
        value.properties.length,
      );
    case "dict":
      return preview(
        "Dict",
        plural(value.entries.length, "entry", "entries"),
        value.entries.length,
      );
    case "range":
      return preview(
        "Range",
        `${value.start} to ${value.end}${value.inclusive ? "" : ", end excluded"}`,
      );
    case "duration":
      return preview("Duration", formatDuration(durationParts(value)));
    case "date":
      return preview("Date", formatIsoDate(value));
    case "time":
      return preview("Time", formatIsoTime(value));
    case "datetime":
      return preview("Date and time", formatIsoDateTime(value));
    case "timestamp":
      return preview("Timestamp", formatIsoTimestamp(value.epochMilliseconds));
    case "script":
      return preview(
        "Script",
        value.label === null ? value.path : `${value.path}, label ${value.label}`,
      );
    default:
      // Handles to runtime objects never reach storage; a forged one is shown as what it claims to be.
      return preview(value.kind, "");
  }
}

/** The members of a list, set, object or dict, in their order; no members for any other value. */
export function storageMembers(value: SerializableRuntimeValue): readonly StorageMember[] {
  if (value === null || typeof value !== "object") return [];
  switch (value.kind) {
    case "list":
    case "set":
      return value.items.map((item, index) => ({ label: `[${index}]`, value: item }));
    case "object":
      return value.properties.map((property) => ({ label: property.name, value: property.value }));
    case "dict":
      return value.entries.map((entry) => ({
        label: JSON.stringify(entry.key),
        value: entry.value,
      }));
    default:
      return [];
  }
}
