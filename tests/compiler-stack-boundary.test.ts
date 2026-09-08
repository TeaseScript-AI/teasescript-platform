import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileSource } from "../src/index.js";

test("large flat chains complete or return the host-stack diagnostic with full provenance", () => {
  let completedPlans = 0;
  for (const termCount of [200, 1_600, 6_400, 12_800]) {
    const source = flatChain(termCount);
    const result = compileSource(source);
    if (result.plan === null) {
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
      continue;
    }

    completedPlans += 1;
    assert.deepEqual(result.diagnostics, []);
    const declaration = result.plan.instructions[0];
    assert.equal(declaration?.kind, "declareBinding");
    assert.deepEqual(
      declaration === undefined ? null : [declaration.span.so, declaration.span.eo],
      [0, source.length],
    );
    assert.equal(declaration?.kind === "declareBinding" ? declaration.value.kind : null, "binary");
  }
  assert.ok(completedPlans > 0);
});

test("flat-chain semantic validation and lowering remain iterative with a constrained host stack", () => {
  const source = flatChain(1_024);
  const nestedSource = `let value = ${"(".repeat(256)}1${")".repeat(256)}`;
  const compilerUrl = new URL("../src/compiler.js", import.meta.url).href;
  const parserUrl = new URL("../src/parser.js", import.meta.url).href;
  const semanticUrl = new URL("../src/semantic.js", import.meta.url).href;
  const compileProgramUrl = new URL("../src/compiler/compile-program.js", import.meta.url).href;
  const script = `
    const [{ compileSource }, { parse }, { validateSemantics }, { compileStableProgram }] = await Promise.all([
      import(${JSON.stringify(compilerUrl)}),
      import(${JSON.stringify(parserUrl)}),
      import(${JSON.stringify(semanticUrl)}),
      import(${JSON.stringify(compileProgramUrl)}),
    ]);
    const source = process.env.TEASESCRIPT_STACK_SOURCE;
    const parsed = parse(source);
    const semantic = validateSemantics(parsed.program);
    const plan = compileStableProgram(parsed.program);
    const contained = compileSource(process.env.TEASESCRIPT_NESTED_SOURCE);
    process.stdout.write(JSON.stringify({
      parserDiagnostics: parsed.diagnostics.length,
      semanticDiagnostics: semantic.diagnostics.length,
      instructionKinds: plan.instructions.map((instruction) => instruction.kind),
      expressionKind: plan.instructions[0]?.value?.kind,
      boundaryCodes: contained.diagnostics.map((diagnostic) => diagnostic.code),
      boundaryProgramStatements: contained.program.statements.length,
      boundarySpan: contained.diagnostics.map((diagnostic) => [
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
    boundaryCodes: ["TSC007"],
    boundaryProgramStatements: 0,
    boundarySpan: [[0, nestedSource.length]],
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
