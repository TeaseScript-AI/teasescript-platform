import { analyseCore, type Answers } from "../../../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../../../src/type-inference/core/budget.js";
import {
  asked,
  coreCheckResult,
  coreFacts,
} from "../../../../src/type-inference/core/check-result/check-result.js";
import {
  OutsideContract,
  SliceIndex,
} from "../../../../src/type-inference/core/check-result/slice-index.js";
import { withoutRecords } from "../../../../src/type-inference/core/consumers.js";
import type { CoreAnalysisRequest } from "../../../../src/type-inference/core/program.js";
import type { HeldMode } from "../../type-core-held-host.js";
import { sampled } from "../../sweep.js";

/**
 * What a compile did at an allowance: its stop, its total, whether a completion ran and the units it charged, and what
 * the compiler consumes (its checked result and its facts, maps and sets by their contents).
 */
export interface CompletionRun {
  readonly exhausted: string | null;
  readonly stoppedIn: string | null;
  readonly total: number;
  readonly completed: boolean;
  readonly units: number;
  readonly result: string;
}

/** A syntax node's span side as its offset, or `-`. */
function offsetOf(span: unknown, side: "start" | "end"): string {
  if (span === null || typeof span !== "object") return "-";
  const position: unknown =
    side === "start" ? ("start" in span ? span.start : null) : "end" in span ? span.end : null;
  if (position === null || typeof position !== "object" || !("offset" in position)) return "-";
  return String(position.offset);
}

/** A value as text with its maps' entries and its sets' members, a syntax node as its kind and span. */
function contents(value: unknown): string {
  return JSON.stringify(value, (_, each: unknown) => {
    if (each instanceof Map) return { map: [...each.entries()] };
    if (each instanceof Set) return { set: [...each] };
    if (typeof each === "function") return "function";
    if (each !== null && typeof each === "object" && "kind" in each && "span" in each)
      return `${String(each.kind)}@${offsetOf(each.span, "start")}:${offsetOf(each.span, "end")}`;
    return each;
  });
}

/**
 * The compiler's run of a request (`asked` with `coreCheckResult` and `coreFacts`, as the backend asks after its own
 * slice check) in a mode under a demand allowance, at a work allowance (`undefined`: the natural one), with its
 * receiving completion (#1526 phase C) or without it (phase B's): the stop as the answers it asked last report it, its
 * result the compiled one or the decline.
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
    // (a program declined where a required check is lost at a stop, #1526 decision 2: the decline is its result)
    const result = ((): string => {
      try {
        return contents(
          asked(answers, (each) => {
            last = each;
            return {
              checked: coreCheckResult(each, index, request),
              facts: coreFacts(each, index, request),
            };
          }),
        );
      } catch (error) {
        if (!(error instanceof OutsideContract)) throw error;
        return contents({ declined: error.what });
      }
    })();
    return {
      exhausted: last.budget.exhausted,
      stoppedIn: last.budget.stoppedIn,
      total: last.budget.total,
      completed: last.budget.closure !== null,
      units: last.budget.closure?.units ?? 0,
      result,
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
 * The allowances the invariant is checked at: of every `step`th from 1 and every one within `band` of each end (where the
 * compile without the completion ends, its questions included, so the head's completion starts after it, and the head's
 * natural total), the sample (`sampled`) of those up to the first end, of those after it up to the second, and of those
 * after the second.
 */
export function completionAllowances(
  request: CoreAnalysisRequest,
  mode: HeldMode,
  demand: number,
  step: number,
  band: number,
): number[] {
  const run = completionRun(request, mode, demand, undefined, true);
  const head = run.total;
  const own = run.total - run.units;
  const allowances = new Set<number>();
  for (let allowance = 1; allowance <= head + band; allowance += step) allowances.add(allowance);
  for (const end of [own, head])
    for (let allowance = Math.max(1, end - band); allowance <= end + band; allowance += 1)
      allowances.add(allowance);
  const sorted = [...allowances].sort((a, b) => a - b);
  return [
    ...sampled(sorted.filter((allowance) => allowance <= own)),
    ...sampled(sorted.filter((allowance) => allowance > own && allowance <= head)),
    ...sampled(sorted.filter((allowance) => allowance > head)),
  ];
}
