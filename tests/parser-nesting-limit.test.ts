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

test("linear prefix depth does not become plan depth", () => {
  const sources = [
    ["not", `let value = ${"not ".repeat(10_000)}true\nexit`],
    ["unary minus", `let value = ${"-".repeat(10_000)}1\nexit`],
    ["parentheses", `let value = ${"(".repeat(500)}1${")".repeat(500)}\nexit`],
  ] as const;

  for (const [name, source] of sources) {
    const compiled = compileSource(source);
    assert.deepEqual(compiled.diagnostics, [], name);
    assert.notEqual(compiled.plan, null, name);
    assert.equal(compiled.plan!.instructions.length, 2, name);
  }
});

test("parentheses do not inflate pure expression plans", () => {
  const expression = `${"(".repeat(500)}1${")".repeat(500)}`;
  const compiled = compileSource(`speaker vera { value: ${expression} }\nexit`);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const declaration = compiled.plan!.instructions[0];
  assert.equal(declaration?.kind, "declareSpeaker");
  if (declaration?.kind !== "declareSpeaker") return;
  assert.equal(declaration.properties[0]?.value.kind, "literal");
});
