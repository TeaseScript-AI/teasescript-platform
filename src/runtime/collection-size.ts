import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import { groupedDigits } from "./text-length.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * The most elements a list, members a set, and keys a dict can hold (owner decision, 2026-10-17): see
 * `docs/RESOURCE-LIMITS.md`. `range.toList()` makes at most this many numbers too.
 */
export const MAX_COLLECTION_LENGTH = 1_000_000;

export type CollectionKind = "list" | "set" | "dict";

/** The name of a kind of collection at the start of a message, and what it holds. */
const COLLECTION_WORDS: Readonly<Record<CollectionKind, readonly [string, string]>> = {
  list: ["List", "elements"],
  set: ["Set", "members"],
  dict: ["Dict", "keys"],
};

/** `TSR088`: `operation` would make a `kind` of `length` elements, members, or keys, more than `MAX_COLLECTION_LENGTH`. */
export function collectionTooLong(
  kind: CollectionKind,
  operation: string,
  span: SourceSpan,
  length: number,
): RuntimeFault {
  const [name, parts] = COLLECTION_WORDS[kind];
  return new RuntimeFault(
    "TSR088",
    `${name} too long: ${operation} would make a ${kind} of ${groupedDigits(length)} ${parts}, but a ${kind} can hold at most ${groupedDigits(MAX_COLLECTION_LENGTH)}. Build a shorter ${kind}.`,
    copySpan(span),
  );
}

/**
 * Fails with `TSR088` before `operation` makes a `kind` of `length` elements, members, or keys, more than it can hold and
 * more than `longest`, the longest collection it is made from (0 for none). A collection restored longer than the limit
 * from an older save keeps working until something would make it, or a collection made from it, longer still.
 */
export function checkCollectionLength(
  kind: CollectionKind,
  length: number,
  longest: number,
  operation: string,
  span: SourceSpan,
): void {
  if (length > MAX_COLLECTION_LENGTH && length > longest)
    throw collectionTooLong(kind, operation, span, length);
}

/**
 * `TSR088` where no check foresaw it: `operation` would make a list, set, or dict larger than the host can hold. V8 holds
 * at most 134,217,728 elements in an array and 16,777,216 entries in a `Set` or `Map`.
 */
export function collectionTooLarge(operation: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(
    "TSR088",
    `Collection too large: ${operation} would make a list, set, or dict larger than this browser can hold. Build a smaller one.`,
    copySpan(span),
  );
}

/** The messages with which V8 refuses to grow an array, a `Set`, or a `Map` past what it can hold. */
const HOST_COLLECTION_LIMITS: ReadonlySet<string> = new Set([
  "Invalid array length",
  "Set maximum size exceeded",
  "Map maximum size exceeded",
]);

/** Whether `error` is V8 refusing to grow an array, a `Set`, or a `Map`, which no check foresaw. */
export function exceedsHostCollectionSize(error: unknown): boolean {
  return error instanceof RangeError && HOST_COLLECTION_LIMITS.has(error.message);
}
