import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";

function nestedTemplate(depth: number): string {
  let expression = "1";
  for (let index = 0; index < depth; index += 1) {
    expression = `\`level ${"${"}${expression}}\``;
  }
  return expression;
}

test("nested source beyond the former parser guard remains valid", () => {
  const depth = 96;
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["parentheses", `let value = ${"(".repeat(depth)}1${")".repeat(depth)}`],
    ["not chain", `let value = ${"not ".repeat(depth)}true`],
    ["unary chain", `let value = ${"-".repeat(depth)}1`],
    ["lists", `let value = ${"[".repeat(depth)}1${"]".repeat(depth)}`],
    ["objects", `let value = ${"{ value: ".repeat(depth)}1${" }".repeat(depth)}`],
    ["sets", `let value = ${"set[".repeat(depth)}1${"]".repeat(depth)}`],
    ["templates", `let value = ${nestedTemplate(depth)}`],
    ["blocks", `${"if true {\n".repeat(depth)}exit\n${"}\n".repeat(depth)}`],
  ];
  for (const [name, source] of cases) {
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], name);
  }

  for (const [name, source] of cases.slice(0, 3)) {
    const compiled = compileSource(source);
    assert.equal(compiled.plan === null, false, name);
    assert.deepEqual(compiled.diagnostics, [], name);
  }
});
