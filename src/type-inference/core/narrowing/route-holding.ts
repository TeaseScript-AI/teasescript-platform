import type { Expression, Statement } from "../../../ast.js";
import { expressionParts, statementExpressions } from "../../../expression-children.js";
import type { WorkLedger } from "../budget.js";
import { each, sorted, steps } from "../charged-iteration.js";
import { peel } from "./narrowings.js";
import {
  countIn,
  lowerBound,
  type StatementTree,
  type TreeBlock,
  type TreeStatement,
} from "./statement-tree.js";

/*
 * Which statements may check, store or hand off a variable, for the route rule's entry segments (the accepted record's
 * r4-451): a segment from a way into a use (a loop's head, a label, a file's or a block body's start) is unchecked
 * only where no statement on it holds the variable's name
 * - in a test position: an operand of `==`, `!=`, `and`, `or` or `not`, the value of `is` or `is not`, an `if`'s or a
 *   `while`'s condition, a `switch`'s subject or case values, the name read anywhere inside it;
 * - inside a call's arguments or its receiver (the callee may store through it);
 * - as a store's or a binding's root: an assignment's target, a `let`, a `global`, a `for` loop's variables.
 * Built once per program from the syntax by one walk of every statement's own expressions, by name rather than by
 * binding: a name another binding shares holds there too, which only closes more segments. Per name, the statements
 * holding it and every compound statement around one are kept sorted by block, so a segment's statements are one
 * binary search per block.
 */

/**
 * The name under which a statement holds a call of one of the program's functions or a file's `call` (no identifier
 * spells it): a callee may store a key owned outside the segment's activation, so a segment holding one closes for such
 * a key. A built-in's call stores no variable.
 */
export const CALL = "(call)";

/** Per name, the statements holding it in any part (their own expressions, or a statement inside them), by block. */
interface Marks {
  readonly byBlock: ReadonlyMap<number, readonly number[]>;
}

export class RouteHolding {
  /** Per statement, the names its own expressions hold (`#walk`); made on the first query. */
  #own: Map<TreeStatement, ReadonlySet<string>> | null = null;
  /** Per name, the statements whose own expressions hold it. */
  readonly #byName = new Map<string, TreeStatement[]>();
  /** Per name, its marks (`#marks`), made on its first segment. */
  readonly #marked = new Map<string, Marks>();
  /** Per name, by block, the sorted indexes of the statements whose own expressions hold it (`after`). */
  readonly #owned = new Map<string, ReadonlyMap<number, readonly number[]>>();

  /** `functions`: the names of the program's functions, whose calls a callee may store through (`CALL`). */
  public constructor(
    readonly work: WorkLedger,
    readonly tree: StatementTree,
    readonly functions: ReadonlySet<string>,
  ) {
    work.charge("indexSteps");
  }

  /** Whether a statement's own expressions (a compound statement's header, a simple statement whole) hold `name`. */
  public holds(name: string, statement: TreeStatement): boolean {
    this.work.charge("eventSteps");
    return this.#index().get(statement)?.has(name) === true;
  }

  /** Whether a statement of `block` from `low` to `high` (exclusive) holds `name` in any part. */
  public holdsIn(name: string, block: TreeBlock, low: number, high: number): boolean {
    this.work.charge("eventSteps");
    const marked = this.#marks(name).byBlock.get(block.id);
    return marked !== undefined && countIn(this.work, marked, low, high) > 0;
  }

  /** The index of the first statement of `block` after `index` whose own expressions hold `name`, or `null`. */
  public after(name: string, block: TreeBlock, index: number): number | null {
    this.work.charge("eventSteps");
    const list = this.#ownedIn(name, block);
    let low = 0;
    let high = list.length;
    for (const _ of steps(this.work, "eventSteps", () => low < high)) {
      const middle = (low + high) >> 1;
      if (list[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    return low < list.length ? list[low]! : null;
  }

  /** The index of the last statement of `block` before `index` whose own expressions hold `name`, or `null`. */
  public before(name: string, block: TreeBlock, index: number): number | null {
    this.work.charge("eventSteps");
    const list = this.#ownedIn(name, block);
    const low = lowerBound(this.work, list, index);
    return low > 0 ? list[low - 1]! : null;
  }

  /** The indexes, sorted, of `block`'s statements whose own expressions hold `name`; per name, made once. */
  #ownedIn(name: string, block: TreeBlock): readonly number[] {
    this.work.charge("eventSteps");
    let owned = this.#owned.get(name);
    if (owned === undefined) {
      this.#index();
      const byBlock = new Map<number, number[]>();
      for (const statement of each(this.work, "indexSteps", this.#byName.get(name) ?? [])) {
        const list = byBlock.get(statement.block.id);
        if (list === undefined) byBlock.set(statement.block.id, [statement.index]);
        else list.push(statement.index);
      }
      for (const list of each(this.work, "indexSteps", byBlock.values()))
        sorted(this.work, "indexSteps", list, (a, b) => a - b);
      owned = byBlock;
      this.#owned.set(name, owned);
    }
    return owned.get(block.id) ?? [];
  }

  /** A name's marks: the statements holding it and every compound statement around one, each once. */
  #marks(name: string): Marks {
    this.work.charge("indexSteps");
    const known = this.#marked.get(name);
    if (known !== undefined) return known;
    this.#index();
    const seen = new Set<TreeStatement>();
    const byBlock = new Map<number, number[]>();
    const pending: TreeStatement[] = [];
    for (const statement of each(this.work, "indexSteps", this.#byName.get(name) ?? []))
      pending.push(statement);
    for (const _ of steps(this.work, "indexSteps", () => pending.length > 0)) {
      const statement = pending.pop()!;
      if (seen.has(statement)) continue;
      seen.add(statement);
      const list = byBlock.get(statement.block.id);
      if (list === undefined) byBlock.set(statement.block.id, [statement.index]);
      else list.push(statement.index);
      if (statement.block.owner !== null) pending.push(statement.block.owner);
    }
    for (const list of each(this.work, "indexSteps", byBlock.values()))
      sorted(this.work, "indexSteps", list, (a, b) => a - b);
    const made = { byBlock };
    this.#marked.set(name, made);
    return made;
  }

  /** Every statement's own names, walked once (`#walk`), and per name the statements holding it. */
  #index(): Map<TreeStatement, ReadonlySet<string>> {
    this.work.charge("indexSteps");
    if (this.#own !== null) return this.#own;
    const own = new Map<TreeStatement, ReadonlySet<string>>();
    for (const block of each(this.work, "indexSteps", this.tree.blocks))
      for (const statement of each(this.work, "indexSteps", block.statements)) {
        const names = this.#walk(statement);
        own.set(statement, names);
        for (const name of each(this.work, "indexSteps", names)) {
          const list = this.#byName.get(name);
          if (list === undefined) this.#byName.set(name, [statement]);
          else list.push(statement);
        }
      }
    this.#own = own;
    return own;
  }

  /**
   * The names a statement's own expressions hold in a test position or a call's arguments or receiver, the roots it
   * stores or binds, and `CALL` where they hold a call or it is a file's `call`.
   */
  #walk(made: TreeStatement): ReadonlySet<string> {
    this.work.charge("indexSteps");
    const statement = made.statement;
    const names = new Set<string>();
    const pending: { readonly at: Expression; readonly held: boolean }[] = [];
    // (a condition, a subject and a case value are test positions whole)
    const tested =
      statement.kind === "ifStatement" ||
      statement.kind === "whileStatement" ||
      statement.kind === "switchStatement";
    for (const expression of each(this.work, "indexSteps", ownExpressions(statement, this.work)))
      pending.push({ at: expression, held: tested });
    for (const name of each(this.work, "indexSteps", boundNames(statement, this.work)))
      names.add(name);
    if (statement.kind === "callFileStatement") names.add(CALL);
    for (const _ of steps(this.work, "indexSteps", () => pending.length > 0)) {
      const { at, held } = pending.pop()!;
      if (at.kind === "identifier") {
        if (held) names.add(at.name);
        continue;
      }
      if (at.kind === "callExpression") {
        // (the callee, its parentheses peeled: a function's name, a method's receiver, or any other expression's parts)
        const callee = peel(at.callee, this.work);
        if (callee.kind === "identifier" && this.functions.has(callee.name)) names.add(CALL);
        // (the callee may store through what it is handed: its arguments and its receiver)
        for (const argument of each(this.work, "indexSteps", at.arguments))
          pending.push({ at: argument.value, held: true });
        if (callee.kind === "propertyAccessExpression")
          pending.push({ at: callee.object, held: true });
        else if (callee.kind !== "identifier") pending.push({ at: callee, held });
        if (at.presentation !== undefined) pending.push({ at: at.presentation, held });
        continue;
      }
      const testing =
        held ||
        (at.kind === "binaryExpression" &&
          (at.operator === "==" ||
            at.operator === "!=" ||
            at.operator === "and" ||
            at.operator === "or")) ||
        (at.kind === "unaryExpression" && at.operator === "not") ||
        at.kind === "typeTestExpression";
      for (const part of each(this.work, "indexSteps", expressionParts(at)))
        pending.push({ at: part, held: testing });
    }
    return names;
  }
}

/** A statement's own expressions: `statementExpressions`, and a `global`'s start value and its assignment's value. */
function ownExpressions(statement: Statement, work: WorkLedger): readonly Expression[] {
  work.charge("indexSteps");
  if (statement.kind === "globalStatement")
    return statement.assignment === null
      ? [statement.initial]
      : [statement.initial, statement.assignment.value];
  return statementExpressions(statement);
}

/** The roots a statement stores or binds: an assignment's target's root, a `let`'s, a `global`'s, a `for`'s variables. */
function boundNames(statement: Statement, work: WorkLedger): readonly string[] {
  work.charge("indexSteps");
  switch (statement.kind) {
    case "letStatement":
    case "globalStatement":
      return [statement.name.name];
    case "forStatement":
      return statement.valueVariable === null
        ? [statement.variable.name]
        : [statement.variable.name, statement.valueVariable.name];
    case "assignmentStatement": {
      let target: Expression = statement.target;
      for (const _ of steps(
        work,
        "indexSteps",
        () =>
          target.kind === "propertyAccessExpression" ||
          target.kind === "indexExpression" ||
          target.kind === "parenthesizedExpression",
      ))
        if (target.kind === "parenthesizedExpression") target = target.expression;
        else if (target.kind === "propertyAccessExpression" || target.kind === "indexExpression")
          target = target.object;
      return target.kind === "identifier" ? [target.name] : [];
    }
    default:
      return [];
  }
}
