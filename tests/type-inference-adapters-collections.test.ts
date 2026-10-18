import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGER_TYPE,
  NUMBER_TYPE,
  optional,
  PropertyTable,
  STRING_TYPE,
  union,
} from "../src/static-types.js";
import { memberOf, operationRelations } from "../src/type-inference/adapters/index.js";
import {
  assertCase,
  assertEqualResult,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
} from "./helpers/adapter-parity.js";

function method(name: string) {
  const relation = operationRelations().relation({ family: "method", name });
  assert.ok(relation !== undefined, `a relation for method.${name}`);
  return relation;
}

const LIST = closedView({ kind: "list", element: INTEGER_TYPE });
const SET = closedView({ kind: "set", element: STRING_TYPE });
const DICT = closedView({ kind: "dict", element: INTEGER_TYPE });
const INTEGER = closedView(INTEGER_TYPE);
const XS = "let xs = [1, 2]\n";

test("list methods give what their contract names: a value, a copy of an element, or a new collection", () => {
  assertEqualResult(
    method("contains"),
    inputsOf({ receiver: LIST, arguments: [INTEGER] }),
    legacyOperation(`${XS}let r = xs.contains(1)\nexit`),
    "type",
  );
  assertEqualResult(
    method("indexOf"),
    inputsOf({ receiver: LIST, arguments: [INTEGER] }),
    legacyOperation(`${XS}let r = xs.indexOf(1)\nexit`),
    "type",
  );
  assertEqualResult(
    method("removeAt"),
    inputsOf({ receiver: LIST, arguments: [INTEGER] }),
    legacyOperation(`${XS}let r = xs.removeAt(0)\nexit`),
    "projection",
  );
  assertEqualResult(
    method("take"),
    inputsOf({ receiver: LIST, arguments: [INTEGER] }),
    legacyOperation(`${XS}let r = xs.take(1)\nexit`),
    "join",
  );
  assertEqualResult(
    method("toSet"),
    inputsOf({ receiver: LIST }),
    legacyOperation(`${XS}let r = xs.toSet()\nexit`),
    "join",
  );
  assertEqualResult(
    method("join"),
    inputsOf({ receiver: LIST, arguments: [closedView(STRING_TYPE)] }),
    legacyOperation(`${XS}let r = xs.join(",")\nexit`),
    "type",
  );
  assertEqualResult(
    method("add"),
    inputsOf({ receiver: LIST, arguments: [INTEGER] }),
    legacyOperation(`${XS}let r = xs.add(3)\nexit`),
    "type",
  );
});

test("get gives the element or the default (Q2) and needs its default; union joins the elements of both", () => {
  assertEqualResult(
    method("get"),
    inputsOf({ receiver: LIST, arguments: [INTEGER], named: { default: closedView(STRING_TYPE) } }),
    legacyOperation(`${XS}let r = xs.get(0, default: "none")\nexit`),
    "alternatives",
  );
  assertCase(
    method("get"),
    inputsOf({ receiver: LIST, arguments: [INTEGER] }),
    legacyOperation(`${XS}let r = xs.get(0)\nexit`),
    { fact: "unknown", errors: ["TSV020"] },
    "invalid",
  );
  assertEqualResult(
    method("get"),
    inputsOf({
      receiver: DICT,
      arguments: [closedView(STRING_TYPE)],
      named: { default: closedView(NUMBER_TYPE) },
    }),
    legacyOperation('let d = dict { "k": 1 }\nlet r = d.get("k", default: 1.5)\nexit'),
    "alternatives",
  );
  assertEqualResult(
    method("union"),
    inputsOf({ receiver: LIST, arguments: [closedView({ kind: "list", element: NUMBER_TYPE })] }),
    legacyOperation(`${XS}let r = xs.union([1.5])\nexit`),
    "type",
  );
  // Elements that mix: the legacy reports and recovers a list of unknown elements, which the relation gives too.
  assertCase(
    method("union"),
    inputsOf({ receiver: LIST, arguments: [closedView({ kind: "list", element: STRING_TYPE })] }),
    legacyOperation(`${XS}let r = xs.union(["x"])\nexit`),
    { fact: "list<unknown>", errors: ["TSV044"] },
    "fact",
    "type",
  );
});

test("the shape gates and the recoveries of the collection methods, as the legacy's branches give them", () => {
  // A list's `get` has no value when its shape is wrong; the other methods keep their result beside the report.
  assertCase(
    method("get"),
    inputsOf({ receiver: LIST, named: { default: closedView(STRING_TYPE) } }),
    legacyOperation(`${XS}let r = xs.get(default: "n")\nexit`),
    { fact: "unknown", errors: ["TSV020"] },
    "invalid",
  );
  assertCase(
    method("get"),
    inputsOf({ receiver: LIST, arguments: [INTEGER], named: { default: INTEGER, extra: INTEGER } }),
    legacyOperation(`${XS}let r = xs.get(0, default: 1, extra: 2)\nexit`),
    { fact: "unknown", errors: ["TSV022"] },
    "invalid",
  );
  assertCase(
    method("union"),
    inputsOf({ receiver: LIST }),
    legacyOperation(`${XS}let r = xs.union()\nexit`),
    { fact: "list<integer>", errors: ["TSV020"] },
    "fact",
  );
  assertCase(
    method("union"),
    inputsOf({ receiver: LIST, arguments: [LIST, INTEGER] }),
    legacyOperation(`${XS}let r = xs.union([2], 3)\nexit`),
    { fact: "list<integer>", errors: ["TSV020"] },
    "fact",
  );
  assertCase(
    method("add"),
    inputsOf({ receiver: LIST }),
    legacyOperation(`${XS}let r = xs.add()\nexit`),
    { fact: "null", errors: ["TSV020"] },
    "fact",
  );
  // A set operation's argument that may be null needs a check first, and the elements are not known.
  assertCase(
    method("intersection"),
    inputsOf({
      receiver: LIST,
      arguments: [closedView(optional({ kind: "list", element: NUMBER_TYPE }))],
    }),
    legacyOperation(`${XS}let other: number[]? = hostValue\nlet r = xs.intersection(other)\nexit`),
    { fact: "list<unknown>", errors: ["TSV043"] },
    "fact",
  );
  assertCase(
    method("union"),
    inputsOf({
      receiver: LIST,
      arguments: [closedView(optional({ kind: "list", element: INTEGER_TYPE }))],
    }),
    legacyOperation(`${XS}let other: integer[]? = hostValue\nlet r = xs.union(other)\nexit`),
    { fact: "list<unknown>", errors: ["TSV043"] },
    "fact",
  );
  // A union with a member of each collection joins the elements of each; a mix, a member that is no collection, or
  // an argument the compiler cannot know leaves the elements unknown.
  assertCase(
    method("union"),
    inputsOf({
      receiver: LIST,
      arguments: [
        closedView(
          union([
            { kind: "list", element: INTEGER_TYPE },
            { kind: "set", element: STRING_TYPE },
          ]),
        ),
      ],
    }),
    legacyOperation(
      `${XS}let other: integer[] | string set = hostValue\nlet r = xs.union(other)\nexit`,
    ),
    { fact: "list<unknown>", errors: ["TSV044"] },
    "fact",
  );
  assertCase(
    method("union"),
    inputsOf({ receiver: LIST, arguments: [closedView(STRING_TYPE)] }),
    legacyOperation(`${XS}let r = xs.union("a")\nexit`),
    { fact: "list<unknown>", errors: ["TSV043"] },
    "fact",
  );
  assertCase(
    method("union"),
    inputsOf({ receiver: LIST, arguments: [dynamicView("host")] }),
    legacyOperation(`${XS}let r = xs.union(hostList)\nexit`),
    { fact: "list<unknown>" },
    "fact",
  );
  // A dict method's shape is a gate: another count or an unknown name leaves the call without a value.
  assertCase(
    method("remove"),
    inputsOf({ receiver: DICT }),
    legacyOperation('let d = dict { "a": 1 }\nlet r = d.remove()\nexit'),
    { fact: "unknown", errors: ["TSV020"] },
    "invalid",
  );
  assertCase(
    method("clear"),
    inputsOf({ receiver: DICT, arguments: [INTEGER] }),
    legacyOperation('let d = dict { "a": 1 }\nlet r = d.clear(1)\nexit'),
    { fact: "unknown", errors: ["TSV020"] },
    "invalid",
  );
});

test("a receiver that may also hold data the compiler cannot know is never rejected: the legacy holds it unknown", () => {
  const guide = 'speaker guide {\n displayName: "Guide"\n}\n';
  // A speaker beside the remainder: the runtime checks the member; the legacy's element is unknown.
  assertCase(
    method("trim"),
    inputsOf({ receiver: dynamicView("host", [{ kind: "speaker" }]) }),
    legacyOperation(`${guide}let xs = [hostValue, guide]\nlet r = xs.first.trim()\nexit`),
    { fact: "unknown" },
    { realized: "unknown" },
    "alternatives",
  );
  // A kind without the method beside the remainder: no rejection either.
  assertCase(
    method("trim"),
    inputsOf({ receiver: dynamicView("host", [INTEGER_TYPE]) }),
    legacyOperation("let xs = [hostValue, 1]\nlet r = xs.first.trim()\nexit"),
    { fact: "unknown" },
    { realized: "unknown" },
    "alternatives",
  );
});

test("a receiver of several kinds answers per kind; a kind without the method makes the call invalid", () => {
  const both = closedView(
    union([
      { kind: "list", element: INTEGER_TYPE },
      { kind: "set", element: NUMBER_TYPE },
    ]),
  );
  assertEqualResult(
    method("union"),
    inputsOf({ receiver: both, arguments: [closedView({ kind: "list", element: INTEGER_TYPE })] }),
    legacyOperation("let a: integer[] | number set = hostValue\nlet r = a.union([1])\nexit"),
    "byReceiver",
  );
  assertCase(
    method("removeAt"),
    inputsOf({ receiver: both, arguments: [INTEGER] }),
    legacyOperation("let a: integer[] | number set = hostValue\nlet r = a.removeAt(0)\nexit"),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
  // A speaker beside a list: the list's method stands and the speaker's case is the runtime's; the legacy's unknown.
  const speakerOrList = closedView(
    union([{ kind: "speaker" }, { kind: "list", element: INTEGER_TYPE }]),
  );
  assertCase(
    method("contains"),
    inputsOf({ receiver: speakerOrList, arguments: [INTEGER] }),
    legacyOperation("let a: speaker | integer[] = hostValue\nlet r = a.contains(1)\nexit"),
    { fact: "unknown" },
    { realized: "unknown" },
    "byReceiver",
  );
  assert.equal(
    method("contains").result(inputsOf({ receiver: closedView({ kind: "speaker" }) })).kind,
    "invalid",
  );
  assert.equal(
    method("contains").result(inputsOf({ receiver: BOTTOM_VIEW })).kind,
    "unconstrained",
  );
  assert.deepEqual(method("contains").result(inputsOf({ receiver: dynamicView("host") })), {
    kind: "dynamic",
    why: "host",
  });
  // A receiver with a dynamic remainder keeps it beside the kinds' answers.
  const partly = method("contains").result(
    inputsOf({
      receiver: dynamicView("host", [{ kind: "list", element: INTEGER_TYPE }]),
      arguments: [INTEGER],
    }),
  );
  assert.equal(partly.kind, "alternatives");
});

test("properties are held parts, copies, or computed members by the receiver's kind", () => {
  assert.deepEqual(memberOf("list", "first", LIST), { kind: "held", step: "element" });
  assert.deepEqual(memberOf("set", "first", SET), {
    kind: "projection",
    source: { of: { receiver: true }, path: ["element"] },
  });
  assert.deepEqual(memberOf("list", "length", LIST), { kind: "type", type: INTEGER_TYPE });
  assert.deepEqual(memberOf("set", "length", SET), { kind: "type", type: INTEGER_TYPE });
  assert.deepEqual(memberOf("dict", "values", DICT), {
    kind: "join",
    constructor: "list",
    parts: [{ of: { receiver: true }, path: ["entry"] }],
  });
  assert.equal(memberOf("dict", "first", DICT), undefined);
  const object = closedView({
    kind: "object",
    properties: new PropertyTable([["x", INTEGER_TYPE]]),
  });
  assert.deepEqual(memberOf("object", "x", object), { kind: "held", step: { property: "x" } });
  assert.equal(memberOf("object", "y", object), undefined);
  assert.deepEqual(memberOf("object", "y", closedView({ kind: "object", properties: null })), {
    kind: "dynamic",
    why: "unwritten parts",
  });
  assert.deepEqual(memberOf("speaker", "mood", closedView({ kind: "speaker" })), {
    kind: "dynamic",
    why: "unknown member",
  });
});
