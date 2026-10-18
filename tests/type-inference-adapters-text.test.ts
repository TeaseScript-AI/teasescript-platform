import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  NULL_TYPE,
  NUMBER_TYPE,
  optional,
  PropertyTable,
  REGEX_TYPE,
  STRING_TYPE,
  union,
  withValues,
  type StaticType,
} from "../src/static-types.js";
import { memberOf, operationRelations } from "../src/type-inference/adapters/index.js";
import type { OperandView, OperationRelation } from "../src/type-inference/adapters/relation.js";
import { INVALID } from "../src/type-inference/adapters/views.js";
import type { ValueKind } from "../src/value-kinds.js";
import {
  assertCase,
  assertEqualResult,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
  type AdapterExpectation,
  type LegacyExpectation,
} from "./helpers/adapter-parity.js";

/**
 * Parity of the members of text with the legacy checker (work note §5.4, §6.3): every method of `TEXT_METHODS` with
 * its arguments written, each argument over an operand of every kind of the registry and the compound shapes, the
 * shape and domain problems the visitor reports, `length`, the members text does not have, and text among other
 * kinds of a receiver, which `members.ts` composes.
 */
function method(name: string) {
  const relation = operationRelations().relation({ family: "method", name });
  assert.ok(relation !== undefined, `a relation for method.${name}`);
  return relation;
}

/** A property read, for parity with the legacy's fact: the member's answer; a member text does not have is none. */
function assertProperty(
  kind: ValueKind,
  name: string,
  receiver: OperandView,
  source: string,
  legacy: LegacyExpectation,
  adapter: AdapterExpectation,
): void {
  const answer = memberOf(kind, name, receiver);
  assert.ok(answer?.kind !== "held", "text holds no part");
  if (adapter === "invalid") assert.equal(answer, undefined, `no member ${name}`);
  const read: OperationRelation = {
    contract: { family: "method", name },
    result: () => answer ?? INVALID,
  };
  assertCase(read, inputsOf({ receiver }), legacyOperation(source), legacy, adapter);
}

const scalar = (name: Extract<StaticType, { kind: "scalar" }>["name"]): StaticType => ({
  kind: "scalar",
  name,
});
const TEXT = closedView(STRING_TYPE);
const S = "let s: string = hostValue\n";

/** An operand of each kind, as `let a` declares it (an annotation where it is written) and as its view holds it. */
const OPERANDS: readonly (readonly [string, OperandView, string?])[] = [
  ["integer", closedView(INTEGER_TYPE)],
  ["number", closedView(NUMBER_TYPE)],
  ["string", closedView(STRING_TYPE)],
  ["boolean", closedView(BOOLEAN_TYPE)],
  ["duration", closedView(scalar("duration"))],
  ["calendarDuration", closedView(scalar("calendarDuration"))],
  ["angle", closedView(scalar("angle"))],
  ["date", closedView(scalar("date"))],
  ["time", closedView(scalar("time"))],
  ["datetime", closedView(scalar("datetime"))],
  ["absoluteDateTime", closedView(scalar("absoluteDateTime"))],
  ["script", closedView(scalar("script"))],
  ["regex", closedView(REGEX_TYPE)],
  ["range", closedView({ kind: "range" })],
  ["integer[]", closedView({ kind: "list", element: INTEGER_TYPE })],
  ["string[]", closedView({ kind: "list", element: STRING_TYPE })],
  ["integer set", closedView({ kind: "set", element: INTEGER_TYPE })],
  ["integer dict", closedView({ kind: "dict", element: INTEGER_TYPE })],
  ["string dict", closedView({ kind: "dict", element: STRING_TYPE })],
  [
    "object",
    closedView({ kind: "object", properties: new PropertyTable([["x", INTEGER_TYPE]]) }),
    "let a = { x: 1 }",
  ],
  [
    "speaker",
    closedView({ kind: "speaker" }),
    'speaker guide {\n displayName: "Guide"\n}\nlet a = guide',
  ],
  ["timer", closedView({ kind: "timer" })],
  ["media", closedView({ kind: "media" })],
  ["camera", closedView({ kind: "camera" }), "let a = showCamera"],
  [
    "permanentButton",
    closedView({ kind: "permanentButton" }),
    'let a = showPermanentButton "B" { }',
  ],
  ["messageHandle", closedView({ kind: "messageHandle" })],
  ["null", closedView(NULL_TYPE), "let a = null"],
  ["host", dynamicView("host"), "let a = hostValue"],
  ["integer?", closedView(optional(INTEGER_TYPE))],
  ["integer | string", closedView(union([INTEGER_TYPE, STRING_TYPE]))],
];

const declaration = (label: string, written: string | undefined) =>
  written ?? `let a: ${label} = hostValue`;

/** A written argument of each parameter kind, the operands the kind takes without an error, and their views. */
const PARAMETERS = {
  text: { written: '"x"', view: TEXT, takes: ["string", "host"] },
  regex: { written: "/x/", view: closedView(REGEX_TYPE), takes: ["regex", "host"] },
  textOrRegex: { written: '"x"', view: TEXT, takes: ["string", "regex", "host"] },
  position: { written: "0", view: closedView(INTEGER_TYPE), takes: ["integer", "host"] },
  count: { written: "1", view: closedView(INTEGER_TYPE), takes: ["integer", "host"] },
} as const;

/** Each method of text by its parameters' kinds and its fact. */
const METHODS: readonly (readonly [string, readonly (keyof typeof PARAMETERS)[], string])[] = [
  ["contains", ["textOrRegex"], "boolean"],
  ["startsWith", ["text"], "boolean"],
  ["endsWith", ["text"], "boolean"],
  ["indexOf", ["textOrRegex"], "(integer|null)"],
  ["lastIndexOf", ["textOrRegex"], "(integer|null)"],
  ["count", ["textOrRegex"], "integer"],
  ["substring", ["position", "position"], "string"],
  ["split", ["textOrRegex"], "list<string>"],
  ["replace", ["textOrRegex", "text"], "string"],
  ["matches", ["regex"], "boolean"],
  ["find", ["regex"], "(null|string)"],
  ["capture", ["regex"], "(list<(null|string)>|null)"],
  ["findAll", ["regex"], "list<string>"],
  ["trim", [], "string"],
  ["trimStart", [], "string"],
  ["trimEnd", [], "string"],
  ["uppercase", [], "string"],
  ["lowercase", [], "string"],
  ["uppercaseFirst", [], "string"],
  ["reverse", [], "string"],
  ["repeat", ["count"], "string"],
  ["padStart", ["count", "text"], "string"],
  ["padEnd", ["count", "text"], "string"],
];

test("every method of text gives a new value of its result", () => {
  for (const [name, parameters] of METHODS)
    assertEqualResult(
      method(name),
      inputsOf({
        receiver: TEXT,
        arguments: parameters.map((parameter) => PARAMETERS[parameter].view),
      }),
      legacyOperation(
        `${S}let r = s.${name}(${parameters.map((parameter) => PARAMETERS[parameter].written).join(", ")})\nexit`,
      ),
      "type",
    );
});

test("an argument of any kind is the visitor's check: the method's result stands", () => {
  for (const [name, parameters, fact] of METHODS)
    parameters.forEach((parameter, index) => {
      for (const [label, view, written] of OPERANDS) {
        const args = parameters.map((other, at) =>
          at === index ? "a" : PARAMETERS[other].written,
        );
        assertCase(
          method(name),
          inputsOf({
            receiver: TEXT,
            arguments: parameters.map((other, at) =>
              at === index ? view : PARAMETERS[other].view,
            ),
          }),
          legacyOperation(
            `${S}${declaration(label, written)}\nlet r = s.${name}(${args.join(", ")})\nexit`,
          ),
          {
            fact,
            errors: PARAMETERS[parameter].takes.some((taken) => taken === label) ? [] : ["TSV043"],
          },
          "fact",
          "type",
        );
      }
    });
});

test("the number of arguments, a name and a known value outside a domain are checking-only", () => {
  const cases: readonly (readonly [string, string, readonly OperandView[], string, string])[] = [
    ["trim", `${S}let r = s.trim(1)`, [closedView(INTEGER_TYPE)], "string", "TSV020"],
    ["substring", `${S}let r = s.substring()`, [], "string", "TSV020"],
    [
      "substring",
      `${S}let r = s.substring(1, 2, 3)`,
      [1, 2, 3].map(() => closedView(INTEGER_TYPE)),
      "string",
      "TSV020",
    ],
    ["replace", `${S}let r = s.replace("x")`, [TEXT], "string", "TSV020"],
    ["substring", 'let r = "abc".substring(5)', [closedView(INTEGER_TYPE)], "string", "TSV043"],
    ["repeat", 'let r = "a".repeat(-1)', [closedView(INTEGER_TYPE)], "string", "TSV043"],
    ["count", 'let r = "a".count("")', [TEXT], "integer", "TSV043"],
    [
      "replace",
      'let r = "a".replace(/a/, "$1")',
      [closedView(REGEX_TYPE), TEXT],
      "string",
      "TSV043",
    ],
    [
      "padStart",
      'let r = "a".padStart(3, "")',
      [closedView(INTEGER_TYPE), TEXT],
      "string",
      "TSV043",
    ],
  ];
  for (const [name, source, args, fact, error] of cases)
    assertCase(
      method(name),
      inputsOf({ receiver: TEXT, arguments: args }),
      legacyOperation(`${source}\nexit`),
      { fact, errors: [error] },
      "fact",
    );
  // Arguments are positional: a name is reported and the method still gives its result.
  assertCase(
    method("split"),
    inputsOf({ receiver: TEXT, named: { separator: TEXT } }),
    legacyOperation(`${S}let r = s.split(separator: ",")\nexit`),
    { fact: "list<string>", errors: ["TSV022"] },
    "fact",
  );
});

test("text of known or restricted values has the same members", () => {
  assertEqualResult(
    method("trim"),
    inputsOf({ receiver: closedView(STRING_TYPE) }),
    legacyOperation('let r = " a ".trim()\nexit'),
  );
  const restricted = closedView(withValues(STRING_TYPE, ["a", "bb"]));
  assertEqualResult(
    method("trim"),
    inputsOf({ receiver: restricted }),
    legacyOperation('let c = askChoice "a", "bb"\nlet r = c.trim()\nexit'),
  );
  assertProperty(
    "string",
    "length",
    restricted,
    'let c = askChoice "a", "bb"\nlet r = c.length\nexit',
    { fact: "integer" },
    "fact",
  );
  assertProperty(
    "string",
    "length",
    TEXT,
    `${S}let r = s.length\nexit`,
    { fact: "integer" },
    "fact",
  );
  assertProperty(
    "string",
    "length",
    TEXT,
    'let r = "abc".length\nexit',
    { fact: "integer" },
    "fact",
  );
});

test("a member text does not have is none, also a method of lists such as join", () => {
  for (const name of ["foo", "first"])
    assertProperty(
      "string",
      name,
      TEXT,
      `${S}let r = s.${name}\nexit`,
      { fact: "unknown", errors: ["TSV043"] },
      "invalid",
    );
  for (const [name, call, args] of [
    ["foo", "foo()", []],
    ["join", 'join(",")', [TEXT]],
    ["toList", "toList()", []],
    ["add", 'add("x")', [TEXT]],
    ["sort", "sort()", []],
    ["format", "format()", []],
  ] as const)
    assertCase(
      method(name),
      inputsOf({ receiver: TEXT, arguments: args }),
      legacyOperation(`${S}let r = s.${call}\nexit`),
      { fact: "unknown", errors: ["TSV043"] },
      "invalid",
    );
  assertCase(
    method("get"),
    inputsOf({ receiver: TEXT, arguments: [closedView(INTEGER_TYPE)], named: { default: TEXT } }),
    legacyOperation(`${S}let r = s.get(0, default: "x")\nexit`),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
});

test("text among the kinds of a receiver: its case beside the others', every kind must have the method", () => {
  const textOrList = closedView(union([STRING_TYPE, { kind: "list", element: INTEGER_TYPE }]));
  const reversed = assertCase(
    method("reverse"),
    inputsOf({ receiver: textOrList }),
    legacyOperation("let a: string | integer[] = hostValue\nlet r = a.reverse()\nexit"),
    { fact: "(null|string)" },
    "fact",
    "byReceiver",
  );
  assert.deepEqual(
    reversed.kind === "byReceiver" ? reversed.cases.map((entry) => entry.receiver) : [],
    ["string", "list"],
  );
  assertCase(
    method("contains"),
    inputsOf({ receiver: textOrList, arguments: [TEXT] }),
    legacyOperation('let a: string | integer[] = hostValue\nlet r = a.contains("x")\nexit'),
    { fact: "boolean" },
    "fact",
    "byReceiver",
  );
  assertCase(
    method("indexOf"),
    inputsOf({
      receiver: closedView(union([STRING_TYPE, { kind: "list", element: STRING_TYPE }])),
      arguments: [TEXT],
    }),
    legacyOperation('let a: string | string[] = hostValue\nlet r = a.indexOf("x")\nexit'),
    { fact: "(integer|null)" },
    "fact",
    "byReceiver",
  );
  for (const [annotation, view] of [
    ["string?", closedView(optional(STRING_TYPE))],
    ["string | integer", closedView(union([STRING_TYPE, INTEGER_TYPE]))],
  ] as const)
    assertCase(
      method("trim"),
      inputsOf({ receiver: view }),
      legacyOperation(`let a: ${annotation} = hostValue\nlet r = a.trim()\nexit`),
      { fact: "unknown", errors: ["TSV043"] },
      "invalid",
    );
  assertCase(
    method("format"),
    inputsOf({ receiver: closedView(union([STRING_TYPE, scalar("date")])) }),
    legacyOperation("let a: string | date = hostValue\nlet r = a.format()\nexit"),
    { fact: "unknown", errors: ["TSV043"] },
    "invalid",
  );
  // A speaker beside text: the runtime checks the speaker; the legacy's unknown without an error.
  assertCase(
    method("trim"),
    inputsOf({ receiver: closedView(union([STRING_TYPE, { kind: "speaker" }])) }),
    legacyOperation(
      'speaker guide {\n displayName: "G"\n}\nlet a: string | speaker = hostValue\nlet r = a.trim()\nexit',
    ),
    { fact: "unknown" },
    { realized: "unknown" },
    "byReceiver",
  );
  // The text the compiler cannot know: the receiver's provenance.
  assertCase(
    method("trim"),
    inputsOf({ receiver: dynamicView("host") }),
    legacyOperation("let r = hostText.trim()\nexit"),
    { fact: "unknown" },
    { dynamic: "host" },
  );
});

test("a relation answers from its inputs alone: bottom waits, a dynamic remainder is kept", () => {
  const trim = method("trim");
  assert.equal(trim.result(inputsOf({ receiver: BOTTOM_VIEW })).kind, "unconstrained");
  assert.deepEqual(trim.result(inputsOf({ receiver: TEXT })), { kind: "type", type: STRING_TYPE });
  assert.equal(trim.result(inputsOf({ receiver: BOTTOM_VIEW })).kind, "unconstrained");
  assert.deepEqual(trim.result(inputsOf({ receiver: dynamicView("host", [STRING_TYPE]) })), {
    kind: "alternatives",
    results: [
      { kind: "type", type: STRING_TYPE },
      { kind: "dynamic", why: "host" },
    ],
  });
  // The arguments do not decide the result, also when the solver knows nothing of them yet.
  assert.deepEqual(
    method("indexOf").result(inputsOf({ receiver: TEXT, arguments: [BOTTOM_VIEW] })),
    { kind: "type", type: optional(INTEGER_TYPE) },
  );
});
