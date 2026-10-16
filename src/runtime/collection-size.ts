import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * `TSR088`: `operation` would make a list, set, or dict larger than the host can hold. TeaseScript sets no size of its
 * own; V8 holds at most 134,217,728 elements in an array and 16,777,216 entries in a `Set` or `Map`.
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
