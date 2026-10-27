import type { BinaryExpression, Block, CallExpression, Expression, Statement } from "../../ast.js";
import { compileChild, runCompileTask, type CompileTask } from "../../compiler/continuation.js";
import { sessionDeclarations } from "../../project-globals.js";
import { createSourceSpan, type SourceSpan } from "../../source.js";
import { blockReach, recursion } from "./flow-graph/callables.js";
import { resolveCalls, resolveTransfers } from "./flow-graph/calls.js";
import { expressionTask } from "./flow-graph/expressions.js";
import { edgeKey, NODE_ID_BOUND, siteKey } from "./flow-graph/keys.js";
import {
  decideDefaults,
  decideLiveness,
  decideReturns,
  joinUnentered,
} from "./flow-graph/liveness.js";
import type {
  Callable,
  CallSite,
  FileRegion,
  FlowGraph,
  FlowGraphFile,
  FlowLoop,
  FlowNode,
  FlowNodeKind,
  FlowRegion,
  FunctionRegion,
  GuardUse,
  HandlerRegion,
  Jump,
  OperandUse,
  StartupRegion,
} from "./flow-graph/model.js";
import { blockTask, statementNode } from "./flow-graph/statements.js";
export type {
  Callable,
  CallSite,
  FileRegion,
  FlowGraph,
  FlowGraphFile,
  FlowLoop,
  FlowNode,
  FlowNodeKind,
  FlowRegion,
  FunctionRegion,
  GuardUse,
  HandlerRegion,
  Jump,
  OperandUse,
  StartupRegion,
} from "./flow-graph/model.js";
export { literalRounds, literalTruth, type LiteralRounds } from "./flow-graph/literals.js";

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
 * second round; `1` or more: the body runs before the loop is left), a `for` over a literal collection (empty: the body
 * is dead; not empty: the body runs before the loop is left), a `get` on a list literal with a literal index, and a
 * parameter default that every call supplies or none does. A call that cannot return has a dead summary edge.
 * Dead code keeps its nodes, joined to the live code before it by dead edges, so every node has a dominator.
 */

/**
 * The graph of a project's files, in project order: `main.tease` first, where the session starts, as the lowering
 * orders them (`compileStableProject`), each with the name pass's picks for its glob targets, as the lowering takes them.
 */
export function buildFlowGraph(files: readonly FlowGraphFile[]): FlowGraph {
  return new FlowGraphBuilder(files).build();
}

/** A node while the graph is built: its edge lists grow and its liveness is decided at the end. */
export interface BuildNode extends FlowNode {
  readonly loops: readonly BuildNode[];
  readonly successors: BuildNode[];
  readonly predecessors: BuildNode[];
  dead: boolean;
  enclosing?: BuildNode;
}

/** Where a statement or expression stands while the graph is built. */
export interface WalkContext {
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
  readonly name: string;
  /** The node before the default, which leads to its first node and, skipping it, to the binding. */
  readonly before: FlowNode;
  readonly binding: FlowNode;
}

/** Its public members serve `buildFlowGraph` and the modules in `flow-graph/`, and are internal to the flow graph. */
export class FlowGraphBuilder {
  public readonly nodes: BuildNode[] = [];
  public readonly regions: FlowRegion[] = [];
  public readonly regionSites: CallSite[][] = [];
  public readonly callableOf: (Callable | null)[] = [];
  readonly #ownerOf: (Callable | null)[] = [];
  public readonly sites: CallSite[] = [];
  public readonly jumps: Jump[] = [];
  readonly #edges = new Set<number>();
  public readonly deadEdges = new Set<number>();
  public readonly expressionNodes = new Map<string, BuildNode>();
  public readonly statementNodes = new Map<string, BuildNode>();
  readonly #startupNodes = new Map<string, BuildNode>();
  public readonly loopBindings = new Map<string, BuildNode>();
  public readonly labels = new Map<string, BuildNode>();
  public readonly functions = new Map<string, FunctionRegion>();
  public readonly globalFunctions = new Map<string, FunctionRegion>();
  public readonly fileRegions: FileRegion[] = [];
  public readonly handlers: HandlerRegion[] = [];
  public readonly pendingCalls: PendingCall[] = [];
  public readonly pendingTransfers: PendingTransfer[] = [];
  public readonly defaultChoices: DefaultChoice[] = [];
  /** The `end` statements of functions and blocks, which end whichever file is running. */
  public readonly ends: BuildNode[] = [];
  public readonly countUses: OperandUse[] = [];
  public readonly indexUses: OperandUse[] = [];
  public readonly keyUses: OperandUse[] = [];
  public readonly conditionUses: GuardUse[] = [];
  public readonly switchUses: GuardUse[] = [];
  public readonly loops: FlowLoop[] = [];
  public readonly leftBy = new Set<FlowNode>();
  public readonly logicals: { readonly file: number; readonly expression: BinaryExpression }[] = [];
  public readonly labelled = new Set<FileRegion>();
  /** The nodes made since the last join of dead code that may have no predecessor (see `joinDead`). */
  readonly #orphans: number[] = [];
  /** The literal value of each condition asked so far (see `literalTruth`). */
  public readonly truths = new Map<Expression, boolean | null>();
  public readonly program: { readonly entry: BuildNode; readonly end: BuildNode };
  public readonly startup: StartupRegion;

  public constructor(public readonly files: readonly FlowGraphFile[]) {
    this.program = {
      entry: this.node("program-entry", -1, -1, null, []),
      end: this.node("program-end", -1, -1, null, []),
    };
    const id = this.regions.length;
    const sites: CallSite[] = [];
    this.startup = {
      kind: "startup",
      id,
      file: 0,
      entry: this.node("startup-entry", id, 0, null, []),
      exit: this.node("startup-exit", id, 0, null, []),
      parent: null,
      sites,
    };
    this.addRegion(this.startup, sites);
  }

  public build(): FlowGraph {
    const program = this.program;
    const startup = this.startup;
    this.link(program.entry, startup.entry);
    let current: FlowNode = startup.entry;
    for (const { file, declaration } of sessionDeclarations(this.files.map((f) => f.program))) {
      const context = this.context(startup.id, file, null, null, null, null, []);
      const values =
        declaration.kind === "globalStatement"
          ? [declaration.initial]
          : declaration.properties.map((property) => property.value);
      for (const value of values)
        current = runCompileTask(expressionTask(this, value, context, current));
      current = statementNode(this, declaration, context, current, {}, this.#startupNodes);
    }
    this.link(current, startup.exit);
    this.files.forEach((file, index) => {
      const region = this.#fileRegion(index, file.path, file.program.span);
      const context = this.context(region.id, index, region, null, null, null, []);
      const last = runCompileTask(blockTask(this, file.program.statements, context, region.entry));
      this.link(last, region.exit);
    });
    const main = this.fileRegions[0];
    if (main !== undefined) {
      this.link(startup.exit, main.entry);
      this.link(main.exit, program.end);
    }
    resolveCalls(this);
    decideDefaults(this);
    resolveTransfers(this);
    decideReturns(this);
    joinUnentered(this);
    decideLiveness(this);
    const callables = this.regions.filter(
      (region): region is Callable => region.kind === "file" || region.kind === "function",
    );
    const recursive = recursion(this, callables);
    const { blockCalled, blockReached } = blockReach(this);
    const expressionNodes = this.expressionNodes;
    const statementNodes = this.statementNodes;
    const startupNodes = this.#startupNodes;
    const loopBindings = this.loopBindings;
    const deadEdges = this.deadEdges;
    const callableOf = this.callableOf;
    const ownerOf = this.#ownerOf;
    return {
      files: this.files,
      nodes: this.nodes,
      regions: this.regions,
      sites: this.sites,
      jumps: this.jumps,
      program,
      startup,
      callables,
      countUses: this.countUses,
      indexUses: this.indexUses,
      keyUses: this.keyUses,
      conditionUses: this.conditionUses,
      switchUses: this.switchUses,
      loops: this.loops,
      leftBy: this.leftBy,
      logicals: this.logicals,
      recursive,
      blockCalled,
      blockReached,
      labelled: this.labelled,
      isDeadEdge: (from, to) => deadEdges.has(edgeKey(from, to)),
      callableOf: (region) => callableOf[region] ?? null,
      ownerOf: (region) => ownerOf[region] ?? null,
      expressionAt: (site) => expressionNodes.get(siteKey(site.file, site.start, site.end)),
      statementAt: (site) => statementNodes.get(siteKey(site.file, site.start, site.end)),
      startupAt: (site) => startupNodes.get(siteKey(site.file, site.start, site.end)),
      loopBindingAt: (site) => loopBindings.get(siteKey(site.file, site.start, site.end)),
    };
  }

  // ------------------------------------------------------------------------------------------- nodes and regions

  public node(
    kind: FlowNodeKind,
    region: number,
    file: number,
    span: SourceSpan | null,
    loops: readonly BuildNode[],
    extra: Partial<Pick<BuildNode, "expression" | "statement" | "prepared" | "fallthrough">> = {},
  ): BuildNode {
    if (this.nodes.length >= NODE_ID_BOUND)
      throw new RangeError("The flow graph has too many nodes.");
    const node: BuildNode = {
      id: this.nodes.length,
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
    this.nodes.push(node);
    this.#orphans.push(node.id);
    return node;
  }

  /** A node of the current statement's own expressions, which its statement node will enclose. */
  public own(
    kind: FlowNodeKind,
    context: WalkContext,
    span: SourceSpan | null,
    extra: Partial<Pick<BuildNode, "expression">> = {},
  ): BuildNode {
    const node = this.node(kind, context.region, context.file, span, context.loops, extra);
    context.own.push(node);
    return node;
  }

  /** An edge, once; a dead one is never taken (P7, a call that cannot return). */
  public link(from: FlowNode | null, to: FlowNode | null, dead = false): void {
    if (from === null || to === null) return;
    const key = edgeKey(from, to);
    if (this.#edges.has(key)) return;
    this.#edges.add(key);
    const source = this.built(from);
    const target = this.built(to);
    source.successors.push(target);
    target.predecessors.push(source);
    if (dead) this.deadEdges.add(key);
  }

  /**
   * Joins the code built from node `first` on that nothing leads to, such as the statements after a `return`, to `from`
   * with dead edges, so that it has dominators.
   */
  public joinDead(first: number, from: FlowNode | null): void {
    if (from === null) return;
    // Each node is looked at by the innermost join after it is made, never again by the joins around it.
    while (this.#orphans.length > 0 && this.#orphans.at(-1)! >= first) {
      const node = this.nodes[this.#orphans.pop()!]!;
      if (node.predecessors.length === 0) this.link(from, node, true);
    }
  }

  /**
   * Adds a region, whose parent was added before it. A function stands only at a file's top level, so a region inside a
   * block is a block itself.
   */
  public addRegion(region: FlowRegion, sites: CallSite[]): void {
    this.regions.push(region);
    this.regionSites.push(sites);
    const own = region.kind === "file" || region.kind === "function" ? region : null;
    this.callableOf.push(own ?? (region.parent === null ? null : this.callableOf[region.parent]!));
    this.#ownerOf.push(own);
  }

  /** The node with the id of `node`, as the builder holds it. */
  public built(node: FlowNode): BuildNode {
    return this.nodes[node.id]!;
  }

  #fileRegion(file: number, path: string, span: SourceSpan): FileRegion {
    const id = this.regions.length;
    const sites: CallSite[] = [];
    const region: FileRegion = {
      kind: "file",
      id,
      file,
      path,
      entry: this.node("file-entry", id, file, null, []),
      exit: this.node("file-exit", id, file, createSourceSpan(span.end, span.end), []),
      parent: null,
      sites,
    };
    this.addRegion(region, sites);
    this.fileRegions.push(region);
    return region;
  }

  public context(
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
  public withOwn(context: WalkContext): WalkContext {
    return { ...context, own: [] };
  }

  /** A timer, media, or button block registered at `creation`. */
  public *handlerRegion(
    block: Block,
    creation: FlowNode,
    context: WalkContext,
    registeredBy: Statement["kind"] | Expression["kind"],
  ): CompileTask<void> {
    const id = this.regions.length;
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
      entry: this.node("handler-entry", id, context.file, null, []),
      exit: this.node(
        "handler-exit",
        id,
        context.file,
        createSourceSpan(block.span.end, block.span.end),
        [],
      ),
      parent: context.region,
      sites,
    };
    this.addRegion(region, sites);
    this.handlers.push(region);
    this.link(creation, region.entry);
    const inner = this.context(id, context.file, context.fileRegion, null, null, region, []);
    const last = yield* compileChild(blockTask(this, block.statements, inner, region.entry));
    this.link(last, region.exit);
  }
}
