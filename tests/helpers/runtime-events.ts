import assert from "node:assert/strict";

import type { RuntimeOperationResult } from "../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";

export function sayTexts(result: { readonly events: readonly InterpreterEvent[] }): string[] {
  return result.events.filter((event) => event.kind === "say").map((event) => event.text);
}

/**
 * Requires a structured runtime failure with `code` located at the first occurrence of `text` in `source`, published
 * as the final `runtimeFailure` event.
 */
export function assertFailedAt(
  result: RuntimeOperationResult,
  source: string,
  code: string,
  text: string,
): void {
  const start = source.indexOf(text);
  assert.ok(start >= 0, `${JSON.stringify(text)} must occur in the source`);
  const failure = result.snapshot.failure;
  assert.equal(result.snapshot.status, "failed");
  assert.ok(failure !== null);
  assert.deepEqual(
    [failure.code, failure.span.start.offset, failure.span.end.offset],
    [code, start, start + text.length],
  );
  const event = result.events.at(-1);
  assert.ok(event?.kind === "runtimeFailure");
  assert.deepEqual([event.code, event.span], [failure.code, failure.span]);
}
