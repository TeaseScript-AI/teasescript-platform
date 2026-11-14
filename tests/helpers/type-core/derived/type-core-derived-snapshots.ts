// The snapshot reader (#1760): one walk over a program recording each variable's value at each typed call, and the
// reads each call's default makes there.

import { isDeepStrictEqual } from "node:util";

import type { Expression, IfStatement, Statement } from "../../../../src/ast.js";
import {
  Underivable,
  declaredIn,
  type DerivedType,
  derivedText,
  allStatements,
  unwrap,
  selected,
  admittedShape,
  nodesIn,
  isBlockOrStatement,
  writtenType,
  fallbackOf,
} from "./type-core-derived.js";
import {
  literalType,
  type Snap,
  type Chain,
  type Resolve,
  INDEX,
  type State,
  OPEN,
  NULL,
  ALL,
  isAll,
  partAt,
  snapshotAt,
} from "./type-core-derived-defaults.js";

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
export function snapshotsOf(program: readonly Statement[]): ReadonlyMap<Expression, Resolve> {
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
        const declared = declaredIn(statements, root, root.name);
        if (declared === undefined) return OPEN;
        // (a parameter's value is its call's: its written type; without one, refused)
        if (declared?.kind === "functionParameter")
          return declared.typeAnnotation === null
            ? { t: "refused", why: "a read of a parameter without a written type" }
            : partAt({ t: "type", type: writtenType(declared.typeAnnotation) }, steps);
        return partAt(lookup(state)(root.name), steps);
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
