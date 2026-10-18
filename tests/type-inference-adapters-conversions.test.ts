import assert from "node:assert/strict";
import test from "node:test";

import type { ConversionName } from "../src/language-facts.js";
import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  NULL_TYPE,
  NUMBER_TYPE,
  optional,
  REGEX_TYPE,
  STRING_TYPE,
  type StaticType,
} from "../src/static-types.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import type { OperandView } from "../src/type-inference/adapters/relation.js";
import type { ContractFamily } from "../src/type-inference/graph.js";
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
 * Parity of the conversions and of the file, hash and lock calls, `escapeMarkup` and `script` with the legacy checker
 * (work note §5.2, §6.3): each call over an operand of every kind of the registry and the compound shapes, and each
 * `default:` policy with a known fitting, a known unfitting, a dynamic, a null and an absent default. The legacy's
 * facts and errors are declared per row; the operand's kind is checking-only, so the result is the call's.
 */
function relation(family: ContractFamily, name: string) {
  const found = operationRelations().relation({ family, name });
  assert.ok(found !== undefined, `a relation for ${family}.${name}`);
  assert.deepEqual(found.contract, { family, name }, "the relation's contract");
  return found;
}

const scalar = (name: Extract<StaticType, { kind: "scalar" }>["name"]): StaticType => ({
  kind: "scalar",
  name,
});

const SCALARS = [
  "integer",
  "number",
  "string",
  "boolean",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "script",
  "regex",
];

/** The operands a call reports nothing for: the text it reads, and a value the compiler cannot know. */
const TEXT = ["string", "host"];
/** Text beside another kind: the call may get its text when the script runs. */
const TEXT_AMONG = [...TEXT, "integer | string"];

/**
 * Per conversion, the call written with the default it needs, its fact, the operands it reports nothing for (every
 * other reports TSV043), and the adapter's answer.
 */
const CONVERSION_CALLS: Readonly<
  Record<
    ConversionName,
    {
      readonly call: string;
      readonly fact: string;
      readonly takes: readonly string[];
      readonly default?: OperandView;
      readonly adapter?: AdapterExpectation;
    }
  >
> = {
  toString: {
    call: "toString(a)",
    fact: "string",
    takes: [...SCALARS, "null", "host", "integer?", "integer | string"],
  },
  toNumber: {
    call: "toNumber(a)",
    fact: "number",
    takes: ["integer", "number", "string", "host", "integer?", "integer | string"],
  },
  toInteger: {
    call: "toInteger(a)",
    fact: "integer",
    takes: ["integer", "number", "string", "host", "integer?", "integer | string"],
  },
  toBoolean: { call: "toBoolean(a)", fact: "boolean", takes: [...TEXT_AMONG, "boolean"] },
  toDate: { call: "toDate(a)", fact: "date", takes: [...TEXT_AMONG, "date", "datetime"] },
  toTime: { call: "toTime(a)", fact: "time", takes: [...TEXT_AMONG, "time", "datetime"] },
  toDateTime: { call: "toDateTime(a)", fact: "datetime", takes: [...TEXT_AMONG, "datetime"] },
  toAbsoluteDateTime: {
    call: "toAbsoluteDateTime(a)",
    fact: "absoluteDateTime",
    takes: [...TEXT_AMONG, "absoluteDateTime"],
  },
  toRegex: {
    call: "toRegex(a, default: null)",
    fact: "(null|regex)",
    takes: TEXT_AMONG,
    default: closedView(NULL_TYPE),
  },
  toJson: {
    call: "toJson(a)",
    fact: "string",
    takes: [
      "integer",
      "number",
      "string",
      "boolean",
      "duration",
      "angle",
      "date",
      "time",
      "datetime",
      "absoluteDateTime",
      "integer[]",
      "string[]",
      "integer set",
      "integer dict",
      "string dict",
      "object",
      "speaker",
      "null",
      "host",
      "integer?",
      "integer | string",
    ],
  },
  fromJson: {
    call: "fromJson(a, default: 1)",
    fact: "unknown",
    takes: TEXT_AMONG,
    default: closedView(INTEGER_TYPE),
    // The written default's copy joins the JSON result (stage 3a); the legacy's union absorbs it into unknown.
    adapter: "unknown",
  },
  toBase64: { call: "toBase64(a)", fact: "string", takes: TEXT },
  fromBase64: {
    call: 'fromBase64(a, default: "d")',
    fact: "string",
    takes: TEXT_AMONG,
    default: closedView(STRING_TYPE),
  },
};

test("a conversion of an operand of any kind gives its result; the operand's kind is checking-only", () => {
  for (const [name, row] of Object.entries(CONVERSION_CALLS)) {
    for (const { label, declaration, view } of OPERANDS) {
      const named = row.default === undefined ? {} : { default: row.default };
      assertCase(
        relation("conversion", name),
        inputsOf({ arguments: [view], named }),
        legacyOperation(`${declaration}\nlet r = ${row.call}\nexit`),
        { fact: row.fact, errors: row.takes.includes(label) ? [] : ["TSV043"] },
        row.adapter ?? "fact",
      );
    }
  }
});

/** A `default:` as written and as its view holds it. */
type WrittenDefault = readonly [string, OperandView];

const DEFAULTS = {
  integer: ["1", closedView(INTEGER_TYPE)],
  text: ['"y"', closedView(STRING_TYPE)],
  null: ["null", closedView(NULL_TYPE)],
  host: ["hostValue", dynamicView("host")],
  list: ["[1]", closedView({ kind: "list", element: INTEGER_TYPE })],
  regex: ["/x/", closedView(REGEX_TYPE)],
  "regex?": ["nullable", closedView(optional(REGEX_TYPE))],
} as const satisfies Record<string, WrittenDefault>;

/** A conversion of `hostText` with a written default, or none. */
function withDefault(
  name: string,
  written: WrittenDefault | null,
  legacy: { readonly fact: string; readonly errors?: readonly string[] },
  adapter: AdapterExpectation,
  tag: "type" | "alternatives" | "dynamic",
): void {
  assertCase(
    relation("conversion", name),
    inputsOf({
      arguments: [dynamicView("host")],
      named: written === null ? {} : { default: written[1] },
    }),
    legacyOperation(
      `let nullable: regex? = hostValue\nlet r = ${name}(hostText${written === null ? "" : `, default: ${written[0]}`})\nexit`,
    ),
    legacy,
    adapter,
    tag,
  );
}

test("a default of the result's kind: the result, whether the default fits, is null, dynamic or absent", () => {
  const RESULTS: readonly (readonly [string, string, WrittenDefault])[] = [
    ["toString", "string", DEFAULTS.text],
    ["toNumber", "number", ["1.5", closedView(NUMBER_TYPE)]],
    ["toInteger", "integer", DEFAULTS.integer],
    ["toBoolean", "boolean", ["true", closedView(BOOLEAN_TYPE)]],
    ["toDate", "date", ["getDate()", closedView(scalar("date"))]],
    ["toTime", "time", ["getTime()", closedView(scalar("time"))]],
    ["toDateTime", "datetime", ["getDateTime()", closedView(scalar("datetime"))]],
    [
      "toAbsoluteDateTime",
      "absoluteDateTime",
      ["getAbsoluteDateTime()", closedView(scalar("absoluteDateTime"))],
    ],
  ];
  for (const [name, fact, fitting] of RESULTS) {
    withDefault(name, fitting, { fact }, "fact", "type");
    withDefault(name, DEFAULTS.list, { fact, errors: ["TSV043"] }, "fact", "type");
    withDefault(name, DEFAULTS.null, { fact, errors: ["TSV043"] }, "fact", "type");
    withDefault(name, DEFAULTS.host, { fact }, "fact", "type");
    withDefault(name, null, { fact }, "fact", "type");
  }
});

test("an optional conversion gives a known default that fits it as it is, and otherwise its result or null", () => {
  withDefault("toRegex", DEFAULTS.regex, { fact: "regex" }, "fact", "alternatives");
  withDefault("toRegex", DEFAULTS.null, { fact: "(null|regex)" }, "fact", "alternatives");
  withDefault("toRegex", DEFAULTS["regex?"], { fact: "(null|regex)" }, "fact", "alternatives");
  withDefault(
    "toRegex",
    DEFAULTS.integer,
    { fact: "(null|regex)", errors: ["TSV043"] },
    "fact",
    "type",
  );
  withDefault("toRegex", DEFAULTS.host, { fact: "(null|regex)" }, "fact", "type");
  // Without the default the text that is not a valid regex needs, the call is reported and still optional.
  withDefault("toRegex", null, { fact: "(null|regex)", errors: ["TSV020"] }, "fact", "type");
  assertCase(
    relation("conversion", "toRegex"),
    inputsOf({ arguments: [closedView(STRING_TYPE)] }),
    legacyOperation('let r = toRegex("a")\nexit'),
    { fact: "(null|regex)", errors: ["TSV020"] },
    "fact",
  );
  // Text the compiler sees is no valid pattern: the default is given, which is null here.
  assertCase(
    relation("conversion", "toRegex"),
    inputsOf({ arguments: [closedView(STRING_TYPE)], named: { default: closedView(NULL_TYPE) } }),
    legacyOperation('let r = toRegex("(", default: null)\nexit'),
    { fact: "(null|regex)" },
    "fact",
  );
  // A default the solver knows nothing of yet does not hold the result back: the result stands alone, the lower bound
  // of every answer a typed default gives (stage 3a); one that may also be dynamic is not known to fit.
  const toRegex = relation("conversion", "toRegex");
  assert.deepEqual(
    toRegex.result(
      inputsOf({ arguments: [closedView(STRING_TYPE)], named: { default: BOTTOM_VIEW } }),
    ),
    { kind: "type", type: REGEX_TYPE },
  );
  assert.deepEqual(
    toRegex.result(
      inputsOf({
        arguments: [closedView(STRING_TYPE)],
        named: { default: dynamicView("host", [REGEX_TYPE]) },
      }),
    ),
    { kind: "type", type: optional(REGEX_TYPE) },
  );
});

test("a default that may be any value is given beside the result, as a copy of the default", () => {
  withDefault("fromBase64", DEFAULTS.integer, { fact: "(integer|string)" }, "fact", "alternatives");
  withDefault("fromBase64", DEFAULTS.text, { fact: "string" }, "fact", "alternatives");
  withDefault("fromBase64", DEFAULTS.null, { fact: "(null|string)" }, "fact", "alternatives");
  withDefault(
    "fromBase64",
    DEFAULTS.list,
    { fact: "(list<integer>|string)" },
    "fact",
    "alternatives",
  );
  // A default the compiler cannot know: the copy keeps its provenance, which the legacy's union loses in unknown.
  withDefault(
    "fromBase64",
    DEFAULTS.host,
    { fact: "unknown" },
    { realized: "unknown" },
    "alternatives",
  );
  withDefault("fromBase64", null, { fact: "string", errors: ["TSV020"] }, "fact", "type");
  assertCase(
    relation("conversion", "fromBase64"),
    inputsOf({
      arguments: [closedView(STRING_TYPE)],
      named: { default: closedView(INTEGER_TYPE) },
    }),
    legacyOperation('let r = fromBase64("eA==", default: 1)\nexit'),
    { fact: "(integer|string)" },
    "fact",
  );
  assert.deepEqual(
    relation("conversion", "fromBase64").result(
      inputsOf({ arguments: [closedView(STRING_TYPE)], named: { default: BOTTOM_VIEW } }),
    ),
    {
      kind: "alternatives",
      results: [
        { kind: "type", type: STRING_TYPE },
        { kind: "projection", source: { of: { named: "default" }, path: [] } },
      ],
    },
    "the copy of a default the solver knows nothing of yet is a reference, not a type",
  );
});

test("what JSON holds is the contract's own dynamic data, with or without a default", () => {
  for (const written of [
    DEFAULTS.integer,
    DEFAULTS.text,
    DEFAULTS.null,
    DEFAULTS.host,
    DEFAULTS.list,
  ])
    withDefault("fromJson", written, { fact: "unknown" }, "unknown", "alternatives");
  // Without a default the call is reported, also for text the compiler sees is valid JSON; checking-only.
  withDefault(
    "fromJson",
    null,
    { fact: "unknown", errors: ["TSV020"] },
    { dynamic: "json" },
    "dynamic",
  );
  assertCase(
    relation("conversion", "fromJson"),
    inputsOf({ arguments: [closedView(STRING_TYPE)] }),
    legacyOperation('let r = fromJson("bad")\nexit'),
    { fact: "unknown", errors: ["TSV020"] },
    { dynamic: "json" },
  );
  assertCase(
    relation("conversion", "fromJson"),
    inputsOf({
      arguments: [closedView(STRING_TYPE)],
      named: { default: closedView(INTEGER_TYPE) },
    }),
    legacyOperation('let r = fromJson("{}", default: 1)\nexit'),
    { fact: "unknown" },
    "unknown",
  );
  assertCase(
    relation("conversion", "fromJson"),
    inputsOf({
      arguments: [dynamicView("host")],
      named: { default: closedView(INTEGER_TYPE), files: closedView(BOOLEAN_TYPE) },
    }),
    legacyOperation("let r = fromJson(hostText, default: 1, files: false)\nexit"),
    { fact: "unknown" },
    "unknown",
  );
  assert.deepEqual(
    relation("conversion", "fromJson").result(inputsOf({ arguments: [BOTTOM_VIEW] })),
    { kind: "dynamic", why: "json" },
  );
});

test("a call's shape problems are checking-only: the result stands", () => {
  const cases: readonly (readonly [
    ConversionName,
    string,
    readonly OperandView[],
    Record<string, OperandView>,
    string,
    string,
  ])[] = [
    // A conversion that takes no default reports one; its result does not take it.
    [
      "toJson",
      "toJson(hostText, default: 1)",
      [dynamicView("host")],
      { default: closedView(INTEGER_TYPE) },
      "string",
      "TSV022",
    ],
    [
      "toBase64",
      "toBase64(hostText, default: 1)",
      [dynamicView("host")],
      { default: closedView(INTEGER_TYPE) },
      "string",
      "TSV022",
    ],
    ["toInteger", "toInteger()", [], {}, "integer", "TSV020"],
    [
      "toInteger",
      "toInteger(1, 2)",
      [closedView(INTEGER_TYPE), closedView(INTEGER_TYPE)],
      {},
      "integer",
      "TSV020",
    ],
    [
      "toInteger",
      "toInteger(1, foo: 2)",
      [closedView(INTEGER_TYPE)],
      { foo: closedView(INTEGER_TYPE) },
      "integer",
      "TSV022",
    ],
    ["toInteger", 'toInteger("x")', [closedView(STRING_TYPE)], {}, "integer", "TSV043"],
    ["toDate", 'toDate("2026-02-30")', [closedView(STRING_TYPE)], {}, "date", "TSV043"],
    [
      "toDateTime",
      "toDateTime(1, getTime())",
      [closedView(INTEGER_TYPE), closedView(scalar("time"))],
      {},
      "datetime",
      "TSV043",
    ],
    ["fromJson", "fromJson()", [], {}, "unknown", "TSV020"],
  ];
  for (const [name, call, args, named, fact, error] of cases)
    assertCase(
      relation("conversion", name),
      inputsOf({ arguments: args, named }),
      legacyOperation(`let r = ${call}\nexit`),
      { fact, errors: [error] },
      fact === "unknown" ? { dynamic: "json" } : "fact",
    );
  // A default without the text is still given beside the result.
  assertCase(
    relation("conversion", "fromBase64"),
    inputsOf({ named: { default: closedView(INTEGER_TYPE) } }),
    legacyOperation("let r = fromBase64(default: 1)\nexit"),
    { fact: "(integer|string)", errors: ["TSV020"] },
    "fact",
    "alternatives",
  );
  // The pair form of a datetime of a date and a time, with and without its default.
  assertCase(
    relation("conversion", "toDateTime"),
    inputsOf({ arguments: [closedView(scalar("date")), closedView(scalar("time"))] }),
    legacyOperation("let r = toDateTime(getDate(), getTime())\nexit"),
    { fact: "datetime" },
    "fact",
  );
  assertCase(
    relation("conversion", "toDateTime"),
    inputsOf({
      arguments: [closedView(scalar("date")), closedView(scalar("time"))],
      named: { default: closedView(scalar("datetime")) },
    }),
    legacyOperation("let r = toDateTime(getDate(), getTime(), default: getDateTime())\nexit"),
    { fact: "datetime" },
    "fact",
  );
  assertCase(
    relation("conversion", "toJson"),
    inputsOf({ arguments: [dynamicView("host")], named: { files: closedView(BOOLEAN_TYPE) } }),
    legacyOperation("let r = toJson(hostValue, files: false)\nexit"),
    { fact: "string" },
    "fact",
  );
});

/** Per builtin, the call written with what it needs, its fact, and the operands it reports nothing for. */
const BUILTIN_CALLS: readonly {
  readonly name: string;
  readonly call: string;
  readonly fact: string;
  readonly takes: readonly string[];
  readonly named: Readonly<Record<string, OperandView>>;
}[] = [
  {
    name: "fileFromBase64",
    call: 'fileFromBase64(a, default: "f")',
    fact: "string",
    takes: TEXT_AMONG,
    named: { default: closedView(STRING_TYPE) },
  },
  { name: "fileToBase64", call: "fileToBase64(a)", fact: "string", takes: TEXT, named: {} },
  { name: "hashText", call: "hashText(a)", fact: "string", takes: TEXT, named: {} },
  { name: "hashFile", call: "hashFile(a)", fact: "string", takes: TEXT, named: {} },
  ...["encryptText", "encryptFile"].map((name) => ({
    name,
    call: `${name}(a, password: "p", publicKey: false, timeLock: false)`,
    fact: "string",
    takes: TEXT,
    named: {
      password: closedView(STRING_TYPE),
      publicKey: closedView(BOOLEAN_TYPE),
      timeLock: closedView(BOOLEAN_TYPE),
    },
  })),
  ...["decryptText", "decryptFile"].map((name) => ({
    name,
    call: `${name}(a, password: "p", default: "d")`,
    fact: "string",
    takes: TEXT,
    named: { password: closedView(STRING_TYPE), default: closedView(STRING_TYPE) },
  })),
  { name: "escapeMarkup", call: "escapeMarkup(a)", fact: "string", takes: TEXT, named: {} },
  { name: "script", call: "script(a)", fact: "script", takes: TEXT, named: {} },
];

test("a file, hash or lock call, escapeMarkup and script of an operand of any kind give their result", () => {
  for (const row of BUILTIN_CALLS)
    for (const { label, declaration, view } of OPERANDS)
      assertCase(
        relation("builtin", row.name),
        inputsOf({ arguments: [view], named: row.named }),
        legacyOperation(`${declaration}\nlet r = ${row.call}\nexit`),
        { fact: row.fact, errors: row.takes.includes(label) ? [] : ["TSV043"] },
        "fact",
      );
});

test("a stored file from Base64 text and a lock call give text or a copy of their default", () => {
  for (const name of ["fileFromBase64", "decryptText", "decryptFile"]) {
    const password = name === "fileFromBase64" ? "" : ', password: "p"';
    const passwordView: Record<string, OperandView> =
      name === "fileFromBase64" ? {} : { password: closedView(STRING_TYPE) };
    const call = (written: string | null) =>
      `let r = ${name}(hostText${password}${written === null ? "" : `, default: ${written}`})\nexit`;
    for (const [written, view, fact] of [
      ['"f"', closedView(STRING_TYPE), "string"],
      ["1", closedView(INTEGER_TYPE), "(integer|string)"],
      ["null", closedView(NULL_TYPE), "(null|string)"],
      ["[1]", closedView({ kind: "list", element: INTEGER_TYPE }), "(list<integer>|string)"],
    ] as const)
      assertCase(
        relation("builtin", name),
        inputsOf({ arguments: [dynamicView("host")], named: { ...passwordView, default: view } }),
        legacyOperation(call(written)),
        { fact },
        "fact",
        "alternatives",
      );
    assertCase(
      relation("builtin", name),
      inputsOf({
        arguments: [dynamicView("host")],
        named: { ...passwordView, default: dynamicView("host") },
      }),
      legacyOperation(call("hostValue")),
      { fact: "unknown" },
      { realized: "unknown" },
      "alternatives",
    );
    assertCase(
      relation("builtin", name),
      inputsOf({ arguments: [dynamicView("host")], named: passwordView }),
      legacyOperation(call(null)),
      { fact: "string", errors: ["TSV020"] },
      "fact",
      "type",
    );
    assertCase(
      relation("builtin", name),
      inputsOf({ named: passwordView }),
      legacyOperation(`let r = ${name}()\nexit`),
      { fact: "string", errors: ["TSV020"] },
      "fact",
      "type",
    );
    assertCase(
      relation("builtin", name),
      inputsOf({
        arguments: [dynamicView("host"), dynamicView("host")],
        named: { ...passwordView, default: closedView(INTEGER_TYPE) },
      }),
      legacyOperation(`let r = ${name}(hostText, hostText${password}, default: 1)\nexit`),
      { fact: "(integer|string)", errors: ["TSV020"] },
      "fact",
      "alternatives",
    );
  }
  // An encrypt call takes no default; the one written is reported and still given beside the text.
  for (const name of ["encryptText", "encryptFile"]) {
    const openers = {
      password: closedView(STRING_TYPE),
      publicKey: closedView(BOOLEAN_TYPE),
      timeLock: closedView(BOOLEAN_TYPE),
    };
    assertCase(
      relation("builtin", name),
      inputsOf({
        arguments: [dynamicView("host")],
        named: { ...openers, default: closedView(INTEGER_TYPE) },
      }),
      legacyOperation(
        `let r = ${name}(hostText, password: "p", publicKey: false, timeLock: false, default: 1)\nexit`,
      ),
      { fact: "(integer|string)", errors: ["TSV022"] },
      "fact",
      "alternatives",
    );
    assertCase(
      relation("builtin", name),
      inputsOf({
        arguments: [dynamicView("host")],
        named: { ...openers, password: closedView(BOOLEAN_TYPE) },
      }),
      legacyOperation(
        `let r = ${name}(hostText, password: true, publicKey: false, timeLock: false)\nexit`,
      ),
      { fact: "string" },
      "fact",
      "type",
    );
    assertCase(
      relation("builtin", name),
      inputsOf({}),
      legacyOperation(`let r = ${name}()\nexit`),
      { fact: "string", errors: ["TSV020"] },
      "fact",
      "type",
    );
  }
});

test("a call that takes no default gives its result, whatever its shape problems", () => {
  for (const name of ["fileToBase64", "hashText", "hashFile", "escapeMarkup"]) {
    for (const [call, args, named, error] of [
      [`${name}()`, [], {}, "TSV020"],
      [`${name}(hostText, hostText)`, [dynamicView("host"), dynamicView("host")], {}, "TSV020"],
      [
        `${name}(hostText, default: 1)`,
        [dynamicView("host")],
        { default: closedView(INTEGER_TYPE) },
        "TSV022",
      ],
    ] as const)
      assertCase(
        relation("builtin", name),
        inputsOf({ arguments: args, named }),
        legacyOperation(`let r = ${call}\nexit`),
        { fact: "string", errors: [error] },
        "fact",
        "type",
      );
  }
  for (const [call, args, named, errors] of [
    [
      'script(hostText, label: "start")',
      [dynamicView("host")],
      { label: closedView(STRING_TYPE) },
      [],
    ],
    [
      "script(hostText, label: 1)",
      [dynamicView("host")],
      { label: closedView(INTEGER_TYPE) },
      ["TSV043"],
    ],
    [
      "script(hostText, foo: 1)",
      [dynamicView("host")],
      { foo: closedView(INTEGER_TYPE) },
      ["TSV022"],
    ],
    ["script(hostText, hostText)", [dynamicView("host"), dynamicView("host")], {}, ["TSV020"]],
    ["script()", [], {}, ["TSV020"]],
  ] as const)
    assertCase(
      relation("builtin", "script"),
      inputsOf({ arguments: args, named }),
      legacyOperation(`let r = ${call}\nexit`),
      { fact: "script", errors },
      "fact",
      "type",
    );
});

test("a relation answers from its inputs alone: a bottom operand it does not need changes nothing", () => {
  const toInteger = relation("conversion", "toInteger");
  for (const view of [BOTTOM_VIEW, closedView(STRING_TYPE), BOTTOM_VIEW])
    assert.deepEqual(toInteger.result(inputsOf({ arguments: [view] })), {
      kind: "type",
      type: INTEGER_TYPE,
    });
  const toRegex = relation("conversion", "toRegex");
  const grown = (view: OperandView) =>
    toRegex.result(inputsOf({ arguments: [closedView(STRING_TYPE)], named: { default: view } }))
      .kind;
  assert.deepEqual(
    [
      grown(BOTTOM_VIEW),
      grown(closedView(REGEX_TYPE)),
      grown(BOTTOM_VIEW),
      grown(closedView(INTEGER_TYPE)),
    ],
    ["type", "alternatives", "type", "type"],
  );
  assert.deepEqual(relation("builtin", "hashText").result(inputsOf({ arguments: [BOTTOM_VIEW] })), {
    kind: "type",
    type: STRING_TYPE,
  });
});
