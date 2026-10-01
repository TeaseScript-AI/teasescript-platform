import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function nestedString(depth: number): string {
  let expression = "1";
  for (let index = 0; index < depth; index += 1) {
    expression = `"level ${"${"}${expression}}"`;
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
    ["strings", `let value = ${nestedString(depth)}`],
    ["blocks", `${"if true {\n".repeat(depth)}exit\n${"}\n".repeat(depth)}`],
  ];
  for (const [name, source] of cases) {
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], name);
  }

  for (const [name, source] of cases) {
    const compiled = compileSource(source);
    if (name === "sets") {
      assert.equal(compiled.plan, null, name);
      assert.ok(
        compiled.diagnostics.every((diagnostic) => diagnostic.code === "TSV006"),
        name,
      );
    } else {
      assert.notEqual(compiled.plan, null, name);
      assert.deepEqual(compiled.diagnostics, [], name);
    }
  }
});

test("deep linear prefix chains compile and evaluate without native recursion", () => {
  // An even count of `not` or `-` cancels out; an odd count applies once.
  const sources = [
    ["even not", `let value = ${"not ".repeat(10_000)}true\nexit`, true],
    ["odd not", `let value = ${"not ".repeat(9_999)}true\nexit`, false],
    ["even unary minus", `let value = ${"-".repeat(10_000)}1\nexit`, 1],
    ["odd unary minus", `let value = ${"-".repeat(9_999)}1\nexit`, -1],
    ["parentheses", `let value = ${"(".repeat(500)}1${")".repeat(500)}\nexit`, 1],
  ] as const;

  for (const [name, source, expected] of sources) {
    const compiled = compileSource(source);
    assert.deepEqual(compiled.diagnostics, [], name);
    assert.notEqual(compiled.plan, null, name);
    const result = runValidSource(source);
    assert.equal(result.snapshot.status, "halted", name);
    assert.equal(
      result.snapshot.frames[0]?.bindings.find((binding) => binding.name === "value")?.value,
      expected,
      name,
    );
  }
});

test("deep parentheses in a direct speaker property evaluate to the grouped value", () => {
  const expression = `${"(".repeat(500)}1${")".repeat(500)}`;
  const result = runValidSource(`speaker vera { value: ${expression} }\nsay vera.value + 1\nexit`);
  assert.deepEqual(sayTexts(result), ["2"]);
  assert.equal(result.snapshot.status, "halted");
});

test("deep parenthesis chains execute through the source-to-runtime path", () => {
  const depth = 2_000;
  const expression = `${"(".repeat(depth)}41${")".repeat(depth)}`;
  const result = runValidSource(`let value = ${expression}\nsay value + 1\nexit`);
  assert.deepEqual(sayTexts(result), ["42"]);
  assert.equal(result.snapshot.status, "halted");
});

test("deep list chains compile in direct expression-plan contexts", () => {
  const depth = 2_000;
  const expression = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  const compiled = compileSource(`speaker vera { value: ${expression} }\nexit`);
  assert.deepEqual(compiled.diagnostics, []);
  const declaration = compiled.plan?.instructions[0];
  assert.equal(declaration?.kind, "declareSpeaker");
  if (declaration?.kind !== "declareSpeaker") return;
  let value = declaration.properties[0]?.value;
  let observedDepth = 0;
  while (value?.kind === "list") {
    observedDepth += 1;
    value = value.elements[0];
  }
  assert.equal(observedDepth, depth);
  assert.equal(value?.kind, "literal");
});

test("deep collection parameter defaults retain semantic diagnostic order", () => {
  const depth = 2_000;
  const wrap = (expression: string) => `${"[".repeat(depth)}${expression}${"]".repeat(depth)}`;
  const interaction = compileSource(`function sample(value = ${wrap("askText")}) {\nexit\n}`);
  assert.deepEqual(
    interaction.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV032"],
  );

  const laterReference = compileSource(
    `function sample(value = ${wrap("later")}, later = 1) {\nexit\n}`,
  );
  assert.deepEqual(
    laterReference.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV025", "TSV002"],
  );
});
