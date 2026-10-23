import type {
  BinaryExpression,
  Block,
  CallExpression,
  Expression,
  ForStatement,
  FunctionDeclaration,
  Program,
  RepeatStatement,
  Statement,
  WhileStatement,
} from "../../ast.js";
import { compileChild, runCompileTask, type CompileTask } from "../../compiler/continuation.js";
import {
  expressionChildren,
  expressionParts,
  handlerBlocks,
  statementExpressions,
  unwrap,
} from "../../expression-children.js";
import { lazyDefaultArgument } from "../../lazy-defaults.js";
import { runsOnItsOwn, sessionDeclarations } from "../../project-globals.js";
import { globMatches, isPathGlob } from "../../project-paths.js";
import { createSourceSpan, type SourceSpan } from "../../source.js";
import { staticNumber } from "../../static-evaluation.js";
import { caseValueKey } from "../../switch-cases.js";
import type { SourceSite } from "../graph.js";
import { conditionShape } from "../narrowing-shapes.js";

/*
 * The control-flow graph of the coarse core (O4, checkpoint 9; the design is the coarse-core table, its §3.1, X4, X5,
 * L1–L13 and P7), built from the ASTs, not from the plan: `plan/control-flow.ts` has no node per expression, and the
 * core's exact path answers a read at the expression that makes it. Every statement and every expression is a node, in
 * evaluation order (the shared order helpers of `expression-children.ts`), so a definition and a read can be compared
 * by dominance. tests/type-core-flow-graph.test.ts compares it with the lowering's control flow.
 *
 * Calls are summarized as the lowering's `PlanControlFlow` does: a call's `call-in` node enters the callee's entry, and
 * a summary edge from it to its `call-out` node stands for the return; no edge leads from a callee's exit back. The
 * session starts at the program's entry, runs the session-start values of every global and speaker (the startup
 * region, which dominates every file), and enters the first file. What the graph proves from literals (P7) is a dead
 * edge: a literal condition, `switch` subject or lazy operand, a literal `repeat` count (`0`: the body is dead; `1`: no
 * second round; `1` or more: the body runs before the loop is left), a `get` on a list literal with a literal index,
 * and a parameter default that every call supplies or none does. A call that cannot return has a dead summary edge.
 * Dead code keeps its nodes, joined to the live code before it by dead edges, so every node has a dominator.
 */

export type FlowNodeKind =
  | "program-entry"
  | "program-end"
  | "startup-entry"
  | "startup-exit"
  | "file-entry"
  | "file-exit"
  | "function-entry"
  | "function-exit"
  /** Where a function's body ends without `return`, or a bare `return` leaves it: a result of `null`. */
  | "function-void"
  | "handler-entry"
  | "handler-exit"
  /** The binding of a parameter, after its default if it has one (F21, F22). */
  | "parameter"
  /** The value of an expression, after its parts. */
  | "expression"
  /** A call's arguments are evaluated: the callee is entered from here. */
  | "call-in"
  /** After a call whose `default:` runs only when it is used: the call's value, with or without the default. */
  | "default-accepted"
  /** A `load` with a default has read its key; the default may run. */
  | "default-probe"
  /** The receiver and index of an assignment through a member or element are evaluated (the receiver rule R). */
  | "target-prepared"
  /** A statement's effect, after its expressions. */
  | "statement"
  /** After a `call` of a file returns. */
  | "call-out"
  | "branch"
  | "join"
  | "loop-head"
  /** A loop body's entry; for a `for` loop also the binding of its variables (F27). */
  | "loop-body"
  | "loop-exit";

export interface FlowNode {
  readonly id: number;
  readonly kind: FlowNodeKind;
  /** The index of its region in {@link FlowGraph.regions}. */
  readonly region: number;
  readonly file: number;
  readonly span: SourceSpan | null;
  /** The heads of the loops around it in its function, file or block, outermost first (X5). */
  readonly loops: readonly FlowNode[];
  readonly successors: readonly FlowNode[];
  readonly predecessors: readonly FlowNode[];
  /** No way over live edges leads to it from the session's start (X1). */
  readonly dead: boolean;
  /** The expression of an `expression` node. */
  readonly expression?: Expression;
  /** The statement of a `statement` node. */
  readonly statement?: Statement;
  /** The statement node whose expressions include this node, for a node of a statement's own expressions. */
  readonly enclosing?: FlowNode;
  /** For an assignment through a member or element: the node where its receiver is prepared (R). */
  readonly prepared?: FlowNode;
  /** For a label: the node it follows in the text, or `null` after code that does not go on (X4, L5). */
  readonly fallthrough?: FlowNode | null;
}

interface RegionBase {
  readonly id: number;
  readonly file: number;
  readonly entry: FlowNode;
  readonly exit: FlowNode;
  /** The region it stands in: a function's file, a block's creator; `null` for a file and the startup region. */
  readonly parent: number | null;
  /** The call sites that may enter it. */
  readonly sites: readonly CallSite[];
}

/** The session-start values of the globals and speakers, in the order a session sets them up (ADR 0022 §6). */
export interface StartupRegion extends RegionBase {
  readonly kind: "startup";
}

export interface FileRegion extends RegionBase {
  readonly kind: "file";
  readonly path: string;
}

export interface FunctionRegion extends RegionBase {
  readonly kind: "function";
  readonly declaration: FunctionDeclaration;
  readonly void: FlowNode;
  /** The binding node of each parameter, by name. */
  readonly parameters: ReadonlyMap<string, FlowNode>;
}

/** A timer, media, or permanent button block, which runs later, at a wait or interaction. */
export interface HandlerRegion extends RegionBase {
  readonly kind: "handler";
  readonly block: Block;
  /** The node of the statement or expression that registers it. */
  readonly creation: FlowNode;
  readonly handler: "timer" | "media" | "button";
}

export type FlowRegion = StartupRegion | FileRegion | FunctionRegion | HandlerRegion;

/** A function or a file: what a call enters and an activation runs. */
export type Callable = FileRegion | FunctionRegion;

/**
 * A call: a call of a function, or a `call` of a file. A `call` of a glob or of a computed target is one site that
 * may enter every candidate file (L11).
 */
export interface CallSite {
  readonly id: number;
  readonly kind: "function" | "file";
  /** The node that enters the callees: the call's `call-in` node, or the `call` statement's node. */
  readonly callIn: FlowNode;
  /** Where the caller goes on once the callee returns: the end of the summary edge from {@link callIn}. */
  readonly callOut: FlowNode;
  readonly callees: readonly Callable[];
  /** The region the call stands in. */
  readonly caller: number;
  /** The call of a function site. */
  readonly call: CallExpression | null;
  /** A glob or computed target, which chooses among the callees when it runs. */
  readonly uncertain: boolean;
}

/** A `goto`: the label or the file entries it may continue at. */
export interface Jump {
  readonly kind: "label" | "file";
  readonly node: FlowNode;
  readonly targets: readonly FlowNode[];
  /** The files it continues in: the label's own file, or the files it may start. */
  readonly files: readonly FileRegion[];
}

/** An operand that needs a kind: a `repeat` count, a list index or a dict key (C2, C12), by where it stands. */
export interface OperandUse {
  readonly file: number;
  /** The `repeat` statement, the index expression or assignment target, or the dict literal's key. */
  readonly span: SourceSpan;
  /** The operand without its parentheses. */
  readonly operand: Expression;
}

/** A condition (C3) or `switch` subject that chooses among branches, which it guards (§3.2). */
export interface GuardUse extends OperandUse {
  /** The entries of the branches it chooses among, the way past them included. */
  readonly branches: readonly FlowNode[];
}

/** A `while`, `repeat` or `for` loop. */
export interface FlowLoop {
  readonly statement: WhileStatement | RepeatStatement | ForStatement;
  /** Where a round ends: the body runs again from it, or the loop is left (X5's loop). */
  readonly head: FlowNode;
  /** The body's entry, which binds a `for` loop's variables (F27). */
  readonly body: FlowNode;
  readonly exit: FlowNode;
}

export interface FlowGraph {
  readonly files: readonly { readonly path: string; readonly program: Program }[];
  readonly nodes: readonly FlowNode[];
  readonly regions: readonly FlowRegion[];
  readonly sites: readonly CallSite[];
  readonly jumps: readonly Jump[];
  readonly program: { readonly entry: FlowNode; readonly end: FlowNode };
  readonly startup: StartupRegion;
  readonly callables: readonly Callable[];
  readonly countUses: readonly OperandUse[];
  readonly indexUses: readonly OperandUse[];
  readonly keyUses: readonly OperandUse[];
  readonly conditionUses: readonly GuardUse[];
  readonly switchUses: readonly GuardUse[];
  readonly loops: readonly FlowLoop[];
  /** The heads of the loops that a `break` (its own loop) or a `goto` (every loop around it) may leave (F5a). */
  readonly leftBy: ReadonlySet<FlowNode>;
  /** Every `and` and `or`, whose right operand runs after its left, in evaluation order of their left operands. */
  readonly logicals: readonly { readonly file: number; readonly expression: BinaryExpression }[];
  /** The callables in a cycle of calls. */
  readonly recursive: ReadonlySet<Callable>;
  /** The callables that a block may run, through calls, file transfers and jumps. */
  readonly blockCalled: ReadonlySet<Callable>;
  /** The nodes after a label that a `goto` in a block may reach. */
  readonly blockReached: ReadonlySet<FlowNode>;
  /** The files that hold a label. */
  readonly labelled: ReadonlySet<FileRegion>;
  isDeadEdge(from: FlowNode, to: FlowNode): boolean;
  /** The function or file whose activation runs the region's code: a block's creator's; `null` for the startup. */
  callableOf(region: number): Callable | null;
  /** As {@link callableOf}, but `null` for a block's code, which a handler runs. */
  ownerOf(region: number): Callable | null;
  /** The node of the expression at `site`. */
  expressionAt(site: SourceSite): FlowNode | undefined;
  /** The node of the statement at `site`; for a global or speaker, its session-start value. */
  statementAt(site: SourceSite): FlowNode | undefined;
  /** The binding node of the `for` loop whose statement or iterable is at `site`. */
  loopBindingAt(site: SourceSite): FlowNode | undefined;
}

/** The key of a source site, as `placeKey` of `way-facts.ts` writes it. */
function siteKey(file: number, start: number, end: number): string {
  return `${file}:${start}:${end}`;
}

/**
 * The graph of a project's files, in project order: `main.tease` first, where the session starts, as the lowering
 * orders them (`compileStableProject`).
 */
export function buildFlowGraph(
  files: readonly { readonly path: string; readonly program: Program }[],
): FlowGraph {
  return new FlowGraphBuilder(files).build();
}

/** A node while the graph is built: its edge lists grow and its liveness is decided at the end. */
interface BuildNode extends FlowNode {
  readonly loops: readonly BuildNode[];
  readonly successors: BuildNode[];
  readonly predecessors: BuildNode[];
  dead: boolean;
  enclosing?: BuildNode;
}

/** Where a statement or expression stands while the graph is built. */
interface WalkContext {
  readonly region: number;
  readonly file: number;
  /** The file region of the code, or `null` in the startup region. */
  readonly fileRegion: FileRegion | null;
  readonly loops: readonly BuildNode[];
  readonly loop: { readonly head: BuildNode; readonly exit: BuildNode } | null;
  readonly function: FunctionRegion | null;
  readonly handler: HandlerRegion | null;
  /** The nodes of the current statement's own expressions, which its statement node encloses. */
  readonly own: BuildNode[];
}

/** A function call whose callee is resolved once every file's functions are known. */
interface PendingCall {
  readonly callIn: FlowNode;
  readonly callOut: FlowNode;
  readonly name: string;
  readonly file: number;
  readonly caller: number;
  readonly call: CallExpression;
}

/** A `goto` or `call` whose target is resolved once every file and label is known. */
interface PendingTransfer {
  readonly node: FlowNode;
  readonly callOut: FlowNode | null;
  readonly file: number;
  readonly caller: number;
  readonly target: Extract<Statement, { kind: "gotoStatement" }>["target"];
}

/** The parameter binding nodes whose default an always-supplied or never-supplied argument decides. */
interface DefaultChoice {
  readonly function: FunctionRegion;
  readonly index: number;
  readonly name: string;
  /** The node before the default, which leads to its first node and, skipping it, to the binding. */
  readonly before: FlowNode;
  readonly binding: FlowNode;
}

/**
 * Edges are keyed by their ends' ids in one number, which stays exact while ids stay below this bound; a graph that
 * large holds far more nodes than memory allows, so the bound is never reached.
 */
const NODE_ID_BOUND = 2 ** 26;

class FlowGraphBuilder {
  readonly #nodes: BuildNode[] = [];
  readonly #regions: FlowRegion[] = [];
  readonly #regionSites: CallSite[][] = [];
  readonly #callableOf: (Callable | null)[] = [];
  readonly #ownerOf: (Callable | null)[] = [];
  readonly #sites: CallSite[] = [];
  readonly #jumps: Jump[] = [];
  readonly #edges = new Set<number>();
  readonly #deadEdges = new Set<number>();
  readonly #expressionNodes = new Map<string, BuildNode>();
  readonly #statementNodes = new Map<string, BuildNode>();
  readonly #loopBindings = new Map<string, BuildNode>();
  readonly #labels = new Map<string, BuildNode>();
  readonly #functions = new Map<string, FunctionRegion>();
  readonly #globalFunctions = new Map<string, FunctionRegion>();
  readonly #fileRegions: FileRegion[] = [];
  readonly #handlers: HandlerRegion[] = [];
  readonly #pendingCalls: PendingCall[] = [];
  readonly #pendingTransfers: PendingTransfer[] = [];
  readonly #defaultChoices: DefaultChoice[] = [];
  /** The `end` statements of functions and blocks, which end whichever file is running. */
  readonly #ends: BuildNode[] = [];
  readonly #countUses: OperandUse[] = [];
  readonly #indexUses: OperandUse[] = [];
  readonly #keyUses: OperandUse[] = [];
  readonly #conditionUses: GuardUse[] = [];
  readonly #switchUses: GuardUse[] = [];
  readonly #loops: FlowLoop[] = [];
  readonly #leftBy = new Set<FlowNode>();
  readonly #logicals: { readonly file: number; readonly expression: BinaryExpression }[] = [];
  readonly #labelled = new Set<FileRegion>();
  readonly #program: { readonly entry: BuildNode; readonly end: BuildNode };
  readonly #startup: StartupRegion;

  public constructor(
    private readonly files: readonly { readonly path: string; readonly program: Program }[],
  ) {
    this.#program = {
      entry: this.#node("program-entry", -1, -1, null, []),
      end: this.#node("program-end", -1, -1, null, []),
    };
    const id = this.#regions.length;
    const sites: CallSite[] = [];
    this.#startup = {
      kind: "startup",
      id,
      file: 0,
      entry: this.#node("startup-entry", id, 0, null, []),
      exit: this.#node("startup-exit", id, 0, null, []),
      parent: null,
      sites,
    };
    this.#addRegion(this.#startup, sites);
  }

  public build(): FlowGraph {
    const program = this.#program;
    const startup = this.#startup;
    this.#link(program.entry, startup.entry);
    let current: FlowNode = startup.entry;
    for (const { file, declaration } of sessionDeclarations(this.files.map((f) => f.program))) {
      const context = this.#context(startup.id, file, null, null, null, null, []);
      const values =
        declaration.kind === "globalStatement"
          ? [declaration.initial]
          : declaration.properties.map((property) => property.value);
      for (const value of values)
        current = runCompileTask(this.#expression(value, context, current));
      current = this.#statement(declaration, context, current);
    }
    this.#link(current, startup.exit);
    this.files.forEach((file, index) => {
      const region = this.#fileRegion(index, file.path, file.program.span);
      const context = this.#context(region.id, index, region, null, null, null, []);
      const last = runCompileTask(this.#block(file.program.statements, context, region.entry));
      this.#link(last, region.exit);
    });
    const main = this.#fileRegions[0];
    if (main !== undefined) {
      this.#link(startup.exit, main.entry);
      this.#link(main.exit, program.end);
    }
    this.#resolveCalls();
    this.#decideDefaults();
    this.#resolveTransfers();
    this.#decideReturns();
    this.#joinUnentered();
    this.#decideLiveness();
    const callables = this.#regions.filter(
      (region): region is Callable => region.kind === "file" || region.kind === "function",
    );
    const recursive = this.#recursion(callables);
    const { blockCalled, blockReached } = this.#blockReach();
    const expressionNodes = this.#expressionNodes;
    const statementNodes = this.#statementNodes;
    const loopBindings = this.#loopBindings;
    const deadEdges = this.#deadEdges;
    const callableOf = this.#callableOf;
    const ownerOf = this.#ownerOf;
    return {
      files: this.files,
      nodes: this.#nodes,
      regions: this.#regions,
      sites: this.#sites,
      jumps: this.#jumps,
      program,
      startup,
      callables,
      countUses: this.#countUses,
      indexUses: this.#indexUses,
      keyUses: this.#keyUses,
      conditionUses: this.#conditionUses,
      switchUses: this.#switchUses,
      loops: this.#loops,
      leftBy: this.#leftBy,
      logicals: this.#logicals,
      recursive,
      blockCalled,
      blockReached,
      labelled: this.#labelled,
      isDeadEdge: (from, to) => deadEdges.has(edgeKey(from, to)),
      callableOf: (region) => callableOf[region] ?? null,
      ownerOf: (region) => ownerOf[region] ?? null,
      expressionAt: (site) => expressionNodes.get(siteKey(site.file, site.start, site.end)),
      statementAt: (site) => statementNodes.get(siteKey(site.file, site.start, site.end)),
      loopBindingAt: (site) => loopBindings.get(siteKey(site.file, site.start, site.end)),
    };
  }

  // ------------------------------------------------------------------------------------------- nodes and regions

  #node(
    kind: FlowNodeKind,
    region: number,
    file: number,
    span: SourceSpan | null,
    loops: readonly BuildNode[],
    extra: Partial<Pick<BuildNode, "expression" | "statement" | "prepared" | "fallthrough">> = {},
  ): BuildNode {
    if (this.#nodes.length >= NODE_ID_BOUND)
      throw new RangeError("The flow graph has too many nodes.");
    const node: BuildNode = {
      id: this.#nodes.length,
      kind,
      region,
      file,
      span,
      loops,
      successors: [],
      predecessors: [],
      dead: false,
      ...extra,
    };
    this.#nodes.push(node);
    return node;
  }

  /** A node of the current statement's own expressions, which its statement node will enclose. */
  #own(
    kind: FlowNodeKind,
    context: WalkContext,
    span: SourceSpan | null,
    extra: Partial<Pick<BuildNode, "expression">> = {},
  ): BuildNode {
    const node = this.#node(kind, context.region, context.file, span, context.loops, extra);
    context.own.push(node);
    return node;
  }

  /** An edge, once; a dead one is never taken (P7, a call that cannot return). */
  #link(from: FlowNode | null, to: FlowNode | null, dead = false): void {
    if (from === null || to === null) return;
    const key = edgeKey(from, to);
    if (this.#edges.has(key)) return;
    this.#edges.add(key);
    const source = this.#built(from);
    const target = this.#built(to);
    source.successors.push(target);
    target.predecessors.push(source);
    if (dead) this.#deadEdges.add(key);
  }

  /**
   * Joins the code built from node `first` on that nothing leads to, such as the statements after a `return`, to `from`
   * with dead edges, so that it has dominators.
   */
  #joinDead(first: number, from: FlowNode | null): void {
    if (from === null) return;
    for (let index = first; index < this.#nodes.length; index += 1) {
      const node = this.#nodes[index]!;
      if (node.predecessors.length === 0) this.#link(from, node, true);
    }
  }

  /**
   * Adds a region, whose parent was added before it. A function stands only at a file's top level, so a region inside a
   * block is a block itself.
   */
  #addRegion(region: FlowRegion, sites: CallSite[]): void {
    this.#regions.push(region);
    this.#regionSites.push(sites);
    const own = region.kind === "file" || region.kind === "function" ? region : null;
    this.#callableOf.push(
      own ?? (region.parent === null ? null : this.#callableOf[region.parent]!),
    );
    this.#ownerOf.push(own);
  }

  /** The node with the id of `node`, as the builder holds it. */
  #built(node: FlowNode): BuildNode {
    return this.#nodes[node.id]!;
  }

  #fileRegion(file: number, path: string, span: SourceSpan): FileRegion {
    const id = this.#regions.length;
    const sites: CallSite[] = [];
    const region: FileRegion = {
      kind: "file",
      id,
      file,
      path,
      entry: this.#node("file-entry", id, file, null, []),
      exit: this.#node("file-exit", id, file, createSourceSpan(span.end, span.end), []),
      parent: null,
      sites,
    };
    this.#addRegion(region, sites);
    this.#fileRegions.push(region);
    return region;
  }

  #context(
    region: number,
    file: number,
    fileRegion: FileRegion | null,
    loop: WalkContext["loop"],
    fn: FunctionRegion | null,
    handler: HandlerRegion | null,
    loops: readonly BuildNode[],
  ): WalkContext {
    return { region, file, fileRegion, loops, loop, function: fn, handler, own: [] };
  }

  /** The context of a statement within `context`'s code: its own expressions are collected afresh. */
  #withOwn(context: WalkContext): WalkContext {
    return { ...context, own: [] };
  }

  // ------------------------------------------------------------------------------------------------ expressions

  /** The nodes of `expression` after `current`, in evaluation order; returns the node of its value. */
  *#expression(
    expression: Expression,
    context: WalkContext,
    current: FlowNode | null,
  ): CompileTask<FlowNode> {
    const file = context.file;
    const remember = (node: BuildNode): BuildNode => {
      this.#expressionNodes.set(
        siteKey(file, expression.span.start.offset, expression.span.end.offset),
        node,
      );
      return node;
    };
    if (expression.kind === "callExpression") {
      const lazy = lazyDefaultArgument(expression)?.argument;
      let cursor = yield* compileChild(this.#expression(expression.callee, context, current));
      if (expression.presentation !== undefined)
        cursor = yield* compileChild(this.#expression(expression.presentation, context, cursor));
      for (const argument of expression.arguments)
        if (argument !== lazy)
          cursor = yield* compileChild(this.#expression(argument.value, context, cursor));
      const callee = unwrap(expression.callee);
      const callIn = this.#own("call-in", context, expression.span);
      this.#link(cursor, callIn);
      const out = remember(this.#own("expression", context, expression.span, { expression }));
      this.#link(callIn, out);
      if (callee.kind === "identifier")
        this.#pendingCalls.push({
          callIn,
          callOut: out,
          name: callee.name,
          file,
          caller: context.region,
          call: expression,
        });
      if (lazy === undefined) return out;
      // P7: a `get` on a list literal with a literal index uses its default exactly when the index is past the end.
      let runs: "never" | "always" | "maybe" = "maybe";
      if (callee.kind === "propertyAccessExpression" && callee.property.name === "get") {
        const receiver = unwrap(callee.object);
        const index = expression.arguments[0];
        const position = index === undefined ? null : literalCount(index.value);
        if (receiver.kind === "listLiteral" && position !== null)
          runs = receiver.elements.length > position ? "never" : "always";
      }
      const accepted = remember(this.#own("default-accepted", context, expression.span));
      if (runs !== "never") {
        const last = yield* compileChild(this.#expression(lazy.value, context, out));
        this.#link(last, accepted);
      } else {
        const first = this.#nodes.length;
        yield* compileChild(this.#expression(lazy.value, context, null));
        this.#joinDead(first, out);
      }
      if (runs !== "always") this.#link(out, accepted);
      return accepted;
    }
    if (
      expression.kind === "binaryExpression" &&
      (expression.operator === "and" ||
        expression.operator === "or" ||
        expression.operator === "otherwise")
    ) {
      if (expression.operator !== "otherwise") this.#logicals.push({ file, expression });
      const left = yield* compileChild(this.#expression(expression.left, context, current));
      // P7: a literal left operand decides whether the right one runs.
      let runs: "never" | "always" | "maybe" = "maybe";
      if (expression.operator === "otherwise") {
        const leftValue = unwrap(expression.left);
        if (leftValue.kind === "nullLiteral") runs = "always";
        else if (NON_NULL_LITERALS.has(leftValue.kind)) runs = "never";
      } else {
        const value = literalTruth(expression.left);
        if (value !== null) runs = value === (expression.operator === "and") ? "always" : "never";
      }
      const node = remember(this.#own("expression", context, expression.span, { expression }));
      if (runs !== "never") {
        const right = yield* compileChild(this.#expression(expression.right, context, left));
        this.#link(right, node);
      } else {
        const first = this.#nodes.length;
        yield* compileChild(this.#expression(expression.right, context, null));
        this.#joinDead(first, left);
      }
      if (runs !== "always") this.#link(left, node);
      return node;
    }
    if (expression.kind === "loadExpression" && expression.defaultValue !== null) {
      const key = yield* compileChild(this.#expression(expression.key, context, current));
      const probe = this.#own("default-probe", context, expression.span);
      this.#link(key, probe);
      const value = yield* compileChild(this.#expression(expression.defaultValue, context, probe));
      const node = remember(this.#own("expression", context, expression.span, { expression }));
      this.#link(value, node);
      this.#link(probe, node);
      return node;
    }
    if (expression.kind === "indexExpression")
      this.#indexUses.push({ file, span: expression.span, operand: unwrap(expression.index) });
    if (expression.kind === "dictLiteral")
      for (const entry of expression.entries)
        this.#keyUses.push({ file, span: entry.key.span, operand: unwrap(entry.key) });
    let cursor = current;
    for (const part of expressionParts(expression))
      cursor = yield* compileChild(this.#expression(part, context, cursor));
    const node = remember(this.#own("expression", context, expression.span, { expression }));
    this.#link(cursor, node);
    for (const block of handlerBlocks(expression))
      yield* compileChild(this.#handlerRegion(block, node, context, expression.kind));
    return node;
  }

  /** A timer, media, or button block registered at `creation`. */
  *#handlerRegion(
    block: Block,
    creation: FlowNode,
    context: WalkContext,
    registeredBy: Statement["kind"] | Expression["kind"],
  ): CompileTask<void> {
    const id = this.#regions.length;
    const sites: CallSite[] = [];
    const region: HandlerRegion = {
      kind: "handler",
      id,
      file: context.file,
      block,
      creation,
      handler: registeredBy.startsWith("timer")
        ? "timer"
        : registeredBy.startsWith("playMedia")
          ? "media"
          : "button",
      entry: this.#node("handler-entry", id, context.file, null, []),
      exit: this.#node(
        "handler-exit",
        id,
        context.file,
        createSourceSpan(block.span.end, block.span.end),
        [],
      ),
      parent: context.region,
      sites,
    };
    this.#addRegion(region, sites);
    this.#handlers.push(region);
    this.#link(creation, region.entry);
    const inner = this.#context(id, context.file, context.fileRegion, null, null, region, []);
    const last = yield* compileChild(this.#block(block.statements, inner, region.entry));
    this.#link(last, region.exit);
  }

  // ------------------------------------------------------------------------------------------------- statements

  /**
   * The statements of a block after `current`; returns where the code after them goes on, or `null` when no way leads
   * past them. Statements that no way reaches are built all the same, joined to the code before them by dead edges.
   */
  *#block(
    statements: readonly Statement[],
    context: WalkContext,
    current: FlowNode | null,
  ): CompileTask<FlowNode | null> {
    let lastLive = current;
    let deadCursor: FlowNode | null = null;
    for (const statement of statements) {
      if (current === null) {
        if (statement.kind === "labelStatement") {
          // A label after code that does not go on is reached only by a `goto`; until then it is dead code.
          const label = yield* compileChild(this.#statementTask(statement, context, null));
          this.#link(lastLive, label, true);
          current = label;
          deadCursor = null;
          continue;
        }
        const first = this.#nodes.length;
        const next: FlowNode | null = yield* compileChild(
          this.#statementTask(statement, context, deadCursor),
        );
        if (deadCursor === null) this.#joinDead(first, lastLive);
        deadCursor = next;
        continue;
      }
      lastLive = current;
      current = yield* compileChild(this.#statementTask(statement, context, current));
    }
    return current;
  }

  /** A statement's own node after its expressions. */
  #statement(
    statement: Statement,
    context: WalkContext,
    current: FlowNode | null,
    extra: Partial<Pick<BuildNode, "prepared" | "fallthrough">> = {},
  ): BuildNode {
    const node = this.#node(
      "statement",
      context.region,
      context.file,
      statement.span,
      context.loops,
      { statement, ...extra },
    );
    this.#statementNodes.set(
      siteKey(context.file, statement.span.start.offset, statement.span.end.offset),
      node,
    );
    this.#link(current, node);
    for (const own of context.own) own.enclosing ??= node;
    return node;
  }

  *#expressionsThenStatement(
    statement: Statement,
    context: WalkContext,
    current: FlowNode | null,
  ): CompileTask<FlowNode> {
    let cursor = current;
    for (const expression of statementExpressions(statement))
      cursor = yield* compileChild(this.#expression(expression, context, cursor));
    return this.#statement(statement, context, cursor);
  }

  *#statementTask(
    statement: Statement,
    outer: WalkContext,
    current: FlowNode | null,
  ): CompileTask<FlowNode | null> {
    const context = this.#withOwn(outer);
    const { file, region, loops } = context;
    switch (statement.kind) {
      case "functionDeclaration":
        yield* compileChild(this.#functionRegion(statement, context));
        return current;
      case "globalStatement":
        // The session-start value is in the startup region; with `default:`, the declaration assigns where it stands.
        return statement.assignment === null
          ? current
          : yield* compileChild(this.#statementTask(statement.assignment, context, current));
      case "speakerDeclaration":
        // A speaker is set up at the start of the session (the startup region).
        return current;
      case "assignmentStatement": {
        let cursor = current;
        let prepared: BuildNode | null = null;
        if (statement.target.kind === "identifier") {
          if (statement.operator !== "=") {
            // A compound assignment reads its variable first.
            cursor = yield* compileChild(this.#expression(statement.target, context, cursor));
          }
        } else {
          if (statement.target.kind === "indexExpression")
            this.#indexUses.push({
              file,
              span: statement.target.span,
              operand: unwrap(statement.target.index),
            });
          for (const part of expressionChildren(statement.target))
            cursor = yield* compileChild(this.#expression(part, context, cursor));
          prepared = this.#own("target-prepared", context, statement.target.span);
          this.#link(cursor, prepared);
          cursor = prepared;
        }
        cursor = yield* compileChild(this.#expression(statement.value, context, cursor));
        return this.#statement(statement, context, cursor, prepared === null ? {} : { prepared });
      }
      case "ifStatement": {
        const condition = yield* compileChild(
          this.#expression(statement.condition, context, current),
        );
        const branches: BuildNode[] = [];
        this.#conditionUses.push({
          file,
          span: statement.condition.span,
          operand: unwrap(statement.condition),
          branches,
        });
        const value = literalTruth(statement.condition);
        const join = this.#node("join", region, file, null, loops);
        const thenStart = this.#node("branch", region, file, null, loops);
        branches.push(thenStart);
        this.#link(condition, thenStart, value === false);
        const thenEnd = yield* compileChild(
          this.#block(statement.thenBlock.statements, context, thenStart),
        );
        this.#link(thenEnd, join, value === false);
        if (statement.elseBlock !== null) {
          const elseStart = this.#node("branch", region, file, null, loops);
          branches.push(elseStart);
          this.#link(condition, elseStart, value === true);
          const elseEnd =
            statement.elseBlock.kind === "ifStatement"
              ? yield* compileChild(this.#statementTask(statement.elseBlock, context, elseStart))
              : yield* compileChild(
                  this.#block(statement.elseBlock.statements, context, elseStart),
                );
          this.#link(elseEnd, join, value === true);
        } else {
          // §3.2: the way past an `if` without `else` is a branch of its test too, so the code after a branch that always
          // leaves is under the test's negation (the way past dominates it).
          const skip = this.#node("branch", region, file, null, loops);
          branches.push(skip);
          this.#link(condition, skip, value === true);
          this.#link(skip, join, value === true);
        }
        return join;
      }
      case "whileStatement": {
        const head = this.#node("loop-head", region, file, statement.span, loops);
        this.#link(current, head);
        const exit = this.#node("loop-exit", region, file, null, loops);
        const inner = { ...context, loops: [...loops, head], loop: { head, exit } };
        const condition = yield* compileChild(this.#expression(statement.condition, inner, head));
        const branches: BuildNode[] = [];
        this.#conditionUses.push({
          file,
          span: statement.condition.span,
          operand: unwrap(statement.condition),
          branches,
        });
        const value = literalTruth(statement.condition);
        const body = this.#node("loop-body", region, file, null, inner.loops);
        branches.push(body);
        this.#link(condition, body, value === false);
        this.#link(condition, exit, value === true);
        this.#loops.push({ statement, head, body, exit });
        const bodyEnd = yield* compileChild(this.#block(statement.body.statements, inner, body));
        this.#link(bodyEnd, head);
        return exit;
      }
      case "repeatStatement":
      case "forStatement": {
        const isRepeat = statement.kind === "repeatStatement";
        const counted = yield* compileChild(
          this.#expression(isRepeat ? statement.count : statement.iterable, context, current),
        );
        if (isRepeat)
          this.#countUses.push({ file, span: statement.span, operand: unwrap(statement.count) });
        const count = isRepeat ? literalCount(statement.count) : null;
        const head = this.#node("loop-head", region, file, statement.span, loops);
        const exit = this.#node("loop-exit", region, file, null, loops);
        const inner = { ...context, loops: [...loops, head], loop: { head, exit } };
        const body = this.#node("loop-body", region, file, null, inner.loops);
        this.#loops.push({ statement, head, body, exit });
        if (statement.kind === "forStatement") {
          this.#loopBindings.set(
            siteKey(file, statement.span.start.offset, statement.span.end.offset),
            body,
          );
          this.#loopBindings.set(
            siteKey(file, statement.iterable.span.start.offset, statement.iterable.span.end.offset),
            body,
          );
        }
        // The head is where a round ends: the body runs again from it, or the loop is left.
        if (count !== null && count <= 0) {
          // P7: the body never runs.
          this.#link(counted, exit);
          this.#link(counted, head, true);
          this.#link(head, body);
          const bodyEnd = yield* compileChild(this.#block(statement.body.statements, inner, body));
          this.#link(bodyEnd, head);
          return exit;
        }
        if (count === 1) {
          // P7: the body runs once; a `continue` ends that round, and with it the loop.
          this.#link(counted, body);
          const bodyEnd = yield* compileChild(this.#block(statement.body.statements, inner, body));
          this.#link(bodyEnd, exit);
          this.#link(counted, head, true);
          this.#link(head, exit);
          return exit;
        }
        // P7: a literal count of one or more runs the body before the loop can be left.
        this.#link(counted, count !== null ? body : head);
        this.#link(head, exit);
        this.#link(head, body);
        const bodyEnd = yield* compileChild(this.#block(statement.body.statements, inner, body));
        this.#link(bodyEnd, head);
        return exit;
      }
      case "switchStatement": {
        let cursor = current;
        for (const expression of statementExpressions(statement))
          cursor = yield* compileChild(this.#expression(expression, context, cursor));
        const branches: BuildNode[] = [];
        this.#switchUses.push({
          file,
          span: statement.subject.span,
          operand: unwrap(statement.subject),
          branches,
        });
        const join = this.#node("join", region, file, null, loops);
        // P7: a literal subject with literal case values decides the case that runs.
        const subject = caseValueKey(statement.subject);
        let decided = false;
        let allKnown = subject !== undefined;
        for (const switchCase of statement.cases) {
          const values = switchCase.values.map(caseValueKey);
          const known =
            subject !== undefined &&
            switchCase.typeTest === null &&
            values.every((value) => value !== undefined);
          if (!known) allKnown = false;
          const dead = known && (decided || !values.includes(subject));
          if (known && !decided && values.includes(subject)) decided = true;
          const start = this.#node("branch", region, file, null, loops);
          branches.push(start);
          this.#link(cursor, start, dead);
          const end = yield* compileChild(this.#block(switchCase.body.statements, context, start));
          this.#link(end, join, dead);
        }
        const noCase = allKnown && decided;
        const start = this.#node("branch", region, file, null, loops);
        branches.push(start);
        this.#link(cursor, start, noCase);
        const end =
          statement.defaultBlock === null
            ? start
            : yield* compileChild(this.#block(statement.defaultBlock.statements, context, start));
        this.#link(end, join, noCase);
        return join;
      }
      case "returnStatement": {
        const node = yield* compileChild(
          this.#expressionsThenStatement(statement, context, current),
        );
        if (context.function !== null)
          this.#link(
            node,
            statement.value !== null ? context.function.exit : context.function.void,
          );
        else if (context.handler !== null) this.#link(node, context.handler.exit);
        return null;
      }
      case "breakStatement": {
        const node = this.#statement(statement, context, current);
        if (context.loop !== null) {
          this.#link(node, context.loop.exit);
          this.#leftBy.add(context.loop.head);
        }
        return null;
      }
      case "continueStatement": {
        const node = this.#statement(statement, context, current);
        if (context.loop !== null) this.#link(node, context.loop.head);
        return null;
      }
      case "exitStatement": {
        const node = this.#statement(statement, context, current);
        this.#link(node, this.#program.end);
        return null;
      }
      case "endStatement": {
        // `end` ends the running file: at a file's top level that file; in a function or block whichever file runs it,
        // which the returns of calls take into account (see `#decideReturns`).
        const node = this.#statement(statement, context, current);
        if (context.function === null && context.handler === null)
          this.#link(node, context.fileRegion?.exit ?? null);
        else this.#ends.push(node);
        return null;
      }
      case "labelStatement": {
        const node = this.#statement(statement, context, current, { fallthrough: current });
        this.#labels.set(`${file}:${statement.name.name}`, node);
        if (context.fileRegion !== null) this.#labelled.add(context.fileRegion);
        return node;
      }
      case "gotoStatement":
      case "callFileStatement": {
        if (statement.kind === "gotoStatement") for (const loop of loops) this.#leftBy.add(loop);
        const node = yield* compileChild(
          this.#expressionsThenStatement(statement, context, current),
        );
        const callOut =
          statement.kind === "callFileStatement"
            ? this.#node("call-out", region, file, statement.span, loops)
            : null;
        this.#link(node, callOut);
        this.#pendingTransfers.push({
          node,
          callOut,
          file,
          caller: region,
          target: statement.target,
        });
        return callOut;
      }
      case "letStatement":
      case "expressionStatement":
      case "waitStatement":
      case "sayStatement":
      case "speakerSetterStatement":
      case "showButtonStatement":
      case "timerStatement":
      case "showImageStatement":
      case "hideImageStatement":
      case "showCameraStatement":
      case "hideCameraStatement":
      case "showPopupStatement":
      case "openUrlStatement":
      case "exportTextStatement":
      case "showPermanentButtonStatement":
      case "playMediaStatement":
      case "stopAudioStatement":
      case "saveStatement":
      case "deleteStatement": {
        const node = yield* compileChild(
          this.#expressionsThenStatement(statement, context, current),
        );
        for (const block of handlerBlocks(statement))
          yield* compileChild(this.#handlerRegion(block, node, context, statement.kind));
        return node;
      }
    }
    statement satisfies never;
    return current;
  }

  /** A function's region: its parameters' bindings, each after its default, then its body. */
  *#functionRegion(declaration: FunctionDeclaration, context: WalkContext): CompileTask<void> {
    const id = this.#regions.length;
    const file = context.file;
    const sites: CallSite[] = [];
    const entry = this.#node("function-entry", id, file, null, []);
    const exit = this.#node(
      "function-exit",
      id,
      file,
      createSourceSpan(declaration.span.end, declaration.span.end),
      [],
    );
    const end = this.#node("function-void", id, file, null, []);
    const parameters = new Map<string, BuildNode>();
    const region: FunctionRegion = {
      kind: "function",
      id,
      file,
      declaration,
      entry,
      exit,
      void: end,
      parameters,
      parent: context.region,
      sites,
    };
    this.#addRegion(region, sites);
    this.#link(end, exit);
    const name = declaration.name.name;
    this.#functions.set(`${file}:${name}`, region);
    if (declaration.global && !this.#globalFunctions.has(name))
      this.#globalFunctions.set(name, region);
    const inner = this.#context(id, file, context.fileRegion, null, region, null, []);
    let cursor: FlowNode = entry;
    for (const [index, parameter] of declaration.parameters.entries()) {
      const binding = this.#node("parameter", id, file, parameter.span, []);
      parameters.set(parameter.name.name, binding);
      if (parameter.defaultValue !== null) {
        // F21: an omitted argument takes the default, evaluated in the callee; a supplied one skips it.
        const own = this.#withOwn(inner);
        const value = yield* compileChild(this.#expression(parameter.defaultValue, own, cursor));
        this.#link(value, binding);
        this.#defaultChoices.push({
          function: region,
          index,
          name: parameter.name.name,
          before: cursor,
          binding,
        });
      }
      this.#link(cursor, binding);
      cursor = binding;
    }
    const last = yield* compileChild(this.#block(declaration.body.statements, inner, cursor));
    this.#link(last, end);
  }

  // -------------------------------------------------------------------------------------------- calls and jumps

  #addSite(site: Omit<CallSite, "id">): CallSite {
    const added: CallSite = { id: this.#sites.length, ...site };
    this.#sites.push(added);
    for (const callee of site.callees) {
      this.#regionSites[callee.id]!.push(added);
      this.#link(this.#built(site.callIn), this.#built(callee.entry));
    }
    return added;
  }

  /** A call names a function of its own file, or else a global function of the project. */
  #resolveCalls(): void {
    for (const call of this.#pendingCalls) {
      const callee =
        this.#functions.get(`${call.file}:${call.name}`) ?? this.#globalFunctions.get(call.name);
      if (callee === undefined) continue;
      this.#addSite({
        kind: "function",
        callIn: call.callIn,
        callOut: call.callOut,
        callees: [callee],
        caller: call.caller,
        call: call.call,
        uncertain: false,
      });
    }
  }

  /** P7: a default that every call supplies never runs, and one that no call supplies always runs. */
  #decideDefaults(): void {
    for (const choice of this.#defaultChoices) {
      const sites = choice.function.sites;
      if (sites.length === 0) continue;
      const supplied = sites.map(
        (site) => site.call !== null && supplies(site.call, choice.index, choice.name),
      );
      if (supplied.every(Boolean)) {
        for (const next of choice.before.successors)
          if (next !== choice.binding) this.#deadEdges.add(edgeKey(choice.before, next));
      } else if (!supplied.some(Boolean))
        this.#deadEdges.add(edgeKey(choice.before, choice.binding));
    }
  }

  /**
   * A `goto` continues at a label of its file or starts a file at its top; a `call` starts a file and is one call site.
   * A glob may pick each file it matches that runs something, as the name pass decides; a computed target may name any
   * file (L11). A file target's label is an error of the name pass, so the file starts at its top.
   */
  #resolveTransfers(): void {
    const byPath = new Map(this.#fileRegions.map((region) => [region.path, region]));
    const paths = this.#fileRegions.map((region) => region.path);
    const runs = (region: FileRegion): boolean =>
      this.files[region.file]!.program.statements.some(runsOnItsOwn);
    for (const transfer of this.#pendingTransfers) {
      const target = transfer.target;
      let files: FileRegion[];
      let entries: FlowNode[];
      let uncertain = false;
      if (target.kind === "labelTarget") {
        const label = this.#labels.get(`${transfer.file}:${target.label.name}`);
        const own = this.#fileRegions[transfer.file];
        files = own === undefined ? [] : [own];
        entries = label === undefined ? [] : [label];
      } else {
        if (target.kind === "scriptTarget") {
          files = [...this.#fileRegions];
          uncertain = true;
        } else if (isPathGlob(target.path)) {
          files = globMatches(target.path, paths)
            .map((path) => byPath.get(path)!)
            .filter(runs);
          uncertain = true;
        } else {
          const file = byPath.get(target.path);
          files = file === undefined ? [] : [file];
        }
        entries = files.map((file) => file.entry);
      }
      if (transfer.callOut === null) {
        for (const entry of entries) this.#link(transfer.node, entry);
        this.#jumps.push({
          kind: target.kind === "labelTarget" ? "label" : "file",
          node: transfer.node,
          targets: entries,
          files,
        });
      } else if (files.length > 0)
        this.#addSite({
          kind: "file",
          callIn: transfer.node,
          callOut: transfer.callOut,
          callees: files,
          caller: transfer.caller,
          call: null,
          uncertain,
        });
    }
  }

  /**
   * Which calls can return, by one least fixpoint over the units of code: each function, each file's top level and
   * each block. A unit is searched once from its entry over its own nodes, and a call's summary edge is followed only
   * once its callee is known to return; each node is visited once. A function returns when its search reaches its exit.
   * A file's activation returns to its caller at an `end` of its top level, at an `end` in a function it calls, through
   * a file it starts with `goto` that returns, or at an `end` of a block, which may run while any file runs. A function
   * may end the running file through an `end`, a function that may, a `goto` of a file that returns, or a `goto` of a
   * label, which leaves it for its file's code. A summary edge whose callees cannot return is dead (L10, L11).
   */
  #decideReturns(): void {
    const regions = this.#regions;
    const returns = new Uint8Array(regions.length);
    const ends = new Uint8Array(regions.length);
    const visited = new Uint8Array(this.#nodes.length);
    let blockEnds = false;
    const sitesByCallIn = new Map<FlowNode, CallSite>();
    for (const site of this.#sites) sitesByCallIn.set(site.callIn, site);
    const jumpsByNode = new Map<FlowNode, Jump>();
    for (const jump of this.#jumps) jumpsByNode.set(jump.node, jump);
    const endNodes = new Set<FlowNode>(this.#ends);
    /**
     * What waits for a callable to return or to end the running file: a unit's search that goes on past a summary edge,
     * or a unit that then may end the running file itself.
     */
    type Waiting =
      | { readonly kind: "follow"; readonly unit: number; readonly site: CallSite }
      | { readonly kind: "ends"; readonly unit: number };
    const waitingForReturn = new Map<number, Waiting[]>();
    const waitingForEnd = new Map<number, Waiting[]>();
    const wait = (on: Map<number, Waiting[]>, region: number, waiting: Waiting): void => {
      const list = on.get(region);
      if (list === undefined) on.set(region, [waiting]);
      else list.push(waiting);
    };
    const work: { readonly unit: number; readonly node: BuildNode }[] = [];
    const visit = (unit: number, node: FlowNode): void => {
      if (visited[node.id] === 1) return;
      visited[node.id] = 1;
      work.push({ unit, node: this.#built(node) });
    };
    const wake = (waiting: Waiting): void => {
      if (waiting.kind === "ends") markEnds(waiting.unit);
      else if (!this.#deadEdges.has(edgeKey(waiting.site.callIn, waiting.site.callOut)))
        visit(waiting.unit, waiting.site.callOut);
    };
    const markReturns = (region: number): void => {
      if (returns[region] === 1) return;
      returns[region] = 1;
      const list = waitingForReturn.get(region) ?? [];
      waitingForReturn.delete(region);
      for (const waiting of list) wake(waiting);
    };
    /** The unit's activation may end the running file: a file returns, a function ends its caller's, a block any. */
    const markEnds = (unit: number): void => {
      const region = regions[unit]!;
      if (region.kind === "file") return markReturns(unit);
      if (region.kind === "handler") {
        if (blockEnds) return;
        blockEnds = true;
        for (const file of this.#fileRegions) markReturns(file.id);
        return;
      }
      if (ends[unit] === 1) return;
      ends[unit] = 1;
      const list = waitingForEnd.get(unit) ?? [];
      waitingForEnd.delete(unit);
      for (const waiting of list) wake(waiting);
    };
    for (const region of regions) if (region.kind !== "startup") visit(region.id, region.entry);
    while (work.length > 0) {
      const { unit, node } = work.pop()!;
      const region = regions[unit]!;
      if (node === region.exit && (region.kind === "function" || region.kind === "file"))
        markReturns(unit);
      if (endNodes.has(node)) markEnds(unit);
      const site = sitesByCallIn.get(node);
      if (site !== undefined)
        for (const callee of site.callees) {
          if (returns[callee.id] === 1) wake({ kind: "follow", unit, site });
          else wait(waitingForReturn, callee.id, { kind: "follow", unit, site });
          if (callee.kind !== "function") continue;
          if (ends[callee.id] === 1) markEnds(unit);
          else wait(waitingForEnd, callee.id, { kind: "ends", unit });
        }
      const jump = jumpsByNode.get(node);
      if (jump?.kind === "label") {
        // Within a file's top level the jump goes on at its label; from a function or block it leaves them for it.
        if (region.kind !== "file") markEnds(unit);
      } else if (jump !== undefined)
        for (const file of jump.files) {
          if (returns[file.id] === 1) markEnds(unit);
          else wait(waitingForReturn, file.id, { kind: "ends", unit });
        }
      for (const next of node.successors) {
        if (next.region !== unit || next === site?.callOut) continue;
        if (!this.#deadEdges.has(edgeKey(node, next))) visit(unit, next);
      }
    }
    for (const site of this.#sites)
      if (!site.callees.some((callee) => returns[callee.id] === 1))
        this.#deadEdges.add(edgeKey(site.callIn, site.callOut));
  }

  /**
   * A function nothing calls, a file nothing enters, and every node that no edge reaches, such as a label nothing jumps
   * to, hang below the startup region by dead edges, so that every node has a dominator.
   */
  #joinUnentered(): void {
    const from = this.#built(this.#startup.exit);
    for (const region of this.#regions)
      if (
        (region.kind === "function" || region.kind === "file") &&
        region.entry.predecessors.length === 0
      )
        this.#link(from, this.#built(region.entry), true);
    for (const node of this.#nodes)
      if (node.predecessors.length === 0 && node !== this.#program.entry)
        this.#link(from, node, true);
  }

  #decideLiveness(): void {
    const live = new Uint8Array(this.#nodes.length);
    const work: BuildNode[] = [this.#program.entry];
    live[this.#program.entry.id] = 1;
    while (work.length > 0) {
      const node = work.pop()!;
      for (const next of node.successors)
        if (live[next.id] === 0 && !this.#deadEdges.has(edgeKey(node, next))) {
          live[next.id] = 1;
          work.push(next);
        }
    }
    for (const node of this.#nodes) node.dead = live[node.id] === 0;
  }

  /** The callables in a cycle of calls: the strongly connected components of the call graph (Tarjan, iteratively). */
  #recursion(callables: readonly Callable[]): ReadonlySet<Callable> {
    const recursive = new Set<Callable>();
    const callers = (callable: Callable): Callable[] =>
      callable.sites.flatMap((site) => {
        const caller = this.#callableOf[site.caller];
        return caller === null || caller === undefined ? [] : [caller];
      });
    const index = new Map<Callable, number>();
    const low = new Map<Callable, number>();
    const onStack = new Set<Callable>();
    const stack: Callable[] = [];
    let counter = 0;
    const enter = (
      callable: Callable,
      frames: { callable: Callable; next: number; edges: Callable[] }[],
    ): void => {
      index.set(callable, counter);
      low.set(callable, counter);
      counter += 1;
      stack.push(callable);
      onStack.add(callable);
      frames.push({ callable, next: 0, edges: callers(callable) });
    };
    for (const root of callables) {
      if (index.has(root)) continue;
      const frames: { callable: Callable; next: number; edges: Callable[] }[] = [];
      enter(root, frames);
      while (frames.length > 0) {
        const frame = frames.at(-1)!;
        if (frame.next < frame.edges.length) {
          const other = frame.edges[frame.next]!;
          frame.next += 1;
          if (other === frame.callable) recursive.add(other);
          if (!index.has(other)) enter(other, frames);
          else if (onStack.has(other))
            low.set(frame.callable, Math.min(low.get(frame.callable)!, index.get(other)!));
          continue;
        }
        frames.pop();
        const parent = frames.at(-1);
        if (parent !== undefined)
          low.set(parent.callable, Math.min(low.get(parent.callable)!, low.get(frame.callable)!));
        if (low.get(frame.callable) === index.get(frame.callable)) {
          const members: Callable[] = [];
          let member: Callable;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            members.push(member);
          } while (member !== frame.callable);
          if (members.length > 1) for (const m of members) recursive.add(m);
        }
      }
    }
    return recursive;
  }

  /**
   * The callables a block may run: those it calls or starts, and all that they call and start, by a worklist over the
   * call and transfer edges, each once. A `goto` out of a block reaches the code after its label, not the code before
   * it (L6): those nodes are marked, and the callables they call or start are block code whole.
   */
  #blockReach(): {
    readonly blockCalled: ReadonlySet<Callable>;
    readonly blockReached: ReadonlySet<FlowNode>;
  } {
    const blockCalled = new Set<Callable>();
    const blockReached = new Set<FlowNode>();
    const inBlock = (node: FlowNode): boolean => this.#regions[node.region]!.kind === "handler";
    const onward = new Map<Callable, Callable[]>();
    const queue: Callable[] = [];
    const mark = (callable: Callable): void => {
      if (blockCalled.has(callable)) return;
      blockCalled.add(callable);
      queue.push(callable);
    };
    const edge = (node: FlowNode, callee: Callable): void => {
      if (inBlock(node)) return mark(callee);
      const caller = this.#callableOf[node.region];
      if (caller === null || caller === undefined) return;
      const list = onward.get(caller);
      if (list === undefined) onward.set(caller, [callee]);
      else list.push(callee);
    };
    const sitesAt = new Map<FlowNode, CallSite>();
    for (const site of this.#sites) {
      sitesAt.set(site.callIn, site);
      for (const callee of site.callees) edge(site.callIn, callee);
    }
    const reach = (from: readonly FlowNode[]): void => {
      const work = [...from];
      while (work.length > 0) {
        const node = work.pop()!;
        if (blockReached.has(node)) continue;
        blockReached.add(node);
        for (const callee of sitesAt.get(node)?.callees ?? []) mark(callee);
        for (const next of node.successors)
          if (!this.#deadEdges.has(edgeKey(node, next))) work.push(next);
      }
    };
    for (const jump of this.#jumps)
      if (inBlock(jump.node)) reach(jump.targets);
      else for (const file of jump.files) edge(jump.node, file);
    while (queue.length > 0) for (const callee of onward.get(queue.pop()!) ?? []) mark(callee);
    return { blockCalled, blockReached };
  }
}

const NON_NULL_LITERALS: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "stringLiteral",
  "booleanLiteral",
  "regexLiteral",
  "listLiteral",
  "objectLiteral",
  "setLiteral",
  "dictLiteral",
  "durationLiteral",
]);

function edgeKey(from: FlowNode, to: FlowNode): number {
  return from.id * NODE_ID_BOUND + to.id;
}

/**
 * P7: the value a condition always has by its literals, as the type check reads conditions (`conditionShape`): a
 * boolean literal, `not` of one, or `and` and `or` that their literal operands decide; `null` when a run decides it.
 */
function literalTruth(expression: Expression): boolean | null {
  return runCompileTask(literalTruthTask(expression));
}

function* literalTruthTask(expression: Expression): CompileTask<boolean | null> {
  const shape = conditionShape(expression);
  switch (shape.kind) {
    case "literal":
      return shape.node.value;
    case "not": {
      const value = yield* compileChild(literalTruthTask(shape.operand));
      return value === null ? null : !value;
    }
    case "and":
    case "or": {
      // `false` decides an `and` and `true` an `or`, whichever operand has it.
      const decides = shape.kind === "or";
      const left = yield* compileChild(literalTruthTask(shape.left));
      const right = yield* compileChild(literalTruthTask(shape.right));
      if (left === decides || right === decides) return decides;
      return left === null || right === null ? null : !decides;
    }
    default:
      return null;
  }
}

/** P7: a `repeat` count or a list index that its literals give, as the type check folds a count, or `null`. */
function literalCount(expression: Expression): number | null {
  return staticNumber(expression) ?? null;
}

/** Whether a call supplies the parameter at `index` named `name`: by position, or by name. */
function supplies(call: CallExpression, index: number, name: string): boolean {
  let positional = 0;
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") positional += 1;
    else if (argument.name.name === name) return true;
  }
  return positional > index;
}
