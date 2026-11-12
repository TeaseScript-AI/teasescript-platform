// The narrowing tests' shared setup (tests/type-core/narrowing/): a program's narrowing pass, a read at a marker, and
// the cases' checker.

import assert from "node:assert/strict";

import { type CorePass } from "../../../src/type-inference/core/answers.js";
import { coreRequest } from "../type-core-analysis.js";
import { narrowingAt, narrowingPass, nodeAt } from "./type-core-narrowing.js";

export const FLAG = 'let flagHost = askBoolean "flag"';
export const NULLABLE = [FLAG, "let n = 1", "if flagHost { n = null }"];

export interface Analysed {
  readonly pass: CorePass;
  readonly source: string;
}

export function pass(...lines: readonly string[]): Analysed {
  const source = `${lines.join("\n")}\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, `the program parses and resolves:\n${source}`);
  return { pass: narrowingPass(request), source };
}

/** The read `delta` code units into the last occurrence of `marker` in the source. */
export function read(analysed: Analysed, marker: string, delta: number) {
  const offset = analysed.source.lastIndexOf(marker);
  assert.ok(offset >= 0, `the source holds '${marker}'`);
  return nodeAt(analysed.pass, offset + delta);
}

/** N2 at a read: its narrowing's form and whether it holds or the failing word; `none` without one. */
export function at(analysed: Analysed, marker: string, delta: number): string {
  const found = narrowingAt(analysed.pass, read(analysed, marker, delta));
  if (found === null) return "none";
  const form = found.g.form;
  const kinds =
    (form.kind === "is" || form.kind === "is-not") && form.kinds.length > 0
      ? ` ${form.kinds.join("|")}`
      : "";
  return `${form.kind}${kinds}${found.g.elements > 0 ? " element" : ""}: ${found.fails ?? "holds"}`;
}

export type Case = readonly [string, readonly string[], string, number, string];

/** Each case's read, `delta` into the last occurrence of its marker, against its expected answer. */
export function check(
  cases: readonly Case[],
  ask: (analysed: Analysed, marker: string, delta: number) => string,
): void {
  for (const [name, lines, marker, delta, expected] of cases)
    assert.equal(ask(pass(...lines), marker, delta), expected, name);
}

export const REPEAT = "repeat n {}";
