// What a record's plan checks, derived from the record and its source (`derive`): its checked stores, its discharges,
// its content, and the type each fallback obligation checks.

import { isDeepStrictEqual } from "node:util";

import type { Expression, IfStatement, Statement } from "../../../../src/ast.js";
import { listProperty } from "../../../../src/list-methods.js";
import type { CompactRecord } from "../../type-core-records.js";
import { Underivable, type DerivedType, type DerivedStore, type Discharge, type DerivedContent, site, derivedText, repairsRecord, type Syntax, allStatements, storeOf, targetName, unwrap, selected, admittedShape, partOf, nodesIn, isBlockOrStatement, unionTypes, writtenType, withoutNull, type DefaultOwner, fallbackOf, expressions } from "./type-core-derived.js";
import { literalType, declaredNames, type Snap, type Chain, type Resolve, INDEX, type State, OPEN, NULL, ALL, isAll, partAt, snapshotAt, expectedType, writtenLanding } from "./type-core-derived-defaults.js";
import { sourceShape, typeOf } from "./type-core-derived-shapes.js";

/** An expression's `Chain` with the chains of the bindings in scope by name; `null` for any other expression. */
function chainOf(expression: Expression, chains: ReadonlyMap<string, Chain | null>): Chain | null {
  const at = unwrap(expression);
  switch (at.kind) {
    case "identifier":
      return chains.get(at.name) ?? null;
    case "listLiteral":
    case "setLiteral": {
      const cells = at.elements.map((element) => chainOf(element, chains));
      const first = cells[0] ?? null;
      return {
        t: at.kind === "listLiteral" ? "list" : "set",
        element:
          first !== null && cells.every((cell) => isDeepStrictEqual(cell, first)) ? first : null,
      };
    }
    case "objectLiteral":
      return {
        t: "object",
        properties: at.properties.map((property) => ({
          name: property.name.name,
          chain: chainOf(property.value, chains),
        })),
      };
    default:
      return null;
  }
}

/**
 * Two values joined where an `if`'s arms meet: a refusal wins, then no structure; else `joinTypes`, or its refusal.
 */
function joinSnaps(a: Snap, b: Snap, written: DerivedType | null): Snap {
  if (a.t === "refused") return a;
  if (b.t === "refused") return b;
  if (a.t === "open" || b.t === "open") return OPEN;
  try {
    return { t: "type", type: joinTypes(a.type, b.type, written) };
  } catch (error) {
    if (error instanceof Underivable) return { t: "refused", why: error.message };
    throw error;
  }
}

/**
 * Two arms' values of a variable an arm stores, joined: every kind (host data) wins; two objects join by property (a
 * property one arm holds alone refused); any other part takes the written type's part (X2), else the two as one family
 * (`admittedShape`), `null` kept.
 */
function joinTypes(a: DerivedType, b: DerivedType, written: DerivedType | null): DerivedType {
  if (isAll(a) || isAll(b)) return ALL;
  if (a.kind === "object" && b.kind === "object") {
    const names = [...new Set([...a.properties, ...b.properties].map((property) => property.name))];
    return {
      kind: "object",
      properties: names.map((name) => {
        const left = a.properties.find((property) => property.name === name)?.type;
        const right = b.properties.find((property) => property.name === name)?.type;
        if (left === undefined || right === undefined)
          throw new Underivable("a property only one arm's value holds");
        const part =
          written?.kind === "object"
            ? (written.properties.find((property) => property.name === name)?.type ?? null)
            : null;
        return { name, type: joinTypes(left, right, part) };
      }),
    };
  }
  if (written !== null) return written;
  if (derivedText(a) === derivedText(b)) return a;
  const flat = (type: DerivedType): boolean =>
    type.kind === "kinds" || (type.kind === "union" && type.members.every(flat));
  if (flat(a) && flat(b)) return admittedShape([a, b])!;
  throw new Underivable("a join of a structure and another value");
}

/** Whether a stored value is a computation the reader does not model: a call, an operation, a conversion. */
function computes(expression: Expression): boolean {
  const at = unwrap(expression);
  switch (at.kind) {
    case "numberLiteral":
    case "booleanLiteral":
    case "nullLiteral":
    case "identifier":
      return false;
    case "stringLiteral":
      return !at.parts.every((part) => part.kind === "stringText");
    case "listLiteral":
    case "setLiteral":
      return at.elements.some(computes);
    case "objectLiteral":
      return at.properties.some((property) => computes(property.value));
    case "propertyAccessExpression":
      return computes(at.object);
    case "indexExpression":
      return computes(at.object) || computes(at.index);
    case "loadExpression":
      return (
        unwrap(at.key).kind !== "stringLiteral" ||
        (at.defaultValue !== null && computes(at.defaultValue))
      );
    case "callExpression": {
      const callee = unwrap(at.callee);
      if (callee.kind !== "identifier" || callee.name !== "fromJson") return true;
      const fallback = fallbackOf(at);
      return fallback !== null && computes(fallback);
    }
    default:
      return true;
  }
}

/** The typed calls (a `load`, a `fromJson`) that run when a statement runs, its nested blocks left out. */
function ownCalls(statement: Statement): Expression[] {
  const fromJson = (callee: Expression) => {
    const at = unwrap(callee);
    return at.kind === "identifier" && at.name === "fromJson";
  };
  return nodesIn(statement, false).filter(
    (node): node is Expression =>
      node.kind === "loadExpression" || (node.kind === "callExpression" && fromJson(node.callee)),
  );
}

/** The root variable of a method call's receiver (`d.push(1)`, `d.n.get(0)`), or `null`. */
function receiverOf(node: Statement | Expression): string | null {
  if (node.kind !== "callExpression") return null;
  let receiver = unwrap(node.callee);
  if (receiver.kind !== "propertyAccessExpression") return null;
  while (receiver.kind === "propertyAccessExpression" || receiver.kind === "indexExpression")
    receiver = unwrap(receiver.object);
  return receiver.kind === "identifier" ? receiver.name : null;
}

/** The names a node stores to, or calls a method on, anywhere within it, nested blocks included. */
function storedNames(node: unknown): Set<string> {
  const found = new Set<string>();
  for (const at of nodesIn(node, true)) {
    const receiver = receiverOf(at);
    if (receiver !== null) found.add(receiver);
    if (at.kind === "letStatement") found.add(at.name.name);
    if (at.kind === "assignmentStatement") {
      let target: Expression = at.target;
      while (target.kind === "propertyAccessExpression" || target.kind === "indexExpression")
        target = target.object;
      if (target.kind === "identifier") found.add(target.name);
    }
    if (at.kind === "forStatement") {
      found.add(at.variable.name);
      if (at.valueVariable) found.add(at.valueVariable.name);
    }
  }
  return found;
}

/** A condition's truth when its syntax decides it, as the compiler's `literalTruth` folds it; else `null`. */
function knownTruth(expression: Expression): boolean | null {
  const at = unwrap(expression);
  if (at.kind === "booleanLiteral") return at.value;
  if (at.kind === "unaryExpression" && at.operator === "not") {
    const operand = knownTruth(at.operand);
    return operand === null ? null : !operand;
  }
  if (at.kind === "binaryExpression" && (at.operator === "and" || at.operator === "or")) {
    const decides = at.operator === "or";
    const [left, right] = [knownTruth(at.left), knownTruth(at.right)];
    if (left === decides || right === decides) return decides;
    return left === null || right === null ? null : !decides;
  }
  return null;
}

/**
 * The snapshot reader (#1760): one forward walk over the program in source order, made once, recording each variable's
 * value at each typed call (`load`, `fromJson`), as the compiler keys a default's reads by its call:
 * the state when the call's statement starts, on the call's own branch. Values are finite `DerivedType` trees copied when
 * stored, so a copy holds what its source held at the copy and a self-copy cannot recurse. Derived from the syntax alone.
 * An `if`'s arms walk from one state and join (`joinSnaps`) what a joining arm's paths store, its written type (X2) the
 * binding's in scope; an arm its condition's syntax rules out (`knownTruth`) or that does not fall through (`exit`,
 * `end`) is left out. A call no path reaches, and a read inside a loop body, are refused. Refused
 * wherever it is read: a variable stored (or called a method on) where source order does not tell when, in a loop, a
 * block an expression holds (a handler), or a statement kind the walk does not model, and every stored variable in a
 * program with a `goto` or a file call. Refused from its store on: a stored computation, a method call on the variable,
 * a property store below a value of no modelled structure. A typed call the walk does not reach is refused.
 */
const snapshotTables = new WeakMap<readonly Statement[], ReadonlyMap<Expression, Resolve>>();
/** The statements the snapshot reader's walks have visited, and the values its calls captured, for its cost probe. */
const visits = { statements: 0, captured: 0 };
export const snapshotVisits = (): { readonly statements: number; readonly captured: number } => ({
  ...visits,
});
function snapshotsOf(program: readonly Statement[]): ReadonlyMap<Expression, Resolve> {
  const cached = snapshotTables.get(program);
  if (cached !== undefined) return cached;
  const table = new Map<Expression, Resolve>();
  // (the rules' flat list of the program's statements, as `derive` reads them)
  const statements = allStatements(program);
  // (the names stored where source order does not tell when, with why: refused before and after)
  const unordered = new Map<string, Snap>();
  const refuse = (names: Iterable<string>, why: string) => {
    for (const name of names) if (!unordered.has(name)) unordered.set(name, { t: "refused", why });
  };
  // (the statements and blocks an expression holds, which run later: a handler's)
  const heldBlocks = (node: Statement | Expression) =>
    nodesIn(node, false).filter((each) => each !== node && isBlockOrStatement(each));
  const visit = (block: readonly Statement[]) => {
    for (const statement of block)
      switch (statement.kind) {
        case "ifStatement": {
          let at: Statement | null = statement;
          while (at !== null && at.kind === "ifStatement") {
            refuse(storedNames(heldBlocks(at.condition)), "a variable a handler block stores");
            visit(at.thenBlock.statements);
            const next: IfStatement["elseBlock"] = at.elseBlock;
            if (next !== null && next.kind !== "ifStatement") visit(next.statements);
            at = next?.kind === "ifStatement" ? next : null;
          }
          break;
        }
        case "repeatStatement":
        case "forStatement":
        case "whileStatement":
          refuse(storedNames(statement), "a variable a loop stores");
          break;
        case "letStatement":
        case "assignmentStatement":
        case "expressionStatement":
        case "sayStatement":
        case "exitStatement":
        case "waitStatement":
        case "saveStatement":
        case "deleteStatement":
          refuse(storedNames(heldBlocks(statement)), "a variable a handler block stores");
          break;
        default:
          refuse(storedNames(statement), `a variable a ${statement.kind} stores`);
      }
  };
  visit(program);
  const jumps = nodesIn(program, true).some(
    (node) => node.kind === "gotoStatement" || node.kind === "callFileStatement",
  );
  if (jumps) refuse(storedNames(program), "a variable stored in a program with a jump");
  const lookup =
    (state: State) =>
    (name: string): Snap =>
      unordered.get(name) ??
      state.get(name) ?? {
        t: "refused",
        why: "a variable read where the reader holds no value of it",
      };
  // (each typed call of a statement reads the values of the names its statement holds, captured as they stand)
  // (a call no path reaches reads no value: the compiler takes none at a dead node, X1)
  const dead: Resolve = () => ({ t: "refused", why: "a variable read where no path reaches" });
  const record = (
    statement: Statement,
    state: State,
    chains: ReadonlyMap<string, Chain | null>,
    live: boolean,
  ) => {
    const calls = ownCalls(statement).filter((call) => !table.has(call));
    if (calls.length === 0) return;
    if (!live) {
      for (const call of calls) {
        table.set(call, dead);
        snapshotAt.set(call, dead);
      }
      return;
    }
    const names = new Set(
      nodesIn(statement, false).flatMap((node) => (node.kind === "identifier" ? [node.name] : [])),
    );
    const captured = new Map<string, Snap>();
    for (const name of names) {
      const snap = state.get(name);
      const chain = chains.get(name) ?? null;
      if (snap !== undefined) captured.set(name, chain === null ? snap : { ...snap, chain });
    }
    visits.captured += captured.size;
    for (const call of calls) {
      table.set(call, lookup(captured));
      snapshotAt.set(call, lookup(captured));
    }
  };
  const valueOf = (value: Expression, state: State): Snap => {
    if (computes(value)) return { t: "refused", why: "a stored computation" };
    const at = selected(value)!;
    switch (at.kind) {
      case "nullLiteral":
        return { t: "type", type: NULL };
      case "objectLiteral": {
        // (each property's value as stored, its null kept)
        const properties: { name: string; type: DerivedType }[] = [];
        for (const property of at.properties) {
          const part = valueOf(property.value, state);
          if (part.t === "refused") return part;
          properties.push({ name: property.name.name, type: part.t === "open" ? ALL : part.type });
        }
        return { t: "type", type: { kind: "object", properties } };
      }
      case "identifier":
      case "propertyAccessExpression":
      case "indexExpression": {
        // (a copy: the source's value at the copy)
        const steps: string[] = [];
        let root: Expression = at;
        while (root.kind === "propertyAccessExpression" || root.kind === "indexExpression") {
          steps.unshift(root.kind === "propertyAccessExpression" ? root.property.name : INDEX);
          root = unwrap(root.object);
        }
        // (host data is open; a read through an unmodelled value is refused, never open)
        if (root.kind !== "identifier")
          return { t: "refused", why: "a read through an unmodelled value" };
        return declaredNames(statements).has(root.name)
          ? partAt(lookup(state)(root.name), steps)
          : OPEN;
      }
      default:
        // (a literal or a typed call: a refused read inside it refuses the store)
        try {
          const type = literalType(at, statements, new Set(), lookup(state));
          return type === null ? OPEN : { t: "type", type };
        } catch (error) {
          if (error instanceof Underivable) return { t: "refused", why: error.message };
          throw error;
        }
    }
  };
  /** The part at `steps` of `snap` replaced by `part`, or why it cannot be. */
  const replaced = (snap: Snap, steps: readonly string[], part: Snap): Snap => {
    if (steps.length === 0) return part;
    if (snap.t === "refused") return snap;
    if (snap.t !== "type" || snap.type.kind !== "object" || steps[0] === INDEX)
      return { t: "refused", why: "a property store below a value of no modelled structure" };
    const [name, ...rest] = steps;
    const own = snap.type.properties.find((property) => property.name === name);
    const next = replaced(own === undefined ? OPEN : { t: "type", type: own.type }, rest, part);
    if (next.t === "refused") return next;
    const type: DerivedType = next.t === "open" ? ALL : next.type;
    return {
      t: "type",
      type: {
        ...snap.type,
        properties: [
          ...snap.type.properties.filter((property) => property.name !== name),
          { name: name!, type },
        ],
      },
    };
  };
  /**
   * A block walked from `incoming`, reached or not (`live`): the state after it, whether it falls through to what
   * follows, and the names declared before it that a path through it to its end stores.
   */
  const walk = (
    block: readonly Statement[],
    incoming: State,
    outer: ReadonlyMap<string, DerivedType>,
    outerChains: ReadonlyMap<string, Chain | null>,
    live: boolean,
  ): {
    readonly state: Map<string, Snap>;
    readonly falls: boolean;
    readonly stored: ReadonlySet<string>;
  } => {
    const state = new Map(incoming);
    // (the written type of each binding in scope, by its name: a block's own `let`s are its own, a sibling's not seen)
    const written = new Map(outer);
    // (each binding's `Chain`, scoped as its written type is)
    const chains = new Map(outerChains);
    const stored = new Set<string>();
    let reached = live;
    const store = (name: string, snap: Snap) => {
      state.set(name, snap);
      // (a block that stops does not fall through, so what it stores after its stop never joins)
      if (incoming.has(name)) stored.add(name);
    };
    for (const statement of block) {
      visits.statements += 1;
      // (a method call on a variable may change it: refused from its statement on, its own typed calls included)
      for (const node of nodesIn(statement, false))
        if (node !== statement && !isBlockOrStatement(node)) {
          const name = receiverOf(node);
          if (name !== null) store(name, { t: "refused", why: "a method call on the variable" });
        }
      record(statement, state, chains, reached);
      switch (statement.kind) {
        case "letStatement":
          if (statement.typeAnnotation !== null)
            written.set(statement.name.name, writtenType(statement.typeAnnotation));
          chains.set(
            statement.name.name,
            statement.typeAnnotation !== null
              ? { t: "whole", type: writtenType(statement.typeAnnotation) }
              : chainOf(statement.initializer, chains),
          );
          state.set(statement.name.name, valueOf(statement.initializer, state));
          break;
        case "assignmentStatement": {
          const steps: string[] = [];
          let target: Expression = statement.target;
          while (target.kind === "propertyAccessExpression" || target.kind === "indexExpression") {
            steps.unshift(
              target.kind === "propertyAccessExpression" ? target.property.name : INDEX,
            );
            target = target.object;
          }
          if (target.kind !== "identifier") break;
          const value: Snap =
            statement.operator === "="
              ? valueOf(statement.value, state)
              : { t: "refused", why: "a stored computation" };
          store(target.name, replaced(state.get(target.name) ?? OPEN, steps, value));
          break;
        }
        case "ifStatement": {
          // (each arm from the state before the `if`, an `else if`'s condition read there too; no `else`: the state as
          // it was. An arm that can run and falls through joins what its paths store)
          const arms: State[] = [];
          const joined = new Set<string>();
          let open = reached;
          const arm = (block: readonly Statement[], runs: boolean) => {
            const out = walk(block, state, written, chains, runs);
            if (runs && out.falls) {
              arms.push(out.state);
              for (const name of out.stored) joined.add(name);
            }
          };
          let at: Statement | null = statement;
          while (at !== null && at.kind === "ifStatement") {
            if (at !== statement) record(at, state, chains, open);
            const truth = knownTruth(at.condition);
            arm(at.thenBlock.statements, open && truth !== false);
            if (truth === true) open = false;
            const next: IfStatement["elseBlock"] = at.elseBlock;
            if (next === null) {
              if (open) arms.push(state);
              at = null;
            } else if (next.kind === "ifStatement") at = next;
            else {
              arm(next.statements, open);
              at = null;
            }
          }
          if (arms.length === 0) {
            reached = false;
            break;
          }
          // (a name declared before that a joining arm's path stores joins each arm's value, X2 by its binding's
          // written type)
          for (const name of joined)
            store(
              name,
              arms
                .map((each) => each.get(name) ?? OPEN)
                .reduce((a, b) => joinSnaps(a, b, written.get(name) ?? null)),
            );
          break;
        }
        case "repeatStatement":
        case "forStatement":
        case "whileStatement": {
          // (its stores are refused (`unordered`); a value read in its body may come from another iteration, whose
          // reading the walk does not model: refused there, X5)
          const inLoop = new Map<string, Snap>(
            [...state.keys()].map((name) => [
              name,
              { t: "refused", why: "a variable read inside a loop" },
            ]),
          );
          walk(statement.body.statements, inLoop, written, chains, reached);
          break;
        }
        case "exitStatement":
        case "endStatement":
          // (what follows does not run: its calls are recorded as unreached)
          reached = false;
          break;
        case "expressionStatement":
        case "sayStatement":
        case "waitStatement":
        case "saveStatement":
        case "deleteStatement":
          break;
        default:
        // (stores in a statement the walk does not model are refused (`unordered`); a typed call in its nested blocks is
        // not reached, and so refused where it is read)
      }
    }
    return { state, falls: reached, stored };
  };
  walk(program, new Map(), new Map(), new Map(), true);
  snapshotTables.set(program, table);
  return table;
}

/**
 * The reads each walked typed call's default makes at its snapshot, by the outermost such call: every expression of its
 * default, a nested typed call's default included, as the compiler keys them (`FlowGraphBuilder.snapshotFrom`).
 */
export function snapshotReads(
  program: readonly Statement[],
): { readonly call: Expression; readonly reads: readonly Expression[] }[] {
  const entries = [...snapshotsOf(program).keys()].map((call) => {
    const fallback = fallbackOf(call);
    return {
      call,
      reads:
        fallback === null
          ? []
          : nodesIn(fallback, false).filter(
              (node): node is Expression => !isBlockOrStatement(node),
            ),
    };
  });
  const inner = new Set(entries.flatMap((entry) => entry.reads));
  return entries.filter((entry) => !inner.has(entry.call) && entry.reads.length > 0);
}

/** Whether a type holds `null`. */
function holdsNull(type: DerivedType): boolean {
  return type.kind === "kinds"
    ? type.kinds.includes("null")
    : type.kind === "union" && type.members.some(holdsNull);
}

/** A fallback obligation can name a part (`[hostValue].element`), checked at the whole selected operand. */
function fallbackType(
  owner: DefaultOwner,
  path: readonly string[],
  against: readonly string[],
  statements: readonly Statement[],
): DerivedType {
  const value = fallbackOf(owner)!;
  const root = sourceShape(value, statements) ?? sourceShape(owner, statements);
  // C10 (ADR 0021 7.2): below the fallback itself an element may also be null, unless the written type of a place
  // the owner lands in directly excludes it there
  const written = path.length === 0 ? undefined : writtenLanding(owner, path, statements);
  const nullable =
    path.length > 0 && (written === undefined || written === null || holdsNull(written));
  const at = (
    shape: DerivedType | null,
    remaining: readonly string[],
    literal: Expression | null,
  ): DerivedType => {
    if (remaining.length === 0) {
      const kinds = nullable && !against.includes("null") ? [...against, "null"] : against;
      // (C10 publishes a collection's own kind alone where no literal holds the value: #1538 checks it whole)
      return literal === null && kinds.some(isCollectionKind)
        ? completedType(owner, path, kinds, statements)
        : { kind: "kinds", kinds };
    }
    const [step, ...rest] = remaining;
    if (step !== "element")
      return {
        kind: "object",
        properties: [{ name: step!, type: at(partOf(shape, step!), rest, null) }],
      };
    const collection =
      shape?.kind === "union"
        ? shape.members.find(
            (member) => member.kind === "list" || member.kind === "set" || member.kind === "dict",
          )
        : shape;
    if (collection?.kind !== "list" && collection?.kind !== "set" && collection?.kind !== "dict")
      throw new Underivable("a fallback element check without a source-carried collection");
    const first =
      (literal?.kind === "listLiteral" || literal?.kind === "setLiteral") &&
      literal.elements.length > 0
        ? collectionLiteral(literal.elements[0]!)
        : null;
    return { kind: collection.kind, element: at(collection.element, rest, first) };
  };
  return at(root, path, collectionLiteral(value));
}

function isCollectionKind(kind: string): boolean {
  return kind === "list" || kind === "set" || kind === "dict";
}

/** The collection literal a value is, through parentheses and constant indexes of list literals, or `null`. */
function collectionLiteral(expression: Expression): Expression | null {
  const at = selected(expression);
  return at?.kind === "listLiteral" || at?.kind === "setLiteral" || at?.kind === "dictLiteral"
    ? at
    : null;
}

/**
 * #1538 (ADR 0021 7.2): a fallback level no literal holds, at which C10 publishes a collection's own kind alone, is
 * checked against the whole structure of the value the default stands in for (a `get`'s receiver's element, an
 * `otherwise`'s left without `null`), C10's scalars and `null` beside it; whole numbers there are numbers too
 * except at a level a written type reaches (`writtenAt`).
 */
function completedType(
  owner: DefaultOwner,
  path: readonly string[],
  kinds: readonly string[],
  statements: readonly Statement[],
): DerivedType {
  if (path.some((step) => step !== "element"))
    throw new Underivable("a completed fallback below a property");
  const callee = owner.kind === "callExpression" ? unwrap(owner.callee) : null;
  const [value, steps] =
    owner.kind === "binaryExpression"
      ? [owner.left, path]
      : callee?.kind === "propertyAccessExpression" && callee.property.name === "get"
        ? [callee.object, ["element", ...path]]
        : [null, path];
  if (value === null) throw new Underivable("a completed fallback of another owner");
  let shape = sourceShape(value, statements);
  for (const step of steps) shape = partOf(shape, step);
  if (shape !== null && owner.kind === "binaryExpression" && path.length === 0)
    shape = withoutNull(shape);
  const held = (shape?.kind === "union" ? shape.members : shape === null ? [] : [shape]).filter(
    (member) => isCollectionKind(member.kind),
  );
  if (held.length === 0) throw new Underivable("a completed fallback without a collection");
  const family = (type: DerivedType, below: readonly string[]): DerivedType => {
    if (type.kind === "kinds")
      return type.kinds.includes("integer") &&
        !type.kinds.includes("number") &&
        !writtenAt(value, [...steps, ...below], statements)
        ? { kind: "kinds", kinds: [...type.kinds, "number"] }
        : type;
    if (type.kind === "union")
      return unionTypes(type.members.map((member) => family(member, below)));
    if (type.kind === "object")
      return {
        ...type,
        properties: type.properties.map((property) => ({
          name: property.name,
          type: family(property.type, [...below, property.name]),
        })),
      };
    return {
      kind: type.kind,
      element: type.element === null ? null : family(type.element, [...below, "element"]),
    };
  };
  const scalars = kinds.filter((kind) => !isCollectionKind(kind));
  return unionTypes([
    ...held.map((member) => family(member, [])),
    ...(scalars.length > 0 ? [{ kind: "kinds", kinds: scalars } as const] : []),
  ]);
}

/**
 * Whether a value's level (by its steps) is a written type's (A4, ADR 0021 1.3): a written declaration's, through
 * parentheses, element reads, `get`s, a literal's elements and copies; an `otherwise` chain's where any operand that
 * brings a collection is, all of one structure.
 */
function writtenAt(
  expression: Expression,
  steps: readonly string[],
  statements: readonly Statement[],
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const at = unwrap(expression);
  switch (at.kind) {
    case "identifier": {
      if (seen.has(at.name)) return false;
      const declared = statements.some(
        (statement) =>
          statement.kind === "letStatement" &&
          statement.name.name === at.name &&
          statement.typeAnnotation !== null,
      );
      if (declared) return true;
      const values = statements.flatMap((statement) => {
        const store = storeOf(statement);
        return store?.name === at.name ? [store.value] : [];
      });
      const next = new Set([...seen, at.name]);
      return (
        values.length > 0 && values.every((value) => writtenAt(value, steps, statements, next))
      );
    }
    case "indexExpression":
      return writtenAt(at.object, ["element", ...steps], statements, seen);
    case "callExpression": {
      const callee = unwrap(at.callee);
      return (
        callee.kind === "propertyAccessExpression" &&
        callee.property.name === "get" &&
        writtenAt(callee.object, ["element", ...steps], statements, seen)
      );
    }
    case "listLiteral":
    case "setLiteral":
      return (
        steps[0] === "element" &&
        at.elements.length > 0 &&
        at.elements.every((element) => writtenAt(element, steps.slice(1), statements, seen))
      );
    case "binaryExpression": {
      if (at.operator !== "otherwise") return false;
      // (a level of a join is written where any operand that brings a collection is; the core admits a join of different
      // structures by its copies, which these rules do not derive)
      const operands = [at.left, at.right]
        .map((operand) => [operand, sourceShape(operand, statements)] as const)
        .filter(
          ([, shape]) =>
            shape === null ||
            (shape.kind === "union" ? shape.members : [shape]).some((member) =>
              isCollectionKind(member.kind),
            ),
        );
      const texts = new Set(
        operands.map(([, shape]) =>
          shape === null ? "" : derivedText(withoutNull(shape) ?? shape),
        ),
      );
      if (texts.size > 1) throw new Underivable("a join of different structures");
      return operands.some(([operand]) => writtenAt(operand, steps, statements, seen));
    }
    default:
      return false;
  }
}

/** Every obligation is mapped by S3; S7 content is owed by that map and F18, never by the emitted plan. */
export function derive(
  syntax: Syntax,
  record: CompactRecord,
): {
  readonly stores: readonly DerivedStore[];
  readonly discharges: readonly Discharge[];
  readonly content: DerivedContent;
} {
  const { source } = syntax;
  // (each typed call's snapshot, walked once over the program's own nesting before any default is read, #1760)
  snapshotsOf(syntax.statements);
  const statements = allStatements(syntax.statements);
  const all = expressions(syntax.statements).map(unwrap);
  const owners = all.filter(
    (expression): expression is DefaultOwner => fallbackOf(expression) !== null,
  );
  const content: {
    requireExisting: { target: string; site: string }[];
    indexes: string[];
    fallbacks: { owner: string; site: string; type: DerivedType }[];
    expected: { owner: string; type: DerivedType }[];
    loads: { owner: string; type: DerivedType | null; repair: boolean }[];
  } = { requireExisting: [], indexes: [], fallbacks: [], expected: [], loads: [] };
  for (const owner of new Set(owners)) {
    if (owner.kind === "loadExpression") {
      const type = expectedType(owner, statements);
      content.loads.push({
        owner: site(owner),
        type,
        repair: type !== null && repairsRecord(type),
      });
    } else if (
      owner.kind === "callExpression" &&
      owner.callee.kind === "identifier" &&
      owner.callee.name === "fromJson"
    ) {
      const type = expectedType(owner, statements);
      if (type !== null) content.expected.push({ owner: site(owner), type });
    }
  }
  const owed = new Map<Statement, { path: readonly string[]; against: readonly string[] }[]>();
  const discharges: ({ statement: Statement } | { native: Discharge & { by: "native" } })[] = [];
  const native = (what: (Discharge & { by: "native" })["what"], at: string): void => {
    discharges.push({ native: { by: "native", what, site: at } });
  };
  const reads = all.filter(
    (
      expression,
    ): expression is Extract<
      Expression,
      { kind: "propertyAccessExpression" | "indexExpression" }
    > => expression.kind === "propertyAccessExpression" || expression.kind === "indexExpression",
  );
  const readAt = (check: CompactRecord["checks"][number]) => {
    const at = `${check.site.offset}:${check.site.end}`;
    const named = reads.filter((expression) => {
      const receiver = unwrap(expression.object);
      return source.slice(receiver.span.start.offset, receiver.span.end.offset) === check.target;
    });
    const exact = (expression: (typeof reads)[number]): boolean =>
      site(unwrap(expression.object)) === at || site(expression) === at;
    return (
      named.find(exact) ??
      reads.find(exact) ??
      named.find((expression) => expression.span.start.offset === check.site.offset)
    );
  };
  for (const check of record.checks) {
    const at = `${check.site.offset}:${check.site.end}`;
    const fallback = owners.find((owner) => {
      const value = unwrap(fallbackOf(owner)!);
      const text = source.slice(value.span.start.offset, value.span.end.offset);
      return site(value) === at && (check.target === text || check.target.startsWith(`${text}.`));
    });
    if (
      check.kind === "copy-type" &&
      check.boundary &&
      check.against.length === 1 &&
      check.against[0] === "unknown"
    ) {
      native("representable", at);
    } else if (check.kind === "copy-type" && fallback !== undefined && !check.boundary) {
      if (fallback.kind !== "loadExpression") {
        const existing = content.fallbacks.find((entry) => entry.owner === site(fallback));
        const value = unwrap(fallbackOf(fallback)!);
        const text = source.slice(value.span.start.offset, value.span.end.offset);
        const path = check.target === text ? [] : check.target.slice(text.length + 1).split(".");
        const type = fallbackType(fallback, path, check.against, statements);
        if (existing !== undefined && derivedText(existing.type) !== derivedText(type))
          throw new Underivable("incompatible checks of one fallback");
        if (existing === undefined)
          content.fallbacks.push({ owner: site(fallback), site: at, type });
      }
      native("fallback", at);
    } else if (
      (check.kind === "copy-type" ||
        // (C1's check of a copied integer that may be null, at its store's value: the store's own, as a copy type's)
        (check.kind === "null-check" &&
          check.against.length > 0 &&
          check.against.every((kind) => kind === "integer") &&
          statements.some((candidate) => {
            const store = storeOf(candidate);
            return (
              store !== null &&
              site(unwrap(store.value)) === at &&
              (check.target === store.name || check.target.startsWith(`${store.name}.`))
            );
          }))) &&
      !check.against.includes("unknown")
    ) {
      const statement = statements
        .filter(
          (candidate) =>
            storeOf(candidate) !== null &&
            candidate.span.start.offset <= check.site.offset &&
            check.site.offset < candidate.span.end.offset,
        )
        .sort(
          (a, b) =>
            a.span.end.offset - a.span.start.offset - (b.span.end.offset - b.span.start.offset),
        )[0];
      if (statement === undefined) {
        const ingress = owners.find(
          (owner) =>
            site(owner) === at &&
            (owner.kind === "loadExpression" ||
              (owner.kind === "callExpression" &&
                owner.callee.kind === "identifier" &&
                owner.callee.name === "fromJson")),
        );
        if (!check.boundary || ingress === undefined || expectedType(ingress, statements) === null)
          throw new Underivable(`${check.target}: no store or typed ingress holds its check`);
        native("typed-ingress", at);
        continue;
      }
      const store = storeOf(statement)!;
      const prefix = `${store.name}.`;
      if (check.target !== store.name && !check.target.startsWith(prefix)) {
        const ingress = owners.find(
          (owner) =>
            site(owner) === at &&
            (owner.kind === "loadExpression" ||
              (owner.kind === "callExpression" &&
                owner.callee.kind === "identifier" &&
                owner.callee.name === "fromJson")),
        );
        if (check.boundary && ingress !== undefined && expectedType(ingress, statements) !== null) {
          native("typed-ingress", at);
          continue;
        }
        throw new Underivable(`${check.target} is not ${store.name}'s`);
      }
      const path = check.target === store.name ? [] : check.target.slice(prefix.length).split(".");
      owed.set(statement, [...(owed.get(statement) ?? []), { path, against: check.against }]);
      discharges.push({ statement });
    } else if (
      check.kind === "integer-check" ||
      // (a count's or an index's possible null that a check on every route the compiler cannot keep leaves to the run,
      // V30 §13, #1073 PR 4: the runtime's own check of the count or the index takes it at the use, as an integer's)
      (check.kind === "null-check" &&
        check.against.length > 0 &&
        check.against.every((kind) => kind === "integer"))
    ) {
      const get = all.find(
        (expression) =>
          expression.kind === "callExpression" &&
          expression.callee.kind === "propertyAccessExpression" &&
          expression.callee.property.name === "get" &&
          expression.arguments[0] !== undefined &&
          site(unwrap(expression.arguments[0].value)) === at,
      );
      if (get !== undefined && !content.indexes.includes(site(get)))
        content.indexes.push(site(get));
      native("integer-use", at);
    } else if (check.kind === "empty-check") {
      const read = readAt(check);
      if (
        read?.kind !== "propertyAccessExpression" ||
        listProperty(read.property.name)?.gives !== "element"
      )
        throw new Underivable(`an empty obligation at ${at} without an element selection`);
      native("empty", site(read));
    } else if (
      (check.kind === "operand" || check.kind === "null-check") &&
      statements.some(
        (statement) => statement.kind === "forStatement" && site(unwrap(statement.iterable)) === at,
      )
    ) {
      // C13 (S9b): a `for` loop's iterable, which the loop's own check of its source takes (TSR044)
      native("iteration", at);
    } else if (check.kind === "operand") {
      // C13 (S9b): a method's argument or what `toJson` writes, which the call's own check takes at the call, or the
      // elements `join` or `sort` reads, whose obligation is the whole call's
      const call = all.find(
        (expression) =>
          expression.kind === "callExpression" &&
          (site(expression) === at ||
            expression.arguments.some((argument) => site(unwrap(argument.value)) === at)),
      );
      if (call === undefined)
        throw new Underivable(`an operand obligation at ${at} without a call`);
      native("argument", site(call));
    } else if (
      check.kind === "null-check" &&
      check.against.length === 1 &&
      check.against[0] === "non-null"
    ) {
      const store = statements.find(
        (statement) =>
          statement.kind === "assignmentStatement" &&
          statement.target.kind === "propertyAccessExpression" &&
          (site(unwrap(statement.target.object)) === at || site(statement.target) === at),
      );
      if (store?.kind === "assignmentStatement") {
        if (!content.requireExisting.some((entry) => entry.site === site(store)))
          content.requireExisting.push({ target: targetName(store.target), site: site(store) });
        native("member", site(store.target));
      } else {
        const read = readAt(check);
        // (a method's receiver that may be null, `xs[0].sort()`: the runtime's own check of the call's receiver, at the call)
        const method =
          read === undefined
            ? all.find(
                (expression) =>
                  expression.kind === "callExpression" &&
                  expression.callee.kind === "propertyAccessExpression" &&
                  (site(unwrap(expression.callee.object)) === at || site(expression) === at),
              )
            : undefined;
        if (read === undefined && method?.kind === "callExpression") native("member", site(method));
        else if (read === undefined)
          throw new Underivable(`a member obligation at ${at} without a member`);
        else native("member", site(read));
      }
    } else
      throw new Underivable(`${check.kind} ${check.target}: an obligation no discharge rule maps`);
  }
  const stores = new Map<Statement, DerivedStore>();
  for (const [statement, checks] of owed) {
    const { name, value } = storeOf(statement)!;
    stores.set(statement, {
      target: name,
      so: statement.span.start.offset,
      eo: statement.span.end.offset,
      valueSo: unwrap(value).span.start.offset,
      valueEo: unwrap(value).span.end.offset,
      type: typeOf(statement, value, checks, 0, statements),
    });
  }
  return {
    stores: [...stores.values()].sort((a, b) => a.so - b.so),
    content,
    discharges: discharges.map((entry) =>
      "native" in entry ? entry.native : { by: "store", store: stores.get(entry.statement)! },
    ),
  };
}
