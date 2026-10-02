import {
  constantString,
  groovyParameters,
  isAstNode,
  variableName,
  walkAst,
  type AstNode,
} from "./ast.ts";

/**
 * Flow-insensitive value-type sets for legacy Groovy expressions. A set bit means the value may have that type;
 * `UNKNOWN` means the importer has no evidence. Groovy's dynamic `def` variables make this an approximation used
 * only to choose safe TeaseScript rewrites, never to claim a TeaseScript type.
 */
export const STRING = 1;
export const NUMBER = 2;
export const BOOLEAN = 4;
export const LIST = 8;
export const OBJECT = 16;
export const NULL = 32;
export const UNKNOWN = STRING | NUMBER | BOOLEAN | LIST | OBJECT | NULL;

export type ValueType = number;

export interface TypeEnvironment {
  /** Union of every value assigned to a name anywhere in the analysed body. */
  variables: ReadonlyMap<string, ValueType>;
  /** Union of element types for names assigned only list literals; absent when unknown. */
  listElements?: ReadonlyMap<string, ValueType>;
  /** Locally defined functions; a call to one of these is not the SexScript API of the same name. */
  localFunctions?: ReadonlySet<string>;
}

/** True when every possible value has one of the `allowed` types. */
export function onlyOf(type: ValueType, allowed: ValueType): boolean {
  return type !== 0 && (type & ~allowed) === 0;
}

const SEXSCRIPT_RESULT_TYPES = new Map<string, ValueType>([
  ["getBoolean", BOOLEAN],
  ["getBooleans", LIST],
  ["getDataFolder", STRING],
  ["getFloat", NUMBER],
  ["getInteger", NUMBER],
  ["getRandom", NUMBER],
  ["getSelectedValue", NUMBER],
  ["getString", STRING],
  ["getTime", NUMBER],
  ["isConnected", BOOLEAN],
  ["loadBoolean", BOOLEAN | NULL],
  ["loadFirstTrue", STRING | NULL],
  ["loadFloat", NUMBER | NULL],
  ["loadInteger", NUMBER | NULL],
  ["loadMap", OBJECT | NULL],
  ["loadString", STRING | NULL],
  ["showButton", NUMBER],
]);

const OBJECT_METHOD_RESULT_TYPES = new Map<string, ValueType>([
  ["capitalize", STRING],
  ["contains", BOOLEAN],
  ["endsWith", BOOLEAN],
  ["equals", BOOLEAN],
  ["equalsIgnoreCase", BOOLEAN],
  ["indexOf", NUMBER],
  ["intValue", NUMBER],
  ["isEmpty", BOOLEAN],
  ["join", STRING],
  ["length", NUMBER],
  ["matches", BOOLEAN],
  ["replace", STRING],
  ["replaceAll", STRING],
  ["size", NUMBER],
  ["split", LIST],
  ["startsWith", BOOLEAN],
  ["substring", STRING],
  ["toInteger", NUMBER],
  ["toLowerCase", STRING],
  ["toString", STRING],
  ["toUpperCase", STRING],
  ["trim", STRING],
]);

const ARITHMETIC_OPERATORS = new Set(["-", "*", "/", "%", "**"]);
const BOOLEAN_OPERATORS = new Set([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  "in",
  "instanceof",
]);

export function inferType(node: AstNode | null, environment: TypeEnvironment): ValueType {
  if (node === null) return UNKNOWN;
  switch (node.kind) {
    case "constant":
      if (node.value === null) return NULL;
      if (typeof node.value === "string") return STRING;
      if (typeof node.value === "number") return NUMBER;
      if (typeof node.value === "boolean") return BOOLEAN;
      return UNKNOWN;
    case "gstring":
      return STRING;
    case "list":
    case "range":
      return LIST;
    case "map":
      return OBJECT;
    case "variable": {
      const name = variableName(node);
      return name === null ? UNKNOWN : (environment.variables.get(name) ?? UNKNOWN);
    }
    case "not":
    case "boolean":
      return node.kind === "not" ? BOOLEAN : inferType(asNode(node.value), environment);
    case "unaryMinus":
    case "unaryPlus":
    case "postfix":
    case "prefix":
      return NUMBER;
    case "ternary":
      return inferType(asNode(node.true), environment) | inferType(asNode(node.false), environment);
    case "elvis":
      return (
        (inferType(asNode(node.boolean), environment) & ~NULL) |
        inferType(asNode(node.false), environment)
      );
    case "cast":
      return castType(typeof node.type === "string" ? node.type : "");
    case "binary":
      return binaryType(node, environment);
    case "methodCall":
      return methodCallType(node, environment);
    case "property": {
      const property = constantString(node.property);
      return property === "size" || property === "length" ? NUMBER : UNKNOWN;
    }
    default:
      return UNKNOWN;
  }
}

function binaryType(node: AstNode, environment: TypeEnvironment): ValueType {
  const operator = typeof node.operator === "string" ? node.operator : "";
  if (operator === "[" && isCalendarConstant(asNode(node.right))) return NUMBER;
  if (BOOLEAN_OPERATORS.has(operator)) return BOOLEAN;
  if (ARITHMETIC_OPERATORS.has(operator)) return NUMBER;
  if (operator === "=") return inferType(asNode(node.right), environment);
  if (operator !== "+") return UNKNOWN;
  const left = inferType(asNode(node.left), environment);
  const right = inferType(asNode(node.right), environment);
  if (left === 0 || right === 0) return left | right;
  // Groovy list + anything is list concatenation or append, even when the right side is a string.
  if (onlyOf(left, LIST | NULL) && left & LIST) return LIST;
  if (onlyOf(left, STRING | NULL) && left & STRING) return STRING;
  if (onlyOf(right, STRING | NULL) && right & STRING) return STRING;
  if (onlyOf(left, NUMBER) && onlyOf(right, NUMBER)) return NUMBER;
  if (onlyOf(left, LIST | NULL) && left & LIST) return LIST;
  return UNKNOWN;
}

function castType(type: string): ValueType {
  switch (type) {
    case "int":
    case "Integer":
    case "long":
    case "Long":
    case "float":
    case "Float":
    case "double":
    case "Double":
    case "BigDecimal":
      return NUMBER;
    case "String":
    case "java.lang.String":
      return STRING;
    case "boolean":
    case "Boolean":
      return BOOLEAN;
    case "List":
    case "java.util.List":
      return LIST;
    default:
      return UNKNOWN;
  }
}

function methodCallType(node: AstNode, environment: TypeEnvironment): ValueType {
  const name = constantString(node.method);
  if (name === null) return UNKNOWN;
  const receiver = variableName(node.object);
  if (node.implicitThis === true && environment.localFunctions?.has(name) === true) return UNKNOWN;
  if (node.implicitThis === true || receiver === "main") {
    return SEXSCRIPT_RESULT_TYPES.get(name) ?? UNKNOWN;
  }
  if (receiver === "Math") return NUMBER;
  if (name === "get" && node.arguments !== undefined && isCalendarFieldRead(node)) return NUMBER;
  return OBJECT_METHOD_RESULT_TYPES.get(name) ?? UNKNOWN;
}

/**
 * Computes the union of every value assigned to each variable in `body`, iterating to a fixed point so that
 * assignments from other variables propagate. Names without assignment evidence stay absent (unknown).
 */
export function inferVariableTypes(
  body: AstNode,
  parameters: readonly string[] = [],
  localFunctionNames: Iterable<string> = [],
): TypeEnvironment {
  const assignments: Array<{ name: string; type: (environment: TypeEnvironment) => ValueType }> =
    [];
  // Incoming parameter values are unknown; later assignments do not describe them.
  const unknownNames = new Set<string>(parameters);
  const localFunctions = new Set<string>(localFunctionNames);
  walkAst(body, (node) => {
    collectAssignments(node, assignments, unknownNames);
    if (node.kind === "declaration" && asNode(node.right)?.kind === "closure") {
      const name = variableName(node.left);
      if (name !== null) localFunctions.add(name);
    }
  });

  const variables = new Map<string, ValueType>();
  for (const { name } of assignments) variables.set(name, 0);
  for (const name of unknownNames) variables.set(name, UNKNOWN);
  const environment: TypeEnvironment = { variables, localFunctions };
  for (let changed = true; changed;) {
    changed = false;
    for (const assignment of assignments) {
      const current = variables.get(assignment.name) ?? 0;
      const next = current | assignment.type(environment);
      if (next !== current) {
        variables.set(assignment.name, next);
        changed = true;
      }
    }
  }
  for (const [name, type] of variables) if (type === 0) variables.set(name, UNKNOWN);
  return { variables, localFunctions, listElements: inferListElements(body, environment) };
}

function inferListElements(body: AstNode, environment: TypeEnvironment): Map<string, ValueType> {
  const elements = new Map<string, ValueType>();
  const unknown = new Set<string>();
  walkAst(body, (node) => {
    if (node.kind !== "declaration" && !(node.kind === "binary" && node.operator === "=")) return;
    const name = variableName(node.left);
    const value = asNode(node.right);
    if (name === null || value === null) return;
    if (
      value.kind === "unsupportedExpression" ||
      (value.kind === "constant" && value.value === null)
    ) {
      return;
    }
    if (value.kind !== "list") {
      unknown.add(name);
      return;
    }
    let type = elements.get(name) ?? 0;
    for (const item of Array.isArray(value.items) ? value.items : []) {
      type |= isAstNode(item) ? inferType(item, environment) : UNKNOWN;
    }
    elements.set(name, type);
  });
  for (const name of unknown) elements.delete(name);
  return elements;
}

function collectAssignments(
  node: AstNode,
  assignments: Array<{ name: string; type: (environment: TypeEnvironment) => ValueType }>,
  unknownNames: Set<string>,
): void {
  if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) {
    const name = variableName(node.left);
    const value = asNode(node.right);
    if (name === null || value === null) return;
    if (value.kind === "unsupportedExpression") {
      // A declaration without initializer starts as null in Groovy.
      assignments.push({ name, type: () => NULL });
      return;
    }
    assignments.push({ name, type: (environment) => inferType(value, environment) });
    return;
  }
  if (node.kind === "binary" && typeof node.operator === "string") {
    const name = variableName(node.left);
    if (name === null) return;
    if (node.operator === "+=") {
      const right = asNode(node.right);
      assignments.push({
        name,
        type: (environment) =>
          binaryType(
            { kind: "binary", span: null, operator: "+", left: node.left, right },
            environment,
          ),
      });
    } else if (["-=", "*=", "/=", "%="].includes(node.operator)) {
      assignments.push({ name, type: () => NUMBER });
    }
    return;
  }
  if (node.kind === "postfix" || node.kind === "prefix") {
    const name = variableName(node.value);
    if (name !== null) assignments.push({ name, type: () => NUMBER });
    return;
  }
  if (node.kind === "for" && typeof node.variable === "string") {
    const collection = asNode(node.collection);
    if (collection?.kind === "range") assignments.push({ name: node.variable, type: () => NUMBER });
    else unknownNames.add(node.variable);
    return;
  }
  if (node.kind === "closure") {
    for (const parameter of groovyParameters(node.parameters) ?? [])
      unknownNames.add(parameter.name);
    if (node.parameterSpecified !== true) unknownNames.add("it");
  }
}

function isCalendarConstant(node: AstNode | null): boolean {
  return node?.kind === "property" && variableName(node.object) === "Calendar";
}

function isCalendarFieldRead(node: AstNode): boolean {
  const args = asNode(node.arguments);
  const first = args === null || !Array.isArray(args.items) ? undefined : args.items[0];
  return isAstNode(first) && isCalendarConstant(first);
}

function asNode(value: unknown): AstNode | null {
  return isAstNode(value) ? value : null;
}
