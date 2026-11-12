// The type enforcement tests' shared setup (tests/type-core/enforcement/): each diagnostic of a source with its code,
// message and text, and what a run says.

import assert from "node:assert/strict";

import { compileSource } from "../../../src/compiler.js";
import { runValidSource } from "../run-valid-source.js";

export function mismatches(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** The code and source text of each diagnostic, for tests whose exact wording is covered elsewhere. */
export function codes(source: string): [string, string][] {
  return mismatches(source).map(([code, , text]) => [code, text]);
}

export function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}
