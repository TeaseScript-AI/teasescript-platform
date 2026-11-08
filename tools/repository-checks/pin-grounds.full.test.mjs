import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { refusalsOf } from "./pin-grounds.mjs";

// The full mutation of `pin-grounds.mjs`'s readers, apart from `test:verification` for its time: a change to the
// readers runs it (`node --test tools/repository-checks/pin-grounds.full.test.mjs`) and quotes its result.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const { positions } = JSON.parse(
  readFileSync(new URL("./pin-grounds.cases.json", import.meta.url), "utf8"),
);

test("each expected value Codex r3 found, moved by one, is refused without its ground and passes with one", () => {
  for (const [file, line, column, text] of positions) {
    const lines = read(file).split("\n");
    const at = `${file}:${line}:${column + 1} ${text}`;
    assert.equal(lines[line - 1].slice(column, column + text.length), text, at);
    const moved = `${lines[line - 1].slice(0, column)}${Number(text.replaceAll("_", "")) + 1}${lines[line - 1].slice(column + text.length)}`;
    const head = [...lines.slice(0, line - 1), moved, ...lines.slice(line)].join("\n");
    const [refusal, ...more] = refusalsOf(file, read(file), head, [line]);
    assert.deepEqual(more, [], at);
    assert.match(refusal ?? "", new RegExp(`^${file}:\\d+: .*new or re-pinned`, "u"), at);
    // (the ground written directly above, once a line)
    if (
      positions.some(
        ([other, otherLine, otherColumn]) =>
          other === file && otherLine === line && otherColumn < column,
      )
    )
      continue;
    const indent = moved.slice(0, moved.length - moved.trimStart().length);
    const grounded = [
      ...lines.slice(0, line - 1),
      `${indent}// (1 unit more since #1)`,
      moved,
      ...lines.slice(line),
    ].join("\n");
    assert.deepEqual(refusalsOf(file, read(file), grounded, [line, line + 1]), [], at);
  }
});
