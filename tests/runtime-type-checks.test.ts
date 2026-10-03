import assert from "node:assert/strict";
import test from "node:test";

import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { sayTexts } from "./helpers/runtime-events.js";

const PICK = "function pick(value) {\n    return value\n}\n";

test("a value the compiler cannot type must fit the variable's type at runtime", () => {
  const cases = [
    [
      "let count: integer = pick(2.5)",
      "'count' holds integer, so it cannot take a number with a fraction (number).",
      "let count: integer = pick(2.5)",
    ],
    [
      'let count = 1\ncount = pick("x")',
      "'count' holds integer, so it cannot take text (string).",
      'count = pick("x")',
    ],
    [
      "let count = 1\ncount += pick(0.5)",
      "'count' holds integer, so it cannot take a number with a fraction (number).",
      "count += pick(0.5)",
    ],
    [
      "let name: string = pick(null)",
      "'name' holds string, so it cannot take null.",
      "let name: string = pick(null)",
    ],
    [
      'let names: string[] = pick(["a", 1])',
      "'names' holds string[], but this list also contains other values.",
      'let names: string[] = pick(["a", 1])',
    ],
    [
      'let tags: string set = pick(["a"])',
      "'tags' holds string set, so it cannot take a list.",
      'let tags: string set = pick(["a"])',
    ],
  ] as const;
  for (const [statements, message, statement] of cases) {
    const source = PICK + statements;
    const failure = runValidSource(source).snapshot.failure;
    const start = source.lastIndexOf(statement);
    assert.deepEqual(
      [failure?.code, failure?.message, failure?.span.start.offset, failure?.span.end.offset],
      ["TSR058", message, start, start + statement.length],
      statements,
    );
  }
});

test("values that fit the variable's type pass the runtime check", () => {
  const result = runValidSource(
    PICK +
      [
        "let count: integer = pick(3)",
        "let ratio: number = pick(3)",
        "ratio = pick(2.5)",
        "let status: string? = pick(null)",
        'status = pick("ready")',
        'let names: string[] = pick(["a", "b"])',
        'say "${count} ${ratio} ${status} ${names.length}"',
      ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["3 2.5 ready 2"]);
});

test("runtime type checks are checkpoint and resume equivalent", () => {
  assertRuntimeResumeEquivalent(
    PICK +
      [
        "let count: integer = pick(1)",
        "count = pick(2)",
        "count += pick(3)",
        'say "${count}"',
      ].join("\n"),
  );
});

test("plan validation rejects a malformed expected type", () => {
  const plan = structuredClone(compileValidPlan(PICK + "let count: integer = pick(1)"));
  const declaration = plan.instructions.find(
    (instruction) => instruction.kind === "declareBinding" && instruction.name === "count",
  );
  assert.ok(declaration?.kind === "declareBinding" && declaration.expectedType !== undefined);
  // EVIDENCE: fixture replaces only the expected type with one whose optional flag is not a boolean.
  (declaration as { expectedType: unknown }).expectedType = {
    ...declaration.expectedType,
    optional: "no",
  };
  assert.equal(validateInstructionPlan(plan).valid, false);
});
