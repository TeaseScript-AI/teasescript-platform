/**
 * java.util.Calendar and java.util.Date as TeaseScript date and time values (#532). Like the rest of the importer, a
 * Calendar or Date becomes a `datetime`, the player's local date and time: fields read its properties (months from
 * 1, Monday-based weekdays), `add` adds an exact duration for time fields and a calendar duration for day, month, and
 * year fields, `before`/`after` compare, and Unix milliseconds go through `toTimestamp()`. A Java Date was a moment, so
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

export type TemporalKind = "calendar" | "date";

/** The Calendar and Date values of a body. */
export interface TemporalAnalysis {
  /** Variables that only ever hold a Calendar or only a Date. */
  readonly variables: ReadonlyMap<string, TemporalKind>;
  /** Map keys whose every value in the body's map literals is a Calendar or a Date, as `["calendar": c.clone()]`. */
  readonly fields: ReadonlyMap<string, TemporalKind>;
  /** Calendar variables that a write may replace: nothing else shares their object while it changes. */
  readonly writable: ReadonlySet<string>;
}

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
  return { variables, fields, writable: writableCalendars(tree, variables) };
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

/** The moment of Unix time 0, from which a number of milliseconds counts. */
const EPOCH = call("toTimestamp", literal("1970-01-01T00:00:00Z"));

/** Unix milliseconds of a local date and time. */
function milliseconds(value: IrExpression): IrExpression {
  return {
    kind: "methodCall",
    target: { kind: "methodCall", target: value, name: "toTimestamp", arguments: [] },
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
      target: call("getTimestamp"),
      name: "toMilliseconds",
      arguments: [],
    };
  if (owner !== null && CALENDAR_CLASSES.has(owner) && name === "getInstance" && args.length === 0)
    return call("getDateTime");
  // The current moment as Unix milliseconds needs no local date and time.
  if (args.length === 0 && currentMilliseconds(receiver, name))
    return {
      kind: "methodCall",
      target: call("getTimestamp"),
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
  return binary(
    operator,
    date,
    binary("*", whole(days), { kind: "duration", value: 1, unit: "day" }),
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
        binary("*", year!, { kind: "duration", value: 1, unit: "year" }),
      ),
      binary("*", month!, { kind: "duration", value: 1, unit: "month" }),
    ),
    binary("*", binary("-", day!, literal(1)), { kind: "duration", value: 1, unit: "day" }),
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
      const duration: IrExpression = { kind: "duration", value: 1, unit };
      // A negative literal amount subtracts, as `realStart - 15 * 1 min`.
      const negative =
        amount.kind === "literal" && typeof amount.value === "number" && amount.value < 0
          ? literal(-amount.value)
          : amount.kind === "unary" && amount.operator === "-" && amount.value.kind === "literal"
            ? amount.value
            : null;
      if (negative !== null)
        return assign(binary("-", target, binary("*", whole(negative), duration)));
      return assign(binary("+", target, binary("*", whole(amount), duration)));
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
