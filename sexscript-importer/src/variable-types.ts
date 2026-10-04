import { isRecord } from "./ast.ts";
import { helperCall } from "./helpers.ts";
import type { IrExpression, IrFunctionParameter, IrStatement } from "./ir.ts";

/**
 * A TeaseScript variable keeps its declared or inferred type (V30 §12, #519): an `integer` may receive a `number`
 * only when it is declared as one, and a variable that receives `null` needs an optional type. This pass follows the
 * compiler's static types over the generated program and repairs what a declaration can express: it annotates
 * `let i: number = 0` or `let name: string? = "Ada"`, and truncates values stored in a variable that Groovy declared
 * as an integer type (`int m = 7 / 2` stores 3) with `toInteger`. A variable that holds values of two different
 * types, such as text and a list, cannot be expressed without union types; those are returned as conflicts.
 *
 * Types follow the compiler (`src/static-types.ts` in the repository root).
 * Values it cannot know, such as storage and function results, are not checked.
 */
export type TeaseType =
  | { kind: "unknown" }
  | { kind: "null" }
  | { kind: "scalar"; name: ScalarName }
  | { kind: "list"; element: TeaseType }
  | { kind: "optional"; value: TeaseType }
  /** A declared union of writable types (ADR 0021 §3), none of them null, optional, or itself a union. */
  | { kind: "union"; members: TeaseType[] }
  | { kind: "object" | "range" | "handle" | "dict" }
  /** A local date, time, or datetime, or a fixed timestamp (#532). */
  | { kind: "temporal"; name: "date" | "time" | "datetime" | "timestamp" };

const SCALAR_NAMES = ["string", "integer", "number", "boolean", "duration"] as const;
type ScalarName = (typeof SCALAR_NAMES)[number];

type LetStatement = Extract<IrStatement, { kind: "let" }>;

export interface TypeConflict {
  /** The variable's declaration, or null for a loop variable. */
  declaration: LetStatement | null;
  /** The statement that stores the value of another type. */
  statement: IrStatement;
  message: string;
  /** SX_TYPE_CHANGE, or SX_LIST_CONCATENATION for a list append of a value of unknown type. */
  code: string;
}

export interface VariableTypeResult {
  statements: IrStatement[];
  /** Variables, or for a loop variable single assignments, that keep values of two types. */
  conflicts: TypeConflict[];
  /**
   * Truncated statements (as rewritten) whose value of unknown type Groovy may have held as text, which an integer
   * variable stored as its character code, where `toInteger()` reads the number the text spells.
   */
  textIntegers: IrStatement[];
  /**
   * Declarations whose empty-text placeholder became the empty value of the type the variable later holds; `first`
   * describes the type whose empty value it is when the variable holds a union.
   */
  placeholders: Array<{ statement: IrStatement; name: string; type: string; first?: string }>;
  /** Declarations of variables that Groovy gave values of several types, now declared with a union type. */
  unions: Array<{
    statement: IrStatement;
    name: string;
    type: string;
    example: string;
    /** Whether the union is the type of the list's elements rather than of the variable itself. */
    elements: boolean;
  }>;
  /** Declarations that gained a `number` or optional type annotation. */
  annotated: number;
  /** Values truncated with `toInteger` because Groovy declared the variable with an integer type. */
  truncated: number;
  /**
   * `list += value` statements, emitted as numeric `+=` because the list was not proven while lowering, that now
   * append with the concatenation helper.
   */
  appended: IrStatement[];
  /** `text += value` statements, emitted as numeric `+=` because the text was not proven while lowering. */
  textAppended: IrStatement[];
}

const UNKNOWN: TeaseType = { kind: "unknown" };
const NULL: TeaseType = { kind: "null" };
const scalar = (name: ScalarName): TeaseType => ({ kind: "scalar", name });
const listOf = (element: TeaseType): TeaseType => ({ kind: "list", element });

interface Binding {
  name: string;
  declaration: LetStatement | null;
  /** Groovy declared an integer type, which truncates every stored number. */
  integer: boolean;
  /** Annotation written by lowering, or the fixed type of a loop variable or media handle. */
  fixed: TeaseType | undefined;
  /** Initializer type as of the last analysis round. */
  initial: TeaseType;
  /**
   * For a variable that starts as `null`: the type of its first stored value in this round, which it then keeps as an
   * optional type (#504 decision 1a); `undefined` until a value is stored.
   */
  inferred: TeaseType | undefined;
  widened: boolean;
  optional: boolean;
  /**
   * A union type that keeps every type Groovy stored (ADR 0021 §3): the variable's own type, or a list whose element
   * type is a union.
   */
  union?: TeaseType;
  /**
   * The type a Groovy empty-text placeholder (`def lines = ""`) later holds instead, whose empty value the declaration
   * starts with.
   */
  placeholder?: TeaseType;
}

/** What declares a binding: a `let`, a `for` loop, a media handle, or a function parameter. */
type BindingKey = IrStatement | IrFunctionParameter;

interface Conflict {
  binding: Binding;
  statement: IrStatement;
  /** Whether the declaration itself is fine and only this statement is invalid, such as `list += value`. */
  operation: boolean;
  message: string;
  code: string;
}

/** The result types of the functions among `statements`, from their `return` values. */
export function functionResultTypes(statements: IrStatement[]): Map<string, TeaseType> {
  const bindings = new Map<BindingKey, Binding>();
  let results = new Map<string, TeaseType>();
  for (let round = 0; round < 50; round += 1) {
    const analysis = analyse(statements, bindings, results);
    const changed = [...analysis.results].some(
      ([name, type]) => typeName(type) !== typeName(results.get(name) ?? UNKNOWN),
    );
    results = analysis.results;
    if (!analysis.changed && !changed) break;
  }
  return results;
}

interface Rounds {
  bindings: Map<BindingKey, Binding>;
  conflicts: Conflict[];
  appends: Map<IrStatement, boolean>;
  textAppends: Set<IrStatement>;
  unguarded: Set<IrStatement>;
  /** Statements whose stored number truncates to an integer. */
  truncations: Set<IrStatement>;
  integerLoads: Set<IrStatement>;
  /** Truncations of a value of unknown type that Groovy may have held as text. */
  textIntegers: Set<IrStatement>;
  indexes: Set<IrExpression>;
}

/** Analysis rounds until no declaration or function result changes. */
function runRounds(
  statements: IrStatement[],
  knownResults: ReadonlyMap<string, TeaseType>,
): Rounds {
  const rounds: Rounds = {
    bindings: new Map(),
    conflicts: [],
    appends: new Map(),
    textAppends: new Set(),
    unguarded: new Set(),
    truncations: new Set(),
    integerLoads: new Set(),
    textIntegers: new Set(),
    indexes: new Set(),
  };
  let results = new Map(knownResults);
  for (let round = 0; round < 50; round += 1) {
    const analysis = analyse(statements, rounds.bindings, results);
    rounds.conflicts = analysis.conflicts;
    rounds.appends = analysis.appends;
    rounds.textAppends = analysis.textAppends;
    rounds.unguarded = analysis.unguarded;
    rounds.indexes = analysis.indexes;
    for (const statement of analysis.truncations) rounds.truncations.add(statement);
    for (const statement of analysis.integerLoads) rounds.integerLoads.add(statement);
    rounds.textIntegers = analysis.textIntegers;
    const next = new Map([...knownResults, ...analysis.results]);
    const resultsChanged =
      next.size !== results.size ||
      [...next].some(([name, type]) => typeName(type) !== typeName(results.get(name) ?? UNKNOWN));
    results = next;
    if (!analysis.changed && !resultsChanged) break;
  }
  return rounds;
}

export function enforceVariableTypes(
  statements: IrStatement[],
  /** Result types of functions defined elsewhere, such as the generated helpers. */
  knownResults: ReadonlyMap<string, TeaseType> = new Map(),
): VariableTypeResult {
  const accepted = runRounds(statements, knownResults);
  const { bindings, appends, textAppends, truncations, integerLoads, textIntegers, indexes } =
    accepted;
  const conflicts = accepted.conflicts;
  // A repair that needs a type no annotation can write, such as an optional object, becomes a conflict too.
  const conflicting = new Set(conflicts.map((conflict) => conflict.binding));
  for (const binding of bindings.values()) {
    if (!binding.widened && !binding.optional) continue;
    const type = bindingType(binding);
    if (type !== undefined && annotation(type) !== null) continue;
    if (conflicting.has(binding) || binding.declaration === null) continue;
    conflicts.push({
      binding,
      statement: binding.declaration,
      operation: false,
      code: "SX_TYPE_CHANGE",
      message: `'${binding.name}' needs the type ${type === undefined ? "?" : typeName(type)} for its later values, which TeaseScript cannot write as an annotation`,
    });
    conflicting.add(binding);
  }

  const declarationConflicts = new Map<LetStatement, Conflict[]>();
  const statementConflicts = new Map<IrStatement, Conflict>();
  for (const conflict of conflicts) {
    const declaration = conflict.binding.declaration;
    if (declaration === null || conflict.operation) {
      if (!statementConflicts.has(conflict.statement))
        statementConflicts.set(conflict.statement, conflict);
      continue;
    }
    declarationConflicts.set(declaration, [
      ...(declarationConflicts.get(declaration) ?? []),
      conflict,
    ]);
  }
  const result: VariableTypeResult = {
    statements: [],
    conflicts: [],
    textIntegers: [],
    placeholders: [],
    unions: [],
    annotated: 0,
    truncated: 0,
    appended: [],
    textAppended: [],
  };
  for (const [declaration, items] of declarationConflicts) {
    result.conflicts.push({
      declaration,
      statement: declaration,
      message: declarationMessage(items),
      code: "SX_TYPE_CHANGE",
    });
  }
  for (const conflict of statementConflicts.values()) {
    result.conflicts.push({
      declaration: conflict.binding.declaration,
      statement: conflict.statement,
      message: conflict.message,
      code: conflict.code,
    });
  }

  const bindingOf = new Map<LetStatement, Binding>();
  for (const binding of bindings.values()) {
    if (binding.declaration !== null) bindingOf.set(binding.declaration, binding);
  }
  const truncate = (value: IrExpression): IrExpression => {
    result.truncated += 1;
    return { kind: "call", name: "toInteger", positional: [value], named: {} };
  };
  const rewrite = (items: IrStatement[]): IrStatement[] =>
    items.map((statement): IrStatement => {
      switch (statement.kind) {
        case "let": {
          const binding = bindingOf.get(statement);
          if (binding === undefined || declarationConflicts.has(statement)) return statement;
          let next: LetStatement = statement;
          const placeholder =
            binding.placeholder === undefined ? null : emptyValue(binding.placeholder);
          if (placeholder !== null) next = { ...next, value: placeholder };
          if (truncations.has(statement)) next = { ...next, value: truncate(next.value) };
          if (integerLoads.has(statement)) {
            result.annotated += 1;
            next = { ...next, type: binding.optional ? "integer?" : "integer" };
          }
          const type = bindingType(binding);
          const written = type === undefined ? null : annotation(type);
          // An unannotated variable widens from integer to number by itself (#504 option B); an optional type and a
          // widened list element type still need an annotation.
          // The compiler narrows an initializer that may be null to its current type, so a variable that keeps such a
          // value later needs its optional type written.
          const needed =
            binding.optional ||
            binding.union !== undefined ||
            // A list literal that mixes types needs its union element type written (ADR 0021 rule 1.3).
            (type !== undefined && hasUnion(type) && statement.value.kind === "list") ||
            binding.initial.kind === "optional" ||
            (binding.widened && type !== undefined && nonNull(type).kind === "list");
          if (needed && written !== null) {
            result.annotated += 1;
            next = { ...next, type: written };
          }
          // An empty list needs its element type written.
          if (placeholder?.kind === "list" && written !== null && next.type === undefined)
            next = { ...next, type: written };
          const rewritten = withIntegerIndexes(next, indexes);
          if (textIntegers.has(statement)) result.textIntegers.push(rewritten);
          const declared = binding.union === undefined ? undefined : nonNull(binding.union);
          const union = declared?.kind === "list" ? declared.element : declared;
          if (union?.kind === "union" && written !== null)
            result.unions.push({
              statement: rewritten,
              name: statement.name,
              type: written,
              example: typeName(union.members[0]!),
              elements: declared?.kind === "list",
            });
          if (placeholder !== null && type !== undefined)
            result.placeholders.push({
              statement: rewritten,
              name: statement.name,
              type: describeValue(type),
              ...(nonNull(type).kind === "union" && binding.placeholder !== undefined
                ? { first: describeValue(binding.placeholder) }
                : {}),
            });
          return rewritten;
        }
        case "assign": {
          if (textAppends.has(statement)) {
            // Groovy `text += value` appended the value's text.
            result.textAppended.push(statement);
            return {
              ...statement,
              operator: "=",
              value: {
                kind: "template",
                parts: [
                  { value: statement.target },
                  ...(statement.value.kind === "template"
                    ? statement.value.parts
                    : statement.value.kind === "literal" &&
                        typeof statement.value.value === "string"
                      ? [{ text: statement.value.value }]
                      : [{ value: statement.value }]),
                ],
              },
            };
          }
          const appendsList = appends.get(statement);
          if (appendsList !== undefined) {
            result.appended.push(statement);
            const value = appendsList
              ? statement.value
              : { kind: "list" as const, items: [statement.value] };
            return {
              ...statement,
              operator: "=",
              value: helperCall("concat", [{ kind: "list", items: [statement.target, value] }]),
            };
          }
          if (!truncations.has(statement)) return withIntegerIndexes(statement, indexes);
          if (statement.operator === "=") {
            const rewritten = withIntegerIndexes(
              { ...statement, value: truncate(statement.value) },
              indexes,
            );
            if (textIntegers.has(statement)) result.textIntegers.push(rewritten);
            return rewritten;
          }
          return {
            ...statement,
            operator: "=",
            value: truncate({
              kind: "binary",
              operator: statement.operator === "+=" ? "+" : "-",
              left: statement.target,
              right: statement.value,
            }),
          };
        }
        case "function":
          return { ...statement, body: rewrite(statement.body) };
        case "if":
          return withIntegerIndexes(
            { ...statement, then: rewrite(statement.then), else: rewrite(statement.else) },
            indexes,
          );
        case "while":
        case "repeat":
        case "for":
          return withIntegerIndexes({ ...statement, body: rewrite(statement.body) }, indexes);
        case "switch":
          return {
            ...statement,
            cases: statement.cases.map((item) => ({ ...item, body: rewrite(item.body) })),
            default: rewrite(statement.default),
          };
        default:
          return statementConflicts.has(statement)
            ? statement
            : withIntegerIndexes(statement, indexes);
      }
    });
  result.statements = rewrite(withoutGuards(statements, accepted.unguarded));
  return result;
}

function declarationMessage(items: Conflict[]): string {
  const binding = items[0]!.binding;
  const lines = [
    ...new Set(
      items.flatMap((item) => (item.statement.span === null ? [] : [item.statement.span.line])),
    ),
  ].sort((left, right) => left - right);
  const first = items[0]!.message;
  const where =
    lines.length === 0
      ? ""
      : ` (line${lines.length === 1 ? "" : "s"} ${lines.slice(0, 5).join(", ")}${lines.length > 5 ? ", ..." : ""})`;
  return `${first}${where}. A TeaseScript variable keeps one type (V30 §12), while Groovy let '${binding.name}' change type, and the importer declares unions only of text, numbers, booleans, durations, lists, and objects. Use a separate variable for the other values, or give all values one type.`;
}

class Scope {
  readonly names = new Map<string, Binding>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  resolve(name: string): Binding | undefined {
    return this.names.get(name) ?? this.parent?.resolve(name);
  }
}

interface Analysis {
  changed: boolean;
  conflicts: Conflict[];
  /** Result types of the program's functions as of this round, from their `return` values. */
  results: Map<string, TeaseType>;
  truncations: Set<IrStatement>;
  /** Integer declarations initialized from storage, declared `: integer` so the stored value is checked. */
  integerLoads: Set<IrStatement>;
  textIntegers: Set<IrStatement>;
  /** List indexes, and `removeAt` calls, whose position may hold a fraction. */
  indexes: Set<IrExpression>;
  /** `list += value` statements, and whether the value is a list whose elements are appended. */
  appends: Map<IrStatement, boolean>;
  /** `text += value` statements on a variable that holds text. */
  textAppends: Set<IrStatement>;
  /** The importer's null tests of input questions on variables that can never hold null. */
  unguarded: Set<IrStatement>;
}

function analyse(
  statements: IrStatement[],
  bindings: Map<BindingKey, Binding>,
  results: ReadonlyMap<string, TeaseType>,
): Analysis {
  const analysis: Analysis = {
    changed: false,
    conflicts: [],
    results: new Map(),
    truncations: new Set(),
    integerLoads: new Set(),
    textIntegers: new Set(),
    indexes: new Set(),
    appends: new Map(),
    textAppends: new Set(),
    unguarded: new Set(),
  };
  // The `return` value types of the function being walked; null for a bare `return` or falling off the end.
  let returns: TeaseType[] | null = null;
  const nullTested = nullTestedNames(statements);
  for (const item of bindings.values()) item.inferred = undefined;
  const root = new Scope(null);
  const functions: Array<Extract<IrStatement, { kind: "function" }>> = [];
  const binding = (
    key: BindingKey,
    name: string,
    declaration: LetStatement | null,
    fixed: TeaseType | undefined,
  ): Binding => {
    let found = bindings.get(key);
    if (found === undefined) {
      found = {
        name,
        declaration,
        integer: declaration?.integer === true,
        fixed,
        initial: UNKNOWN,
        inferred: undefined,
        widened: false,
        optional: false,
      };
      bindings.set(key, found);
    }
    return found;
  };
  const typeOf = (value: IrExpression, scope: Scope): TeaseType =>
    expressionType(
      value,
      (name) => {
        const found = scope.resolve(name);
        return found === undefined ? UNKNOWN : (bindingType(found) ?? UNKNOWN);
      },
      (name) => results.get(name),
    );
  const conflict = (
    target: Binding,
    statement: IrStatement,
    message: string,
    operation = false,
    code = "SX_TYPE_CHANGE",
  ): void => {
    analysis.conflicts.push({ binding: target, statement, operation, message, code });
  };
  const change = (apply: () => void): void => {
    apply();
    analysis.changed = true;
  };

  /** Checks that `value` may be stored in `target`, repairing the declaration where an annotation can. */
  const store = (target: Binding, value: TeaseType, statement: IrStatement): void => {
    if (
      target.fixed === undefined &&
      target.initial.kind === "null" &&
      target.inferred === undefined &&
      value.kind !== "null"
    ) {
      // A variable that starts as null keeps the type of its first value, optional (#504 decision 1a).
      target.inferred = value;
      return;
    }
    // A storage read is checked when stored; it may be null, which matters only where the program tests the variable
    // for null and so expects one.
    if (
      nonNull(value).kind === "unknown" &&
      !(value.kind === "optional" && nullTested.has(target.name))
    )
      return;
    const type = bindingType(target);
    // A list that starts empty takes its element type from its first elements (ADR 0021 rule 1.3), so elements of
    // several types need that union written on the declaration.
    if (
      type?.kind === "list" &&
      type.element.kind === "unknown" &&
      target.declaration !== null &&
      target.fixed === undefined &&
      target.union === undefined &&
      value.kind === "list" &&
      hasUnion(value) &&
      annotation(value) !== null
    )
      return change(() => (target.union = value));
    if (type === undefined || isAssignable(type, value)) return;
    // Only a declaration can take an annotation; a loop variable keeps its element type.
    const declared = target.declaration !== null;
    if (declared && value.kind === "null" && type.kind !== "optional")
      return change(() => (target.optional = true));
    // A value that may be null, such as the result of a function that may return nothing, needs an optional type too
    // (ADR 0021 rule 1.9).
    if (
      declared &&
      value.kind === "optional" &&
      type.kind !== "optional" &&
      isAssignable(type, value.value)
    )
      return change(() => (target.optional = true));
    if (declared && canWiden(type, value) && !target.widened)
      return change(() => (target.widened = true));
    // A variable that Groovy gave values of several types keeps them all in a declared union.
    const merged =
      declared && target.fixed === undefined && !target.integer ? unionOf(type, value) : null;
    if (merged !== null && target.placeholder !== undefined) {
      const text = scalar("string");
      // Groovy stored text too, so the empty text it started with was a value rather than a placeholder.
      if (isAssignable(merged, text))
        return change(() => {
          delete target.placeholder;
          target.initial = text;
          target.union = unionOf(text, merged) ?? merged;
        });
      return change(() => (target.union = merged));
    }
    // An empty-text placeholder that later holds values of one other type starts with that type's empty value.
    const declaration = target.declaration;
    if (
      declaration !== null &&
      target.placeholder === undefined &&
      target.fixed === undefined &&
      !target.integer &&
      declaration.value.kind === "literal" &&
      declaration.value.value === "" &&
      emptyValue(nonNull(value)) !== null
    ) {
      return change(() => {
        target.placeholder = nonNull(value);
        target.initial = nonNull(value);
      });
    }
    if (merged !== null) return change(() => (target.union = merged));
    conflict(
      target,
      statement,
      `'${target.name}' starts as ${describeValue(type)}, but is later set to ${describeValue(value)}`,
    );
  };

  /** A position that may hold a fraction cannot index a list (#504 option B); Groovy truncated it. */
  const findIndexes = (value: IrExpression, scope: Scope): void => {
    forEachExpression(value, (child) => {
      const position =
        child.kind === "index" && child.dict !== true
          ? child.index
          : child.kind === "methodCall" && child.name === "removeAt" && child.arguments.length === 1
            ? child.arguments[0]!
            : null;
      if (position !== null && isNumber(typeOf(position, scope))) analysis.indexes.add(child);
    });
  };

  const statement = (item: IrStatement, scope: Scope): void => {
    for (const value of ownExpressions(item)) findIndexes(value, scope);
    switch (item.kind) {
      case "let": {
        const fixed = item.type === undefined ? undefined : parseAnnotation(item.type);
        const declared = binding(item, item.name, item, fixed);
        let initial = typeOf(item.value, scope);
        if (declared.integer && isText(initial)) {
          conflict(
            declared,
            item,
            `Groovy stored a one-character text in the int '${item.name}' as its character code ("3" became 51) and failed for longer text; convert the value explicitly`,
            true,
            "SX_INTEGER_FROM_TEXT",
          );
          return;
        }
        if (declared.integer && needsInteger(initial)) {
          if (item.maybeText === true && nonNull(initial).kind === "unknown")
            analysis.textIntegers.add(item);
          // Groovy stores a whole number in an integer variable; a `loadInteger()` read is declared and checked, and
          // other reads may hold a fraction that Groovy truncated.
          if (item.value.kind === "load" && item.value.integer === true && fixed === undefined)
            analysis.integerLoads.add(item);
          else analysis.truncations.add(item);
          initial = scalar("integer");
        }
        declared.initial = declared.placeholder ?? initial;
        if (fixed !== undefined) store(declared, initial, item);
        scope.names.set(item.name, declared);
        return;
      }
      case "assign": {
        const value = typeOf(item.value, scope);
        if (item.target.kind === "index" && item.target.target.kind === "variable") {
          const list = scope.resolve(item.target.target.name);
          if (list !== undefined && item.operator === "=") storeElement(list, value, item);
          return;
        }
        if (item.target.kind !== "variable") return;
        const target = scope.resolve(item.target.name);
        if (target === undefined) return;
        const type = bindingType(target);
        if (item.operator === "=") {
          if (target.integer && isText(value)) {
            conflict(
              target,
              item,
              `Groovy stored a one-character text in the int '${target.name}' as its character code ("3" became 51) and failed for longer text; convert the value explicitly`,
              true,
              "SX_INTEGER_FROM_TEXT",
            );
            return;
          }
          if (target.integer && needsInteger(value)) {
            analysis.truncations.add(item);
            if (item.maybeText === true && nonNull(value).kind === "unknown")
              analysis.textIntegers.add(item);
            return store(target, scalar("integer"), item);
          }
          const list = type === undefined ? undefined : nonNull(type);
          if (item.value.kind === "list" && list?.kind === "list") {
            // Like the compiler, a list literal is checked element by element against a known element type.
            for (const element of item.value.items)
              storeElement(target, typeOf(element, scope), item);
            return;
          }
          return store(target, value, item);
        }
        const current = type ?? (target.integer ? scalar("integer") : UNKNOWN);
        const result = arithmeticType(item.operator === "+=" ? "+" : "-", current, value);
        if (
          result === undefined &&
          item.operator === "+=" &&
          nonNull(current).kind === "list" &&
          value.kind !== "null"
        ) {
          // Groovy `list += other` appended the elements of a list or range, or else one value; a value that may be
          // either cannot be converted.
          const appended = nonNull(value);
          if (value.kind === "optional" || appended.kind === "unknown") {
            conflict(
              target,
              item,
              `Groovy '+=' appended to the list '${target.name}' either the elements of a list or one value, and the type of this value is not proven; convert it manually`,
              true,
              "SX_LIST_CONCATENATION",
            );
            return;
          }
          analysis.appends.set(item, appended.kind === "list" || appended.kind === "range");
          return;
        }
        // Groovy `text += value` appended the value's text, whatever its type.
        if (item.operator === "+=" && current.kind === "scalar" && current.name === "string") {
          analysis.textAppends.add(item);
          return;
        }
        if (
          target.integer &&
          (result === undefined ? nonNull(value).kind === "unknown" : needsInteger(result))
        ) {
          analysis.truncations.add(item);
          return;
        }
        if (result === undefined) {
          if (nonNull(current).kind !== "unknown" && nonNull(value).kind !== "unknown")
            conflict(
              target,
              item,
              `'${target.name}' holds ${describeValue(current)}, so ${describeValue(value)} cannot be ${item.operator === "+=" ? "added to" : "subtracted from"} it; TeaseScript '${item.operator}' only works on numbers and durations`,
              true,
            );
          return;
        }
        if (type !== undefined && result !== undefined) store(target, result, item);
        return;
      }
      case "expression": {
        const value = item.expression;
        if (
          value.kind === "methodCall" &&
          value.name === "add" &&
          value.arguments.length === 1 &&
          value.target.kind === "variable" &&
          value.dict !== true
        ) {
          const list = scope.resolve(value.target.name);
          if (list !== undefined) storeElement(list, typeOf(value.arguments[0]!, scope), item);
        }
        return;
      }
      case "function":
        functions.push(item);
        return;
      case "return":
        returns?.push(item.value === null ? NULL : typeOf(item.value, scope));
        return;
      case "if": {
        // The question of a legacy input needs no null test where the variable can never hold null, or where the
        // statement before has just stored a value that is never null in it.
        const before: IrStatement | null = preceding;
        const tested = item.condition.kind === "binary" ? item.condition.left : null;
        const neverNull = (type: TeaseType): boolean =>
          !["unknown", "null", "optional"].includes(type.kind);
        if (item.guard === "prompt" && tested?.kind === "variable") {
          const assigned =
            before !== null &&
            before.kind === "assign" &&
            before.operator === "=" &&
            before.target.kind === "variable" &&
            before.target.name === tested.name &&
            neverNull(typeOf(before.value, scope));
          if (assigned || neverNull(typeOf(tested, scope))) analysis.unguarded.add(item);
        }
        block(item.then, scope);
        block(item.else, scope);
        return;
      }
      case "while":
      case "repeat":
        block(item.body, scope);
        return;
      case "for": {
        const inner = new Scope(scope);
        const variable = binding(item, item.variable, null, UNKNOWN);
        // The collection's element type may widen between rounds; a dict loop visits its text keys.
        variable.fixed =
          item.dict === true
            ? scalar("string")
            : (elementType(typeOf(item.collection, scope)) ?? UNKNOWN);
        inner.names.set(item.variable, variable);
        for (const child of item.body) statement(child, inner);
        return;
      }
      case "switch":
        for (const switchCase of item.cases) block(switchCase.body, scope);
        block(item.default, scope);
        return;
      case "playAudio":
        if (item.handle !== undefined)
          scope.names.set(item.handle, binding(item, item.handle, null, { kind: "handle" }));
        return;
      default:
        return;
    }
  };

  /** `list.add(value)` and `list[i] = value` keep a list's element type. */
  const storeElement = (list: Binding, value: TeaseType, item: IrStatement): void => {
    const type = bindingType(list);
    const collection = type === undefined ? undefined : nonNull(type);
    if (collection?.kind !== "list" || nonNull(value).kind === "unknown") return;
    // A list that starts empty takes its element type from its first element (ADR 0021 rule 1.3), so an element that
    // holds several types needs that union written on the declaration.
    if (
      collection.element.kind === "unknown" &&
      list.declaration !== null &&
      list.fixed === undefined &&
      list.union === undefined &&
      hasUnion(value) &&
      annotation(listOf(value)) !== null
    )
      return change(() => (list.union = listOf(value)));
    if (isAssignable(collection.element, value)) return;
    if (list.declaration !== null && canWiden(collection.element, value) && !list.widened)
      return change(() => (list.widened = true));
    const element =
      list.declaration !== null && list.fixed === undefined
        ? unionOf(collection.element, value)
        : null;
    if (element !== null) return change(() => (list.union = listOf(element)));
    conflict(
      list,
      item,
      `'${list.name}' holds ${typeName(collection.element)} values (${typeName(collection)}), but later gets ${describeValue(value)}`,
    );
  };

  // The statement before the one being walked in its block, apart from comments: a prompt guard right after an
  // assignment of a value that is never null tests nothing.
  let preceding: IrStatement | null = null;
  const walk = (items: readonly IrStatement[], scope: Scope): void => {
    let last: IrStatement | null = null;
    for (const item of items) {
      preceding = last;
      statement(item, scope);
      if (item.kind !== "comment" && item.kind !== "blank") last = item;
    }
  };
  const block = (items: IrStatement[], outer: Scope): void => walk(items, new Scope(outer));

  walk(statements, root);
  // Functions see every package global, also those declared after them.
  for (const item of functions) {
    const scope = new Scope(root);
    item.parameters.forEach((parameter: IrFunctionParameter) => {
      scope.names.set(parameter.name, binding(parameter, parameter.name, null, UNKNOWN));
    });
    returns = [];
    walk(item.body, scope);
    // A function that may end without `return` may return nothing (#526: an optional result).
    if (
      item.body.findLast((child) => child.kind !== "comment" && child.kind !== "blank")?.kind !==
      "return"
    )
      returns.push(NULL);
    analysis.results.set(item.name, resultType(returns));
    returns = null;
  }
  return analysis;
}

/** The statements with each of the `guards` replaced by its `then` statements. */
function withoutGuards(items: IrStatement[], guards: ReadonlySet<IrStatement>): IrStatement[] {
  if (guards.size === 0) return items;
  return items.flatMap((statement): IrStatement[] => {
    if (guards.has(statement) && statement.kind === "if")
      return withoutGuards(statement.then, guards);
    switch (statement.kind) {
      case "function":
        return [{ ...statement, body: withoutGuards(statement.body, guards) }];
      case "if":
        return [
          {
            ...statement,
            then: withoutGuards(statement.then, guards),
            else: withoutGuards(statement.else, guards),
          },
        ];
      case "while":
      case "repeat":
      case "for":
        return [{ ...statement, body: withoutGuards(statement.body, guards) }];
      case "switch":
        return [
          {
            ...statement,
            cases: statement.cases.map((item) => ({
              ...item,
              body: withoutGuards(item.body, guards),
            })),
            default: withoutGuards(statement.default, guards),
          },
        ];
      default:
        return [statement];
    }
  });
}

/** Names of the variables the program compares with null (`x == null`, `x != null`). */
function nullTestedNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) nullTestedNames(item, names);
    return names;
  }
  if (!isRecord(value)) return names;
  if (value.kind === "binary" && (value.operator === "==" || value.operator === "!=")) {
    for (const [side, other] of [
      [value.left, value.right],
      [value.right, value.left],
    ]) {
      if (
        isRecord(side) &&
        side.kind === "variable" &&
        typeof side.name === "string" &&
        isRecord(other) &&
        other.kind === "literal" &&
        other.value === null
      )
        names.add(side.name);
    }
  }
  for (const child of Object.values(value)) nullTestedNames(child, names);
  return names;
}

/** The type a variable keeps, or undefined when the compiler does not check it (a null or unknown initializer). */
function bindingType(binding: Binding): TeaseType | undefined {
  let type =
    (binding.union !== undefined && binding.initial.kind === "null"
      ? ({ kind: "optional", value: binding.union } satisfies TeaseType)
      : binding.union) ??
    binding.fixed ??
    (binding.initial.kind === "null" && binding.inferred !== undefined
      ? { kind: "optional", value: nonNull(binding.inferred) }
      : binding.initial.kind === "unknown" || binding.initial.kind === "null"
        ? undefined
        : binding.initial);
  if (type === undefined || type.kind === "unknown" || nonNull(type).kind === "unknown")
    return undefined;
  if (binding.widened) type = widen(type);
  if (binding.optional && type.kind !== "optional") type = { kind: "optional", value: type };
  return type;
}

function widen(type: TeaseType): TeaseType {
  if (type.kind === "optional") return { kind: "optional", value: widen(type.value) };
  if (type.kind === "scalar" && type.name === "integer") return scalar("number");
  if (type.kind === "list") return listOf(widen(type.element));
  return type;
}

/** Whether `integer` → `number` (also as a list element type) makes `value` assignable. */
function canWiden(type: TeaseType, value: TeaseType): boolean {
  const widened = widen(type);
  return typeName(widened) !== typeName(type) && isAssignable(widened, value);
}

/** Whether a value stored in a Groovy integer variable needs truncation: it is not known to be a whole number. */
function needsInteger(type: TeaseType): boolean {
  const value = nonNull(type);
  return value.kind === "unknown" || (value.kind === "scalar" && value.name === "number");
}

/**
 * A function's result from its `return` values: one shared type, optional when it may return nothing, and unknown
 * when the values disagree or are not known.
 */
function resultType(returns: readonly TeaseType[]): TeaseType {
  const values = returns.filter((type) => type.kind !== "null");
  if (values.length === 0) return NULL;
  const shared = sharedValueType(values.map(nonNull));
  if (shared.kind === "unknown") return UNKNOWN;
  return values.length < returns.length || values.some((type) => type.kind === "optional")
    ? { kind: "optional", value: shared }
    : shared;
}

/** The empty value a placeholder of this type starts with: an empty list, false, or 0; null for other types. */
function emptyValue(type: TeaseType): IrExpression | null {
  if (type.kind === "list") return { kind: "list", items: [] };
  if (type.kind !== "scalar") return null;
  if (type.name === "boolean") return { kind: "literal", value: false };
  return type.name === "integer" || type.name === "number" ? { kind: "literal", value: 0 } : null;
}

function isText(type: TeaseType): boolean {
  const value = nonNull(type);
  return value.kind === "scalar" && value.name === "string";
}

function isNumber(type: TeaseType): boolean {
  const value = nonNull(type);
  return value.kind === "scalar" && value.name === "number";
}

function nonNull(type: TeaseType): TeaseType {
  return type.kind === "optional" ? type.value : type;
}

/**
 * Mirrors the compiler's isAssignable: only integer widens, to number, and a value that may be null fits only a place
 * that takes null (ADR 0021 rule 1.9).
 */
export function isAssignable(target: TeaseType, source: TeaseType): boolean {
  if (target.kind === "unknown" || source.kind === "unknown") return true;
  if (target.kind === "optional")
    return source.kind === "null" || isAssignable(target.value, nonNull(source));
  if (source.kind === "optional") return false;
  if (source.kind === "union")
    return source.members.every((member) => isAssignable(target, member));
  if (target.kind === "union") return target.members.some((member) => isAssignable(member, source));
  switch (target.kind) {
    case "null":
      return source.kind === "null";
    case "scalar":
      return (
        source.kind === "scalar" &&
        (source.name === target.name || (target.name === "number" && source.name === "integer"))
      );
    case "list":
      return source.kind === "list" && isAssignable(target.element, source.element);
    case "temporal":
      return source.kind === "temporal" && source.name === target.name;
    default:
      return source.kind === target.kind;
  }
}

/** The annotation that declares `type`, or null when TeaseScript cannot write it (V30 §12). */
function annotation(type: TeaseType): string | null {
  const value = nonNull(type);
  const writable =
    value.kind === "scalar" ||
    (value.kind === "list" && value.element.kind === "scalar") ||
    (value.kind === "union" && value.members.every(isWritableMember)) ||
    (value.kind === "list" && hasUnion(value) && writableElements(value.element));
  return writable ? typeName(type) : null;
}

/** Whether a list's elements, possibly lists themselves, end in scalars or unions an annotation can name. */
function writableElements(type: TeaseType): boolean {
  if (type.kind === "list") return writableElements(type.element);
  return type.kind === "scalar" || (type.kind === "union" && type.members.every(isWritableMember));
}

/** Whether a type is or contains a union, as the element type of a list of lists may. */
function hasUnion(type: TeaseType): boolean {
  const value = nonNull(type);
  return value.kind === "union" || (value.kind === "list" && hasUnion(value.element));
}

/** A type a union annotation can name: a scalar, a list of scalars, any list (`list`), or any object (`object`). */
function isWritableMember(type: TeaseType): boolean {
  return (
    type.kind === "scalar" ||
    type.kind === "object" ||
    (type.kind === "list" && (type.element.kind === "scalar" || type.element.kind === "unknown"))
  );
}

/**
 * The union of two types that an annotation can write, such as `string | string[]`, or null. Integers and numbers
 * together are numbers.
 */
function unionOf(left: TeaseType, right: TeaseType): TeaseType | null {
  const members: TeaseType[] = [];
  for (const type of [nonNull(left), nonNull(right)]) {
    for (const member of type.kind === "union" ? type.members : [type]) {
      if (!isWritableMember(member)) return null;
      const index = members.findIndex(
        (known) => isAssignable(known, member) || isAssignable(member, known),
      );
      if (index < 0) members.push(member);
      else if (isAssignable(member, members[index]!)) members[index] = member;
    }
  }
  return members.length < 2 ? null : { kind: "union", members };
}

function parseAnnotation(text: string): TeaseType {
  const optional = text.endsWith("?");
  const core = optional ? text.slice(0, -1) : text;
  const list = core.endsWith("[]");
  const name = list ? core.slice(0, -2) : core;
  const scalarName = SCALAR_NAMES.find((candidate) => candidate === name);
  const base: TeaseType = scalarName === undefined ? UNKNOWN : scalar(scalarName);
  const value = list ? listOf(base) : base;
  return optional ? { kind: "optional", value } : value;
}

function typeName(type: TeaseType): string {
  switch (type.kind) {
    case "scalar":
      return type.name;
    case "list":
      return type.element.kind === "unknown"
        ? "list"
        : type.element.kind === "union"
          ? `(${typeName(type.element)})[]`
          : `${typeName(type.element)}[]`;
    case "optional":
      return type.value.kind === "union"
        ? `${typeName(type.value)} | null`
        : `${typeName(type.value)}?`;
    case "union":
      return type.members.map(typeName).join(" | ");
    case "temporal":
      return type.name;
    default:
      return type.kind;
  }
}

function describeValue(type: TeaseType): string {
  switch (type.kind) {
    case "scalar":
      return {
        string: "text (string)",
        integer: "a whole number (integer)",
        number: "a number",
        boolean: "true or false (boolean)",
        duration: "a duration",
      }[type.name];
    case "list":
      return type.element.kind === "unknown" ? "a list" : `a list (${typeName(type)})`;
    case "optional":
      return `${describeValue(type.value)} or null`;
    case "union":
      return type.members.map(describeValue).join(" or ");
    case "null":
      return "null";
    case "object":
      return "an object";
    case "dict":
      return "a dict";
    case "range":
      return "a range";
    case "handle":
      return "a media handle";
    case "temporal":
      return `a ${type.name}`;
    case "unknown":
      return "an unknown value";
  }
}

function elementType(type: TeaseType): TeaseType | undefined {
  const value = nonNull(type);
  if (value.kind === "list") return value.element;
  if (value.kind === "range") return scalar("integer");
  return undefined;
}

const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

/** Integer arithmetic stays integer except `/`; durations combine as V30 §35 defines. */
function arithmeticType(
  operator: string,
  leftType: TeaseType,
  rightType: TeaseType,
): TeaseType | undefined {
  const left = nonNull(leftType);
  const right = nonNull(rightType);
  if (left.kind !== "scalar" || right.kind !== "scalar") return undefined;
  const numeric = (name: ScalarName): boolean => name === "integer" || name === "number";
  if (numeric(left.name) && numeric(right.name)) {
    return left.name === "integer" && right.name === "integer" && operator !== "/"
      ? scalar("integer")
      : scalar("number");
  }
  if (left.name === "duration" && right.name === "duration") {
    if (operator === "+" || operator === "-") return scalar("duration");
    if (operator === "/") return scalar("number");
    return undefined;
  }
  if (left.name === "duration" && numeric(right.name) && (operator === "*" || operator === "/"))
    return scalar("duration");
  if (numeric(left.name) && right.name === "duration" && operator === "*")
    return scalar("duration");
  return undefined;
}

/**
 * The element type of a list literal: the common type, or a union that a declaration can write when Groovy mixed
 * types, such as `(number | boolean)` (ADR 0021 rule 1.3).
 */
function elementsType(types: readonly TeaseType[]): TeaseType {
  const common = commonType(types);
  if (
    common.kind !== "unknown" ||
    types.length === 0 ||
    !types.every((type) => type.kind === "scalar" || type.kind === "list")
  )
    return common;
  // Lists of lists keep their elements' list type, such as `(string | integer)[]` for Groovy pairs.
  let merged: TeaseType | null = types[0]!;
  for (const type of types.slice(1)) {
    if (merged === null) return UNKNOWN;
    if (isAssignable(merged, type)) continue;
    merged = isAssignable(type, merged) ? type : unionOf(merged, type);
  }
  return merged ?? UNKNOWN;
}

/** One element type for all elements; integers and numbers together are numbers. Anything else is unknown. */
function commonType(types: readonly TeaseType[]): TeaseType {
  let common: TeaseType | undefined;
  for (const type of types) {
    if (type.kind !== "scalar") return UNKNOWN;
    if (common === undefined || isAssignable(type, common)) common = type;
    else if (!isAssignable(common, type)) return UNKNOWN;
  }
  return common ?? UNKNOWN;
}

/** The value type `choose` returns: all values share one type, integers and numbers together are numbers. */
function sharedValueType(types: readonly TeaseType[]): TeaseType {
  const numeric = (type: TeaseType): boolean =>
    type.kind === "scalar" && (type.name === "integer" || type.name === "number");
  let shared: TeaseType | undefined;
  for (const type of types) {
    if (type.kind === "unknown") return UNKNOWN;
    if (shared === undefined || typeName(shared) === typeName(type)) shared ??= type;
    else if (numeric(shared) && numeric(type)) shared = scalar("number");
    else return UNKNOWN;
  }
  return shared ?? UNKNOWN;
}

const TEXT_RESULTS = new Map<string, TeaseType>([
  ["contains", scalar("boolean")],
  ["startsWith", scalar("boolean")],
  ["endsWith", scalar("boolean")],
  ["indexOf", scalar("integer")],
  ["lastIndexOf", scalar("integer")],
  ["substring", scalar("string")],
  ["replace", scalar("string")],
  ["trim", scalar("string")],
  ["trimStart", scalar("string")],
  ["trimEnd", scalar("string")],
  ["uppercase", scalar("string")],
  ["lowercase", scalar("string")],
  ["uppercaseFirst", scalar("string")],
  ["repeat", scalar("string")],
  ["padStart", scalar("string")],
  ["padEnd", scalar("string")],
  ["split", listOf(scalar("string"))],
]);

/** The current-time getters of #532 and what they return. */
const TEMPORAL_GETTERS = new Map<string, "date" | "time" | "datetime" | "timestamp">([
  ["getDate", "date"],
  ["getTime", "time"],
  ["getDateTime", "datetime"],
  ["getTimestamp", "timestamp"],
]);

/** Members of a dict (#536). */
const DICT_MEMBERS = new Map<string, TeaseType>([
  ["length", scalar("integer")],
  ["keys", listOf(scalar("string"))],
  ["values", listOf(UNKNOWN)],
]);

const TEMPORAL_FIELDS = new Map<string, TeaseType>([
  ...["year", "month", "day", "hour", "minute", "second", "millisecond", "weekdayNumber"].map(
    (name): [string, TeaseType] => [name, scalar("integer")],
  ),
  ["weekday", scalar("string")],
]);

const TEMPORAL_RESULTS = new Map<string, TeaseType>([
  ["toSeconds", scalar("integer")],
  ["toMilliseconds", scalar("integer")],
  ["toISO", scalar("string")],
  ["formatDate", scalar("string")],
  ["formatTime", scalar("string")],
  ["formatDateTime", scalar("string")],
]);

const CALL_RESULTS = new Map<string, TeaseType>([
  ["random", scalar("number")],
  ["randomInteger", scalar("integer")],
  ["chance", scalar("boolean")],
  ["round", scalar("integer")],
  ["floor", scalar("integer")],
  ["ceil", scalar("integer")],
  ["toInteger", scalar("integer")],
  ["toNumber", scalar("number")],
  ["toString", scalar("string")],
  ["toBoolean", scalar("boolean")],
  ["askInteger", scalar("integer")],
  ["askBoolean", scalar("boolean")],
  ["showButton", scalar("duration")],
]);

export function expressionType(
  value: IrExpression,
  variable: (name: string) => TeaseType,
  result: (name: string) => TeaseType | undefined = () => undefined,
): TeaseType {
  const type = (child: IrExpression): TeaseType => expressionType(child, variable, result);
  switch (value.kind) {
    case "literal":
      if (value.value === null) return NULL;
      if (typeof value.value === "string") return scalar("string");
      if (typeof value.value === "boolean") return scalar("boolean");
      // The emitted literal is an integer when it has neither a decimal point nor an exponent.
      return scalar(/^-?\d+$/u.test(String(value.value)) ? "integer" : "number");
    case "duration":
    case "button":
      return scalar("duration");
    case "template":
      return scalar("string");
    case "variable":
      return variable(value.name);
    case "list":
      return listOf(elementsType(value.items.map(type)));
    case "object":
      return { kind: value.dict === true ? "dict" : "object" };
    case "index": {
      if (value.dict === true) return UNKNOWN;
      const target = nonNull(type(value.target));
      return target.kind === "list" ? target.element : UNKNOWN;
    }
    case "property": {
      if (value.dict === true) return DICT_MEMBERS.get(value.name) ?? UNKNOWN;
      // `(date - date).days` counts whole calendar days (#532).
      if (value.name === "days" && value.target.kind === "binary" && value.target.operator === "-")
        return scalar("integer");
      const target = nonNull(type(value.target));
      if (target.kind === "temporal") return TEMPORAL_FIELDS.get(value.name) ?? UNKNOWN;
      if (target.kind === "list") {
        if (value.name === "length") return scalar("integer");
        return ["first", "last", "random"].includes(value.name) ? target.element : UNKNOWN;
      }
      if (target.kind === "scalar" && target.name === "string" && value.name === "length")
        return scalar("integer");
      return UNKNOWN;
    }
    case "methodCall": {
      if (value.dict === true) {
        if (value.name === "contains") return scalar("boolean");
        // `get(key, default: value)` reads a value of the default's type (#536).
        return value.name === "get" && value.arguments.length === 2
          ? type(value.arguments[1]!)
          : UNKNOWN;
      }
      const target = nonNull(type(value.target));
      if (target.kind === "list") {
        if (["removeAt", "removeFirst", "removeLast"].includes(value.name)) return target.element;
        if (value.name === "contains") return scalar("boolean");
        if (value.name === "join") return scalar("string");
        return UNKNOWN;
      }
      if (target.kind === "scalar" && target.name === "string")
        return TEXT_RESULTS.get(value.name) ?? UNKNOWN;
      if (target.kind === "temporal") return TEMPORAL_RESULTS.get(value.name) ?? UNKNOWN;
      return UNKNOWN;
    }
    case "load":
      // A read with a default has the default's type (#541); without one, a missing key reads null.
      return value.defaultValue === undefined
        ? { kind: "optional", value: UNKNOWN }
        : type(value.defaultValue);
    case "choice":
      // Numeric choice values are integers (#515).
      return scalar(value.labels === undefined ? "integer" : "string");
    case "listChoice": {
      const values: TeaseType[] = [];
      for (const option of value.options) {
        if (option.kind === "option") {
          values.push(
            option.value !== null ? scalar("integer") : choiceEntryType(type(option.text)),
          );
          continue;
        }
        const list = nonNull(type(option.list));
        values.push(list.kind === "list" ? choiceEntryType(list.element) : UNKNOWN);
      }
      return sharedValueType(values);
    }
    case "input":
      return scalar(
        value.input === "askText" ? "string" : value.input === "askInteger" ? "integer" : "number",
      );
    case "range":
      return { kind: "range" };
    case "unary": {
      if (value.operator === "not") return scalar("boolean");
      const operand = nonNull(type(value.value));
      return operand.kind === "scalar" &&
        (operand.name === "integer" || operand.name === "number" || operand.name === "duration")
        ? operand
        : UNKNOWN;
    }
    case "binary":
      if (!ARITHMETIC.has(value.operator)) return scalar("boolean");
      return arithmeticType(value.operator, type(value.left), type(value.right)) ?? UNKNOWN;
    case "call": {
      // A function of the package returns what its `return` values share.
      const local = result(value.name);
      if (local !== undefined) return local;
      if (value.local === true) return UNKNOWN;
      const temporal = TEMPORAL_GETTERS.get(value.name);
      if (temporal !== undefined) return { kind: "temporal", name: temporal };
      return CALL_RESULTS.get(value.name) ?? UNKNOWN;
    }
  }
}

/** A choice object's value type is not known from its type alone. */
function choiceEntryType(type: TeaseType): TeaseType {
  return nonNull(type).kind === "object" ? UNKNOWN : type;
}

/** The expressions a statement evaluates itself, not those of the statements it contains. */
function ownExpressions(statement: IrStatement): IrExpression[] {
  switch (statement.kind) {
    case "let":
    case "say":
    case "return":
      return "value" in statement && statement.value !== null ? [statement.value] : [];
    case "assign":
      return [statement.target, statement.value];
    case "expression":
      return [statement.expression];
    case "if":
    case "while":
      return [statement.condition];
    case "repeat":
      return [statement.count];
    case "for":
      return [statement.collection];
    case "save":
      return [statement.key, statement.value];
    case "wait":
      return [statement.duration];
    case "showButton":
      return statement.timeout === null ? [statement.label] : [statement.label, statement.timeout];
    case "showPopup":
      return [statement.message];
    case "showImage":
      return [statement.file];
    case "playAudio":
      return statement.repeatCount === null
        ? [statement.file]
        : [statement.file, statement.repeatCount];
    case "switch":
      return [statement.value, ...statement.cases.flatMap((item) => item.matches)];
    case "goto":
      return statement.target.kind === "file" ? [] : [statement.target.path];
    case "delete":
      return [statement.key];
    default:
      return [];
  }
}

/** Calls `visit` on an expression and every expression inside it. */
function forEachExpression(value: IrExpression, visit: (expression: IrExpression) => void): void {
  visit(value);
  mapChildren(value, (child) => {
    forEachExpression(child, visit);
    return child;
  });
}

/** Truncates the recorded list positions inside a statement's own expressions with `toInteger`. */
function withIntegerIndexes<T extends IrStatement>(
  statement: T,
  indexes: ReadonlySet<IrExpression>,
): T {
  if (indexes.size === 0) return statement;
  const truncated = (position: IrExpression): IrExpression => ({
    kind: "call",
    name: "toInteger",
    positional: [position],
    named: {},
  });
  const replace = (value: IrExpression): IrExpression => {
    const copy = mapChildren(value, replace);
    if (!indexes.has(value)) return copy;
    if (copy.kind === "index") return { ...copy, index: truncated(copy.index) };
    if (copy.kind === "methodCall") return { ...copy, arguments: [truncated(copy.arguments[0]!)] };
    return copy;
  };
  return mapOwnExpressions(statement, replace);
}

/** A copy of a statement with `map` applied to each expression it evaluates itself (see ownExpressions). */
function mapOwnExpressions<T extends IrStatement>(
  statement: T,
  map: (value: IrExpression) => IrExpression,
): T {
  const item: IrStatement = statement;
  const next: IrStatement = (() => {
    switch (item.kind) {
      case "let":
      case "say":
        return { ...item, value: map(item.value) };
      case "return":
        return { ...item, value: item.value === null ? null : map(item.value) };
      case "assign":
        return { ...item, target: map(item.target), value: map(item.value) };
      case "expression":
        return { ...item, expression: map(item.expression) };
      case "if":
      case "while":
        return { ...item, condition: map(item.condition) };
      case "repeat":
        return { ...item, count: map(item.count) };
      case "for":
        return { ...item, collection: map(item.collection) };
      case "save":
        return { ...item, key: map(item.key), value: map(item.value) };
      case "wait":
        return { ...item, duration: map(item.duration) };
      case "showButton":
        return {
          ...item,
          label: map(item.label),
          timeout: item.timeout === null ? null : map(item.timeout),
        };
      case "showPopup":
        return { ...item, message: map(item.message) };
      case "showImage":
        return { ...item, file: map(item.file) };
      case "playAudio":
        return {
          ...item,
          file: map(item.file),
          repeatCount: item.repeatCount === null ? null : map(item.repeatCount),
        };
      case "switch":
        return {
          ...item,
          value: map(item.value),
          cases: item.cases.map((switchCase) => ({
            ...switchCase,
            matches: switchCase.matches.map(map),
          })),
        };
      case "goto":
        return item.target.kind === "file"
          ? item
          : { ...item, target: { kind: "script", path: map(item.target.path) } };
      case "delete":
        return { ...item, key: map(item.key) };
      default:
        return item;
    }
  })();
  // EVIDENCE: each case spreads `item`, so `next` has the kind and fields of `statement` with expressions replaced.
  return next as T;
}

/** A copy of an expression with `map` applied to each direct child expression. */
function mapChildren(
  value: IrExpression,
  map: (child: IrExpression) => IrExpression,
): IrExpression {
  switch (value.kind) {
    case "literal":
    case "variable":
    case "duration":
      return value;
    case "list":
      return { ...value, items: value.items.map(map) };
    case "object":
      return {
        ...value,
        properties: value.properties.map((property) => ({
          ...property,
          value: map(property.value),
          ...(property.key === undefined ? {} : { key: map(property.key) }),
        })),
      };
    case "index":
      return { ...value, target: map(value.target), index: map(value.index) };
    case "property":
      return { ...value, target: map(value.target) };
    case "methodCall":
      return { ...value, target: map(value.target), arguments: value.arguments.map(map) };
    case "load":
      return {
        ...value,
        key: map(value.key),
        ...(value.defaultValue === undefined ? {} : { defaultValue: map(value.defaultValue) }),
      };
    case "choice":
      return { ...value, options: value.options.map(map) };
    case "listChoice":
      return {
        ...value,
        options: value.options.map((option) =>
          option.kind === "list"
            ? { ...option, list: map(option.list) }
            : { ...option, text: map(option.text) },
        ),
      };
    case "input":
      return value.defaultValue === undefined
        ? value
        : { ...value, defaultValue: map(value.defaultValue) };
    case "range":
      return { ...value, from: map(value.from), to: map(value.to) };
    case "unary":
      return { ...value, value: map(value.value) };
    case "binary":
      return { ...value, left: map(value.left), right: map(value.right) };
    case "call":
      return {
        ...value,
        positional: value.positional.map(map),
        named: Object.fromEntries(
          Object.entries(value.named).map(([name, item]) => [name, map(item)]),
        ),
      };
    case "template":
      return {
        ...value,
        parts: value.parts.map((part) => ("text" in part ? part : { value: map(part.value) })),
      };
    case "button":
      return {
        ...value,
        label: map(value.label),
        timeout: value.timeout === null ? null : map(value.timeout),
      };
  }
}
