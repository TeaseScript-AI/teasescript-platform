import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { asked, coreCheckResult, SliceIndex } from "../../src/type-inference/core/consumer.js";
import { withoutRecords } from "../../src/type-inference/core/consumers.js";
import type { CoreAnalysisRequest } from "../../src/type-inference/core/program.js";
import type { HeldMode } from "./type-core-held-host.js";

/** What a compile did at an allowance: its stop, its total, whether a completion ran, and what the compiler consumes. */
export interface CompletionRun {
  readonly exhausted: string | null;
  readonly stoppedIn: string | null;
  readonly total: number;
  readonly completed: boolean;
  readonly result: string;
}

/**
 * The compiler's run of a request (`asked` with `coreCheckResult`, as the backend asks) in a mode under a demand
 * allowance, at a work allowance (`undefined`: the natural one), with its receiving completion (#1526 phase C) or
 * without it (phase B's): the stop as the answers it asked last report it.
 */
export function completionRun(
  request: CoreAnalysisRequest,
  mode: HeldMode,
  demand: number,
  allowance: number | undefined,
  completion: boolean,
): CompletionRun {
  const index = new SliceIndex(request.files.map((file) => file.program));
  const compile = (): CompletionRun => {
    const answers = analyseCore(request);
    let last: Answers = answers;
    const result = asked(answers, (each) => {
      last = each;
      return coreCheckResult(each, index, request);
    });
    return {
      exhausted: last.budget.exhausted,
      stoppedIn: last.budget.stoppedIn,
      total: last.budget.total,
      completed: last.budget.closure !== null,
      result: JSON.stringify(result),
    };
  };
  const omitted = (): CompletionRun =>
    completion
      ? compile()
      : withoutRecords({ diagnostic: () => false, check: () => false, completion: true }, compile);
  return mode.run(() =>
    withTestDemandAllowance(demand, () =>
      allowance === undefined ? omitted() : withTestAllowance(allowance, omitted),
    ),
  );
}

/**
 * The invariant of the receiving completion's place (the lead's ruling on #1637): at each allowance the compile with the
 * completion stops exactly where, and as, the one without it (phase B's), and where they stop it compiles the same;
 * where it does not stop it charges no more than the allowance. Each difference as a line.
 */
export function completionStopProblems(
  request: CoreAnalysisRequest,
  mode: HeldMode,
  demand: number,
  allowances: Iterable<number>,
): string[] {
  const problems: string[] = [];
  for (const allowance of allowances) {
    const head = completionRun(request, mode, demand, allowance, true);
    const phaseB = completionRun(request, mode, demand, allowance, false);
    const at = `${mode.name}, demand ${demand}, allowance ${allowance}`;
    if (head.exhausted !== phaseB.exhausted || head.stoppedIn !== phaseB.stoppedIn)
      problems.push(
        `${at}: stops ${head.exhausted}/${head.stoppedIn}, phase B ${phaseB.exhausted}/${phaseB.stoppedIn}`,
      );
    else if (
      phaseB.exhausted !== null &&
      (head.result !== phaseB.result || head.total !== phaseB.total)
    )
      problems.push(`${at}: the stopped compile differs from phase B's`);
    else if (phaseB.exhausted !== null && head.completed)
      problems.push(`${at}: a completion ran after a stop`);
    if (head.exhausted === null && head.total > allowance)
      problems.push(`${at}: charged ${head.total} past the allowance`);
  }
  return problems;
}

/**
 * The allowances the invariant is checked at: every `step`th from 1, and every one within `band` of each end the
 * compile without the completion reaches (its total) and of the head's natural total.
 */
export function completionAllowances(
  request: CoreAnalysisRequest,
  mode: HeldMode,
  demand: number,
  step: number,
  band: number,
): number[] {
  const own = completionRun(request, mode, demand, undefined, false).total;
  const head = completionRun(request, mode, demand, undefined, true).total;
  const allowances = new Set<number>();
  for (let allowance = 1; allowance <= head + band; allowance += step) allowances.add(allowance);
  for (const end of [own, head])
    for (let allowance = Math.max(1, end - band); allowance <= end + band; allowance += 1)
      allowances.add(allowance);
  return [...allowances].sort((a, b) => a - b);
}
