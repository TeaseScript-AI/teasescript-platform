import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { MAX_PARSER_NESTING_DEPTH, parse } from "../src/parser.js";

function assertDepthDiagnostic(name: string, source: string): void {
  assert.ok(source.length < 65_536, name);
  let parsed: ReturnType<typeof parse> | null = null;
  assert.doesNotThrow(() => { parsed = parse(source); }, name);
  const diagnostics = parsed!.diagnostics.filter(
    (diagnostic) => diagnostic.code === "TSP027",
  );
  assert.equal(diagnostics.length, 1, name);
  assert.equal(diagnostics[0]!.severity, "error", name);
  assert.ok(diagnostics[0]!.span.start.offset >= 0, name);
  assert.ok(diagnostics[0]!.span.end.offset <= source.length, name);

  let compiled: ReturnType<typeof compileSource> | null = null;
  assert.doesNotThrow(() => { compiled = compileSource(source); }, name);
  assert.equal(compiled!.plan, null, name);
  assert.equal(
    compiled!.diagnostics.filter((diagnostic) => diagnostic.code === "TSP027").length,
    1,
    name,
  );
}

test("deep recursive source forms return a bounded parser diagnostic", () => {
  const templateDepth = 200;
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["parentheses", `${"(".repeat(20_000)}1${")".repeat(20_000)}`],
    ["not chain", `${"not ".repeat(12_000)}true`],
    ["unary chain", `${"-".repeat(40_000)}1`],
    ["nested lists", `${"[".repeat(20_000)}1${"]".repeat(20_000)}`],
    ["nested templates", `${"`${".repeat(templateDepth)}1${"}`".repeat(templateDepth)}`],
    ["nested blocks", `${"if true {\n".repeat(2_000)}exit\n${"}\n".repeat(2_000)}`],
  ];
  for (const [name, source] of cases) assertDepthDiagnostic(name, source);
});

test("ordinary nested sources below the parser limit retain behavior", () => {
  assert.equal(MAX_PARSER_NESTING_DEPTH, 64);
  const cases = [
    `${"(".repeat(8)}1${")".repeat(8)}`,
    `${"not ".repeat(16)}true`,
    `${"-".repeat(16)}1`,
    `${"[".repeat(8)}1${"]".repeat(8)}`,
    `${"if true {\n".repeat(8)}exit\n${"}\n".repeat(8)}`,
  ];
  for (const source of cases) {
    const first = parse(source);
    const second = parse(source);
    assert.deepEqual(first.diagnostics, second.diagnostics);
    assert.equal(first.diagnostics.some((diagnostic) => diagnostic.code === "TSP027"), false);
  }
});

test("malformed over-limit input recovers deterministically", () => {
  const source = `${"(".repeat(200)}1`;
  const first = parse(source);
  const second = parse(source);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.diagnostics.filter((diagnostic) => diagnostic.code === "TSP027").length, 1);
});
