import type { Statement } from "./ast.js";
import type { ControlOrigin } from "./compiler/compile-program.js";
import type { FlowEdge, PlanControlFlow } from "./plan/control-flow.js";
import type { PlanSourceLocation } from "./plan/model.js";
import type { SourceSpan } from "./source.js";

/**
 * Which ways through the source the type check found possible, by the literals and the types of the values that decide
 * them (the facts behind TSV046). They are the one answer to whether a branch, a loop body, or a lazy operand can run;
 * the checks that follow the compiled plan read them through {@link DeadWays}.
 */
export interface WayFacts {
  /**
   * For an `if` its `then` and its `else` (also without one), for a `switch` each case and then no case, for a `while`
   * its body and its end, and for a `repeat` or `for` its body and no run of it.
   */
  readonly paths: ReadonlyMap<Statement, readonly boolean[]>;
  /** For `and`, `or`, and `otherwise`, by place: whether the right side may run, and whether it may be skipped. */
  readonly operands: ReadonlyMap<string, readonly boolean[]>;
}

/** The key of a place in the source: its file and the offsets of its span. */
export function placeKey(file: number, span: SourceSpan | PlanSourceLocation): string {
  return "so" in span
    ? `${file}:${span.so}:${span.eo}`
    : `${file}:${span.start.offset}:${span.end.offset}`;
}

const TRUE_IMPOSSIBLE = 1;
const FALSE_IMPOSSIBLE = 2;
const ITERATE_IMPOSSIBLE = 4;
const EXHAUSTED_IMPOSSIBLE = 8;
/** The loop runs at least once: it is left only after its body ran. */
const RUNS_ONCE = 16;

/** The {@link WayFacts} as ways of a compiled plan: which ways of its `jumpIfFalse`s and `loopStart`s never run. */
export class DeadWays {
  readonly #flags = new Map<number, number>();

  public constructor(
    flow: PlanControlFlow,
    origins: ReadonlyMap<number, ControlOrigin>,
    private readonly facts: WayFacts,
  ) {
    for (const [index, origin] of origins) {
      let flags = 0;
      switch (origin.kind) {
        case "if": {
          const ways = facts.paths.get(origin.statement);
          if (ways?.[0] === false) flags |= TRUE_IMPOSSIBLE;
          if (ways?.[1] === false) flags |= FALSE_IMPOSSIBLE;
          break;
        }
        case "case": {
          const ways = facts.paths.get(origin.statement);
          if (ways?.[origin.index] === false) flags |= TRUE_IMPOSSIBLE;
          const last = origin.statement.cases.length - 1;
          if (origin.index === last && ways?.[last + 1] === false) flags |= FALSE_IMPOSSIBLE;
          break;
        }
        case "loop": {
          const ways = facts.paths.get(origin.statement);
          if (ways?.[0] === false) flags |= ITERATE_IMPOSSIBLE;
          if (ways?.[1] === false) {
            flags |= EXHAUSTED_IMPOSSIBLE;
            if (origin.statement.kind !== "whileStatement") flags |= RUNS_ONCE;
          }
          break;
        }
        case "operand": {
          const fact = facts.operands.get(placeKey(flow.fileOf(index), origin.expression.span));
          if (fact === undefined) break;
          // `and` and `otherwise` run their right side when the condition holds, `or` when it does not.
          const runs = origin.expression.operator === "or" ? FALSE_IMPOSSIBLE : TRUE_IMPOSSIBLE;
          const skip = origin.expression.operator === "or" ? TRUE_IMPOSSIBLE : FALSE_IMPOSSIBLE;
          if (!fact[0]) flags |= runs;
          if (!fact[1]) flags |= skip;
          break;
        }
        case "default":
          break;
      }
      if (flags !== 0) this.#flags.set(index, flags);
    }
  }

  /**
   * Whether the way of `edge` from the instruction at `index` may run: not a branch or loop way that the facts rule out.
   * A loop that runs its body at least once is left only after it ran (see {@link runsOnce}).
   */
  public possible(index: number, edge: FlowEdge["kind"]): boolean {
    const flags = this.#flags.get(index) ?? 0;
    switch (edge) {
      case "true":
        return (flags & TRUE_IMPOSSIBLE) === 0;
      case "false":
        return (flags & FALSE_IMPOSSIBLE) === 0;
      case "iterate":
        return (flags & ITERATE_IMPOSSIBLE) === 0;
      case "exhausted":
        return (flags & EXHAUSTED_IMPOSSIBLE) === 0;
      default:
        return true;
    }
  }

  /**
   * Whether the `repeat` or `for` loop that starts at `index` certainly runs its body once: then its end follows a
   * `continue`, which the plan sends back to its start, rather than the start itself.
   */
  public runsOnce(index: number): boolean {
    return ((this.#flags.get(index) ?? 0) & RUNS_ONCE) !== 0;
  }

  /** Whether the right side of the `and`, `or`, or `otherwise` at `span` of file `file` never runs. */
  public skipsRight(file: number, span: SourceSpan | PlanSourceLocation): boolean {
    return this.facts.operands.get(placeKey(file, span))?.[0] === false;
  }
}
