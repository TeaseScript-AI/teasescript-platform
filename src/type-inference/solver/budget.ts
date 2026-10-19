/**
 * The temporary work budget of the solver (the owner, 2026-10-19, after PR 3a review r6; work note §3.5). One
 * isolated mechanism: one module, one set of limits, one status, read at the two cut points named here and nowhere
 * else, so that removing it later touches this module and those reads alone, never a relation or an identity rule.
 * The owner wants every composition the budget covers solved eventually (`o4-review-backlog.md`); until then the
 * work above a limit is not done: the result is held (`too complex`) and the status reports the cut
 * (`<family>.<name>@<site>:budget(combinations)` for an operation, `cell@<name>:budget(alternatives)` for a cell),
 * the solve continues, the rest of the script is checked, the expression and the values computed from it are not.
 * Stage 4 renders the cut as the owner's diagnostic (`owner-decisions.md`, "the type checker stopped checking ...").
 *
 * The cut points: `lift` in `lifting.ts`, on the combinations of an operation's operand choices (the product of the
 * operands' alternative counts, before any lazy dimension); `alternatives` in `lifting.ts`, on the expanded
 * alternatives of a cell (the elements of its expansion, nested choices included), checked while expanding so the
 * large representation is never built. The limits are the provisional guards of `evidence/budget-limits-sol.md`
 * (the orchestrator, 2026-10-19): the measured cases peak at 26 combinations and 24 alternatives.
 */

import type { CellId, Cells } from "./cells.js";

export interface Budget {
  /** The most operand combinations one operation enumerates. */
  readonly combinations: number;
  /** The most expanded alternatives one cell presents. */
  readonly alternatives: number;
}

/** The provisional guards of `evidence/budget-limits-sol.md`, until the amplifications they cover are repaired. */
const PROVISIONAL_COMBINATIONS = 1000;
const PROVISIONAL_ALTERNATIVES = 256;

export const BUDGET: Budget = Object.freeze({
  combinations: PROVISIONAL_COMBINATIONS,
  alternatives: PROVISIONAL_ALTERNATIVES,
});

/** The provenance of the held item a cut leaves. */
export const BUDGET_WHY = "too complex";

/** A cut the budget made, for the status and the diagnostic. */
export interface BudgetCut {
  readonly quantity: keyof Budget;
  /** The count met at the cut (the production schedule's; the status names the quantity alone). */
  readonly count: number;
  /** An operation's site for `combinations`, a cell for `alternatives`. */
  readonly at: number;
  /** For `combinations`: the operands with the number of alternatives each brought, the largest first. */
  readonly operands: readonly { readonly cell: CellId; readonly count: number }[];
}

export function overBudget(quantity: keyof Budget, count: number): boolean {
  return count > BUDGET[quantity];
}

const CUTS = new WeakMap<Cells, Map<CellId, BudgetCut>>();

/** Records that a cell's expansion was cut (once per cell: a cut cell stays cut, the cells only grow). */
export function cutCell(cells: Cells, cell: CellId, count: number): void {
  let cuts = CUTS.get(cells);
  if (cuts === undefined) {
    cuts = new Map();
    CUTS.set(cells, cuts);
  }
  if (!cuts.has(cell)) cuts.set(cell, { quantity: "alternatives", count, at: cell, operands: [] });
}

export function isCutCell(cells: Cells, cell: CellId): boolean {
  return CUTS.get(cells)?.has(cell) === true;
}

/** The cells the budget cut, in cell order. */
export function cutCells(cells: Cells): readonly BudgetCut[] {
  return [...(CUTS.get(cells)?.values() ?? [])].sort((a, b) => a.at - b.at);
}
