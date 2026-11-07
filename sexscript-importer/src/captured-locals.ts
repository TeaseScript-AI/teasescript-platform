import type { AstNode, SourceSpan } from "./ast.ts";
import { constantString, variableName, walkAst } from "./ast.ts";
import { asNode, children, mapChildren, nodeArray } from "./list-aliases.ts";

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

/** The captured locals that withPassedLocals passes or withLiftedLocals lifts. */
export function liftableCaptures(
  body: AstNode,
  captured: readonly CapturedLocal[],
  lifts = true,
): CapturedLocal[] {
  const passes = passPlan(body, captured);
  const rest = captured.filter((local) => !passes.has(local.closure));
  return [
    ...[...passes.values()].flatMap((pass) => pass.locals),
    ...(lifts ? [...plan(body, rest).values()].flatMap((lift) => lift.locals) : []),
  ];
}

/**
 * A closure value that only reads the locals it captures, and that its function only calls, gets them as parameters
 * instead: each call passes them as they are where it calls (fight_arena's menu, whose `args` reads the player's choice
 * of the list it was given, in a function that its own actions call again). The closure must change none of them,
 * through itself or a closure of the function that it calls, so that its reads see what the call passed; and each
 * call must pass all of its parameters. Returns the body and the captured locals that the other closures keep, which
 * withLiftedLocals may lift.
 */
export function withPassedLocals(
  body: AstNode,
  captured: readonly CapturedLocal[],
): { body: AstNode; rest: CapturedLocal[] } {
  const passes = passPlan(body, captured);
  const rest = captured.filter((local) => !passes.has(local.closure));
  if (passes.size === 0) return { body, rest };
  const owners = new Map<string, Map<string, Pass>>();
  for (const pass of passes.values())
    owners.set(pass.owner, new Map([...(owners.get(pass.owner) ?? []), [pass.name, pass]]));
  const parameter = (
    name: string,
    type = "java.lang.Object",
  ): { name: string; type: string; default: null } => ({ name, type, default: null });
  // The calls of the passed closures of a function, outside the closures in it, pass the locals.
  const addArguments = (current: AstNode, calls: ReadonlyMap<string, Pass>): AstNode => {
    if (current.kind === "closure") return current;
    const next = mapChildren(current, (child) => addArguments(child, calls));
    const called = calledClosure(next);
    const pass = called === null ? undefined : calls.get(called);
    if (pass === undefined) return next;
    const list = asNode(next.arguments);
    const items = nodeArray(list?.items);
    const span = next.span;
    const passed = [
      ...(pass.implicit && items.length === 0 ? [{ kind: "constant", span, value: null }] : []),
      ...items,
      ...pass.names.map((name) => ({ kind: "variable", span, name, type: "java.lang.Object" })),
    ];
    return { ...next, arguments: { ...(list ?? { kind: "arguments", span }), items: passed } };
  };
  const rewrite = (node: AstNode): AstNode => {
    let changed = mapChildren(node, rewrite);
    if (node.kind !== "closure") return changed;
    const calls = owners.get(spanKey(node.span));
    const block = asNode(changed.body);
    if (calls !== undefined && block !== null)
      changed = { ...changed, body: addArguments(block, calls) };
    const pass = passes.get(spanKey(node.span));
    if (pass === undefined) return changed;
    const implicit = node.parameterSpecified !== true;
    return {
      ...changed,
      parameterSpecified: true,
      // Every call passes every parameter, so a default the closure gave one is never used.
      parameters: [
        ...(implicit
          ? [parameter("it")]
          : (Array.isArray(node.parameters) ? node.parameters : []).map((item: unknown) =>
              typeof item === "object" && item !== null ? { ...item, default: null } : item,
            )),
        // A local's declared type is its parameter's, which the calls then do not give it.
        ...pass.names.map((name) => parameter(name, pass.types.get(name))),
      ],
    };
  };
  return { body: rewrite(body), rest };
}

interface Pass {
  /** The function's closure, by spanKey. */
  owner: string;
  name: string;
  implicit: boolean;
  names: string[];
  /** The declared Groovy types of the locals that have one. */
  types: ReadonlyMap<string, string>;
  locals: CapturedLocal[];
}

/** The closure values that get their captured locals as parameters (withPassedLocals), by spanKey. */
function passPlan(body: AstNode, captured: readonly CapturedLocal[]): Map<string, Pass> {
  const passes = new Map<string, Pass>();
  if (captured.length === 0) return passes;
  const closures = closuresOf(body);
  const byBody = new Map(
    closures.map((item) => [spanKey(asNode(item.node.body)?.span ?? null), item]),
  );
  const byClosure = new Map(closures.map((item) => [spanKey(item.node.span), item]));
  const byKey = new Map<string, CapturedLocal[]>();
  for (const local of captured)
    byKey.set(local.closure, [...(byKey.get(local.closure) ?? []), local]);
  for (const [key, locals] of byKey) {
    const closure = byClosure.get(key);
    const owner = byBody.get(locals[0]!.body);
    if (closure?.name == null || owner === undefined || !onlyCalled(owner.node, closure)) continue;
    const names = [...new Set(locals.map((local) => local.name))];
    if (names.includes("it")) continue;
    // The closure changes none of them, and calls no closure of its function, which might.
    const ownClosures = new Set(
      closures.flatMap((item) => (item.parent === owner && item.name !== null ? [item.name] : [])),
    );
    let safe = names.every((name) => !changesName(closure.node, name));
    walkAst(closure.node, (node) => {
      const callee = calledClosure(node);
      if (callee !== null && (ownClosures.has(callee) || callee === owner.name)) safe = false;
    });
    // Every call passes all of the closure's parameters, outside the closures of the function.
    const implicit = closure.node.parameterSpecified !== true;
    const count = Array.isArray(closure.node.parameters) ? closure.node.parameters.length : 0;
    let calls = 0;
    walkOutsideOwn(owner.node, (node, nested) => {
      if (calledClosure(node) !== closure.name) return;
      calls += 1;
      const passed = nodeArray(asNode(node.arguments)?.items).length;
      if (nested || (implicit ? passed > 1 : passed !== count)) safe = false;
    });
    if (!safe || calls === 0) continue;
    const types = new Map<string, string>();
    for (const name of names) {
      const declared = declaredType(owner.node, name);
      if (declared !== null) types.set(name, declared);
    }
    passes.set(key, {
      owner: spanKey(owner.node.span),
      name: closure.name,
      implicit,
      names,
      types,
      locals,
    });
  }
  return passes;
}

/** The declared Groovy type of a function's parameter or local, where it has one and declares it once. */
function declaredType(owner: AstNode, name: string): string | null {
  const parameter = parameterType(owner, name);
  if (parameter !== null) return parameter;
  const types: string[] = [];
  walkOutsideOwn(owner, (node, nested) => {
    const left = node.kind === "declaration" ? asNode(node.left) : null;
    if (nested || left === null || variableName(left) !== name) return;
    types.push(typeof left.originType === "string" ? left.originType : "java.lang.Object");
  });
  const [type] = types;
  return types.length === 1 && type !== undefined && type !== "java.lang.Object" ? type : null;
}

/** Visits every node below a closure, telling whether it stands in a closure nested in it. */
function walkOutsideOwn(closure: AstNode, visit: (node: AstNode, nested: boolean) => void): void {
  const walk = (node: AstNode, nested: boolean): void => {
    visit(node, nested);
    for (const child of children(node)) walk(child, nested || node.kind === "closure");
  };
  for (const child of children(asNode(closure.body) ?? closure)) walk(child, false);
}

/** Whether the node sets `name`, changes it by `++` or `--`, or changes an element or a field of it, or by a method. */
function changesName(node: AstNode, name: string): boolean {
  let found = false;
  const rooted = (target: AstNode | null): boolean => {
    let at = target;
    while (at !== null && at.kind !== "variable")
      at =
        at.kind === "binary" && at.operator === "["
          ? asNode(at.left)
          : at.kind === "property"
            ? asNode(at.object)
            : null;
    return at !== null && variableName(at) === name;
  };
  walkAst(node, (child) => {
    if (child.kind === "binary" && ASSIGNING_OPERATORS.has(String(child.operator)))
      if (rooted(asNode(child.left))) found = true;
    if (child.kind === "declaration" && variableName(child.left) === name) found = true;
    if ((child.kind === "postfix" || child.kind === "prefix") && rooted(children(child)[0] ?? null))
      found = true;
    if (child.kind === "binary" && child.operator === "<<" && rooted(asNode(child.left)))
      found = true;
    if (
      child.kind === "methodCall" &&
      CHANGING_METHODS.has(constantString(child.method) ?? "") &&
      rooted(asNode(child.object))
    )
      found = true;
  });
  return found;
}

/** The closure a node calls by name, `f(…)` or `f.call(…)`, or null. */
function calledClosure(node: AstNode): string | null {
  if (node.kind !== "methodCall") return null;
  if (node.implicitThis === true) return constantString(node.method);
  return constantString(node.method) === "call" ? variableName(node.object) : null;
}

/** The closures of the script, with the names a declaration or an assignment gives them and the closures around them. */
function closuresOf(body: AstNode): Closure[] {
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
  return closures;
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
  const closures = closuresOf(body);
  const byBody = new Map(
    closures.map((item) => [spanKey(asNode(item.node.body)?.span ?? null), item]),
  );
  const byClosure = new Map(closures.map((item) => [spanKey(item.node.span), item]));
  const functions = new Map(
    closures.flatMap((item): Array<[string, Closure]> =>
      item.parent === null && item.name !== null ? [[item.name, item]] : [],
    ),
  );
  // The script's functions that something takes as a value, which may then call them at any time; that a closure
  // without a name calls, such as one kept in a map; or whose name the script binds more than once.
  const reads = valueReads(body);
  const taken = new Set([...reads].map(variableName).filter((name) => functions.has(name ?? "")));
  for (const item of closures)
    if (item.name === null && item.parent === null)
      walkAst(item.node, (node) => {
        const target = calledName(node) ?? calledClosure(node);
        if (target !== null && functions.has(target)) taken.add(target);
      });
  const bindings = new Map<string, number>();
  walkAst(body, (node) => {
    const name = setName(node);
    if (name !== null) bindings.set(name, (bindings.get(name) ?? 0) + 1);
  });
  for (const name of functions.keys()) if ((bindings.get(name) ?? 0) > 1) taken.add(name);
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
    // A closure value lifts its locals where the function only calls it and all of them lift; a local lifts only where
    // every closure value that captures it may lift it, as one that escapes would read the next call's.
    const fails = (local: CapturedLocal): boolean => {
      const closure = byClosure.get(local.closure);
      return (
        closure === undefined ||
        !onlyCalled(owner.node, closure) ||
        !liftable(block, local, parameterType(owner.node, local.name))
      );
    };
    const failedNames = new Set(locals.filter(fails).map((local) => local.name));
    const stays = new Set(
      locals.flatMap((local) =>
        fails(local) || failedNames.has(local.name) ? [local.closure] : [],
      ),
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
  // A text parameter may be null where it is read after a call, which a script variable cannot show; the closure gets
  // it as a parameter instead, where it only reads it (withPassedLocals).
  if (local.parameters.includes(name))
    return (
      declarations.length === 0 &&
      parameter !== null &&
      typed(parameter) &&
      !TEXT_TYPES.has(parameter)
    );
  // Groovy lets a function declare a name again only in a block apart from the first, such as another `case`; each
  // declaration then sets the one script variable where it stands (liftLocal), so they must agree on its type.
  if (declarations.length === 0) return false;
  const types = new Set(declarations.map(({ node }) => originType(node)));
  if (types.size !== 1) return false;
  return declarations.every(({ node, nested }) => {
    if (nested || node.multipleAssignment === true) return false;
    const value = asNode(node.right);
    const type = originType(node);
    if (value?.kind === "closure") return false;
    if (type === "boolean") return false;
    // A text without a value starts as the empty text, as the conversion starts such a local (liftLocal), except where
    // the function tells null apart, which a local the conversion keeps as null shows.
    if (value === null || isEmpty(value))
      return ZERO_TYPES.has(type) || (TEXT_TYPES.has(type) && !nullTested(block, name));
    // A text set to a computed value may be null where it is read after a call, as above.
    if (TEXT_TYPES.has(type)) return literal(value);
    if (typed(type)) return true;
    // Untyped declarations agree where their values are constants of one kind.
    return literal(value) && (declarations.length === 1 || constantKinds(declarations).size === 1);
  });
}

/**
 * The function body with the name renamed where it is one of its locals: after one of its declarations, inside that
 * declaration's block, as a variable or an implicit call. A use outside, or before a declaration in its block, is a
 * script variable of the same name and stays. A body that declares no such local (a lifted parameter) renames every
 * use.
 */
function renameLocal(block: AstNode, name: string, lifted: string): AstNode {
  // The block that holds each declaration of the name, with where the declaration starts.
  const scopes = new Map<AstNode, Array<{ line: number; column: number }>>();
  const place = (node: AstNode, ancestors: readonly AstNode[]): void => {
    if (node.kind === "declaration" && variableName(node.left) === name) {
      const holder = [...ancestors].reverse().find((ancestor) => ancestor.kind === "block");
      const span = node.span;
      if (holder !== undefined && span !== null && span !== undefined)
        scopes.set(holder, [
          ...(scopes.get(holder) ?? []),
          { line: span.line, column: span.column },
        ]);
    }
    for (const child of children(node)) place(child, [...ancestors, node]);
  };
  place(block, []);
  if (scopes.size === 0) return rename(block, name, lifted);
  const after = (span: AstNode["span"], start: { line: number; column: number }): boolean =>
    span !== null &&
    span !== undefined &&
    (span.line > start.line || (span.line === start.line && span.column >= start.column));
  const scoped = (node: AstNode, ancestors: readonly AstNode[]): AstNode => {
    const local = ancestors.some((ancestor) =>
      (scopes.get(ancestor) ?? []).some((start) => after(node.span, start)),
    );
    if (node.kind === "variable" && node.name === name)
      return local ? { ...node, name: lifted } : node;
    const changed = mapChildren(node, (child) => scoped(child, [...ancestors, node]));
    if (local && calledName(changed) === name)
      return { ...changed, method: { ...asNode(changed.method)!, value: lifted } };
    return changed;
  };
  return scoped(block, []);
}

/** The Groovy type a declaration gives its variable, `java.lang.Object` for `def`. */
function originType(declaration: AstNode): string {
  const left = asNode(declaration.left);
  return typeof left?.originType === "string" ? left.originType : "java.lang.Object";
}

/** The kinds of the constant values that declarations give, `typeof` each constant, or `other`. */
function constantKinds(declarations: ReadonlyArray<{ node: AstNode }>): Set<string> {
  return new Set(
    declarations.map(({ node }) => {
      const value = asNode(node.right);
      return value?.kind === "constant" ? typeof value.value : "other";
    }),
  );
}

/**
 * Whether the block may tell a variable's null apart from the empty text: it compares the variable by `==`, `!=`, `<=>`,
 * `in`, a pattern, or `instanceof`, switches on it, gives it to `?:`, or reads it null-safely, `x?.size()`. A comparison
 * with another variable may compare with null too, so any comparison counts.
 */
function nullTested(block: AstNode, name: string): boolean {
  const comparing = new Set(["==", "!=", "<=>", "in", "==~", "=~", "instanceof"]);
  let tested = false;
  const walk = (node: AstNode, parent: AstNode | null): void => {
    if (node.kind === "variable" && variableName(node) === name && parent !== null) {
      if (parent.kind === "binary" && comparing.has(String(parent.operator))) tested = true;
      if (parent.kind === "switch" && asNode(parent.expression) === node) tested = true;
      if (parent.kind === "elvis") tested = true;
      if (
        (parent.kind === "property" || parent.kind === "methodCall") &&
        parent.safe === true &&
        asNode(parent.object) === node
      )
        tested = true;
    }
    for (const child of children(node)) walk(child, node);
  };
  walk(block, null);
  return tested;
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
  // The declaration sets the variable where it had a value, or where something sets it again, to its type's start: 0,
  // false, or for a text the empty text, as the conversion starts a text local that Groovy started as null.
  const text = TEXT_TYPES.has(type);
  const set = (node: AstNode): AstNode[] => {
    const expression = node.kind === "expressionStatement" ? asNode(node.expression) : null;
    if (expression?.kind !== "declaration" || variableName(expression.left) !== lifted)
      return [mapBlocks(node, set)];
    const value = asNode(expression.right);
    if (value !== null && !isEmpty(value)) return [assignment(value, node.span)];
    if (text) return [assignment({ kind: "constant", span: node.span, value: "" }, node.span)];
    return ZERO_TYPES.has(type) && writes > 0
      ? [assignment(startingValue(type, node.span), node.span)]
      : [];
  };
  const withValue = mapBlocks(renameLocal(block, name, lifted), set);
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
      right:
        initial !== null && !isEmpty(initial) && literal(initial)
          ? initial
          : text
            ? { kind: "constant", span: at, value: "" }
            : empty,
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
