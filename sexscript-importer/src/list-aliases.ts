import type { AstNode } from "./ast.ts";
import { constantString, isAstNode, variableName, walkAst } from "./ast.ts";

// List and map methods that change their receiver in place.
const CHANGING_METHODS = new Set([
  "add",
  "addAll",
  "clear",
  "leftShift",
  "pop",
  "push",
  "put",
  "putAll",
  "remove",
  "removeAll",
  "removeAt",
  "removeIf",
  "retainAll",
  "set",
  "shuffle",
  "sort",
]);
// Of those, the ones that only append, which leave the positions of the elements there are as they were.
const APPENDING_METHODS = new Set(["add", "addAll", "leftShift"]);
// Of those, the ones the conversion writes for an element read through its list as well as for a variable.
const INDEXED_METHODS = new Set(["add", "addAll", "clear", "leftShift", "pop", "remove"]);
// Static methods of java.util.Collections that change the list they get first in place.
const COLLECTIONS_METHODS = new Set(["fill", "reverse", "rotate", "shuffle", "sort", "swap"]);
const ASSIGNING_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<="]);
const COMPOUND_OPERATORS = new Map([
  ["+=", "+"],
  ["-=", "-"],
  ["*=", "*"],
  ["/=", "/"],
  ["%=", "%"],
]);

/**
 * Groovy lists are shared references, so a change through an element read or an iterated item changed the list it
 * came from, where TeaseScript lists are values (ADR 0014) and the change would stay in a copy (PainStacks' stacks,
 * whose session never ended). The changed element is read through its list instead:
 * - a loop over a list variable whose body changes the item, `for (st in stacks) st[0] = true` or `stacks.each { st ->
 *   st.add(x) }`, goes through the positions of the list and reads the item as `stacks[stIndex]`, where the body
 *   neither sets the item nor the list, nor changes the list's length or order;
 * - a variable that only ever takes elements of one list, `stack = stacks[i]`, and that its scope changes, keeps the
 *   element's position instead, `stackIndex = i`, and reads the element as `stacks[stackIndex]`, where the scope does
 *   not set the list again or move its elements; one that starts empty or null, `List stack = []`, qualifies where each
 *   use follows a statement of its block that takes an element, so the starting value is never used.
 * Neither applies to a list whose slots the script replaces anywhere, `rows[0] = [5]`, after which the element taken
 * before is no longer in the list, nor where the item or variable gets a changing method that the conversion writes for
 * a variable only, such as `push`. A compound change through the element, `row[0] += 1`, is written out,
 * `rows[rowIndex][0] = rows[rowIndex][0] + 1`, where its positions are plain values.
 * `fresh` gives a new variable name.
 */
export function withListAliasesAsPaths(body: AstNode, fresh: (base: string) => string): AstNode {
  const negative = negativeNames(body);
  const movers = closureMoves(body);
  const replaced = new Set([
    ...replacedSlots(body),
    ...sharedLists(body),
    ...escapingMoves(body, movers),
  ]);
  return scope(loops(body, fresh, replaced, movers), fresh, negative, replaced, movers);
}

/** The list variables whose slots the body replaces or moves anywhere: `rows[0] = [5]`, `rows.set(…)`, a swap. */
function replacedSlots(body: AstNode): Set<string> {
  const names = new Set<string>();
  walkAst(body, (node) => {
    const left = node.kind === "binary" ? asNode(node.left) : null;
    if (
      node.kind === "binary" &&
      ASSIGNING_OPERATORS.has(String(node.operator)) &&
      left?.kind === "binary" &&
      left.operator === "[" &&
      variableName(left.left) !== null
    )
      names.add(variableName(left.left)!);
    const list = movedByCollections(node);
    if (list !== null) names.add(list);
    const method = node.kind === "methodCall" ? constantString(node.method) : null;
    if (
      (method === "set" || method === "putAt" || method === "swap") &&
      variableName(node.object) !== null
    )
      names.add(variableName(node.object)!);
  });
  return names;
}

type Moves = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * For each closure of the script, the list variables that it, or a closure it calls, sets again, empties, or moves the
 * elements of, other than by appending: a call of it may run while an element taken from such a list is in use.
 */
function closureMoves(body: AstNode): Map<string, Set<string>> {
  const closures = new Map<string, AstNode>();
  walkAst(body, (node) => {
    const name =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")
        ? variableName(node.left)
        : null;
    const value = asNode(node.right);
    if (name !== null && value?.kind === "closure") closures.set(name, value);
  });
  const direct = new Map<string, Set<string>>();
  const called = new Map<string, Set<string>>();
  for (const [name, closure] of closures) {
    const moved = new Set<string>();
    const calls = new Set<string>();
    walkAst(closure, (node) => {
      const set =
        node.kind === "binary" && ASSIGNING_OPERATORS.has(String(node.operator))
          ? variableName(node.left)
          : null;
      if (set !== null) moved.add(set);
      const method = node.kind === "methodCall" ? constantString(node.method) : null;
      const appends =
        method !== null &&
        APPENDING_METHODS.has(method) &&
        nodeArray(asNode(node.arguments)?.items).length === 1;
      const receiver = node.kind === "methodCall" ? variableName(node.object) : null;
      if (method !== null && CHANGING_METHODS.has(method) && !appends && receiver !== null)
        moved.add(receiver);
      const sorted = movedByCollections(node);
      if (sorted !== null) moved.add(sorted);
      const callee = calledClosure(node);
      if (callee !== null && closures.has(callee)) calls.add(callee);
    });
    direct.set(name, moved);
    called.set(name, calls);
  }
  const moves = new Map<string, Set<string>>();
  for (const name of closures.keys()) {
    const moved = new Set<string>();
    const seen = new Set<string>();
    const pending = [name];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      direct.get(next)?.forEach((list) => moved.add(list));
      pending.push(...(called.get(next) ?? []));
    }
    moves.set(name, moved);
  }
  return moves;
}

/**
 * The lists that a closure the script may call by another name moves: one that is not a variable's value, as a map's or
 * a list's, or whose variable the script reads as a value, which a call through another name or a map may reach unseen.
 */
function escapingMoves(body: AstNode, movers: Moves): Set<string> {
  const lists = new Set<string>();
  const named = new Set<AstNode>();
  const reads = new Set<string>();
  walkAst(body, (node) => {
    const name =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")
        ? variableName(node.left)
        : null;
    const value = asNode(node.right);
    if (name !== null && value?.kind === "closure") named.add(value);
    if (name !== null && value?.kind === "variable" && movers.has(variableName(value) ?? ""))
      reads.add(variableName(value)!);
    if (node.kind === "list")
      nodeArray(node.items).forEach((item) => reads.add(variableName(item) ?? ""));
    if (node.kind === "map")
      nodeArray(node.entries).forEach((entry) =>
        reads.add(variableName(asNode(entry.value)) ?? ""),
      );
    if (node.kind === "methodCall")
      nodeArray(asNode(node.arguments)?.items).forEach((item) =>
        reads.add(variableName(item) ?? ""),
      );
  });
  for (const name of reads) movers.get(name)?.forEach((list) => lists.add(list));
  // An anonymous closure, such as a map's, moves its lists wherever it may be called.
  walkAst(body, (node) => {
    if (node.kind !== "closure" || named.has(node)) return;
    walkAst(node, (child) => {
      const method = child.kind === "methodCall" ? constantString(child.method) : null;
      const appends =
        method !== null &&
        APPENDING_METHODS.has(method) &&
        nodeArray(asNode(child.arguments)?.items).length === 1;
      const receiver = child.kind === "methodCall" ? variableName(child.object) : null;
      if (method !== null && CHANGING_METHODS.has(method) && !appends && receiver !== null)
        lists.add(receiver);
      const set =
        child.kind === "binary" && ASSIGNING_OPERATORS.has(String(child.operator))
          ? variableName(child.left)
          : null;
      if (set !== null) lists.add(set);
      const sorted = movedByCollections(child);
      if (sorted !== null) lists.add(sorted);
    });
  });
  return lists;
}

/** The closure a node calls by name, `f(…)` or `f.call(…)`, or null. */
function calledClosure(node: AstNode): string | null {
  if (node.kind !== "methodCall") return null;
  const method = constantString(node.method);
  if (node.implicitThis === true) return method;
  return method === "call" ? variableName(node.object) : null;
}

/** Whether the node calls a closure that may set `list` again, empty it, or move its elements (closureMoves). */
function callsMoving(node: AstNode, list: string, movers: Moves): boolean {
  let found = false;
  walkAst(node, (child) => {
    const callee = calledClosure(child);
    if (callee !== null && movers.get(callee)?.has(list) === true) found = true;
  });
  return found;
}

/**
 * The list variables that the script also reaches under another name, which may then replace or move their slots
 * unseen: set to another variable, put into a list or a map, passed to a function of the script or added to another
 * list, or returned.
 */
function sharedLists(body: AstNode): Set<string> {
  const functions = new Set<string>();
  walkAst(body, (node) => {
    if (node.kind === "declaration" && asNode(node.right)?.kind === "closure") {
      const name = variableName(node.left);
      if (name !== null) functions.add(name);
    }
  });
  const names = new Set<string>();
  const shared = (value: AstNode | null): void => {
    const name = variableName(value);
    if (name !== null) names.add(name);
  };
  walkAst(body, (node) => {
    if (node.kind === "declaration" || (node.kind === "binary" && node.operator === "="))
      shared(asNode(node.right));
    if (node.kind === "list") nodeArray(node.items).forEach(shared);
    if (node.kind === "map")
      nodeArray(node.entries).forEach((entry) => shared(asNode(entry.value)));
    if (node.kind === "return") shared(asNode(node.value));
    if (node.kind === "methodCall") {
      const method = constantString(node.method) ?? "";
      const passes =
        (node.implicitThis === true && functions.has(method)) ||
        ["add", "push", "put", "leftShift", "addAll", "call"].includes(method);
      if (passes) nodeArray(asNode(node.arguments)?.items).forEach(shared);
    }
    if (node.kind === "binary" && node.operator === "<<") shared(asNode(node.right));
  });
  return names;
}

/** The list variable a `Collections.shuffle(list)`, `sort`, `swap`, or other changing static call changes. */
function movedByCollections(node: AstNode): string | null {
  if (node.kind !== "methodCall" || !COLLECTIONS_METHODS.has(constantString(node.method) ?? ""))
    return null;
  const receiver = asNode(node.object);
  const owner =
    receiver?.kind === "classExpression" ? String(receiver.type ?? "") : variableName(receiver);
  if (owner === null || !/(^|\.)Collections$/u.test(owner)) return null;
  return variableName(nodeArray(asNode(node.arguments)?.items)[0]);
}

/**
 * Whether the node calls a changing method on the variable itself that the conversion writes for a variable only, which
 * reading the element through its list would lose (`row.push(7)`), or changes it with a static Collections call.
 */
function variableOnlyChange(node: AstNode, name: string): boolean {
  let found = false;
  walkAst(node, (child) => {
    const method = child.kind === "methodCall" ? constantString(child.method) : null;
    if (
      method !== null &&
      CHANGING_METHODS.has(method) &&
      !INDEXED_METHODS.has(method) &&
      variableName(child.object) === name
    )
      found = true;
    if (movedByCollections(child) === name) found = true;
  });
  return found;
}

/**
 * Whether a compound change through the variable, `row[0] += 1`, has a position that is no plain value, which writing
 * it out would compute twice.
 */
function computedCompound(node: AstNode, name: string): boolean {
  let found = false;
  walkAst(node, (child) => {
    if (child.kind !== "binary" || !COMPOUND_OPERATORS.has(String(child.operator))) return;
    const left = asNode(child.left);
    if (left === null || left.kind === "variable" || rootName(left) !== name) return;
    if (!plainPositions(left)) found = true;
  });
  return found;
}

/**
 * Whether every position in an element or property chain, `rows[i][0]`, is a variable or a number of at least 0, which
 * reading it twice reads the same and which an element read through its list can take.
 */
function plainPositions(target: AstNode): boolean {
  for (let at: AstNode | null = target; at !== null && at.kind !== "variable";) {
    if (at.kind === "binary") {
      const position = asNode(at.right);
      const plain =
        position === null ||
        position.kind === "variable" ||
        (position.kind === "constant" &&
          (typeof position.value !== "number" || position.value >= 0));
      if (!plain) return false;
      at = asNode(at.left);
    } else at = asNode(at.object);
  }
  return true;
}

/**
 * Whether the node writes an element of the variable at a negative position, `row[-1] += 1`, which Groovy counted from
 * the end and which the conversion writes for a variable, not for an element read through its list; a read converts.
 */
function negativeAccess(node: AstNode, name: string): boolean {
  let found = false;
  const negativeTarget = (target: AstNode | null): boolean => {
    for (let at = target; at !== null && at.kind !== "variable";) {
      if (at.kind !== "binary" || at.operator !== "[") return false;
      const position = asNode(at.right);
      const left = asNode(at.left);
      if (
        variableName(left) === name &&
        (position?.kind === "unaryMinus" ||
          (position?.kind === "constant" &&
            typeof position.value === "number" &&
            position.value < 0))
      )
        return true;
      at = left;
    }
    return false;
  };
  walkAst(node, (child) => {
    if (child.kind === "binary" && ASSIGNING_OPERATORS.has(String(child.operator)))
      if (negativeTarget(asNode(child.left))) found = true;
    if ((child.kind === "postfix" || child.kind === "prefix") && negativeTarget(firstChild(child)))
      found = true;
  });
  return found;
}

/** The node with each compound change through `list`'s elements written out: `a[i][0] += 1` as `a[i][0] = a[i][0] + 1`. */
function plainCompounds(node: AstNode, list: string): AstNode {
  const changed = mapChildren(node, (child) => plainCompounds(child, list));
  const operator =
    changed.kind === "binary" ? COMPOUND_OPERATORS.get(String(changed.operator)) : undefined;
  const left = asNode(changed.left);
  if (
    operator === undefined ||
    left === null ||
    left.kind === "variable" ||
    rootName(left) !== list ||
    !plainPositions(left)
  )
    return changed;
  return {
    ...changed,
    operator: "=",
    right: { kind: "binary", span: changed.span, operator, left, right: changed.right },
  };
}

/**
 * The variables that may hold a negative number: one set to a negative number, or to a variable that may hold one
 * (`colIndex = unfairColIndex` after `unfairColIndex = -1`, PainStacks), by name.
 */
function negativeNames(body: AstNode): Set<string> {
  const values = new Map<string, AstNode[]>();
  walkAst(body, (node) => {
    const assigned =
      node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")
        ? variableName(node.left)
        : null;
    const value = asNode(node.right);
    if (assigned !== null && value !== null)
      values.set(assigned, [...(values.get(assigned) ?? []), value]);
  });
  const negative = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, assigned] of values)
      if (!negative.has(name) && assigned.some((value) => mayBeNegative(value, negative))) {
        negative.add(name);
        changed = true;
      }
  }
  return negative;
}

/**
 * Whether a position may be negative: anything but a number of at least 0, a variable that never holds a negative one,
 * a size or a length, a random draw, or a sum or product of those.
 */
function mayBeNegative(value: AstNode, negative: ReadonlySet<string>): boolean {
  if (value.kind === "constant") return typeof value.value !== "number" || value.value < 0;
  const name = variableName(value);
  if (name !== null) return negative.has(name);
  if (value.kind === "property" && constantString(value.property) === "length") return false;
  if (value.kind === "methodCall") {
    const method = constantString(value.method);
    const random =
      method === "getRandom" &&
      asNode(value.object)?.kind === "variable" &&
      value.implicitThis === true;
    return !(method === "size" || method === "length" || random);
  }
  if (value.kind === "binary" && (value.operator === "+" || value.operator === "*"))
    return (
      mayBeNegative(asNode(value.left)!, negative) || mayBeNegative(asNode(value.right)!, negative)
    );
  return true;
}

/**
 * Groovy's multiple assignment, `(a, b) = list`, set each variable to the element at its position, null past the end;
 * it becomes one assignment per variable from the list kept in a new variable, each read marked `tupleItem` for a read
 * that gives null past the end (enforced_chastity's server state). The declaring form, `def (a, b) = list`, converts
 * as a declaration.
 */
export function withTupleAssignments(body: AstNode, fresh: (base: string) => string): AstNode {
  const expand = (statement: AstNode): AstNode[] | null => {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const assigned =
      expression?.kind === "binary" &&
      expression.operator === "=" &&
      asNode(expression.left)?.kind === "tuple";
    const value = asNode(expression?.right);
    if (expression === null || value === null || !assigned) return null;
    const targets = nodeArray(asNode(expression.left)?.items);
    if (targets.length === 0) return null;
    const span = statement.span;
    const values = fresh("values");
    const item = (position: number): AstNode => ({
      kind: "binary",
      span,
      operator: "[",
      left: variable(values, span),
      right: constant(position, span),
      tupleItem: true,
    });
    const keep: AstNode = {
      kind: "expressionStatement",
      span,
      expression: {
        kind: "declaration",
        span,
        multipleAssignment: false,
        left: variable(values, span),
        right: value,
      },
    };
    return [
      keep,
      ...targets.map((target, position): AstNode => ({
        kind: "expressionStatement",
        span,
        expression: { kind: "binary", span, operator: "=", left: target, right: item(position) },
      })),
    ];
  };
  const rewrite = (node: AstNode): AstNode => {
    if (node.kind === "block")
      return {
        ...node,
        statements: nodeArray(node.statements).flatMap(
          (statement) => expand(statement) ?? [rewrite(statement)],
        ),
      };
    const expanded = expand(node);
    if (expanded !== null) return { kind: "block", span: node.span, statements: expanded };
    return mapChildren(node, rewrite);
  };
  return rewrite(body);
}

/** Rewrites the loops over a list that change their item, everywhere in the node. */
function loops(
  node: AstNode,
  fresh: (base: string) => string,
  replaced: ReadonlySet<string>,
  movers: Moves,
): AstNode {
  const result = mapChildren(node, (child) => loops(child, fresh, replaced, movers));
  if (result.kind === "for") {
    const list = asNode(result.collection);
    const item = typeof result.variable === "string" ? result.variable : null;
    const body = asNode(result.body);
    if (list?.kind !== "variable" || item === null || body === null) return result;
    if (replaced.has(variableName(list)!) || callsMoving(body, variableName(list)!, movers))
      return result;
    return itemLoop(result, variableName(list)!, item, body, fresh) ?? result;
  }
  if (result.kind === "expressionStatement") {
    const call = asNode(result.expression);
    if (call?.kind !== "methodCall" || constantString(call.method) !== "each") return result;
    const list = asNode(call.object);
    const items = nodeArray(asNode(call.arguments)?.items);
    const closure = items.length === 1 ? items[0]! : null;
    if (list?.kind !== "variable" || closure?.kind !== "closure") return result;
    const parameters = closureParameters(closure);
    const body = asNode(closure.body);
    // A `return` in the closure went on with the next element, which a loop would have to write otherwise.
    if (parameters.length !== 1 || body === null || returnsInPlace(body)) return result;
    if (replaced.has(variableName(list)!) || callsMoving(body, variableName(list)!, movers))
      return result;
    return itemLoop(result, variableName(list)!, parameters[0]!, body, fresh) ?? result;
  }
  return result;
}

/** `for (index in 0..<list.size()) body` with the item read through the list, or null where the rule does not apply. */
function itemLoop(
  loop: AstNode,
  list: string,
  item: string,
  body: AstNode,
  fresh: (base: string) => string,
): AstNode | null {
  if (!changes(body, item) || sets(body, item) || sets(body, list) || moves(body, list, false))
    return null;
  if (
    declares(body, list) ||
    variableOnlyChange(body, item) ||
    computedCompound(body, item) ||
    negativeAccess(body, item)
  )
    return null;
  const span = loop.span;
  const index = fresh(`${item}Index`);
  const element = (at: AstNode["span"]): AstNode => ({
    kind: "binary",
    span: at,
    operator: "[",
    left: variable(list, at),
    right: variable(index, at),
  });
  return {
    kind: "for",
    span,
    variable: index,
    collection: {
      kind: "range",
      span,
      from: constant(0, span),
      to: {
        kind: "methodCall",
        span,
        object: variable(list, span),
        method: { kind: "constant", span, value: "size" },
        arguments: { kind: "arguments", span, items: [] },
        implicitThis: false,
        safe: false,
        spreadSafe: false,
      },
      inclusive: false,
    },
    body: plainCompounds(substitute(body, item, element), list),
  };
}

/** Rewrites the element variables of the script body and of each closure body, each its own scope. */
function scope(
  node: AstNode,
  fresh: (base: string) => string,
  negative: ReadonlySet<string>,
  replaced: ReadonlySet<string>,
  movers: Moves,
): AstNode {
  const nested = mapChildren(node, (child) => scope(child, fresh, negative, replaced, movers));
  const block =
    nested.kind === "closure" ? asNode(nested.body) : nested.kind === "block" ? nested : null;
  if (block?.kind !== "block") return nested;
  let rewritten = block;
  for (const statement of nodeArray(block.statements)) {
    const declared = declaration(statement);
    if (declared === null) continue;
    rewritten =
      elementVariable(
        rewritten,
        declared.name,
        declared.value,
        fresh,
        negative,
        replaced,
        movers,
      ) ?? rewritten;
  }
  if (rewritten === block) return nested;
  return nested.kind === "closure" ? { ...nested, body: rewritten } : rewritten;
}

/** The block with an element variable read through its list, or null where the rule does not apply. */
function elementVariable(
  block: AstNode,
  name: string,
  initial: AstNode | null,
  fresh: (base: string) => string,
  negative: ReadonlySet<string>,
  replaced: ReadonlySet<string>,
  movers: Moves,
): AstNode | null {
  // Every write takes an element of one list variable; a closure that reads the variable keeps it.
  let list: string | null = null;
  let valid = true;
  const takes = (value: AstNode | null): boolean => {
    if (value?.kind !== "binary" || value.operator !== "[") return false;
    const source = variableName(value.left);
    if (source === null || (list !== null && source !== list)) return false;
    list = source;
    return true;
  };
  const placeholder =
    initial === null ||
    (initial.kind === "constant" && initial.value === null) ||
    (initial.kind === "list" && nodeArray(initial.items).length === 0);
  if (!placeholder && !takes(initial)) return null;
  walkOutsideClosures(block, (node, inClosure) => {
    if (inClosure && variableName(node) === name) valid = false;
    if (inClosure) return;
    if (node.kind === "binary" && ASSIGNING_OPERATORS.has(String(node.operator))) {
      if (variableName(node.left) === name && (node.operator !== "=" || !takes(asNode(node.right))))
        valid = false;
    }
    if ((node.kind === "postfix" || node.kind === "prefix") && rootName(firstChild(node)) === name)
      valid = false;
  });
  if (!valid || list === null || !changes(block, name)) return null;
  const source: string = list;
  if (sets(block, source, true) || moves(block, source, true) || closureDeclares(block, source))
    return null;
  if (
    replaced.has(source) ||
    callsMoving(block, source, movers) ||
    variableOnlyChange(block, name) ||
    computedCompound(block, name) ||
    negativeAccess(block, name)
  )
    return null;
  if (placeholder && !usesFollowTakes(block, name, source)) return null;
  const index = fresh(`${name}Index`);
  // A position that may be negative counted from the end in Groovy, which the kept position does from there on:
  // `if (stackIndex < 0) stackIndex = stacks.size() + stackIndex`.
  const fromEnd = (span: AstNode["span"]): AstNode => ({
    kind: "if",
    span,
    condition: {
      kind: "binary",
      span,
      operator: "<",
      left: variable(index, span),
      right: constant(0, span),
    },
    then: {
      kind: "expressionStatement",
      span,
      expression: {
        kind: "binary",
        span,
        operator: "=",
        left: variable(index, span),
        right: {
          kind: "binary",
          span,
          operator: "+",
          left: sizeOf(source, span),
          right: variable(index, span),
        },
      },
    },
    else: { kind: "empty", span },
  });
  // The statements a take becomes: the kept position, and where it may be negative, the count from the end.
  const takeStatements = (statement: AstNode): AstNode[] | null => {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const taken =
      expression?.kind === "declaration" ||
      (expression?.kind === "binary" && expression.operator === "=")
        ? expression
        : null;
    if (taken === null || variableName(taken.left) !== name) return null;
    const right = asNode(taken.right);
    const position =
      right?.kind === "binary" && right.operator === "[" ? asNode(right.right) : null;
    const kept = { ...statement, expression: rewrite(taken) };
    return position !== null && mayBeNegative(position, negative)
      ? [kept, fromEnd(statement.span)]
      : [kept];
  };
  const rewrite = (node: AstNode): AstNode => {
    if (node.kind === "closure") return node;
    if (node.kind === "block")
      return {
        ...node,
        statements: nodeArray(node.statements).flatMap(
          (statement) => takeStatements(statement) ?? [rewrite(statement)],
        ),
      };
    if (node.kind === "expressionStatement") {
      const statements = takeStatements(node);
      if (statements !== null && statements.length > 1)
        return { kind: "block", span: node.span, statements };
    }
    if (node.kind === "declaration" && variableName(node.left) === name) {
      const right = asNode(node.right);
      const position =
        right?.kind === "binary" && right.operator === "["
          ? asNode(right.right)!
          : constant(0, node.span);
      return { ...node, left: variable(index, node.span), right: rewrite(position) };
    }
    if (node.kind === "binary" && node.operator === "=" && variableName(node.left) === name) {
      const right = asNode(node.right)!;
      return { ...node, left: variable(index, node.span), right: rewrite(asNode(right.right)!) };
    }
    if (variableName(node) === name)
      return {
        kind: "binary",
        span: node.span,
        operator: "[",
        left: variable(source, node.span),
        right: variable(index, node.span),
      };
    return mapChildren(node, rewrite);
  };
  // The block's own statements take the position as theirs, so that a declaration stays in the block.
  return plainCompounds(rewrite(block), source);
}

/**
 * Whether every use of a variable that starts empty follows, in a block that holds it, a statement of that block that
 * takes an element of the list, so that its starting value is never used.
 */
function usesFollowTakes(block: AstNode, name: string, list: string): boolean {
  const take = (statement: AstNode): AstNode | null => {
    const expression =
      statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
    const right = asNode(expression?.right);
    return expression?.kind === "binary" &&
      expression.operator === "=" &&
      variableName(expression.left) === name &&
      right?.kind === "binary" &&
      right.operator === "[" &&
      variableName(right.left) === list
      ? right
      : null;
  };
  let valid = true;
  const visit = (node: AstNode, covered: boolean): void => {
    if (node.kind === "closure") return;
    if (node.kind === "block") {
      let taken = covered;
      for (const statement of nodeArray(node.statements)) {
        const element = take(statement);
        if (element !== null) {
          // The position is read before the variable is set.
          const position = asNode(element.right);
          if (position !== null) visit(position, taken);
          taken = true;
        } else visit(statement, taken);
      }
      return;
    }
    if (node.kind === "declaration" && variableName(node.left) === name) {
      const right = asNode(node.right);
      if (right !== null) visit(right, covered);
      return;
    }
    if (variableName(node) === name && !covered) valid = false;
    for (const child of children(node)) visit(child, covered);
  };
  visit(block, false);
  return valid;
}

/** Whether the node changes what `name` holds in place: an element or property write, or a changing method. */
function changes(node: AstNode, name: string): boolean {
  let found = false;
  walkAst(node, (child) => {
    if (child.kind === "binary" && ASSIGNING_OPERATORS.has(String(child.operator))) {
      const left = asNode(child.left);
      if (left !== null && left.kind !== "variable" && rootName(left) === name) found = true;
    }
    if (child.kind === "binary" && child.operator === "<<" && rootName(asNode(child.left)) === name)
      found = true;
    if (
      child.kind === "methodCall" &&
      CHANGING_METHODS.has(constantString(child.method) ?? "") &&
      rootName(asNode(child.object)) === name
    )
      found = true;
  });
  return found;
}

/** Whether the node sets the variable itself, `name = …`, or declares it; `declared` allows one declaration. */
function sets(node: AstNode, name: string, declared = false): boolean {
  let found = false;
  let declarations = 0;
  walkAst(node, (child) => {
    if (child.kind === "declaration" && variableName(child.left) === name) declarations += 1;
    if (
      child.kind === "binary" &&
      ASSIGNING_OPERATORS.has(String(child.operator)) &&
      variableName(child.left) === name
    )
      found = true;
  });
  return found || declarations > (declared ? 1 : 0);
}

/** Whether the node changes a list's length or order in place, other than by appending where `append` allows it. */
function moves(node: AstNode, name: string, append: boolean): boolean {
  let found = false;
  walkAst(node, (child) => {
    const method = child.kind === "methodCall" ? constantString(child.method) : null;
    // `add(position, value)` inserts, which moves the elements after it.
    const appends =
      append &&
      method !== null &&
      APPENDING_METHODS.has(method) &&
      nodeArray(asNode(child.arguments)?.items).length === 1;
    if (
      method !== null &&
      CHANGING_METHODS.has(method) &&
      variableName(child.object) === name &&
      !appends
    )
      found = true;
    if (movedByCollections(child) === name) found = true;
    if (
      child.kind === "binary" &&
      child.operator === "<<" &&
      variableName(child.left) === name &&
      !append
    )
      found = true;
  });
  return found;
}

/** Whether the node declares `name`, as a variable or a closure parameter. */
function declares(node: AstNode, name: string): boolean {
  let found = false;
  walkAst(node, (child) => {
    if (child.kind === "declaration" && variableName(child.left) === name) found = true;
    if (child.kind === "closure" && closureParameters(child).includes(name)) found = true;
  });
  return found;
}

/** Whether a closure in the node declares `name` as a parameter or a variable of its own. */
function closureDeclares(node: AstNode, name: string): boolean {
  let found = false;
  walkAst(node, (child) => {
    if (child.kind === "closure" && declares(child, name)) found = true;
  });
  return found;
}

/** Whether a closure body returns from itself, outside closures nested in it. */
function returnsInPlace(body: AstNode): boolean {
  let found = false;
  walkOutsideClosures(body, (node, inClosure) => {
    if (!inClosure && node.kind === "return") found = true;
  });
  return found;
}

/** Visits every node below `node`, telling whether it stands in a closure nested in `node`. */
function walkOutsideClosures(
  node: AstNode,
  visit: (node: AstNode, inClosure: boolean) => void,
): void {
  const walk = (current: AstNode, inClosure: boolean): void => {
    visit(current, inClosure);
    const nested = inClosure || current.kind === "closure";
    for (const child of children(current)) walk(child, nested);
  };
  for (const child of children(node)) walk(child, false);
}

/** The variable at the root of an element or property chain, `stack[i][0]` or `stack.done`. */
function rootName(node: AstNode | null): string | null {
  let current = node;
  while (current !== null) {
    if (current.kind === "variable") return variableName(current);
    if (current.kind === "binary" && current.operator === "[") current = asNode(current.left);
    else if (current.kind === "property") current = asNode(current.object);
    else return null;
  }
  return null;
}

/** The node with every read of `name` replaced, except in closures that declare a parameter of that name. */
function substitute(
  node: AstNode,
  name: string,
  replacement: (span: AstNode["span"]) => AstNode,
): AstNode {
  if (variableName(node) === name) return replacement(node.span);
  if (node.kind === "closure" && closureParameters(node).includes(name)) return node;
  return mapChildren(node, (child) => substitute(child, name, replacement));
}

/** A top-level declaration statement's variable name and value. */
function declaration(statement: AstNode): { name: string; value: AstNode | null } | null {
  const expression = statement.kind === "expressionStatement" ? asNode(statement.expression) : null;
  if (expression?.kind !== "declaration" || expression.multipleAssignment === true) return null;
  const name = variableName(expression.left);
  return name === null ? null : { name, value: asNode(expression.right) };
}

function closureParameters(closure: AstNode): string[] {
  const parameters = Array.isArray(closure.parameters) ? closure.parameters : [];
  if (parameters.length === 0 && closure.parameterSpecified !== true) return ["it"];
  return parameters.map((parameter: unknown) =>
    String(isRecordWithName(parameter) ? parameter.name : ""),
  );
}

function isRecordWithName(value: unknown): value is { name: unknown } {
  return typeof value === "object" && value !== null && "name" in value;
}

function firstChild(node: AstNode): AstNode | null {
  return children(node)[0] ?? null;
}

function sizeOf(list: string, span: AstNode["span"]): AstNode {
  return {
    kind: "methodCall",
    span,
    object: variable(list, span),
    method: { kind: "constant", span, value: "size" },
    arguments: { kind: "arguments", span, items: [] },
    implicitThis: false,
    safe: false,
    spreadSafe: false,
  };
}

function variable(name: string, span: AstNode["span"]): AstNode {
  return { kind: "variable", span, name, type: "java.lang.Object" };
}

function constant(value: number, span: AstNode["span"]): AstNode {
  return { kind: "constant", span, value };
}

function asNode(value: unknown): AstNode | null {
  return isAstNode(value) ? value : null;
}

function nodeArray(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isAstNode) : [];
}

function children(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "span") continue;
    if (isAstNode(value)) result.push(value);
    else if (Array.isArray(value)) result.push(...value.filter(isAstNode));
  }
  return result;
}

/** The node with each child node replaced by `change`; arrays of nodes are followed. */
function mapChildren(node: AstNode, change: (child: AstNode) => AstNode): AstNode {
  let changed = false;
  const mapNode = (value: AstNode): AstNode => {
    const next = change(value);
    if (next !== value) changed = true;
    return next;
  };
  const result: AstNode = { ...node };
  for (const [key, value] of Object.entries(node)) {
    if (key === "span") continue;
    // Statement and item lists hold nodes; other values, such as parameter records, stay as they are.
    if (isAstNode(value)) result[key] = mapNode(value);
    else if (Array.isArray(value))
      result[key] = value.map((item: unknown) => (isAstNode(item) ? mapNode(item) : item));
  }
  return changed ? result : node;
}
