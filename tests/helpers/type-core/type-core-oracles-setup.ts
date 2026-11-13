// The oracle library's control tests' shared setup (tests/type-core/oracles/): a source's globals, a program of one
// main file, a hash, a small allowance and an answer's cells.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type SourceFile } from "../type-core-analysis.js";

export const GLOBALS = ["hostValue", "hostOther", "hostInit"];

export const main = (source: string): SourceFile[] => [{ path: "main.tease", source }];
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const SMALL = [
  'let box = {n: 1, m: "a"}\nbox.n = 2\nsay box.m\nexit\n',
  "let xs = [1, 2]\nxs.add(3)\nfor x in xs { say x }\nexit\n",
  "let v = hostValue\nlet w = {p: v}\nsay w.p\nexit\n",
];

/** An occurrence answer's cells, as the oracle's questions count them: its own, its element's, each property's. */
export const cellsOf = (answer: unknown): number => {
  assert.ok(Array.isArray(answer));
  const [, , , , , element, properties] = answer;
  return 1 + (element === null ? 0 : 1) + (Array.isArray(properties) ? properties.length : 0);
};
