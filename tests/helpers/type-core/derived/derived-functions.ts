import type {
  CallArgument,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionParameter,
  Statement,
} from "../../../../src/ast.js";
import { nestedStatements } from "../../../../src/expression-children.js";
import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import {
  type DerivedStore,
  type Syntax,
  Underivable,
  site,
  unwrap,
  writtenType,
} from "./type-core-derived.js";
import { fitsType } from "./type-core-derived-values.js";

/*
 * The derived oracle's author functions (#2667, step 4a-0): what a call of a function the script declares does by the
 * rules, and where the plan checks a value stored into one of its places. A call evaluates its arguments in source
 * order, then checks each one stored into a parameter with a written type (TSR058 at the argument's value), then binds
 * the parameters, then evaluates in parameter order the default of each one no argument supplies, checking it against
 * the parameter's written type, then runs the body; a `return` checks its value against the function's written result
 * type and ends the call with it, and a body that ends without one gives `null` (V30 §10, §11, §17;
 * `src/runtime/instructions/functions.ts`). A function sees its parameters, its own variables and its file's (V30 §14),
 * which the oracle keeps in one map: a call binds its own names for the call and gives back the caller's after it. Like
 * `evaluate`, it reads the sources and the derived stores, never the plan.
 *
 * Only a value stored into a place with a written type is a store here (`transferStore`): an obligation at an argument, a
 * default or a returned value of an untyped parameter or result is underivable, since the candidate route publishes no
 * check there.
 */

/** A value as `evaluate` reads it: the runtime value, and the host globals it came from. */
export interface FunctionValue {
  readonly v: SerializableRuntimeValue;
  readonly from: ReadonlySet<string>;
}

/** The functions a file's calls may name: its own, and every file's `global function`. */
export function visibleFunctions(
  own: readonly Statement[],
  project: readonly Syntax[] = [],
): ReadonlyMap<string, FunctionDeclaration> {
  const found = new Map<string, FunctionDeclaration>();
  for (const file of project)
    for (const statement of file.statements)
      if (statement.kind === "functionDeclaration" && statement.global)
        found.set(statement.name.name, statement);
  for (const statement of own)
    if (statement.kind === "functionDeclaration") found.set(statement.name.name, statement);
  return found;
}

/** The function an author call names, or `undefined` for any other call. */
function calleeOf(
  call: CallExpression,
  functions: ReadonlyMap<string, FunctionDeclaration>,
): FunctionDeclaration | undefined {
  const callee = unwrap(call.callee);
  return callee.kind === "identifier" ? functions.get(callee.name) : undefined;
}

/** The parameter an argument fills: by its name, or by its place among the positional ones. */
function parameterOf(
  fn: FunctionDeclaration,
  call: CallExpression,
  argument: CallArgument,
): FunctionParameter {
  const parameter =
    argument.kind === "namedArgument"
      ? fn.parameters.find((candidate) => candidate.name.name === argument.name.name)
      : fn.parameters[
          call.arguments.filter((each) => each.kind === "positionalArgument").indexOf(argument)
        ];
  if (parameter === undefined)
    throw new Underivable(`an argument ${fn.name.name} has no parameter for`);
  return parameter;
}

/** The returns of a function's body, at any depth of its blocks. */
function returnsOf(fn: FunctionDeclaration): Extract<Statement, { kind: "returnStatement" }>[] {
  const found: Extract<Statement, { kind: "returnStatement" }>[] = [];
  const pending: Statement[] = [...fn.body.statements];
  for (let statement = pending.pop(); statement !== undefined; statement = pending.pop()) {
    if (statement.kind === "returnStatement") found.push(statement);
    pending.push(...nestedStatements(statement));
  }
  return found;
}

/**
 * The store at `at` (`start:end` of a stored value) where it is a value stored into a function's place: an author call's
 * argument, a parameter's default or a returned value. Its type is the place's written type; such a value into an untyped
 * parameter or result is underivable. `null` where no function's place takes the value at `at`.
 */
export function transferStore(
  at: string,
  own: Syntax,
  expressions: readonly Expression[],
  project: readonly Syntax[] = [],
): DerivedStore | null {
  const functions = visibleFunctions(own.statements, project);
  const store = (
    node: { readonly span: Expression["span"] },
    value: Expression,
    target: string,
    written: FunctionParameter["typeAnnotation"],
  ): DerivedStore => {
    if (written === null)
      throw new Underivable(`${target}: a check into a parameter or result without a written type`);
    return {
      target,
      so: node.span.start.offset,
      eo: node.span.end.offset,
      valueSo: unwrap(value).span.start.offset,
      valueEo: unwrap(value).span.end.offset,
      type: writtenType(written),
    };
  };
  for (const expression of expressions) {
    if (expression.kind !== "callExpression") continue;
    const fn = calleeOf(expression, functions);
    if (fn === undefined) continue;
    for (const argument of expression.arguments)
      if (site(unwrap(argument.value)) === at) {
        const parameter = parameterOf(fn, expression, argument);
        return store(
          argument,
          argument.value,
          `parameter '${parameter.name.name}' of '${fn.name.name}'`,
          parameter.typeAnnotation,
        );
      }
  }
  for (const fn of functions.values()) {
    for (const parameter of fn.parameters)
      if (parameter.defaultValue !== null && site(unwrap(parameter.defaultValue)) === at)
        return store(
          parameter,
          parameter.defaultValue,
          `parameter '${parameter.name.name}' of '${fn.name.name}'`,
          parameter.typeAnnotation,
        );
    for (const returned of returnsOf(fn))
      if (returned.value !== null && site(unwrap(returned.value)) === at)
        return store(
          returned,
          returned.value,
          `the result of '${fn.name.name}'`,
          fn.returnTypeAnnotation,
        );
  }
  return null;
}

/**
 * The name the analysis gives the place a store statement writes: a parameter of the function whose body holds the
 * statement is `<function>.<parameter>`; any other place keeps its own name.
 */
export function storedPlaceName(statement: Statement, name: string, own: Syntax): string {
  for (const fn of own.statements) {
    if (fn.kind !== "functionDeclaration") continue;
    if (!fn.parameters.some((parameter) => parameter.name.name === name)) continue;
    const pending: Statement[] = [...fn.body.statements];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (at === statement) return `${fn.name.name}.${name}`;
      pending.push(...nestedStatements(at));
    }
  }
  return name;
}

/** A `return` ending a call, with its value. */
class Returned {
  public constructor(readonly value: FunctionValue) {}
}

/** The deepest a call nests in the oracle's runs: deeper is underivable (the runtime's own bound is TSR047's). */
const DEPTH = 64;

/** What `evaluate` gives the calls: its reader, its statement runner, its checks and its variables. */
export interface CallContext {
  /** The evaluated file's statements. */
  readonly own: readonly Statement[];
  readonly project: readonly Syntax[];
  readonly stores: readonly DerivedStore[];
  readonly env: Map<string, FunctionValue>;
  readonly value: (expression: Expression) => FunctionValue;
  readonly run: (block: readonly Statement[]) => void;
  /** A check at `start:end` of a value from `from`: it fails with `code` unless `fits`. */
  readonly fail: (
    code: string,
    start: number,
    end: number,
    from: ReadonlySet<string>,
    fits: boolean,
  ) => void;
}

/** The author functions of one evaluation (see the module's comment). */
export interface FunctionCalls {
  /** The value of `call` where it names an author function, else `undefined`. */
  call(call: CallExpression): FunctionValue | undefined;
  /** Whether `statement` is a function's own, run here: a declaration (nothing runs) or a `return` (ends the call). */
  statement(statement: Statement): boolean;
}

export function functionCalls(context: CallContext): FunctionCalls {
  const functions = visibleFunctions(context.own, context.project);
  const { env, stores, fail, value } = context;
  // (a store's check at its value, where the derived stores hold one for the node at `node`)
  const checked = (node: { readonly span: Expression["span"] }, stored: FunctionValue): void => {
    const store = stores.find(
      (candidate) =>
        candidate.so === node.span.start.offset && candidate.eo === node.span.end.offset,
    );
    if (store !== undefined)
      fail("TSR058", store.valueSo, store.valueEo, stored.from, fitsType(stored.v, store.type));
  };
  let depth = 0;
  return {
    call(call) {
      const fn = calleeOf(call, functions);
      if (fn === undefined) return undefined;
      const supplied = call.arguments.map((argument) => {
        const read = value(argument.value);
        return {
          argument,
          parameter: parameterOf(fn, call, argument),
          value: { v: structuredClone(read.v), from: read.from },
        };
      });
      for (const { argument, value: given } of supplied) checked(argument, given);
      if (depth >= DEPTH) throw new Underivable(`calls nested deeper than ${DEPTH}`);
      // the call's own names: its parameters and every variable its body declares, the caller's given back after it
      const own = new Set(fn.parameters.map((parameter) => parameter.name.name));
      const pending: Statement[] = [...fn.body.statements];
      for (let statement = pending.pop(); statement !== undefined; statement = pending.pop()) {
        if (statement.kind === "letStatement") own.add(statement.name.name);
        if (statement.kind === "forStatement") {
          own.add(statement.variable.name);
          if (statement.valueVariable !== null) own.add(statement.valueVariable.name);
        }
        pending.push(...nestedStatements(statement));
      }
      const caller = new Map([...own].map((name) => [name, env.get(name)]));
      for (const name of own) env.delete(name);
      depth += 1;
      try {
        for (const { parameter, value: given } of supplied) env.set(parameter.name.name, given);
        for (const parameter of fn.parameters) {
          if (supplied.some((entry) => entry.parameter === parameter)) continue;
          if (parameter.defaultValue === null)
            throw new Underivable(
              `a call of ${fn.name.name} without its parameter ${parameter.name.name}`,
            );
          const given = value(parameter.defaultValue);
          checked(parameter, given);
          env.set(parameter.name.name, { v: structuredClone(given.v), from: given.from });
        }
        try {
          context.run(fn.body.statements);
        } catch (end) {
          if (end instanceof Returned) return end.value;
          throw end;
        }
        return { v: null, from: new Set() };
      } finally {
        depth -= 1;
        for (const [name, held] of caller)
          if (held === undefined) env.delete(name);
          else env.set(name, held);
      }
    },
    statement(statement) {
      if (statement.kind === "functionDeclaration") return true;
      if (statement.kind !== "returnStatement") return false;
      if (depth === 0) throw new Underivable("a return outside a function");
      if (statement.value === null) throw new Returned({ v: null, from: new Set() });
      const returned = value(statement.value);
      checked(statement, returned);
      throw new Returned({ v: structuredClone(returned.v), from: returned.from });
    },
  };
}
