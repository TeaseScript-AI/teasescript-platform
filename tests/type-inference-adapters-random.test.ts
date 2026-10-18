import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGER_TYPE,
  NUMBER_TYPE,
  PropertyTable,
  STRING_TYPE,
  type StaticType,
} from "../src/static-types.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import {
  assertCase,
  assertEqualResult,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
} from "./helpers/adapter-parity.js";

/** The relation of a random function, which the routing table must know. */
function random(name: string) {
  const relation = operationRelations().relation({ family: "random", name });
  assert.ok(relation !== undefined, `a relation for random.${name}`);
  return relation;
}

test("a draw of numbers is a number, a chance a boolean, a draw from a range an integer, whatever the arguments", () => {
  assertEqualResult(
    random("random"),
    inputsOf({}),
    legacyOperation("let r = random()\nexit"),
    "type",
  );
  assertEqualResult(
    random("chance"),
    inputsOf({ arguments: [closedView(NUMBER_TYPE)] }),
    legacyOperation("let r = chance(0.5)\nexit"),
  );
  assertEqualResult(
    random("randomInteger"),
    inputsOf({ arguments: [closedView({ kind: "range" })] }),
    legacyOperation("let r = randomInteger(1..6)\nexit"),
  );
  // The argument's kind is the visitor's check: the legacy reports it and the draw stays a boolean (recovery).
  assertCase(
    random("chance"),
    inputsOf({ arguments: [closedView(STRING_TYPE)] }),
    legacyOperation('let r = chance("x")\nexit'),
    { fact: "boolean", errors: ["TSV043"] },
    "fact",
  );
});

test("randomWeighted gives a key of a dict of weights, a copy of an element of a list, or nothing", () => {
  assertEqualResult(
    random("randomWeighted"),
    inputsOf({ arguments: [closedView({ kind: "dict", element: INTEGER_TYPE })] }),
    legacyOperation('let r = randomWeighted(dict { "a": 1, "b": 3 })\nexit'),
    "type",
  );
  const element: StaticType = {
    kind: "object",
    properties: new PropertyTable([["weight", INTEGER_TYPE]]),
  };
  assertEqualResult(
    random("randomWeighted"),
    inputsOf({
      arguments: [closedView({ kind: "list", element })],
      named: { weight: closedView(STRING_TYPE) },
    }),
    legacyOperation(
      'let r = randomWeighted([{ weight: 1 }, { weight: 3 }], weight: "weight")\nexit',
    ),
    "projection",
  );
  // A source the compiler cannot know: the legacy's unknown, a value of the source's provenance here.
  assertCase(
    random("randomWeighted"),
    inputsOf({ arguments: [dynamicView("host")] }),
    legacyOperation("let r = randomWeighted(hostValue)\nexit"),
    { fact: "unknown" },
    { dynamic: "host" },
  );
  // A source of another kind: the legacy reports and recovers unknown; the relation has no value.
  assertCase(
    random("randomWeighted"),
    inputsOf({ arguments: [closedView(STRING_TYPE)] }),
    legacyOperation('let r = randomWeighted("x")\nexit'),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
});

test("a relation answers from its inputs alone: bottom waits, and a grown view is answered afresh", () => {
  const relation = random("randomWeighted");
  assert.equal(relation.result(inputsOf({ arguments: [BOTTOM_VIEW] })).kind, "unconstrained");
  const grown = relation.result(
    inputsOf({ arguments: [closedView({ kind: "dict", element: INTEGER_TYPE })] }),
  );
  assert.deepEqual(grown, { kind: "type", type: STRING_TYPE });
  assert.equal(relation.result(inputsOf({ arguments: [BOTTOM_VIEW] })).kind, "unconstrained");
});
