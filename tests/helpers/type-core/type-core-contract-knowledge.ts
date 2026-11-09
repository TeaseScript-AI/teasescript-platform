import type { InstructionPlan, TypePlan } from "../../../src/plan/model.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import type { Answers } from "../../../src/type-inference/core/answers.js";
import type { CapturedContract } from "../../../src/type-inference/core/contract-descriptors.js";
import { runGlobals } from "../type-core-route.js";

/*
 * The obligation-level knowledge of a stopped analysis (#1526 phase B, TABLE r4.278): which contract each store owing a
 * check was captured with (`Answers.contracts`: complete, open, or lost with its cause), and an execution predicate
 * that judges a store's check from what the script does, apart from the checker. Kept apart from the held-host oracle
 * until #1597 lands there (the lead's ruling).
 */

/** A source span by its offsets. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A run's host globals. */
export type Globals = Readonly<Record<string, SerializableRuntimeValue>>;

/** The contracts captured for the stores whose site lies within `span`, in the order captured. */
export function capturedWithin(answers: Answers, span: Span): readonly CapturedContract[] {
  return answers.contracts.filter(({ site }) => span.start <= site.start && site.end <= span.end);
}

/** The type checks of a plan's instructions, in order. */
export function planChecks(plan: InstructionPlan | null): TypePlan[] {
  return (plan?.instructions ?? []).flatMap((instruction) =>
    "typeCheck" in instruction && instruction.typeCheck !== undefined
      ? [instruction.typeCheck.type]
      : [],
  );
}

/**
 * A store's check judged by what the script does, apart from the checker (no capped baseline or omitted mark defines
 * what is accepted): with each fitting value the run says `after`; with each forbidden one it fails at the store,
 * inside `store`, before it says `after`. The problems found, none where the check holds.
 */
export function storeRunProblems(
  plan: InstructionPlan,
  store: Span,
  fitting: readonly Globals[],
  forbidden: readonly Globals[],
  after = "AFTER",
): string[] {
  const problems: string[] = [];
  for (const globals of fitting) {
    const run = runGlobals(plan, globals);
    if (run.status !== "halted" || !run.said.some((said) => said.text === after))
      problems.push(`fitting ${JSON.stringify(globals)}: ${JSON.stringify(run)}`);
  }
  for (const globals of forbidden) {
    const run = runGlobals(plan, globals);
    const at = /@(\d+):(\d+)$/.exec(run.failure ?? "");
    const inside = at !== null && store.start <= Number(at[1]) && Number(at[2]) <= store.end;
    if (run.status !== "failed" || !inside || run.said.some((said) => said.text === after))
      problems.push(`forbidden ${JSON.stringify(globals)}: ${JSON.stringify(run)}`);
  }
  return problems;
}
