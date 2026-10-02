import { TEASESCRIPT_PROTECTED_NAMES } from "../../src/protected-names.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";

const PROTECTED = new Set<string>(TEASESCRIPT_PROTECTED_NAMES);

/**
 * Renames legacy identifiers that TeaseScript rejects: names reserved by TeaseScript, and function parameters or
 * locals that collide with a package-global name (TeaseScript forbids that shadowing even when the global is
 * declared later in the file). Groovy allowed both. Runs on the final program, after package helper composition.
 */
export function renameConflictingIdentifiers(program: MigrationProgram): MigrationProgram {
  const used = new Set<string>();
  collectNames(program.statements, used);
  const fresh = (base: string): string => {
    let candidate = `${base}Value`;
    for (let suffix = 2; used.has(candidate) || PROTECTED.has(candidate); suffix += 1) {
      candidate = `${base}Value${suffix}`;
    }
    used.add(candidate);
    return candidate;
  };

  const globals = new Set<string>();
  const functions = new Map<string, string>();
  for (const statement of program.statements) {
    if (statement.kind === "let") globals.add(statement.name);
    if (statement.kind === "function") {
      functions.set(
        statement.name,
        PROTECTED.has(statement.name) ? fresh(statement.name) : statement.name,
      );
    }
  }
  const rootScope = new Map<string, string>();
  for (const name of globals) if (PROTECTED.has(name)) rootScope.set(name, fresh(name));

  const renamer: Renamer = {
    functions,
    conflicts: (name, inFunction) => PROTECTED.has(name) || (inFunction && globals.has(name)),
    fresh,
  };
  return { ...program, statements: renameBlock(program.statements, rootScope, false, renamer) };
}

interface Renamer {
  functions: ReadonlyMap<string, string>;
  conflicts: (name: string, inFunction: boolean) => boolean;
  fresh: (base: string) => string;
}

type Scope = Map<string, string>;

function renameBlock(
  statements: IrStatement[],
  outer: Scope,
  inFunction: boolean,
  renamer: Renamer,
): IrStatement[] {
  const scope: Scope = new Map(outer);
  return statements.map((statement) => renameStatement(statement, scope, inFunction, renamer));
}

function declare(name: string, scope: Scope, inFunction: boolean, renamer: Renamer): string {
  const existing = scope.get(name);
  if (existing !== undefined && !inFunction) return existing;
  const renamed = renamer.conflicts(name, inFunction) ? renamer.fresh(name) : name;
  scope.set(name, renamed);
  return renamed;
}

function renameStatement(
  statement: IrStatement,
  scope: Scope,
  inFunction: boolean,
  renamer: Renamer,
): IrStatement {
  const expression = (value: IrExpression): IrExpression => renameExpression(value, scope, renamer);
  const block = (body: IrStatement[]): IrStatement[] =>
    renameBlock(body, scope, inFunction, renamer);
  switch (statement.kind) {
    case "function": {
      const functionScope: Scope = new Map(scope);
      const parameters = statement.parameters.map((parameter) => ({
        name: declare(parameter.name, functionScope, true, renamer),
        defaultValue:
          parameter.defaultValue === null
            ? null
            : renameExpression(parameter.defaultValue, functionScope, renamer),
      }));
      return {
        ...statement,
        name: renamer.functions.get(statement.name) ?? statement.name,
        parameters,
        body: renameBlock(statement.body, functionScope, true, renamer),
      };
    }
    case "let": {
      const value = expression(statement.value);
      return { ...statement, value, name: declare(statement.name, scope, inFunction, renamer) };
    }
    case "for": {
      const collection = expression(statement.collection);
      const loopScope: Scope = new Map(scope);
      const variable = declare(statement.variable, loopScope, inFunction, renamer);
      return {
        ...statement,
        variable,
        collection,
        body: renameBlock(statement.body, loopScope, inFunction, renamer),
      };
    }
    case "if":
      return {
        ...statement,
        condition: expression(statement.condition),
        then: block(statement.then),
        else: block(statement.else),
      };
    case "while":
      return {
        ...statement,
        condition: expression(statement.condition),
        body: block(statement.body),
      };
    case "switch":
      return {
        ...statement,
        value: expression(statement.value),
        cases: statement.cases.map((item) => ({
          ...item,
          match: expression(item.match),
          body: block(item.body),
        })),
        default: block(statement.default),
      };
    case "assign":
      return {
        ...statement,
        target: expression(statement.target),
        value: expression(statement.value),
      };
    case "say":
      return { ...statement, value: expression(statement.value) };
    case "wait":
      return { ...statement, duration: expression(statement.duration) };
    case "showButton":
      return {
        ...statement,
        label: expression(statement.label),
        timeout: statement.timeout === null ? null : expression(statement.timeout),
      };
    case "showPopup":
      return { ...statement, message: expression(statement.message) };
    case "showImage":
      return { ...statement, file: expression(statement.file) };
    case "playAudio":
      return {
        ...statement,
        file: expression(statement.file),
        repeatCount: statement.repeatCount === null ? null : expression(statement.repeatCount),
      };
    case "save":
      return { ...statement, key: expression(statement.key), value: expression(statement.value) };
    case "delete":
      return { ...statement, key: expression(statement.key) };
    case "return":
      return { ...statement, value: statement.value === null ? null : expression(statement.value) };
    case "expression":
      return { ...statement, expression: expression(statement.expression) };
    case "run":
      return { ...statement, script: expression(statement.script) };
    case "hideImage":
    case "break":
    case "continue":
    case "end":
    case "exit":
    case "unsupported":
    case "comment":
    case "blank":
      return statement;
  }
}

function renameExpression(expression: IrExpression, scope: Scope, renamer: Renamer): IrExpression {
  const child = (value: IrExpression): IrExpression => renameExpression(value, scope, renamer);
  switch (expression.kind) {
    case "variable":
      return { ...expression, name: scope.get(expression.name) ?? expression.name };
    case "call":
      return {
        ...expression,
        name: renamer.functions.get(expression.name) ?? expression.name,
        positional: expression.positional.map(child),
        named: Object.fromEntries(
          Object.entries(expression.named).map(([name, value]) => [name, child(value)]),
        ),
      };
    case "list":
      return { ...expression, items: expression.items.map(child) };
    case "object":
      return {
        ...expression,
        properties: expression.properties.map((property) => ({
          ...property,
          value: child(property.value),
        })),
      };
    case "index":
      return { ...expression, target: child(expression.target), index: child(expression.index) };
    case "property":
      return { ...expression, target: child(expression.target) };
    case "methodCall":
      return {
        ...expression,
        target: child(expression.target),
        arguments: expression.arguments.map(child),
      };
    case "load":
      return {
        ...expression,
        key: child(expression.key),
        ...(expression.defaultValue === undefined
          ? {}
          : { defaultValue: child(expression.defaultValue) }),
      };
    case "choice":
      return { ...expression, options: expression.options.map(child) };
    case "range":
      return { ...expression, from: child(expression.from), to: child(expression.to) };
    case "unary":
      return { ...expression, value: child(expression.value) };
    case "binary":
      return { ...expression, left: child(expression.left), right: child(expression.right) };
    case "template":
      return {
        ...expression,
        parts: expression.parts.map((part) =>
          "text" in part ? part : { value: child(part.value) },
        ),
      };
    case "literal":
    case "input":
      return expression;
  }
}

function collectNames(statements: IrStatement[], names: Set<string>): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "name" || key === "variable") && typeof child === "string") names.add(child);
      else visit(child);
    }
  };
  visit(statements);
}
