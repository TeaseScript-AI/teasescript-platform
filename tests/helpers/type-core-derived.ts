import type { Expression, Statement } from "../../src/ast.js";
import { parse } from "../../src/parser.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { CompactCheck, CompactRecord } from "./type-core-records.js";

/*
 * The reached fixture's derivation (S6-CARRIERS revision 5, §5.2; TABLE r4.59; the lead's answer 3): what a record's
 * plan checks, where, and how its runs end, derived from the record and its source alone, never from the plan.
 *
 * The derivation covers the fixture's constructs only: literals, host reads, list literals, constant indexes, binding
 * reads, constant `repeat`s, literal `if`s, `say` and `exit`. Anything else throws `Underivable`, so a construct the
 * slice grows to reach fails visibly until a rule covers it. Every run it predicts is compared with the real engine.
 */

/** A record, or a part of one, outside what the rules derive. */
export class Underivable extends Error {}

/** A checked type as the plan's `TypePlan` is compared: its kinds at a path, or a collection of them. */
export type DerivedType =
  | { readonly kind: "kinds"; readonly kinds: readonly string[] }
  | { readonly kind: "list" | "set" | "dict"; readonly element: DerivedType };

/** A store the plan checks: its statement's target, the statement's span, its value's span, and the type it checks. */
export interface DerivedStore {
  readonly target: string;
  readonly so: number;
  readonly eo: number;
  readonly valueSo: number;
  readonly valueEo: number;
  readonly type: DerivedType;
}

/** Where a record's obligation is discharged: by a checked store, or by the runtime itself (S3 §4). */
export type Discharge =
  | { readonly by: "store"; readonly store: DerivedStore }
  | {
      readonly by: "native";
      readonly what: "integer-use" | "representable";
      /** The obligation's site, `start:end`: the use, or the ingress. */
      readonly site: string;
    };

/** A checked type in full, as the candidate test writes a plan's: `integer`, `list<integer>`, `integer|string`. */
export function derivedText(type: DerivedType): string {
  return type.kind === "kinds"
    ? [...type.kinds].sort().join("|")
    : `${type.kind}<${derivedText(type.element)}>`;
}

function statementsOf(source: string): readonly Statement[] {
  const parsed = parse(source);
  if (parsed.diagnostics.length > 0) throw new Underivable("the source does not parse");
  return parsed.program.statements;
}

/** Every statement of a program, nested blocks included, in source order. */
function allStatements(statements: readonly Statement[]): Statement[] {
  return statements.flatMap((statement) => {
    if (statement.kind === "repeatStatement")
      return [statement, ...allStatements(statement.body.statements)];
    if (statement.kind === "ifStatement") {
      if (statement.elseBlock !== null) throw new Underivable("an `if` with an `else`");
      return [statement, ...allStatements(statement.thenBlock.statements)];
    }
    return [statement];
  });
}

/** A store statement's target name and value, or `null` for any other statement. */
function storeOf(
  statement: Statement,
): { readonly name: string; readonly value: Expression } | null {
  if (statement.kind === "letStatement")
    return { name: statement.name.name, value: statement.initializer };
  if (
    statement.kind === "assignmentStatement" &&
    statement.operator === "=" &&
    statement.target.kind === "identifier"
  )
    return { name: statement.target.name, value: statement.value };
  return null;
}

function unwrap(expression: Expression): Expression {
  return expression.kind === "parenthesizedExpression" ? unwrap(expression.expression) : expression;
}

/** The collection a value's literal structure, or its written type, has at a path's element step. */
function collectionAt(
  statement: Statement,
  value: Expression | null,
  path: readonly string[],
): "list" | "set" | "dict" {
  let annotation = statement.kind === "letStatement" ? statement.typeAnnotation : null;
  let literal: Expression | null = value === null ? null : unwrap(value);
  for (const step of path) {
    if (step !== "element") throw new Underivable("a property step");
    annotation =
      annotation !== null && annotation.kind !== "namedType" && "element" in annotation
        ? annotation.element
        : null;
    literal =
      literal !== null && (literal.kind === "listLiteral" || literal.kind === "setLiteral")
        ? (literal.elements[0] ?? null)
        : null;
  }
  if (
    annotation !== null &&
    (annotation.kind === "listType" ||
      annotation.kind === "setType" ||
      annotation.kind === "dictType")
  )
    return annotation.kind === "listType" ? "list" : annotation.kind === "setType" ? "set" : "dict";
  if (literal?.kind === "listLiteral") return "list";
  if (literal?.kind === "setLiteral") return "set";
  if (literal?.kind === "dictLiteral") return "dict";
  throw new Underivable("an element step without a written or literal collection");
}

/**
 * S3 §4's lowering of a store's checks by rule: the destination's structure at each target path (its written type,
 * else its value's literal structure), with the record's required kinds at each, `null` kept.
 */
function typeOf(
  statement: Statement,
  value: Expression,
  checks: readonly { readonly path: readonly string[]; readonly against: readonly string[] }[],
  depth = 0,
): DerivedType {
  const here = checks.filter((check) => check.path.length === depth);
  const below = checks.filter((check) => check.path.length > depth);
  if (here.length > 0 && below.length > 0)
    throw new Underivable("kinds and a structure at one path");
  if (below.length === 0)
    return { kind: "kinds", kinds: [...new Set(here.flatMap((check) => check.against))] };
  if (below.some((check) => check.path[depth] !== "element"))
    throw new Underivable("a property step");
  return {
    kind: collectionAt(statement, value, below[0]!.path.slice(0, depth)),
    element: typeOf(statement, value, below, depth + 1),
  };
}

/** Whether a record obligation is discharged by a checked store: a `copy-type` against a kind (S3 §4). */
function byStore(check: CompactCheck): boolean {
  return check.kind === "copy-type" && !check.against.every((kind) => kind === "unknown");
}

/**
 * The record's checked stores and the discharge of each of its obligations, by one rule (§5.2's discharges): a
 * `copy-type` against a kind at the store statement whose span holds its site; C2's `integer-check` at a count or an
 * index, and a boundary against `unknown`, by the runtime. Any other obligation is unmapped and throws, so a producer
 * the map does not know cannot be dropped.
 */
export function derive(
  source: string,
  record: CompactRecord,
): { readonly stores: readonly DerivedStore[]; readonly discharges: readonly Discharge[] } {
  const statements = allStatements(statementsOf(source));
  const owed = new Map<Statement, { path: readonly string[]; against: readonly string[] }[]>();
  const discharges: {
    check: CompactCheck;
    statement: Statement | null;
    what?: "integer-use" | "representable";
  }[] = [];
  for (const check of record.checks) {
    if (byStore(check)) {
      const statement = statements
        .filter((candidate) => storeOf(candidate) !== null)
        .filter(
          ({ span }) =>
            span.start.offset <= check.site.offset && check.site.offset < span.end.offset,
        )
        .sort(
          (a, b) =>
            a.span.end.offset - a.span.start.offset - (b.span.end.offset - b.span.start.offset),
        )[0];
      if (statement === undefined)
        throw new Error(`${check.target}: no store statement holds its check`);
      const store = storeOf(statement)!;
      const [name, ...path] = check.target.split(".");
      if (name !== store.name) throw new Underivable(`${check.target} is not ${store.name}'s`);
      owed.set(statement, [...(owed.get(statement) ?? []), { path, against: check.against }]);
      discharges.push({ check, statement });
    } else if (check.kind === "integer-check")
      discharges.push({ check, statement: null, what: "integer-use" });
    else if (check.kind === "copy-type" && check.boundary)
      discharges.push({ check, statement: null, what: "representable" });
    else throw new Error(`${check.kind} ${check.target}: an obligation no discharge rule maps`);
  }
  const stores = new Map<Statement, DerivedStore>();
  for (const [statement, checks] of owed) {
    const { name, value } = storeOf(statement)!;
    stores.set(statement, {
      target: name,
      so: statement.span.start.offset,
      eo: statement.span.end.offset,
      valueSo: value.span.start.offset,
      valueEo: value.span.end.offset,
      type: typeOf(statement, value, checks),
    });
  }
  return {
    stores: [...stores.values()].sort((a, b) => a.so - b.so),
    discharges: discharges.map(({ check, statement, what }) =>
      statement === null
        ? { by: "native", what: what!, site: `${check.site.offset}:${check.site.end}` }
        : { by: "store", store: stores.get(statement)! },
    ),
  };
}

// ------------------------------------------------------------------------------------------------ the companions

/** A companion of a record's source: its text and the host globals it reads, each read its own input. */
export interface Companion {
  readonly label: string;
  readonly source: string;
  readonly globals: readonly string[];
  /** Whether `say "AFTER"` was inserted before the final `exit`: the next effect a fitting run reaches. */
  readonly after: boolean;
}

const HOST = "hostValue";

/** The expressions of a program, in source order. */
function expressions(statements: readonly Statement[]): Expression[] {
  const out: Expression[] = [];
  const walk = (expression: Expression): void => {
    out.push(expression);
    if (expression.kind === "listLiteral") expression.elements.forEach(walk);
    else if (expression.kind === "parenthesizedExpression") walk(expression.expression);
    else if (expression.kind === "indexExpression") {
      walk(expression.object);
      walk(expression.index);
    }
  };
  for (const statement of allStatements(statements)) {
    const store = storeOf(statement);
    if (store !== null) walk(store.value);
    else if (statement.kind === "repeatStatement") walk(statement.count);
    else if (statement.kind === "ifStatement") walk(statement.condition);
  }
  return out;
}

function replaced(source: string, edits: readonly (readonly [number, number, string])[]): string {
  let out = source;
  for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0])) {
    if (text.length !== end - start) throw new Error("a companion keeps every span");
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

/**
 * §5.2's companions, from the source alone: every host read after the first renamed to a same-length global
 * (`hostValu2`, …); every constant index of a list literal given each element index of the same width; every number
 * literal a store writes whole given a same-width integer spelling, `(1)` for `1.5`; and `say "AFTER"` inserted before
 * a final `exit` where the program does not exit first. The original itself is not a companion: it runs as written.
 */
export function companions(source: string): readonly Companion[] {
  const statements = statementsOf(source);
  const all = expressions(statements);
  const hosts = all.filter(
    (expression) => expression.kind === "identifier" && expression.name === HOST,
  );
  const renames: (readonly [number, number, string])[] = hosts.slice(1).map((host, index) => {
    const name = `hostValu${index + 2}`;
    if (name.length !== HOST.length)
      throw new Underivable("more host reads than same-length names");
    return [host.span.start.offset, host.span.end.offset, name] as const;
  });
  const globals = [HOST, ...renames.map(([, , name]) => name)];
  const choices: (readonly (readonly [number, number, string] | null)[])[] = [];
  for (const expression of all) {
    if (expression.kind !== "indexExpression") continue;
    const list = unwrap(expression.object);
    const index = unwrap(expression.index);
    if (list.kind !== "listLiteral" || index.kind !== "numberLiteral") continue;
    const width = index.span.end.offset - index.span.start.offset;
    choices.push([
      null,
      ...list.elements
        .map((_, position) => String(position))
        .filter((text) => text.length === width && text !== index.raw)
        .map((text) => [index.span.start.offset, index.span.end.offset, text] as const),
    ]);
  }
  for (const statement of allStatements(statements)) {
    const store = storeOf(statement);
    const value = store === null ? null : store.value;
    if (value?.kind !== "numberLiteral" || value.numericType !== "number") continue;
    const spelling = `(${Math.trunc(value.value)})`;
    if (spelling.length !== value.raw.length) continue;
    choices.push([null, [value.span.start.offset, value.span.end.offset, spelling] as const]);
  }
  const top = statements;
  const last = top.at(-1);
  const after = last?.kind === "exitStatement" && top[0]?.kind !== "exitStatement";
  const out: Companion[] = [];
  const product = (at: number, picked: readonly (readonly [number, number, string])[]): void => {
    if (at === choices.length) {
      let text = replaced(source, [...renames, ...picked]);
      if (after) {
        const exit = last!.span.start.offset;
        text = `${text.slice(0, exit)}say "AFTER"\n${text.slice(exit)}`;
      }
      out.push({
        label:
          [
            ...picked.map(([start, , spelled]) => `${start}:${spelled}`),
            ...(after ? ["AFTER"] : []),
          ].join(" ") || "renamed",
        source: text,
        globals,
        after,
      });
      return;
    }
    for (const choice of choices[at]!)
      product(at + 1, choice === null ? picked : [...picked, choice]);
  };
  product(0, []);
  return out;
}

// ------------------------------------------------------------------------------------------------- the evaluator

/** A run's end as the engine reports it: its status, its failure `CODE@start:end`, and what it said, with offsets. */
export interface PredictedRun {
  readonly status: "halted" | "failed";
  readonly failure: string | null;
  readonly said: readonly { readonly text: string; readonly at: number }[];
}

/** One check a run evaluates: its discharge's site, whether the value fits, and the host globals the value came from. */
export interface CheckEvent {
  readonly site: string;
  readonly fits: boolean;
  readonly from: ReadonlySet<string>;
}

interface Value {
  readonly v: SerializableRuntimeValue;
  readonly from: ReadonlySet<string>;
}

class Stop {
  public constructor(readonly failure: string | null) {}
}

function fitsType(value: SerializableRuntimeValue, type: DerivedType): boolean {
  if (type.kind === "kinds")
    return type.kinds.some((kind) =>
      value === null
        ? kind === "null"
        : typeof value === "number"
          ? kind === "number" || (kind === "integer" && Number.isInteger(value))
          : typeof value === "string"
            ? kind === "string"
            : typeof value === "boolean"
              ? kind === "boolean"
              : false,
    );
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === type.kind &&
    "items" in value &&
    Array.isArray(value.items) &&
    value.items.every((item: SerializableRuntimeValue) => fitsType(item, type.element))
  );
}

/**
 * A run of `source` by the rules, with `inputs` the host globals' values: the plan's checked stores `stores` fail with
 * TSR058 at their value when it does not fit their type; a `repeat` count that is not a whole number of at least 0 fails
 * with TSR043 at the count, a list index that is not a whole number with TSR024, one the list does not have with
 * TSR025, both at the index. With `through`, a failing check is recorded and the run goes on, so a later check's value
 * is still seen (a preempted discharge).
 */
export function evaluate(
  source: string,
  stores: readonly DerivedStore[],
  inputs: Readonly<Record<string, SerializableRuntimeValue>>,
  through = false,
): { readonly run: PredictedRun; readonly events: readonly CheckEvent[] } {
  const statements = statementsOf(source);
  const env = new Map<string, Value>();
  const said: { text: string; at: number }[] = [];
  const events: CheckEvent[] = [];
  let first: string | null = null;
  const fail = (
    code: string,
    start: number,
    end: number,
    from: ReadonlySet<string>,
    fits: boolean,
  ): void => {
    events.push({ site: `${start}:${end}`, fits, from });
    if (fits) return;
    const failure = `${code}@${start}:${end}`;
    first ??= failure;
    if (!through) throw new Stop(failure);
  };
  const value = (expression: Expression): Value => {
    switch (expression.kind) {
      case "numberLiteral":
      case "booleanLiteral":
      case "nullLiteral":
        return { v: expression.value, from: new Set() };
      case "stringLiteral":
        if (expression.parts.some((part) => part.kind !== "stringText"))
          throw new Underivable("an interpolation");
        return {
          v: expression.parts
            .map((part) => (part.kind === "stringText" ? part.value : ""))
            .join(""),
          from: new Set(),
        };
      case "parenthesizedExpression":
        return value(expression.expression);
      case "identifier": {
        if (Object.hasOwn(inputs, expression.name))
          return { v: inputs[expression.name]!, from: new Set([expression.name]) };
        const bound = env.get(expression.name);
        if (bound === undefined)
          throw new Underivable(`a read of ${expression.name} before its store`);
        return bound;
      }
      case "listLiteral": {
        const items = expression.elements.map(value);
        return {
          v: { kind: "list", items: items.map((item) => item.v) },
          from: new Set(items.flatMap((item) => [...item.from])),
        };
      }
      case "indexExpression": {
        const list = value(expression.object);
        const index = value(expression.index);
        const { start, end } = {
          start: expression.index.span.start.offset,
          end: expression.index.span.end.offset,
        };
        if (
          typeof list.v !== "object" ||
          list.v === null ||
          !("kind" in list.v) ||
          list.v.kind !== "list"
        )
          throw new Underivable("an index of a value that is not a list");
        const items: readonly SerializableRuntimeValue[] = list.v.items;
        const whole = typeof index.v === "number" && Number.isInteger(index.v);
        fail("TSR024", start, end, index.from, whole);
        const position = Number(index.v);
        fail(
          "TSR025",
          start,
          end,
          index.from,
          !whole || (position >= 0 && position < items.length),
        );
        return { v: items[position] ?? null, from: list.from };
      }
      default:
        throw new Underivable(`a ${expression.kind}`);
    }
  };
  const run = (block: readonly Statement[]): void => {
    for (const statement of block) {
      const store = storeOf(statement);
      if (store !== null) {
        const stored = value(store.value);
        const checked = stores.find((candidate) => candidate.so === statement.span.start.offset);
        if (checked !== undefined)
          fail(
            "TSR058",
            checked.valueSo,
            checked.valueEo,
            stored.from,
            fitsType(stored.v, checked.type),
          );
        env.set(store.name, stored);
      } else if (statement.kind === "repeatStatement") {
        const count = value(statement.count);
        const fits = typeof count.v === "number" && Number.isInteger(count.v) && count.v >= 0;
        fail(
          "TSR043",
          statement.count.span.start.offset,
          statement.count.span.end.offset,
          count.from,
          fits,
        );
        for (let round = 0; round < (fits ? Number(count.v) : 0); round += 1)
          run(statement.body.statements);
      } else if (statement.kind === "ifStatement") {
        const condition = unwrap(statement.condition);
        if (condition.kind !== "booleanLiteral")
          throw new Underivable("an `if` on a value that is not literal");
        if (condition.value) run(statement.thenBlock.statements);
      } else if (statement.kind === "sayStatement") {
        const text = value(statement.value);
        if (typeof text.v !== "string") throw new Underivable("a message that is not text");
        said.push({ text: text.v, at: statement.span.start.offset });
      } else if (statement.kind === "exitStatement") throw new Stop(null);
      else throw new Underivable(`a ${statement.kind}`);
    }
  };
  let failure: string | null = null;
  try {
    run(statements);
  } catch (stop) {
    if (!(stop instanceof Stop)) throw stop;
    failure = stop.failure;
  }
  failure ??= first;
  return { run: { status: failure === null ? "halted" : "failed", failure, said }, events };
}
