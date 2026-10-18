// O4 stage 2b: numeric.* and the value form of min and max, exported as minMaxOfValues (§5.3).
// A placeholder of the starting commit: the slice delegated to Opus 5.5 fills it in; the lead edits no further line here.
import type { OperandView, OperationRelation, OperationResult } from "./relation.js";
import { UNCONSTRAINED } from "./views.js";

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map();

/** The result of `min`/`max` of two or more values (§5.3); the placeholder answers nothing yet. */
export function minMaxOfValues(_views: readonly OperandView[]): OperationResult {
  return UNCONSTRAINED;
}
