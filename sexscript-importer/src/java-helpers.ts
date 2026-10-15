/**
 * Generated TeaseScript functions for the Java and data API rules (java-data.ts, java-time.ts, java-text.ts),
 * registered with the other generated helpers in helpers.ts. Each is ordinary TeaseScript, the same in every file
 * that needs it. Where Java produced NaN or Infinity, which are no TeaseScript numbers, a lookup in an empty dict stops
 * the script with a message that names the case.
 */
import type { IrExpression, IrStatement } from "./ir.ts";

export type JavaHelperName =
  | "calendarTime"
  | "formEncode"
  | "javaTrim"
  | "isInteger"
  | "isNumber"
  | "countText"
  | "indexFrom"
  | "character"
  | "insert"
  | "fileName"
  | "clockText"
  | "reversed";

/** The Java helpers in their stable order after the other generated helpers. */
export const JAVA_HELPER_ORDER: readonly JavaHelperName[] = [
  "calendarTime",
  "formEncode",
  "javaTrim",
  "isInteger",
  "isNumber",
  "countText",
  "indexFrom",
  "character",
  "insert",
  "fileName",
  "clockText",
  "reversed",
];

const DEPENDENCIES = new Map<string, JavaHelperName[]>([
  ["isInteger", ["javaTrim"]],
  ["isNumber", ["javaTrim"]],
]);

/** The Java helpers that a generated helper calls. */
export function javaHelperDependencies(name: string): readonly JavaHelperName[] {
  return DEPENDENCIES.get(name) ?? [];
}

const v = (name: string): IrExpression => ({ kind: "variable", name });
const lit = (value: string | number | boolean | null): IrExpression => ({ kind: "literal", value });
const bin = (operator: string, left: IrExpression, right: IrExpression): IrExpression => ({
  kind: "binary",
  operator,
  left,
  right,
});
const not = (value: IrExpression): IrExpression => ({ kind: "unary", operator: "not", value });
const regex = (pattern: string): IrExpression => ({ kind: "regex", pattern, flags: "" });
const call = (name: string, ...positional: IrExpression[]): IrExpression => ({
  kind: "call",
  name,
  positional,
  named: {},
});
const local = (name: string, ...positional: IrExpression[]): IrExpression => ({
  kind: "call",
  name,
  positional,
  named: {},
  local: true,
});
const method = (target: IrExpression, name: string, ...args: IrExpression[]): IrExpression => ({
  kind: "methodCall",
  target,
  name,
  arguments: args,
});
const at = (target: IrExpression, index: IrExpression): IrExpression => ({
  kind: "index",
  target,
  index,
});
const length = (target: IrExpression): IrExpression => ({
  kind: "property",
  target,
  name: "length",
});
const letS = (name: string, value: IrExpression, type?: string): IrStatement => ({
  kind: "let",
  name,
  value,
  span: null,
  ...(type === undefined ? {} : { type }),
});
const set = (
  name: string,
  value: IrExpression,
  operator: "=" | "+=" | "-=" = "=",
): IrStatement => ({ kind: "assign", target: v(name), operator, value, span: null });
const ret = (value: IrExpression): IrStatement => ({ kind: "return", value, span: null });
const ifS = (
  condition: IrExpression,
  then: IrStatement[],
  otherwise: IrStatement[] = [],
): IrStatement => ({ kind: "if", condition, then, else: otherwise, span: null });
const whileS = (condition: IrExpression, body: IrStatement[]): IrStatement => ({
  kind: "while",
  condition,
  body,
  span: null,
});
const forS = (variable: string, collection: IrExpression, body: IrStatement[]): IrStatement => ({
  kind: "for",
  variable,
  collection,
  body,
  span: null,
});
const fn = (name: string, parameters: string[], body: IrStatement[]): IrStatement => ({
  kind: "function",
  name,
  parameters: parameters.map((parameter) => ({ name: parameter, defaultValue: null })),
  body,
  span: null,
});
const template = (...parts: Array<string | IrExpression>): IrExpression => ({
  kind: "template",
  parts: parts.map((part) => (typeof part === "string" ? { text: part } : { value: part })),
});
/** A whole number written with at least `width` digits. */
const padded = (value: IrExpression, width: number): IrExpression =>
  method(call("toString", value), "padStart", lit(width), lit("0"));
/** Stops the script where Java had no result of the helper's type, such as NaN, naming the case. */
const fail = (reason: string, type = "number"): IrStatement[] => [
  letS("noResult", { kind: "object", properties: [], dict: true }, `${type} dict`),
  ret({ kind: "index", target: v("noResult"), index: lit(reason), dict: true }),
];
/** The printable ASCII characters, from code 32 (a space) to 126 (`~`). */
const PRINTABLE = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join(
  "",
);

/** Java URLEncoder keeps these characters; it writes a space as `+` and every other character as `%XX` bytes. */
const FORM_KEPT = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-*_";

/** `%XX` of the UTF-8 bytes of the tab, line breaks, other ASCII, and Latin-1 characters that Java encoded. */
function formCodes(): IrExpression {
  const codes: Array<[string, string]> = [];
  const characters = [0x09, 0x0a, 0x0d];
  for (let code = 0x20; code < 0x7f; code += 1) characters.push(code);
  for (let code = 0xa0; code <= 0xff; code += 1) characters.push(code);
  for (const code of characters) {
    const character = String.fromCodePoint(code);
    if (FORM_KEPT.includes(character)) continue;
    const bytes = [...new TextEncoder().encode(character)];
    codes.push([
      character,
      character === " "
        ? "+"
        : bytes.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
    ]);
  }
  return {
    kind: "object",
    dict: true,
    properties: codes.map(([character, code]) => ({
      name: character,
      key: lit(character),
      value: lit(code),
    })),
  };
}

export const JAVA_HELPERS: Record<JavaHelperName, { name: string; build: () => IrStatement }> = {
  // Java Calendar.set() of the time of day: a value outside its range carries into the next field and the date, as
  // Java's lenient calendar computes the wall-clock time before it applies the time zone.
  calendarTime: {
    name: "sexscriptLegacyCalendarTime",
    build: () =>
      fn(
        "sexscriptLegacyCalendarTime",
        ["value", "hour", "minute", "second", "millisecond"],
        [
          letS(
            "rest",
            bin(
              "+",
              bin(
                "*",
                bin(
                  "+",
                  bin("*", bin("+", bin("*", v("hour"), lit(60)), v("minute")), lit(60)),
                  v("second"),
                ),
                lit(1000),
              ),
              v("millisecond"),
            ),
          ),
          letS("days", call("floor", bin("/", v("rest"), lit(86400000)))),
          set("rest", bin("-", v("rest"), bin("*", v("days"), lit(86400000)))),
          letS("hours", call("floor", bin("/", v("rest"), lit(3600000)))),
          set("rest", bin("-", v("rest"), bin("*", v("hours"), lit(3600000)))),
          letS("minutes", call("floor", bin("/", v("rest"), lit(60000)))),
          set("rest", bin("-", v("rest"), bin("*", v("minutes"), lit(60000)))),
          letS("seconds", call("floor", bin("/", v("rest"), lit(1000)))),
          set("rest", bin("-", v("rest"), bin("*", v("seconds"), lit(1000)))),
          letS(
            "time",
            call(
              "toTime",
              template(
                padded(v("hours"), 2),
                ":",
                padded(v("minutes"), 2),
                ":",
                padded(v("seconds"), 2),
                ".",
                padded(v("rest"), 3),
              ),
            ),
          ),
          ret(
            call(
              "toDateTime",
              bin(
                "+",
                call("toDate", v("value")),
                // A date moves by calendar days only (time model 2).
                bin("*", v("days"), { kind: "duration", value: 1, unit: "day", calendar: true }),
              ),
              v("time"),
            ),
          ),
        ],
      ),
  },
  // Java URLEncoder.encode(text, "UTF-8"); a character outside ASCII and Latin-1 stops the script at the lookup.
  formEncode: {
    name: "sexscriptLegacyFormEncode",
    build: () =>
      fn(
        "sexscriptLegacyFormEncode",
        ["text"],
        [
          letS("kept", lit(FORM_KEPT)),
          letS("codes", formCodes()),
          letS("encoded", lit("")),
          forS("character", method(v("text"), "split", lit("")), [
            ifS(
              method(v("kept"), "contains", v("character")),
              [set("encoded", template(v("encoded"), v("character")))],
              [
                set(
                  "encoded",
                  template(v("encoded"), {
                    kind: "index",
                    target: v("codes"),
                    index: v("character"),
                    dict: true,
                  }),
                ),
              ],
            ),
          ]),
          ret(v("encoded")),
        ],
      ),
  },
  // Java trim(): the text without the characters up to U+0020 at both ends.
  javaTrim: {
    name: "sexscriptLegacyJavaTrim",
    build: () =>
      fn(
        "sexscriptLegacyJavaTrim",
        ["text"],
        [
          ret(
            method(v("text"), "replace", regex(String.raw`^[\x00-\x20]+|[\x00-\x20]+$`), lit("")),
          ),
        ],
      ),
  },
  // Groovy isInteger(): Integer.valueOf() of the trimmed text, a sign and digits within the int range, which the
  // digits after leading zeros, compared as text with the largest int of their sign, tell.
  isInteger: {
    name: "sexscriptLegacyIsInteger",
    build: () =>
      fn(
        "sexscriptLegacyIsInteger",
        ["text"],
        [
          letS("digits", local("sexscriptLegacyJavaTrim", v("text"))),
          ifS(not(method(v("digits"), "matches", regex("[+-]?[0-9]+"))), [ret(lit(false))]),
          letS("limit", lit("2147483647")),
          ifS(method(v("digits"), "startsWith", lit("-")), [set("limit", lit("2147483648"))]),
          set("digits", method(v("digits"), "replace", regex("^[+-]?0*([0-9])"), lit("$1"))),
          ifS(bin("!=", length(v("digits")), length(v("limit"))), [
            ret(bin("<", length(v("digits")), length(v("limit")))),
          ]),
          ret(bin("<=", v("digits"), v("limit"))),
        ],
      ),
  },
  // Groovy isNumber(): new BigDecimal() of the trimmed text, a sign, digits with one optional point, and an exponent.
  isNumber: {
    name: "sexscriptLegacyIsNumber",
    build: () =>
      fn(
        "sexscriptLegacyIsNumber",
        ["text"],
        [
          ret(
            method(
              local("sexscriptLegacyJavaTrim", v("text")),
              "matches",
              regex(String.raw`[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?`),
            ),
          ),
        ],
      ),
  },
  // Groovy count(): every occurrence of a text, overlapping ones too; an empty text occurs before each character and
  // at the end.
  countText: {
    name: "sexscriptLegacyCountText",
    build: () =>
      fn(
        "sexscriptLegacyCountText",
        ["text", "part"],
        [
          ifS(bin("==", v("part"), lit("")), [ret(bin("+", length(v("text")), lit(1)))]),
          letS("count", lit(0)),
          letS("rest", v("text")),
          letS("found", method(v("rest"), "indexOf", v("part"))),
          whileS(bin(">=", v("found"), lit(0)), [
            set("count", lit(1), "+="),
            set("rest", method(v("rest"), "substring", bin("+", v("found"), lit(1)))),
            set("found", method(v("rest"), "indexOf", v("part"))),
          ]),
          ret(v("count")),
        ],
      ),
  },
  // Java indexOf(part, start): a start before the text searches it all; one after it finds only an empty part.
  indexFrom: {
    name: "sexscriptLegacyIndexFrom",
    build: () =>
      fn(
        "sexscriptLegacyIndexFrom",
        ["text", "part", "start"],
        [
          letS("from", call("clamp", v("start"), lit(0), length(v("text")))),
          letS("found", method(method(v("text"), "substring", v("from")), "indexOf", v("part"))),
          ifS(bin("<", v("found"), lit(0)), [ret(lit(-1))]),
          ret(bin("+", v("found"), v("from"))),
        ],
      ),
  },
  // Java's (char) code of a printable ASCII character.
  character: {
    name: "sexscriptLegacyCharacter",
    build: () =>
      fn(
        "sexscriptLegacyCharacter",
        ["code"],
        [
          ifS(
            bin("or", bin("<", v("code"), lit(32)), bin(">", v("code"), lit(126))),
            fail("a character code outside printable ASCII", "string"),
          ),
          ret(
            method(
              lit(PRINTABLE),
              "substring",
              bin("-", v("code"), lit(32)),
              bin("-", v("code"), lit(31)),
            ),
          ),
        ],
      ),
  },
  // Java List.add(index, value): a new list of the elements before the position, the value, and the rest; a position
  // outside 0 to the length failed in Java, and a position with a fraction found no add() in Groovy; take() rejects it.
  insert: {
    name: "sexscriptLegacyInsert",
    build: () =>
      fn(
        "sexscriptLegacyInsert",
        ["items", "index", "value"],
        [
          ifS(bin("or", bin("<", v("index"), lit(0)), bin(">", v("index"), length(v("items")))), [
            letS("noList", { kind: "object", properties: [], dict: true }, "list dict"),
            ret({
              kind: "index",
              target: v("noList"),
              index: lit("a list position outside the list"),
              dict: true,
            }),
          ]),
          ret(
            bin(
              "+",
              bin("+", method(v("items"), "take", v("index")), {
                kind: "list",
                items: [v("value")],
              }),
              method(v("items"), "takeLast", bin("-", length(v("items")), v("index"))),
            ),
          ),
        ],
      ),
  },
  // java.io.File getName() as on Windows: the part after the last / or \\, without separators at the end.
  fileName: {
    name: "sexscriptLegacyFileName",
    build: () =>
      fn(
        "sexscriptLegacyFileName",
        ["path"],
        [
          // Separators at the end go, but a lone one stays.
          letS(
            "name",
            method(
              method(v("path"), "replace", lit("\\"), lit("/")),
              "replace",
              regex("(.)\\/+$"),
              lit("$1"),
            ),
          ),
          ret(
            method(
              v("name"),
              "substring",
              bin("+", method(v("name"), "lastIndexOf", lit("/")), lit(1)),
            ),
          ),
        ],
      ),
  },
  // A number of seconds as the time of day HH:mm:ss, wrapped at midnight as a lenient calendar wrapped it.
  clockText: {
    name: "sexscriptLegacyClockText",
    build: () =>
      fn(
        "sexscriptLegacyClockText",
        ["seconds"],
        [
          letS("rest", call("mod", v("seconds"), lit(86400))),
          ret(
            template(
              padded(call("floor", bin("/", v("rest"), lit(3600))), 2),
              ":",
              padded(call("floor", bin("/", call("mod", v("rest"), lit(3600)), lit(60))), 2),
              ":",
              padded(call("mod", v("rest"), lit(60)), 2),
            ),
          ),
        ],
      ),
  },
  // Groovy reverse() of a list: a new list of its elements in reverse order, where the statement cannot take a reversed
  // copy first (java-text.ts reverse).
  reversed: {
    name: "sexscriptLegacyReversed",
    build: () =>
      fn(
        "sexscriptLegacyReversed",
        ["items"],
        [
          // Assignment copies a list (ADR 0014), which reverse() then reverses in place (#860).
          letS("result", v("items")),
          { kind: "expression", expression: method(v("result"), "reverse"), span: null },
          ret(v("result")),
        ],
      ),
  },
};
