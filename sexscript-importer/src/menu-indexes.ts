/**
 * List reads by a position that is certainly in range (#512 idiomatic output), which need neither the negative
 * position Groovy counted from the end nor the null it read past the end, and convert as a plain index:
 *
 * - `list[choice - 1]` after `choice = getSelectedValue(text, ["Back"] + list)`, where a test such as `choice > 0`
 *   rules out the written options before the list, or after a menu of a list that a loop built with one option for each
 *   element of the read list after its written options (`names = ["New"]; for (c in configs) names.add(c.name)`);
 * - `list[choice]` after `choice = getSelectedValue(text, list + ["Back"])`, where a test such as
 *   `choice == list.size()` rules out the one written option after the list, as DisciplineClinic's mistress menus;
 * - `list[i]` where `i` started at a whole number of at least 0, only grew by whole numbers since, and a test such as
 *   `i < list.size()` holds, as in `while (i < list.size()) { ... list[i] ...; i++ }`.
 *
 * Facts hold along a block in order, and end where code may change the position, the length of the list, or anything
 * at all, as a call of the script's own function may; a list that another variable, a collection, or a call may share
 * never has them.
 */
import { constantString, isAstNode, variableName, walkAst, type AstNode } from "./ast.ts";
import { asNode } from "./java-ast.ts";
import { SEXSCRIPT_API_METHODS } from "./sexscript-api.ts";

interface Facts {
  /** The least value of each position, a whole number. */
  least: Map<string, number>;
  /** For each position, the lists it stays below: `position - offset < list.size()`, by list. */
  below: Map<string, Map<string, number>>;
  /** Lists that hold `prefix` written options and then one for each element of `list` (`list` null before the loop). */
  options: Map<string, { prefix: number; list: string | null }>;
}

/** The operator with the position on the left: `0 < position` is `position > 0`. */
const MIRRORED: Readonly<Record<string, string>> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** Methods that only read a list. */
const READING_METHODS = new Set([
  "any",
  "collect",
  "contains",
  "count",
  "each",
  "eachWithIndex",
  "every",
  "find",
  "findAll",
  "findIndexOf",
  "first",
  "get",
  "getAt",
  "indexOf",
  "isEmpty",
  "join",
  "last",
  "lastIndexOf",
  "max",
  "min",
  "size",
  "sum",
  "toString",
]);

/** The index reads of a script body, and of the closures in it, that are certainly in range. */
export function menuIndexes(body: AstNode): Set<AstNode> {
  const shared = sharedNames(body);
  const safe = new Set<AstNode>();
  const bodies: AstNode[] = [body];
  walkAst(body, (node) => {
    if (node.kind === "closure" && isAstNode(node.body)) bodies.push(node.body);
  });
  for (const item of bodies) statements(item, empty(), shared, safe);
  return safe;
}

function empty(): Facts {
  return { least: new Map(), below: new Map(), options: new Map() };
}

/** Follows a block's statements in order. */
function statements(
  block: AstNode,
  facts: Facts,
  shared: ReadonlySet<string>,
  safe: Set<AstNode>,
): void {
  const items = block.kind === "block" ? list(block.statements) : [block];
  for (const statement of items) step(statement, facts, shared, safe);
}

function step(
  statement: AstNode,
  facts: Facts,
  shared: ReadonlySet<string>,
  safe: Set<AstNode>,
): void {
  switch (statement.kind) {
    case "block":
      statements(statement, facts, shared, safe);
      return;
    case "expressionStatement": {
      const expression = asNode(statement.expression);
      if (expression !== null) expressionStep(expression, facts, shared, safe);
      return;
    }
    case "if": {
      const condition = asNode(statement.condition);
      const changes = changed(statement);
      if (condition !== null) {
        const tested = changed(condition);
        if (!tested.anything) mark(condition, facts, safe);
        const base = copy(facts);
        forget(base, tested);
        const then = asNode(statement.then);
        const otherwise = asNode(statement.else);
        if (then !== null) statements(then, guarded(base, condition, true), shared, safe);
        if (otherwise !== null)
          statements(otherwise, guarded(base, condition, false), shared, safe);
      }
      forget(facts, changes);
      return;
    }
    case "while":
    case "for": {
      const counted = countedLoop(statement);
      // `for (int i = 0; i < n; i++)`: the start runs once, before the loop.
      if (counted !== null && counted.start !== null)
        expressionStep(counted.start, facts, shared, safe);
      // A loop repeats, so only facts that nothing in it changes hold inside it, and its test holds at its start.
      const changes = changed(counted === null ? statement : counted.repeated);
      const inside = copy(facts);
      forget(inside, changes);
      const test =
        statement.kind === "while" ? asNode(statement.condition) : (counted?.test ?? null);
      const loopBody = asNode(statement.body);
      if (loopBody !== null)
        statements(loopBody, test === null ? inside : guarded(inside, test, true), shared, safe);
      const unfilled = [...facts.options].filter(([, options]) => options.list === null);
      forget(facts, changes);
      if (statement.kind === "for" && counted === null) built(statement, unfilled, facts, shared);
      return;
    }
    case "switch": {
      // A case runs on into the next one without a break, after the changes of the cases before it.
      const subject = asNode(statement.expression);
      const before = copy(facts);
      if (subject !== null) {
        const tested = changed(subject);
        if (!tested.anything) mark(subject, facts, safe);
        forget(before, tested);
      }
      for (const branch of [...list(statement.cases), asNode(statement.default)]) {
        const branchBody = asNode(branch?.body) ?? (branch?.kind === "block" ? branch : null);
        if (branchBody === null) continue;
        statements(branchBody, copy(before), shared, safe);
        forget(before, changed(branchBody));
      }
      forget(facts, changed(statement));
      return;
    }
    default:
      forget(facts, changed(statement));
  }
}

/** An expression statement: its reads, then its writes, then what it teaches. */
function expressionStep(
  expression: AstNode,
  facts: Facts,
  shared: ReadonlySet<string>,
  safe: Set<AstNode>,
): void {
  const changes = changed(expression);
  // Reads come before the statement's own writes, unless it may call anything that changes the lists first.
  if (!changes.anything) mark(expression, facts, safe);
  forget(facts, changes);
  learn(expression, facts, shared);
}

/** The start, test, and repeated parts of a counted `for (start; test; update)` loop, or null for another loop. */
function countedLoop(
  loop: AstNode,
): { start: AstNode | null; test: AstNode | null; repeated: AstNode[] } | null {
  const parts = loop.kind === "for" ? asNode(loop.collection) : null;
  if (parts?.kind !== "list" || loop.variable !== "forLoopDummyParameter") return null;
  const [start, test, update] = list(parts.items);
  return {
    start: start ?? null,
    test: test ?? null,
    repeated: [test, update, asNode(loop.body)].filter((part): part is AstNode => isAstNode(part)),
  };
}

/** Marks the in-range reads of an expression, outside the closures in it, which may run later. */
function mark(expression: AstNode, facts: Facts, safe: Set<AstNode>): void {
  outsideClosures(expression, (node) => {
    if (node.kind !== "binary" || node.operator !== "[") return;
    const listName = variableName(node.left);
    const index = asNode(node.right);
    if (listName === null || index === null) return;
    // `list[position]` or `list[position - offset]`.
    const subtracted = index.kind === "binary" && index.operator === "-";
    const position = variableName(subtracted ? index.left : index);
    const offset = subtracted ? asNode(index.right)?.value : 0;
    if (position === null || typeof offset !== "number" || !Number.isInteger(offset)) return;
    const least = facts.least.get(position);
    const bound = facts.below.get(position)?.get(listName);
    if (least !== undefined && least >= offset && bound !== undefined && bound <= offset)
      safe.add(node);
  });
}

/** Facts after `position = getSelectedValue(text, options)`, `i = 0`, or `options = ["Back"]`. */
function learn(expression: AstNode, facts: Facts, shared: ReadonlySet<string>): void {
  const assigns =
    expression.kind === "declaration" ||
    (expression.kind === "binary" && expression.operator === "=");
  const target = assigns ? variableName(expression.left) : null;
  const value = assigns ? asNode(expression.right) : null;
  if (target === null || value === null) return;
  const start = value.kind === "constant" ? value.value : undefined;
  if (typeof start === "number" && Number.isInteger(start) && start >= 0) {
    facts.least.set(target, start);
    return;
  }
  const written = writtenOptions(value);
  if (written !== null && !shared.has(target))
    facts.options.set(target, { prefix: written, list: null });
  if (value.kind !== "methodCall" || constantString(value.method) !== "getSelectedValue") return;
  const options = list(asNode(value.arguments)?.items)[1];
  if (options === undefined) return;
  let menu: { list: string; offset: number } | null = null;
  // `["Back"] + list`: the written options, then the list's elements; `list + ["Back"]`: the list's elements, whose
  // positions stay below its size plus the written options'.
  if (options.kind === "binary" && options.operator === "+") {
    const prefix = writtenOptions(asNode(options.left));
    const menuList = variableName(options.right);
    const suffix = writtenOptions(asNode(options.right));
    const listedFirst = variableName(options.left);
    if (prefix !== null && menuList !== null && !shared.has(menuList))
      menu = { list: menuList, offset: prefix };
    else if (suffix !== null && listedFirst !== null && !shared.has(listedFirst))
      menu = { list: listedFirst, offset: suffix };
  } else {
    const built = facts.options.get(variableName(options) ?? "");
    if (built !== undefined && built.list !== null)
      menu = { list: built.list, offset: built.prefix };
  }
  if (menu === null) return;
  facts.least.set(target, 0);
  facts.below.set(target, new Map([[menu.list, menu.offset]]));
}

/** A loop over a list that gives an options list from before it one option for each of its elements. */
function built(
  loop: AstNode,
  unfilled: ReadonlyArray<[string, { prefix: number; list: string | null }]>,
  facts: Facts,
  shared: ReadonlySet<string>,
): void {
  const source = variableName(loop.collection);
  const loopBody = asNode(loop.body);
  const items =
    loopBody?.kind === "block" ? list(loopBody.statements) : loopBody === null ? [] : [loopBody];
  if (source === null || shared.has(source) || items.length === 0) return;
  for (const [name, options] of unfilled) {
    // One statement adds exactly one option, unconditionally; nothing else in the loop changes either list.
    const adds = items.filter((item) => appendsOne(item, name));
    const others = items.filter((item) => !adds.includes(item));
    if (
      adds.length === 1 &&
      others.every((item) => {
        const changes = changed(item);
        return !changes.anything && !changes.names.has(name) && !changes.names.has(source);
      }) &&
      !items.some((item) => leaves(item))
    )
      facts.options.set(name, { prefix: options.prefix, list: source });
  }
}

/** `options.add(text)`, `options << text`, or `options += [text]`. */
function appendsOne(statement: AstNode, name: string): boolean {
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  if (expression === null) return false;
  if (expression.kind === "methodCall")
    return (
      variableName(expression.object) === name &&
      constantString(expression.method) === "add" &&
      list(asNode(expression.arguments)?.items).length === 1 &&
      !changed(asNode(expression.arguments)!).anything
    );
  if (expression.kind !== "binary" || variableName(expression.left) !== name) return false;
  const value = asNode(expression.right);
  if (value === null || changed(value).anything) return false;
  if (expression.operator === "<<") return true;
  return expression.operator === "+=" && value.kind === "list" && list(value.items).length === 1;
}

/** Whether a loop body may leave a pass early. */
function leaves(statement: AstNode): boolean {
  let found = false;
  walkAst(statement, (node) => {
    if (["break", "continue", "return", "throw"].includes(node.kind)) found = true;
  });
  return found;
}

/** A list literal of written options, without spread elements: their number. */
function writtenOptions(node: AstNode | null): number | null {
  if (node?.kind !== "list") return null;
  const items = list(node.items);
  return items.every((item) => item.kind === "constant" || item.kind === "gstring")
    ? items.length
    : null;
}

/**
 * The facts inside a branch of `if (condition)` or a loop with that test: a test of a position against a number
 * raises its least value, and `i < list.size()` keeps it below the list's size.
 */
function guarded(facts: Facts, condition: AstNode, holds: boolean): Facts {
  const inside = copy(facts);
  const tests = holds ? conjuncts(condition) : [condition];
  for (const test of tests) {
    if (test.kind !== "binary") continue;
    const operator = String(test.operator);
    const left = variableName(test.left);
    const right = variableName(test.right);
    const name = left ?? right;
    if (name === null || !inside.least.has(name)) continue;
    // `0 < position` reads as `position > 0`.
    const relation = left !== null ? operator : (MIRRORED[operator] ?? operator);
    const other = asNode(left !== null ? test.right : test.left);
    const sized = other === null ? null : sizeOf(other);
    if (sized !== null) {
      // `i < list.size()`, or `i <= list.size() - 1`.
      if (holds && relation === "<" && sized.minus === 0) below(inside, name, sized.list, 0);
      if (holds && relation === "<=" && sized.minus === 1) below(inside, name, sized.list, 0);
      // `i != list.size()` where `i` stays below the size plus one, as after one written option behind the list.
      const unequal = (holds && relation === "!=") || (!holds && relation === "==");
      if (unequal && sized.minus === 0 && inside.below.get(name)?.get(sized.list) === 1)
        below(inside, name, sized.list, 0);
      continue;
    }
    const number = other?.value;
    if (typeof number !== "number") continue;
    const least = inside.least.get(name)!;
    let next = least;
    if (holds) {
      if (relation === ">") next = Math.max(least, Math.floor(number) + 1);
      else if (relation === ">=") next = Math.max(least, Math.ceil(number));
      else if (relation === "!=" && number === least) next = least + 1;
    } else if (relation === "==" && number === least) next = least + 1;
    else if (relation === "<") next = Math.max(least, Math.ceil(number));
    else if (relation === "<=") next = Math.max(least, Math.floor(number) + 1);
    inside.least.set(name, next);
  }
  return inside;
}

function below(facts: Facts, name: string, listName: string, offset: number): void {
  const lists = new Map(facts.below.get(name) ?? []);
  lists.set(listName, Math.min(offset, lists.get(listName) ?? offset));
  facts.below.set(name, lists);
}

/** `list.size()`, `list.length`, or either minus a number: the list and the number. */
function sizeOf(node: AstNode): { list: string; minus: number } | null {
  if (node.kind === "binary" && node.operator === "-") {
    const inner = asNode(node.left);
    const minus = asNode(node.right)?.value;
    const sized = inner === null ? null : sizeOf(inner);
    return sized === null || typeof minus !== "number"
      ? null
      : { list: sized.list, minus: sized.minus + minus };
  }
  if (node.kind === "methodCall" && constantString(node.method) === "size") {
    const listName = variableName(node.object);
    return listName === null || list(asNode(node.arguments)?.items).length > 0
      ? null
      : { list: listName, minus: 0 };
  }
  if (
    node.kind === "property" &&
    ["size", "length"].includes(constantString(node.property) ?? "")
  ) {
    const listName = variableName(node.object);
    return listName === null ? null : { list: listName, minus: 0 };
  }
  return null;
}

/** The tests a condition joins with `&&`. */
function conjuncts(condition: AstNode): AstNode[] {
  if (condition.kind === "binary" && condition.operator === "&&")
    return [asNode(condition.left), asNode(condition.right)].flatMap((side) =>
      side === null ? [] : conjuncts(side),
    );
  return [condition];
}

interface Changes {
  /** Variables that the code may give another value or another length. */
  names: Set<string>;
  /** Variables that the code only increases by whole numbers (`i++`, `i += 1`). */
  increased: Set<string>;
  /** Whether the code may change anything, as a call of the script's own function or a closure may. */
  anything: boolean;
}

/** What code may change. */
function changed(code: unknown): Changes {
  const names = new Set<string>();
  const increased = new Set<string>();
  let anything = false;
  walkAst(code, (node) => {
    if (node.kind === "postfix" || node.kind === "prefix") {
      const name = variableName(node.value);
      if (name !== null) (node.operator === "++" ? increased : names).add(name);
      return;
    }
    if (node.kind === "declaration") {
      const name = variableName(node.left);
      if (name !== null) names.add(name);
      for (const item of list(asNode(node.left)?.items)) {
        const part = variableName(item);
        if (part !== null) names.add(part);
      }
      return;
    }
    if (node.kind === "binary") {
      const operator = String(node.operator);
      const assigns =
        operator === "<<" ||
        (operator.endsWith("=") && !["==", "!=", "<=", ">=", "==="].includes(operator));
      if (!assigns) return;
      // An element write past the end of a list makes it longer.
      const target = asNode(node.left);
      const name = variableName(
        target?.kind === "binary" && target.operator === "[" ? target.left : target,
      );
      if (name === null) return;
      const step = asNode(node.right)?.value;
      if (operator === "+=" && typeof step === "number" && Number.isInteger(step) && step >= 0)
        increased.add(name);
      else names.add(name);
      return;
    }
    if (node.kind !== "methodCall") return;
    const method = constantString(node.method);
    const receiver = variableName(node.object);
    const passesThis = list(asNode(node.arguments)?.items).some(
      (item) => variableName(item) === "this",
    );
    const api =
      (node.implicitThis === true || receiver === "main") &&
      method !== null &&
      SEXSCRIPT_API_METHODS.has(method);
    if ((node.implicitThis === true && !api) || method === "call" || passesThis) anything = true;
    else if (receiver !== null && !api && !READING_METHODS.has(method ?? "")) names.add(receiver);
  });
  for (const name of names) increased.delete(name);
  return { names, increased, anything };
}

/** Forgets the facts that changed code ends. */
function forget(facts: Facts, changes: Changes): void {
  if (changes.anything) {
    facts.least.clear();
    facts.below.clear();
    facts.options.clear();
    return;
  }
  for (const name of [...changes.names, ...changes.increased]) facts.below.delete(name);
  for (const name of changes.names) facts.least.delete(name);
  for (const [name, lists] of facts.below)
    if ([...lists.keys()].some((listName) => changes.names.has(listName))) {
      const kept = new Map([...lists].filter(([listName]) => !changes.names.has(listName)));
      facts.below.set(name, kept);
    }
  for (const [name, options] of facts.options)
    if (changes.names.has(name) || (options.list !== null && changes.names.has(options.list)))
      facts.options.delete(name);
}

function copy(facts: Facts): Facts {
  return {
    least: new Map(facts.least),
    below: new Map([...facts.below].map(([name, lists]) => [name, new Map(lists)])),
    options: new Map(facts.options),
  };
}

/**
 * Variables whose list something else may share: assigned to or from another variable, put in a collection, returned,
 * or passed to a call that is not the SexScript API, which may keep it or change it.
 */
function sharedNames(body: AstNode): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const whole: Array<AstNode | null> = [];
    if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")) {
      whole.push(asNode(node.right));
      const target = variableName(node.left);
      if (target !== null && variableName(node.right) !== null) names.add(target);
    } else if (node.kind === "list") whole.push(...list(node.items));
    else if (node.kind === "map")
      whole.push(...list(node.entries).map((entry) => asNode(entry.value)));
    else if (node.kind === "return") whole.push(asNode(node.value));
    else if (node.kind === "methodCall") {
      const method = constantString(node.method);
      const api = method !== null && SEXSCRIPT_API_METHODS.has(method);
      if (!api) whole.push(...list(asNode(node.arguments)?.items));
    }
    for (const value of whole) {
      const name = variableName(value);
      if (name !== null) names.add(name);
    }
  });
  return names;
}

function outsideClosures(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) outsideClosures(item, visit);
    return;
  }
  if (!isAstNode(value) || value.kind === "closure") return;
  visit(value);
  for (const child of Object.values(value))
    if (typeof child === "object") outsideClosures(child, visit);
}

function list(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isAstNode) : [];
}
