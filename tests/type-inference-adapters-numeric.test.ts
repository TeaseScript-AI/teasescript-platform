import assert from "node:assert/strict";
import test from "node:test";

import {
  ANGLE_TYPE,
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  NULL_TYPE,
  NUMBER_TYPE,
  optional,
  STRING_TYPE,
  union,
  withValues,
  type StaticType,
} from "../src/static-types.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import { minMaxOfValues } from "../src/type-inference/adapters/numeric.js";
import type {
  OperandView,
  OperationInputs,
  OperationRelation,
} from "../src/type-inference/adapters/relation.js";
import type { DynamicWhy } from "../src/type-inference/graph.js";
import {
  assertCase,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
  type AdapterExpectation,
} from "./helpers/adapter-parity.js";
import { OPERANDS } from "./helpers/adapter-operands.js";

/**
 * Parity of the numeric functions and of the value form of `min` and `max` with the legacy checker (work note §5.3,
 * §5.3.1, §6.3): each function with each argument over an operand of every kind of the registry and the compound
 * shapes, the shapes of a call, known values, the named argument, the domains the checker sees, the bounded results
 * of an input the compiler cannot know, and `min` of every pair of the kinds it orders and of the others.
 */
function relation(family: "numeric" | "listFunction", name: string) {
  const found = operationRelations().relation({ family, name });
  assert.ok(found !== undefined, `a relation for ${family}.${name}`);
  return found;
}

const scalar = (name: Extract<StaticType, { kind: "scalar" }>["name"]): StaticType => ({
  kind: "scalar",
  name,
});
const INTEGER = closedView(INTEGER_TYPE);
const NUMBER = closedView(NUMBER_TYPE);
const TEXT = closedView(STRING_TYPE);
const ANGLE = closedView(ANGLE_TYPE);
const HOST = dynamicView("host");
/** A view whose value the fold knows, as a literal's. */
const known = (type: StaticType, value: number): OperandView => ({
  alternatives: [type],
  dynamic: null,
  known: value,
});

/** A bounded case: the legacy's unknown, the declared possibilities, and the dynamic input's provenance. */
function assertBounded(
  relation: OperationRelation,
  inputs: OperationInputs,
  source: string,
  types: readonly StaticType[],
  why: DynamicWhy,
  errors: readonly string[] = [],
): void {
  const result = assertCase(
    relation,
    inputs,
    legacyOperation(source),
    { fact: "unknown", errors },
    { possible: types },
  );
  assert.equal(result.kind === "possible" ? result.why : undefined, why, "the provenance");
}

test("the fixture cases of the parity helper hold of the real relations", () => {
  assertBounded(
    relation("numeric", "abs"),
    inputsOf({ arguments: [HOST] }),
    "let r = abs(hostValue)\nexit",
    [INTEGER_TYPE, NUMBER_TYPE],
    "host",
  );
  assertCase(
    relation("numeric", "abs"),
    inputsOf({ arguments: [closedView(optional(INTEGER_TYPE))] }),
    legacyOperation("let n: integer? = hostValue\nlet r = abs(n)\nexit"),
    { fact: "integer", errors: ["TSV043"] },
    "fact",
    "type",
  );
  assertCase(
    relation("numeric", "round"),
    inputsOf({ arguments: [HOST] }),
    legacyOperation("let r = round(hostValue)\nexit"),
    { fact: "integer" },
    "fact",
    "type",
  );
});

const declaration = (label: string, written: string | undefined) =>
  written ?? `let a: ${label} = hostValue`;

/**
 * What a function gives with one argument of each operand: a fixed kind, whatever the argument, or the kind the
 * argument is prepared as (`integer`, `number`; `integer?` is an integer beside a reported null), no value for an
 * argument of another kind, and the possibilities of both kinds for one the compiler cannot know.
 */
type Answer = { readonly fixed: "integer" | "number" | "angle" } | "argument's kind";

/** Each function, its arguments as written within their domains, and the answer for each argument position. */
const FUNCTIONS: readonly (readonly [string, readonly string[], readonly Answer[]])[] = [
  ["round", ["2"], [{ fixed: "integer" }]],
  ["floor", ["2"], [{ fixed: "integer" }]],
  ["ceil", ["2"], [{ fixed: "integer" }]],
  ["abs", ["2"], ["argument's kind"]],
  ["sign", ["2"], [{ fixed: "integer" }]],
  ["sqrt", ["2"], [{ fixed: "number" }]],
  // The exponent is a known 2: the base's kind decides; the base is a known 2, the exponent's value is not known.
  ["pow", ["2", "2"], ["argument's kind", { fixed: "number" }]],
  ["mod", ["2", "2"], ["argument's kind", "argument's kind"]],
  ["clamp", ["2", "1", "3"], ["argument's kind", "argument's kind", "argument's kind"]],
  ["exp", ["2"], [{ fixed: "number" }]],
  ["ln", ["2"], [{ fixed: "number" }]],
  ["log10", ["2"], [{ fixed: "number" }]],
  ["sin", ["30 deg"], [{ fixed: "number" }]],
  ["cos", ["30 deg"], [{ fixed: "number" }]],
  ["tan", ["30 deg"], [{ fixed: "number" }]],
  ["asin", ["0.5"], [{ fixed: "angle" }]],
  ["acos", ["0.5"], [{ fixed: "angle" }]],
  ["atan", ["2"], [{ fixed: "angle" }]],
  ["atan2", ["2", "2"], [{ fixed: "angle" }, { fixed: "angle" }]],
  ["toDeg", ["30 deg"], [{ fixed: "number" }]],
  ["toRad", ["30 deg"], [{ fixed: "number" }]],
];

const ANGLE_FUNCTIONS = ["sin", "cos", "tan", "toDeg", "toRad"];

/** The view of an argument as written, as the fold knows it. */
function writtenView(written: string): OperandView {
  if (written.endsWith(" deg")) return ANGLE;
  const value = Number(written);
  return known(Number.isInteger(value) ? INTEGER_TYPE : NUMBER_TYPE, value);
}

test("each argument of a numeric function over every kind: the rule's kind, no value, or a bounded result", () => {
  for (const [name, written, answers] of FUNCTIONS)
    answers.forEach((answer, position) => {
      const takes = ANGLE_FUNCTIONS.includes(name)
        ? ["angle", "host"]
        : ["integer", "number", "host"];
      for (const { label, view, declaration: source } of OPERANDS) {
        const args = written.map((text, at) => (at === position ? "a" : text));
        const inputs = inputsOf({
          arguments: written.map((text, at) => (at === position ? view : writtenView(text))),
        });
        const program = `${declaration(label, source)}\nlet r = ${name}(${args.join(", ")})\nexit`;
        const errors = takes.includes(label) ? [] : ["TSV043"];
        if (answer !== "argument's kind") {
          assertCase(
            relation("numeric", name),
            inputs,
            legacyOperation(program),
            { fact: answer.fixed, errors },
            "fact",
            "type",
          );
          continue;
        }
        const kind = label === "integer?" ? "integer" : label;
        if (kind === "integer" || kind === "number")
          assertCase(
            relation("numeric", name),
            inputs,
            legacyOperation(program),
            { fact: kind, errors },
            "fact",
            "type",
          );
        else if (label === "host")
          assertBounded(
            relation("numeric", name),
            inputs,
            program,
            [INTEGER_TYPE, NUMBER_TYPE],
            "host",
          );
        else
          assertCase(
            relation("numeric", name),
            inputs,
            legacyOperation(program),
            { fact: "unknown", errors },
            "invalid",
          );
      }
    });
  // `decimals:` is read by its presence: the rounded number is a number, whatever the argument.
  for (const { label, view, declaration: source } of OPERANDS)
    assertCase(
      relation("numeric", "round"),
      inputsOf({ arguments: [known(NUMBER_TYPE, 1.5)], named: { decimals: view } }),
      legacyOperation(`${declaration(label, source)}\nlet r = round(1.5, decimals: a)\nexit`),
      { fact: "number", errors: ["integer", "number", "host"].includes(label) ? [] : ["TSV043"] },
      "fact",
      "type",
    );
});

test("a call of another shape tells the rule nothing of its arguments: a fixed kind stands, a kind of them has no value", () => {
  const cases: readonly (readonly [
    string,
    string,
    readonly OperandView[],
    Record<string, OperandView>,
    string,
    string,
  ])[] = [
    ["abs", "abs()", [], {}, "unknown", "TSV020"],
    ["abs", "abs(1, 2)", [known(INTEGER_TYPE, 1), known(INTEGER_TYPE, 2)], {}, "unknown", "TSV020"],
    [
      "abs",
      "abs(1, foo: 2)",
      [known(INTEGER_TYPE, 1)],
      { foo: known(INTEGER_TYPE, 2) },
      "unknown",
      "TSV022",
    ],
    ["abs", "abs(hostValue, 1)", [HOST, known(INTEGER_TYPE, 1)], {}, "unknown", "TSV020"],
    ["mod", "mod(1)", [known(INTEGER_TYPE, 1)], {}, "unknown", "TSV020"],
    ["mod", "mod(hostValue)", [HOST], {}, "unknown", "TSV020"],
    [
      "mod",
      "mod(1, 2, 3)",
      [1, 2, 3].map((value) => known(INTEGER_TYPE, value)),
      {},
      "unknown",
      "TSV020",
    ],
    [
      "clamp",
      "clamp(1, 2)",
      [known(INTEGER_TYPE, 1), known(INTEGER_TYPE, 2)],
      {},
      "unknown",
      "TSV020",
    ],
    ["round", "round()", [], {}, "integer", "TSV020"],
    [
      "round",
      "round(1, 2)",
      [known(INTEGER_TYPE, 1), known(INTEGER_TYPE, 2)],
      {},
      "integer",
      "TSV020",
    ],
    [
      "round",
      "round(1, foo: 2)",
      [known(INTEGER_TYPE, 1)],
      { foo: known(INTEGER_TYPE, 2) },
      "integer",
      "TSV022",
    ],
    ["sqrt", "sqrt()", [], {}, "number", "TSV020"],
    // Without its exponent's value the power is a number.
    ["pow", "pow(2)", [known(INTEGER_TYPE, 2)], {}, "number", "TSV020"],
    ["sin", "sin()", [], {}, "number", "TSV020"],
    ["sin", "sin(1 deg, 2 deg)", [ANGLE, ANGLE], {}, "number", "TSV020"],
  ];
  for (const [name, call, args, named, fact, error] of cases)
    assertCase(
      relation("numeric", name),
      inputsOf({ arguments: args, named }),
      legacyOperation(`let r = ${call}\nexit`),
      { fact, errors: [error] },
      fact === "unknown" ? "invalid" : "fact",
    );
});

test("a domain the checker sees in the known arguments is checking-only", () => {
  const cases: readonly (readonly [
    string,
    string,
    readonly OperandView[],
    Record<string, OperandView>,
    string,
  ])[] = [
    ["sqrt", "sqrt(-1)", [known(INTEGER_TYPE, -1)], {}, "number"],
    ["mod", "mod(1, 0)", [known(INTEGER_TYPE, 1), known(INTEGER_TYPE, 0)], {}, "integer"],
    [
      "clamp",
      "clamp(1, 2, 1)",
      [1, 2, 1].map((value) => known(INTEGER_TYPE, value)),
      {},
      "integer",
    ],
    ["ln", "ln(0)", [known(INTEGER_TYPE, 0)], {}, "number"],
    ["asin", "asin(2)", [known(INTEGER_TYPE, 2)], {}, "angle"],
    ["pow", "pow(0, -1)", [known(INTEGER_TYPE, 0), known(INTEGER_TYPE, -1)], {}, "number"],
    ["pow", "pow(-8, 0.5)", [known(INTEGER_TYPE, -8), known(NUMBER_TYPE, 0.5)], {}, "number"],
    [
      "round",
      "round(1.5, decimals: -1)",
      [known(NUMBER_TYPE, 1.5)],
      { decimals: known(INTEGER_TYPE, -1) },
      "number",
    ],
    [
      "round",
      "round(1.5, decimals: 0.5)",
      [known(NUMBER_TYPE, 1.5)],
      { decimals: known(NUMBER_TYPE, 0.5) },
      "number",
    ],
    ["tan", "tan(90 deg)", [ANGLE], {}, "number"],
    ["exp", "exp(1000)", [known(INTEGER_TYPE, 1000)], {}, "number"],
  ];
  for (const [name, call, args, named, fact] of cases)
    assertCase(
      relation("numeric", name),
      inputsOf({ arguments: args, named }),
      legacyOperation(`let r = ${call}\nexit`),
      { fact, errors: ["TSV043"] },
      "fact",
      "type",
    );
  // A domain of the known arguments beside an input the compiler cannot know: the bounded answer stands.
  assertBounded(
    relation("numeric", "mod"),
    inputsOf({ arguments: [HOST, known(INTEGER_TYPE, 0)] }),
    "let r = mod(hostValue, 0)\nexit",
    [INTEGER_TYPE, NUMBER_TYPE],
    "host",
    ["TSV043"],
  );
  assertBounded(
    relation("numeric", "clamp"),
    inputsOf({ arguments: [HOST, known(INTEGER_TYPE, 2), known(INTEGER_TYPE, 1)] }),
    "let r = clamp(hostValue, 2, 1)\nexit",
    [INTEGER_TYPE, NUMBER_TYPE],
    "host",
    ["TSV043"],
  );
});

test("the rule reads the known exponent of a power, the presence of decimals:, and an argument's kinds", () => {
  const cases: readonly (readonly [
    string,
    string,
    readonly OperandView[],
    Record<string, OperandView>,
    string,
    readonly string[],
  ])[] = [
    [
      "pow",
      "let r = pow(2, 3)",
      [known(INTEGER_TYPE, 2), known(INTEGER_TYPE, 3)],
      {},
      "integer",
      [],
    ],
    [
      "pow",
      "let r = pow(2.5, 3)",
      [known(NUMBER_TYPE, 2.5), known(INTEGER_TYPE, 3)],
      {},
      "number",
      [],
    ],
    [
      "pow",
      "let r = pow(2, 0.5)",
      [known(INTEGER_TYPE, 2), known(NUMBER_TYPE, 0.5)],
      {},
      "number",
      [],
    ],
    [
      "pow",
      "let r = pow(2, -1)",
      [known(INTEGER_TYPE, 2), known(INTEGER_TYPE, -1)],
      {},
      "number",
      [],
    ],
    [
      "pow",
      "let k = 3\nlet r = pow(2, k)",
      [known(INTEGER_TYPE, 2), known(INTEGER_TYPE, 3)],
      {},
      "integer",
      [],
    ],
    [
      "pow",
      "let k = -3\nlet r = pow(2, k)",
      [known(INTEGER_TYPE, 2), known(INTEGER_TYPE, -3)],
      {},
      "number",
      [],
    ],
    // The exponent's value decides without the base's kind; without a known exponent the power is a number.
    ["pow", "let r = pow(hostValue, 2.5)", [HOST, known(NUMBER_TYPE, 2.5)], {}, "number", []],
    ["pow", "let r = pow(hostValue, -1)", [HOST, known(INTEGER_TYPE, -1)], {}, "number", []],
    ["pow", "let r = pow(2, hostValue)", [known(INTEGER_TYPE, 2), HOST], {}, "number", []],
    ["pow", 'let r = pow(2, "x")', [known(INTEGER_TYPE, 2), TEXT], {}, "number", ["TSV043"]],
    ["pow", 'let r = pow(hostValue, "x")', [HOST, TEXT], {}, "number", ["TSV043"]],
    [
      "round",
      "let r = round(1.5, decimals: 1)",
      [known(NUMBER_TYPE, 1.5)],
      { decimals: known(INTEGER_TYPE, 1) },
      "number",
      [],
    ],
    [
      "round",
      "let r = round(1.5, decimals: hostValue)",
      [known(NUMBER_TYPE, 1.5)],
      { decimals: HOST },
      "number",
      [],
    ],
    [
      "round",
      "let r = round(hostValue, decimals: 1)",
      [HOST],
      { decimals: known(INTEGER_TYPE, 1) },
      "number",
      [],
    ],
    ["abs", "let r = abs(-1)", [known(INTEGER_TYPE, -1)], {}, "integer", []],
    ["abs", "let r = abs(-1.5)", [known(NUMBER_TYPE, -1.5)], {}, "number", []],
    ["sqrt", 'let r = sqrt("x")', [TEXT], {}, "number", ["TSV043"]],
    // Values a choice restricted are of their plain kind.
    [
      "abs",
      'let c = askChoice 1: "A", 2: "B"\nlet r = abs(c)',
      [closedView(withValues(INTEGER_TYPE, [1, 2]))],
      {},
      "integer",
      [],
    ],
    [
      "pow",
      'let c = askChoice 1: "A", 2: "B"\nlet r = pow(c, 2)',
      [closedView(withValues(INTEGER_TYPE, [1, 2])), known(INTEGER_TYPE, 2)],
      {},
      "integer",
      [],
    ],
    // An argument that may be null is used by its other members; integers beside numbers are numbers.
    [
      "abs",
      "let m: (integer | number)? = hostValue\nlet r = abs(m)",
      [closedView(optional(union([INTEGER_TYPE, NUMBER_TYPE])))],
      {},
      "number",
      ["TSV043"],
    ],
    [
      "abs",
      "let m: integer | number = hostValue\nlet r = abs(m)",
      [closedView(union([INTEGER_TYPE, NUMBER_TYPE]))],
      {},
      "number",
      [],
    ],
    [
      "mod",
      "let n: integer? = hostValue\nlet r = mod(n, 2)",
      [closedView(optional(INTEGER_TYPE)), known(INTEGER_TYPE, 2)],
      {},
      "integer",
      ["TSV043"],
    ],
    [
      "mod",
      "let n: integer? = hostValue\nlet r = mod(n, 2.5)",
      [closedView(optional(INTEGER_TYPE)), known(NUMBER_TYPE, 2.5)],
      {},
      "number",
      ["TSV043"],
    ],
    [
      "sin",
      "let a: angle? = hostValue\nlet r = sin(a)",
      [closedView(optional(ANGLE_TYPE))],
      {},
      "number",
      ["TSV043"],
    ],
    [
      "sin",
      "let a: angle | integer = hostValue\nlet r = sin(a)",
      [closedView(union([ANGLE_TYPE, INTEGER_TYPE]))],
      {},
      "number",
      ["TSV043"],
    ],
    ["sin", "let r = sin(hostValue)", [HOST], {}, "number", []],
    ["asin", "let r = asin(hostValue)", [HOST], {}, "angle", []],
    ["toDeg", "let r = toDeg(1 rad)", [ANGLE], {}, "number", []],
  ];
  for (const [name, source, args, named, fact, errors] of cases)
    assertCase(
      relation("numeric", name),
      inputsOf({ arguments: args, named }),
      legacyOperation(`${source}\nexit`),
      { fact, errors },
      "fact",
      "type",
    );
  // A member of another kind beside the numbers leaves no value; so does a known value outside the contract.
  for (const [name, source, args] of [
    [
      "abs",
      "let a: integer | duration = hostValue\nlet r = abs(a)",
      [closedView(union([INTEGER_TYPE, scalar("duration")]))],
    ],
    ["abs", 'let r = abs("x")', [TEXT]],
    ["mod", 'let r = mod("x", 2)', [TEXT, known(INTEGER_TYPE, 2)]],
    ["pow", 'let r = pow("x", 2)', [TEXT, known(INTEGER_TYPE, 2)]],
    ["mod", 'let r = mod(hostValue, "x")', [HOST, TEXT]],
    ["clamp", 'let r = clamp(hostValue, "x", 2)', [HOST, TEXT, known(INTEGER_TYPE, 2)]],
  ] as const)
    assertCase(
      relation("numeric", name),
      inputsOf({ arguments: args }),
      legacyOperation(`${source}\nexit`),
      { fact: "unknown", errors: ["TSV043"] },
      "invalid",
    );
});

test("an input the compiler cannot know whose kind the rule needs: each numeric kind's result, also one alone", () => {
  for (const [name, source, args, types] of [
    ["mod", "mod(hostValue, 1.5)", [HOST, known(NUMBER_TYPE, 1.5)], [NUMBER_TYPE]],
    [
      "clamp",
      "clamp(hostValue, 1.5, 2)",
      [HOST, known(NUMBER_TYPE, 1.5), known(INTEGER_TYPE, 2)],
      [NUMBER_TYPE],
    ],
    [
      "clamp",
      "clamp(hostValue, 1, 2)",
      [HOST, known(INTEGER_TYPE, 1), known(INTEGER_TYPE, 2)],
      [INTEGER_TYPE, NUMBER_TYPE],
    ],
    ["mod", "mod(hostValue, hostValue)", [HOST, HOST], [INTEGER_TYPE, NUMBER_TYPE]],
    [
      "clamp",
      "clamp(hostValue, hostValue, 2.5)",
      [HOST, HOST, known(NUMBER_TYPE, 2.5)],
      [NUMBER_TYPE],
    ],
    ["pow", "pow(hostValue, 2)", [HOST, known(INTEGER_TYPE, 2)], [INTEGER_TYPE, NUMBER_TYPE]],
  ] as const)
    assertBounded(
      relation("numeric", name),
      inputsOf({ arguments: args }),
      `let r = ${source}\nexit`,
      types,
      "host",
    );
  // A nested result: the outer function gets the JSON's dynamic data and answers its bound; the inner call's report is
  // inside the operation.
  assertBounded(
    relation("numeric", "abs"),
    inputsOf({ arguments: [dynamicView("json")] }),
    'let r = abs(fromJson("bad"))\nexit',
    [INTEGER_TYPE, NUMBER_TYPE],
    "json",
    ["TSV020"],
  );
  assertBounded(
    relation("numeric", "abs"),
    inputsOf({ arguments: [dynamicView("json")] }),
    'let r = abs(fromJson("1", default: 0))\nexit',
    [INTEGER_TYPE, NUMBER_TYPE],
    "json",
  );
  // A dynamic remainder beside a closed integer: the input may be either numeric kind.
  assert.deepEqual(
    relation("numeric", "abs").result(
      inputsOf({ arguments: [dynamicView("host", [INTEGER_TYPE])] }),
    ),
    { kind: "possible", types: [INTEGER_TYPE, NUMBER_TYPE], why: "host" },
  );
});

test("a relation answers from its inputs alone: an input the rule needs waits while it is bottom", () => {
  const abs = relation("numeric", "abs");
  const mod = relation("numeric", "mod");
  assert.equal(abs.result(inputsOf({ arguments: [BOTTOM_VIEW] })).kind, "unconstrained");
  assert.deepEqual(abs.result(inputsOf({ arguments: [NUMBER] })), {
    kind: "type",
    type: NUMBER_TYPE,
  });
  assert.equal(abs.result(inputsOf({ arguments: [BOTTOM_VIEW] })).kind, "unconstrained");
  // A bottom and a dynamic input together wait; a rule that needs no input's kind does not.
  assert.equal(mod.result(inputsOf({ arguments: [BOTTOM_VIEW, HOST] })).kind, "unconstrained");
  assert.equal(mod.result(inputsOf({ arguments: [HOST, BOTTOM_VIEW] })).kind, "unconstrained");
  assert.deepEqual(mod.result(inputsOf({ arguments: [INTEGER, known(INTEGER_TYPE, 2)] })), {
    kind: "type",
    type: INTEGER_TYPE,
  });
  assert.deepEqual(relation("numeric", "round").result(inputsOf({ arguments: [BOTTOM_VIEW] })), {
    kind: "type",
    type: INTEGER_TYPE,
  });
  assert.deepEqual(
    relation("numeric", "pow").result(
      inputsOf({ arguments: [BOTTOM_VIEW, known(NUMBER_TYPE, 0.5)] }),
    ),
    { kind: "type", type: NUMBER_TYPE },
  );
});

/** The value form's operands: each kind `min` orders, and others, as written in a call and as their views hold them. */
const VALUES: readonly (readonly [string, string, OperandView])[] = [
  ["integer", "1", INTEGER],
  ["number", "1.5", NUMBER],
  ["duration", "1 s", closedView(scalar("duration"))],
  ["calendarDuration", "1 calendar days", closedView(scalar("calendarDuration"))],
  ["angle", "1 deg", ANGLE],
  ["date", "getDate()", closedView(scalar("date"))],
  ["time", "getTime()", closedView(scalar("time"))],
  ["datetime", "getDateTime()", closedView(scalar("datetime"))],
  ["absoluteDateTime", "getAbsoluteDateTime()", closedView(scalar("absoluteDateTime"))],
  ["string", '"x"', TEXT],
  ["boolean", "true", closedView(BOOLEAN_TYPE)],
  ["null", "null", closedView(NULL_TYPE)],
  ["host", "hostValue", HOST],
  ["integer?", "n", closedView(optional(INTEGER_TYPE))],
  ["integer|duration", "u", closedView(union([INTEGER_TYPE, scalar("duration")]))],
  ["integer[]", "[1]", closedView({ kind: "list", element: INTEGER_TYPE })],
];

/** The kinds `min` orders, which a value the compiler cannot know may be. */
const ORDERED: readonly StaticType[] = [
  INTEGER_TYPE,
  NUMBER_TYPE,
  scalar("duration"),
  scalar("calendarDuration"),
  ANGLE_TYPE,
  scalar("date"),
  scalar("time"),
  scalar("datetime"),
  scalar("absoluteDateTime"),
];

/** The possibilities of `min` of a value the compiler cannot know beside a value of each kind. */
const BESIDE_HOST: Readonly<Record<string, readonly StaticType[]>> = {
  integer: [INTEGER_TYPE, NUMBER_TYPE],
  number: [NUMBER_TYPE],
  duration: [scalar("duration")],
  calendarDuration: [scalar("calendarDuration")],
  angle: [ANGLE_TYPE],
  date: [scalar("date")],
  time: [scalar("time")],
  datetime: [scalar("datetime")],
  absoluteDateTime: [scalar("absoluteDateTime")],
  host: ORDERED,
  "integer?": [INTEGER_TYPE, NUMBER_TYPE],
};

/**
 * `min(row, column)` as the legacy checks it, in the order of `VALUES`: the fact's kind, no value (`invalid`), or the
 * possibilities beside a value the compiler cannot know (`possible`); each `!` is a TSV043 at the call.
 */
const PAIRS: readonly (readonly [string, readonly string[]])[] = [
  [
    "integer",
    [
      "integer",
      "number",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "integer!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "number",
    [
      "number",
      "number",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "number!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "duration",
    [
      "invalid!",
      "invalid!",
      "duration",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "calendarDuration",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "calendarDuration",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "angle",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "angle",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "date",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "date",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "time",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "time",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "datetime",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "datetime",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "absoluteDateTime",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "absoluteDateTime",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "string",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!!",
      "invalid!!",
      "invalid!",
    ],
  ],
  [
    "boolean",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!!",
      "invalid!!",
      "invalid!",
    ],
  ],
  [
    "null",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!!",
      "invalid!!",
      "invalid!",
    ],
  ],
  [
    "host",
    [
      "possible",
      "possible",
      "possible",
      "possible",
      "possible",
      "possible",
      "possible",
      "possible",
      "possible",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible",
      "possible!",
      "invalid!",
      "invalid!",
    ],
  ],
  [
    "integer?",
    [
      "integer!",
      "number!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "possible!",
      "integer!!",
      "invalid!!",
      "invalid!",
    ],
  ],
  [
    "integer|duration",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!!",
      "invalid!!",
      "invalid!",
    ],
  ],
  [
    "integer[]",
    [
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!",
      "invalid!!",
      "invalid!!",
      "invalid!",
    ],
  ],
];

const VALUE_DECLARATIONS = "let n: integer? = hostValue\nlet u: integer | duration = hostValue\n";

test("min of every pair of values: one kind it orders gives that kind, a value it cannot know the possibilities", () => {
  assert.deepEqual(
    PAIRS.map(([label]) => label),
    VALUES.map(([label]) => label),
  );
  const min = relation("listFunction", "min");
  for (const [row, cells] of PAIRS) {
    const [, left, leftView] = VALUES.find(([label]) => label === row)!;
    cells.forEach((cell, column) => {
      const [other, right, rightView] = VALUES[column]!;
      const answer = cell.replaceAll("!", "");
      const errors = [...cell].filter((character) => character === "!").map(() => "TSV043");
      const inputs = inputsOf({ arguments: [leftView, rightView] });
      const source = `${VALUE_DECLARATIONS}let r = min(${left}, ${right})\nexit`;
      if (answer === "possible")
        assertBounded(
          min,
          inputs,
          source,
          BESIDE_HOST[row === "host" ? other : row]!,
          "host",
          errors,
        );
      else
        assertCase(
          min,
          inputs,
          legacyOperation(source),
          { fact: answer === "invalid" ? "unknown" : answer, errors },
          answer === "invalid" ? "invalid" : "fact",
        );
    });
  }
});

test("min and max of more values, of fewer than two, and the note's rows", () => {
  const value = (label: string) => VALUES.find(([name]) => name === label)![2];
  const cases: readonly (readonly [
    "min" | "max",
    string,
    readonly string[],
    string,
    readonly string[],
    AdapterExpectation?,
  ])[] = [
    ["max", "max(1, 2)", ["integer", "integer"], "integer", []],
    ["max", "max(1, 2.5)", ["integer", "number"], "number", []],
    ["max", "max(1 s, 2 s)", ["duration", "duration"], "duration", []],
    ["max", "max(getTime(), getTime())", ["time", "time"], "time", []],
    ["min", "min(1, 2, 3)", ["integer", "integer", "integer"], "integer", []],
    ["min", "min(1, 2, 3.5)", ["integer", "integer", "number"], "number", []],
    ["min", "min(1 s, 2 s, 3 s)", ["duration", "duration", "duration"], "duration", []],
    ["min", "min(getDate(), getDate(), getDate())", ["date", "date", "date"], "date", []],
    [
      "min",
      "min(1 calendar days, 2 calendar days)",
      ["calendarDuration", "calendarDuration"],
      "calendarDuration",
      [],
    ],
    // Known calendar durations of two families are reported; the result is still a calendar duration.
    [
      "min",
      "min(1 calendar months, 1 calendar days)",
      ["calendarDuration", "calendarDuration"],
      "calendarDuration",
      ["TSV043"],
    ],
    [
      "min",
      "min(1 calendar days, 1 s)",
      ["calendarDuration", "duration"],
      "unknown",
      ["TSV043"],
      "invalid",
    ],
    ["min", "min(1, 2 s, 3)", ["integer", "duration", "integer"], "unknown", ["TSV043"], "invalid"],
    ["min", "min(n, 2)", ["integer?", "integer"], "integer", ["TSV043"]],
    ["min", 'min(1, "x")', ["integer", "string"], "unknown", ["TSV043"], "invalid"],
    ["min", "min(1 deg, 2)", ["angle", "integer"], "unknown", ["TSV043"], "invalid"],
    ["min", "min()", [], "unknown", ["TSV020"], "invalid"],
    ["min", "min(1)", ["integer"], "unknown", ["TSV020"], "invalid"],
    ["min", "min(1 s)", ["duration"], "unknown", ["TSV020"], "invalid"],
    ["min", 'min("x")', ["string"], "unknown", ["TSV020"], "invalid"],
  ];
  for (const [name, call, labels, fact, errors, adapter] of cases)
    assertCase(
      relation("listFunction", name),
      inputsOf({ arguments: labels.map(value) }),
      legacyOperation(`${VALUE_DECLARATIONS}let r = ${call}\nexit`),
      { fact, errors },
      adapter ?? "fact",
    );
  assertBounded(
    relation("listFunction", "min"),
    inputsOf({ arguments: [HOST, HOST, INTEGER] }),
    "let r = min(hostValue, hostValue, 1)\nexit",
    [INTEGER_TYPE, NUMBER_TYPE],
    "host",
  );
});

test("the legacy's value form folds the named arguments' values too", () => {
  // `min(1, 2, by: 1.5)` reports the name and folds its value: the routed value form gives the legacy's result of
  // the views of every argument, positional and named.
  for (const [name, call, args, named, fact] of [
    ["min", "min(1, 2, by: 1)", [INTEGER, INTEGER], { by: INTEGER }, "integer"],
    ["min", "min(1, 2, by: 1.5)", [INTEGER, INTEGER], { by: NUMBER }, "number"],
    [
      "min",
      "min(1 s, 2 s, foo: 1 s)",
      [1, 2].map(() => closedView(scalar("duration"))),
      { foo: closedView(scalar("duration")) },
      "duration",
    ],
    ["max", "max(1, by: 2)", [INTEGER], { by: INTEGER }, "integer"],
    ["min", 'min(1, 2, by: "x")', [INTEGER, INTEGER], { by: TEXT }, "unknown"],
  ] as const)
    assertCase(
      relation("listFunction", name),
      inputsOf({ arguments: args, named }),
      legacyOperation(`let r = ${call}\nexit`),
      { fact, errors: ["TSV022"] },
      fact === "unknown" ? "invalid" : "fact",
    );
});

test("minMaxOfValues answers from its inputs alone: a bottom value waits", () => {
  assert.equal(minMaxOfValues([BOTTOM_VIEW, INTEGER]).kind, "unconstrained");
  assert.equal(minMaxOfValues([HOST, BOTTOM_VIEW]).kind, "unconstrained");
  assert.deepEqual(minMaxOfValues([INTEGER, NUMBER]), { kind: "type", type: NUMBER_TYPE });
  assert.equal(minMaxOfValues([BOTTOM_VIEW, INTEGER]).kind, "unconstrained");
  assert.equal(minMaxOfValues([BOTTOM_VIEW]).kind, "invalid");
  // A dynamic remainder beside a closed duration: a duration, or what a dynamic value beside the integer gives.
  assert.deepEqual(minMaxOfValues([dynamicView("host", [scalar("duration")]), INTEGER]), {
    kind: "possible",
    types: [INTEGER_TYPE, NUMBER_TYPE],
    why: "host",
  });
  assert.deepEqual(
    minMaxOfValues([dynamicView("host", [scalar("duration")]), closedView(scalar("duration"))]),
    { kind: "possible", types: [scalar("duration")], why: "host" },
  );
});
