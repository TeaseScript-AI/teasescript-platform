/*
 * The route rule's condition tests (`NarrowingRoutes`, routes.ts): the closed set of tests the tested-producer rule
 * reads (`checked`), arm feasibility by entry narrowing and the program default (`holdsInfeasible`), and where a
 * node's statement stands in the statement tree (`chainOf`).
 */
import type { Expression } from "../../../ast.js";
import type { SourceSite } from "../../graph.js";
import type { CorePass } from "../answers.js";
import { joinParts, keepText, type WorkLedger } from "../budget.js";
import type { FlowNode } from "../flow-graph.js";
import { REASON, type ItemTag } from "../items.js";
import type { Work } from "../solver.js";
import { each, some, sorted, steps } from "../charged-iteration.js";
import {
  locationOf,
  peel,
  removes,
  stablePath,
  testForms,
  type NarrowingForm,
  type NarrowingIndex,
} from "./narrowings.js";
import {
  countIn,
  lowerBound,
  type StatementTree,
  type TreeBlock,
  type TreeStatement,
} from "./statement-tree.js";

/** Where a statement stands: its block and index, from a callable's body down (a definition before the body: -1). */
export interface Place {
  readonly block: TreeBlock;
  readonly index: number;
}

/** How far a condition's part's truth or falsity guards: an offset, and whether to the arms (`#conditionFacts`). */
interface Guarding {
  readonly to: number;
  /** Whether it reaches the statement's `then` arm or loop body (`then`), its `else` arm or way past (`else`). */
  readonly arm: "then" | "else" | null;
}

/**
 * A condition's test as a fact (`RouteTests.#conditionFacts`): the tested text, the form it proves, and where it
 * guards: within the condition from the test's end up to `to`, and the `then` arm (or a loop's body) or the `else` arm
 * (or the way past).
 */
interface ConditionFact {
  readonly text: string;
  /** The tested read's refined location (N1's), where it is a stable path. */
  readonly location: string | null;
  readonly form: NarrowingForm;
  readonly from: number;
  readonly to: number;
  /** It guards the `then` arm or a loop's body (the condition's truth). */
  readonly holding: boolean;
  /** It guards the `else` arm or the way past (the condition's falsity). */
  readonly otherwise: boolean;
}

/** An `if`'s or a `while`'s condition's facts, in walk order and by tested text. */
interface ConditionFacts {
  readonly list: readonly ConditionFact[];
  readonly byText: ReadonlyMap<string, readonly ConditionFact[]>;
}

/**
 * A text's tests of one offending kind (`RouteTests.#tests`): the arms a condition's test of the needed form
 * guards from their start, and per block the indexes (sorted) of its statements every route past which passed one.
 */
interface TextTests {
  readonly entered: Set<TreeBlock>;
  readonly passed: Map<number, number[]>;
}

/** The statements that leave the code after them for good on every route through them (`RouteTests.#ends`). */
const ENDING: ReadonlySet<string> = new Set([
  "returnStatement",
  "exitStatement",
  "endStatement",
  "gotoStatement",
  "breakStatement",
  "continueStatement",
]);

/** The tree's blocks that end on every route through them, and per block its labels' indexes (`#ends`). */
interface Endings {
  readonly ending: Set<TreeBlock>;
  readonly labels: Map<number, number[]>;
}

/** An `if` arm's feasibility for the route rule's default (`RouteTests.#infeasible`). */
type ArmFeasibility = "feasible" | "infeasible" | "unavailable";

/** A condition's own guards of a text and kind (`#ownGuarded`): their starts sorted, and the furthest end by each. */
interface OwnGuards {
  readonly from: readonly number[];
  readonly reach: readonly number[];
}

/** The route rule's condition tests of one pass, each built on its first query; `NarrowingRoutes` extends it. */
export class RouteTests {
  /** Per tested text, the `if`s and `while`s whose conditions test it (`#testing`), made on the first query. */
  #tested: Map<string, TreeStatement[]> | null = null;
  /** Per (text, offending kind), its tests (`#tests`). */
  readonly #textTests = new Map<string, TextTests>();
  /** Per `if` or `while`, its condition's own guards by (text, offending kind) (`#ownGuarded`). */
  readonly #own = new Map<TreeStatement, Map<string, OwnGuards>>();
  /** The blocks that end and the labels (`#ends`), made on the first query. */
  #endings: Endings | null = null;
  /** The program's `if`s whose conditions hold a test (`#testing`). */
  readonly #ifs: TreeStatement[] = [];
  /** Whether the program holds an `if` arm infeasible or unavailable (`holdsInfeasible`), made on the first query. */
  #holds: boolean | null = null;
  /** Per arm, its feasibility: infeasible, unavailable evidence, or feasible (`#infeasible`). */
  readonly #infeasibleArms = new Map<TreeBlock, ArmFeasibility>();
  /** Per `if` or `while`, its condition's tests as facts (`#conditionFacts`). */
  readonly #conditions = new Map<TreeStatement, ConditionFacts | null>();
  /** The program's ledger. */
  readonly #work: WorkLedger;

  public constructor(
    readonly pass: CorePass,
    readonly index: NarrowingIndex,
    readonly tree: StatementTree,
  ) {
    pass.program.work.charge("indexSteps");
    this.#work = pass.program.work;
  }

  /**
   * The tested-producer rule's one decision (V30 §13, the `call` warning; AD-1's "unless a check stands"): whether a
   * check that removes `tag` from the text `text` stands, after `from`, on every route to the use at `node`. It holds
   * only by the closed set of forms below; any other test form, arm, loop or way out counts as no check, and the route
   * rule's error stands:
   * - a test is N1's form (`testForms`) under `and`, `or`, `not` and parentheses (`#conditionFacts`);
   * - the use is in an arm such a test guards from its start: an `if`'s `then` arm by its truth or its `else` arm by its
   *   falsity, a `while`'s body by its truth;
   * - or it is in the test's own condition after it, where its truth (an `and`) or its falsity (an `or`) guards it;
   * - or it is after a statement of its block every route past which passed such a test, with no label between them
   *   (`#tests`).
   */
  protected checked(node: FlowNode, text: string, tag: ItemTag, from: number): boolean {
    this.#work.charge("exactQueries");
    const work = this.#work;
    const chain = this.chainOf(node);
    if (chain === null || node.span === null) return false;
    const use = node.span.start.offset;
    const tests = this.#tests(text, tag);
    const labels = this.#ends().labels;
    for (const place of each(work, "exactQueries", chain)) {
      const owner = place.block.owner;
      if (owner !== null && owner.start > from && tests.entered.has(place.block)) return true;
      if (place.index < 0) continue;
      const statement = place.block.statements[place.index]!;
      if (statement.start > from && this.#ownGuarded(statement, text, tag, use)) return true;
      const passed = tests.passed.get(place.block.id);
      if (passed === undefined) continue;
      // (a route may enter the block at a label: only a statement after the last label before the use counts)
      const marks = labels.get(place.block.id) ?? [];
      const label = lowerBound(work, marks, place.index) - 1;
      const after = this.#firstAfter(place.block, from);
      const low = label >= 0 && marks[label]! + 1 > after ? marks[label]! + 1 : after;
      if (countIn(work, passed, low, place.index) > 0) return true;
    }
    return false;
  }

  /** The index of a block's first statement that starts after `from`: a binary search, each comparison charged. */
  #firstAfter(block: TreeBlock, from: number): number {
    this.#work.charge("exactQueries");
    let low = 0;
    let high = block.statements.length;
    for (const _ of steps(this.#work, "exactQueries", () => low < high)) {
      const middle = (low + high) >> 1;
      if (block.statements[middle]!.start <= from) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /**
   * A text's tests of one offending kind, built once: the arms a test of the needed form guards from their start, and
   * the statements every route past which passed one: an `if` whose every live arm is guarded so, holds such a
   * statement, or ends (`#ends`), with one arm not ending; a `while` whose falsity proves it and that no `break` leaves;
   * and so on up through each `if` holding one. A loop or a `switch` holding one is not (a `break` or a `continue` may
   * leave the body before it, and a loop's body may not run).
   */
  #tests(text: string, tag: ItemTag): TextTests {
    this.#work.charge("indexSteps");
    const memo = joinParts(text, tag);
    const known = this.#textTests.get(memo);
    if (known !== undefined) return known;
    const work = this.#work;
    const ending = this.#ends().ending;
    const entered = new Set<TreeBlock>();
    const holding = new Set<TreeBlock>();
    const passed = new Map<number, number[]>();
    const pending: TreeStatement[] = [];
    const statements = this.#testing().get(text) ?? [];
    for (const statement of each(work, "indexSteps", statements)) {
      const facts = this.#conditionFacts(statement)?.byText.get(text) ?? [];
      const failing = some(
        work,
        "indexSteps",
        facts,
        (fact) => fact.otherwise && removes(fact.form, tag, work),
      );
      if (some(work, "indexSteps", facts, (fact) => fact.holding && removes(fact.form, tag, work)))
        entered.add(statement.arms[0]!);
      if (statement.statement.kind === "ifStatement") {
        if (failing) entered.add(statement.arms[1]!);
        pending.push(statement);
      } else if (failing && !this.#broken(statement)) pending.push(statement);
    }
    const done = new Set<TreeStatement>();
    for (const _ of steps(work, "indexSteps", () => pending.length > 0)) {
      const statement = pending.pop()!;
      if (done.has(statement)) continue;
      // (an `if`: every live arm guarded, holding a passed statement, or ending, and one of them not ending)
      if (statement.statement.kind === "ifStatement") {
        let open = false;
        let through = false;
        for (const arm of each(work, "indexSteps", statement.arms)) {
          if (!arm.live) continue;
          if (entered.has(arm) || holding.has(arm)) through = true;
          else if (!ending.has(arm)) open = true;
        }
        if (open || !through) continue;
      }
      done.add(statement);
      const list = passed.get(statement.block.id);
      if (list === undefined) passed.set(statement.block.id, [statement.index]);
      else list.push(statement.index);
      holding.add(statement.block);
      const owner = statement.block.owner;
      if (owner !== null && owner.statement.kind === "ifStatement") pending.push(owner);
    }
    for (const list of each(work, "indexSteps", passed.values()))
      sorted(work, "indexSteps", list, (a, b) => a - b);
    const made = { entered, passed };
    keepText(work, memo.length);
    this.#textTests.set(memo, made);
    return made;
  }

  /**
   * The blocks that end on every route through them, found once bottom-up: one holding a statement that leaves
   * (`ENDING`) or an `if` every live arm of which ends; never by a loop or a `switch`. And per block its labels' indexes
   * (a `goto`'s way in).
   */
  #ends(): Endings {
    this.#work.charge("indexSteps");
    if (this.#endings !== null) return this.#endings;
    const work = this.#work;
    const ending = new Set<TreeBlock>();
    const labels = new Map<number, number[]>();
    // (an arm's block is made after its owner's: from the last block, each arm before the block holding its owner)
    let index = this.tree.blocks.length;
    for (const _ of steps(work, "indexSteps", () => index > 0)) {
      index -= 1;
      const block = this.tree.blocks[index]!;
      for (const statement of each(work, "indexSteps", block.statements)) {
        const kind = statement.statement.kind;
        if (kind === "labelStatement") {
          const list = labels.get(block.id);
          if (list === undefined) labels.set(block.id, [statement.index]);
          else list.push(statement.index);
        }
        if (
          ENDING.has(kind) ||
          (kind === "ifStatement" &&
            !some(work, "indexSteps", statement.arms, (arm) => arm.live && !ending.has(arm)))
        )
          ending.add(block);
      }
    }
    this.#endings = { ending, labels };
    return this.#endings;
  }

  /** Whether a live `break` leaves a loop: a way past it its header's test does not guard. */
  #broken(statement: TreeStatement): boolean {
    this.#work.charge("indexSteps");
    const program = this.pass.program;
    const exit = statement.loop?.exit;
    return (
      exit === undefined ||
      some(
        this.#work,
        "indexSteps",
        exit.predecessors,
        (before) =>
          program.live(before) &&
          !program.flow.isDeadEdge(before, exit) &&
          before.statement?.kind === "breakStatement",
      )
    );
  }

  /** Per tested text, the `if`s and `while`s whose conditions test it: one walk of the tree on the first query. */
  #testing(): ReadonlyMap<string, readonly TreeStatement[]> {
    this.#work.charge("indexSteps");
    if (this.#tested !== null) return this.#tested;
    const work = this.#work;
    const made = new Map<string, TreeStatement[]>();
    for (const block of each(work, "indexSteps", this.tree.blocks)) {
      for (const statement of each(work, "indexSteps", block.statements)) {
        const facts = this.#conditionFacts(statement);
        if (facts === null) continue;
        if (statement.statement.kind === "ifStatement" && facts.list.length > 0)
          this.#ifs.push(statement);
        for (const [text] of each(work, "indexSteps", facts.byText)) {
          const list = made.get(text);
          if (list === undefined) made.set(text, [statement]);
          else list.push(statement);
        }
      }
    }
    this.#tested = made;
    return made;
  }

  /**
   * Whether an earlier part of an `if`'s or a `while`'s own condition guards the use at offset `use` with a test that
   * removes `tag` from the text `text` (`f() != null and f() > 0`): per statement and (text, kind), the guarding facts'
   * starts sorted with the furthest end among each prefix, built once, then one binary search.
   */
  #ownGuarded(statement: TreeStatement, text: string, tag: ItemTag, use: number): boolean {
    this.#work.charge("exactQueries");
    const work = this.#work;
    const facts = this.#conditionFacts(statement)?.byText.get(text);
    if (facts === undefined) return false;
    const memo = joinParts(text, tag);
    let per = this.#own.get(statement);
    if (per === undefined) this.#own.set(statement, (per = new Map()));
    let guards = per.get(memo);
    if (guards === undefined) {
      const kept: ConditionFact[] = [];
      for (const fact of each(work, "exactQueries", facts))
        if (removes(fact.form, tag, work)) kept.push(fact);
      sorted(work, "exactQueries", kept, (a, b) => a.from - b.from);
      const from: number[] = [];
      const reach: number[] = [];
      let far = -1;
      for (const fact of each(work, "exactQueries", kept)) {
        if (fact.to > far) far = fact.to;
        from.push(fact.from);
        reach.push(far);
      }
      guards = { from, reach };
      keepText(work, memo.length);
      per.set(memo, guards);
    }
    // (the last guard that starts at or before the use)
    const at = lowerBound(work, guards.from, use + 1) - 1;
    return at >= 0 && guards.reach[at]! > use;
  }

  /**
   * The route rule's default (Sol's F2 on #1937, then Codex r6 and r7; the lead's ruling): the certificate promotes to
   * an error only where no live `if` arm of the program's admitted callables is infeasible by entry narrowing (N1's
   * forms over the core's items, `#infeasible`) or has a stopped tested read, so none on the use's witness chain or
   * among the callables whose results or defaults reach it does; otherwise the use keeps the warning. An uncalled
   * function contributes no live arm. An arm it does not prove counts as feasible: a comparison that is constant
   * outside N1's forms (`o.k == 1`), a loop's exit, a `switch` case, another location's test. One answer per program,
   * from the `if`s `#testing` finds once.
   */
  protected *holdsInfeasible(): Work<boolean> {
    this.#work.charge("eventSteps");
    if (this.#holds !== null) return this.#holds;
    const work = this.#work;
    this.#testing();
    let holds = false;
    for (const statement of each(work, "eventSteps", this.#ifs)) {
      for (const arm of each(work, "eventSteps", statement.arms))
        if (arm.live && (yield* this.#infeasible(arm)) !== "feasible") {
          holds = true;
          break;
        }
      if (holds) break;
    }
    this.#holds = holds;
    return holds;
  }

  /**
   * Whether an `if`'s arm is one no run enters (`infeasible`): a test of its condition (N1's form, `atEntry`) whose
   * narrowing removes every kind its read holds at the condition. `unavailable`, which blocks the route rule's promotion
   * (Sol's final F1 on #1937, the lead's ruling), where a tested read's answer is missing: a stopped decision's (the
   * `budget` reason), an `unknown` without the `external` reason (admission lacking items, #2009, #2011), or empty.
   * `feasible` where the kinds are known and the narrowing leaves some, or the read is external data: an `unknown` with
   * the `external` reason is an answer, a value of any kind, so the arm is entered. One answer per arm.
   */
  *#infeasible(arm: TreeBlock): Work<ArmFeasibility> {
    this.#work.charge("eventSteps");
    const known = this.#infeasibleArms.get(arm);
    if (known !== undefined) return known;
    const work = this.#work;
    const owner = arm.owner;
    let answer: ArmFeasibility = "feasible";
    const facts = owner?.statement.kind === "ifStatement" ? this.#conditionFacts(owner) : null;
    // (each location's narrowings at the entry once: a condition may test one location many times)
    const seen = new Set<string>();
    if (arm.entry !== null && facts !== null)
      for (const fact of each(work, "eventSteps", facts.list)) {
        if (fact.location === null || seen.has(fact.location)) continue;
        seen.add(fact.location);
        for (const g of each(work, "eventSteps", this.index.atEntry(arm.entry, fact.location))) {
          const items = yield* this.pass.values.keyItems(g.key, g.input);
          if (
            items.length === 0 ||
            some(
              work,
              "eventSteps",
              items,
              (item) =>
                (item.reasons & REASON.budget) !== 0 ||
                (item.tag === "unknown" && (item.reasons & REASON.external) === 0),
            )
          ) {
            answer = "unavailable";
            break;
          }
          if (
            items.length > 0 &&
            !some(
              work,
              "eventSteps",
              items,
              (item) => item.tag === "unknown" || !removes(g.form, item.tag, work),
            )
          ) {
            answer = "infeasible";
            break;
          }
        }
        if (answer !== "feasible") break;
      }
    this.#infeasibleArms.set(arm, answer);
    return answer;
  }

  /**
   * An `if`'s or a `while`'s condition's tests as facts (N1's forms, `testForms`), found once per statement by one walk
   * of the condition: each test's form where it holds, guarding the rest of an `and` and, through every `and` above it,
   * the `then` arm or the loop's body; its form where it fails, guarding the rest of an `or` and, through every `or`
   * above it, the `else` arm or the way past; a `not` swaps the two.
   */
  #conditionFacts(statement: TreeStatement): ConditionFacts | null {
    this.#work.charge("exactQueries");
    const known = this.#conditions.get(statement);
    if (known !== undefined) return known;
    const ast = statement.statement;
    if (ast.kind !== "ifStatement" && ast.kind !== "whileStatement") {
      this.#conditions.set(statement, null);
      return null;
    }
    const list: ConditionFact[] = [];
    const byText = new Map<string, ConditionFact[]>();
    const end = ast.condition.span.end.offset;
    // (each node with how far its truth's and its falsity's facts guard, and whether to the arms)
    const pending: {
      readonly at: Expression;
      readonly holding: Guarding | null;
      readonly failing: Guarding | null;
    }[] = [
      { at: ast.condition, holding: { to: end, arm: "then" }, failing: { to: end, arm: "else" } },
    ];
    const add = (
      text: string,
      location: string | null,
      form: NarrowingForm,
      from: number,
      side: Guarding,
    ): void => {
      this.#work.charge("exactQueries");
      const fact: ConditionFact = {
        text,
        location,
        form,
        from,
        to: side.to,
        holding: side.arm === "then",
        otherwise: side.arm === "else",
      };
      list.push(fact);
      const same = byText.get(text);
      if (same === undefined) byText.set(text, [fact]);
      else same.push(fact);
    };
    for (const _ of steps(this.#work, "exactQueries", () => pending.length > 0)) {
      const { at: raw, holding, failing } = pending.pop()!;
      const at = peel(raw, this.#work);
      const close = at.span.end.offset;
      if (at.kind === "binaryExpression" && (at.operator === "and" || at.operator === "or")) {
        const and = at.operator === "and";
        const kept = and ? holding : failing;
        const left: Guarding =
          kept === null
            ? { to: close, arm: null }
            : { to: kept.to > close ? kept.to : close, arm: kept.arm };
        pending.push(
          and
            ? { at: at.left, holding: left, failing: null }
            : { at: at.left, holding: null, failing: left },
          and ? { at: at.right, holding, failing: null } : { at: at.right, holding: null, failing },
        );
        continue;
      }
      if (at.kind === "unaryExpression" && at.operator === "not") {
        pending.push({ at: at.operand, holding: failing, failing: holding });
        continue;
      }
      const forms = testForms(at, this.#work);
      if (forms === null) continue;
      const tested = peel(forms.tested, this.#work);
      const text = this.text({
        file: statement.file,
        start: tested.span.start.offset,
        end: tested.span.end.offset,
      });
      const path = stablePath(this.pass.program, statement.file, tested);
      const location = path === null ? null : locationOf(path, this.#work);
      if (holding !== null) add(text, location, forms.holding, close, holding);
      if (failing !== null) add(text, location, forms.failing, close, failing);
    }
    const made = { list, byText };
    this.#conditions.set(statement, made);
    return made;
  }

  /** The source text at a site, kept as charged text. */
  protected text(site: SourceSite): string {
    this.#work.charge("exactQueries");
    keepText(this.#work, site.end - site.start);
    return this.pass.program.textAt(site);
  }

  /** Where a node's statement stands, from its callable's body down, or `null` outside the bodies. */
  protected chainOf(node: FlowNode): Place[] | null {
    this.#work.charge("eventSteps");
    const tree = this.tree;
    const body = tree.root(node.region);
    if (body === undefined) return null;
    // a callable's parameters and their defaults stand before its body
    if (node.kind === "parameter" || node.span === null) return [{ block: body, index: -1 }];
    const statement = tree.statementAt(node.file, node.span.start.offset);
    const chain = statement === null ? [] : this.#up(statement);
    return chain.length > 0 && chain[0]!.block === body ? chain : [{ block: body, index: -1 }];
  }

  /** A statement's places from its callable's body down to it. */
  #up(statement: TreeStatement): Place[] {
    this.#work.charge("eventSteps");
    const upward: Place[] = [];
    let at: TreeStatement | null = statement;
    for (const _ of steps(this.#work, "eventSteps", () => at !== null)) {
      upward.push({ block: at!.block, index: at!.index });
      at = at!.block.owner;
    }
    // (from the body down)
    let index = upward.length;
    const chain: Place[] = [];
    for (const _ of steps(this.#work, "eventSteps", () => index > 0)) {
      index -= 1;
      chain.push(upward[index]!);
    }
    return chain;
  }
}
