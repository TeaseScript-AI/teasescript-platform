import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGER_TYPE,
  NUMBER_TYPE,
  optional,
  REGEX_TYPE,
  STRING_TYPE,
} from "../src/static-types.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import type {
  OperationRelation,
  OperationResult,
} from "../src/type-inference/adapters/relation.js";
import {
  assertCase,
  closedView,
  dynamicView,
  inputsOf,
  isClosedFact,
  legacyOperation,
} from "./helpers/adapter-parity.js";

/**
 * The parity helper itself (work note §6.1): a case declares the legacy's fact and errors and the adapter's answer;
 * the helper refuses a fact it cannot compare and a declaration the legacy contradicts.
 */
test("a fact with an open slot, a held unknown or an open shape is not closed and must be declared", () => {
  assert.ok(isClosedFact("(integer|null)"));
  assert.ok(isClosedFact('{"a":integer,"b":string}'));
  assert.ok(isClosedFact("integer{1|2}"));
  assert.ok(!isClosedFact("(list<?>|list<?>)"));
  assert.ok(!isClosedFact("list<integer>!"));
  assert.ok(!isClosedFact('{"a":integer,+}'));
  const outcome = legacyOperation("let a = [[]]\nlet r = a.get(0, default: [])\nexit");
  assert.equal(outcome.type, "(list<?>|list<?>)");
  const get = operationRelations().relation({ family: "method", name: "get" })!;
  const inputs = inputsOf({
    receiver: closedView({ kind: "list", element: { kind: "list", element: INTEGER_TYPE } }),
    arguments: [closedView(INTEGER_TYPE)],
    named: { default: closedView({ kind: "list", element: INTEGER_TYPE }) },
  });
  assert.throws(
    () => assertCase(get, inputs, outcome, { fact: "(list<?>|list<?>)" }, "fact"),
    /closed fact/,
  );
  assertCase(
    get,
    inputs,
    outcome,
    { fact: "(list<?>|list<?>)" },
    { realized: "list<integer>" },
    "alternatives",
  );
});

test("a declaration the legacy contradicts fails, so a case pins the oracle it is compared with", () => {
  const outcome = legacyOperation('let r = 1 + "x"\nexit');
  const plus = operationRelations().relation({ family: "operator", name: "+" })!;
  const inputs = inputsOf({
    arguments: [closedView(INTEGER_TYPE), closedView({ kind: "scalar", name: "string" })],
  });
  assert.throws(
    () => assertCase(plus, inputs, outcome, { fact: "integer" }, "fact"),
    /legacy fact/,
  );
  assert.throws(
    () => assertCase(plus, inputs, outcome, { fact: "unknown" }, "invalid"),
    /errors at the operation/,
  );
  assertCase(plus, inputs, outcome, { fact: "unknown", errors: ["TSV043"] }, "invalid");
});

/** A fixture relation: the answer a family module will give, pinned here against the legacy before the module exists. */
function fixture(result: OperationResult): OperationRelation {
  return { contract: { family: "builtin", name: "fixture" }, result: () => result };
}

test("the declared classes the delegated families will meet, pinned against the legacy oracle", () => {
  // The contract's own dynamic data beside a checking error: JSON without a default for text that is not JSON.
  assertCase(
    fixture({ kind: "dynamic", why: "json" }),
    inputsOf({ arguments: [closedView(STRING_TYPE)] }),
    legacyOperation('let r = fromJson("bad")\nexit'),
    { fact: "unknown", errors: ["TSV020"] },
    { dynamic: "json" },
  );
  assertCase(
    fixture({ kind: "dynamic", why: "json" }),
    inputsOf({
      arguments: [closedView(STRING_TYPE)],
      named: { default: closedView(INTEGER_TYPE) },
    }),
    legacyOperation('let r = fromJson("{}", default: 1)\nexit'),
    { fact: "unknown" },
    { dynamic: "json" },
  );
  // An optional conversion without its default: the optional result and the error that asks for the default.
  assertCase(
    fixture({ kind: "type", type: optional(REGEX_TYPE) }),
    inputsOf({ arguments: [closedView(STRING_TYPE)] }),
    legacyOperation('let r = toRegex("a")\nexit'),
    { fact: "(null|regex)", errors: ["TSV020"] },
    "fact",
  );
  // A bounded possibility against the legacy's unknown: a numeric function of a value the compiler cannot know.
  assertCase(
    fixture({ kind: "possible", types: [INTEGER_TYPE, NUMBER_TYPE], why: "host" }),
    inputsOf({ arguments: [dynamicView("host")] }),
    legacyOperation("let r = abs(hostValue)\nexit"),
    { fact: "unknown" },
    { possible: [INTEGER_TYPE, NUMBER_TYPE] },
  );
  // A nullable number: the check names the null first and the result keeps the number's kind (a recovery).
  assertCase(
    fixture({ kind: "type", type: INTEGER_TYPE }),
    inputsOf({ arguments: [closedView(optional(INTEGER_TYPE))] }),
    legacyOperation("let n: integer? = hostValue\nlet r = abs(n)\nexit"),
    { fact: "integer", errors: ["TSV043"] },
    "fact",
  );
  // A result function that does not need the unknown operand: `round` without `decimals:` is an integer.
  assertCase(
    fixture({ kind: "type", type: INTEGER_TYPE }),
    inputsOf({ arguments: [dynamicView("host")] }),
    legacyOperation("let r = round(hostValue)\nexit"),
    { fact: "integer" },
    "fact",
  );
});
