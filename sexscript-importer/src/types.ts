import {
  constantString,
  groovyParameters,
  isAstNode,
  isRecord,
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
  /**
   * The positions of the parameters a local function returns unchanged, whose arguments a call adds to the result:
   * `{ key, fallback -> ... return fallback }` returns what a call passes as `fallback`.
   */
  functionPassThrough?: ReadonlyMap<string, readonly number[]>;
  /** Set while the list elements are not inferred yet, so an element read adds no type (inferVariableTypes). */
  elementsPending?: true;
  /**
   * Types of the variables a closure declares (its parameters and `def` locals), by binding key, apart from script
   * variables of the same name; `variables` holds the union of every binding of a name.
   */
  bindingTypes?: ReadonlyMap<string, ValueType>;
  /** The binding key a variable reference names (see `VariableBindings`). */
  bindingOf?: (node: AstNode) => string | null;
}

/**
 * How variable references resolve to bindings (`bindingKeys` in lower.ts): a closure's parameters and `def` locals
 * are variables apart from script-level names of the same spelling. Without it, every name is one variable.
 */
export interface VariableBindings {
  /** The key of a variable reference or declaration target; its name for a script-level variable. */
  bindingOf: (node: AstNode) => string | null;
  /** The key of a closure parameter. */
  parameterKey: (closure: AstNode, name: string) => string;
  /** The key of a `for` loop variable. */
  loopKey: (loop: AstNode) => string;
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
  ["after", BOOLEAN],
  ["any", BOOLEAN],
  ["before", BOOLEAN],
  ["collect", LIST],
  ["every", BOOLEAN],
  ["findAll", LIST],
  ["flatten", LIST],
  ["intersect", LIST],
  ["keySet", LIST],
  // Groovy readLines() on a file, reader, stream, or text returns a list of lines.
  ["readLines", LIST],
  ["shuffle", LIST],
  ["sum", NUMBER],
  ["toList", LIST],
  ["tokenize", LIST],
  ["unique", LIST],
  ["values", LIST],
  ["capitalize", STRING],
  ["contains", BOOLEAN],
  ["containsKey", BOOLEAN],
  ["count", NUMBER],
  ["endsWith", BOOLEAN],
  ["equals", BOOLEAN],
  ["equalsIgnoreCase", BOOLEAN],
  ["exists", BOOLEAN],
  ["indexOf", NUMBER],
  ["intValue", NUMBER],
  ["isEmpty", BOOLEAN],
  ["join", STRING],
  ["lastIndexOf", NUMBER],
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

/** Java list classes, whose constructors make a list. */
const LIST_CONSTRUCTORS = new Set([
  "ArrayList",
  "java.util.ArrayList",
  "LinkedList",
  "java.util.LinkedList",
  "Vector",
  "java.util.Vector",
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
    // `new ArrayList()` and its relatives are lists (java-text.ts converts them).
    case "constructorCall":
      return LIST_CONSTRUCTORS.has(String(node.type)) ? LIST : UNKNOWN;
    case "variable": {
      const name = variableName(node);
      if (name === null) return UNKNOWN;
      const key = environment.bindingOf?.(node) ?? name;
      const scoped = key === name ? undefined : environment.bindingTypes?.get(key);
      return scoped ?? environment.variables.get(name) ?? UNKNOWN;
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
  // Groovy `list << value` appends to the list and is the list.
  if (operator === "<<") {
    const left = inferType(asNode(node.left), environment);
    if (onlyOf(left, LIST | NULL) && left & LIST) return LIST;
  }
  // Groovy list - value is a list without the value.
  if (operator === "-") {
    const left = inferType(asNode(node.left), environment);
    if (onlyOf(left, LIST | NULL) && left & LIST) return LIST;
  }
  if (ARITHMETIC_OPERATORS.has(operator)) return NUMBER;
  if (operator === "=") return inferType(asNode(node.right), environment);
  if (operator === "==~") return BOOLEAN;
  if (operator === "&" || operator === "|" || operator === "^") {
    // Groovy's & | ^ are logical on booleans and bitwise on numbers.
    const left = inferType(asNode(node.left), environment);
    const right = inferType(asNode(node.right), environment);
    // A side of unknown type with a flag on the other side is tested as a condition (isLogicalOperation).
    const flag = (type: number): boolean => onlyOf(type, BOOLEAN | NULL) || type === UNKNOWN;
    if (flag(left) && flag(right) && (left !== UNKNOWN || right !== UNKNOWN)) return BOOLEAN;
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
  if (node.implicitThis === true && environment.localFunctions?.has(name) === true) {
    const passed = environment.functionPassThrough?.get(name);
    if (passed === undefined) return environment.functionResults?.get(name) ?? UNKNOWN;
    const items: unknown = asNode(node.arguments)?.items;
    const args = Array.isArray(items) ? items.filter(isAstNode) : [];
    return passed.reduce(
      (type, position) =>
        type | (args[position] === undefined ? NULL : inferType(args[position], environment)),
      environment.functionResults?.get(name) ?? 0,
    );
  }
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
 * assignments from other variables propagate. Names without assignment evidence stay absent (unknown). With
 * `bindings`, a variable that a closure declares has a type apart from the other variables of its name.
 */
export function inferVariableTypes(
  body: AstNode,
  parameters: readonly string[] = [],
  localFunctionNames: Iterable<string> = [],
  /** Results of functions defined elsewhere in the package (packageFunctionResults). */
  knownResults: ReadonlyMap<string, ValueType> = new Map(),
  bindings?: VariableBindings,
): TypeEnvironment {
  const keys: VariableBindings = bindings ?? {
    bindingOf: (node) => variableName(node),
    parameterKey: (_closure, name) => name,
    loopKey: (loop) => String(loop.variable),
  };
  const collector: AssignmentCollector = {
    assignments: [],
    // Incoming parameter values are unknown; later assignments do not describe them.
    unknownKeys: new Set<string>(parameters),
    declarations: new Map(),
    iterationClosures: new Set(),
    keys,
  };
  const { assignments, unknownKeys } = collector;
  const localFunctions = new Set<string>(localFunctionNames);
  // The values each closure kept in a variable returns, which calls of it produce; a returned parameter that the
  // closure never assigns is the call's argument (functionPassThrough).
  const returns: Array<{ name: string; values: AstNode[] }> = [];
  const passThrough = new Map<string, number[]>();
  walkAst(body, (node) => {
    collectAssignments(node, collector);
    const closure = node.kind === "declaration" ? asNode(node.right) : null;
    if (closure?.kind === "closure") {
      const name = variableName(node.left);
      if (name !== null) {
        localFunctions.add(name);
        const parameterNames =
          closure.parameterSpecified === true
            ? (groovyParameters(closure.parameters) ?? []).map((parameter) => parameter.name)
            : [];
        const assignedInside = new Set<string>();
        walkAst(closure.body, (inner) => {
          const target =
            inner.kind === "binary" &&
            String(inner.operator).endsWith("=") &&
            inner.operator !== "=="
              ? variableName(inner.left)
              : null;
          if (target !== null) assignedInside.add(target);
        });
        const values = closureReturnValues(closure);
        const passed = values.flatMap((value) => {
          const position = parameterNames.indexOf(variableName(value) ?? "");
          return position >= 0 && !assignedInside.has(parameterNames[position]!) ? [position] : [];
        });
        if (passed.length > 0) passThrough.set(name, [...new Set(passed)]);
        returns.push({
          name,
          values: values.filter((value) => {
            const position = parameterNames.indexOf(variableName(value) ?? "");
            return !(position >= 0 && passed.includes(position));
          }),
        });
      }
    }
  });
  // A variable declared with a list or text type holds only such values: Groovy converted any other value to text,
  // or failed, when the variable received it. Every declaration of the binding must agree. It holds null only when
  // an assignment shows it may; a value of unknown type is no such evidence, as for an undeclared variable.
  const declared = new Map<string, ValueType>();
  for (const [key, types] of collector.declarations) {
    const [only] = types;
    if (types.size === 1 && typeof only === "number" && !unknownKeys.has(key))
      declared.set(key, only);
  }

  // An empty-text placeholder (`def lines = ""`) adds no type when the variable is assigned elsewhere, since the type
  // pass starts it with the empty value of its later type.
  const placeholderNames = new Set(
    assignments.filter((item) => item.placeholder === true).map((item) => nameOf(item.key)),
  );
  for (const name of placeholderNames) {
    if (assignments.some((item) => nameOf(item.key) === name && item.placeholder !== true)) {
      for (let index = assignments.length - 1; index >= 0; index -= 1)
        if (nameOf(assignments[index]!.key) === name && assignments[index]!.placeholder === true)
          assignments.splice(index, 1);
    }
  }
  // Every binding during the fixed point, by key; a script-level variable's key is its name.
  const types = new Map<string, ValueType>();
  for (const { key } of assignments) types.set(key, 0);
  for (const key of unknownKeys) types.set(key, UNKNOWN);
  for (const [key, type] of declared) types.set(key, type);
  // The values assigned to each declared binding, which decide only whether it may hold null.
  const assigned = new Map<string, ValueType>();
  // A function defined here gets its result from its own returns; others keep the package's.
  const functionResults = new Map<string, ValueType>(
    [...knownResults].filter(([name]) => !returns.some((item) => item.name === name)),
  );
  const bindingOf = bindings?.bindingOf;
  const scoped = bindingOf === undefined ? {} : { bindingTypes: types, bindingOf };
  let environment: TypeEnvironment = {
    variables: types,
    localFunctions,
    functionResults,
    functionPassThrough: passThrough,
    elementsPending: true,
    ...scoped,
  };
  const settle = (): void => {
    for (let changed = true; changed;) {
      changed = false;
      for (const assignment of assignments) {
        const type = declared.get(assignment.key);
        if (type !== undefined) {
          const values = (assigned.get(assignment.key) ?? 0) | assignment.type(environment);
          assigned.set(assignment.key, values);
          const next = type | ((values & NULL) !== 0 && values !== UNKNOWN ? NULL : 0);
          if (next !== types.get(assignment.key)) {
            types.set(assignment.key, next);
            changed = true;
          }
          continue;
        }
        const current = types.get(assignment.key) ?? 0;
        const next = current | assignment.type(environment);
        if (next !== current) {
          types.set(assignment.key, next);
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
    environment = {
      variables: types,
      localFunctions,
      functionResults,
      functionPassThrough: passThrough,
      listElements,
      ...scoped,
    };
    settle();
  }
  if (!settled) {
    environment = {
      variables: types,
      localFunctions,
      functionResults,
      functionPassThrough: passThrough,
      ...scoped,
    };
    settle();
  }
  for (const [key, type] of types) if (type === 0) types.set(key, UNKNOWN);
  for (const [name, type] of functionResults) if (type === 0) functionResults.set(name, UNKNOWN);
  const listElements = inferListElements(body, environment);
  // Code that sees names only gets the union of every binding of a name.
  const variables = new Map<string, ValueType>();
  const bindingTypes = new Map<string, ValueType>();
  for (const [key, type] of types) {
    const name = nameOf(key);
    variables.set(name, (variables.get(name) ?? 0) | type);
    if (key !== name) bindingTypes.set(key, type);
  }
  const unknownNames = new Set([...unknownKeys].map(nameOf));
  const assignmentCounts = new Map<string, number>();
  for (const { key } of assignments)
    assignmentCounts.set(nameOf(key), (assignmentCounts.get(nameOf(key)) ?? 0) + 1);
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
    functionPassThrough: passThrough,
    listElements,
    ...(bindingOf === undefined ? {} : { bindingTypes, bindingOf }),
  };
}

/** The variable name of a binding key: `name@file:line:column` for a closure's variable, else the name itself. */
function nameOf(key: string): string {
  return key.split("@")[0]!;
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
  // `target = a + b + ...` of list literals and variables, and the names any assignment gives a value.
  const sums: Array<[string, AstNode[]]> = [];
  const assigned = new Set<string>();
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
    assigned.add(name);
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
    // Groovy readLines(), split(text), and tokenize() give lists of text.
    if (value.kind === "methodCall" && textListCall(value)) {
      elements.set(name, (elements.get(name) ?? 0) | STRING);
      return;
    }
    // `a + b` of list variables and literals holds the elements of each, once every part is known to be a list.
    const parts = listSumParts(value);
    if (parts !== null && parts.length > 1) {
      sums.push([name, parts]);
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
    for (const [target, parts] of sums) {
      if (unknown.has(target)) continue;
      let type = 0;
      let ready = true;
      for (const part of parts) {
        const source = variableName(part);
        if (source === null) type |= itemsType(part);
        else if (unknown.has(source) || !assigned.has(source)) ready = false;
        else type |= elements.get(source) ?? 0;
      }
      if (!ready) {
        unknown.add(target);
        changed = true;
      } else if (
        type !== 0 &&
        (elements.get(target) ?? 0) !== ((elements.get(target) ?? 0) | type)
      ) {
        elements.set(target, (elements.get(target) ?? 0) | type);
        changed = true;
      }
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
  // A sum whose parts never became lists is no list of known elements.
  for (const [target, parts] of sums) {
    if (parts.some((part) => part.kind === "variable" && !elements.has(variableName(part) ?? "")))
      unknown.add(target);
  }
  for (const name of unknown) elements.delete(name);
  return elements;
}

/** `text.readLines()`, `text.split(separator)`, and `text.tokenize(...)`, which give lists of text. */
function textListCall(node: AstNode): boolean {
  const method = constantString(node.method);
  const args = asNode(node.arguments);
  const items = Array.isArray(args?.items) ? args.items.filter(isAstNode) : [];
  if (method === "readLines") return items.length === 0;
  // A collection's split(closure) gives two lists instead.
  if (method === "split") return items.length === 1 && items[0]!.kind !== "closure";
  return method === "tokenize" && items.every((item) => item.kind !== "closure");
}

/** The operands of `a + b + ...` when each is a list literal or a variable, as Groovy joins lists. */
function listSumParts(node: AstNode): AstNode[] | null {
  if (node.kind === "list" || node.kind === "variable") return [node];
  if (node.kind !== "binary" || node.operator !== "+") return null;
  const left = asNode(node.left);
  const right = asNode(node.right);
  const leftParts = left === null ? null : listSumParts(left);
  const rightParts = right === null ? null : listSumParts(right);
  if (leftParts === null || rightParts === null) return null;
  // At least one literal list or a sum of several parts: a single variable is an alias, handled above.
  return [...leftParts, ...rightParts];
}

interface Assignment {
  key: string;
  type: (environment: TypeEnvironment) => ValueType;
  placeholder?: true;
}

/** What collectAssignments records about the variables of a body, by binding key. */
interface AssignmentCollector {
  assignments: Assignment[];
  /** Bindings whose values are unknown: parameters, loop variables over unknown values, destructured names. */
  unknownKeys: Set<string>;
  /** The declared type of each declaration of a binding, or "untyped" for one whose type admits other values. */
  declarations: Map<string, Set<ValueType | "untyped">>;
  /** Closures whose parameter receives the elements of a list (`list.each { item -> }`), as a loop variable. */
  iterationClosures: Set<AstNode>;
  keys: VariableBindings;
}

/** Groovy collection methods that call their closure with each element of the receiver. */
const ITERATION_METHODS = new Set([
  "any",
  "collect",
  "count",
  "each",
  "eachWithIndex",
  "every",
  "find",
  "findAll",
  "sum",
]);

function collectAssignments(node: AstNode, collector: AssignmentCollector): void {
  const { assignments, unknownKeys, declarations, iterationClosures, keys } = collector;
  const keyOf = (target: unknown): string | null => {
    const name = variableName(target);
    return name === null || !isAstNode(target) ? null : (keys.bindingOf(target) ?? name);
  };
  const declare = (key: string, type: ValueType | "untyped"): void => {
    if (!declarations.has(key)) declarations.set(key, new Set());
    declarations.get(key)!.add(type);
  };
  if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) {
    const left = asNode(node.left);
    if (left?.kind === "arguments" && Array.isArray(left.items)) {
      // `def (a, b) = list` assigns each name an element whose type is not tracked.
      for (const item of left.items) {
        const key = keyOf(item);
        if (key !== null) unknownKeys.add(key);
      }
      return;
    }
    const key = keyOf(node.left);
    const value = asNode(node.right);
    if (key === null || value === null) return;
    if (node.kind === "declaration") declare(key, declaredType(left?.originType) ?? "untyped");
    if (value.kind === "unsupportedExpression") {
      // A declaration without initializer starts as null in Groovy.
      assignments.push({ key, type: () => NULL });
      return;
    }
    if (node.kind === "declaration" && value.kind === "constant" && value.value === "") {
      assignments.push({ key, type: () => STRING, placeholder: true });
      return;
    }
    assignments.push({ key, type: (environment) => inferType(value, environment) });
    return;
  }
  if (node.kind === "binary" && typeof node.operator === "string") {
    const key = keyOf(node.left);
    if (key === null) return;
    if (node.operator === "+=") {
      const right = asNode(node.right);
      assignments.push({
        key,
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
        key,
        type: (environment) =>
          binaryType(
            { kind: "binary", span: null, operator: "-", left: node.left, right },
            environment,
          ),
      });
    } else if (["*=", "/=", "%="].includes(node.operator)) {
      assignments.push({ key, type: () => NUMBER });
    }
    return;
  }
  if (node.kind === "postfix" || node.kind === "prefix") {
    const key = keyOf(node.value);
    if (key !== null) assignments.push({ key, type: () => NUMBER });
    return;
  }
  if (node.kind === "methodCall") {
    // The parameter of `list.each { item -> }` takes each element, as a loop variable does; `eachWithIndex` also
    // passes the position. A closure with other parameters, such as a map's `each { key, value -> }`, is not one.
    const method = constantString(node.method);
    const args = asNode(node.arguments);
    const closure = Array.isArray(args?.items) ? asNode(args.items.at(-1)) : null;
    const receiver = asNode(node.object);
    if (method === null || !ITERATION_METHODS.has(method) || closure?.kind !== "closure") return;
    if (receiver === null || node.implicitThis === true) return;
    const names =
      closure.parameterSpecified === true
        ? (groovyParameters(closure.parameters) ?? []).map((parameter) => parameter.name)
        : ["it"];
    if (names.length !== (method === "eachWithIndex" ? 2 : 1)) return;
    iterationClosures.add(closure);
    assignments.push({
      key: keys.parameterKey(closure, names[0]!),
      type: (environment) => elementsOf(receiver, environment),
    });
    if (names.length === 2)
      assignments.push({ key: keys.parameterKey(closure, names[1]!), type: () => NUMBER });
    return;
  }
  if (node.kind === "for" && typeof node.variable === "string") {
    const collection = asNode(node.collection);
    const key = keys.loopKey(node);
    if (collection?.kind === "range") assignments.push({ key, type: () => NUMBER });
    // A classic `for (;;)` loop has a dummy variable whose collection holds its three parts.
    else if (collection !== null && node.variable !== "forLoopDummyParameter")
      assignments.push({ key, type: (environment) => elementsOf(collection, environment) });
    else unknownKeys.add(key);
    return;
  }
  if (node.kind === "closure") {
    const iterated = iterationClosures.has(node);
    for (const parameter of Array.isArray(node.parameters) ? node.parameters : []) {
      if (!isRecord(parameter) || typeof parameter.name !== "string") continue;
      const key = keys.parameterKey(node, parameter.name);
      // A closure called with a value of another type than its declared parameter type failed in Groovy.
      const type = declaredType(parameter.type);
      if (type !== null) declare(key, type);
      else if (!iterated) unknownKeys.add(key);
    }
    if (node.parameterSpecified !== true && !iterated)
      unknownKeys.add(keys.parameterKey(node, "it"));
  }
}

/**
 * The values a Groovy declared type admits, for the types that matter to list and text methods: a list type or
 * Java array holds lists, and `String` holds text (or null). Null for other types, including `def` and `Object`.
 */
function declaredType(type: unknown): ValueType | null {
  if (typeof type !== "string") return null;
  const name = type.replace(/<.*>$/u, "").replace(/^java\.(?:util|lang)\./u, "");
  if (name.endsWith("[]") || name === "List" || name === "ArrayList" || name === "LinkedList")
    return LIST;
  return name === "String" ? STRING : null;
}

/** The type of the elements a loop or an iteration closure takes from a value: a list's elements, or unknown. */
function elementsOf(collection: AstNode, environment: TypeEnvironment): ValueType {
  if (collection.kind === "range") return NUMBER;
  if (collection.kind === "list")
    return (Array.isArray(collection.items) ? collection.items : []).reduce(
      (type: ValueType, item) => type | (isAstNode(item) ? inferType(item, environment) : UNKNOWN),
      0,
    );
  const type = inferType(collection, environment);
  if (!onlyOf(type, LIST | NULL) || (type & LIST) === 0) return UNKNOWN;
  return binaryType(
    {
      kind: "binary",
      span: null,
      operator: "[",
      left: collection,
      right: { kind: "constant", span: null, value: 0 },
    },
    environment,
  );
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
