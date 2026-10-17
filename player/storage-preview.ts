import { runtimeDebugPreview, type SerializableRuntimeValue } from "../src/index.js";
import { isWellFormedCapturedMediaReference } from "./captured-media.js";

/**
 * One saved value as Player Debug's Storage tab previews it: its type, its notation as Variables shows a value, and how
 * many members a composite has. Text shaped like a captured-media reference stays text; it is only a candidate for a
 * saved photo, which the Player's media store confirms or not.
 */
export interface StoragePreview {
  readonly type: string;
  /** The engine's notation of the value (`runtimeDebugPreview`), ending in `…` where its preview limit cut it off. */
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

/**
 * The engine's notation of a saved value or key, as Variables shows a value: written only up to the preview limit, then
 * `…`.
 */
export function storageNotation(value: SerializableRuntimeValue): string {
  const { text, truncated } = runtimeDebugPreview(value);
  return truncated ? `${text}…` : text;
}

const TYPES: Readonly<
  Partial<Record<Extract<SerializableRuntimeValue, { readonly kind: string }>["kind"], string>>
> = {
  list: "List",
  set: "Set",
  object: "Object",
  dict: "Dict",
  range: "Range",
  duration: "Duration",
  calendarDuration: "Calendar duration",
  angle: "Angle",
  date: "Date",
  time: "Time",
  datetime: "Date and time",
  absoluteDateTime: "Absolute date and time",
  script: "Script",
  regex: "Regex",
};

function typeOf(value: SerializableRuntimeValue): string {
  if (value === null) return "Nothing";
  if (typeof value === "string") return "Text";
  if (typeof value === "number") return Number.isInteger(value) ? "Integer" : "Number";
  if (typeof value === "boolean") return "Yes/no";
  // Handles to runtime objects never reach storage; one would show its kind.
  return TYPES[value.kind] ?? value.kind;
}

function sizeOf(value: SerializableRuntimeValue): number | null {
  if (value === null || typeof value !== "object") return null;
  switch (value.kind) {
    case "list":
    case "set":
      return value.items.length;
    case "object":
      return value.properties.length;
    case "dict":
      return value.entries.length;
    default:
      return null;
  }
}

export function storagePreview(value: SerializableRuntimeValue): StoragePreview {
  return Object.freeze({
    type: typeOf(value),
    text: storageNotation(value),
    photo: typeof value === "string" && isWellFormedCapturedMediaReference(value) ? value : null,
    size: sizeOf(value),
  });
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
        .map((entry) => ({ label: storageNotation(entry.key), value: entry.value }));
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
