import { durationParts, formatDuration } from "../src/duration.js";
import type { SerializableRuntimeValue } from "../src/index.js";
import {
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
} from "../src/temporal.js";
import { isWellFormedCapturedMediaReference } from "./captured-media.js";

/**
 * One saved value as Player Debug's Storage tab previews it: its type, a one-line text, and how many members a
 * composite has. Text shaped like a captured-media reference stays text; it is only a candidate for a saved photo, which
 * the Player's media store confirms or not.
 */
export interface StoragePreview {
  readonly type: string;
  readonly text: string;
  /** The captured-media reference this text has the shape of, which may name a saved photo; otherwise `null`. */
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
    return Object.freeze({
      type: "Text",
      text: shortText(JSON.stringify(value)),
      photo: isWellFormedCapturedMediaReference(value) ? value : null,
      size: null,
    });
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
    case "absoluteDateTime":
      return preview("Absolute date and time", formatIsoTimestamp(value.epochMilliseconds));
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

/**
 * The first `limit` members of a list, set, object or dict, in their order; no members for any other value. Only those
 * are built, so a wide value costs what is shown.
 */
export function storageMembers(
  value: SerializableRuntimeValue,
  limit = Number.POSITIVE_INFINITY,
): readonly StorageMember[] {
  if (value === null || typeof value !== "object") return [];
  switch (value.kind) {
    case "list":
    case "set":
      return value.items
        .slice(0, limit)
        .map((item, index) => ({ label: `[${index}]`, value: item }));
    case "object":
      return value.properties
        .slice(0, limit)
        .map((property) => ({ label: property.name, value: property.value }));
    case "dict":
      return value.entries
        .slice(0, limit)
        .map((entry) => ({ label: JSON.stringify(entry.key), value: entry.value }));
    default:
      return [];
  }
}

/** How many members an expanded composite shows at first, and how many more each "Show more" adds. */
export const STORAGE_MEMBER_PAGE = 20;

/** One line of a saved value's expanded outline: a value, or the "show more" line after a composite's shown members. */
export type StorageOutlineRow =
  | {
      readonly kind: "value";
      /** Identifies the value within the saved value: member positions from the top, joined by `/`. */
      readonly path: string;
      readonly depth: number;
      readonly label: string | null;
      readonly value: SerializableRuntimeValue;
      readonly preview: StoragePreview;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "more";
      readonly path: string;
      readonly depth: number;
      readonly shown: number;
      readonly size: number;
    };

/**
 * The lines a saved value shows: the value itself and, for each expanded composite, its first members, page by page.
 * Built without recursion, and only as far as the player expanded, so a wide or deep value costs only what is shown.
 */
export function storageOutline(
  value: SerializableRuntimeValue,
  expanded: ReadonlySet<string>,
  pages: ReadonlyMap<string, number>,
): StorageOutlineRow[] {
  const rows: StorageOutlineRow[] = [];
  type Pending =
    | {
        kind: "value";
        path: string;
        depth: number;
        label: string | null;
        value: SerializableRuntimeValue;
      }
    | { kind: "more"; path: string; depth: number; shown: number; size: number };
  const pending: Pending[] = [{ kind: "value", path: "", depth: 0, label: null, value }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.kind === "more") {
      rows.push(next);
      continue;
    }
    const preview = storagePreview(next.value);
    const open = preview.size !== null && preview.size > 0 && expanded.has(next.path);
    rows.push({ ...next, preview, expanded: open });
    if (!open) continue;
    const size = preview.size!;
    const shown = Math.min(size, (pages.get(next.path) ?? 1) * STORAGE_MEMBER_PAGE);
    const members = storageMembers(next.value, shown);
    // Pushed in reverse, so they come off the stack in order, followed by the "show more" line.
    if (shown < size)
      pending.push({ kind: "more", path: next.path, depth: next.depth + 1, shown, size });
    for (let index = shown - 1; index >= 0; index -= 1)
      pending.push({
        kind: "value",
        path: `${next.path}/${index}`,
        depth: next.depth + 1,
        label: members[index]!.label,
        value: members[index]!.value,
      });
  }
  return rows;
}
