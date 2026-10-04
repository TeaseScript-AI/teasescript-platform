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
 * Types follow the compiler (`src/static-types.ts` in the repository root) plus the accepted result types it does not
 * implement yet: text operations, `join`, conversions, and rounding (#518), list `choose` values (#515), and the
 * `showButton` elapsed duration (#513). A compact numeric `choose` keeps `main`'s `number` until PR #515 merges.
 * Values it cannot know, such as storage and function results, are not checked.
 */
export type TeaseType =
  | { kind: "unknown" }
  | { kind: "null" }
  | { kind: "scalar"; name: ScalarName }
  | { kind: "list"; element: TeaseType }
  | { kind: "optional"; value: TeaseType }
  | { kind: "object" | "range" | "handle" };

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
  /** Declarations that gained a `number` or optional type annotation. */
  annotated: number;
  /** Values truncated with `toInteger` because Groovy declared the variable with an integer type. */
  truncated: number;
  /**
   * `list += value` statements, emitted as numeric `+=` because the list was not proven while lowering, that now
   * append with the concatenation helper.
   */
  appended: IrStatement[];
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
  widened: boolean;
  optional: boolean;
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

export function enforceVariableTypes(statements: IrStatement[]): VariableTypeResult {
  const bindings = new Map<BindingKey, Binding>();
  let conflicts: Conflict[] = [];
  // Statements whose stored number truncates to an integer.
  const truncations = new Set<IrStatement>();
  let appends = new Map<IrStatement, boolean>();
  for (let round = 0; round < 50; round += 1) {
    const analysis = analyse(statements, bindings);
    conflicts = analysis.conflicts;
    appends = analysis.appends;
    for (const statement of analysis.truncations) truncations.add(statement);
    if (!analysis.changed) break;
  }
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
    annotated: 0,
    truncated: 0,
    appended: [],
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
          if (truncations.has(statement)) next = { ...next, value: truncate(next.value) };
          const type = bindingType(binding);
          const written = type === undefined ? null : annotation(type);
          if ((binding.widened || binding.optional) && written !== null) {
            result.annotated += 1;
            next = { ...next, type: written };
          }
          return next;
        }
        case "assign": {
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
          if (!truncations.has(statement)) return statement;
          if (statement.operator === "=") return { ...statement, value: truncate(statement.value) };
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
          return { ...statement, then: rewrite(statement.then), else: rewrite(statement.else) };
        case "while":
        case "repeat":
        case "for":
          return { ...statement, body: rewrite(statement.body) };
        case "switch":
          return {
            ...statement,
            cases: statement.cases.map((item) => ({ ...item, body: rewrite(item.body) })),
            default: rewrite(statement.default),
          };
        default:
          return statement;
      }
    });
  result.statements = rewrite(statements);
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
  return `${first}${where}. A TeaseScript variable keeps one type (V30 §12) and union types are not accepted yet, while Groovy let '${binding.name}' change type. Use a separate variable for the other values, or give all values one type.`;
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
  truncations: Set<IrStatement>;
  /** `list += value` statements, and whether the value is a list whose elements are appended. */
  appends: Map<IrStatement, boolean>;
}

function analyse(statements: IrStatement[], bindings: Map<BindingKey, Binding>): Analysis {
  const analysis: Analysis = {
    changed: false,
    conflicts: [],
    truncations: new Set(),
    appends: new Map(),
  };
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
        widened: false,
        optional: false,
      };
      bindings.set(key, found);
    }
    return found;
  };
  const typeOf = (value: IrExpression, scope: Scope): TeaseType =>
    expressionType(value, (name) => {
      const found = scope.resolve(name);
      return found === undefined ? UNKNOWN : (bindingType(found) ?? UNKNOWN);
    });
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
    if (value.kind === "unknown") return;
    const type = bindingType(target);
    if (type === undefined || isAssignable(type, value)) return;
    // Only a declaration can take an annotation; a loop variable keeps its element type.
    const declared = target.declaration !== null;
    if (declared && value.kind === "null" && type.kind !== "optional")
      return change(() => (target.optional = true));
    if (declared && canWiden(type, value) && !target.widened)
      return change(() => (target.widened = true));
    conflict(
      target,
      statement,
      `'${target.name}' starts as ${describeValue(type)}, but is later set to ${describeValue(value)}`,
    );
  };

  const statement = (item: IrStatement, scope: Scope): void => {
    switch (item.kind) {
      case "let": {
        const fixed = item.type === undefined ? undefined : parseAnnotation(item.type);
        const declared = binding(item, item.name, item, fixed);
        let initial = typeOf(item.value, scope);
        if (declared.integer && isNumber(initial)) {
          analysis.truncations.add(item);
          initial = scalar("integer");
        }
        declared.initial = initial;
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
          if (target.integer && isNumber(value)) {
            analysis.truncations.add(item);
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
        if (target.integer && isNumber(result)) {
          analysis.truncations.add(item);
          return;
        }
        if (type !== undefined) store(target, result, item);
        return;
      }
      case "expression": {
        const value = item.expression;
        if (
          value.kind === "methodCall" &&
          value.name === "add" &&
          value.arguments.length === 1 &&
          value.target.kind === "variable" &&
          value.proposed === undefined
        ) {
          const list = scope.resolve(value.target.name);
          if (list !== undefined) storeElement(list, typeOf(value.arguments[0]!, scope), item);
        }
        return;
      }
      case "function":
        functions.push(item);
        return;
      case "if":
        block(item.then, scope);
        block(item.else, scope);
        return;
      case "while":
      case "repeat":
        block(item.body, scope);
        return;
      case "for": {
        const inner = new Scope(scope);
        const variable = binding(item, item.variable, null, UNKNOWN);
        // The collection's element type may widen between rounds.
        variable.fixed = elementType(typeOf(item.collection, scope)) ?? UNKNOWN;
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
    if (collection?.kind !== "list" || value.kind === "unknown") return;
    if (isAssignable(collection.element, value)) return;
    if (list.declaration !== null && canWiden(collection.element, value) && !list.widened)
      return change(() => (list.widened = true));
    conflict(
      list,
      item,
      `'${list.name}' holds ${typeName(collection.element)} values (${typeName(collection)}), but later gets ${describeValue(value)}`,
    );
  };

  const block = (items: IrStatement[], outer: Scope): void => {
    const scope = new Scope(outer);
    for (const item of items) statement(item, scope);
  };

  for (const item of statements) statement(item, root);
  // Functions see every package global, also those declared after them.
  for (const item of functions) {
    const scope = new Scope(root);
    item.parameters.forEach((parameter: IrFunctionParameter) => {
      scope.names.set(parameter.name, binding(parameter, parameter.name, null, UNKNOWN));
    });
    for (const child of item.body) statement(child, scope);
  }
  return analysis;
}

/** The type a variable keeps, or undefined when the compiler does not check it (a null or unknown initializer). */
function bindingType(binding: Binding): TeaseType | undefined {
  let type =
    binding.fixed ??
    (binding.initial.kind === "unknown" || binding.initial.kind === "null"
      ? undefined
      : binding.initial);
  if (type === undefined || type.kind === "unknown") return undefined;
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

function isNumber(type: TeaseType): boolean {
  const value = nonNull(type);
  return value.kind === "scalar" && value.name === "number";
}

function nonNull(type: TeaseType): TeaseType {
  return type.kind === "optional" ? type.value : type;
}

/** Mirrors the compiler's isAssignable: only integer widens, to number. */
export function isAssignable(target: TeaseType, source: TeaseType): boolean {
  if (target.kind === "unknown" || source.kind === "unknown") return true;
  if (target.kind === "optional")
    return source.kind === "null" || isAssignable(target.value, nonNull(source));
  if (source.kind === "optional") return isAssignable(target, source.value);
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
    default:
      return source.kind === target.kind;
  }
}

/** The annotation that declares `type`, or null when TeaseScript cannot write it (V30 §12). */
function annotation(type: TeaseType): string | null {
  const value = nonNull(type);
  const writable =
    value.kind === "scalar" || (value.kind === "list" && value.element.kind === "scalar");
  return writable ? typeName(type) : null;
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
      return type.element.kind === "unknown" ? "list" : `${typeName(type.element)}[]`;
    case "optional":
      return `${typeName(type.value)}?`;
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
    case "null":
      return "null";
    case "object":
      return "an object";
    case "range":
      return "a range";
    case "handle":
      return "a media handle";
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
): TeaseType {
  const type = (child: IrExpression): TeaseType => expressionType(child, variable);
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
      return listOf(commonType(value.items.map(type)));
    case "object":
      return { kind: "object" };
    case "index": {
      if (value.proposed !== undefined) return UNKNOWN;
      const target = nonNull(type(value.target));
      return target.kind === "list" ? target.element : UNKNOWN;
    }
    case "property": {
      if (value.proposed !== undefined) return UNKNOWN;
      const target = nonNull(type(value.target));
      if (target.kind === "list") {
        if (value.name === "length") return scalar("integer");
        return ["first", "last", "random"].includes(value.name) ? target.element : UNKNOWN;
      }
      if (target.kind === "scalar" && target.name === "string" && value.name === "length")
        return scalar("integer");
      return UNKNOWN;
    }
    case "methodCall": {
      if (value.proposed !== undefined) return UNKNOWN;
      const target = nonNull(type(value.target));
      if (target.kind === "list") {
        if (["removeAt", "removeFirst", "removeLast"].includes(value.name)) return target.element;
        if (value.name === "contains") return scalar("boolean");
        if (value.name === "join") return scalar("string");
        return UNKNOWN;
      }
      if (target.kind === "scalar" && target.name === "string")
        return TEXT_RESULTS.get(value.name) ?? UNKNOWN;
      return UNKNOWN;
    }
    case "load":
      return UNKNOWN;
    case "choice":
      // PR #515 makes numeric choice values integers; until it merges, `main` types them as numbers, and a variable
      // declared from a whole number that later receives one needs `: number` there.
      return value.labels === undefined ? scalar("number") : scalar("string");
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
      return scalar(value.input === "askText" ? "string" : "number");
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
    case "call":
      if (value.local === true) return UNKNOWN;
      return CALL_RESULTS.get(value.name) ?? UNKNOWN;
  }
}

/** A choice object's value type is not known from its type alone. */
function choiceEntryType(type: TeaseType): TeaseType {
  return nonNull(type).kind === "object" ? UNKNOWN : type;
}
