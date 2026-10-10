/**
 * java.util.Calendar and java.util.Date as TeaseScript date and time values (#532). Like the rest of the importer, a
 * Calendar or Date becomes a `datetime`, the player's local date and time: fields read its properties (months from
 * 1, Monday-based weekdays), `add` adds an exact duration for time fields and a calendar duration for day, month, and
 * year fields, `before`/`after` compare, and Unix milliseconds go through `toAbsoluteDateTime()`. A Java Date was a moment, so
 * the operations that read it as one carry a note: a local date and time names two moments in the hour that the
 * autumn daylight-saving change repeats.
 *
 * A Calendar is a mutable object, while a TeaseScript value is a copy: `cal.add(...)` becomes `cal = cal + ...`, which
 * is the same only while no other variable, list, or record shares the object, so writes convert only for a variable
 * whose object nothing else can see when it changes.
 */
import { constantString, variableName, type AstNode, type SourceSpan } from "./ast.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import {
  argumentsOf,
  asNode,
  buildTree,
  dottedName,
  isNullConstant,
  memberOf,
  type Tree,
} from "./java-ast.ts";
import { noteOnce, type JavaRuleHost } from "./java-data.ts";
import { NUMBER, onlyOf } from "./types.ts";
import { timeModel } from "./time-model.ts";

export type TemporalKind = "calendar" | "date";

/** The Calendar and Date values of a body. */
export interface TemporalAnalysis {
  /** Variables that only ever hold a Calendar or only a Date. */
  readonly variables: ReadonlyMap<string, TemporalKind>;
  /** Map keys whose every value in the body's map literals is a Calendar or a Date, as `["calendar": c.clone()]`. */
  readonly fields: ReadonlyMap<string, TemporalKind>;
  /** Calendar variables that a write may replace: nothing else shares their object while it changes. */
  readonly writable: ReadonlySet<string>;
  /** Variables that only ever hold a `new SimpleDateFormat(pattern)` of one literal pattern, by name. */
  readonly formatters?: ReadonlyMap<string, string>;
  /**
   * The date formatting calls whose text the script saves or parses again, as data rather than for display, which the
   * conversion writes exactly from the date's fields.
   */
  readonly dataFormats?: ReadonlySet<AstNode>;
}

const FORMATTER_TYPES = new Set(["SimpleDateFormat", "java.text.SimpleDateFormat"]);

const CALENDAR_CLASSES = new Set(["Calendar", "java.util.Calendar"]);
const GREGORIAN_TYPES = new Set(["GregorianCalendar", "java.util.GregorianCalendar"]);
const DATE_TYPES = new Set(["Date", "java.util.Date"]);
/** Calendar methods that change the object they are called on. */
const CALENDAR_WRITES = new Set(["add", "clear", "roll", "set", "setTime", "setTimeInMillis"]);
/** Members that read a Calendar or Date without sharing it. */
const TEMPORAL_READS = new Set([
  "after",
  "before",
  "clone",
  "compareTo",
  "equals",
  "format",
  "get",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTime",
  "getTimeInMillis",
  "getYear",
  "minus",
  "plus",
  "time",
  "timeInMillis",
]);
/** Calendar fields that `add` changes by an exact duration (elapsed time) or a calendar duration. */
const ADD_UNITS = new Map<string, IrDurationUnit>([
  ["MILLISECOND", "ms"],
  ["SECOND", "s"],
  ["MINUTE", "min"],
  ["HOUR", "h"],
  ["HOUR_OF_DAY", "h"],
  ["DATE", "day"],
  ["DAY_OF_MONTH", "day"],
  ["DAY_OF_YEAR", "day"],
  ["DAY_OF_WEEK", "day"],
  ["WEEK_OF_YEAR", "week"],
  ["WEEK_OF_MONTH", "week"],
  ["MONTH", "month"],
  ["YEAR", "year"],
]);
/** Time-of-day fields that `set` replaces, in the order of the helper's parameters. */
const TIME_FIELDS = ["HOUR_OF_DAY", "MINUTE", "SECOND", "MILLISECOND"] as const;
const TIME_PROPERTIES = ["hour", "minute", "second", "millisecond"] as const;

type IrDurationUnit = Extract<IrExpression, { kind: "duration" }>["unit"];

const MOMENT_NOTE =
  "Java kept this date as a moment; the conversion keeps the player's local date and time, which names two moments in the hour that the autumn daylight-saving change repeats.";

// ---------------------------------------------------------------------------------------------------------------
// Analysis

export function analyzeTemporal(root: AstNode): TemporalAnalysis {
  const tree = buildTree(root);
  const variables = new Map<string, TemporalKind>();
  const fields = new Map<string, TemporalKind>();
  const analysis: TemporalAnalysis = { variables, fields, writable: new Set() };
  // Variables and record fields whose every value is a Calendar, or every value a Date.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, values] of tree.assignments) {
      if (tree.parameters.has(name)) continue;
      const kind = commonKind(values, analysis);
      if (kind !== (variables.get(name) ?? null)) {
        if (kind === null) variables.delete(name);
        else variables.set(name, kind);
        changed = true;
      }
    }
    for (const [key, values] of mapEntries(tree)) {
      const kind = commonKind(values, analysis);
      if (kind !== (fields.get(key) ?? null)) {
        if (kind === null) fields.delete(key);
        else fields.set(key, kind);
        changed = true;
      }
    }
  }
  const formatters = dateFormatters(tree);
  return {
    variables,
    fields,
    writable: writableCalendars(tree, variables),
    formatters,
    dataFormats: dataFormats(tree, formatters),
  };
}

/** The literal pattern of a `new SimpleDateFormat(pattern)`, or null. */
function formatterPattern(node: AstNode | null): string | null {
  if (node?.kind !== "constructorCall" || !FORMATTER_TYPES.has(String(node.type))) return null;
  const args = argumentsOf(node);
  return args.length === 1 ? constantString(args[0]) : null;
}

/** Variables that only ever hold a SimpleDateFormat of one literal pattern. */
function dateFormatters(tree: Tree): Map<string, string> {
  const formatters = new Map<string, string>();
  for (const [name, values] of tree.assignments) {
    if (tree.parameters.has(name) || values.length === 0) continue;
    const patterns = new Set(values.map((value) => formatterPattern(value)));
    const [pattern] = patterns;
    if (patterns.size === 1 && typeof pattern === "string") formatters.set(name, pattern);
  }
  return formatters;
}

/**
 * The `format` calls whose text is data: saved, `save(key, text)`, or parsed again by a formatter, also through a
 * variable that holds the text, as jewell keeps the day it last ran (`y/M/d`) to count the days since.
 */
function dataFormats(tree: Tree, formatters: ReadonlyMap<string, string>): Set<AstNode> {
  const used = new Set<AstNode>();
  for (const node of tree.calls) {
    const name = constantString(node.method);
    const args = argumentsOf(node);
    const receiver = asNode(node.object);
    if (name === "save" && node.implicitThis === true && args.length === 2) used.add(args[1]!);
    if (name === "parse" && args.length === 1 && formatters.has(variableName(receiver) ?? ""))
      used.add(args[0]!);
  }
  const names = new Set([...used].flatMap((node) => variableName(node) ?? []));
  // A variable that one of them is set from holds the same text, `copy = text` before `save(key, copy)`.
  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...names])
      for (const value of tree.assignments.get(name) ?? []) {
        const source = variableName(value);
        if (source !== null && !names.has(source)) {
          names.add(source);
          changed = true;
        }
      }
  }
  const result = new Set<AstNode>();
  const isFormat = (node: AstNode | null): node is AstNode =>
    node?.kind === "methodCall" && constantString(node.method) === "format";
  for (const node of used) if (isFormat(node)) result.add(node);
  for (const name of names)
    for (const value of tree.assignments.get(name) ?? []) if (isFormat(value)) result.add(value);
  return result;
}

/** The kind every non-null value has, or null. */
function commonKind(
  values: ReadonlyArray<AstNode | null>,
  analysis: TemporalAnalysis,
): TemporalKind | null {
  const kinds = values.flatMap((value) =>
    value === null || isNullConstant(value) ? [] : [temporalKind(value, analysis)],
  );
  return kinds.length > 0 && kinds.every((kind) => kind !== null && kind === kinds[0])
    ? kinds[0]!
    : null;
}

/** The values of each key in the body's map literals and the assignments to it. */
function mapEntries(tree: Tree): Map<string, AstNode[]> {
  const entries = new Map<string, AstNode[]>();
  const add = (key: string, value: AstNode) =>
    entries.set(key, [...(entries.get(key) ?? []), value]);
  for (const [node, parent] of tree.parents) {
    if (node.kind === "mapEntry") {
      const key = constantString(node.key);
      const value = asNode(node.value);
      if (key !== null && value !== null) add(key, value);
    }
    // `record[key] = value` and `record.key = value` give the key another value.
    if (parent?.kind === "binary" && parent.operator === "=" && asNode(parent.left) === node) {
      const key =
        node.kind === "binary" && node.operator === "["
          ? constantString(node.right)
          : node.kind === "property"
            ? constantString(node.property)
            : null;
      const value = asNode(parent.right);
      if (key !== null && value !== null) add(key, value);
    }
  }
  return entries;
}

/** Whether a value is a Calendar or a Date, by how the body makes it. */
export function temporalKind(node: AstNode, analysis: TemporalAnalysis): TemporalKind | null {
  switch (node.kind) {
    case "variable":
      return analysis.variables.get(variableName(node) ?? "") ?? null;
    case "constructorCall": {
      const type = String(node.type);
      const count = argumentsOf(node).length;
      if (GREGORIAN_TYPES.has(type) && count === 0) return "calendar";
      // new Date(), new Date(ms), and the deprecated new Date(year, month, day[, hours, minutes[, seconds]]).
      return DATE_TYPES.has(type) && [0, 1, 3, 5, 6].includes(count) ? "date" : null;
    }
    case "binary": {
      if (node.operator === "[") {
        const key = constantString(node.right);
        return key === null ? null : (analysis.fields.get(key) ?? null);
      }
      // Groovy `date + days` and `date - days`.
      const left = asNode(node.left);
      return (node.operator === "+" || node.operator === "-") &&
        left !== null &&
        temporalKind(left, analysis) === "date" &&
        numberOperand(asNode(node.right), analysis)
        ? "date"
        : null;
    }
    case "property": {
      const name = constantString(node.property);
      const receiver = asNode(node.object);
      if (receiver === null || name === null) return null;
      const kind = temporalKind(receiver, analysis);
      if (name === "time" && kind === "calendar") return "date";
      return kind === null ? (analysis.fields.get(name) ?? null) : null;
    }
    case "methodCall": {
      const name = constantString(node.method);
      const receiver = asNode(node.object);
      const args = argumentsOf(node);
      if (receiver === null || name === null) return null;
      const owner = dottedName(receiver);
      if (
        owner !== null &&
        CALENDAR_CLASSES.has(owner) &&
        name === "getInstance" &&
        args.length === 0
      )
        return "calendar";
      // Date.parse(pattern, text) is a Date; Date.parse(text) gave Unix milliseconds.
      if (owner !== null && DATE_TYPES.has(owner) && name === "parse" && args.length >= 2)
        return "date";
      // A SimpleDateFormat's parse(text) is a Date too.
      if (name === "parse" && args.length === 1 && analysis.formatters?.has(owner ?? "") === true)
        return "date";
      const kind = temporalKind(receiver, analysis);
      if (name === "clone" && args.length === 0) return kind;
      if (name === "getTime" && args.length === 0 && kind === "calendar") return "date";
      if ((name === "plus" || name === "minus") && args.length === 1 && kind === "date")
        return numberOperand(args[0]!, analysis) ? "date" : null;
      return null;
    }
    default:
      return null;
  }
}

/** A number of days, as Groovy adds to a Date: not text, a list, or another date. */
function numberOperand(node: AstNode | null, analysis: TemporalAnalysis): boolean {
  if (node === null) return false;
  if (["gstring", "list", "map"].includes(node.kind)) return false;
  if (node.kind === "constant") return typeof node.value === "number";
  return temporalKind(node, analysis) === null;
}

/**
 * Calendar variables that a write may replace with a new value. A variable shares its object when it is assigned
 * another variable, or when a read hands it on (`list << cal`, `other = cal`, `f(cal)`) rather than calling a member.
 * The write is the same as Groovy's when it cannot reach such a copy: the variable is declared once with a new
 * Calendar, and every handing-on read comes after every write, in the same block and loop as the declaration.
 */
function writableCalendars(tree: Tree, variables: ReadonlyMap<string, TemporalKind>): Set<string> {
  const writable = new Set<string>();
  for (const [name, kind] of variables) {
    if (kind !== "calendar") continue;
    const values = tree.assignments.get(name) ?? [];
    // Each value must be a new object: getInstance(), a constructor, or clone().
    const fresh = values.every(
      (value) =>
        value === null ||
        isNullConstant(value) ||
        value.kind === "constructorCall" ||
        (value.kind === "methodCall" &&
          ["getInstance", "clone"].includes(constantString(value.method) ?? "")),
    );
    if (!fresh) continue;
    const reads = tree.reads.get(name) ?? [];
    const writes = reads.filter((read) => {
      const member = memberOf(read, tree);
      return member !== null && !member.property && CALENDAR_WRITES.has(member.name);
    });
    const handedOn = reads.filter((read) => {
      const member = memberOf(read, tree);
      return (
        member === null || (!TEMPORAL_READS.has(member.name) && !CALENDAR_WRITES.has(member.name))
      );
    });
    if (handedOn.length === 0 || writes.length === 0) {
      writable.add(name);
      continue;
    }
    const declaration = [...tree.parents.keys()].find(
      (node) => node.kind === "declaration" && variableName(node.left) === name,
    );
    if (declaration === undefined || values.length !== 1) continue;
    const block = enclosingBlock(declaration, tree);
    const lastWrite = Math.max(...writes.map((write) => position(write)));
    const safe =
      block !== null &&
      [...writes, ...handedOn].every((read) => sameLoopLevel(read, block, tree)) &&
      handedOn.every((read) => position(read) > lastWrite);
    if (safe) writable.add(name);
  }
  return writable;
}

function enclosingBlock(node: AstNode, tree: Tree): AstNode | null {
  for (let current = tree.parents.get(node) ?? null; current !== null;) {
    if (current.kind === "block") return current;
    current = tree.parents.get(current) ?? null;
  }
  return null;
}

/** Whether a node lies inside a block without a loop or closure between them. */
function sameLoopLevel(node: AstNode, block: AstNode, tree: Tree): boolean {
  for (let current = tree.parents.get(node) ?? null; current !== null;) {
    if (current === block) return true;
    if (["for", "while", "doWhile", "closure"].includes(current.kind)) return false;
    current = tree.parents.get(current) ?? null;
  }
  return false;
}

function position(node: AstNode): number {
  return node.span === null ? 0 : node.span.line * 100000 + node.span.column;
}

// ---------------------------------------------------------------------------------------------------------------
// Lowering

const call = (name: string, ...positional: IrExpression[]): IrExpression => ({
  kind: "call",
  name,
  positional,
  named: {},
});
const property = (target: IrExpression, name: string): IrExpression => ({
  kind: "property",
  target,
  name,
});
const binary = (operator: string, left: IrExpression, right: IrExpression): IrExpression => ({
  kind: "binary",
  operator,
  left,
  right,
});
const literal = (value: number | string): IrExpression => ({ kind: "literal", value });
const method = (target: IrExpression, name: string): IrExpression => ({
  kind: "methodCall",
  target,
  name,
  arguments: [],
});

/** The moment of Unix time 0, from which a number of milliseconds counts. */
const EPOCH = call("toAbsoluteDateTime", literal("1970-01-01T00:00:00Z"));

/** Unix milliseconds of a local date and time. */
function milliseconds(value: IrExpression): IrExpression {
  return {
    kind: "methodCall",
    target: { kind: "methodCall", target: value, name: "toAbsoluteDateTime", arguments: [] },
    name: "toMilliseconds",
    arguments: [],
  };
}

/** The local date and time of a number of Unix milliseconds, which Java truncated to a whole number. */
function fromMilliseconds(count: IrExpression): IrExpression {
  return {
    kind: "methodCall",
    target: binary(
      "+",
      EPOCH,
      binary("*", whole(count), { kind: "duration", value: 1, unit: "ms" }),
    ),
    name: "toDateTime",
    arguments: [],
  };
}

/** A whole number: Java's int and long parameters drop the fraction toward zero, as toInteger() does. */
export function whole(value: IrExpression): IrExpression {
  return isWhole(value) ? value : call("toInteger", value);
}

/** Whether a value is certainly a whole number: an integer literal, a rounding, or arithmetic of such. */
function isWhole(value: IrExpression): boolean {
  if (value.kind === "literal") return Number.isInteger(value.value);
  if (value.kind === "call") return ["toInteger", "round", "floor", "ceil"].includes(value.name);
  if (value.kind === "unary") return value.operator === "-" && isWhole(value.value);
  return (
    value.kind === "binary" &&
    ["+", "-", "*"].includes(value.operator) &&
    isWhole(value.left) &&
    isWhole(value.right)
  );
}

/** A Calendar field constant such as `Calendar.MINUTE`. */
function calendarField(node: AstNode | undefined): string | null {
  if (node?.kind !== "property") return null;
  const owner = dottedName(asNode(node.object));
  return owner !== null && CALENDAR_CLASSES.has(owner) ? constantString(node.property) : null;
}

/** Calendar.getInstance(), new GregorianCalendar(), and Date/Calendar method calls. */
export function temporalCall(
  node: AstNode,
  name: string,
  args: readonly AstNode[],
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const receiver = asNode(node.object);
  if (receiver === null) return undefined;
  const analysis = host.state.temporal;
  const owner = dottedName(receiver);
  // A SimpleDateFormat in a variable formats a date, or parses its text back (jewell's day count).
  const pattern = owner === null ? undefined : analysis.formatters?.get(owner);
  if (pattern !== undefined && args.length === 1) {
    if (name === "format") {
      const date = args[0]!;
      const now =
        date.kind === "constructorCall" &&
        DATE_TYPES.has(String(date.type)) &&
        argumentsOf(date).length === 0;
      if (!now && temporalKind(date, analysis) !== "date") return undefined;
      const source = now ? call("getDateTime") : host.lower(date);
      return source === null
        ? null
        : patternText(pattern, source, analysis.dataFormats?.has(node) === true, node, host);
    }
    if (name === "parse") return parsedDate(pattern, args[0]!, host);
  }
  const clock = name === "format" && args.length === 1 ? clockSeconds(receiver, args[0]!) : null;
  if (clock !== null) {
    const parts: IrExpression[] = [];
    for (const field of clock.fields) {
      const value = host.lower(field);
      if (value === null) return null;
      parts.push(whole(value));
    }
    // The total seconds, without the terms of zero hours or minutes.
    const terms = [
      binary("*", parts[0]!, literal(3600)),
      binary("*", parts[1]!, literal(60)),
      parts[2]!,
    ].filter(
      (term, index) =>
        !(index < 2 && parts[index]!.kind === "literal" && parts[index]!.value === 0),
    );
    const total = terms.slice(1).reduce((sum, term) => binary("+", sum, term), terms[0]!);
    const text = host.helper("clockText", [total]);
    return clock.pattern === "HH:mm:ss"
      ? text
      : clock.pattern === "HH:mm"
        ? {
            kind: "methodCall",
            target: text,
            name: "substring",
            arguments: [literal(0), literal(5)],
          }
        : { kind: "methodCall", target: text, name: "substring", arguments: [literal(3)] };
  }
  if (owner === "System" && name === "currentTimeMillis" && args.length === 0)
    return {
      kind: "methodCall",
      target: call("getAbsoluteDateTime"),
      name: "toMilliseconds",
      arguments: [],
    };
  if (owner !== null && CALENDAR_CLASSES.has(owner) && name === "getInstance" && args.length === 0)
    return call("getDateTime");
  // The current moment as Unix milliseconds needs no local date and time.
  if (args.length === 0 && currentMilliseconds(receiver, name))
    return {
      kind: "methodCall",
      target: call("getAbsoluteDateTime"),
      name: "toMilliseconds",
      arguments: [],
    };
  // get(Calendar.FIELD) proves a Calendar receiver whatever holds it.
  const field = calendarField(args[0]);
  const kind = field !== null && name === "get" ? "calendar" : temporalKind(receiver, analysis);
  if (kind === null) return undefined;
  const value = (): IrExpression | null => host.lower(receiver);
  switch (name) {
    case "get": {
      if (args.length !== 1 || field === null || kind !== "calendar") return undefined;
      const target = value();
      return target === null ? null : temporalField(field, target, node, host);
    }
    case "clone":
      return args.length === 0 ? value() : undefined;
    case "getTime":
    case "getTimeInMillis": {
      if (args.length !== 0) return undefined;
      if (name === "getTimeInMillis" && kind !== "calendar") return undefined;
      const target = value();
      if (target === null) return null;
      // A Calendar's getTime() is its Date, the same date and time; a Date's is its Unix milliseconds.
      if (name === "getTime" && kind === "calendar") return target;
      noteOnce(host, "SX_DATE_MOMENT", MOMENT_NOTE, node.span);
      return milliseconds(target);
    }
    case "before":
    case "after": {
      const other = args[0];
      if (args.length !== 1 || other === undefined || temporalKind(other, analysis) !== kind)
        return undefined;
      const left = value();
      const right = host.lower(other);
      if (left === null || right === null) return null;
      noteOnce(host, "SX_DATE_MOMENT", MOMENT_NOTE, node.span);
      return binary(name === "before" ? "<" : ">", left, right);
    }
    case "plus":
    case "minus":
      return args.length === 1 && kind === "date"
        ? dateArithmetic(name === "plus" ? "+" : "-", receiver, args[0]!, host)
        : undefined;
    // Groovy's Date.format(pattern), as Farkel shows the end of a denial.
    case "format": {
      const text = args.length === 1 ? constantString(args[0]) : null;
      if (text === null || kind !== "date") return undefined;
      const target = value();
      return target === null
        ? null
        : patternText(text, target, analysis.dataFormats?.has(node) === true, node, host);
    }
    case "getYear":
    case "getMonth":
    case "getDate":
    case "getDay":
    case "getHours":
    case "getMinutes":
    case "getSeconds": {
      if (args.length !== 0 || kind !== "date") return undefined;
      const target = value();
      return target === null ? null : dateGetter(name, target);
    }
    default:
      return undefined;
  }
}

/** `calendar.time` (its Date) and `date.time` or `calendar.timeInMillis` (Unix milliseconds). */
export function temporalProperty(
  node: AstNode,
  name: string,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const receiver = asNode(node.object);
  if (receiver === null) return undefined;
  const kind = temporalKind(receiver, host.state.temporal);
  const getter = DATE_PROPERTIES.get(name);
  if (kind === "date" && getter !== undefined) {
    const target = host.lower(receiver);
    return target === null ? null : dateGetter(getter, target);
  }
  if (name !== "time" && name !== "timeInMillis") return undefined;
  if (kind === null || (name === "timeInMillis" && kind !== "calendar")) return undefined;
  const target = host.lower(receiver);
  if (target === null) return null;
  if (name === "time" && kind === "calendar") return target;
  noteOnce(host, "SX_DATE_MOMENT", MOMENT_NOTE, node.span);
  return milliseconds(target);
}

/** Groovy `date + days`, `date - days`, and `date - otherDate` (whole calendar days between the two dates). */
export function temporalBinary(node: AstNode, host: JavaRuleHost): IrExpression | null | undefined {
  const operator = node.operator;
  const left = asNode(node.left);
  const right = asNode(node.right);
  if ((operator !== "+" && operator !== "-") || left === null || right === null) return undefined;
  if (temporalKind(left, host.state.temporal) !== "date") return undefined;
  return dateArithmetic(operator, left, right, host);
}

function dateArithmetic(
  operator: "+" | "-",
  dateNode: AstNode,
  operand: AstNode,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const analysis = host.state.temporal;
  const date = host.lower(dateNode);
  if (date === null) return null;
  if (operator === "-" && temporalKind(operand, analysis) === "date") {
    const other = host.lower(operand);
    if (other === null) return null;
    return property(binary("-", call("toDate", date), call("toDate", other)), "days");
  }
  if (!numberOperand(operand, analysis)) return undefined;
  const days = host.lower(operand);
  if (days === null) return null;
  // Groovy added calendar days in the JVM's zone: the same clock time, 23 or 25 hours apart across a clock change.
  return binary(
    operator,
    date,
    binary("*", whole(days), { kind: "duration", value: 1, unit: "day", calendar: true }),
  );
}

/** `new GregorianCalendar()` is the current local date and time; `new Date(ms)` the moment of Unix milliseconds. */
export function temporalConstructor(
  node: AstNode,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const type = String(node.type);
  const args = argumentsOf(node);
  if (GREGORIAN_TYPES.has(type) && args.length === 0) return call("getDateTime");
  // A formatter of a literal pattern keeps its pattern, which its format and parse calls write out.
  const pattern = formatterPattern(node);
  if (pattern !== null) return literal(pattern);
  if (!DATE_TYPES.has(type)) return undefined;
  if (args.length === 1) {
    // new Date(text) parsed the text instead.
    if (!onlyOf(host.valueType(args[0]!), NUMBER)) return undefined;
    const count = host.lower(args[0]!);
    return count === null ? null : fromMilliseconds(count);
  }
  if (![3, 5, 6].includes(args.length)) return undefined;
  const fields: IrExpression[] = [];
  for (const argument of args) {
    const value = host.lower(argument);
    if (value === null) return null;
    fields.push(whole(value));
  }
  // The deprecated constructor counts years from 1900 and months from 0, and lets every field carry into the next.
  const [year, month, day, hours, minutes, seconds] = fields;
  const date = binary(
    "+",
    binary(
      "+",
      binary(
        "+",
        call("toDate", literal("1900-01-01")),
        binary("*", year!, { kind: "duration", value: 1, unit: "year", calendar: true }),
      ),
      binary("*", month!, { kind: "duration", value: 1, unit: "month", calendar: true }),
    ),
    binary("*", binary("-", day!, literal(1)), {
      kind: "duration",
      value: 1,
      unit: "day",
      calendar: true,
    }),
  );
  const midnight = call("toDateTime", date, call("toTime", literal("00:00")));
  if (hours === undefined) return midnight;
  return host.helper("calendarTime", [
    midnight,
    hours,
    minutes ?? literal(0),
    seconds ?? literal(0),
    literal(0),
  ]);
}

/**
 * A date and time shown in a Java pattern (#532): the machine date `yyyy-MM-dd` as `toISO()`; a pattern of number
 * fields from the fields, exactly, where it shows no whole date or time, or where the script saves or parses the text
 * again (`data`); another display pattern of a whole date or time as the player's local form, with a note. Null after
 * a diagnostic for a pattern with names or a time zone.
 */
export function patternText(
  pattern: string,
  source: IrExpression,
  data: boolean,
  node: AstNode,
  host: JavaRuleHost,
): IrExpression | null {
  const kind = datePatternKind(pattern);
  if (kind === "isoDate") return method(call("toDate", source), "toISO");
  const fields = datePatternFields(pattern, source);
  if (fields !== null && (data || kind === null)) return fields;
  if (kind === null || data) {
    host.diagnostic(
      "SX_DATE_FORMAT",
      "error",
      data
        ? `The script saves or parses this date text again, so it needs Java's exact pattern ${JSON.stringify(pattern)}, whose names or time zone TeaseScript does not write; build the text from the date fields.`
        : "This Java date pattern is neither the ISO date yyyy-MM-dd (toISO()) nor a whole date or time that formatDate(), formatTime(), or formatDateTime() can show (#532); build the text from the date fields.",
      node.span,
    );
    return null;
  }
  const shown = kind === "date" ? "Date" : kind === "time" ? "Time" : "DateTime";
  host.diagnostic(
    "SX_DATE_FORMAT",
    "warning",
    `Java formatted this date with the pattern ${JSON.stringify(pattern)}; format${shown}() shows the player's local form instead (#532).`,
    node.span,
  );
  return method(source, `format${shown}`);
}

/**
 * A SimpleDateFormat's parse(text) of a pattern of a year, a month, and a day as numbers with one separator, as
 * jewell's `y/M/d`, which reads back the text the same pattern wrote: the date at midnight (a Java Date), with a note
 * that Java's lenient parse also read other text, which stops the script here or reads another date. Undefined for
 * another pattern, such as a month name or a two-digit year.
 */
function parsedDate(
  pattern: string,
  textNode: AstNode,
  host: JavaRuleHost,
): IrExpression | null | undefined {
  const tokens = [...pattern.matchAll(/([yMd])\1*|[^A-Za-z']/gu)].map((match) => match[0]);
  const [first, separator, second, other, third, extra] = tokens;
  if (
    tokens.join("") !== pattern ||
    first === undefined ||
    separator === undefined ||
    second === undefined ||
    other === undefined ||
    third === undefined ||
    extra !== undefined
  )
    return undefined;
  const fields = [first, second, third];
  if (separator !== other || /[A-Za-z]/u.test(separator)) return undefined;
  const at = (letter: string): number => fields.findIndex((field) => field.startsWith(letter));
  if (
    ["y", "M", "d"].some((letter) => at(letter) < 0) ||
    fields.some((field) => field === "yy" || (!field.startsWith("y") && field.length > 2))
  )
    return undefined;
  const text = host.lower(textNode);
  if (text === null) return null;
  noteOnce(
    host,
    "SX_DATE_PARSE",
    `Java's lenient parse of the pattern ${JSON.stringify(pattern)} also read a day or month past its end, which it carried into the next, a year of one or two digits in the current century, and spaces or text after the date; the conversion reads the date the pattern writes, and stops the script on other text or reads another year.`,
    textNode.span ?? null,
  );
  return host.helper("dateFromText", [
    text,
    literal(separator),
    literal(at("y")),
    literal(at("M")),
    literal(at("d")),
  ]);
}

/** What a Java SimpleDateFormat pattern shows: the ISO date, a whole date, a time, both, or null for anything else. */
export function datePatternKind(pattern: string): "isoDate" | "date" | "time" | "dateTime" | null {
  if (pattern === "yyyy-MM-dd") return "isoDate";
  // Quoted text is literal; every other letter is a pattern field.
  const fields = pattern.replace(/'[^']*'/gu, "").replace(/[^A-Za-z]/gu, "");
  if (/[^yMdHhkKmsSa]/u.test(fields)) return null;
  const date = /y/u.test(fields) && /M/u.test(fields) && /d/u.test(fields);
  const time = /[HhkK]/u.test(fields) && /m/u.test(fields);
  if (date && time) return "dateTime";
  if (date && !/[HhkKmsSa]/u.test(fields)) return "date";
  if (time && !/[yMd]/u.test(fields)) return "time";
  return null;
}

/** The date and time fields that Java's pattern letters write as numbers. */
const NUMBER_PATTERN_FIELDS = new Map([
  ["y", "year"],
  ["M", "month"],
  ["d", "day"],
  ["H", "hour"],
  ["m", "minute"],
  ["s", "second"],
]);

/**
 * A Java pattern of number fields, such as jewell's `dd/MM` or `HH`, as the fields of `source` (by default the current
 * date and time) written the same way, padded to the letters' count: exact, since Java writes numbers the same in
 * every locale. Null for a pattern with another letter, such as a month or weekday name.
 */
export function datePatternFields(
  pattern: string,
  source: IrExpression = { kind: "call", name: "getDateTime", positional: [], named: {} },
): IrExpression | null {
  const now = source;
  const parts: Array<{ text: string } | { value: IrExpression }> = [];
  for (const [token, letter] of pattern.matchAll(/'(?:[^']|'')*'|([A-Za-z])\1*|[^A-Za-z']+/gu)) {
    if (letter === undefined) {
      parts.push({
        text: token.startsWith("'") ? token.slice(1, -1).replaceAll("''", "'") || "'" : token,
      });
      continue;
    }
    const field = NUMBER_PATTERN_FIELDS.get(letter);
    if (field === undefined || (letter === "M" && token.length > 2)) return null;
    const value: IrExpression = { kind: "property", target: now, name: field };
    // `yy` writes the year's last two digits.
    const shown: IrExpression =
      letter === "y" && token.length === 2
        ? { kind: "binary", operator: "%", left: value, right: { kind: "literal", value: 100 } }
        : value;
    parts.push({
      value:
        token.length === 1
          ? shown
          : {
              kind: "methodCall",
              target: { kind: "call", name: "toString", positional: [shown], named: {} },
              name: "padStart",
              arguments: [
                { kind: "literal", value: token.length },
                { kind: "literal", value: "0" },
              ],
            },
    });
  }
  return { kind: "template", parts };
}

/** Calendar writes as statements: `cal.add(Calendar.MINUTE, n)`, `cal.set(...)`, `cal.setTime(d)`, ... */
export function temporalStatement(
  node: AstNode,
  name: string,
  args: readonly AstNode[],
  span: SourceSpan | null,
  host: JavaRuleHost,
): IrStatement[] | null {
  if (!CALENDAR_WRITES.has(name)) return null;
  const receiver = asNode(node.object);
  if (receiver === null) return null;
  const analysis = host.state.temporal;
  const field = calendarField(args[0]);
  const isCalendar = temporalKind(receiver, analysis) === "calendar" || field !== null;
  if (!isCalendar) return null;
  const variable = variableName(receiver);
  if (variable === null || !analysis.writable.has(variable)) {
    host.diagnostic(
      "SX_CALENDAR_SHARED",
      "error",
      "This Calendar may be shared with another variable, list, or record, which a Groovy write changed too; a TeaseScript date and time is a value, so give the copy its new value explicitly.",
      node.span,
    );
    return null;
  }
  const target: IrExpression = { kind: "variable", name: variable };
  const assign = (value: IrExpression): IrStatement[] => [
    { kind: "assign", target, operator: "=", value, span },
  ];
  switch (name) {
    case "add": {
      const unit = field === null ? undefined : ADD_UNITS.get(field);
      if (args.length !== 2 || unit === undefined) return null;
      const amount = host.lower(args[1]!);
      if (amount === null) return null;
      // Calendar added date fields as calendar steps and time fields as elapsed time.
      const calendar = unit === "day" || unit === "week" || unit === "month" || unit === "year";
      const duration: IrExpression = {
        kind: "duration",
        value: 1,
        unit,
        ...(calendar ? { calendar: true as const } : {}),
      };
      // A negative literal amount subtracts, as `realStart - 15 * 1 min`.
      const negative =
        amount.kind === "literal" && typeof amount.value === "number" && amount.value < 0
          ? literal(-amount.value)
          : amount.kind === "unary" && amount.operator === "-" && amount.value.kind === "literal"
            ? amount.value
            : null;
      const step = (base: IrExpression): IrExpression =>
        negative !== null
          ? binary("-", base, binary("*", whole(negative), duration))
          : binary("+", base, binary("*", whole(amount), duration));
      // Time model 2 adds elapsed time to a moment only, so the date and time goes through its moment and back.
      if (!calendar && timeModel() === 2)
        return assign(method(step(method(target, "toAbsoluteDateTime")), "toDateTime"));
      return assign(step(target));
    }
    case "set": {
      const index = TIME_FIELDS.findIndex((time) => time === field);
      if (args.length !== 2 || index < 0) return null;
      // Java normalizes the fields of a lenient Calendar when it next reads them, so a value outside its range combines
      // with later set() calls; a literal value in range needs no normalization.
      const literalValue = args[1]!.kind === "constant" ? args[1]!.value : undefined;
      const limit = [23, 59, 59, 999][index]!;
      if (
        typeof literalValue !== "number" ||
        !Number.isInteger(literalValue) ||
        literalValue < 0 ||
        literalValue > limit
      ) {
        host.diagnostic(
          "SX_CALENDAR_SET_RANGE",
          "error",
          `Calendar.set() converts for a literal ${TIME_FIELDS[index]} from 0 to ${limit}; Java combined other values with the later set() calls before it normalized them.`,
          node.span,
        );
        return null;
      }
      const amount = host.lower(args[1]!);
      if (amount === null) return null;
      const parts = TIME_PROPERTIES.map((time, position) =>
        position === index ? whole(amount) : property(target, time),
      );
      return assign(host.helper("calendarTime", [target, ...parts]));
    }
    case "setTime": {
      const date = args[0];
      if (args.length !== 1 || date === undefined || temporalKind(date, analysis) === null)
        return null;
      const value = host.lower(date);
      return value === null ? null : assign(value);
    }
    case "setTimeInMillis": {
      if (args.length !== 1) return null;
      const count = host.lower(args[0]!);
      return count === null ? null : assign(fromMilliseconds(count));
    }
    default:
      return null;
  }
}

/**
 * `new GregorianCalendar(0, 0, 0, hours, minutes, seconds[, 0]).time.format("HH:mm:ss")`, the idiom that shows a
 * number of seconds as a clock: a lenient calendar wraps the time at midnight, so only the time of day shows.
 */
function clockSeconds(
  receiver: AstNode,
  patternNode: AstNode,
): { fields: AstNode[]; pattern: string } | null {
  const pattern = constantString(patternNode);
  if (pattern !== "HH:mm:ss" && pattern !== "HH:mm" && pattern !== "mm:ss") return null;
  const calendar =
    receiver.kind === "property" && constantString(receiver.property) === "time"
      ? asNode(receiver.object)
      : receiver.kind === "methodCall" &&
          constantString(receiver.method) === "getTime" &&
          argumentsOf(receiver).length === 0
        ? asNode(receiver.object)
        : null;
  if (calendar?.kind !== "constructorCall" || !GREGORIAN_TYPES.has(String(calendar.type)))
    return null;
  const args = argumentsOf(calendar);
  const zero = (node: AstNode | undefined) => node?.kind === "constant" && node.value === 0;
  if (args.length < 6 || args.length > 7 || !args.slice(0, 3).every(zero)) return null;
  if (args.length === 7 && !zero(args[6])) return null;
  return { fields: args.slice(3, 6), pattern };
}

/** Groovy properties of a Date that read its deprecated getters, such as `date.year` for getYear(). */
const DATE_PROPERTIES = new Map([
  ["year", "getYear"],
  ["month", "getMonth"],
  ["date", "getDate"],
  ["day", "getDay"],
  ["hours", "getHours"],
  ["minutes", "getMinutes"],
  ["seconds", "getSeconds"],
]);

/** The deprecated Date getters, which count years from 1900, months from 0, and weekdays from Sunday as 0. */
function dateGetter(getter: string, target: IrExpression): IrExpression {
  switch (getter) {
    case "getYear":
      return binary("-", property(target, "year"), literal(1900));
    case "getMonth":
      return binary("-", property(target, "month"), literal(1));
    case "getDate":
      return property(target, "day");
    case "getDay":
      return binary("%", property(target, "weekdayNumber"), literal(7));
    case "getHours":
      return property(target, "hour");
    case "getMinutes":
      return property(target, "minute");
    default:
      return property(target, "second");
  }
}

/** A Calendar field of a date and time: TeaseScript months count from 1 and weekdays from Monday. */
function temporalField(
  field: string,
  value: IrExpression,
  node: AstNode,
  host: JavaRuleHost,
): IrExpression | null {
  switch (field) {
    case "SECOND":
      return property(value, "second");
    case "MILLISECOND":
      return property(value, "millisecond");
    default:
      return host.calendarField(field, value, node);
  }
}

/**
 * Whether a member reads the Unix milliseconds of the current moment: `new Date().getTime()`,
 * `Calendar.getInstance().getTimeInMillis()`, or `Calendar.getInstance().getTime().getTime()`.
 */
function currentMilliseconds(receiver: AstNode, member: string): boolean {
  const current = (node: AstNode): "calendar" | "date" | null => {
    if (node.kind === "constructorCall" && argumentsOf(node).length === 0) {
      const type = String(node.type);
      return DATE_TYPES.has(type) ? "date" : GREGORIAN_TYPES.has(type) ? "calendar" : null;
    }
    if (node.kind !== "methodCall" || argumentsOf(node).length !== 0) return null;
    const name = constantString(node.method);
    const owner = asNode(node.object);
    if (owner === null) return null;
    if (name === "getInstance")
      return CALENDAR_CLASSES.has(dottedName(owner) ?? "") ? "calendar" : null;
    return name === "getTime" && current(owner) === "calendar" ? "date" : null;
  };
  const kind = current(receiver);
  return (
    (kind === "date" && member === "getTime") ||
    (kind === "calendar" && member === "getTimeInMillis")
  );
}
