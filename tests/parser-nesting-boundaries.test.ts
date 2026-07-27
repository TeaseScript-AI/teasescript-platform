import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PARSER_NESTING_DEPTH, parse } from "../src/parser.js";

function hasDepthDiagnostic(source: string): boolean {
  return parse(source).diagnostics.some((diagnostic) => diagnostic.code === "TSP027");
}

function nestedTemplate(depth: number): string {
  let expression = "1";
  for (let index = 0; index < depth; index += 1) {
    expression = `\`level ${"${"}${expression}}\``;
  }
  return expression;
}

function nestedBlocks(depth: number): string {
  return `${"if true {\n".repeat(depth)}exit\n${"}\n".repeat(depth)}`;
}

test("parser nesting limit counts actual recursive expression syntax", () => {
  const accepted = MAX_PARSER_NESTING_DEPTH;
  const rejected = accepted + 1;
  const cases = [
    ["parentheses", `${"(".repeat(accepted)}1${")".repeat(accepted)}`, `${"(".repeat(rejected)}1${")".repeat(rejected)}`],
    ["not", `${"not ".repeat(accepted)}true`, `${"not ".repeat(rejected)}true`],
    ["unary", `${"-".repeat(accepted)}1`, `${"-".repeat(rejected)}1`],
    ["lists", `${"[".repeat(accepted)}1${"]".repeat(accepted)}`, `${"[".repeat(rejected)}1${"]".repeat(rejected)}`],
    ["templates", nestedTemplate(accepted), nestedTemplate(rejected)],
  ] as const;
  for (const [name, below, above] of cases) {
    assert.equal(hasDepthDiagnostic(below), false, `${name} at boundary`);
    assert.equal(hasDepthDiagnostic(above), true, `${name} above boundary`);
  }
});

test("nested blocks have an exact boundary in recursive syntax entries", () => {
  const acceptedBlocks = MAX_PARSER_NESTING_DEPTH / 2;
  assert.equal(Number.isInteger(acceptedBlocks), true);
  assert.equal(hasDepthDiagnostic(nestedBlocks(acceptedBlocks)), false);
  assert.equal(hasDepthDiagnostic(nestedBlocks(acceptedBlocks + 1)), true);
});
