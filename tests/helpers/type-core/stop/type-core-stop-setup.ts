// The stop tests' shared setup (tests/type-core/stop/): the candidate route's compile and run at an allowance, a
// stopped run, the allowances where a stop falls, and the gates' decline reasons.

import assert from "node:assert/strict";

import { compileSourceWithBackend } from "../../../../src/compiler.js";
import { run } from "../../../../src/runtime/engine.js";
import { type SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../../src/type-inference/core/answers.js";
import {
  CandidateOutsideSlice,
  CORE_BACKEND,
} from "../../../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../../../src/type-inference/core/budget.js";
import {
  withConsumerOrder,
  withoutRecords,
} from "../../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "../../immediate-pacing-runtime.js";
import { coreRequest } from "../../type-core-analysis.js";
import { phaseEnds } from "../../type-core-held-host.js";
import { stopProblems, type StopRun } from "../../type-core-stop-oracle.js";

export const OPTIONS = { globals: ["hostValue"] };

/** A stop in the setup: an allowance below what the program's size alone charges. */
export const ALLOWANCE = 50;

/** `make` in the core's order and with its consumers' and solver's orders reversed: both, equal. */
export function inBothOrders<T>(make: () => T): T {
  const forward = make();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), make),
  );
  assert.deepEqual(reversed, forward);
  return forward;
}

/** The candidate route's compile of `source` under an allowance (the small one by default): diagnostics and plan. */
export function compiled(source: string, allowance = ALLOWANCE) {
  return withTestAllowance(allowance, () =>
    inBothOrders(() => {
      const result = compileSourceWithBackend(source, OPTIONS, CORE_BACKEND);
      return {
        diagnostics: result.diagnostics.map(
          (d) => `${d.severity} ${d.code} @${d.span.start.offset}:${d.span.end.offset}`,
        ),
        plan: result.plan,
      };
    }),
  );
}

/** A run of a plan to its end with `hostValue`: what it said and where it failed. */
export function ran(
  plan: NonNullable<ReturnType<typeof compiled>["plan"]>,
  hostValue: SerializableRuntimeValue,
) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  };
}

/** The plain gate's decline (#2080 part 2): a stop before admission settled left a store's check undecided. */
export const UNDECIDED = "a store whose check was left undecided at the budget";

/** The allowance a source's analysis spends to its end: a stop at it falls in the route's questions after it. */
export function analysisTotal(source: string): number {
  const request = coreRequest([{ path: "main.tease", source }], OPTIONS.globals);
  assert.ok(request !== null);
  return analyseCore(request).budget.total;
}
/** The lost-check gate's decline (#1526 decision 2, condition 1). */
export const LOST_CHECK = "a store whose check was lost at the budget";
/** A settled stop's decline at a fallback whose requirement it lost (#2183). */
export const DEFAULT_LOST = "a default whose check was lost at the budget";

export const object = (
  props: Record<string, SerializableRuntimeValue>,
): SerializableRuntimeValue => ({
  kind: "object",
  properties: Object.entries(props).map(([name, value]) => ({ name, value })),
});
export const host = (
  hostValue: SerializableRuntimeValue,
  hostOther: SerializableRuntimeValue = 2,
) => ({ hostValue, hostOther });

/** A compile of `source` and its analysis, under an allowance where one is given. */
export function stopRun(
  source: string,
  allowance?: number,
): StopRun & { readonly undecided: boolean; readonly lostDefault: boolean } {
  const options = { globals: ["hostValue", "hostOther"] };
  const request = coreRequest([{ path: "main.tease", source }], options.globals);
  assert.ok(request !== null);
  const allowed = <T>(make: () => T): T =>
    allowance === undefined ? make() : withTestAllowance(allowance, make);
  // (the plain gate's decline, #2080 part 2, and a settled stop's at a lost default, #2183, are no plan and no
  // diagnostics, as `heldRun` records a decline)
  let undecided = false;
  let lostDefault = false;
  const compile = (): StopRun["result"] => {
    try {
      return compileSourceWithBackend(source, options, CORE_BACKEND);
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      if (error.what === UNDECIDED) undecided = true;
      else if (error.what === DEFAULT_LOST) lostDefault = true;
      else throw error;
      return { diagnostics: [], plan: null };
    }
  };
  const both = () => ({ result: compile(), answers: analyseCore(request) });
  return {
    ...allowed(both),
    undecided,
    lostDefault,
    without: (omit) => allowed(() => withoutRecords(omit, both)),
  };
}

/**
 * `stopProblems` of a stop as `declines` says the plain gate treats it (#2080 part 2): a declined stop's problems but
 * its missing plan, what the oracle compares beside the plan (diagnostics, records, the check ledger); a published one's
 * all of them.
 */
export function gatedProblems(
  c: Omit<Parameters<typeof stopProblems>[0], "stopped"> & {
    readonly stopped: ReturnType<typeof stopRun>;
  },
  declines: boolean,
): string[] {
  assert.equal(c.stopped.undecided, declines, declines ? "declined" : "published");
  return stopProblems(c).filter((problem) => !declines || problem !== "no plan");
}

/** A source's settled phases, each with its lowest and highest stopping allowance (`phaseEnds`). */
export function settledEnds(source: string): Map<string, readonly [number, number]> {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  return phaseEnds(analyseCore(request).budget.total, (allowance) => {
    const { stoppedIn, settled } = withTestAllowance(allowance, () => analyseCore(request)).budget;
    return settled ? stoppedIn : null;
  });
}

/** The lowest and highest allowance of a source's settled walk stops. */
export function walkEnds(source: string): readonly [number, number] {
  const walk = settledEnds(source).get("walk");
  assert.ok(walk !== undefined, source);
  return walk;
}

/**
 * The highest allowance at which a source's analysis stops before admission settled: below its total where none settles.
 */
export function lastUnsettled(source: string): number {
  const lows = [...settledEnds(source).values()].map(([low]) => low);
  return (lows.length > 0 ? Math.min(...lows) : analysisTotal(source)) - 1;
}
