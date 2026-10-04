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
    SHOW +
      [
        'say show(1, c: "3")',
        'say show(1, "2", c: "3")',
        'say show(1, c: "3", b: "2")',
        "exit",
      ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["1b3", "123", "123"]);
});

test("a built-in receives positional and named arguments from one call", () => {
  const plan = compileValidPlan('say pack(1, mode: "x")\nexit', { builtins: ["pack"] });
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
    builtins: {
      pack: (call) => JSON.stringify({ positional: call.positional, named: call.named }),
    },
  });
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ['{"positional":[1],"named":{"mode":"x"}}']);
});

test("the specification's conversion example parses as one positional and one named argument", () => {
  const result = compileSource('let text = "5"\nlet amount = toNumber(text, default: 0)\nexit');
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
    ["TSV023", "Argument 'c' is given twice. Remove one of them.", "c"],
  ]);
  assert.deepEqual(diagnostics(SHOW + "say show(1, d: 2)")[0]?.slice(0, 2), [
    "TSV022",
    "Function 'show' has no parameter 'd'. Its parameters are a, b, c.",
  ]);
  assert.deepEqual(diagnostics(SHOW + "say show(b: 2)")[0]?.slice(0, 2), [
    "TSV024",
    "Function 'show' needs a value for 'a'. Add it by position or as 'a: ...'.",
  ]);
});

test("a name given twice to a built-in or method is rejected at compile time", () => {
  const builtin = 'say pack(1, mode: "x", mode: "y")';
  const result = compileSource(builtin, { builtins: ["pack"] });
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [
      [
        "TSV023",
        "Argument 'mode' is given twice. Remove one of them.",
        builtin.lastIndexOf("mode"),
        builtin.lastIndexOf("mode") + 4,
      ],
    ],
  );
  assert.deepEqual(diagnostics('let items = ["a"]\nsay items.remove(x: 1, x: 2)'), [
    ["TSV023", "Argument 'x' is given twice. Remove one of them.", "x"],
  ]);
  assert.deepEqual(
    compileSource('say pack(1, mode: "x", size: 2)\nexit', { builtins: ["pack"] }).diagnostics,
    [],
  );
  for (const callee of ["(items.remove)", "[items.remove][0]", "pick().remove"])
    assert.deepEqual(
      diagnostics(
        `let items = ["a"]\nfunction pick {\n    return items\n}\nsay ${callee}(x: 1, x: 2)`,
      ).map(([code]) => code),
      ["TSV023"],
      callee,
    );
});

test("argument count errors name the parameters and the fix", () => {
  assert.deepEqual(diagnostics(SHOW + "say show(1, 2, 3, 4)")[0]?.slice(0, 2), [
    "TSV020",
    "Function 'show' takes 1 to 3 arguments (a, b, c), received 4 positional arguments. Remove the extra positional arguments.",
  ]);
  assert.deepEqual(diagnostics(SHOW + "say show()")[0]?.slice(0, 2), [
    "TSV020",
    "Function 'show' takes 1 to 3 arguments (a, b, c), received 0. Add the missing arguments.",
  ]);
});

test("plan validation rejects a function call that gives one parameter two arguments", () => {
  const plan = structuredClone(compileValidPlan(SHOW + 'let shown = show(1, c: "3")\nexit'));
  const call = plan.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.ok(call?.kind === "callFunction" && call.arguments.length === 2);
  // EVIDENCE: fixture renames only the named argument's parameter to the one the positional argument fills.
  (call.arguments[1] as { parameterName: string }).parameterName = "a";
  assert.equal(validateInstructionPlan(plan).valid, false);
});
