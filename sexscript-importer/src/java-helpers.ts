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
  | "log"
  | "exp"
  | "cos"
  | "sin"
  | "gaussian"
  | "javaTrim"
  | "isInteger"
  | "isNumber"
  | "countText"
  | "indexFrom"
  | "character"
  | "insert"
  | "aroundText"
  | "fileName"
  | "clockText"
  | "reversed"
  | "reversedText";

/** The Java helpers in their stable order after the other generated helpers. */
export const JAVA_HELPER_ORDER: readonly JavaHelperName[] = [
  "calendarTime",
  "formEncode",
  "log",
  "exp",
  "cos",
  "sin",
  "gaussian",
  "javaTrim",
  "isInteger",
  "isNumber",
  "countText",
  "indexFrom",
  "character",
  "insert",
  "aroundText",
  "fileName",
  "clockText",
  "reversed",
  "reversedText",
];

const DEPENDENCIES = new Map<string, JavaHelperName[]>([
  ["gaussian", ["log"]],
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
const neg = (value: IrExpression): IrExpression => ({ kind: "unary", operator: "-", value });
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
const between = (value: IrExpression, low: string, high: string): IrExpression =>
  bin("and", bin(">=", value, lit(low)), bin("<=", value, lit(high)));

const LN2 = 0.6931471805599453;
/**
 * 2 pi in three parts whose sum is exact to about 1e-32: the first has few enough bits that a whole multiple of it is
 * exact, so an angle reduces without losing its fraction.
 */
const TWO_PI_HIGH = Math.floor(2 * Math.PI * 2 ** 24) / 2 ** 24;
const TWO_PI_MIDDLE = 2 * Math.PI - TWO_PI_HIGH;
const TWO_PI_LOW = 2.4492935982947064e-16;
const POWER_32 = 4294967296;

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

/** A Taylor series of cos (start 1, first divisor 1) or sin (start the angle, first divisor 2) on [-pi, pi]. */
function trigonometry(name: string, sine: boolean): IrStatement {
  return fn(
    name,
    ["value"],
    [
      letS("turns", call("round", bin("/", v("value"), lit(2 * Math.PI)))),
      letS(
        "angle",
        bin(
          "-",
          bin(
            "-",
            bin("-", v("value"), bin("*", v("turns"), lit(TWO_PI_HIGH))),
            bin("*", v("turns"), lit(TWO_PI_MIDDLE)),
          ),
          bin("*", v("turns"), lit(TWO_PI_LOW)),
        ),
        "number",
      ),
      // Beyond 2^26 turns a multiple of the first part is no longer exact; the remainder keeps the angle in range.
      ifS(bin("or", bin(">", v("turns"), lit(2 ** 26)), bin("<", v("turns"), lit(-(2 ** 26)))), [
        set("angle", bin("%", v("value"), lit(2 * Math.PI))),
        ifS(bin(">", v("angle"), lit(Math.PI)), [set("angle", lit(2 * Math.PI), "-=")]),
        ifS(bin("<", v("angle"), lit(-Math.PI)), [set("angle", lit(2 * Math.PI), "+=")]),
      ]),
      letS("square", bin("*", v("angle"), v("angle")), "number"),
      letS("term", sine ? v("angle") : lit(1.0), "number"),
      letS("total", v("term"), "number"),
      letS("divisor", lit(sine ? 2 : 1)),
      whileS(bin("<", v("divisor"), lit(40)), [
        set(
          "term",
          bin(
            "/",
            bin("*", neg(v("term")), v("square")),
            bin("*", v("divisor"), bin("+", v("divisor"), lit(1))),
          ),
        ),
        set("total", v("term"), "+="),
        set("divisor", lit(2), "+="),
      ]),
      ret(v("total")),
    ],
  );
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
  // Java Math.log(), the natural logarithm: value = mantissa * 2^exponent, then 2 atanh((m - 1) / (m + 1)).
  log: {
    name: "sexscriptLegacyLog",
    build: () =>
      fn(
        "sexscriptLegacyLog",
        ["value"],
        [
          ifS(bin("<=", v("value"), lit(0)), fail("Math.log() of zero or a negative number")),
          letS("exponent", lit(0)),
          letS("mantissa", v("value"), "number"),
          whileS(bin(">", v("mantissa"), lit(POWER_32)), [
            set("mantissa", bin("/", v("mantissa"), lit(POWER_32))),
            set("exponent", lit(32), "+="),
          ]),
          whileS(bin("<", v("mantissa"), lit(1 / POWER_32)), [
            set("mantissa", bin("*", v("mantissa"), lit(POWER_32))),
            set("exponent", lit(32), "-="),
          ]),
          whileS(bin(">", v("mantissa"), lit(Math.SQRT2)), [
            set("mantissa", bin("/", v("mantissa"), lit(2))),
            set("exponent", lit(1), "+="),
          ]),
          whileS(bin("<", v("mantissa"), lit(Math.SQRT1_2)), [
            set("mantissa", bin("*", v("mantissa"), lit(2))),
            set("exponent", lit(1), "-="),
          ]),
          letS("ratio", bin("/", bin("-", v("mantissa"), lit(1)), bin("+", v("mantissa"), lit(1)))),
          letS("square", bin("*", v("ratio"), v("ratio")), "number"),
          letS("term", v("ratio"), "number"),
          letS("total", lit(0.0), "number"),
          letS("divisor", lit(1)),
          whileS(bin("<", v("divisor"), lit(40)), [
            set("total", bin("/", v("term"), v("divisor")), "+="),
            set("term", bin("*", v("term"), v("square"))),
            set("divisor", lit(2), "+="),
          ]),
          ret(bin("+", bin("*", v("exponent"), lit(LN2)), bin("*", lit(2), v("total")))),
        ],
      ),
  },
  // Java Math.exp(): value = halves * ln 2 + rest, a Taylor series of the rest, then doubled or halved.
  exp: {
    name: "sexscriptLegacyExp",
    build: () =>
      fn(
        "sexscriptLegacyExp",
        ["value"],
        [
          letS("halves", call("round", bin("/", v("value"), lit(LN2)))),
          letS("rest", bin("-", v("value"), bin("*", v("halves"), lit(LN2)))),
          letS("term", lit(1.0), "number"),
          letS("total", lit(1.0), "number"),
          letS("count", lit(1)),
          whileS(bin("<", v("count"), lit(25)), [
            set("term", bin("/", bin("*", v("term"), v("rest")), v("count"))),
            set("total", v("term"), "+="),
            set("count", lit(1), "+="),
          ]),
          whileS(bin(">", v("halves"), lit(0)), [
            set("total", bin("*", v("total"), lit(2))),
            set("halves", lit(1), "-="),
          ]),
          whileS(bin("<", v("halves"), lit(0)), [
            set("total", bin("/", v("total"), lit(2))),
            set("halves", lit(1), "+="),
          ]),
          ret(v("total")),
        ],
      ),
  },
  // Java Math.cos() and Math.sin() of an angle in radians.
  cos: { name: "sexscriptLegacyCos", build: () => trigonometry("sexscriptLegacyCos", false) },
  sin: { name: "sexscriptLegacySin", build: () => trigonometry("sexscriptLegacySin", true) },
  // Java Random.nextGaussian(): the polar method on two uniform draws.
  gaussian: {
    name: "sexscriptLegacyGaussian",
    build: () =>
      fn(
        "sexscriptLegacyGaussian",
        [],
        [
          letS("first", lit(0.0), "number"),
          letS("second", lit(0.0), "number"),
          letS("square", lit(0.0), "number"),
          whileS(bin("or", bin(">=", v("square"), lit(1)), bin("==", v("square"), lit(0))), [
            set("first", bin("-", bin("*", lit(2), call("random")), lit(1))),
            set("second", bin("-", bin("*", lit(2), call("random")), lit(1))),
            set(
              "square",
              bin("+", bin("*", v("first"), v("first")), bin("*", v("second"), v("second"))),
            ),
          ]),
          ret(
            bin(
              "*",
              v("first"),
              call(
                "sqrt",
                bin("/", bin("*", lit(-2), local("sexscriptLegacyLog", v("square"))), v("square")),
              ),
            ),
          ),
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
          letS("characters", method(v("text"), "split", lit(""))),
          letS("start", lit(0)),
          whileS(
            bin(
              "and",
              bin("<", v("start"), length(v("characters"))),
              bin("<=", at(v("characters"), v("start")), lit(" ")),
            ),
            [set("start", lit(1), "+=")],
          ),
          letS("end", length(v("characters"))),
          whileS(
            bin(
              "and",
              bin(">", v("end"), v("start")),
              bin("<=", at(v("characters"), bin("-", v("end"), lit(1))), lit(" ")),
            ),
            [set("end", lit(1), "-=")],
          ),
          ret(method(v("text"), "substring", v("start"), v("end"))),
        ],
      ),
  },
  // Groovy isInteger(): Integer.valueOf() of the trimmed text, a sign and digits within the int range.
  isInteger: {
    name: "sexscriptLegacyIsInteger",
    build: () =>
      fn(
        "sexscriptLegacyIsInteger",
        ["text"],
        [
          letS("digits", local("sexscriptLegacyJavaTrim", v("text"))),
          letS("limit", lit("2147483647")),
          ifS(
            method(v("digits"), "startsWith", lit("-")),
            [
              set("limit", lit("2147483648")),
              set("digits", method(v("digits"), "substring", lit(1))),
            ],
            [
              ifS(method(v("digits"), "startsWith", lit("+")), [
                set("digits", method(v("digits"), "substring", lit(1))),
              ]),
            ],
          ),
          ifS(bin("==", v("digits"), lit("")), [ret(lit(false))]),
          forS("character", method(v("digits"), "split", lit("")), [
            ifS(not(between(v("character"), "0", "9")), [ret(lit(false))]),
          ]),
          whileS(
            bin(
              "and",
              bin(">", length(v("digits")), lit(1)),
              method(v("digits"), "startsWith", lit("0")),
            ),
            [set("digits", method(v("digits"), "substring", lit(1)))],
          ),
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
    build: () => {
      const character = at(v("characters"), v("index"));
      const more = bin("<", v("index"), length(v("characters")));
      const sign = bin("or", bin("==", character, lit("+")), bin("==", character, lit("-")));
      return fn(
        "sexscriptLegacyIsNumber",
        ["text"],
        [
          letS("characters", method(local("sexscriptLegacyJavaTrim", v("text")), "split", lit(""))),
          letS("index", lit(0)),
          ifS(bin("and", more, sign), [set("index", lit(1), "+=")]),
          letS("digits", lit(0)),
          letS("point", lit(false)),
          whileS(more, [
            ifS(
              between(character, "0", "9"),
              [set("digits", lit(1), "+=")],
              [
                ifS(
                  bin("and", bin("==", character, lit(".")), not(v("point"))),
                  [set("point", lit(true))],
                  [{ kind: "break", span: null }],
                ),
              ],
            ),
            set("index", lit(1), "+="),
          ]),
          ifS(bin("==", v("digits"), lit(0)), [ret(lit(false))]),
          ifS(
            bin(
              "and",
              more,
              bin("or", bin("==", character, lit("e")), bin("==", character, lit("E"))),
            ),
            [
              set("index", lit(1), "+="),
              ifS(bin("and", more, sign), [set("index", lit(1), "+=")]),
              letS("exponent", lit(0)),
              whileS(bin("and", more, between(character, "0", "9")), [
                set("exponent", lit(1), "+="),
                set("index", lit(1), "+="),
              ]),
              ifS(bin("==", v("exponent"), lit(0)), [ret(lit(false))]),
            ],
          ),
          ret(bin("==", v("index"), length(v("characters")))),
        ],
      );
    },
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
          letS("from", v("start")),
          ifS(bin("<", v("from"), lit(0)), [set("from", lit(0))]),
          ifS(bin(">", v("from"), length(v("text"))), [
            ifS(bin("==", v("part"), lit("")), [ret(length(v("text")))]),
            ret(lit(-1)),
          ]),
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
  // outside 0 to the length failed in Java.
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
          letS("result", { kind: "list", items: [] }),
          letS("position", lit(0)),
          forS("item", v("items"), [
            ifS(bin("==", v("position"), v("index")), [
              {
                kind: "expression",
                expression: method(v("result"), "add", v("value")),
                span: null,
              },
            ]),
            { kind: "expression", expression: method(v("result"), "add", v("item")), span: null },
            set("position", lit(1), "+="),
          ]),
          ifS(bin("==", v("index"), length(v("items"))), [
            { kind: "expression", expression: method(v("result"), "add", v("value")), span: null },
          ]),
          ret(v("result")),
        ],
      ),
  },
  // Java matches() of `.{a,b}text.{c,d}` (a maximum below 0 has no limit): the text has no line break, which `.` does
  // not match, and an occurrence of the part splits it into counts in both ranges.
  aroundText: {
    name: "sexscriptLegacyAroundText",
    build: () => {
      const within = (count: IrExpression, low: string, high: string): IrExpression =>
        bin(
          "and",
          bin(">=", count, v(low)),
          bin("or", bin("<", v(high), lit(0)), bin("<=", count, v(high))),
        );
      return fn(
        "sexscriptLegacyAroundText",
        ["text", "part", "minBefore", "maxBefore", "minAfter", "maxAfter"],
        [
          forS(
            "lineBreak",
            {
              kind: "list",
              items: ["\n", "\r", "\u0085", "\u2028", "\u2029"].map((lineBreak) => lit(lineBreak)),
            },
            [ifS(method(v("text"), "contains", v("lineBreak")), [ret(lit(false))])],
          ),
          letS("before", lit(0)),
          letS("rest", v("text")),
          letS("found", method(v("rest"), "indexOf", v("part"))),
          whileS(bin(">=", v("found"), lit(0)), [
            set("before", v("found"), "+="),
            letS("after", bin("-", bin("-", length(v("text")), v("before")), length(v("part")))),
            ifS(
              bin(
                "and",
                within(v("before"), "minBefore", "maxBefore"),
                within(v("after"), "minAfter", "maxAfter"),
              ),
              [ret(lit(true))],
            ),
            set("rest", method(v("rest"), "substring", bin("+", v("found"), lit(1)))),
            set("before", lit(1), "+="),
            set("found", method(v("rest"), "indexOf", v("part"))),
          ]),
          ret(lit(false)),
        ],
      );
    },
  },
  // java.io.File getName() as on Windows: the part after the last / or \\, without separators at the end.
  fileName: {
    name: "sexscriptLegacyFileName",
    build: () =>
      fn(
        "sexscriptLegacyFileName",
        ["path"],
        [
          letS("name", method(v("path"), "replace", lit("\\"), lit("/"))),
          whileS(
            bin(
              "and",
              bin(">", length(v("name")), lit(1)),
              method(v("name"), "endsWith", lit("/")),
            ),
            [
              set(
                "name",
                method(v("name"), "substring", lit(0), bin("-", length(v("name")), lit(1))),
              ),
            ],
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
          letS(
            "rest",
            bin(
              "-",
              v("seconds"),
              bin("*", call("floor", bin("/", v("seconds"), lit(86400))), lit(86400)),
            ),
          ),
          letS("hours", call("floor", bin("/", v("rest"), lit(3600)))),
          set("rest", bin("-", v("rest"), bin("*", v("hours"), lit(3600)))),
          letS("minutes", call("floor", bin("/", v("rest"), lit(60)))),
          set("rest", bin("-", v("rest"), bin("*", v("minutes"), lit(60)))),
          ret(
            template(
              padded(v("hours"), 2),
              ":",
              padded(v("minutes"), 2),
              ":",
              padded(v("rest"), 2),
            ),
          ),
        ],
      ),
  },
  // Groovy reverse() of a list: a new list of its elements in reverse order.
  reversed: {
    name: "sexscriptLegacyReversed",
    build: () =>
      fn(
        "sexscriptLegacyReversed",
        ["items"],
        [
          letS("result", { kind: "list", items: [] }),
          letS("index", bin("-", length(v("items")), lit(1))),
          whileS(bin(">=", v("index"), lit(0)), [
            {
              kind: "expression",
              expression: method(v("result"), "add", at(v("items"), v("index"))),
              span: null,
            },
            set("index", lit(1), "-="),
          ]),
          ret(v("result")),
        ],
      ),
  },
  // Groovy reverse() of text: its characters in reverse order.
  reversedText: {
    name: "sexscriptLegacyReversedText",
    build: () =>
      fn(
        "sexscriptLegacyReversedText",
        ["text"],
        [
          letS("result", lit("")),
          forS("character", method(v("text"), "split", lit("")), [
            set("result", template(v("character"), v("result"))),
          ]),
          ret(v("result")),
        ],
      ),
  },
};
