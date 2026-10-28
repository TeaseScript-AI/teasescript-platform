import type { Block, Statement, SwitchStatement } from "../../ast.js";
import { joinParts, keptParts, type WorkLedger } from "./budget.js";
import type { FlowLoop, FlowNode, GuardUse } from "./flow-graph.js";
import { Laminar } from "./narrowing.js";
import { each, some, sorted, steps } from "./narrowing-iteration.js";
import type { CoreProgram } from "./program.js";

/*
 * The statements of a program as N3's corridor composes them (checkpoint 9, TABLE §13 N3, §13.3): per callable body (a
 * file's top level, a function's body, a block's body) its statements in order, each with the blocks of its live
 * alternatives (an `if`'s arms or the way past it, a `switch`'s cases and its `default` or the way past them, a loop's
 * body beside its skip edge where the graph keeps one), and the **shared, key-independent layer** of closed
 * statements, computed once bottom-up: a statement that always leaves, closed for every key; a statement whose
 * compulsory evaluation holds a live call site (one that dominates where its own expressions end), closed for a key
 * with an owner outside its activation (X6's owner predicate); and a branch or loop whose every live alternative is
 * closed by those alone, in either applicability. Per block, the indexes of its closed statements are sorted, so a
 * segment of a block is one binary search per layer. X7's events are the flat veto they are and stay out of the
 * layer; kills and blocking tests are each key's (`narrowing-routes.ts`).
 */

/** A statement of the tree: where it stands, its alternatives, and whether the shared layer closes it. */
export interface TreeStatement {
  readonly statement: Statement;
  readonly file: number;
  readonly start: number;
  readonly end: number;
  readonly block: TreeBlock;
  readonly index: number;
  /** The blocks of its alternatives: an `if`'s arms, a `switch`'s cases and default, a loop's body. */
  readonly arms: TreeBlock[];
  /** A loop's skip edge where the graph keeps it: the way past the body is live. */
  skip: boolean;
  /** A loop its header leaves (not only a `break`): a round's end reaches the code after it. */
  exits: boolean;
  /** Its own compulsory evaluation holds a live call site (outside block code). */
  called: boolean;
  /** Closed for every key: it always leaves, or every live alternative is. */
  leaves: boolean;
  /** Closed for a key with an outside owner: `leaves`, `called`, or every live alternative is so closed. */
  calls: boolean;
  /** A loop's header: the node where its condition, count or iterable is evaluated (`null` otherwise). */
  readonly loop: FlowLoop | null;
  /** Its live alternatives, and how many of them the shared layer closes, in either applicability. */
  liveArms: number;
  readonly sharedArms: { leaves: number; calls: number };
}

/** A block of statements: a callable's body (`owner` null) or an alternative of a compound statement. */
export interface TreeBlock {
  readonly id: number;
  readonly owner: TreeStatement | null;
  readonly statements: TreeStatement[];
  /** The alternative's entry (a branch node, a loop's body), or `null` for a callable's body. */
  readonly entry: FlowNode | null;
  /** Where its last statement ends (its owner's start when it has none); a callable's body never ends. */
  end: number;
  /** Whether its entry is live (a callable's body is). */
  readonly live: boolean;
  /** The indexes of its statements the shared layer closes for every key, and for a key with an outside owner. */
  readonly leaves: number[];
  readonly calls: number[];
}

const LEAVING: ReadonlySet<Statement["kind"]> = new Set([
  "returnStatement",
  "exitStatement",
  "breakStatement",
  "continueStatement",
  "gotoStatement",
  "endStatement",
]);

/** How many of the sorted indexes lie in [low, high): two binary searches, each comparison charged. */
export function countIn(
  work: WorkLedger,
  sorted: readonly number[],
  low: number,
  high: number,
): number {
  work.charge("eventSteps");
  if (low >= high || sorted.length === 0) return 0;
  return lowerBound(work, sorted, high) - lowerBound(work, sorted, low);
}

/** The index of the first of the sorted numbers at least `target`: a binary search, each comparison charged. */
export function lowerBound(work: WorkLedger, sorted: readonly number[], target: number): number {
  work.charge("eventSteps");
  let low = 0;
  let high = sorted.length;
  for (const _ of steps(work, "eventSteps", () => low < high)) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export class StatementTree {
  readonly blocks: TreeBlock[] = [];
  /** Per file, its statements by their spans: the innermost one holding an offset. */
  readonly #byFile = new Map<number, Laminar<TreeStatement>>();
  /** Each `switch` statement by its subject's span (N1's cases). */
  readonly #switches = new Map<string, SwitchStatement>();
  /** Each alternative by its entry. */
  readonly #arms = new Map<FlowNode, TreeBlock>();
  /** Each callable's body by its region. */
  readonly #roots = new Map<number, TreeBlock>();
  /** The live call sites' call-ins outside block code by their dominator intervals (the nearest one dominating a node). */
  readonly #calls: Laminar<FlowNode>;
  /** Where their calls end, by file, sorted (an operand region's calls, N2: a call enters after its arguments). */
  readonly callTexts = new Map<number, number[]>();

  public constructor(readonly program: CoreProgram) {
    program.work.charge("indexSteps");
    const work = program.work;
    const flow = program.flow;
    const uses = new Map<string, GuardUse>();
    for (const conditions of each(work, "indexSteps", [flow.conditionUses, flow.switchUses]))
      for (const use of each(work, "indexSteps", conditions))
        uses.set(keptParts(work, use.file, use.span.start.offset, use.span.end.offset), use);
    const loops = new Map<Statement, FlowLoop>();
    for (const loop of each(work, "indexSteps", flow.loops)) loops.set(loop.statement, loop);
    const order: TreeStatement[] = [];
    const byFile = new Map<number, { start: number; end: number; item: TreeStatement }[]>();
    const pending: {
      readonly into: TreeBlock;
      readonly file: number;
      readonly statements: readonly Statement[];
    }[] = [];
    const block = (
      owner: TreeStatement | null,
      entry: FlowNode | null,
      statements: readonly Statement[],
      file = owner?.file ?? -1,
    ): TreeBlock => {
      work.charge("indexSteps");
      const made: TreeBlock = {
        id: this.blocks.length,
        owner,
        statements: [],
        entry,
        end: owner === null ? Infinity : owner.start,
        live: entry === null || program.live(entry),
        leaves: [],
        calls: [],
      };
      this.blocks.push(made);
      if (entry !== null) this.#arms.set(entry, made);
      pending.push({ into: made, file, statements });
      return made;
    };
    for (const region of each(work, "indexSteps", flow.regions)) {
      if (region.kind === "file")
        this.#roots.set(
          region.id,
          block(null, null, flow.files[region.file]!.program.statements, region.file),
        );
      else if (region.kind === "function")
        this.#roots.set(
          region.id,
          block(null, null, region.declaration.body.statements, region.file),
        );
      else if (region.kind === "handler")
        this.#roots.set(region.id, block(null, null, region.block.statements, region.file));
    }
    const useOf = (
      file: number,
      span: {
        readonly start: { readonly offset: number };
        readonly end: { readonly offset: number };
      },
    ) => {
      work.charge("indexSteps");
      return uses.get(joinParts(file, span.start.offset, span.end.offset));
    };
    for (const _ of steps(work, "indexSteps", () => pending.length > 0)) {
      const { into, file, statements } = pending.pop()!;
      for (const statement of each(work, "indexSteps", statements)) {
        // a function's body is a callable of its own
        if (statement.kind === "functionDeclaration") continue;
        const loop = loops.get(statement) ?? null;
        const made: TreeStatement = {
          statement,
          file,
          start: statement.span.start.offset,
          end: statement.span.end.offset,
          block: into,
          index: into.statements.length,
          arms: [],
          skip: false,
          exits: false,
          called: false,
          leaves: LEAVING.has(statement.kind),
          calls: LEAVING.has(statement.kind),
          loop,
          liveArms: 0,
          sharedArms: { leaves: 0, calls: 0 },
        };
        into.statements.push(made);
        if (into.owner !== null) into.end = made.end;
        order.push(made);
        const list = byFile.get(file);
        const entry = { start: made.start, end: made.end, item: made };
        if (list === undefined) byFile.set(file, [entry]);
        else list.push(entry);
        switch (statement.kind) {
          case "ifStatement": {
            const branches = useOf(file, statement.condition.span)?.branches ?? [];
            made.arms.push(block(made, branches[0] ?? null, statement.thenBlock.statements));
            const otherwise = statement.elseBlock;
            made.arms.push(
              block(
                made,
                branches[1] ?? null,
                otherwise === null
                  ? []
                  : otherwise.kind === "ifStatement"
                    ? [otherwise]
                    : otherwise.statements,
              ),
            );
            break;
          }
          case "switchStatement": {
            this.#switches.set(
              keptParts(
                work,
                file,
                statement.subject.span.start.offset,
                statement.subject.span.end.offset,
              ),
              statement,
            );
            const branches = useOf(file, statement.subject.span)?.branches ?? [];
            for (const [index, switchCase] of each(work, "indexSteps", statement.cases.entries()))
              made.arms.push(block(made, branches[index] ?? null, switchCase.body.statements));
            const fallback: Block | null = statement.defaultBlock;
            made.arms.push(
              block(made, branches[statement.cases.length] ?? null, fallback?.statements ?? []),
            );
            break;
          }
          case "whileStatement":
          case "repeatStatement":
          case "forStatement":
            made.arms.push(block(made, loop?.body ?? null, statement.body.statements));
            made.skip =
              loop !== null &&
              program.live(loop.exit) &&
              !(program.reached(loop.body) && program.dom.dominates(loop.body, loop.exit));
            made.exits =
              loop !== null &&
              some(
                work,
                "indexSteps",
                loop.exit.predecessors,
                (before) =>
                  program.live(before) &&
                  !flow.isDeadEdge(before, loop.exit) &&
                  before.statement?.kind !== "breakStatement",
              );
            break;
          default:
            break;
        }
      }
    }
    for (const [file, list] of each(work, "indexSteps", byFile))
      this.#byFile.set(file, new Laminar(work, list));
    // a live call site outside block code whose call-in every route through its statement's own expressions passes
    const calls: { start: number; end: number; item: FlowNode }[] = [];
    for (const site of each(work, "indexSteps", flow.sites)) {
      const at = site.callIn;
      if (!program.live(at) || program.inBlockCode(at) || at.span === null) continue;
      calls.push({ start: program.position(at), end: program.positionEnd(at), item: at });
      const offsets = this.callTexts.get(at.file);
      if (offsets === undefined) this.callTexts.set(at.file, [at.span.end.offset]);
      else offsets.push(at.span.end.offset);
      const statement = this.statementAt(at.file, at.span.start.offset);
      const done = statement === null ? null : this.#evaluated(statement);
      if (statement !== null && done !== null && program.dom.dominates(at, done))
        statement.called = true;
    }
    // bottom-up: a statement after its alternatives' statements (they were made after it), each block counting its
    // closed statements as they are decided
    const closedIn = new Map<TreeBlock, { leaves: number; calls: number }>();
    let index = order.length;
    for (const _ of steps(work, "indexSteps", () => index > 0)) {
      index -= 1;
      const made = order[index]!;
      if (made.called) made.calls = true;
      for (const arm of each(work, "indexSteps", made.arms)) {
        if (!arm.live) continue;
        made.liveArms += 1;
        const closed = closedIn.get(arm);
        if ((closed?.leaves ?? 0) > 0) made.sharedArms.leaves += 1;
        if ((closed?.calls ?? 0) > 0) made.sharedArms.calls += 1;
      }
      if (made.arms.length > 0 && !made.leaves && !made.skip) {
        if (made.sharedArms.leaves === made.liveArms) made.leaves = made.calls = true;
        else if (made.sharedArms.calls === made.liveArms) made.calls = true;
      }
      let counts = closedIn.get(made.block);
      if (counts === undefined) closedIn.set(made.block, (counts = { leaves: 0, calls: 0 }));
      if (made.leaves) counts.leaves += 1;
      if (made.calls) counts.calls += 1;
    }
    this.#calls = new Laminar(work, calls);
    for (const offsets of each(work, "indexSteps", this.callTexts.values()))
      sorted(work, "indexSteps", offsets, (a, b) => a - b);
    for (const made of each(work, "indexSteps", this.blocks))
      for (const statement of each(work, "indexSteps", made.statements)) {
        if (statement.leaves) made.leaves.push(statement.index);
        if (statement.calls) made.calls.push(statement.index);
      }
  }

  /** Where every route through a statement's own expressions has evaluated them (the statement's node, a header's). */
  #evaluated(made: TreeStatement): FlowNode | null {
    this.program.work.charge("indexSteps");
    const program = this.program;
    const statement = made.statement;
    const site = (span: {
      readonly start: { readonly offset: number };
      readonly end: { readonly offset: number };
    }) => {
      program.work.charge("indexSteps");
      return program.exprAt({ file: made.file, start: span.start.offset, end: span.end.offset });
    };
    switch (statement.kind) {
      case "ifStatement":
      case "whileStatement":
        return site(statement.condition.span);
      case "switchStatement":
        return site(statement.subject.span);
      case "repeatStatement":
        return site(statement.count.span);
      case "forStatement":
        return site(statement.iterable.span);
      case "globalStatement":
        return statement.assignment === null
          ? null
          : (program.flow.statementAt({
              file: made.file,
              start: statement.assignment.span.start.offset,
              end: statement.assignment.span.end.offset,
            }) ?? null);
      default:
        return (
          program.flow.statementAt({ file: made.file, start: made.start, end: made.end }) ?? null
        );
    }
  }

  /** The innermost statement of `file` holding `offset`, or `null`. */
  public statementAt(file: number, offset: number): TreeStatement | null {
    this.program.work.charge("eventSteps");
    return this.#byFile.get(file)?.innermost(offset) ?? null;
  }

  /** The alternative a node enters, if it is one's entry. */
  public armAt(node: FlowNode): TreeBlock | undefined {
    this.program.work.charge("eventSteps");
    return this.#arms.get(node);
  }

  /** A callable's body (a file, a function or a block) by its region. */
  public root(region: number): TreeBlock | undefined {
    this.program.work.charge("eventSteps");
    return this.#roots.get(region);
  }

  /** The nearest live call site's call-in outside block code that dominates a node, or `null`. */
  public nearestCall(node: FlowNode): FlowNode | null {
    this.program.work.charge("eventSteps");
    return this.program.reached(node) ? this.#calls.innermost(this.program.position(node)) : null;
  }

  /** The `switch` statement whose subject has this span. */
  public switchAt(file: number, start: number, end: number): SwitchStatement | undefined {
    this.program.work.charge("indexSteps");
    return this.#switches.get(joinParts(file, start, end));
  }
}
