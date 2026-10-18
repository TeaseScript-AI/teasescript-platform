import assert from "node:assert/strict";
import test from "node:test";

import {
  ANGLE_TYPE,
  BOOLEAN_TYPE,
  CALENDAR_DURATION_TYPE,
  DURATION_TYPE,
  INTEGER_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  union,
  UNKNOWN_TYPE,
  withValues,
} from "../src/static-types.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import type { ContractFamily } from "../src/type-inference/graph.js";
import {
  assertCase,
  assertEqualResult,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
} from "./helpers/adapter-parity.js";

function relation(family: ContractFamily, name: string) {
  const found = operationRelations().relation({ family, name });
  assert.ok(found !== undefined, `a relation for ${family}.${name}`);
  return found;
}

const INTEGER = closedView(INTEGER_TYPE);
const NUMBER = closedView(NUMBER_TYPE);
const TEXT = closedView(STRING_TYPE);
const DURATION = closedView(DURATION_TYPE);

test("arithmetic combines every pair of operand members, and a pair that cannot combine leaves no value", () => {
  assertEqualResult(
    relation("operator", "+"),
    inputsOf({ arguments: [INTEGER, NUMBER] }),
    legacyOperation("let r = 1 + 1.5\nexit"),
    "type",
  );
  assertEqualResult(
    relation("operator", "+"),
    inputsOf({ arguments: [TEXT, TEXT] }),
    legacyOperation('let r = "a" + "b"\nexit'),
  );
  assertEqualResult(
    relation("operator", "+"),
    inputsOf({ arguments: [DURATION, DURATION] }),
    legacyOperation("let r = 1 s + 1 s\nexit"),
  );
  assertEqualResult(
    relation("operator", "*"),
    inputsOf({ arguments: [DURATION, INTEGER] }),
    legacyOperation("let r = 3 s * 2\nexit"),
  );
  assertEqualResult(
    relation("operator", "%"),
    inputsOf({ arguments: [INTEGER, INTEGER] }),
    legacyOperation("let r = 1 % 2\nexit"),
  );
  assertCase(
    relation("operator", "+"),
    inputsOf({ arguments: [INTEGER, TEXT] }),
    legacyOperation('let r = 1 + "x"\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
  // A member that may be null, or a member no value could combine with: the operation has no value (rule 3.5).
  assertCase(
    relation("operator", "+"),
    inputsOf({ arguments: [closedView(union([INTEGER_TYPE, STRING_TYPE])), INTEGER] }),
    legacyOperation("let a: integer | string = hostValue\nlet r = a + 1\nexit"),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
  assertCase(
    relation("operator", "+"),
    inputsOf({ arguments: [closedView(union([INTEGER_TYPE, { kind: "null" }])), INTEGER] }),
    legacyOperation("let a: integer? = hostValue\nlet r = a + 1\nexit"),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
});

test("two lists join their elements as a literal does; elements that mix are the legacy's recovery", () => {
  assertEqualResult(
    relation("operator", "+"),
    inputsOf({
      arguments: [
        closedView({ kind: "list", element: INTEGER_TYPE }),
        closedView({ kind: "list", element: INTEGER_TYPE }),
      ],
    }),
    legacyOperation("let r = [1, 2] + [3]\nexit"),
    "type",
  );
  assertEqualResult(
    relation("operator", "+"),
    inputsOf({
      arguments: [
        closedView({ kind: "list", element: INTEGER_TYPE }),
        closedView({ kind: "list", element: NUMBER_TYPE }),
      ],
    }),
    legacyOperation("let r = [1] + [1.5]\nexit"),
  );
  assertCase(
    relation("operator", "+"),
    inputsOf({
      arguments: [
        closedView({ kind: "list", element: INTEGER_TYPE }),
        closedView({ kind: "list", element: STRING_TYPE }),
      ],
    }),
    legacyOperation('let r = [1] + ["x"]\nexit'),
    { fact: "list<unknown>", errors: ["TSV044"] },
    "invalid",
  );
});

test("a dynamic operand stands for every kind an operator takes: the results are the operation's possibilities", () => {
  assertCase(
    relation("operator", "+"),
    inputsOf({ arguments: [dynamicView("host"), INTEGER] }),
    legacyOperation("let r = hostValue + 1\nexit"),
    { fact: "unknown" },
    { possible: [INTEGER_TYPE, NUMBER_TYPE] },
  );
  assertCase(
    relation("operator", "+"),
    inputsOf({ arguments: [dynamicView("host"), dynamicView("host")] }),
    legacyOperation("let r = hostValue + hostText\nexit"),
    { fact: "unknown" },
    {
      possible: [
        INTEGER_TYPE,
        NUMBER_TYPE,
        STRING_TYPE,
        DURATION_TYPE,
        CALENDAR_DURATION_TYPE,
        ANGLE_TYPE,
        { kind: "scalar", name: "date" },
        { kind: "scalar", name: "datetime" },
        { kind: "scalar", name: "absoluteDateTime" },
        { kind: "list", element: UNKNOWN_TYPE },
      ],
    },
  );
  assertCase(
    relation("unary", "-"),
    inputsOf({ arguments: [dynamicView("host")] }),
    legacyOperation("let r = -hostValue\nexit"),
    { fact: "unknown" },
    { possible: [INTEGER_TYPE, NUMBER_TYPE, DURATION_TYPE, CALENDAR_DURATION_TYPE, ANGLE_TYPE] },
  );
  assert.equal(
    relation("operator", "+").result(inputsOf({ arguments: [BOTTOM_VIEW, INTEGER] })).kind,
    "unconstrained",
  );
});

test("negation keeps a number's kind and flips the values a choice restricted it to", () => {
  assertEqualResult(
    relation("unary", "-"),
    inputsOf({ arguments: [INTEGER] }),
    legacyOperation("let r = -(1)\nexit"),
    "type",
  );
  assertEqualResult(
    relation("unary", "-"),
    inputsOf({ arguments: [closedView(withValues(INTEGER_TYPE, [1, 2]))] }),
    legacyOperation('let c = askChoice 1: "A", 2: "B"\nlet r = -c\nexit'),
  );
  assertCase(
    relation("unary", "-"),
    inputsOf({ arguments: [TEXT] }),
    legacyOperation('let r = -"x"\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
});

test("logic, comparisons, tests, interpolations, units, angles and ranges always have their kind", () => {
  assertEqualResult(
    relation("logic", "and"),
    inputsOf({ arguments: [closedView(BOOLEAN_TYPE), dynamicView("host")] }),
    legacyOperation("let r = true and hostFlag\nexit"),
    "type",
  );
  // The operand check is the visitor's: `not 1` is reported and stays a boolean.
  assertCase(
    relation("logic", "not"),
    inputsOf({ arguments: [INTEGER] }),
    legacyOperation("let r = not 1\nexit"),
    { fact: "boolean", errors: ["TSV043"] },
    "fact",
  );
  assertEqualResult(
    relation("comparison", "<"),
    inputsOf({ arguments: [dynamicView("host"), INTEGER] }),
    legacyOperation("let r = hostValue < 1\nexit"),
  );
  assertEqualResult(
    relation("typeTest", "is"),
    inputsOf({ arguments: [dynamicView("host")] }),
    legacyOperation("let r = hostValue is integer\nexit"),
  );
  assertEqualResult(
    relation("interpolation", "show"),
    inputsOf({ arguments: [INTEGER] }),
    legacyOperation('let n = 1\nlet r = "${n} items"\nexit'),
  );
  assertEqualResult(
    relation("unit", "s"),
    inputsOf({ arguments: [INTEGER] }),
    legacyOperation("let n = 1\nlet r = (n + 1) s\nexit"),
  );
  assert.deepEqual(relation("unit", "calendar days").result(inputsOf({ arguments: [INTEGER] })), {
    kind: "type",
    type: CALENDAR_DURATION_TYPE,
  });
  assertEqualResult(
    relation("angle", "deg"),
    inputsOf({ arguments: [INTEGER] }),
    legacyOperation("let r = 90 deg\nexit"),
  );
  // A range's bounds are numeric; what a consumer needs of them is its own rule.
  assertEqualResult(
    relation("range", ".."),
    inputsOf({ arguments: [NUMBER, NUMBER] }),
    legacyOperation("let r = 1.5..3.5\nexit"),
  );
});
