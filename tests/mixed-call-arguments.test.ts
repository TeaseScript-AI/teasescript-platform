import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

const SHOW = 'function show(a, b = "b", c = "c") {\n    return "${a}${b}${c}"\n}\n';

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("positional arguments followed by named arguments fill an author function's parameters", () => {
  const result = runValidSource(
    SHOW + ["say show(1, c: 3)", "say show(1, 2, c: 3)", "say show(1, c: 3, b: 2)"].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["1b3", "123", "123"]);
});

test("a built-in receives positional and named arguments from one call", () => {
  const plan = compileValidPlan('say pack(1, mode: "x")', { builtins: ["pack"] });
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
    builtins: {
      pack: (call) => JSON.stringify({ positional: call.positional, named: call.named }),
    },
  });
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ['{"positional":[1],"named":{"mode":"x"}}']);
});

test("the specification's conversion example parses as one positional and one named argument", () => {
  const result = compileSource('let text = "5"\nlet amount = toNumber(text, default: 0)');
  assert.deepEqual(result.parserDiagnostics, []);
});

test("a positional argument after a named one and a parameter given twice are rejected", () => {
  assert.deepEqual(diagnostics(SHOW + "say show(b: 2, 1)"), [
    [
      "TSP019",
      "A positional argument may not follow a named argument. Move it before the named arguments, or name it too.",
      "1",
    ],
  ]);
  assert.deepEqual(diagnostics(SHOW + "say show(1, a: 2)"), [
    ["TSV023", "Parameter 'a' already receives positional argument 1. Remove one of the two.", "a"],
  ]);
  assert.deepEqual(diagnostics(SHOW + "say show(1, c: 2, c: 3)"), [
    ["TSV023", "Duplicate named argument 'c'.", "c"],
  ]);
  assert.deepEqual(diagnostics(SHOW + "say show(1, d: 2)")[0]?.slice(0, 2), [
    "TSV022",
    "Unknown argument 'd' for function 'show'.",
  ]);
  assert.deepEqual(diagnostics(SHOW + "say show(b: 2)")[0]?.slice(0, 2), [
    "TSV024",
    "Missing required named argument 'a'.",
  ]);
});

test("plan validation rejects a function call that gives one parameter two arguments", () => {
  const plan = structuredClone(compileValidPlan(SHOW + "let shown = show(1, c: 3)"));
  const call = plan.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.ok(call?.kind === "callFunction" && call.arguments.length === 2);
  // EVIDENCE: fixture renames only the named argument's parameter to the one the positional argument fills.
  (call.arguments[1] as { parameterName: string }).parameterName = "a";
  assert.equal(validateInstructionPlan(plan).valid, false);
});
