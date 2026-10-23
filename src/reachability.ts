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
import { solveForward } from "./plan/dataflow.js";
import type { InstructionPlan } from "./plan/model.js";
import { planLocationToSourceSpan } from "./plan/source-location.js";
import { runsOnItsOwn } from "./project-globals.js";
import { CORE_RUNTIME_BUILTINS } from "./language-facts.js";
import { createSourceSpan, type SourceSpan } from "./source.js";
import type { DeadWays } from "./way-facts.js";

/*
 * Which code can run, from the compiled plan: the ways of `plan/control-flow.ts` that the type check does not rule out
 * (`DeadWays`), solved with `plan/dataflow.ts`. Code can run in a file's top level, from its start; in a function where
 * a call that can run reaches it; and in a timer, media, or button block where code that can run creates it (ADR 0022
 * §3.4). A call counts as returning, also of a function that never returns, so the ending after it is still written out
 * (ADR 0022 §4.3). The checks that follow it: the endings of files and of the session (TSV052, TSV053), an `end` with
 * no file call to return to (TSV070, TSV071), loops with no way out (TSV058), code that never runs (TSV065, TSV066),
 * and the flow of statements that the check of variables at labels follows (TSV054).
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
    for (const { edge, target } of this.#flow.successors(index))
      if (target !== null && this.ways.possible(index, edge.kind))
        out.push({ node: target, edge: edge.kind });
    const instruction = this.plan.instructions[index]!;
    if (instruction.kind === "loopControl" && instruction.action === "continue") {
      const start = this.#flow.loopStart(instruction.loopId);
      const loop = start === undefined ? undefined : this.plan.instructions[start];
      if (start !== undefined && loop?.kind === "loopStart" && this.ways.runsOnce(start))
        out.push({ node: loop.target, edge: "exhausted" });
    }
    for (const handler of this.#flow.handlersOf(index)) {
      const definition = this.#flow.functionById(handler);
      if (definition !== undefined)
        out.push({ node: definition.entryInstruction, edge: "handler" });
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
   * An `end` returns to the file that called the running one (V30 §30). The ways from the start of the session follow
   * which file calls are waiting: a `call` makes one wait, and a `goto` keeps those that wait. An `end` that a way
   * reaches with none waiting is an error (TSV070), also when another way reaches it through a call. Where only a way
   * the compiler cannot follow leads there with none waiting, it is a warning (TSV071), and the `end` fails if that
   * happens: a computed target, which may start a file that `targets` gives, the files its `picks` give for a tagged
   * pick, by instruction, else those that any reference in the project may name, `referenced`, where `null` is every
   * file; and a timer, media, or button block, which runs later, while the file that started it or a file it called
   * runs, or after it. The `end` that closes a file's top level is the ending check's (TSV052).
   */
  public pendingCallDiagnostics(
    targets: () => {
      readonly picks: ReadonlyMap<number, readonly number[]>;
      readonly referenced: readonly number[] | null;
    },
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
    const { picks, referenced } = targets();
    const ways = this.#computedWays(picks, referenced);
    const states = solveForward<CallsWaiting, string>(
      {
        nodeCount: count + ways.hubs.length,
        successors: (node) => {
          if (node >= count)
            return ways.hubs[node - count]!.map((entry) => ({ node: entry, edge: "hub" }));
          const out = this.#successors(node);
          const computed = ways.targets.get(node);
          if (computed !== undefined) out.push(computed);
          return out;
        },
        join: (left, right) => ({
          none: left.none ?? right.none,
          hidden: left.hidden ?? right.hidden,
        }),
        equals: (left, right) => left.none === right.none && left.hidden === right.hidden,
        transfer: (node, edge, state) => {
          const waitsForNone = state.none !== null || state.hidden !== null;
          // A block runs later: a non-persistent timer's or button's while the file that started it, or one it called,
          // runs, so with the calls that wait there; a persistent one's or a media block also after that file ended.
          if (edge === "handler")
            return waitsForNone || this.#outlivesItsFile(node)
              ? { none: null, hidden: node }
              : state;
          const instruction = this.plan.instructions[node];
          if (instruction?.kind !== "transfer" || (edge !== "transfer" && edge !== "computed"))
            return state;
          if (instruction.mode === "call") return { none: null, hidden: null };
          // A goto keeps the calls that wait; with none, the file it starts has none either.
          if (edge === "transfer")
            return { none: state.none === null ? null : node, hidden: state.hidden };
          return { none: null, hidden: waitsForNone ? node : null };
        },
      },
      [[this.plan.files[0]!.startInstruction, { none: SESSION_START, hidden: null }]],
    );
    for (let index = 0; index < count; index += 1) {
      const state = states[index];
      const instruction = this.plan.instructions[index]!;
      if (state === null || state === undefined || instruction.kind !== "end" || closing.has(index))
        continue;
      if (state.none === null && state.hidden === null) continue;
      const file = this.#flow.fileOf(index);
      const fix = "use exit or goto here instead of end";
      diagnostics[file]!.push(
        createDiagnostic(
          state.none !== null ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
          state.none !== null ? "TSV070" : "TSV071",
          state.none === SESSION_START
            ? "No call waits for this end, because the session starts in main.tease without one, so there is nothing to return to. Use exit to finish the session, or goto to continue in another file."
            : state.none !== null
              ? `No call waits for this end when the goto on ${this.#where(state.none, file)} leads here, so there is nothing to return to. Write call there to come back after it, or ${fix}.`
              : this.plan.instructions[state.hidden!]!.kind === "transfer"
                ? `The goto on ${this.#where(state.hidden!, file)} picks its file when it runs, so the compiler cannot tell whether a call waits for this end then. Without one, the end fails. If that goto can lead here, write call there to come back after it, or ${fix}.`
                : `The block that ${this.#where(state.hidden!, file)} starts runs later, so the compiler cannot tell whether a call waits for this end when it runs. Without one, the end fails. If the block can run while no file call waits, ${fix}.`,
          planLocationToSourceSpan(instruction.span),
        ),
      );
    }
    return diagnostics;
  }

  /**
   * The way of each computed target for the check of waiting calls (see {@link pendingCallDiagnostics}). A
   * `script(...)` of a path written out names its file, which the check follows like a file target. Any other target
   * leads to a node of its own after the instructions, a hub, with a way into each file it may start: those of its
   * tagged pick, or those any reference may name. Targets that may start the same files share one, by the list of files
   * `picks` shares, so the ways grow with the files, not with the targets times the files.
   */
  #computedWays(
    picks: ReadonlyMap<number, readonly number[]>,
    referenced: readonly number[] | null,
  ): {
    readonly targets: ReadonlyMap<number, { readonly node: number; readonly edge: string }>;
    readonly hubs: readonly (readonly number[])[];
  } {
    const count = this.plan.instructions.length;
    const files = new Map(this.plan.files.map((file, index) => [file.path, index]));
    const targets = new Map<number, { readonly node: number; readonly edge: string }>();
    const hubs: (readonly number[])[] = [];
    // By the list of files, which `picks` shares; `null` for the files any other reference may name.
    const hubOf = new Map<readonly number[] | null, number>();
    const hub = (picked: readonly number[] | null): number => {
      let node = hubOf.get(picked);
      if (node === undefined) {
        node = count + hubs.length;
        hubs.push(
          (picked ?? referenced ?? this.plan.files.map((_, file) => file)).map(
            (file) => this.plan.files[file]!.entryInstruction,
          ),
        );
        hubOf.set(picked, node);
      }
      return node;
    };
    this.plan.instructions.forEach((instruction, index) => {
      if (instruction.kind !== "transfer" || !("value" in instruction.destination)) return;
      const value = instruction.destination.value;
      const path =
        value.kind === "call" &&
        value.callee.kind === "identifier" &&
        value.callee.name === "script" &&
        value.arguments.length === 1 &&
        value.arguments[0]!.value.kind === "literal"
          ? value.arguments[0]!.value.value
          : undefined;
      if (path !== undefined) {
        const file = typeof path === "string" ? files.get(path) : undefined;
        if (file !== undefined)
          targets.set(index, { node: this.plan.files[file]!.entryInstruction, edge: "transfer" });
        return;
      }
      const node = hub((value.kind === "tagQuery" ? picks.get(index) : undefined) ?? null);
      targets.set(index, { node, edge: "computed" });
    });
    return { targets, hubs };
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
    return file === from ? line : `${line} of ${this.plan.files[file]!.path}`;
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
   * each file, which may already report why a branch never runs.
   */
  public warnings(constantTests: readonly (readonly ConstantTest[])[]): Diagnostic[][] {
    const { diagnostics, closed } = this.#closedLoops();
    this.programs.forEach((program, file) =>
      new UnreachableCode(
        (statement) => this.#runs(statement),
        (statements) => this.#regionRuns(statements),
        closed,
        [...(constantTests[file] ?? [])].sort(
          (left, right) => left.span.start.offset - right.span.start.offset,
        ),
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
 * without a call, or `SESSION_START`, and `hidden` one by the computed `goto` that may have done so. Both `null`: every
 * way there has a call waiting. The first way found names each.
 */
interface CallsWaiting {
  readonly none: number | null;
  readonly hidden: number | null;
}

/** The start of the session, which runs `main.tease` with no call waiting. */
const SESSION_START = -1;

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
    private readonly diagnostics: Diagnostic[],
  ) {}

  public report(program: Program): void {
    const work: { readonly statements: readonly Statement[]; readonly owner: Owner }[] = [
      { statements: program.statements, owner: { kind: "region" } },
    ];
    for (let item = work.pop(); item !== undefined; item = work.pop()) {
      const { statements, owner } = item;
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
            work.push({ statements: list, owner: way });
          for (const block of createdBlocks(statement)) this.#region(block, work);
          continue;
        }
        if (inRun) continue;
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
  #region(
    block: Block,
    work: { readonly statements: readonly Statement[]; readonly owner: Owner }[],
  ): void {
    if (this.regionRuns(block.statements) !== false)
      work.push({ statements: block.statements, owner: { kind: "region" } });
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
