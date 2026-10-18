import assert from "node:assert/strict";
import test from "node:test";

import {
  DURATION_TYPE,
  INTEGER_TYPE,
  NUMBER_TYPE,
  PropertyTable,
  STRING_TYPE,
  UNKNOWN_TYPE,
  type StaticType,
} from "../src/static-types.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import type { SyntaxEvidence } from "../src/type-inference/graph.js";
import {
  assertCase,
  assertEqualResult,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
} from "./helpers/adapter-parity.js";

function listFunction(name: string) {
  const found = operationRelations().relation({ family: "listFunction", name });
  assert.ok(found !== undefined, `a relation for listFunction.${name}`);
  return found;
}

const listOf = (element: StaticType) => closedView({ kind: "list", element });
const selectors = (...written: { name: string; text: string | null }[]): SyntaxEvidence => ({
  kind: "selectors",
  written,
});
const scored: StaticType = {
  kind: "object",
  properties: new PropertyTable([["score", INTEGER_TYPE]]),
};

test("a statistic has the kind of the list's values, promoted from integers where the contract says", () => {
  assertEqualResult(
    listFunction("sum"),
    inputsOf({ arguments: [listOf(INTEGER_TYPE)], evidence: selectors() }),
    legacyOperation("let r = sum([1, 2])\nexit"),
    "type",
  );
  assertEqualResult(
    listFunction("sum"),
    inputsOf({ arguments: [listOf(NUMBER_TYPE)], evidence: selectors() }),
    legacyOperation("let r = sum([1, 1.5])\nexit"),
  );
  assertEqualResult(
    listFunction("average"),
    inputsOf({ arguments: [listOf(INTEGER_TYPE)], evidence: selectors() }),
    legacyOperation("let r = average([1, 2])\nexit"),
  );
  assertEqualResult(
    listFunction("median"),
    inputsOf({ arguments: [listOf(DURATION_TYPE)], evidence: selectors() }),
    legacyOperation("let r = median([1 s, 2 s])\nexit"),
  );
  assertEqualResult(
    listFunction("percentile"),
    inputsOf({
      arguments: [listOf(INTEGER_TYPE), closedView(INTEGER_TYPE)],
      evidence: selectors(),
    }),
    legacyOperation("let r = percentile([1, 2], 50)\nexit"),
  );
  assertEqualResult(
    listFunction("stddev"),
    inputsOf({ arguments: [listOf(INTEGER_TYPE)], evidence: selectors() }),
    legacyOperation("let r = stddev([1, 2])\nexit"),
  );
  assertEqualResult(
    listFunction("max"),
    inputsOf({ arguments: [listOf({ kind: "scalar", name: "angle" })], evidence: selectors() }),
    legacyOperation("let r = max([1 deg, 2 deg])\nexit"),
  );
  assertCase(
    listFunction("sum"),
    inputsOf({ arguments: [listOf(STRING_TYPE)], evidence: selectors() }),
    legacyOperation('let r = sum(["a"])\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
  assertCase(
    listFunction("sum"),
    inputsOf({ arguments: [dynamicView("host")], evidence: selectors() }),
    legacyOperation("let r = sum(hostList)\nexit"),
    { fact: "unknown" },
    { dynamic: "host" },
  );
});

test("a selector is read as written: a visible text selects the property, a variable does not", () => {
  assertEqualResult(
    listFunction("sum"),
    inputsOf({
      arguments: [listOf(scored)],
      named: { by: closedView(STRING_TYPE) },
      evidence: selectors({ name: "by", text: "score" }),
    }),
    legacyOperation('let r = sum([{ score: 1 }], by: "score")\nexit'),
  );
  // The legacy cannot see a selector held in a variable, known or not: its unknown, a declared selector-visibility case.
  assertCase(
    listFunction("sum"),
    inputsOf({
      arguments: [listOf(scored)],
      named: { by: closedView(STRING_TYPE) },
      evidence: selectors({ name: "by", text: null }),
    }),
    legacyOperation('let k = "score"\nlet r = sum([{ score: 1 }], by: k)\nexit'),
    { fact: "unknown" },
    { dynamic: "unknown member" },
  );
  assertCase(
    listFunction("sum"),
    inputsOf({
      arguments: [listOf(INTEGER_TYPE)],
      named: { by: closedView(STRING_TYPE) },
      evidence: selectors({ name: "by", text: "v" }),
    }),
    legacyOperation('let r = sum([1], by: "v")\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
});

test("a regression is the object of its line, with unknown amounts where the values' kind is not known", () => {
  assertEqualResult(
    listFunction("linearRegression"),
    inputsOf({
      arguments: [listOf(scored)],
      named: { y: closedView(STRING_TYPE) },
      evidence: selectors({ name: "y", text: "score" }),
    }),
    legacyOperation('let r = linearRegression([{ score: 1 }, { score: 2 }], y: "score")\nexit'),
    "type",
  );
  assertEqualResult(
    listFunction("linearRegression"),
    inputsOf({
      arguments: [listOf(scored)],
      named: { y: closedView(STRING_TYPE) },
      evidence: selectors({ name: "y", text: null }),
    }),
    legacyOperation(
      'let k = "score"\nlet r = linearRegression([{ score: 1 }, { score: 2 }], y: k)\nexit',
    ),
  );
  assertEqualResult(
    listFunction("linearRegression"),
    inputsOf({ arguments: [listOf(INTEGER_TYPE)], evidence: selectors() }),
    legacyOperation("let r = linearRegression([1, 2])\nexit"),
  );
  assertCase(
    listFunction("linearRegression"),
    inputsOf({
      arguments: [listOf(DURATION_TYPE)],
      named: { x: closedView(STRING_TYPE) },
      evidence: selectors({ name: "x", text: "x" }),
    }),
    legacyOperation('let r = linearRegression([1 s, 2 s], x: "x")\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
});

test("a prediction is a number or a duration like its line's intercept; a line that is no line has no value", () => {
  const line = (amount: StaticType): StaticType => ({
    kind: "object",
    properties: new PropertyTable([
      ["slope", amount],
      ["intercept", amount],
      ["r2", NUMBER_TYPE],
      ["start", INTEGER_TYPE],
    ]),
  });
  assertEqualResult(
    listFunction("predict"),
    inputsOf({ arguments: [closedView(line(NUMBER_TYPE)), closedView(INTEGER_TYPE)] }),
    legacyOperation("let line = linearRegression([1, 2])\nlet r = predict(line, 3)\nexit"),
    "type",
  );
  assertEqualResult(
    listFunction("predict"),
    inputsOf({ arguments: [closedView(line(DURATION_TYPE)), closedView(INTEGER_TYPE)] }),
    legacyOperation("let line = linearRegression([1 s, 2 s])\nlet r = predict(line, 3)\nexit"),
  );
  assertCase(
    listFunction("predict"),
    inputsOf({
      arguments: [
        closedView({
          kind: "object",
          properties: new PropertyTable([["intercept", INTEGER_TYPE]]),
        }),
        closedView(INTEGER_TYPE),
      ],
    }),
    legacyOperation("let r = predict({ intercept: 1 }, 2)\nexit"),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
  assertCase(
    listFunction("predict"),
    inputsOf({ arguments: [dynamicView("host"), closedView(INTEGER_TYPE)] }),
    legacyOperation("let r = predict(hostValue, 2)\nexit"),
    { fact: "unknown" },
    { dynamic: "host" },
  );
});

test("a regression keeps its line's object after a rejected value or selection, with unknown fields", () => {
  const line = '{"intercept":unknown,"r2":number,"slope":unknown,"start":integer}';
  assertCase(
    listFunction("linearRegression"),
    inputsOf({ arguments: [listOf(STRING_TYPE)], evidence: selectors() }),
    legacyOperation('let r = linearRegression(["a", "b"])\nexit'),
    { fact: line, errors: ["TSV043"] },
    "fact",
  );
  assertCase(
    listFunction("linearRegression"),
    inputsOf({ arguments: [closedView(INTEGER_TYPE)], evidence: selectors() }),
    legacyOperation("let r = linearRegression(1)\nexit"),
    { fact: line, errors: ["TSV043"] },
    "fact",
  );
  const points: StaticType = {
    kind: "object",
    properties: new PropertyTable([
      ["x", STRING_TYPE],
      ["y", INTEGER_TYPE],
    ]),
  };
  assertCase(
    listFunction("linearRegression"),
    inputsOf({
      arguments: [listOf(points)],
      named: { x: closedView(STRING_TYPE), y: closedView(STRING_TYPE) },
      evidence: selectors({ name: "x", text: "x" }, { name: "y", text: "y" }),
    }),
    legacyOperation(
      'let r = linearRegression([{ x: "a", y: 1 }, { x: "b", y: 2 }], x: "x", y: "y")\nexit',
    ),
    { fact: '{"intercept":number,"r2":number,"slope":number,"start":unknown}', errors: ["TSV043"] },
    "fact",
  );
  // `x:` without `y:` is a malformed call.
  assertCase(
    listFunction("linearRegression"),
    inputsOf({
      arguments: [listOf(scored)],
      named: { x: closedView(STRING_TYPE) },
      evidence: selectors({ name: "x", text: "score" }),
    }),
    legacyOperation('let r = linearRegression([{ score: 1 }], x: "score")\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
});

test("a visible selector that names no property of the objects is a missing property: reported, not known", () => {
  const valued: StaticType = {
    kind: "object",
    properties: new PropertyTable([["value", INTEGER_TYPE]]),
  };
  assertCase(
    listFunction("sum"),
    inputsOf({
      arguments: [listOf(valued)],
      named: { by: closedView(STRING_TYPE) },
      evidence: selectors({ name: "by", text: "score" }),
    }),
    legacyOperation('let xs = [{ value: 1 }]\nlet r = sum(xs, by: "score")\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    { dynamic: "unknown member" },
  );
});

test("an intercept the compiler cannot know keeps the prediction unknown; a known text intercept is no line", () => {
  const withIntercept = (intercept: StaticType): StaticType => ({
    kind: "object",
    properties: new PropertyTable([
      ["slope", INTEGER_TYPE],
      ["intercept", intercept],
      ["start", INTEGER_TYPE],
    ]),
  });
  assertCase(
    listFunction("predict"),
    inputsOf({ arguments: [closedView(withIntercept(UNKNOWN_TYPE)), closedView(INTEGER_TYPE)] }),
    legacyOperation(
      "let line = { slope: 1, intercept: hostValue, start: 0 }\nlet r = predict(line, 1)\nexit",
    ),
    { fact: "unknown" },
    { dynamic: "unknown member" },
  );
  // The legacy gives unknown without a report, a validation hole; the candidate closes it (a declared refinement,
  // listed for the orchestrator's acceptance at stage 5).
  assertCase(
    listFunction("predict"),
    inputsOf({ arguments: [closedView(withIntercept(STRING_TYPE)), closedView(INTEGER_TYPE)] }),
    legacyOperation('let r = predict({ slope: 1, intercept: "x", start: 0 }, 1)\nexit'),
    { fact: "unknown" },
    "invalid",
  );
});
