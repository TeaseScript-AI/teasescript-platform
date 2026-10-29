import type { Block, Expression, Program, Statement } from "./ast.js";
import type { LoweringTrace } from "./compiler/compile-program.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import {
  expressionParts,
  handlerBlocks,
  nestedStatements,
  statementExpressions,
} from "./expression-children.js";
import { PlanControlFlow, type FlowEdge } from "./plan/control-flow.js";
import { solveBackward, solveForward } from "./plan/dataflow.js";
import type { ExpressionPlan, InstructionPlan, LiteralExpressionPlan } from "./plan/model.js";
import { planLocationToSourceSpan } from "./plan/source-location.js";
import { runsOnItsOwn } from "./project-globals.js";
import { declarationsOnlyMessage, type UnreadablePackageFile } from "./project-paths.js";
import { runsNothing } from "./runtime/scopes/activation-validation.js";
import type { FileCallTarget } from "./semantic.js";
import { CORE_RUNTIME_BUILTINS } from "./language-facts.js";
import { createSourceSpan, type SourceSpan } from "./source.js";
import type { DeadWays } from "./way-facts.js";

/*
 * Which code can run, from the compiled plan: the ways of `plan/control-flow.ts` that the type check does not rule out
 * (`DeadWays`), solved with `plan/dataflow.ts`. Code can run in a file's top level, from its start; in a function where
 * a call that can run reaches it; and in a timer, media, or button block where code that can run creates it (ADR 0022
 * §3.4). A call counts as returning, also of a function that never returns, so the ending after it is still written out
 * (ADR 0022 §4.3). The checks that follow it: the endings of files and of the session (TSV052, TSV053), an `end` with
 * no file call to return to (TSV070, TSV071), a `call` that can start the running file (TSV072, TSV073), a computed
 * `goto` that can lead to a file of declarations only (TSV057, TSV074), loops with no way out (TSV058), code that never
 * runs (TSV065, TSV066), also of a file that nothing starts, and the flow of statements that the check of variables at
 * labels follows (TSV054).
 */

/**
 * A TSV046 warning: where it stands, and what it says the test there always gives, or `null` for a case that never
 * matches or a range that contains no numbers.
 */
export interface ConstantTest {
  readonly span: SourceSpan;
  readonly value: boolean | null;
}

/** The statements that never run, and the top-level statements that run and after which execution continues. */
export interface StatementFlow {
  readonly unreachable: ReadonlySet<Statement>;
  readonly continuing: ReadonlySet<Statement>;
}

/**
 * A `call` of a file, for the check of the running file (see {@link Reachability.runningFileDiagnostics}): how it names
 * its file, the files it may start by index or `null` for any file, and for one of them whether the call can start it:
 * `true` for certain, `false` when it cannot after all, or `null` where only the run decides.
 */
export interface FileCall {
  readonly form: FileCallTarget["form"];
  readonly files: readonly number[] | null;
  readonly starts: (file: number) => boolean | null;
  readonly span: SourceSpan;
}

const NO_WAY_OUT =
  "If this loop starts, it has no way to stop. Add a condition with `break` to leave the loop, or use `exit` to finish the session.";

/** The edges that go on with what follows in the same code, rather than at another place. */
const ONWARD_EDGES: ReadonlySet<string> = new Set<FlowEdge["kind"]>([
  "next",
  "true",
  "false",
  "jump",
  "iterate",
  "exhausted",
  "break",
  "continue",
  "resume",
  "supplied",
  "omitted",
]);

/**
 * Where a computed target of a `goto` or `call` may lead (see `computedTargets` in `compiler.ts`): the files it may
 * start, by index, `null` for any file; whether it may start each of them whenever it runs, as a tagged pick whose tags
 * decide its matches does, rather than possibly only some; and whether it is a tagged pick, rather than a reference.
 */
export interface ComputedTarget {
  readonly files: readonly number[] | null;
  readonly certain: boolean;
  readonly tagged: boolean;
}

/** A computed target that nothing is known of: a reference that may name any file. */
const ANY_TARGET: ComputedTarget = { files: null, certain: false, tagged: false };

/**
 * The ways of computed targets (see `Reachability.#computedWays`): each target's way into its file or hub, a node after
 * the instructions, and each hub's ways into the entries of its files.
 */
interface ComputedWays {
  readonly targets: ReadonlyMap<number, { readonly node: number; readonly edge: string }>;
  readonly hubs: readonly (readonly number[])[];
}

/** Which instructions of a plan can run, and how that reads back as the source's statements. */
export class Reachability {
  readonly #flow: PlanControlFlow;
  /** The code that can run: from the start of a file, with the functions and blocks it reaches. */
  readonly #reached: Uint8Array;
  /** For each instruction, how many before it {@link #reached} holds. */
  readonly #reachedBefore: Int32Array;
  /**
   * The code that can run once its function or block runs, whether or not one does: the view of the check of variables
   * at labels, which decides itself which functions and blocks run (ADR 0022 §3.4).
   */
  readonly #local: Uint8Array;
  readonly #localBefore: Int32Array;
  /** The functions that may return to their caller (see {@link #returningFunctions}), found once. */
  #returning: ReadonlySet<number> | undefined;
  /** The ways of the computed targets, and where blocks stay, found once for the targets the checks share. */
  #transfers:
    | {
        readonly targets: ReadonlyMap<number, ComputedTarget>;
        readonly ways: ComputedWays;
        stays?: Staying;
        staying?: StayingBlocks;
        again?: Uint8Array;
      }
    | undefined;

  public constructor(
    private readonly programs: readonly Program[],
    private readonly plan: InstructionPlan,
    private readonly trace: LoweringTrace,
    private readonly ways: DeadWays,
  ) {
    this.#flow = new PlanControlFlow(plan);
    // A file starts at its top, so a label is reached only by the code before it or a goto (V30 §26, §29).
    const starts: number[] = [];
    for (const file of plan.files) starts.push(file.startInstruction, file.entryInstruction);
    this.#reached = this.#solve(starts);
    this.#local = this.#solve([
      ...starts,
      ...plan.functions.map((definition) => definition.entryInstruction),
    ]);
    this.#reachedBefore = countsBefore(this.#reached);
    this.#localBefore = countsBefore(this.#local);
  }

  /** The instructions that some way from `entries` reaches. */
  #solve(entries: readonly number[]): Uint8Array {
    const states = solveForward<true, string>(
      {
        nodeCount: this.plan.instructions.length,
        successors: (index) => this.#successors(index),
        join: () => true,
        equals: () => true,
        transfer: () => true,
      },
      entries.map((entry) => [entry, true] as const),
    );
    return Uint8Array.from(states, (state) => (state === null ? 0 : 1));
  }

  /**
   * The ways on from the instruction at `index` that can run: the plan's, without those that the type check rules out,
   * from a `continue` of a loop that runs once also to the loop's end (see `DeadWays.runsOnce`), and into the blocks
   * the instruction creates.
   */
  #successors(index: number): { readonly node: number; readonly edge: string }[] {
    const out: { node: number; edge: string }[] = [];
    for (const { node, edge } of this.#ways(index)) if (node !== null) out.push({ node, edge });
    for (const handler of this.#flow.handlersOf(index)) {
      const definition = this.#flow.functionById(handler);
      if (definition !== undefined)
        out.push({ node: definition.entryInstruction, edge: "handler" });
    }
    return out;
  }

  /**
   * The ways on from the instruction at `index` that can run, also those that leave the plan's code (`node: null`): the
   * plan's, without those that the type check rules out, and from a `continue` of a loop that runs once also to the
   * loop's end (see `DeadWays.runsOnce`).
   */
  #ways(index: number): { readonly node: number | null; readonly edge: FlowEdge["kind"] }[] {
    const out: { node: number | null; edge: FlowEdge["kind"] }[] = [];
    for (const { edge, target } of this.#flow.successors(index))
      if (this.ways.possible(index, edge.kind)) out.push({ node: target, edge: edge.kind });
    const instruction = this.plan.instructions[index]!;
    if (instruction.kind === "loopControl" && instruction.action === "continue") {
      const start = this.#flow.loopStart(instruction.loopId);
      const loop = start === undefined ? undefined : this.plan.instructions[start];
      if (start !== undefined && loop?.kind === "loopStart" && this.ways.runsOnce(start))
        out.push({ node: loop.target, edge: "exhausted" });
    }
    return out;
  }

  /** Whether some instruction of the statement can run, or `null` for a statement with none, such as a declaration. */
  #runs(statement: Statement, local = false): boolean | null {
    const range = this.trace.statements.get(statement);
    if (range === undefined || range.start === range.end) return null;
    const before = local ? this.#localBefore : this.#reachedBefore;
    return before[range.end]! > before[range.start]!;
  }

  /**
   * The flow of statements for the check of variables at labels (ADR 0022 §3.4): those that cannot run once their
   * function or block runs, and the top-level statements that run and continue after them. A declaration that runs
   * nothing where it stands lets the way through.
   */
  public statementFlow(): StatementFlow {
    const unreachable = new Set<Statement>();
    for (const statement of this.trace.statements.keys())
      if (this.#runs(statement, true) === false) unreachable.add(statement);
    const continuing = new Set<Statement>();
    for (const program of this.programs)
      for (const statement of program.statements) {
        if (statement.kind === "functionDeclaration") continue;
        const range = this.trace.statements.get(statement);
        if (range === undefined || range.start === range.end || this.#continues(range))
          continuing.add(statement);
      }
    return { unreachable, continuing };
  }

  /** Whether a way through the instructions from `start` up to `end` that can run goes on at `end`. */
  #continues(range: { readonly start: number; readonly end: number }): boolean {
    for (let index = range.start; index < range.end; index += 1) {
      if (this.#local[index] === 0) continue;
      for (const { node, edge } of this.#successors(index))
        if (node === range.end && ONWARD_EDGES.has(edge)) return true;
    }
    return false;
  }

  /**
   * A top-level way that runs past the end of a file is an error (TSV052). By the explicit-ending rule (ADR 0022 §4.3,
   * V30 §30), a call counts as returning, also of a function that always ends the session, so the ending after it is
   * still written out. A file of declarations only runs nothing on its own, so it has no way to its end.
   */
  public endingDiagnostics(): Diagnostic[][] {
    return this.plan.files.map((file, index) => {
      const program = this.programs[index]!;
      if (this.#local[file.rootEndInstruction - 1] === 0 || !program.statements.some(runsOnItsOwn))
        return [];
      const last = program.statements
        .filter((statement) => statement.kind !== "functionDeclaration")
        .at(-1)!;
      const call = last.kind === "expressionStatement" ? unwrap(last.expression) : null;
      return [
        createDiagnostic(
          DiagnosticSeverity.Error,
          "TSV052",
          call?.kind === "callExpression" && call.callee.kind === "identifier"
            ? `This path reaches the end of the file after ${call.callee.name}(). Even if ${call.callee.name} ends the session, add exit (or end) here so the ending is explicit.`
            : "The script can run past the end of this file. Add exit where the session should finish, or end to return to the file that called this one.",
          last.span,
        ),
      ];
    });
  }

  /**
   * An `end` returns to the file that called the running one (V30 §30), and fails without one. The ways from the start
   * of the session follow which file calls are waiting: a `call` makes one wait, and a `goto` keeps those that wait.
   * The `end` is an error (TSV070) only where it fails whenever some code runs (V30 §13): where every way to it has none
   * waiting, or where code that every way reaches with none waiting certainly goes on to it or to another `end` (see
   * {@link #provenEnds}), also when another way reaches it through a call. Where a way the compiler follows reaches it
   * with none waiting but neither holds, because code before it may leave first, it is a warning (TSV071), and so it is
   * where only a way the compiler cannot follow leads there with none waiting: a computed target whose files `targets`
   * does not decide (see {@link #computedWays}), and a timer, media, or button block that may run while none waits (see
   * {@link #blockRuns}). The runtime checks the `end` then (TSR066). The `end` that closes a file's top level is the
   * ending check's (TSV052).
   */
  public pendingCallDiagnostics(
    targets: () => ReadonlyMap<number, ComputedTarget>,
  ): Diagnostic[][] {
    const diagnostics = this.plan.files.map((): Diagnostic[] => []);
    const closing = new Set(this.plan.files.map((file) => file.rootEndInstruction - 1));
    if (
      !this.plan.instructions.some(
        (instruction, index) => instruction.kind === "end" && !closing.has(index),
      )
    )
      return diagnostics;
    const count = this.plan.instructions.length;
    const ways = this.#waysOf(targets());
    const { states, interrupted } = this.#blockRuns(ways);
    let proven: ReadonlyMap<number, number> | undefined;
    for (let index = 0; index < count; index += 1) {
      const state = states[index];
      const instruction = this.plan.instructions[index]!;
      if (state === null || state === undefined || instruction.kind !== "end" || closing.has(index))
        continue;
      if (state.none === null && state.hidden === null) continue;
      const file = this.#flow.fileOf(index);
      const fix = "use 'exit' or 'goto' here instead of 'end'";
      // The way that the message names: a `goto` that leads here, or the start of the session.
      const certain =
        state.none === null
          ? undefined
          : withoutCall(state)
            ? state.none
            : (proven ??= this.#provenEnds(states, ways, interrupted)).get(index);
      const way = certain ?? state.none;
      diagnostics[file]!.push(
        createDiagnostic(
          certain !== undefined ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
          certain !== undefined ? "TSV070" : "TSV071",
          certain === SESSION_START
            ? "This 'end' has no call to return to, because the session starts in 'main.tease' without one. Use 'exit' to finish the session, or 'goto' to continue in another file."
            : certain !== undefined
              ? `This 'end' has no call to return to when the 'goto' on ${this.#where(certain, file)} leads here. Write 'call' instead of 'goto' there to come back after it, or ${fix}.`
              : way === SESSION_START
                ? `This 'end' has no call to return to when the start of the session in 'main.tease' leads here, but the compiler cannot tell whether the script reaches it then. If it does, the 'end' fails. If that can happen, ${fix}.`
                : way !== null
                  ? `This 'end' has no call to return to when the 'goto' on ${this.#where(way, file)} leads here, but the compiler cannot tell whether the script reaches it then. If it does, the 'end' fails. If that can happen, write 'call' instead of 'goto' there, or ${fix}.`
                  : this.plan.instructions[state.hidden!]!.kind === "transfer"
                    ? `The 'goto' on ${this.#where(state.hidden!, file)} picks its file when it runs, so the compiler cannot tell whether this 'end' has a call to return to then. Without one, the 'end' fails. If that 'goto' can lead here, write 'call' instead of 'goto' there, or ${fix}.`
                    : `This 'end' runs later, ${this.#blockAt(state.hidden!, file).when}, so the compiler cannot tell whether it has a call to return to then. Without one, the 'end' fails. If that can happen, ${fix}.`,
          planLocationToSourceSpan(instruction.span),
        ),
      );
    }
    return diagnostics;
  }

  /**
   * Which file calls wait where code runs, from the start of the session (see {@link pendingCallDiagnostics}), with
   * where each timer, media, or button block starts. A block starts at a boundary between instructions once it is due:
   * a button's once pressed, which the player can only while code waits, and a timer whose length is written out and
   * whose handle the script does not keep once that time has passed, which it only does while code waits; any other
   * timer, and a media block, may be due at any boundary (see {@link #startsAnywhere}). While a block runs, others wait
   * for it, so a block also starts where one that may start anywhere returns to, and where one that may leave the code
   * it interrupts (see {@link #leavingBlocks}) leaves to. While a called file runs, a call waits. A block starts only while
   * it stays, on the ways from its creation that {@link #staying} follows. Its `end` ends the file running where it
   * starts, so it has a call to return to when one waits at every such place and no other block that may leave stays
   * there, nor another copy of it (see {@link #single}). The block's code then runs with calls waiting, and else as code
   * that may have none, by the instruction that created it (`hidden`). `interrupted` tells where a block that may leave
   * the code it interrupts may start.
   */
  #blockRuns(ways: ComputedWays): {
    readonly states: readonly (CallsWaiting | null)[];
    readonly interrupted: (index: number) => boolean;
  } {
    const count = this.plan.instructions.length;
    const code = count + ways.hubs.length;
    const { stays, staying, interrupted } = this.#blocksStaying(ways);
    // The nodes: the code, where the blocks start that each place leads to as one that stays on, by whether they
    // outlive their file entry, and each block where an instruction creates it.
    const runs = (outlives: boolean): number => code + (outlives ? stays.nodeCount : 0);
    const gates: { readonly creator: number; readonly entry: number; readonly block: number }[] =
      [];
    const gatesAt = new Map<number, number[]>();
    this.plan.instructions.forEach((_, index) => {
      if (this.#reached[index] === 0) return;
      for (const block of this.#flow.handlersOf(index)) {
        const definition = this.#flow.functionById(block);
        if (definition === undefined) continue;
        const list = gatesAt.get(index) ?? [];
        list.push(gates.length);
        gatesAt.set(index, list);
        gates.push({ creator: index, entry: definition.entryInstruction, block });
      }
    });
    const firstGate = code + 2 * stays.nodeCount;
    const unknown: BlockStarts = { unsafe: true, leavers: SEVERAL_LEAVERS };
    const solved = solveForward<BlockState, string>(
      {
        nodeCount: firstGate + gates.length,
        successors: (node) => {
          if (node < code) {
            const out = this.#computedSuccessors(ways, node, false);
            if (node < count)
              out.push(
                { node: runs(false) + node, edge: "run" },
                { node: runs(true) + node, edge: "run" },
              );
            for (const gate of gatesAt.get(node) ?? [])
              out.push({ node: firstGate + gate, edge: "created" });
            return out;
          }
          if (node < firstGate) {
            const outlives = node >= runs(true);
            const at = node - runs(outlives);
            const out = [
              ...stays.staysBefore[at]!,
              ...(outlives ? stays.outlivesBefore[at]! : []),
            ].map((previous) => ({ node: runs(outlives) + previous, edge: "back" }));
            for (const gate of gatesAt.get(at) ?? [])
              if (this.#outlivesItsFile(at) === outlives)
                out.push({ node: firstGate + gate, edge: "runs" });
            return out;
          }
          return [{ node: gates[node - firstGate]!.entry, edge: "block" }];
        },
        join: joinBlockStates,
        equals: sameBlockStates,
        transfer: (node, edge, state) => {
          switch (edge) {
            case "run": {
              if (state.kind !== "calls") return null;
              const none = state.none !== null || state.hidden !== null;
              const leavers = staying.leavers(node);
              const anywhere = staying.anywhere(node);
              const waits = !NEVER_WAITS.has(this.plan.instructions[node]!.kind);
              // While a called file runs, a call waits.
              const call = this.#calls(node);
              return {
                kind: "runs",
                anywhere: { unsafe: none, leavers },
                due:
                  waits || anywhere || call
                    ? { unsafe: none && (waits || anywhere), leavers }
                    : null,
              };
            }
            case "back":
              return state;
            case "created":
              return { kind: "gate", created: true, run: null };
            case "runs":
              return state.kind === "runs" ? { kind: "gate", created: false, run: state } : null;
            case "block": {
              if (state.kind !== "gate" || !state.created || state.run === null) return null;
              const { creator, block } = gates[node - firstGate]!;
              const starts = this.#startsAnywhere(creator) ? state.run.anywhere : state.run.due;
              if (starts === null) return null;
              const alone =
                starts.leavers === null ||
                (starts.leavers === block && this.#single(creator, ways));
              return {
                kind: "calls",
                none: null,
                hidden: starts.unsafe || !alone ? creator : null,
                waiting: true,
              };
            }
          }
          return state.kind === "calls" ? this.#waitingAfter(node, edge, state) : null;
        },
      },
      [
        [
          this.plan.files[0]!.startInstruction,
          { kind: "calls", none: SESSION_START, hidden: null, waiting: false },
        ],
        // Once a block returns, the code it interrupted goes on, wherever that was.
        ...stays.blockReturns.flatMap((index) =>
          [false, true].map(
            (outlives) =>
              [runs(outlives) + index, { kind: "runs", anywhere: unknown, due: unknown }] as const,
          ),
        ),
      ],
    );
    const states = solved
      .slice(0, code)
      .map((state) => (state !== null && state.kind === "calls" ? state : null));
    return { states, interrupted };
  }

  /** The calls that wait after `node` along `edge`, from those that wait at it (see {@link pendingCallDiagnostics}). */
  #waitingAfter(node: number, edge: string, state: CallsWaiting): CallsWaiting {
    const instruction = this.plan.instructions[node];
    if (instruction?.kind !== "transfer" || (edge !== "transfer" && edge !== "computed"))
      return state;
    if (instruction.mode === "call")
      return { kind: "calls", none: null, hidden: null, waiting: true };
    // A goto keeps the calls that wait; with none, the file it starts has none either.
    if (edge === "transfer")
      return {
        kind: "calls",
        none: state.none === null ? null : node,
        hidden: state.hidden,
        waiting: state.waiting,
      };
    const waitsForNone = state.none !== null || state.hidden !== null;
    return {
      kind: "calls",
      none: null,
      hidden: waitsForNone ? node : null,
      waiting: state.waiting,
    };
  }

  /**
   * Whether at most one copy of a block that the instruction `creator` creates stays at a time, so that no copy starts
   * where another left: a button's, which takes no click while its block waits to run or runs, that of a timer that does
   * not repeat, and that of a media that plays once and whose handle the script does not keep, which could seek it back,
   * where the instruction runs at most once in a session (see {@link #runsAgain}).
   */
  #single(creator: number, ways: ComputedWays): boolean {
    const instruction = this.plan.instructions[creator]!;
    return (
      (instruction.kind === "showPermanentButton" ||
        (instruction.kind === "startTimer" && !instruction.repeat) ||
        (instruction.kind === "playMedia" &&
          instruction.repeat.kind === "once" &&
          instruction.destinationTemporary === null)) &&
      this.#runsAgain(ways)[creator] === 0
    );
  }

  /**
   * For each instruction, whether it may run more than once in a session: where a way within its function, block, or
   * file entry leads from it back to it, as in a loop or after a `goto` back to a label, and where what it is in may
   * start more than once: a function that two calls that can run call, or one that may run more than once; a file that
   * two transfers that can run, or one that may run more than once, may start, and `main.tease` once any may; a block;
   * and a label that a `goto` outside the file's top level, such as a block's, leads to. Found once for `ways`, without
   * native recursion.
   */
  #runsAgain(ways: ComputedWays): Uint8Array {
    const facts = this.#transfers?.ways === ways ? this.#transfers : undefined;
    if (facts?.again !== undefined) return facts.again;
    const count = this.plan.instructions.length;
    // The ways within a function, block, or file entry, as a label `goto` takes them.
    const within = (index: number): number[] =>
      this.#ways(index).flatMap(({ node, edge }) =>
        node === null || edge === "transfer" || edge === "computed" || edge === "call"
          ? []
          : [node],
      );
    const again = onCycles(count, within);
    const fileAt = new Map(this.plan.files.map((file, index) => [file.entryInstruction, index]));
    // The starts of each function and file entry, which make it start more than once from two on.
    const starts = new Map<number, number>([[this.plan.files[0]!.entryInstruction, 1]]);
    const begins = (entry: number): boolean => {
      const started = (starts.get(entry) ?? 0) + 1;
      starts.set(entry, started);
      return started === 2;
    };
    // The function and file entries that an instruction may start.
    const startsOf = (index: number): number[] => {
      const instruction = this.plan.instructions[index]!;
      if (instruction.kind === "callFunction") {
        const entry = this.#flow.functionById(instruction.functionId)?.entryInstruction;
        return entry === undefined ? [] : [entry];
      }
      if (instruction.kind !== "transfer") return [];
      const target = ways.targets.get(index)?.node;
      if (target !== undefined) return target < count ? [target] : [...ways.hubs[target - count]!];
      return this.#ways(index).flatMap(({ node, edge }) =>
        edge === "transfer" && node !== null && fileAt.has(node) ? [node] : [],
      );
    };
    const work: number[] = [];
    const mark = (index: number): void => {
      if (again[index] === 2) return;
      again[index] = 2;
      work.push(index);
    };
    for (const definition of this.plan.functions)
      if (definition.handler !== null) mark(definition.entryInstruction);
    this.plan.instructions.forEach((instruction, index) => {
      if (this.#reached[index] === 0) return;
      if (instruction.kind === "goto" && this.#flow.functionOf(index) !== null)
        mark(instruction.target);
      for (const entry of startsOf(index)) if (begins(entry)) mark(entry);
    });
    // On a way within a region, a cycle runs again without what follows it doing so.
    this.plan.instructions.forEach((_, index) => {
      if (again[index] === 1 && this.#reached[index] === 1)
        for (const entry of startsOf(index)) mark(entry);
    });
    for (let index = work.pop(); index !== undefined; index = work.pop()) {
      for (const next of within(index)) mark(next);
      if (this.#reached[index] === 1) for (const entry of startsOf(index)) mark(entry);
    }
    if (facts !== undefined) facts.again = again;
    return again;
  }

  /**
   * Whether the blocks that the instruction at `index` creates may be due at any boundary between instructions, rather
   * than only once code waited: a media's, which a seek of its handle may make due, and a timer's, unless its length is
   * written out and more than zero and the script does not keep its handle, which could set what remains to zero.
   */
  #startsAnywhere(index: number): boolean {
    const instruction = this.plan.instructions[index]!;
    if (instruction.kind === "showPermanentButton") return false;
    return !(
      instruction.kind === "startTimer" &&
      instruction.destinationTemporary === null &&
      instruction.duration.kind === "duration" &&
      instruction.duration.milliseconds > 0
    );
  }

  /** Whether the instruction at `index` calls a file, which runs with that call waiting. */
  #calls(index: number): boolean {
    const instruction = this.plan.instructions[index]!;
    return instruction.kind === "transfer" && instruction.mode === "call";
  }

  /**
   * The ways on which a block stays once an instruction created it, which it then may run at (see {@link #blockRuns}),
   * over the instructions, the hubs of computed targets, and one node, `ended`, for what follows an `end`. A
   * non-persistent timer or button belongs to the file entry that created it, which a `goto` or the entry's `end`
   * leaves (V30 §27, §28), so it stays on the ways on in that entry: past a file call to what follows it, which the
   * called file's `end` returns to, and from a function's return to what follows each call of it. A block that
   * outlives its file entry (see {@link #outlivesItsFile}) also stays on a `goto`, into the files of a computed `goto`,
   * and from an `end` to what follows each file call. A block returns to wherever it interrupted the code, so its
   * returns, `blockReturns`, lead anywhere.
   */
  #staying(ways: ComputedWays): Staying {
    const count = this.plan.instructions.length;
    const ended = count + ways.hubs.length;
    const nodeCount = ended + 1;
    // For each node, the ways on which every block stays, and those on which only one that outlives its file does.
    const all: number[][] = Array.from({ length: nodeCount }, () => []);
    const outliving: number[][] = Array.from({ length: nodeCount }, () => []);
    const resumes = new Map<number, number[]>();
    const blockReturns: number[] = [];
    this.plan.instructions.forEach((instruction, index) => {
      if (instruction.kind === "callFunction") {
        const list = resumes.get(instruction.functionId) ?? [];
        list.push(instruction.returnInstruction);
        resumes.set(instruction.functionId, list);
      } else if (instruction.kind === "transfer" && instruction.mode === "call")
        outliving[ended]!.push(index + 1);
    });
    for (let index = 0; index < count; index += 1) {
      const instruction = this.plan.instructions[index]!;
      const call = instruction.kind === "transfer" && instruction.mode === "call";
      for (const { node, edge } of this.#ways(index))
        switch (edge) {
          case "transfer":
          case "computed":
            if (!call) {
              const target = node ?? ways.targets.get(index)?.node;
              if (target !== undefined) outliving[index]!.push(target);
            }
            break;
          case "goto":
            outliving[index]!.push(node!);
            break;
          case "end":
            outliving[index]!.push(ended);
            break;
          case "exit":
            break;
          case "return": {
            const definition = this.#flow.functionOf(index);
            if (definition?.handler !== null && definition?.handler !== undefined)
              blockReturns.push(index);
            else
              for (const resume of resumes.get(definition?.id ?? -1) ?? [])
                all[index]!.push(resume);
            break;
          }
          default:
            if (node !== null) all[index]!.push(node);
        }
    }
    ways.hubs.forEach((entries, hub) => outliving[count + hub]!.push(...entries));
    const before = (lists: readonly number[][]): number[][] => {
      const result: number[][] = Array.from({ length: nodeCount }, () => []);
      lists.forEach((list, node) => {
        for (const next of list) result[next]!.push(node);
      });
      return result;
    };
    return {
      nodeCount,
      stays: all,
      outlives: outliving,
      staysBefore: before(all),
      outlivesBefore: before(outliving),
      blockReturns,
    };
  }

  /**
   * Which blocks stay at each place (see {@link #staying}), as far as the checks need: `leavers`, those that may leave the
   * code they interrupt (see {@link #leavingBlocks}), `null` for none, the one block's function, or `SEVERAL_LEAVERS`,
   * also those that the instruction creates where it may wait, as a media that is waited for may run its blocks then. `anywhere`, whether one that may start at any boundary stays (see {@link #startsAnywhere}), and
   * `leavesAnywhere`, whether one that does both. Once such a block stays where a block returns, which may be anywhere,
   * every place has several.
   */
  #blocksStayingAt(stays: Staying): StayingBlocks {
    const leaving = this.#leavingBlocks();
    const seeds: (readonly [number, BlocksStaying])[] = [];
    this.plan.instructions.forEach((_, index) => {
      if (this.#reached[index] === 0) return;
      const outlives = this.#outlivesItsFile(index);
      const anywhere = this.#startsAnywhere(index);
      for (const block of this.#flow.handlersOf(index)) {
        const leaves = leaving.has(block);
        if (!leaves && !anywhere) continue;
        const blocks: Stay = {
          leavers: leaves ? block : null,
          anywhere,
          leavesAnywhere: leaves && anywhere,
        };
        const seed: BlocksStaying = outlives
          ? { kept: NO_STAY, outliving: blocks }
          : { kept: blocks, outliving: NO_STAY };
        for (const next of stays.stays[index]!) seeds.push([next, seed]);
        if (outlives) for (const next of stays.outlives[index]!) seeds.push([next, seed]);
      }
    });
    const states = solveForward<BlocksStaying, string>(
      {
        nodeCount: stays.nodeCount,
        successors: (node) => [
          ...stays.stays[node]!.map((next) => ({ node: next, edge: "stays" })),
          ...stays.outlives[node]!.map((next) => ({ node: next, edge: "outlives" })),
        ],
        join: (left, right) => ({
          kept: joinStays(left.kept, right.kept),
          outliving: joinStays(left.outliving, right.outliving),
        }),
        equals: (left, right) =>
          sameStays(left.kept, right.kept) && sameStays(left.outliving, right.outliving),
        transfer: (_, edge, state) =>
          edge === "stays"
            ? state
            : state.outliving === NO_STAY
              ? null
              : { kept: NO_STAY, outliving: state.outliving },
      },
      seeds,
    );
    const everywhere = stays.blockReturns.some((index) => states[index] !== null);
    const at = (index: number): Stay => {
      const state = states[index];
      return state === null || state === undefined
        ? NO_STAY
        : joinStays(state.kept, state.outliving);
    };
    return {
      leavers: (index) => {
        if (everywhere) return SEVERAL_LEAVERS;
        let leavers = at(index).leavers;
        if (!NEVER_WAITS.has(this.plan.instructions[index]!.kind))
          for (const block of this.#flow.handlersOf(index))
            if (leaving.has(block)) leavers = joinLeavers(leavers, block);
        return leavers;
      },
      anywhere: (index) => everywhere || at(index).anywhere,
      leavesAnywhere: (index) => everywhere || at(index).leavesAnywhere,
    };
  }

  /**
   * The timer, media, and button blocks, by function, whose own code may leave the code they interrupt: by a `goto`, an
   * `end`, or an `exit`, also in a function they call. A file they call returns into them.
   */
  #leavingBlocks(): ReadonlySet<number> {
    const leaves = solveBackward<true, string>({
      nodeCount: this.plan.instructions.length,
      successors: (index) => {
        const instruction = this.plan.instructions[index]!;
        if (
          instruction.kind === "end" ||
          instruction.kind === "exit" ||
          instruction.kind === "goto" ||
          (instruction.kind === "transfer" && instruction.mode === "goto")
        )
          return [{ node: null, edge: "leaves" }];
        const call = instruction.kind === "transfer";
        return this.#ways(index).filter(
          ({ edge }) => !(call && (edge === "transfer" || edge === "computed")),
        );
      },
      join: () => true,
      equals: () => true,
      transfer: (_, edge, state) => (edge === "leaves" ? true : state),
    });
    const blocks = new Set<number>();
    for (const definition of this.plan.functions)
      if (definition.handler !== null && leaves[definition.entryInstruction] === true)
        blocks.add(definition.id);
    return blocks;
  }

  /**
   * The `end`s that code which every way reaches with no call waiting certainly goes on to (see {@link #endings}), as
   * the `goto` in `if pick { call "scene.tease" } else { goto "scene.tease" }` when `scene.tease` is `say "scene"` and
   * `end`, or when it ends at one of several `end`s: whenever that code runs, the run fails at one of them, unless it
   * never goes on, as at an answer that never comes. Each `end` that such code may go on to maps to the way that its
   * message names: such a `goto`, else the way by which that code runs; a `goto` first, then the earliest. A block that
   * may leave the code it interrupts may run where `interrupted` tells, so code before such a place goes on to no `end`
   * for certain.
   */
  #provenEnds(
    states: readonly (CallsWaiting | null)[],
    ways: ComputedWays,
    interrupted: (index: number) => boolean,
  ): ReadonlyMap<number, number> {
    const proven = new Map<number, number>();
    const endings = this.#endings(ways, interrupted);
    const seeds: (readonly [number, number])[] = [];
    endings.forEach((ending, index) => {
      const state = states[index];
      if (
        ending === null ||
        ending.leaves ||
        ending.returns ||
        ending.end === null ||
        state === null ||
        state === undefined ||
        !withoutCall(state)
      )
        return;
      const instruction = this.plan.instructions[index];
      seeds.push([
        index,
        instruction?.kind === "transfer" && instruction.mode === "goto" ? index : state.none!,
      ]);
    });
    if (seeds.length === 0) return proven;
    // From that code along the ways it goes on, as `#endings` follows them, to the ends it may reach.
    const count = this.plan.instructions.length;
    const reached = solveForward<number, string>(
      {
        nodeCount: count + ways.hubs.length,
        successors: (node) => {
          if (node >= count)
            return ways.hubs[node - count]!.map((entry) => ({ node: entry, edge: "hub" }));
          const instruction = this.plan.instructions[node]!;
          const out: { node: number; edge: string }[] = [];
          for (const { node: next, edge } of this.#ways(node)) {
            if (instruction.kind === "transfer" && instruction.mode === "call" && edge !== "resume")
              continue;
            if (edge === "resume" && instruction.kind === "callFunction") {
              const entry = this.#flow.functionById(instruction.functionId)?.entryInstruction;
              if (entry !== undefined && endings[entry]?.returns !== true) continue;
            }
            const target = next ?? ways.targets.get(node)?.node;
            if (
              target !== undefined &&
              (next !== null || ways.targets.get(node)?.edge === "transfer")
            )
              out.push({ node: target, edge });
          }
          return out;
        },
        join: (left, right) =>
          left === SESSION_START ? right : right === SESSION_START ? left : Math.min(left, right),
        equals: (left, right) => left === right,
        transfer: (_, __, state) => state,
      },
      seeds,
    );
    this.plan.instructions.forEach((instruction, index) => {
      const way = reached[index];
      if (instruction.kind === "end" && way !== null && way !== undefined) proven.set(index, way);
    });
    return proven;
  }

  /**
   * How the code from each instruction on can stop (see {@link Ending}), by the ways of {@link #ways}, where a computed
   * target that `ways` leads into its files for certain goes on in them: a `goto` of a file goes on in it, a file `call`
   * comes back unless the called file may leave, and a function call does what the function does, then goes on after
   * the call where the function may return (see {@link #returningFunctions}). A block that an instruction creates runs
   * later, so it is no way on from there, but one that may leave the code it interrupts may run where `interrupted`
   * tells, which may then leave.
   */
  #endings(ways: ComputedWays, interrupted: (index: number) => boolean): (Ending | null)[] {
    const count = this.plan.instructions.length;
    const returning = this.#returningFunctions();
    return solveBackward<Ending, string>({
      nodeCount: count + ways.hubs.length,
      successors: (index) => {
        if (index >= count)
          return ways.hubs[index - count]!.map((entry) => ({ node: entry, edge: "hub" }));
        const out: { node: number | null; edge: string }[] = this.#ways(index).map(
          ({ node, edge }) => {
            if (node !== null || edge === "end" || edge === "return") return { node, edge };
            const target = ways.targets.get(index);
            return target?.edge === "transfer" ? target : { node: null, edge: "leaves" };
          },
        );
        if (interrupted(index)) out.push({ node: null, edge: "leaves" });
        return out;
      },
      join: (left, right) => ({
        end:
          left.end === null || left.end === right.end
            ? right.end
            : right.end === null
              ? left.end
              : SEVERAL,
        leaves: left.leaves || right.leaves,
        returns: left.returns || right.returns,
      }),
      equals: (left, right) =>
        left.end === right.end && left.leaves === right.leaves && left.returns === right.returns,
      transfer: (index, edge, state) => {
        switch (edge) {
          case "end":
            return { end: index, leaves: false, returns: false };
          case "return":
            return RETURNS;
          case "leaves":
            return LEAVING;
          // Into a function: what it does, where its return goes on after the call.
          case "call":
            return state?.returns === true ? { ...state, returns: false } : state;
          case "resume": {
            const instruction = this.plan.instructions[index]!;
            return instruction.kind !== "callFunction" || returning.has(instruction.functionId)
              ? state
              : null;
          }
          case "transfer": {
            const instruction = this.plan.instructions[index]!;
            if (instruction.kind !== "transfer" || instruction.mode === "goto") return state;
            // The called file's `end` comes back after the call.
            return state?.leaves === true ? LEAVING : null;
          }
          default:
            return state;
        }
      },
    });
  }

  /**
   * The ways on from `node` in the graph of `ways`: its own, from a computed target into its file or hub, and from a hub;
   * with `handlers`, also into the blocks that an instruction creates.
   */
  #computedSuccessors(
    ways: ComputedWays,
    node: number,
    handlers = true,
  ): { node: number; edge: string }[] {
    const count = this.plan.instructions.length;
    if (node >= count)
      return ways.hubs[node - count]!.map((entry) => ({ node: entry, edge: "hub" }));
    const out: { node: number; edge: string }[] = handlers
      ? this.#successors(node)
      : this.#ways(node).flatMap(({ node: next, edge }) =>
          next === null ? [] : [{ node: next, edge }],
        );
    const computed = ways.targets.get(node);
    if (computed !== undefined) out.push(computed);
    return out;
  }

  /** The ways of the computed targets `targets` (see {@link #computedWays}), found once. */
  #waysOf(targets: ReadonlyMap<number, ComputedTarget>): ComputedWays {
    if (this.#transfers?.targets !== targets)
      this.#transfers = { targets, ways: this.#computedWays(targets) };
    return this.#transfers.ways;
  }

  /**
   * Where blocks stay (see {@link #staying}), which of them stay at each place (see {@link #blocksStayingAt}), and where
   * a block that may leave the code it interrupts may start, `interrupted`: where one that may start anywhere stays, and
   * where code may wait, a block that may start anywhere may return to, or a file is called, while one stays. Found once
   * for `ways`.
   */
  #blocksStaying(ways: ComputedWays): {
    readonly stays: Staying;
    readonly staying: StayingBlocks;
    readonly interrupted: (index: number) => boolean;
  } {
    const facts = this.#transfers?.ways === ways ? this.#transfers : undefined;
    const stays = facts?.stays ?? this.#staying(ways);
    const staying = facts?.staying ?? this.#blocksStayingAt(stays);
    if (facts !== undefined) {
      facts.stays = stays;
      facts.staying = staying;
    }
    return {
      stays,
      staying,
      interrupted: (index) =>
        staying.leavesAnywhere(index) ||
        ((!NEVER_WAITS.has(this.plan.instructions[index]!.kind) ||
          staying.anywhere(index) ||
          this.#calls(index)) &&
          staying.leavers(index) !== null),
    };
  }

  /**
   * The functions that may return to their caller: those where a way from their start reaches a `return` or the end of
   * the body, on which a call of another function goes on only where that one may return, and a file call goes on
   * unless it is one of `stops`, which never go on. A transfer of the session does not return.
   */
  #returningFunctions(stops?: ReadonlySet<number>): ReadonlySet<number> {
    if (stops === undefined && this.#returning !== undefined) return this.#returning;
    const returning = new Set<number>();
    // The places after the calls of each function that does not return so far, which go on once it may.
    const after = new Map<number, number[]>();
    const reached = new Uint8Array(this.plan.instructions.length);
    const work: number[] = [];
    const reach = (index: number): void => {
      if (reached[index] === 1) return;
      reached[index] = 1;
      work.push(index);
    };
    for (const definition of this.plan.functions) reach(definition.entryInstruction);
    for (let index = work.pop(); index !== undefined; index = work.pop()) {
      const instruction = this.plan.instructions[index]!;
      if (stops?.has(index) === true) continue;
      for (const { node, edge } of this.#ways(index))
        if (edge === "return") {
          const definition = this.#flow.functionOf(index);
          if (definition === null || returning.has(definition.id)) continue;
          returning.add(definition.id);
          for (const next of after.get(definition.id) ?? []) reach(next);
        } else if (edge === "resume" && instruction.kind === "callFunction") {
          if (returning.has(instruction.functionId)) reach(node!);
          else {
            const list = after.get(instruction.functionId) ?? [];
            list.push(node!);
            after.set(instruction.functionId, list);
          }
        } else if (
          node !== null &&
          edge !== "call" &&
          edge !== "transfer" &&
          edge !== "computed" &&
          edge !== "goto"
        )
          reach(node);
    }
    if (stops === undefined) this.#returning = returning;
    return returning;
  }

  /**
   * The file call that the code from each instruction on certainly makes in the file that runs it (see {@link Ending},
   * whose `end` is that call here): one of `certain`, the calls that certainly start their one file, before the code
   * leaves that file, by an `end`, `exit`, or `goto`, or returns from its function. A function call does what the function
   * does, then goes on after the call where the function may return; another file call comes back unless the called file
   * may leave (see {@link #endings}). A block that may leave the code it interrupts may run where it waits.
   */
  #certainCalls(
    certain: ReadonlySet<number>,
    targets: () => ReadonlyMap<number, ComputedTarget>,
  ): (Ending | null)[] {
    const ways = this.#waysOf(targets());
    const { interrupted } = this.#blocksStaying(ways);
    const endings = this.#endings(ways, interrupted);
    const returning = this.#returningFunctions(certain);
    return solveBackward<Ending, string>({
      nodeCount: this.plan.instructions.length,
      successors: (index) => {
        if (certain.has(index)) return [{ node: null, edge: "calls" }];
        const instruction = this.plan.instructions[index]!;
        if (
          instruction.kind === "end" ||
          instruction.kind === "exit" ||
          instruction.kind === "goto" ||
          (instruction.kind === "transfer" && instruction.mode === "goto")
        )
          return [{ node: null, edge: "leaves" }];
        const out: { node: number | null; edge: string }[] = [];
        for (const way of this.#ways(index)) {
          if (instruction.kind !== "transfer" || way.edge === "resume") out.push(way);
          // The called file comes back unless it may leave.
          else if (
            way.node === null
              ? ways.targets.get(index)?.edge !== "transfer" ||
                endings[ways.targets.get(index)!.node]?.leaves !== false
              : endings[way.node]?.leaves === true
          )
            out.push({ node: null, edge: "leaves" });
        }
        if (interrupted(index)) out.push({ node: null, edge: "leaves" });
        return out;
      },
      join: (left, right) => ({
        end:
          left.end === null || left.end === right.end
            ? right.end
            : right.end === null
              ? left.end
              : SEVERAL,
        leaves: left.leaves || right.leaves,
        returns: left.returns || right.returns,
      }),
      equals: (left, right) =>
        left.end === right.end && left.leaves === right.leaves && left.returns === right.returns,
      transfer: (index, edge, state) => {
        switch (edge) {
          case "calls":
            return { end: index, leaves: false, returns: false };
          case "return":
            return RETURNS;
          case "leaves":
            return LEAVING;
          case "call":
            return state?.returns === true ? { ...state, returns: false } : state;
          case "resume": {
            const instruction = this.plan.instructions[index]!;
            return instruction.kind !== "callFunction" || returning.has(instruction.functionId)
              ? state
              : null;
          }
          default:
            return state;
        }
      },
    });
  }

  /**
   * The way of each computed target for the checks of waiting calls and of the files that start (see
   * {@link pendingCallDiagnostics}, {@link unstartedFileWarnings}). A `script(...)` of a path written out names its file,
   * which the checks follow like a file target. Any other target leads to a node of its own after the instructions, a
   * hub, with a way into each file that `targets` gives it, any file without one. The checks follow a target that may
   * start each of its files like a glob, by a `transfer` way, and any other by a `computed` way, which they cannot
   * follow: they do not read the tests that decide which file it names, nor whether it names an existing one, so an
   * error there could reject code that cannot fail. Targets that may start the same files share one hub, by the list of
   * files that `targets` shares, so the ways grow with the files, not with the targets times the files.
   */
  #computedWays(computed: ReadonlyMap<number, ComputedTarget>): ComputedWays {
    const count = this.plan.instructions.length;
    const files = new Map(this.plan.files.map((file, index) => [file.path, index]));
    const targets = new Map<number, { readonly node: number; readonly edge: string }>();
    const hubs: (readonly number[])[] = [];
    // By whether the target may start each file, then by its list of files, `null` for every file.
    const hubOf = [
      new Map<readonly number[] | null, number>(),
      new Map<readonly number[] | null, number>(),
    ] as const;
    const hub = ({ files: picked, certain }: ComputedTarget): number => {
      const known = hubOf[certain ? 1 : 0];
      let node = known.get(picked);
      if (node === undefined) {
        node = count + hubs.length;
        hubs.push(
          (picked ?? this.plan.files.map((_, file) => file)).map(
            (file) => this.plan.files[file]!.entryInstruction,
          ),
        );
        known.set(picked, node);
      }
      return node;
    };
    this.plan.instructions.forEach((instruction, index) => {
      if (instruction.kind !== "transfer" || !("value" in instruction.destination)) return;
      const path = writtenPath(instruction.destination.value);
      if (path !== undefined) {
        const file = typeof path === "string" ? files.get(path) : undefined;
        if (file !== undefined)
          targets.set(index, { node: this.plan.files[file]!.entryInstruction, edge: "transfer" });
        return;
      }
      const target = computed.get(index) ?? ANY_TARGET;
      targets.set(index, { node: hub(target), edge: target.certain ? "transfer" : "computed" });
    });
    return { targets, hubs };
  }

  /**
   * A `goto` to a file of declarations only ends nowhere, so it fails (V30 §29). The name pass reports one whose
   * `script(...)` names its file in text written out, and a tagged pick never picks such a file. For any other computed
   * target, the files that `targets` gives it decide, any file without one: a `goto` whose every such file runs nothing
   * is an error (TSV057, for one file with the name pass's text), and one that may lead to such a file is a warning
   * (TSV074), which the runtime checks (TSR069). Like the name pass, this also reports a `goto` that never runs.
   */
  public computedGotoDiagnostics(
    targets: () => ReadonlyMap<number, ComputedTarget>,
  ): Diagnostic[][] {
    const diagnostics = this.plan.files.map((): Diagnostic[] => []);
    // By the list of files, which targets share: a file of declarations only among them, and whether all are.
    const found = new Map<
      readonly number[] | null,
      { readonly file: number | undefined; readonly all: boolean }
    >();
    this.plan.instructions.forEach((instruction, index) => {
      if (
        instruction.kind !== "transfer" ||
        instruction.mode !== "goto" ||
        !("value" in instruction.destination)
      )
        return;
      const value = instruction.destination.value;
      if (value.kind === "tagQuery" || writtenPath(value) !== undefined) return;
      const files = (targets().get(index) ?? ANY_TARGET).files;
      let empty = found.get(files);
      if (empty === undefined) {
        const candidates = files ?? [...this.plan.files.keys()];
        const nothing = candidates.filter((file) => runsNothing(this.plan, file));
        empty = {
          file: nothing[0],
          all: files !== null && nothing.length > 0 && nothing.length === candidates.length,
        };
        found.set(files, empty);
      }
      if (empty.file === undefined) return;
      const path = this.plan.files[empty.file]!.path;
      const span = planLocationToSourceSpan(value.span);
      diagnostics[this.#flow.fileOf(index)]!.push(
        empty.all
          ? createDiagnostic(
              DiagnosticSeverity.Error,
              "TSV057",
              files!.length === 1
                ? declarationsOnlyMessage(path)
                : `Every file that this 'goto' can lead to, such as '${path}', holds declarations only and runs nothing, so going there would end nowhere. Make the 'goto' lead to a file that runs something.`,
              span,
            )
          : createDiagnostic(
              DiagnosticSeverity.Warning,
              "TSV074",
              `The file of this 'goto' is known only when it runs, so the compiler cannot tell whether it is '${path}', which holds declarations only and runs nothing. If it is, the 'goto' fails. If it can be, make sure the 'goto' leads to a file that runs something.`,
              span,
            ),
      );
    });
    return diagnostics;
  }

  /**
   * A `call` starts another file, so a call that can start the running file is an error (TSV072, V30 §29). A file's own
   * code, its top level and its functions, runs in that file, so a call there that can start the file is an error, also
   * where it cannot run itself, as a call of the file it stands in is an error anywhere. A global function runs in every
   * file whose code calls it where it can run, also through other global functions, but whether its call runs while
   * such a file runs depends on the run: on its tests and defaults, and on the blocks that may end a wait first. It is an
   * error only where a file's own code that can run calls a global function from which every way certainly makes that
   * call, of that file alone (see {@link #certainCalls}). Else only the run decides, as it does for a tagged pick or
   * reference that the compiler cannot decide, and for code that a timer, media, or button block runs, which runs later,
   * while the file that started it or a file it called runs, or after it. A call that may start a file its code runs in
   * then is a warning (TSV073), and the runtime checks every call (TSR069). `calls` holds each call by its transfer
   * instruction, and `targets` where computed targets may lead.
   */
  public runningFileDiagnostics(
    calls: ReadonlyMap<number, FileCall>,
    targets: () => ReadonlyMap<number, ComputedTarget>,
  ): Diagnostic[][] {
    const diagnostics = this.plan.files.map((): Diagnostic[] => []);
    if (calls.size === 0) return diagnostics;
    // A function or block by its id, a file's top level by `-1 - file`.
    const region = (index: number): number =>
      this.#flow.functionOf(index)?.id ?? -1 - this.#flow.fileOf(index);
    const callees = new Map<number, number[]>();
    // The files each region may run in, and an instruction that starts a block from which it runs later. A pair is
    // found once, then passed on to the functions the region calls: a file as itself, a block's start as `-1 - start`.
    const running = new Map<number, Set<number>>();
    const later = new Map<number, number>();
    const work: (readonly [number, number])[] = [];
    const runs = (node: number, file: number): void => {
      const files = running.get(node) ?? new Set<number>();
      if (files.has(file)) return;
      files.add(file);
      running.set(node, files);
      work.push([node, file]);
    };
    const runsLater = (node: number, start: number): void => {
      if (later.has(node)) return;
      later.set(node, start);
      work.push([node, -1 - start]);
    };
    this.plan.instructions.forEach((instruction, index) => {
      if (this.#reached[index] === 0) return;
      if (instruction.kind === "callFunction") {
        const caller = region(index);
        const list = callees.get(caller);
        if (list === undefined) callees.set(caller, [instruction.functionId]);
        else list.push(instruction.functionId);
      }
      for (const handler of this.#flow.handlersOf(index)) runsLater(handler, index);
    });
    this.plan.files.forEach((_, file) => runs(-1 - file, file));
    for (let pair = work.pop(); pair !== undefined; pair = work.pop()) {
      const [node, fact] = pair;
      for (const callee of callees.get(node) ?? [])
        if (fact >= 0) runs(callee, fact);
        else runsLater(callee, -1 - fact);
    }
    // The calls of a global function that every way through a file that runs certainly makes, which start that file.
    let always: ReadonlySet<number> | undefined;
    const alwaysMade = (): ReadonlySet<number> => {
      const certain = new Set<number>();
      for (const [index, call] of calls)
        if (call.files?.length === 1 && call.starts(call.files[0]!) === true) certain.add(index);
      const reaches = this.#certainCalls(certain, targets);
      const found = new Set<number>();
      this.plan.files.forEach(({ entryInstruction }, file) => {
        const reach = reaches[entryInstruction];
        if (
          this.#reached[entryInstruction] === 1 &&
          reach !== null &&
          reach !== undefined &&
          !reach.leaves &&
          !reach.returns &&
          reach.end !== null &&
          reach.end !== SEVERAL &&
          calls.get(reach.end)?.files?.[0] === file
        )
          found.add(reach.end);
      });
      return found;
    };
    for (const [index, call] of calls) {
      const node = region(index);
      const files = running.get(node) ?? new Set<number>();
      const definition = this.#flow.functionOf(index);
      const global =
        definition?.global === true && definition.handler === null ? definition.name : null;
      let certain: number | undefined;
      let made = false;
      let guarded: number | undefined;
      let possible: number | undefined;
      for (const file of call.files ?? [...files].sort((left, right) => left - right)) {
        if (!files.has(file)) continue;
        const starts = call.starts(file);
        if (starts === true && global === null) {
          certain = file;
          break;
        }
        // The one file it starts, which runs this call on every way through it.
        if (starts === true && (always ??= alwaysMade()).has(index)) {
          certain = file;
          made = true;
          break;
        }
        // In a global function, which is the only code with a certain target left here.
        if (starts === true) guarded ??= file;
        else if (starts === null) possible ??= file;
      }
      const start = later.get(node);
      if (
        certain === undefined &&
        guarded === undefined &&
        possible === undefined &&
        start === undefined
      )
        continue;
      const file = this.#flow.fileOf(index);
      const path = (target: number): string => this.plan.files[target]!.path;
      diagnostics[file]!.push(
        certain !== undefined
          ? createDiagnostic(
              DiagnosticSeverity.Error,
              "TSV072",
              made
                ? `This call starts '${path(certain)}' while it is already running, because '${path(certain)}' always runs global function '${global!}' up to here. ${calledFileFix(path(certain), call.form, global)}`
                : calledFileMessage(path(certain), call.form),
              call.span,
            )
          : createDiagnostic(
              DiagnosticSeverity.Warning,
              "TSV073",
              guarded !== undefined
                ? guardedCallMessage(path(guarded), call.form, global!)
                : possible !== undefined
                  ? pickedFileMessage(path(possible), call.form, global)
                  : laterCallMessage(
                      this.#blockAt(start!, file),
                      call.form === "path" && call.files?.length === 1
                        ? path(call.files[0]!)
                        : null,
                    ),
              call.span,
            ),
      );
    }
    return diagnostics;
  }

  /** Whether the blocks that the instruction at `index` creates may run after the file entry that created them ended. */
  #outlivesItsFile(index: number): boolean {
    const instruction = this.plan.instructions[index];
    return instruction?.kind === "startTimer" || instruction?.kind === "showPermanentButton"
      ? instruction.persist
      : true;
  }

  /** Where the instruction at `index` stands, as seen from the file `from`: `line 3` or `line 3 of main.tease`. */
  #where(index: number, from: number): string {
    const file = this.#flow.fileOf(index);
    const line = `line ${this.plan.instructions[index]!.span.sl + 1}`;
    return file === from ? line : `${line} of '${this.plan.files[file]!.path}'`;
  }

  /**
   * The block that the instruction at `index` starts, as seen from the file `from`: when it runs, as in "from the timer
   * on line 3", and how to stop it.
   */
  #blockAt(index: number, from: number): { readonly when: string; readonly stop: string } {
    const where = this.#where(index, from);
    const kind = this.plan.instructions[index]!.kind;
    return kind === "showPermanentButton"
      ? { when: `when the button on ${where} is pressed`, stop: "remove the button" }
      : kind === "playMedia"
        ? { when: `from the media on ${where}`, stop: "stop the media" }
        : { when: `from the timer on ${where}`, stop: "stop the timer" };
  }

  /**
   * The code of a file that no `goto` or `call` which can run starts never runs (TSV065, #595): the session starts
   * `main.tease`, and the ways that can run lead on from there, by a target written out or a glob into each file it
   * names, and by any other target into each file that `targets` gives it (see {@link #computedWays}). The warning
   * stands on the file's first statement that runs where it stands; a file of declarations only runs nothing, so it gets
   * none. A file the host could not load is not in the plan, so when `unreadable` asks, `referencesRun` tells whether a
   * computed target other than a tagged pick or a `script(...)` of a path written out can run, which may start such a
   * file too.
   */
  public unstartedFileWarnings(
    targets: () => ReadonlyMap<number, ComputedTarget>,
    unreadable: boolean,
  ): { readonly files: Diagnostic[][]; readonly referencesRun: boolean } {
    const diagnostics = this.plan.files.map((): Diagnostic[] => []);
    if (this.plan.files.length < 2 && !unreadable)
      return { files: diagnostics, referencesRun: false };
    const count = this.plan.instructions.length;
    const computed = targets();
    const ways = this.#waysOf(computed);
    const states = solveForward<true, string>(
      {
        nodeCount: count + ways.hubs.length,
        successors: (node) => this.#computedSuccessors(ways, node),
        join: () => true,
        equals: () => true,
        transfer: () => true,
      },
      [[this.plan.files[0]!.startInstruction, true]],
    );
    this.plan.files.forEach((file, index) => {
      if (states[file.entryInstruction] !== null || runsNothing(this.plan, index)) return;
      // A start value stands in its file but runs at the start of the session, with those of `main.tease`.
      const first = this.programs[index]!.statements.find((statement) => {
        const range = this.trace.statements.get(statement);
        return (
          range !== undefined &&
          range.start < range.end &&
          range.start >= file.entryInstruction &&
          range.end <= file.rootEndInstruction
        );
      });
      if (first === undefined) return;
      diagnostics[index]!.push(
        createDiagnostic(
          DiagnosticSeverity.Warning,
          "TSV065",
          `${unstartedFileSentence(file.path)} Remove the file, or start the file with a 'goto' or 'call'.`,
          first.span,
        ),
      );
    });
    // A reference other than a `script(...)` of a path written out leads through a hub.
    let referencesRun = false;
    for (const [index, way] of ways.targets)
      if (way.node >= count && computed.get(index)?.tagged !== true && states[index] !== null)
        referencesRun = true;
    return { files: diagnostics, referencesRun };
  }

  /** Whether an `exit` can run, which the project needs (TSV053, ADR 0022 §4.1). */
  public reachesExit(): boolean {
    return this.plan.instructions.some(
      (instruction, index) => instruction.kind === "exit" && this.#reached[index] === 1,
    );
  }

  /**
   * The warnings of each file, in source order: the loops with no way out (TSV058), and each run of statements that
   * never run, on its first statement (TSV065, or TSV066 for an `exit`). `constantTests` holds the TSV046 warnings of
   * each file, which may already report why a branch never runs, and `started` whether something starts the file, which
   * otherwise has a warning that its top level never runs (see {@link unstartedFileWarnings}).
   */
  public warnings(
    constantTests: readonly (readonly ConstantTest[])[],
    started: (file: number) => boolean,
  ): Diagnostic[][] {
    const { diagnostics, closed } = this.#closedLoops();
    this.programs.forEach((program, file) =>
      new UnreachableCode(
        (statement) => this.#runs(statement),
        (statements) => this.#regionRuns(statements),
        closed,
        [...(constantTests[file] ?? [])].sort(
          (left, right) => left.span.start.offset - right.span.start.offset,
        ),
        started(file),
        diagnostics[file]!,
      ).report(program),
    );
    for (const list of diagnostics)
      list.sort((left, right) => left.span.start.offset - right.span.start.offset);
    return diagnostics;
  }

  /**
   * Whether the function or block whose statements are `statements` runs: a call or creation that can run reaches it.
   * `null` when none of them has instructions.
   */
  #regionRuns(statements: readonly Statement[]): boolean | null {
    for (const statement of statements) {
      const range = this.trace.statements.get(statement);
      if (range === undefined || range.start === range.end) continue;
      const definition = this.#flow.functionOf(range.start);
      return definition === null || this.#reached[definition.entryInstruction] === 1;
    }
    return null;
  }

  /**
   * Warns about each loop with no way out once it starts (#578): a `while true`, and a top-level `goto` back to an
   * earlier label of its file, whose loop is the statements between them. As V30 §30 decides, a `break`, `return`,
   * `end`, `exit`, any other `goto`, a `call` of a file, or a call of a function other than an engine function is a way
   * out wherever it stands in the loop, also nested, but only where it can run. A timer or media block may run during
   * any loop, so when a block of the project has a way out that can run, no loop is reported. Neither is a loop that
   * cannot run. Returns the warnings of each file and the loops they report.
   */
  #closedLoops(): { diagnostics: Diagnostic[][]; closed: ReadonlySet<Statement> } {
    let blockExits = false;
    const loops: { readonly file: number; readonly loop: EndlessLoop }[] = [];
    const closed = this.programs.map((): Statement[] => []);
    /** Walks a top-level statement and returns whether it has a way out that can run. */
    const walk = (file: number, root: Statement): boolean => {
      let found = false;
      const work: ExitWork[] = [{ statement: root, loop: null, handler: false }];
      const enter = (
        statements: readonly Statement[],
        loop: EndlessLoop | null,
        handler: boolean,
      ): void => {
        for (let index = statements.length - 1; index >= 0; index -= 1)
          work.push({ statement: statements[index]!, loop, handler });
      };
      const wayOut = (loop: EndlessLoop | null, handler: boolean): void => {
        found = true;
        blockExits ||= handler;
        // A way out of an inner loop is one of the loops around it too.
        for (let node = loop; node !== null && !node.exits; node = node.parent) node.exits = true;
      };
      while (work.length > 0) {
        const item = work.pop()!;
        const { loop, handler } = item;
        if ("statement" in item && this.#runs(item.statement) === false) continue;
        // A timer or media block runs later, outside the loop that starts it.
        for (const block of handlerBlocks("expression" in item ? item.expression : item.statement))
          enter(block.statements, null, true);
        if ("expression" in item) {
          const expression = item.expression;
          if (
            expression.kind === "callExpression" &&
            !(
              expression.callee.kind === "identifier" &&
              ENGINE_FUNCTIONS.has(expression.callee.name)
            )
          )
            wayOut(loop, handler);
          // The right side of an `and`, `or`, or `otherwise` that never runs has no way out.
          const skipped =
            expression.kind === "binaryExpression" && this.ways.skipsRight(file, expression.span)
              ? expression.right
              : null;
          for (const part of expressionParts(expression))
            if (part !== skipped) work.push({ expression: part, loop, handler });
          continue;
        }
        const statement = item.statement;
        if (LOOP_EXITS.has(statement.kind)) wayOut(loop, handler);
        if (statement.kind === "functionDeclaration") {
          enter(statement.body.statements, null, false);
          for (const parameter of statement.parameters)
            if (parameter.defaultValue !== null)
              work.push({ expression: parameter.defaultValue, loop: null, handler: false });
          continue;
        }
        let inner = loop;
        if (isWhileTrue(statement)) {
          inner = { statement, parent: loop, exits: false };
          loops.push({ file, loop: inner });
        }
        enter(nestedStatements(statement), inner, handler);
        for (const expression of statementExpressions(statement))
          work.push({ expression, loop, handler });
      }
      return found;
    };
    for (const [file, program] of this.programs.entries()) {
      // The number of top-level statements with a way out before each label.
      const labels = new Map<string, number>();
      let count = 0;
      for (const statement of program.statements) {
        if (statement.kind === "labelStatement") labels.set(statement.name.name, count);
        else if (
          statement.kind === "gotoStatement" &&
          statement.target.kind === "labelTarget" &&
          labels.get(statement.target.label.name) === count &&
          this.#runs(statement) !== false
        )
          closed[file]!.push(statement);
        // A function runs where it is called, and a call is a way out.
        if (walk(file, statement) && statement.kind !== "functionDeclaration") count += 1;
      }
    }
    if (blockExits) return { diagnostics: this.programs.map(() => []), closed: new Set() };
    for (const { file, loop } of loops) if (!loop.exits) closed[file]!.push(loop.statement);
    return {
      diagnostics: closed.map((statements) =>
        statements.map((statement) =>
          createDiagnostic(
            DiagnosticSeverity.Warning,
            "TSV058",
            NO_WAY_OUT,
            statement.kind === "whileStatement"
              ? createSourceSpan(statement.span.start, statement.condition.span.end)
              : statement.span,
          ),
        ),
      ),
      closed: new Set(closed.flat()),
    };
  }
}

/**
 * Whether a way reaches code with no file call waiting: `none` names one by the `goto` that started the running file
 * without a call, or `SESSION_START`, and `hidden` one by the computed `goto`, or the instruction that creates a block,
 * that may have done so. Both `null`: every way there has a call waiting. The first way found names each. `waiting`:
 * whether a way reaches the code with a call waiting.
 */
interface CallsWaiting {
  readonly kind: "calls";
  readonly none: number | null;
  readonly hidden: number | null;
  readonly waiting: boolean;
}

/**
 * Where a block starts, as far as its `end` needs (see `Reachability.#blockRuns`): whether such a place may have no
 * call waiting, `unsafe`, and which blocks that may leave the code they interrupt stay there (see `StayingBlocks`).
 */
interface BlockStarts {
  readonly unsafe: boolean;
  readonly leavers: number | null;
}

/**
 * Where the blocks that an instruction creates start, once they stay: one that may start at any boundary, `anywhere`,
 * and one that starts once due, `due`, `null` where it never does.
 */
interface BlockRuns {
  readonly kind: "runs";
  readonly anywhere: BlockStarts;
  readonly due: BlockStarts | null;
}

/** For a block where an instruction creates it: whether the instruction runs, and where the block starts then. */
interface BlockGate {
  readonly kind: "gate";
  readonly created: boolean;
  readonly run: BlockRuns | null;
}

/** The facts of the analysis of `Reachability.#blockRuns`, by its nodes. */
type BlockState = CallsWaiting | BlockRuns | BlockGate;

function joinBlockStates(left: BlockState, right: BlockState): BlockState {
  if (left.kind === "calls" && right.kind === "calls")
    return {
      kind: "calls",
      none: left.none ?? right.none,
      hidden: left.hidden ?? right.hidden,
      waiting: left.waiting || right.waiting,
    };
  if (left.kind === "runs" && right.kind === "runs") return joinRuns(left, right);
  if (left.kind === "gate" && right.kind === "gate")
    return {
      kind: "gate",
      created: left.created || right.created,
      run:
        left.run === null
          ? right.run
          : right.run === null
            ? left.run
            : joinRuns(left.run, right.run),
    };
  throw new Error("A node of the block analysis has states of two kinds.");
}

function joinRuns(left: BlockRuns, right: BlockRuns): BlockRuns {
  return {
    kind: "runs",
    anywhere: joinStarts(left.anywhere, right.anywhere)!,
    due: joinStarts(left.due, right.due),
  };
}

function joinStarts(left: BlockStarts | null, right: BlockStarts | null): BlockStarts | null {
  return left === null
    ? right
    : right === null
      ? left
      : { unsafe: left.unsafe || right.unsafe, leavers: joinLeavers(left.leavers, right.leavers) };
}

function sameStarts(left: BlockStarts | null, right: BlockStarts | null): boolean {
  return left === null || right === null
    ? left === right
    : left.unsafe === right.unsafe && left.leavers === right.leavers;
}

function sameBlockStates(left: BlockState, right: BlockState): boolean {
  switch (left.kind) {
    case "calls":
      return (
        right.kind === "calls" &&
        left.none === right.none &&
        left.hidden === right.hidden &&
        left.waiting === right.waiting
      );
    case "runs":
      return (
        right.kind === "runs" &&
        sameStarts(left.anywhere, right.anywhere) &&
        sameStarts(left.due, right.due)
      );
    case "gate":
      return (
        right.kind === "gate" &&
        left.created === right.created &&
        (left.run === null || right.run === null
          ? left.run === right.run
          : sameBlockStates(left.run, right.run))
      );
  }
}

/**
 * Blocks that stay at a place, as far as the checks need (see `Reachability.#blocksStayingAt`): those that may leave the
 * code they interrupt, `leavers`, whether one that may start at any boundary stays, `anywhere`, and one that does both,
 * `leavesAnywhere`.
 */
interface Stay {
  readonly leavers: number | null;
  readonly anywhere: boolean;
  readonly leavesAnywhere: boolean;
}

const NO_STAY: Stay = { leavers: null, anywhere: false, leavesAnywhere: false };

function joinStays(left: Stay, right: Stay): Stay {
  if (left === NO_STAY) return right;
  if (right === NO_STAY) return left;
  return {
    leavers: joinLeavers(left.leavers, right.leavers),
    anywhere: left.anywhere || right.anywhere,
    leavesAnywhere: left.leavesAnywhere || right.leavesAnywhere,
  };
}

function sameStays(left: Stay, right: Stay): boolean {
  return (
    left.leavers === right.leavers &&
    left.anywhere === right.anywhere &&
    left.leavesAnywhere === right.leavesAnywhere
  );
}

/** The blocks that stay at a place: those that belong to a file entry, `kept`, and those that outlive it. */
interface BlocksStaying {
  readonly kept: Stay;
  readonly outliving: Stay;
}

/** Which blocks stay at each instruction (see `Reachability.#blocksStayingAt`). */
interface StayingBlocks {
  leavers(index: number): number | null;
  anywhere(index: number): boolean;
  leavesAnywhere(index: number): boolean;
}

/** More than one block, or more than one copy of a block, that may leave the code it interrupts. */
const SEVERAL_LEAVERS = -1;

function joinLeavers(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null || left === right ? left : SEVERAL_LEAVERS;
}

/**
 * The ways on which a block stays (see `Reachability.#staying`), by node: those of every block, `stays`, and those of
 * a block that outlives its file entry only, `outlives`, each also backwards; and the returns of blocks.
 */
interface Staying {
  readonly nodeCount: number;
  readonly stays: readonly (readonly number[])[];
  readonly outlives: readonly (readonly number[])[];
  readonly staysBefore: readonly (readonly number[])[];
  readonly outlivesBefore: readonly (readonly number[])[];
  readonly blockReturns: readonly number[];
}

/** The start of the session, which runs `main.tease` with no call waiting. */
const SESSION_START = -1;

/**
 * The instructions that never make execution wait, so that no timer, media, or button block starts at them unless
 * another block left the code it interrupted there. Any other may.
 */
const NEVER_WAITS: ReadonlySet<InstructionPlan["instructions"][number]["kind"]> = new Set([
  "declareGlobal",
  "declareSpeaker",
  "setDefaultSpeaker",
  "copyPlayerProfile",
  "enterScope",
  "leaveScope",
  "declareBinding",
  "prepareReference",
  "validateAssignmentTarget",
  "assign",
  "validateCallReceiver",
  "evaluate",
  "jumpIfFalse",
  "jump",
  "loopStart",
  "loopControl",
  "storeTemporary",
  "prepareSaySpeaker",
  "prepareSayContextualSpeaker",
  "prepareSayText",
  "prepareInteractionSpeaker",
  "clearTemporary",
  "clearTemporaries",
  "callFunction",
  "bindSuppliedParameter",
  "beginFunctionDefaults",
  "prepareParameterDefault",
  "bindDefaultParameter",
  "enterFunctionBody",
  "returnValue",
  "returnVoid",
  "startTimer",
  "showPermanentButton",
  "goto",
  "transfer",
  "end",
  "exit",
]);

/** Whether every way to code reaches it with no call waiting, also the ways that the compiler cannot follow. */
function withoutCall(state: CallsWaiting): boolean {
  return state.none !== null && state.hidden === null && !state.waiting;
}

/**
 * How the code from an instruction on can stop running (see `Reachability.#endings`): at an `end`, the instruction
 * `end`, or `SEVERAL` for more than one, `null` for none; by leaving the code that runs, `leaves`, through an `exit`, a
 * computed target, or a file call that may not come back; and by returning from its function, `returns`. Code that
 * never stops, as a loop with no way out, has no ending.
 */
interface Ending {
  readonly end: number | null;
  readonly leaves: boolean;
  readonly returns: boolean;
}

/** More than one `end` at which code may stop. */
const SEVERAL = -1;
const LEAVING: Ending = { end: null, leaves: true, returns: false };
const RETURNS: Ending = { end: null, leaves: false, returns: true };

/** `text` with its first letter in lower case, to follow "If that can happen, ". */
function lowerFirst(text: string): string {
  return `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

/**
 * What to do about a call that can start `path` while it is running, by how the call names its file: in a file's own
 * code, or in a global function, `global`.
 */
function calledFileFix(path: string, form: FileCall["form"], global: string | null): string {
  return form === "glob"
    ? `Change the pattern so that it does not match '${path}'.`
    : form === "tagged"
      ? `Leave '${path}' out with 'from:', or with a tag that it does not have.`
      : global === null
        ? "To run a part of it and come back, put that part in a function and write the function's name with '()' instead. To continue at a label without coming back, write 'goto' and the label."
        : `Run '${global}' only from other files.`;
}

/** Why a call may not start `path`, the file it stands in (V30 §29): that file is already running. */
function calledFileMessage(path: string, form: FileCall["form"]): string {
  return `This call ${form === "path" ? "starts" : "can pick"} its own file, '${path}', which is already running. ${calledFileFix(path, form, null)}`;
}

/**
 * Why a call in a global function, `global`, may start `path`, a file whose code runs the function: the compiler cannot
 * tell whether that file is running then.
 */
function guardedCallMessage(path: string, form: FileCall["form"], global: string): string {
  return form === "path"
    ? `This call starts '${path}', which runs global function '${global}', so the compiler cannot tell whether '${path}' is already running when the call runs. If it is, the call fails. If that can happen, run '${global}' only from other files.`
    : `This call can pick '${path}', which runs global function '${global}', so the compiler cannot tell whether that file is already running when this call picks it. If it is, the call fails. If that can happen, ${lowerFirst(calledFileFix(path, form, global))}`;
}

/**
 * Why a call whose tagged pick or computed target decides its file when it runs may start `path`: in a file's own code,
 * its own file, and in a global function, `global`, a file whose code runs the function.
 */
function pickedFileMessage(path: string, form: FileCall["form"], global: string | null): string {
  if (form === "tagged")
    return global === null
      ? `This call's tags depend on a value known only when it runs, so the compiler cannot tell whether it can pick its own file, '${path}', which is already running. If it does, the call fails. ${calledFileFix(path, form, global)}`
      : `This call's tags depend on a value known only when it runs, so the compiler cannot tell whether it can pick '${path}', which runs global function '${global}'. If it picks '${path}' while that file is running, the call fails. ${calledFileFix(path, form, global)}`;
  return global === null
    ? `This call's file is known only when it runs, so the compiler cannot tell whether it is its own file, '${path}', which is already running. If it is, the call fails. If it can be, put the part to run in a function and write the function's name with '()' instead.`
    : `This call's file is known only when it runs, so the compiler cannot tell whether it is '${path}', which runs global function '${global}'. If it is, and '${path}' is running then, the call fails. If it can be '${path}', run '${global}' only from other files.`;
}

/**
 * Why a call that a block runs later may start a running file: the block runs while the file that started it or a file
 * it called runs, or after it. `block` says when it runs and how to stop it; `path` is the file the call names, `null`
 * when it picks one.
 */
function laterCallMessage(
  block: { readonly when: string; readonly stop: string },
  path: string | null,
): string {
  return path !== null
    ? `This call runs later, ${block.when}, so the compiler cannot tell whether '${path}' is already running then. If it is, the call fails. If that can happen, ${block.stop} while '${path}' runs, or put what '${path}' does in a function and write the function's name with '()' instead.`
    : `This call runs later, ${block.when}, so the compiler cannot tell whether the file it starts is already running then. If it is, the call fails. If that can happen, ${block.stop} while such a file runs.`;
}

/** Why the code of a file never runs (TSV065, #595), whether or not the host could load the file. */
function unstartedFileSentence(path: string): string {
  return `The code of '${path}' never runs, because no 'goto' or 'call' that can run starts the file.`;
}

/**
 * Why a file or folder that the host could not load is code that never runs (TSV065, #595): no code that can run uses
 * it. The host's reason follows, which says why it cannot be read and what to do.
 */
export function unusedUnreadableMessage(entry: UnreadablePackageFile): string {
  return entry.folder === true
    ? `No code that can run uses a file in the folder '${entry.path}'. Remove the folder, or use the files of '${entry.path}' once the Player can read the folder. ${entry.reason}`
    : `${unstartedFileSentence(entry.path)} Remove the file, or start the file with a 'goto' or 'call' once the Player can read the file. ${entry.reason}`;
}

/**
 * The one file that a computed target's reference can name, when the references of the project can name only that
 * file (`referenced`, see `referencedFiles` in `compiler.ts`): such a target starts it, if it starts a file at all.
 */
export function knownReferenceFile(referenced: readonly number[] | null): number | undefined {
  return referenced?.length === 1 ? referenced[0] : undefined;
}

/** The path of a computed target that is a `script(...)` of a path written out, which names its file; else none. */
function writtenPath(value: ExpressionPlan): LiteralExpressionPlan["value"] | undefined {
  return value.kind === "call" &&
    value.callee.kind === "identifier" &&
    value.callee.name === "script" &&
    value.arguments.length === 1 &&
    value.arguments[0]!.value.kind === "literal"
    ? value.arguments[0]!.value.value
    : undefined;
}

/**
 * For each node of a graph, `1` where a way of `successors` leads from it back to it, else `0`: the nodes of its strongly
 * connected components of more than one node, and those with a way to themselves. Without native recursion.
 */
function onCycles(nodeCount: number, successors: (node: number) => readonly number[]): Uint8Array {
  const cyclic = new Uint8Array(nodeCount);
  const order = new Int32Array(nodeCount).fill(-1);
  const low = new Int32Array(nodeCount);
  const open = new Uint8Array(nodeCount);
  const component: number[] = [];
  let next = 0;
  for (let root = 0; root < nodeCount; root += 1) {
    if (order[root] !== -1) continue;
    const frames: { readonly node: number; readonly edges: readonly number[]; at: number }[] = [];
    const enter = (node: number): void => {
      order[node] = next;
      low[node] = next;
      next += 1;
      component.push(node);
      open[node] = 1;
      frames.push({ node, edges: successors(node), at: 0 });
    };
    enter(root);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      if (frame.at < frame.edges.length) {
        const to = frame.edges[frame.at]!;
        frame.at += 1;
        if (to === frame.node) cyclic[to] = 1;
        if (order[to] === -1) enter(to);
        else if (open[to] === 1) low[frame.node] = Math.min(low[frame.node]!, order[to]!);
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) low[parent.node] = Math.min(low[parent.node]!, low[frame.node]!);
      if (low[frame.node] !== order[frame.node]) continue;
      const members = component.splice(component.lastIndexOf(frame.node));
      for (const member of members) {
        open[member] = 0;
        if (members.length > 1) cyclic[member] = 1;
      }
    }
  }
  return cyclic;
}

/** For each index, how many of the entries before it are set; one more count at the end, for all of them. */
function countsBefore(set: Uint8Array): Int32Array {
  const counts = new Int32Array(set.length + 1);
  for (let index = 0; index < set.length; index += 1)
    counts[index + 1] = counts[index]! + set[index]!;
  return counts;
}

/** The statements that leave a loop or the session, or may: one of them is a way out of the loop it stands in. */
const LOOP_EXITS: ReadonlySet<Statement["kind"]> = new Set([
  "breakStatement",
  "returnStatement",
  "endStatement",
  "exitStatement",
  "gotoStatement",
  "callFileStatement",
]);

/** The engine functions, which only compute a value; a call of any other function may leave a loop. */
const ENGINE_FUNCTIONS: ReadonlySet<string> = new Set(CORE_RUNTIME_BUILTINS);

/** A `while true` loop, and whether its body has a way out. */
interface EndlessLoop {
  readonly statement: Extract<Statement, { kind: "whileStatement" }>;
  readonly parent: EndlessLoop | null;
  exits: boolean;
}

/** A node to walk, with the innermost `while true` around it and whether it stands in a timer or media block. */
type ExitWork = { readonly loop: EndlessLoop | null; readonly handler: boolean } & (
  { readonly statement: Statement } | { readonly expression: Expression }
);

/** Whether a statement is `while true`, with or without parentheses. */
function isWhileTrue(
  statement: Statement,
): statement is Extract<Statement, { kind: "whileStatement" }> {
  if (statement.kind !== "whileStatement") return false;
  const condition = unwrap(statement.condition);
  return condition.kind === "booleanLiteral" && condition.value;
}

function unwrap(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

type IfStatement = Extract<Statement, { kind: "ifStatement" }>;
type SwitchStatement = Extract<Statement, { kind: "switchStatement" }>;
type LoopStatement = Extract<
  Statement,
  { kind: "whileStatement" | "repeatStatement" | "forStatement" }
>;

/** A list of statements to walk, what runs it, and whether it is of the file's top level. */
interface Work {
  readonly statements: readonly Statement[];
  readonly owner: Owner;
  readonly top: boolean;
}

/** What runs a list of statements: its function, block, or file, or one way through a statement. */
type Owner =
  | { readonly kind: "region" }
  | { readonly kind: "then" | "else"; readonly statement: IfStatement }
  | { readonly kind: "case"; readonly statement: SwitchStatement; readonly index: number }
  | { readonly kind: "default"; readonly statement: SwitchStatement }
  | { readonly kind: "body"; readonly statement: LoopStatement };

/**
 * Why a run of statements never runs, and what to do about it; `after` when it follows a statement that never
 * continues, rather than standing in a way that never runs.
 */
interface Reason {
  readonly because: string;
  readonly fix: string;
  readonly after: boolean;
}

/**
 * Finds each run of statements that never run in a file, and reports it once, on its first statement (V30 §30): with
 * TSV066 when that is an `exit`, else with TSV065. One problem gets one code, so a run is not reported where another
 * warning already says why it never runs: in a branch whose condition TSV046 reports as never taking it, or whose case
 * value or range it reports, and after a loop that TSV058 reports. Nor is the code of a function that no call which can
 * run reaches, or of a block that no code which can run creates.
 */
class UnreachableCode {
  public constructor(
    private readonly runs: (statement: Statement) => boolean | null,
    private readonly regionRuns: (statements: readonly Statement[]) => boolean | null,
    private readonly closed: ReadonlySet<Statement>,
    /** The file's TSV046 warnings, by start. */
    private readonly constantTests: readonly ConstantTest[],
    /** Whether something starts the file; else a warning on the file already says that its top level never runs. */
    private readonly started: boolean,
    private readonly diagnostics: Diagnostic[],
  ) {}

  public report(program: Program): void {
    const work: Work[] = [{ statements: program.statements, owner: { kind: "region" }, top: true }];
    for (let item = work.pop(); item !== undefined; item = work.pop()) {
      const { statements, owner, top } = item;
      // The last statement before, since the start of the list or a label, that can run, and that label.
      let previous: Statement | null = null;
      let label: Extract<Statement, { kind: "labelStatement" }> | null = null;
      let inRun = false;
      for (const statement of statements) {
        if (statement.kind === "labelStatement") {
          previous = null;
          label = statement;
          inRun = false;
          continue;
        }
        if (statement.kind === "functionDeclaration") {
          this.#region(statement.body, work);
          continue;
        }
        const runs = this.runs(statement);
        if (runs === null) continue;
        if (runs) {
          previous = statement;
          label = null;
          inRun = false;
          for (const [list, way] of ownedLists(statement))
            work.push({ statements: list, owner: way, top });
          for (const block of createdBlocks(statement)) this.#region(block, work);
          continue;
        }
        if (inRun || (top && !this.started)) continue;
        inRun = true;
        const reason =
          previous !== null
            ? this.#afterReason(previous)
            : label !== null
              ? {
                  // A file starts at its top, so only the code before a label or a goto leads to it (V30 §26).
                  because: `no goto leads to label '${label.name.name}' on line ${label.span.start.line + 1}, and the code before it never continues there`,
                  fix: "Remove it, or add a goto to the label.",
                  after: false,
                }
              : this.#branchReason(owner);
        if (reason === null) continue;
        this.diagnostics.push(
          statement.kind === "exitStatement"
            ? createDiagnostic(
                DiagnosticSeverity.Warning,
                "TSV066",
                `This exit never runs, because ${reason.because}. ${reason.after ? "Remove it, or move it to where the session should finish." : reason.fix}`,
                statement.span,
              )
            : createDiagnostic(
                DiagnosticSeverity.Warning,
                "TSV065",
                `This code never runs, because ${reason.because}. ${reason.fix}`,
                statement.span,
              ),
        );
      }
    }
  }

  /** Walks the statements of a function or block, unless nothing that can run reaches it. */
  #region(block: Block, work: Work[]): void {
    if (this.regionRuns(block.statements) !== false)
      work.push({ statements: block.statements, owner: { kind: "region" }, top: false });
  }

  /** Why the statements after `previous`, which can run but never continues, never run. */
  #afterReason(previous: Statement): Reason | null {
    // TSV058 already reports the loop that never ends.
    if (this.closed.has(previous)) return null;
    const line = previous.span.start.line + 1;
    const keyword = KEYWORDS[previous.kind];
    const leaving = LEAVES[previous.kind];
    if (keyword !== undefined && leaving !== undefined)
      return {
        because: `the '${keyword}' on line ${line} always ${leaving} first`,
        fix: `Remove it, or move it before the '${keyword}'.`,
        after: true,
      };
    if (keyword === undefined)
      return {
        because: `no way through line ${line} continues after it`,
        fix: "Remove it.",
        after: true,
      };
    return {
      because: `no way through the '${keyword}' on line ${line} continues after it`,
      fix:
        previous.kind === "ifStatement" || previous.kind === "switchStatement"
          ? `Remove it, or move it into the branch of the '${keyword}' that should run it.`
          : "Remove it, or add a 'break' where the loop should end.",
      after: true,
    };
  }

  /** Why the statements of a way through `owner` never run, or `null` when a TSV046 warning already says so. */
  #branchReason(owner: Owner): Reason | null {
    switch (owner.kind) {
      case "region":
        return null;
      case "then":
      case "else": {
        const condition = owner.statement.condition;
        if (this.#reportsAlways(condition, owner.kind === "else")) return null;
        return {
          because: `the condition on line ${condition.span.start.line + 1} is ${owner.kind === "then" ? "never true" : "always true"}`,
          fix: "Remove it, or change the condition.",
          after: false,
        };
      }
      case "case": {
        const switchCase = owner.statement.cases[owner.index]!;
        const values =
          switchCase.typeTest?.span ??
          createSourceSpan(switchCase.values[0]!.span.start, switchCase.values.at(-1)!.span.end);
        if (this.#hasConstantTest(values)) return null;
        return {
          because: `no value reaches the case on line ${values.start.line + 1}`,
          fix: "Remove it, or change the case.",
          after: false,
        };
      }
      case "default":
        return {
          because: `the cases of the 'switch' on line ${owner.statement.span.start.line + 1} take every value`,
          fix: "Remove the 'default', or change the cases.",
          after: false,
        };
      case "body": {
        const loop = owner.statement;
        if (
          loop.kind === "whileStatement"
            ? this.#reportsAlways(loop.condition, false)
            : this.#hasConstantTest(
                (loop.kind === "repeatStatement" ? loop.count : loop.iterable).span,
              )
        )
          return null;
        const line = loop.span.start.line + 1;
        if (loop.kind === "whileStatement")
          return {
            because: `the condition on line ${line} is never true`,
            fix: "Remove it, or change the condition.",
            after: false,
          };
        return {
          because: `the '${KEYWORDS[loop.kind]!}' on line ${line} runs its body no time`,
          fix:
            loop.kind === "repeatStatement"
              ? "Remove it, or change the count."
              : "Remove it, or change what the loop goes through.",
          after: false,
        };
      }
    }
  }

  /**
   * Whether TSV046 warnings say that `condition` is always `value`: one on the condition itself, or on parts that decide
   * it so, such as an operand of `and` that is always false, or every operand of `or`.
   */
  #reportsAlways(condition: Expression, value: boolean): boolean {
    // For each part of the condition, whether the warnings say it is always true, and always false; a part comes before
    // the parts in it, so the reverse order has each one after its parts, without native recursion.
    const parts: Expression[] = [];
    for (const work = [condition]; work.length > 0;) {
      const node = unwrap(work.pop()!);
      parts.push(node);
      if (node.kind === "unaryExpression" && node.operator === "not") work.push(node.operand);
      else if (
        node.kind === "binaryExpression" &&
        (node.operator === "and" || node.operator === "or")
      )
        work.push(node.left, node.right);
    }
    const always = new Map<Expression, readonly [boolean, boolean]>();
    const of = (part: Expression): readonly [boolean, boolean] =>
      always.get(unwrap(part)) ?? [false, false];
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const node = parts[index]!;
      const reported = this.#constantTestAt(node.span);
      let [isTrue, isFalse] = [reported === true, reported === false];
      if (node.kind === "unaryExpression" && node.operator === "not") {
        const [operandTrue, operandFalse] = of(node.operand);
        isTrue ||= operandFalse;
        isFalse ||= operandTrue;
      } else if (
        node.kind === "binaryExpression" &&
        (node.operator === "and" || node.operator === "or")
      ) {
        const [leftTrue, leftFalse] = of(node.left);
        const [rightTrue, rightFalse] = of(node.right);
        isTrue ||= node.operator === "or" ? leftTrue || rightTrue : leftTrue && rightTrue;
        isFalse ||= node.operator === "and" ? leftFalse || rightFalse : leftFalse && rightFalse;
      }
      always.set(node, [isTrue, isFalse]);
    }
    return of(condition)[value ? 0 : 1];
  }

  /** What the TSV046 warning on exactly `span` says its test always gives, or `undefined` without one. */
  #constantTestAt(span: SourceSpan): boolean | null | undefined {
    for (let index = this.#firstTestFrom(span); index < this.constantTests.length; index += 1) {
      const test = this.constantTests[index]!;
      if (test.span.start.offset !== span.start.offset) break;
      if (test.span.end.offset === span.end.offset) return test.value;
    }
    return undefined;
  }

  /** Whether a TSV046 warning stands inside `span`: expressions nest, so the first one that starts in it lies in it. */
  #hasConstantTest(span: SourceSpan): boolean {
    const test = this.constantTests[this.#firstTestFrom(span)];
    return test !== undefined && test.span.start.offset < span.end.offset;
  }

  /** The index of the first TSV046 warning that starts at `span` or after it. */
  #firstTestFrom(span: SourceSpan): number {
    const tests = this.constantTests;
    let low = 0;
    let high = tests.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tests[middle]!.span.start.offset < span.start.offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/** The keyword that starts a statement, for a message that names it. */
const KEYWORDS: Partial<Record<Statement["kind"], string>> = {
  exitStatement: "exit",
  endStatement: "end",
  gotoStatement: "goto",
  returnStatement: "return",
  breakStatement: "break",
  continueStatement: "continue",
  ifStatement: "if",
  switchStatement: "switch",
  whileStatement: "while",
  repeatStatement: "repeat",
  forStatement: "for",
};

/** What a statement that never continues does instead. */
const LEAVES: Partial<Record<Statement["kind"], string>> = {
  exitStatement: "ends the session",
  endStatement: "ends the file",
  gotoStatement: "jumps away",
  returnStatement: "leaves the function",
  breakStatement: "leaves the loop",
  continueStatement: "starts the next round of the loop",
};

/** The lists of statements that run as part of a statement, each with the way through it that runs it. */
function ownedLists(statement: Statement): readonly (readonly [readonly Statement[], Owner])[] {
  switch (statement.kind) {
    case "ifStatement": {
      const { elseBlock } = statement;
      const lists: (readonly [readonly Statement[], Owner])[] = [
        [statement.thenBlock.statements, { kind: "then", statement }],
      ];
      if (elseBlock !== null)
        lists.push([
          elseBlock.kind === "ifStatement" ? [elseBlock] : elseBlock.statements,
          { kind: "else", statement },
        ]);
      return lists;
    }
    case "switchStatement": {
      const lists: (readonly [readonly Statement[], Owner])[] = statement.cases.map(
        (switchCase, index) => [switchCase.body.statements, { kind: "case", statement, index }],
      );
      if (statement.defaultBlock !== null)
        lists.push([statement.defaultBlock.statements, { kind: "default", statement }]);
      return lists;
    }
    case "whileStatement":
    case "repeatStatement":
    case "forStatement":
      return [[statement.body.statements, { kind: "body", statement }]];
    default: {
      const nested = nestedStatements(statement);
      return nested.length === 0 ? [] : [[nested, { kind: "region" }]];
    }
  }
}

/** The timer, media, and button blocks that a statement creates itself, also in its expressions. */
function createdBlocks(statement: Statement): readonly Block[] {
  const blocks = [...handlerBlocks(statement)];
  const work = [...statementExpressions(statement)];
  for (let expression = work.pop(); expression !== undefined; expression = work.pop()) {
    for (const block of handlerBlocks(expression)) blocks.push(block);
    for (const part of expressionParts(expression)) work.push(part);
  }
  return blocks;
}
