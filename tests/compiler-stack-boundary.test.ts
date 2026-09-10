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

test("flat, parenthesis, collection, object, and block compilation remain iterative with a constrained host stack", () => {
  const source = flatChain(1_024);
  const nestedSource = `let value = ${"(".repeat(1_024)}1${")".repeat(1_024)}`;
  const collectionSource = `let value = ${"[".repeat(1_024)}1${"]".repeat(1_024)}\nexit`;
  const setSource = `let value = ${"set[".repeat(1_024)}1${"]".repeat(1_024)}`;
  const objectSource = `let value = ${"{ value: ".repeat(1_024)}1${" }".repeat(1_024)}\nexit`;
  const blockSource = `${"if true {".repeat(1_024)}exit${"}".repeat(1_024)}`;
  const compilerUrl = new URL("../src/compiler.js", import.meta.url).href;
  const parserUrl = new URL("../src/parser.js", import.meta.url).href;
  const semanticUrl = new URL("../src/semantic.js", import.meta.url).href;
  const compilerLoweringUrl = new URL("../src/compiler/compile-program.js", import.meta.url).href;
  const runtimeStateUrl = new URL("../src/runtime/state.js", import.meta.url).href;
  const checkpointUrl = new URL("../src/runtime/checkpoint.js", import.meta.url).href;
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
    const compiledObject = compileSource(process.env.TEASESCRIPT_OBJECT_SOURCE);
    const deepObject = "{ x: ".repeat(1024) + "1" + " }".repeat(1024);
    const innerObjectCodes = ["{a:1, b:{q:1}}", "{a:{q:1}, b:2}", "{a:{q:1}.q}", "{a:{q:1} + 2}"].map((leaf) =>
      compileSource("let value = " + "{x:".repeat(1024) + leaf + "}".repeat(1024)).diagnostics.map((diagnostic) => diagnostic.code),
    );
    const siblingObjects = ["{ before: 2, child: " + deepObject + " }", "{ child: " + deepObject + ", after: 2 }"].map((expression) => {
      const compiled = compileSource("let value = " + expression);
      return {codes: compiled.diagnostics.map((diagnostic) => diagnostic.code), status: compiled.plan ? run(compiled.plan, createFreshRuntimeSnapshot(compiled.plan)).snapshot.status : null};
    });
    const compiledBlock = compileSource(process.env.TEASESCRIPT_BLOCK_SOURCE);
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
    const {createCheckpoint, restoreCheckpoint} = await import(${JSON.stringify(checkpointUrl)});
    const downstreamObjects = [
      "let value = " + deepObject + " == null",
      "function take(value = " + deepObject + ") { return value }\\nlet got = take()\\nexit",
    ].map((source) => {
      const compiled = compileSource(source);
      if (!compiled.plan) return {codes: compiled.diagnostics.map((diagnostic) => diagnostic.code), status: null};
      const result = run(compiled.plan, createFreshRuntimeSnapshot(compiled.plan));
      const restored = restoreCheckpoint(createCheckpoint(compiled.plan, result.snapshot));
      return {codes: [], status: restored.snapshot.status};
    });
    const objectRuntime = run(compiledObject.plan, createFreshRuntimeSnapshot(compiledObject.plan));
    const restoredObject = restoreCheckpoint(createCheckpoint(compiledObject.plan, objectRuntime.snapshot));
    let objectValue = restoredObject.snapshot.frames[0]?.bindings[0]?.value;
    let objectDepth = 0;
    while (objectValue?.kind === "object") {
      objectDepth += 1;
      objectValue = objectValue.properties[0].value;
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
      innerObjectCodes,
      downstreamObjects,
      siblingObjects,
      objectCodes: compiledObject.diagnostics.map((diagnostic) => diagnostic.code),
      objectRuntimeStatus: objectRuntime.snapshot.status,
      objectDepth,
      objectLeaf: objectValue,
      collectionCodes: compiledCollection.diagnostics.map((diagnostic) => diagnostic.code),
      collectionRuntimeStatus: runtimeResult.snapshot.status,
      collectionDepth,
      setCodeCount: compiledSet.diagnostics.length,
      setFirstCode: compiledSet.diagnostics[0]?.code,
      setLastCode: compiledSet.diagnostics.at(-1)?.code,
      setFirstStart: compiledSet.diagnostics[0]?.span.start.offset,
      setLastStart: compiledSet.diagnostics.at(-1)?.span.start.offset,
      blockCodes: compiledBlock.diagnostics.map((diagnostic) => diagnostic.code),
      blockProgramStatements: compiledBlock.program.statements.length,
      blockSpan: [compiledBlock.program.span.start.offset, compiledBlock.program.span.end.offset],
      blockRuntimeStatus: run(compiledBlock.plan, createFreshRuntimeSnapshot(compiledBlock.plan)).snapshot.status,
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
        TEASESCRIPT_OBJECT_SOURCE: objectSource,
        TEASESCRIPT_SET_SOURCE: setSource,
        TEASESCRIPT_BLOCK_SOURCE: blockSource,
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
    innerObjectCodes: [[], [], [], []],
    downstreamObjects: [
      { codes: [], status: "halted" },
      { codes: [], status: "halted" },
    ],
    siblingObjects: [
      { codes: [], status: "halted" },
      { codes: [], status: "halted" },
    ],
    objectCodes: [],
    objectRuntimeStatus: "halted",
    objectDepth: 1_024,
    objectLeaf: 1,
    collectionCodes: [],
    collectionRuntimeStatus: "halted",
    collectionDepth: 1_024,
    setCodeCount: 1_023,
    setFirstCode: "TSV006",
    setLastCode: "TSV006",
    setFirstStart: 4_104,
    setLastStart: 16,
    blockCodes: [],
    blockProgramStatements: 1,
    blockSpan: [0, blockSource.length],
    blockRuntimeStatus: "halted",
  });
});

test("compiler containment recognizes native stack failures without relying on a failure depth", () => {
  const source = "let value = 1";
  for (const error of [
    new RangeError("Maximum call stack size exceeded"),
    new RangeError("Stack overflow"),
    new SyntaxError("Invalid regular expression: /[.eE]/u: Stack overflow"),
  ]) {
    const original = RegExp.prototype.test;
    let result;
    RegExp.prototype.test = () => {
      throw error;
    };
    try {
      result = compileSource(source);
    } finally {
      RegExp.prototype.test = original;
    }
    assert.equal(result.plan, null);
    assert.deepEqual(result.program.statements, []);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["TSC007"],
    );
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [[0, source.length]],
    );
  }
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
