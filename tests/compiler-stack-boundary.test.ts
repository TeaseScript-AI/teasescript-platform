import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileSource } from "../src/index.js";

test("large flat chains complete full compilation with source provenance", () => {
  for (const termCount of [200, 1_600, 6_400, 12_800]) {
    const source = flatChain(termCount);
    const result = compileSource(source);
    assert.deepEqual(result.diagnostics, []);
    assert.notEqual(result.plan, null);
    const declaration = result.plan!.instructions[0];
    assert.equal(declaration?.kind, "declareBinding");
    assert.deepEqual(
      declaration === undefined ? null : [declaration.span.so, declaration.span.eo],
      [0, source.length],
    );
    assert.equal(declaration?.kind === "declareBinding" ? declaration.value.kind : null, "binary");
  }
});

test("flat, parenthesis, and collection compilation remain iterative with a constrained host stack", () => {
  const source = flatChain(1_024);
  const nestedSource = `let value = ${"(".repeat(1_024)}1${")".repeat(1_024)}`;
  const collectionSource = `let value = ${"[".repeat(1_024)}1${"]".repeat(1_024)}\nexit`;
  const setSource = `let value = ${"set[".repeat(1_024)}1${"]".repeat(1_024)}`;
  const residualNestedSource = `let value = ${"{ value: ".repeat(256)}1${" }".repeat(256)}`;
  const compilerUrl = new URL("../src/compiler.js", import.meta.url).href;
  const parserUrl = new URL("../src/parser.js", import.meta.url).href;
  const semanticUrl = new URL("../src/semantic.js", import.meta.url).href;
  const compilerLoweringUrl = new URL("../src/compiler/compile-program.js", import.meta.url).href;
  const runtimeStateUrl = new URL("../src/runtime/state.js", import.meta.url).href;
  const runtimeEngineUrl = new URL("../src/runtime/engine.js", import.meta.url).href;
  const script = `
    const [
      { compileSource },
      { parse },
      { validateSemantics },
      { compileStableProgram },
      { createFreshRuntimeSnapshot },
      { run },
    ] = await Promise.all([
      import(${JSON.stringify(compilerUrl)}),
      import(${JSON.stringify(parserUrl)}),
      import(${JSON.stringify(semanticUrl)}),
      import(${JSON.stringify(compilerLoweringUrl)}),
      import(${JSON.stringify(runtimeStateUrl)}),
      import(${JSON.stringify(runtimeEngineUrl)}),
    ]);
    const source = process.env.TEASESCRIPT_STACK_SOURCE;
    const parsed = parse(source);
    const semantic = validateSemantics(parsed.program);
    const plan = compileStableProgram(parsed.program);
    const compiledFlat = compileSource(source);
    const compiledNested = compileSource(process.env.TEASESCRIPT_NESTED_SOURCE);
    const compiledCollection = compileSource(process.env.TEASESCRIPT_COLLECTION_SOURCE);
    const compiledSet = compileSource(process.env.TEASESCRIPT_SET_SOURCE);
    const containedResidual = compileSource(process.env.TEASESCRIPT_RESIDUAL_NESTED_SOURCE);
    const runtimeResult = run(
      compiledCollection.plan,
      createFreshRuntimeSnapshot(compiledCollection.plan, {
        baseDelayMs: 0,
        delayPerWordMs: 0,
        delayPerCharacterMs: 0,
      }),
    );
    let collectionValue = runtimeResult.snapshot.frames[0]?.bindings[0]?.value;
    let collectionDepth = 0;
    while (collectionValue?.kind === "list") {
      collectionDepth += 1;
      collectionValue = collectionValue.items[0];
    }
    process.stdout.write(JSON.stringify({
      parserDiagnostics: parsed.diagnostics.length,
      semanticDiagnostics: semantic.diagnostics.length,
      instructionKinds: plan.instructions.map((instruction) => instruction.kind),
      expressionKind: plan.instructions[0]?.value?.kind,
      compiledFlatCodes: compiledFlat.diagnostics.map((diagnostic) => diagnostic.code),
      compiledFlatExpressionKind: compiledFlat.plan?.instructions[0]?.value?.kind,
      compiledNestedCodes: compiledNested.diagnostics.map((diagnostic) => diagnostic.code),
      compiledNestedProgramStatements: compiledNested.program.statements.length,
      compiledNestedExpressionKind: compiledNested.plan?.instructions[0]?.value?.kind,
      collectionCodes: compiledCollection.diagnostics.map((diagnostic) => diagnostic.code),
      collectionRuntimeStatus: runtimeResult.snapshot.status,
      collectionDepth,
      setCodeCount: compiledSet.diagnostics.length,
      setFirstCode: compiledSet.diagnostics[0]?.code,
      setLastCode: compiledSet.diagnostics.at(-1)?.code,
      setFirstStart: compiledSet.diagnostics[0]?.span.start.offset,
      setLastStart: compiledSet.diagnostics.at(-1)?.span.start.offset,
      residualCodes: containedResidual.diagnostics.map((diagnostic) => diagnostic.code),
      residualProgramStatements: containedResidual.program.statements.length,
      residualSpan: containedResidual.diagnostics.map((diagnostic) => [
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
    }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEASESCRIPT_STACK_SOURCE: source,
        TEASESCRIPT_NESTED_SOURCE: nestedSource,
        TEASESCRIPT_COLLECTION_SOURCE: collectionSource,
        TEASESCRIPT_SET_SOURCE: setSource,
        TEASESCRIPT_RESIDUAL_NESTED_SOURCE: residualNestedSource,
      },
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.deepEqual(JSON.parse(child.stdout), {
    parserDiagnostics: 0,
    semanticDiagnostics: 0,
    instructionKinds: ["declareBinding"],
    expressionKind: "binary",
    compiledFlatCodes: [],
    compiledFlatExpressionKind: "binary",
    compiledNestedCodes: [],
    compiledNestedProgramStatements: 1,
    compiledNestedExpressionKind: "literal",
    collectionCodes: [],
    collectionRuntimeStatus: "halted",
    collectionDepth: 1_024,
    setCodeCount: 1_023,
    setFirstCode: "TSV006",
    setLastCode: "TSV006",
    setFirstStart: 4_104,
    setLastStart: 16,
    residualCodes: ["TSC007"],
    residualProgramStatements: 0,
    residualSpan: [[0, residualNestedSource.length]],
  });
});

test("compileSource does not convert unrelated RangeErrors into diagnostics", () => {
  const error = new RangeError("unrelated compiler failure");
  const original = RegExp.prototype.test;
  RegExp.prototype.test = () => {
    throw error;
  };
  try {
    assert.throws(
      () => compileSource("let value = 1"),
      (received: unknown) => received === error,
    );
  } finally {
    RegExp.prototype.test = original;
  }
});

function flatChain(termCount: number): string {
  return `let value = ${Array.from({ length: termCount }, (_, index) => index % 10).join(" + ")}`;
}
