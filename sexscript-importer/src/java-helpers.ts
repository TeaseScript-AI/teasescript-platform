/**
 * Generated TeaseScript functions for the Java and data API rules (java-data.ts, java-time.ts), registered with the
 * other generated helpers in helpers.ts. Each is ordinary TeaseScript, the same in every file that needs it.
 */
import type { IrExpression, IrStatement } from "./ir.ts";

export type JavaHelperName = "calendarTime";

/** The Java helpers in their stable order after the other generated helpers. */
export const JAVA_HELPER_ORDER: readonly JavaHelperName[] = ["calendarTime"];

const DEPENDENCIES = new Map<string, JavaHelperName[]>();

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
const call = (name: string, ...positional: IrExpression[]): IrExpression => ({
  kind: "call",
  name,
  positional,
  named: {},
});
const method = (target: IrExpression, name: string, ...args: IrExpression[]): IrExpression => ({
  kind: "methodCall",
  target,
  name,
  arguments: args,
});
const letS = (name: string, value: IrExpression): IrStatement => ({
  kind: "let",
  name,
  value,
  span: null,
});
const set = (name: string, value: IrExpression): IrStatement => ({
  kind: "assign",
  target: v(name),
  operator: "=",
  value,
  span: null,
});
const ret = (value: IrExpression): IrStatement => ({ kind: "return", value, span: null });
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
                bin("*", v("days"), { kind: "duration", value: 1, unit: "day" }),
              ),
              v("time"),
            ),
          ),
        ],
      ),
  },
};
