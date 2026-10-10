import type { AstNode, SourceSpan } from "./ast.ts";
import { constantString, variableName, walkAst } from "./ast.ts";
import { asNode, children, mapChildren, nodeArray } from "./list-aliases.ts";

/** A local or parameter of a function that a closure value in it reads or sets (lowerClosureValue). */
export interface CapturedLocal {
  /** The function's body and the closure value, by spanKey. */
  body: string;
  closure: string;
  function: string;
  parameters: readonly string[];
  name: string;
}

export function spanKey(span: SourceSpan | null): string {
  return span === null ? "" : `${span.line}:${span.column}:${span.endLine}:${span.endColumn}`;
}

// Declared Groovy types whose variables start at 0 or false instead of null.
const ZERO_TYPES = new Set(["int", "long", "short", "byte", "double", "float", "boolean"]);
const TEXT_TYPES = new Set(["String", "java.lang.String"]);
// Declared collection types, which a script variable of that type holds as they were.
const COLLECTION_TYPES = /^(java\.util\.)?(List|ArrayList|Map|HashMap|LinkedHashMap)(<.*>)?$/u;
const ASSIGNING_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", "**="]);

/**
 * TeaseScript has no closures, so a closure value becomes a function of its own, which cannot see the locals of the
 * function it stood in (ShockQuiz's settings, whose `txt` each setting's closure set). Such a local becomes a script
 * variable instead, named after the function and the local, declared with its type before the top-level statement that
 * holds the function: its declaration in the function sets it where it had a value, or where its type starts at 0 or
 * false and something sets it again, and a parameter is copied into it as the function starts.
 *
 * One script variable holds what Groovy kept for each call of the function, so a local lifts only where no two calls
 * can share it: the closure value is a local of the function that the function only calls, and the function is one of
 * the script that nothing calls while it runs, as no function it calls calls it again and nothing takes it as a value;
 * a closure value inside a closure value needs the same of each. A local stays where a loop or another closure declares
 * it, which Groovy made anew on each pass, where it holds a closure, and where it has neither a declared type nor a
 * literal value, which a script variable, read after a call, could not show to hold a value; so do the other locals of
 * a closure value that captures such a local, which cannot convert anyway. `fresh` gives a new variable name.
 */
export function withLiftedLocals(
  body: AstNode,
  captured: readonly CapturedLocal[],
  fresh: (base: string) => string,
): AstNode {
  const lifts = plan(body, captured);
  if (body.kind !== "block" || lifts.size === 0) return body;
  const statements = nodeArray(body.statements).flatMap((statement) => {
    const hoisted: AstNode[] = [];
    const at: SourceSpan | null =
      statement.span === null
        ? null
        : { ...statement.span, endLine: statement.span.line, endColumn: statement.span.column };
    const rewrite = (node: AstNode): AstNode => {
      const lift =
        node.kind === "closure" ? lifts.get(spanKey(asNode(node.body)?.span ?? null)) : undefined;
      const changed = mapChildren(node, rewrite);
      const block = asNode(changed.body);
      if (lift === undefined || block?.kind !== "block") return changed;
      let lifted = block;
      for (const local of lift.locals) {
        const parameter = parameterType(node, local.name);
        const next = liftLocal(lifted, local, lift.function, parameter, fresh, at);
        lifted = next.body;
        hoisted.push(next.declaration);
      }
      return { ...changed, body: lifted };
    };
    const rewritten = rewrite(statement);
    return [...hoisted, rewritten];
  });
  return { ...body, statements };
}

/** The captured locals that withLiftedLocals lifts. */
export function liftableCaptures(
  body: AstNode,
  captured: readonly CapturedLocal[],
): CapturedLocal[] {
  return [...plan(body, captured).values()].flatMap((lift) => lift.locals);
}

/** A closure of the script, with the name a declaration or an assignment gives it, and the closure around it. */
interface Closure {
  node: AstNode;
  name: string | null;
  parent: Closure | null;
}

/** The locals to lift, one of each name, by the bodies of their functions, with the functions' names. */
function plan(
  body: AstNode,
  captured: readonly CapturedLocal[],
): Map<string, { function: string; locals: CapturedLocal[] }> {
  const lifts = new Map<string, { function: string; locals: CapturedLocal[] }>();
  if (captured.length === 0) return lifts;
  const closures: Closure[] = [];
  const visit = (node: AstNode, parent: Closure | null, name: string | null): void => {
    let inner = parent;
    if (node.kind === "closure") {
      inner = { node, name, parent };
      closures.push(inner);
    }
    const assigned = setName(node);
    const value = asNode(node.right);
    for (const child of children(node))
      visit(child, inner, assigned !== null && child === value ? assigned : null);
  };
  visit(body, null, null);
  const byBody = new Map(
    closures.map((item) => [spanKey(asNode(item.node.body)?.span ?? null), item]),
  );
  const byClosure = new Map(closures.map((item) => [spanKey(item.node.span), item]));
  const functions = new Map(
    closures.flatMap((item): Array<[string, Closure]> =>
      item.parent === null && item.name !== null ? [[item.name, item]] : [],
    ),
  );
  // The script's functions that something takes as a value, which may then call them at any time.
  const reads = valueReads(body);
  const taken = new Set([...reads].map(variableName).filter((name) => functions.has(name ?? "")));
  // Whether a function of the script may be called again while it runs: a function it calls calls it.
  const callees = new Map<string, Set<string>>();
  for (const [name, item] of functions) {
    const called = new Set<string>();
    walkAst(item.node, (node) => {
      const target = calledName(node) ?? variableName(node);
      if (target !== null && functions.has(target)) called.add(target);
    });
    callees.set(name, called);
  }
  const reentrant = (name: string): boolean => {
    const seen = new Set<string>();
    const pending = [...(callees.get(name) ?? [])];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (next === name) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(callees.get(next) ?? []));
    }
    return false;
  };
  // Whether only one call of a function can run at a time, so that one script variable can hold its locals.
  const once = (item: Closure): boolean => {
    if (item.name === null) return false;
    if (item.parent === null) return !taken.has(item.name) && !reentrant(item.name);
    let owner = item.parent;
    while (owner.name === null && owner.parent !== null) owner = owner.parent;
    return onlyCalled(owner.node, item) && once(owner);
  };
  const byFunction = new Map<string, CapturedLocal[]>();
  for (const local of captured)
    byFunction.set(local.body, [...(byFunction.get(local.body) ?? []), local]);
  for (const [key, locals] of byFunction) {
    const owner = byBody.get(key);
    const block = asNode(owner?.node.body);
    if (owner?.name == null || block?.kind !== "block" || !once(owner)) continue;
    // A closure value lifts its locals where the function only calls it and all of them lift.
    const stays = new Set(
      locals.flatMap((local) => {
        const closure = byClosure.get(local.closure);
        return closure !== undefined &&
          onlyCalled(owner.node, closure) &&
          liftable(block, local, parameterType(owner.node, local.name))
          ? []
          : [local.closure];
      }),
    );
    const names = new Set<string>();
    const kept = locals.filter((local) => {
      if (stays.has(local.closure) || names.has(local.name)) return false;
      names.add(local.name);
      return true;
    });
    if (kept.length > 0) lifts.set(key, { function: owner.name, locals: kept });
  }
  return lifts;
}

/** The variable a declaration or an assignment sets, or null for any other node. */
function setName(node: AstNode): string | null {
  return node.kind === "declaration" || (node.kind === "binary" && node.operator === "=")
    ? variableName(node.left)
    : null;
}

/**
 * The variable nodes that read a value: not the variable a declaration or an assignment sets, nor the receiver of
 * `.call(…)`, which calls the closure it holds.
 */
function valueReads(node: AstNode): Set<AstNode> {
  const skipped = new Set<AstNode>();
  const reads = new Set<AstNode>();
  walkAst(node, (child) => {
    const left = setName(child) === null ? null : asNode(child.left);
    if (left !== null) skipped.add(left);
    const object = child.kind === "methodCall" ? asNode(child.object) : null;
    if (object !== null && constantString(child.method) === "call") skipped.add(object);
    if (child.kind === "variable" && !skipped.has(child)) reads.add(child);
  });
  return reads;
}

/**
 * Whether a function only calls its local closure, `cb()` or `cb.call()`, and sets the variable to nothing else, so that
 * no call of the closure outlasts the function's call.
 */
function onlyCalled(owner: AstNode, closure: Closure): boolean {
  const name = closure.name;
  if (name === null) return false;
  let only = true;
  walkAst(owner, (node) => {
    if (setName(node) === name && asNode(node.right) !== closure.node) only = false;
  });
  for (const read of valueReads(owner)) if (variableName(read) === name) only = false;
  return only;
}

/** The name a call without a receiver calls, `f(…)`. */
function calledName(node: AstNode): string | null {
  return node.kind === "methodCall" && node.implicitThis === true
    ? constantString(node.method)
    : null;
}

/** The declared Groovy type of a closure's parameter, null for none or an untyped one. */
function parameterType(closure: AstNode, name: string): string | null {
  for (const parameter of Array.isArray(closure.parameters) ? closure.parameters : []) {
    if (typeof parameter !== "object" || parameter === null || !("name" in parameter)) continue;
    if (parameter.name !== name) continue;
    const type = "type" in parameter ? parameter.type : null;
    return typeof type === "string" && type !== "java.lang.Object" ? type : null;
  }
  return null;
}

/** Whether a local or parameter of the function whose body is `block` can be a script variable (withLiftedLocals). */
function liftable(block: AstNode, local: CapturedLocal, parameter: string | null): boolean {
  const { name } = local;
  if (name === "it") return false;
  let rebound = false;
  walkAst(block, (node) => {
    if (node.kind === "for" && node.variable === name) rebound = true;
    if (node.kind === "closure" && closureNames(node).includes(name)) rebound = true;
  });
  if (rebound) return false;
  // The declarations of the name, and whether a loop or closure in the function holds each.
  const declarations: Array<{ node: AstNode; nested: boolean }> = [];
  const find = (node: AstNode, nested: boolean): void => {
    if (node.kind === "declaration" && variableName(node.left) === name)
      declarations.push({ node, nested });
    const inner = nested || ["for", "while", "doWhile", "closure"].includes(node.kind);
    for (const child of children(node)) find(child, inner);
  };
  for (const child of children(block)) find(child, false);
  if (local.parameters.includes(name))
    return declarations.length === 0 && parameter !== null && typed(parameter);
  const [declared] = declarations;
  if (declarations.length !== 1 || declared === undefined || declared.nested) return false;
  if (declared.node.multipleAssignment === true) return false;
  const value = asNode(declared.node.right);
  const left = asNode(declared.node.left);
  const type = typeof left?.originType === "string" ? left.originType : "java.lang.Object";
  if (value?.kind === "closure") return false;
  if (type === "boolean") return false;
  if (value === null || isEmpty(value)) return ZERO_TYPES.has(type) || TEXT_TYPES.has(type);
  return literal(value) || typed(type);
}

/**
 * Whether a declared type keeps a script variable to values of that type. A `boolean` does not: the conversion writes
 * no truth for a number set to it, which a script variable would then hold where the local showed the old value.
 */
function typed(type: string): boolean {
  if (type === "boolean") return false;
  return ZERO_TYPES.has(type) || TEXT_TYPES.has(type) || COLLECTION_TYPES.test(type);
}

/** Whether a value is written out in full: a constant, or a list or map of such values. */
function literal(value: AstNode): boolean {
  if (value.kind === "constant") return true;
  if (value.kind === "list") return nodeArray(value.items).every(literal);
  if (value.kind === "map")
    return nodeArray(value.entries).every((entry) =>
      [asNode(entry.key), asNode(entry.value)].every((part) => part !== null && literal(part)),
    );
  return false;
}

/** The function's body with a local that can lift (liftable) as a script variable, and that variable's declaration. */
function liftLocal(
  block: AstNode,
  local: CapturedLocal,
  owner: string,
  parameter: string | null,
  fresh: (base: string) => string,
  at: SourceSpan | null,
): { body: AstNode; declaration: AstNode } {
  const { name } = local;
  let declared: AstNode | undefined;
  let writes = 0;
  walkAst(block, (node) => {
    if (node.kind === "declaration" && variableName(node.left) === name) declared = node;
    if (
      node.kind === "binary" &&
      ASSIGNING_OPERATORS.has(String(node.operator)) &&
      variableName(node.left) === name
    )
      writes += 1;
    if (
      (node.kind === "postfix" || node.kind === "prefix") &&
      variableName(children(node)[0]) === name
    )
      writes += 1;
  });
  const lifted = fresh(`${owner}${name.charAt(0).toUpperCase()}${name.slice(1)}`);
  const left = asNode(declared?.left);
  const type =
    parameter ?? (typeof left?.originType === "string" ? left.originType : "java.lang.Object");
  const assignment = (right: AstNode, span: SourceSpan | null): AstNode => ({
    kind: "expressionStatement",
    span,
    expression: {
      kind: "binary",
      span,
      operator: "=",
      left: { kind: "variable", span, name: lifted, type: "java.lang.Object" },
      right,
    },
  });
  const initial = asNode(declared?.right);
  // The declaration sets the variable where it had a value, or where its type starts at 0 or false and something sets
  // it again; a text without a value stays as the script variable starts.
  const set = (node: AstNode): AstNode[] => {
    const expression = node.kind === "expressionStatement" ? asNode(node.expression) : null;
    if (expression?.kind !== "declaration" || variableName(expression.left) !== lifted)
      return [mapBlocks(node, set)];
    const value = asNode(expression.right);
    if (value !== null && !isEmpty(value)) return [assignment(value, node.span)];
    return ZERO_TYPES.has(type) && writes > 0
      ? [assignment(startingValue(type, node.span), node.span)]
      : [];
  };
  const withValue = mapBlocks(rename(block, name, lifted), set);
  const copied = { kind: "variable", span: block.span, name, type: "java.lang.Object" };
  const result =
    parameter === null
      ? withValue
      : {
          ...withValue,
          statements: [assignment(copied, block.span), ...nodeArray(withValue.statements)],
        };
  const empty: AstNode = {
    kind: "unsupportedExpression",
    span: at,
    groovyType: "org.codehaus.groovy.ast.expr.EmptyExpression",
  };
  const declaration: AstNode = {
    kind: "expressionStatement",
    span: at,
    expression: {
      kind: "declaration",
      span: at,
      multipleAssignment: false,
      left: {
        ...(left ?? {}),
        kind: "variable",
        span: at,
        name: lifted,
        type: left?.type ?? "java.lang.Object",
        originType: type,
      },
      // A literal value is the script variable's from the start, so that it holds a value wherever it is read.
      right: initial !== null && !isEmpty(initial) && literal(initial) ? initial : empty,
    },
  };
  return { body: result, declaration };
}

/** The node with each block's statements replaced by `change`'s, in nested blocks too. */
function mapBlocks(node: AstNode, change: (statement: AstNode) => AstNode[]): AstNode {
  if (node.kind === "block")
    return { ...node, statements: nodeArray(node.statements).flatMap(change) };
  return mapChildren(node, (child) => mapBlocks(child, change));
}

/** The node with every variable and closure call named `name` named `lifted`; Groovy lets no closure rebind it. */
function rename(node: AstNode, name: string, lifted: string): AstNode {
  if (node.kind === "variable" && node.name === name) return { ...node, name: lifted };
  const changed = mapChildren(node, (child) => rename(child, name, lifted));
  if (calledName(changed) === name)
    return { ...changed, method: { ...asNode(changed.method)!, value: lifted } };
  return changed;
}

function closureNames(closure: AstNode): string[] {
  const parameters = Array.isArray(closure.parameters) ? closure.parameters : [];
  if (parameters.length === 0 && closure.parameterSpecified !== true) return ["it"];
  return parameters.map((parameter: unknown) =>
    typeof parameter === "object" && parameter !== null && "name" in parameter
      ? String(parameter.name)
      : "",
  );
}

function isEmpty(node: AstNode): boolean {
  return (
    node.kind === "unsupportedExpression" &&
    node.groovyType === "org.codehaus.groovy.ast.expr.EmptyExpression"
  );
}

function startingValue(type: string, span: SourceSpan | null): AstNode {
  return { kind: "constant", span, value: type === "boolean" ? false : 0 };
}
