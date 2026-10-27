import type {
  BinaryExpression,
  Block,
  CallExpression,
  Expression,
  FileTarget,
  ForStatement,
  FunctionDeclaration,
  Program,
  RepeatStatement,
  Statement,
  WhileStatement,
} from "../../../ast.js";
import type { SourceSpan } from "../../../source.js";
import type { SourceSite } from "../../graph.js";

// The flow graph's shape: its nodes, regions, call sites, jumps, loops and the operand uses it records.

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

/** A file of the project, with the files that each of its glob targets may pick, as the name pass resolved them. */
export interface FlowGraphFile {
  readonly path: string;
  readonly program: Program;
  /** The name pass's picks (`semantic.ts`): the matching files that run something, for each glob target. */
  readonly picks: ReadonlyMap<FileTarget, readonly string[]>;
}

export interface FlowGraph {
  readonly files: readonly FlowGraphFile[];
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
  /**
   * The node of the statement at `site` where it runs: for a `global` with `default:`, the assignment the declaration
   * performs (F1a's executable store); a `global` without one and a speaker have none.
   */
  statementAt(site: SourceSite): FlowNode | undefined;
  /** The session-start node of the `global` or speaker declared at `site`, in the startup region (F1a's start store). */
  startupAt(site: SourceSite): FlowNode | undefined;
  /** The binding node of the `for` loop whose statement or iterable is at `site`. */
  loopBindingAt(site: SourceSite): FlowNode | undefined;
}
