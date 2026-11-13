import type {
  CallArgument,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionParameter,
  Statement,
  TypeAnnotation,
} from "../../../../src/ast.js";
import { nestedStatements } from "../../../../src/expression-children.js";
import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import {
  type DerivedContent,
  type DerivedStore,
  type Syntax,
  Underivable,
  expressions,
  unwrap,
  writtenType,
} from "./type-core-derived.js";
import { fitsType } from "./type-core-derived-values.js";

/*
 * The derived oracle's author functions (#2667, step 4a-0): what a call of a function the script declares does by the
 * rules, and where the plan checks a value stored into one of its places. A call evaluates its arguments in source
 * order, then checks each one whose store the derivation holds (TSR058 at the argument's value), then binds the
 * parameters, then evaluates in parameter order the default of each one no argument supplies, checking it where the
 * derivation holds its store, then runs the body; a `return` checks its value likewise and ends the call with it, and a
 * body that ends without one gives `null` (V30 §10, §11, §17; `src/runtime/instructions/functions.ts`). A function sees
 * its parameters, its own variables and its file's (V30 §14), which the oracle keeps in one map: a call binds its own
 * names for the call and gives back the caller's after it. Like `evaluate`, it reads the sources and the derived stores,
 * never the plan. The calling file's run reads its own stores and content by offset, so a call of another file's
 * function is underivable where the body holds an entry of either file's (its checks are the other file's).
 *
 * Only a value stored into a place with a written type is a store here (`transferStore`): an obligation at an argument, a
 * default or a returned value of an untyped parameter or result is underivable, since the candidate route publishes no
 * check there.
 */

/** A value as `evaluate` reads it: the runtime value, and the host globals it came from. */
export interface EvaluatedValue {
  readonly v: SerializableRuntimeValue;
  readonly from: ReadonlySet<string>;
}

/** The functions a file's calls may name: its own, and every file's `global function`. */
function visibleFunctions(
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

/** The statements of a function's body, at any depth of its blocks. */
function bodyOf(fn: FunctionDeclaration): Statement[] {
  const found: Statement[] = [];
  const pending: Statement[] = [...fn.body.statements];
  for (let statement = pending.pop(); statement !== undefined; statement = pending.pop()) {
    found.push(statement);
    pending.push(...nestedStatements(statement));
  }
  return found;
}

/** The returns of a function's body, at any depth of its blocks. */
function returnsOf(fn: FunctionDeclaration): Extract<Statement, { kind: "returnStatement" }>[] {
  return bodyOf(fn).filter((statement) => statement.kind === "returnStatement");
}

/**
 * The store of a check at `start:end` with the analysis' `target` where it lies in a value stored into a function's place:
 * an author call's argument, a parameter's default or a returned value, the one of the place `target` names (the
 * parameter's `<function>.<parameter>`, the result's `<function>.result`, or below it) whose value holds the site, the
 * innermost. Its type is the place's written type, checked whole; such a value into an untyped parameter or result is
 * underivable. `null` where no function's place holds the check.
 */
export function transferStore(
  check: { readonly start: number; readonly end: number; readonly target: string },
  own: Syntax,
  expressions: readonly Expression[],
  project: readonly Syntax[] = [],
): DerivedStore | null {
  const functions = visibleFunctions(own.statements, project);
  const candidates: {
    readonly node: { readonly span: Expression["span"] };
    readonly value: Expression;
    readonly place: string;
    readonly label: string;
    readonly written: FunctionParameter["typeAnnotation"];
  }[] = [];
  const parameterPlace = (fn: FunctionDeclaration, parameter: FunctionParameter) => ({
    place: `${fn.name.name}.${parameter.name.name}`,
    label: `parameter '${parameter.name.name}' of '${fn.name.name}'`,
    written: parameter.typeAnnotation,
  });
  for (const expression of expressions) {
    if (expression.kind !== "callExpression") continue;
    const fn = calleeOf(expression, functions);
    if (fn !== undefined)
      for (const argument of expression.arguments)
        candidates.push({
          node: argument,
          value: argument.value,
          ...parameterPlace(fn, parameterOf(fn, expression, argument)),
        });
  }
  // (a default or a return is a store of the file that declares the function)
  for (const fn of visibleFunctions(own.statements).values()) {
    for (const parameter of fn.parameters)
      if (parameter.defaultValue !== null)
        candidates.push({
          node: parameter,
          value: parameter.defaultValue,
          ...parameterPlace(fn, parameter),
        });
    for (const returned of returnsOf(fn))
      if (returned.value !== null)
        candidates.push({
          node: returned,
          value: returned.value,
          place: `${fn.name.name}.result`,
          label: `the result of '${fn.name.name}'`,
          written: fn.returnTypeAnnotation,
        });
  }
  const holding = candidates
    .filter(
      ({ value, place }) =>
        (check.target === place || check.target.startsWith(`${place}.`)) &&
        value.span.start.offset <= check.start &&
        check.end <= value.span.end.offset,
    )
    .sort(
      (a, b) =>
        a.value.span.end.offset -
        a.value.span.start.offset -
        (b.value.span.end.offset - b.value.span.start.offset),
    )[0];
  if (holding === undefined) return null;
  if (holding.written === null)
    throw new Underivable(
      `${holding.label}: a check into a parameter or result without a written type`,
    );
  return {
    target: holding.label,
    so: holding.node.span.start.offset,
    eo: holding.node.span.end.offset,
    valueSo: unwrap(holding.value).span.start.offset,
    valueEo: unwrap(holding.value).span.end.offset,
    type: writtenType(holding.written),
  };
}

/**
 * The values `statements` store into a place of one of their functions with a written type, with that type: each
 * argument of a call naming the function, each default, each returned value into a written result, and each assignment
 * of a parameter in its function's body. Only the functions among `statements` (a file's, as `allStatements` lists
 * them): a `global function` of another file is not one.
 */
export function functionLandings(
  statements: readonly Statement[],
): { readonly value: Expression; readonly written: TypeAnnotation }[] {
  const found: { value: Expression; written: TypeAnnotation }[] = [];
  const functions = visibleFunctions(statements);
  for (const fn of functions.values()) {
    for (const parameter of fn.parameters)
      if (parameter.typeAnnotation !== null && parameter.defaultValue !== null)
        found.push({ value: parameter.defaultValue, written: parameter.typeAnnotation });
    if (fn.returnTypeAnnotation !== null)
      for (const returned of returnsOf(fn))
        if (returned.value !== null)
          found.push({ value: returned.value, written: fn.returnTypeAnnotation });
    for (const statement of bodyOf(fn))
      if (statement.kind === "assignmentStatement" && statement.target.kind === "identifier") {
        const name = statement.target.name;
        const written = fn.parameters.find(
          (parameter) => parameter.name.name === name,
        )?.typeAnnotation;
        if (written !== undefined && written !== null)
          found.push({ value: statement.value, written });
      }
  }
  for (const expression of expressions(statements)) {
    if (expression.kind !== "callExpression") continue;
    const fn = calleeOf(expression, functions);
    if (fn !== undefined)
      for (const argument of expression.arguments) {
        const written = parameterOf(fn, expression, argument).typeAnnotation;
        if (written !== null) found.push({ value: argument.value, written });
      }
  }
  return found;
}

/**
 * The name the analysis gives the place a store statement writes (`name`, the target's, as `o.a`): one of a parameter of
 * the function whose body holds the statement is prefixed with the function's, `<function>.<parameter>…`; any other
 * keeps its own.
 */
export function storedPlaceName(statement: Statement, name: string, own: Syntax): string {
  const root = name.split(".")[0];
  for (const fn of own.statements) {
    if (fn.kind !== "functionDeclaration") continue;
    if (!fn.parameters.some((parameter) => parameter.name.name === root)) continue;
    if (bodyOf(fn).includes(statement)) return `${fn.name.name}.${name}`;
  }
  return name;
}

/** A `return` ending a call, with its value. */
class Returned {
  public constructor(readonly value: EvaluatedValue) {}
}

/** The deepest a call nests in the oracle's runs: deeper is underivable (the runtime's own bound is TSR047's). */
const DEPTH = 64;

/** A file of the project as the calls read it: its syntax and what `derive` gives for it. */
export interface ProjectFile {
  readonly syntax: Syntax;
  readonly stores: readonly DerivedStore[];
  readonly content?: DerivedContent;
}

/** What `evaluate` gives the calls: its reader, its statement runner, its checks and its variables. */
export interface CallContext {
  /** The evaluated file's statements, stores and content. */
  readonly own: readonly Statement[];
  readonly stores: readonly DerivedStore[];
  readonly content: DerivedContent;
  readonly project: readonly ProjectFile[];
  readonly env: Map<string, EvaluatedValue>;
  readonly value: (expression: Expression) => EvaluatedValue;
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
  call(call: CallExpression): EvaluatedValue | undefined;
  /** Whether `statement` is a function's own, run here: a declaration (nothing runs) or a `return` (ends the call). */
  statement(statement: Statement): boolean;
}

export function functionCalls(context: CallContext): FunctionCalls {
  const functions = visibleFunctions(
    context.own,
    context.project.map((file) => file.syntax),
  );
  const { env, stores, fail, value } = context;
  // (a file's entries, stores and content, as the sites a run reads them by)
  const entries = (
    held: readonly DerivedStore[],
    content: DerivedContent | undefined,
  ): string[] => [
    ...held.map((store) => `${store.so}:${store.eo}`),
    ...(content === undefined
      ? []
      : [
          ...content.requireExisting.map((entry) => entry.site),
          ...content.indexes,
          ...content.fallbacks.flatMap((entry) => [entry.owner, entry.site]),
          ...content.expected.map((entry) => entry.owner),
          ...content.loads.map((entry) => entry.owner),
        ]),
  ];
  // (whether a run of another file's function would read an entry by offset: one of its own file inside it, which the
  // calling file's run does not hold, or one of the calling file at the site of a node of it)
  const misread = (fn: FunctionDeclaration, declaring: ProjectFile): boolean => {
    const [start, end] = [fn.span.start.offset, fn.span.end.offset];
    if (
      entries(declaring.stores, declaring.content).some((at) => {
        const [so, eo] = at.split(":").map(Number);
        return start <= so! && eo! <= end;
      })
    )
      return true;
    const nodes = new Set(
      [
        ...fn.parameters,
        ...bodyOf(fn),
        ...expressions([fn]).flatMap((expression) => [
          expression,
          ...(expression.kind === "callExpression" ? expression.arguments : []),
        ]),
      ].map((node) => `${node.span.start.offset}:${node.span.end.offset}`),
    );
    return entries(stores, context.content).some((at) => nodes.has(at));
  };
  let depth = 0;
  return {
    call(call) {
      const fn = calleeOf(call, functions);
      if (fn === undefined) return undefined;
      const declaring = context.own.includes(fn)
        ? undefined
        : context.project.find((file) => file.syntax.statements.includes(fn));
      if (declaring !== undefined && misread(fn, declaring))
        throw new Underivable(
          `a call of ${fn.name.name}, another file's function, whose run would read entries by offset`,
        );
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
      for (const statement of bodyOf(fn)) {
        if (statement.kind === "letStatement") own.add(statement.name.name);
        if (statement.kind === "forStatement") {
          own.add(statement.variable.name);
          if (statement.valueVariable !== null) own.add(statement.valueVariable.name);
        }
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
