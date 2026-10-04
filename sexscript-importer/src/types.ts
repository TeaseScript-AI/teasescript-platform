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
  /** Names assigned exactly once (their declaration), whose value no later side effect can change. */
  singleAssignment?: ReadonlySet<string>;
  /** Union of the values each local function (a closure in a variable) returns. */
  functionResults?: ReadonlyMap<string, ValueType>;
  /** Set while the list elements are not inferred yet, so an element read adds no type (inferVariableTypes). */
  elementsPending?: true;
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
  ["getImage", STRING | NULL],
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
  ["showPopup", NUMBER],
]);

const OBJECT_METHOD_RESULT_TYPES = new Map<string, ValueType>([
  ["any", BOOLEAN],
  ["collect", LIST],
  ["every", BOOLEAN],
  ["findAll", LIST],
  ["flatten", LIST],
  ["intersect", LIST],
  ["keySet", LIST],
  ["shuffle", LIST],
  ["sum", NUMBER],
  ["toList", LIST],
  ["unique", LIST],
  ["values", LIST],
  ["capitalize", STRING],
  ["contains", BOOLEAN],
  ["containsKey", BOOLEAN],
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
  ["toBigDecimal", NUMBER],
  ["toDouble", NUMBER],
  ["toFloat", NUMBER],
  ["toInteger", NUMBER],
  ["toLong", NUMBER],
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
    case "array":
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
    // A placeholder for a value that adds no type, such as a lookup of the dict whose values are being inferred.
    case "noValue":
      return 0;
    default:
      return UNKNOWN;
  }
}

function binaryType(node: AstNode, environment: TypeEnvironment): ValueType {
  const operator = typeof node.operator === "string" ? node.operator : "";
  if (operator === "[" && isCalendarConstant(asNode(node.right))) return NUMBER;
  if (operator === "[") {
    if (environment.elementsPending === true) return 0;
    const name = variableName(node.left);
    const element = name === null ? undefined : environment.listElements?.get(name);
    return element === undefined || element === 0 ? UNKNOWN : element;
  }
  if (BOOLEAN_OPERATORS.has(operator)) return BOOLEAN;
  // Groovy list - value is a list without the value.
  if (operator === "-") {
    const left = inferType(asNode(node.left), environment);
    if (onlyOf(left, LIST | NULL) && left & LIST) return LIST;
  }
  if (ARITHMETIC_OPERATORS.has(operator)) return NUMBER;
  if (operator === "=") return inferType(asNode(node.right), environment);
  if (operator === "&" || operator === "|" || operator === "^") {
    // Groovy's & | ^ are logical on booleans and bitwise on numbers.
    const left = inferType(asNode(node.left), environment);
    const right = inferType(asNode(node.right), environment);
    if (onlyOf(left, BOOLEAN) && onlyOf(right, BOOLEAN | NULL)) return BOOLEAN;
    return onlyOf(left, NUMBER) && onlyOf(right, NUMBER) ? NUMBER : UNKNOWN;
  }
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
  if (node.implicitThis === true && environment.localFunctions?.has(name) === true)
    return environment.functionResults?.get(name) ?? UNKNOWN;
  if (node.implicitThis === true || receiver === "main") {
    return SEXSCRIPT_RESULT_TYPES.get(name) ?? UNKNOWN;
  }
  if (receiver === "Math") return NUMBER;
  // Java's static number parsers, such as Integer.parseInt(text).
  if (
    ["Integer", "Long", "Double", "Float"].includes(receiver ?? "") &&
    /^(?:parse|valueOf)/u.test(name)
  )
    return NUMBER;
  // sort(), unique(), and reverse() on a list return a list.
  if (["sort", "unique", "reverse"].includes(name)) {
    const type = inferType(asNode(node.object), environment);
    if (onlyOf(type, LIST | NULL) && (type & LIST) !== 0) return LIST;
  }
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
  /** Results of functions defined elsewhere in the package (packageFunctionResults). */
  knownResults: ReadonlyMap<string, ValueType> = new Map(),
): TypeEnvironment {
  const assignments: Array<{
    name: string;
    type: (environment: TypeEnvironment) => ValueType;
    placeholder?: true;
  }> = [];
  // Incoming parameter values are unknown; later assignments do not describe them.
  const unknownNames = new Set<string>(parameters);
  const localFunctions = new Set<string>(localFunctionNames);
  // The values each closure kept in a variable returns, which calls of it produce.
  const returns: Array<{ name: string; values: AstNode[] }> = [];
  walkAst(body, (node) => {
    collectAssignments(node, assignments, unknownNames);
    const closure = node.kind === "declaration" ? asNode(node.right) : null;
    if (closure?.kind === "closure") {
      const name = variableName(node.left);
      if (name !== null) {
        localFunctions.add(name);
        returns.push({ name, values: closureReturnValues(closure) });
      }
    }
  });

  // An empty-text placeholder (`def lines = ""`) adds no type when the variable is assigned elsewhere, since the type
  // pass starts it with the empty value of its later type.
  const placeholderNames = new Set(
    assignments.filter((item) => item.placeholder === true).map((item) => item.name),
  );
  for (const name of placeholderNames) {
    if (assignments.some((item) => item.name === name && item.placeholder !== true)) {
      for (let index = assignments.length - 1; index >= 0; index -= 1)
        if (assignments[index]!.name === name && assignments[index]!.placeholder === true)
          assignments.splice(index, 1);
    }
  }
  const variables = new Map<string, ValueType>();
  for (const { name } of assignments) variables.set(name, 0);
  for (const name of unknownNames) variables.set(name, UNKNOWN);
  // A function defined here gets its result from its own returns; others keep the package's.
  const functionResults = new Map<string, ValueType>(
    [...knownResults].filter(([name]) => !returns.some((item) => item.name === name)),
  );
  let environment: TypeEnvironment = {
    variables,
    localFunctions,
    functionResults,
    elementsPending: true,
  };
  const settle = (): void => {
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
      for (const { name, values } of returns) {
        const current = functionResults.get(name) ?? 0;
        const next = values.reduce((type, value) => type | inferType(value, environment), current);
        if (next !== current) {
          functionResults.set(name, next);
          changed = true;
        }
      }
    }
  };
  settle();
  // An element read (`list[i]`) has the type of the list's elements, which depend on the variable types in turn; when
  // they do not settle, element reads stay unknown.
  let settled = false;
  for (let round = 0; round < 10 && !settled; round += 1) {
    const listElements = inferListElements(body, environment);
    const previous = environment.listElements;
    settled =
      previous !== undefined &&
      listElements.size === previous.size &&
      [...listElements].every(([name, type]) => previous.get(name) === type);
    environment = { variables, localFunctions, functionResults, listElements };
    settle();
  }
  if (!settled) {
    environment = { variables, localFunctions, functionResults };
    settle();
  }
  for (const [name, type] of variables) if (type === 0) variables.set(name, UNKNOWN);
  for (const [name, type] of functionResults) if (type === 0) functionResults.set(name, UNKNOWN);
  const assignmentCounts = new Map<string, number>();
  for (const { name } of assignments)
    assignmentCounts.set(name, (assignmentCounts.get(name) ?? 0) + 1);
  const singleAssignment = new Set(
    [...assignmentCounts]
      .filter(([name, count]) => count === 1 && !unknownNames.has(name))
      .map(([name]) => name),
  );
  return {
    variables,
    localFunctions,
    singleAssignment,
    functionResults,
    listElements: inferListElements(body, environment),
  };
}

/**
 * The values a closure returns: its `return` values (null for a bare `return`) and its last expression, or the last
 * expressions of a final `if`; a closure that ends otherwise returns null. Nested closures return for themselves.
 */
function closureReturnValues(closure: AstNode): AstNode[] {
  const nullValue: AstNode = { kind: "constant", span: null, value: null };
  const values: AstNode[] = [];
  const visit = (node: AstNode): void => {
    if (node.kind === "closure") return;
    if (node.kind === "return") values.push(asNode(node.value) ?? nullValue);
    for (const child of Object.values(node)) {
      for (const item of Array.isArray(child) ? child : [child]) if (isAstNode(item)) visit(item);
    }
  };
  const last = (statement: AstNode | null): void => {
    if (statement === null || statement.kind === "empty") {
      values.push(nullValue);
    } else if (statement.kind === "block") {
      const statements = Array.isArray(statement.statements)
        ? statement.statements.filter(isAstNode)
        : [];
      last(statements.at(-1) ?? null);
    } else if (statement.kind === "expressionStatement") {
      values.push(asNode(statement.expression) ?? nullValue);
    } else if (statement.kind === "if") {
      last(asNode(statement.then));
      last(asNode(statement.else));
    } else if (statement.kind !== "return") {
      values.push(nullValue);
    }
  };
  const body = asNode(closure.body);
  if (body !== null) {
    for (const child of Object.values(body)) {
      for (const item of Array.isArray(child) ? child : [child]) if (isAstNode(item)) visit(item);
    }
  }
  last(body);
  return values;
}

/**
 * Element types of variables that only list literals are assigned to, including elements added later (`add`, `<<`,
 * `addAll`, `+=`, index writes). A variable assigned another variable shares its list, as Groovy lists are shared by
 * reference, so both get the elements of either.
 */
function inferListElements(body: AstNode, environment: TypeEnvironment): Map<string, ValueType> {
  const elements = new Map<string, ValueType>();
  const added = new Map<string, ValueType>();
  const unknown = new Set<string>();
  const aliases: Array<[string, string]> = [];
  // `target += source` and `target.addAll(source)` copy the elements of a list variable one way.
  const appends: Array<[string, string]> = [];
  const add = (name: string | null, type: ValueType): void => {
    if (name !== null) added.set(name, (added.get(name) ?? 0) | type);
  };
  const itemsType = (list: AstNode): ValueType =>
    (Array.isArray(list.items) ? list.items : []).reduce(
      (type: ValueType, item) => type | (isAstNode(item) ? inferType(item, environment) : UNKNOWN),
      0,
    );
  const appendList = (name: string | null, list: AstNode): void => {
    const source = variableName(list);
    if (list.kind === "list") add(name, itemsType(list));
    else if (source !== null && name !== null) appends.push([name, source]);
    else add(name, UNKNOWN);
  };
  walkAst(body, (node) => {
    if (node.kind === "methodCall") {
      const name = variableName(node.object);
      const method = constantString(node.method);
      const args = asNode(node.arguments);
      const items = Array.isArray(args?.items) ? args.items.filter(isAstNode) : [];
      const last = items.at(-1);
      if ((method === "add" || method === "push" || method === "leftShift") && last !== undefined)
        add(name, inferType(last, environment));
      if (method === "addAll" && last !== undefined) appendList(name, last);
      return;
    }
    if (node.kind === "binary" && (node.operator === "<<" || node.operator === "+=")) {
      const right = asNode(node.right);
      if (right === null) return;
      if (node.operator === "<<") add(variableName(node.left), inferType(right, environment));
      else if ((inferType(right, environment) & LIST) !== 0)
        appendList(variableName(node.left), right);
      else add(variableName(node.left), inferType(right, environment));
      return;
    }
    if (node.kind !== "declaration" && !(node.kind === "binary" && node.operator === "=")) return;
    const left = asNode(node.left);
    const value = asNode(node.right);
    if (left?.kind === "binary" && left.operator === "[" && value !== null) {
      add(variableName(left.left), inferType(value, environment));
      return;
    }
    const name = variableName(left);
    if (name === null || value === null) return;
    if (
      value.kind === "unsupportedExpression" ||
      (value.kind === "constant" && value.value === null) ||
      // An empty-text placeholder holds no elements (see inferVariableTypes).
      (node.kind === "declaration" && value.kind === "constant" && value.value === "")
    ) {
      return;
    }
    if (value.kind === "array" && typeof value.elementType === "string") {
      // Java arrays are typed; object arrays start filled with null.
      const element = castType(value.elementType);
      const primitive = /^[a-z]/u.test(value.elementType);
      elements.set(name, (elements.get(name) ?? 0) | element | (primitive ? 0 : NULL));
      return;
    }
    const source = variableName(value);
    if (source !== null) {
      aliases.push([name, source]);
      return;
    }
    // `list = list - value` keeps some of its elements; `list = list + other` appends as `+=` does.
    const extended = value.kind === "binary" && variableName(value.left) === name;
    const extension = extended ? asNode(value.right) : null;
    if (extended && value.operator === "-") return;
    if (extended && value.operator === "+" && extension !== null) {
      if ((inferType(extension, environment) & LIST) !== 0) appendList(name, extension);
      else add(name, inferType(extension, environment));
      return;
    }
    if (value.kind !== "list") {
      unknown.add(name);
      return;
    }
    elements.set(name, (elements.get(name) ?? 0) | itemsType(value));
  });
  const flows = [
    ...aliases.flatMap(([target, source]): Array<[string, string]> => [
      [target, source],
      [source, target],
    ]),
    ...appends,
  ];
  for (let changed = true; changed;) {
    changed = false;
    // Only a list variable gains the elements, also one that shares a list through an alias; a `+=` on a number
    // or text adds nothing.
    for (const [name, type] of added) {
      if (!elements.has(name) || (elements.get(name)! | type) === elements.get(name)) continue;
      elements.set(name, elements.get(name)! | type);
      changed = true;
    }
    for (const [target, source] of flows) {
      if (!elements.has(source) && !unknown.has(source)) continue;
      const merged = unknown.has(source)
        ? undefined
        : (elements.get(target) ?? 0) | elements.get(source)!;
      if (merged === undefined ? !unknown.has(target) : merged !== elements.get(target)) {
        if (merged === undefined) unknown.add(target);
        else elements.set(target, merged);
        changed = true;
      }
    }
  }
  for (const name of unknown) elements.delete(name);
  return elements;
}

function collectAssignments(
  node: AstNode,
  assignments: Array<{
    name: string;
    type: (environment: TypeEnvironment) => ValueType;
    placeholder?: true;
  }>,
  unknownNames: Set<string>,
): void {
  if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) {
    const left = asNode(node.left);
    if (left?.kind === "arguments" && Array.isArray(left.items)) {
      // `def (a, b) = list` assigns each name an element whose type is not tracked.
      for (const item of left.items) {
        const name = isAstNode(item) ? variableName(item) : null;
        if (name !== null) unknownNames.add(name);
      }
      return;
    }
    const name = variableName(node.left);
    const value = asNode(node.right);
    if (name === null || value === null) return;
    if (value.kind === "unsupportedExpression") {
      // A declaration without initializer starts as null in Groovy.
      assignments.push({ name, type: () => NULL });
      return;
    }
    if (node.kind === "declaration" && value.kind === "constant" && value.value === "") {
      assignments.push({ name, type: () => STRING, placeholder: true });
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
    } else if (node.operator === "-=") {
      // Groovy list -= value keeps a list.
      const right = asNode(node.right);
      assignments.push({
        name,
        type: (environment) =>
          binaryType(
            { kind: "binary", span: null, operator: "-", left: node.left, right },
            environment,
          ),
      });
    } else if (["*=", "/=", "%="].includes(node.operator)) {
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
