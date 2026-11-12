// The solver oracle of #2486: within one solve from bottom, each run of a component's member keeps what its previous run
// gave, so a component settles once its inputs do. A transfer that loses an item, a reason or an unknown's word as what
// it reads grows makes a component that alternates until the allowance stops it.
import { firstContext, type Item } from "../../../src/type-inference/core/items.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";

/**
 * What a run may not do to its member's previous answer: drop one of its kinds (`empty`, the emptiness mark, included;
 * an `integer` where `number` is listed instead, with every reason it had, is kept), drop a reason of a kind it keeps, or move an unknown's word later in the merge's order (`firstContext`) while its
 * reasons stay as they were. An unknown's word may follow its reasons as they grow (`reasonContext`), which happens at most
 * once per reason; a word that moves later under the same reasons went round a component (#2486's Domme ring).
 */
export type ViolationKind = "kind lost" | "reason lost" | "unknown's word later";

export interface Violation {
  readonly kind: ViolationKind;
  /** The member's demand key. */
  readonly key: string;
  readonly tag: string;
  readonly before: string;
  readonly after: string;
}

/** What the oracle saw over the runs it heard. */
export interface MonotoneRecord {
  /** Every run of a member it heard, and those with a previous answer to compare with. */
  readonly runs: number;
  readonly compared: number;
  /** Every violation, counted; the first of each kind, key and kind of item kept. */
  readonly violations: number;
  readonly first: readonly Violation[];
  /**
   * Moves of the fields the oracle does not judge (#2486's R5), counted by field and direction: `cert`, each mark, a
   * known item's word, the writer, the operand identity (`fan`), a null's word and the spelling.
   */
  readonly moves: Readonly<Record<string, number>>;
}

const MARKS = ["guarded", "called", "loose", "fromExternal", "tested", "extOnly"] as const;

const shown = (item: Item): string =>
  `${item.tag}/${item.cert}/r${item.reasons}/${item.context ?? ""}`;

/** Whether `after` comes later than `before` in the merge's order of words (`firstContext`). */
const later = (before: Item["context"], after: Item["context"]): boolean =>
  before !== after && firstContext(before, after) === before;

/** One run judged against its member's previous answer: its violations, and its moves added to `moves`. */
export function judgeRun(
  key: string,
  before: readonly Item[],
  after: readonly Item[],
  moves: Map<string, number>,
): Violation[] {
  const count = (move: string): void => void moves.set(move, (moves.get(move) ?? 0) + 1);
  const now = new Map(after.map((item) => [item.tag, item]));
  const violations: Violation[] = [];
  for (const was of before) {
    const is = now.get(was.tag);
    const violation = (kind: ViolationKind): void =>
      void violations.push({
        kind,
        key,
        tag: was.tag,
        before: shown(was),
        after: is === undefined ? "" : shown(is),
      });
    if (is === undefined) {
      // (`number` holds every integer, so an `integer` replaced by `number` widens: a narrowed read whose test a store in
      // its loop fails takes the place's own kinds, once, as in `let n: number | string = 2` /
      // `if n is integer { repeat 2 { repeat n {} n = n / 2 } }`, #2486's ruling R9)
      const wider = was.tag === "integer" ? now.get("number") : undefined;
      if (wider !== undefined && (was.reasons & ~wider.reasons) === 0)
        count("integer widened to number");
      else violation(wider === undefined ? "kind lost" : "reason lost");
      continue;
    }
    if ((was.reasons & ~is.reasons) !== 0) violation("reason lost");
    if (was.tag === "unknown") {
      if (was.reasons === is.reasons && later(was.context, is.context))
        violation("unknown's word later");
      else if (was.context !== is.context) count("unknown word with its reasons");
    } else if (was.context !== is.context)
      count(`known word ${later(was.context, is.context) ? "later" : "earlier"}`);
    if (was.cert !== is.cert) count(`cert ${was.cert}→${is.cert}`);
    for (const mark of MARKS)
      if ((was[mark] === true) !== (is[mark] === true))
        count(`${mark} ${was[mark] === true ? "lost" : "gained"}`);
    if (was.writer?.start !== is.writer?.start || was.writer?.kind !== is.writer?.kind)
      count("writer changed");
    if (was.fan !== is.fan) count("fan changed");
    if (was.word !== is.word) count("word changed");
    if (was.spelling?.join("+") !== is.spelling?.join("+")) count("spelling changed");
  }
  return violations;
}

/**
 * `run` with every member run of every solver made inside it judged (`judgeRun`), and what the oracle saw; with
 * `reverseWorklist`, the members run in the reverse of the canonical order (one seam carries both).
 */
export function withMonotoneOracle<T>(
  run: () => T,
  reverseWorklist = false,
): { readonly result: T; readonly record: MonotoneRecord } {
  let runs = 0;
  let compared = 0;
  let violations = 0;
  const first = new Map<string, Violation>();
  const moves = new Map<string, number>();
  const result = withSolverSeam(
    {
      reverseWorklist,
      onRerun: (key, before, after) => {
        runs += 1;
        if (before.length === 0) return;
        compared += 1;
        for (const violation of judgeRun(key, before, after, moves)) {
          violations += 1;
          const at = `${violation.kind}|${violation.key}|${violation.tag}`;
          if (!first.has(at)) first.set(at, violation);
        }
      },
    },
    run,
  );
  return {
    result,
    record: {
      runs,
      compared,
      violations,
      first: [...first.values()],
      moves: Object.fromEntries([...moves].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    },
  };
}
