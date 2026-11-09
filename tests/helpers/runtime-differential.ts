/*
 * The differential driver (docs/TESTING.md "Differential harness"): two pipelines compile and run the same input, one
 * instruction or wait settlement at a time, and every state's complete record is compared, in the uninterrupted run
 * and in every restore route from a bounded set of cut points. Each side is a port (`runtime-differential-side.ts`):
 * this build in this process by default, or a root's runner across processes (`runtime-differential-remote.ts`); the
 * one lockstep control flow below decides for both.
 */

import {
  compareStructures,
  IDENTITY,
  MappingFailure,
  mismatchLimit,
} from "./runtime-state-comparison.js";
import { thisBuild } from "./runtime-differential-build.js";
import {
  Attribution,
  CallbackFailure,
  classifiedFailure,
  cutPoints,
  DEFAULT_MAX_CUTS,
  DEFAULT_MAX_STEPS,
  LocalPort,
  notCompared,
  PortFailure,
  RESTORE_TAILS,
  Stop,
  write,
  type ComparisonSite,
  type DifferentialInput,
  type DifferentialOptions,
  type DifferentialReport,
  type InjectionSite,
  type Latched,
  type PairVerdict,
  type PortRecord,
  type Route,
  type SideName,
  type SideOutcome,
  type SidePort,
  type SideRecord,
  type Written,
} from "./runtime/runtime-differential-side.js";

export { thisBuild } from "./runtime-differential-build.js";
export type {
  ComparisonSite,
  Compiled,
  DifferentialInput,
  DifferentialOptions,
  DifferentialReport,
  HostCall,
  HostDriver,
  InjectionSite,
  PairVerdict,
  PipelineAdapter,
  RestoreTail,
  Route,
  SideOutcome,
  SideRecord,
  SidePort,
  Stage,
  Tail,
} from "./runtime/runtime-differential-side.js";

/**
 * Runs `input` through two pipelines on one route and compares them completely: the compile results, then every state
 * of the uninterrupted run, then every restore route from every cut point to its end, each state against the other
 * side's same run and against its own side's uninterrupted run.
 *
 * No exception gives a false `equivalent` or a `discrepancy`: one outer catch reports any exception the driver did not
 * raise itself as `not-compared` with a side's `harness-failure` (or `serializer-failure`), at the cursor or at a
 * latched callback. Only a public engine call's own exception, invoked inside its narrow catch, is engine behaviour: a
 * fresh session's admission refusing the input, or a restore that threw. The classification is best effort for
 * trusted synchronous adapters (#1923).
 */
export function differentialRun(
  input: DifferentialInput,
  options: DifferentialOptions = {},
): DifferentialReport {
  const attribution = new Attribution();
  return differentialRunOn(
    attribution,
    (route) => {
      const context = {
        input,
        route,
        maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        maxCuts: options.maxCuts ?? DEFAULT_MAX_CUTS,
        host: options.host,
      };
      return {
        left: new LocalPort(attribution, "left", options.left ?? thisBuild("left"), context),
        right: new LocalPort(attribution, "right", options.right ?? thisBuild("right"), context),
      };
    },
    input,
    options,
  );
}

/**
 * The lockstep driver over two ports, which `makePorts` makes once the route is read. `attribution` is the driver's own
 * cursor and latch, which in-process ports share.
 */
export function differentialRunOn(
  attribution: Attribution,
  makePorts: (route: Route) => { readonly left: SidePort; readonly right: SidePort },
  input: DifferentialInput,
  options: DifferentialOptions = {},
): DifferentialReport {
  const cursor = attribution.cursor;
  const op = <T>(side: SideName, member: string, run: () => T): T =>
    attribution.op(side, member, run);
  const started = process.cpuUsage();
  const progress: { steps: number; cuts: readonly number[]; overCap: boolean; tailSteps: number } =
    { steps: 0, cuts: [], overCap: false, tailSteps: 0 };
  let outcomes: DifferentialReport["outcomes"] = { left: null, right: null };
  let planDigests: DifferentialReport["plans"] = { left: null, right: null };
  let route: Route = "legacy";
  let ports: { readonly left: SidePort; readonly right: SidePort } | null = null;
  /**
   * The one way a verdict leaves `differentialRun`: a pending latched callback failure takes priority over any verdict,
   * `equivalent`, a discrepancy, a mapping failure, censoring or an admission alike.
   */
  const report = (given: PairVerdict): DifferentialReport => {
    // Every field that can run code is read first, so that the latch is checked last, right before the verdict
    // leaves: a callback failure swallowed while a field is read still takes priority.
    const name = input.name;
    const used = process.cpuUsage(started);
    const fields = {
      name,
      route,
      plans: planDigests,
      steps: progress.steps,
      cuts: progress.cuts,
      cutsOverCap: progress.overCap,
      tailSteps: progress.tailSteps,
      cpuMs: Math.round((used.user + used.system) / 1000),
    };
    let verdict = given;
    const own = attribution.pending();
    const pending =
      own !== null
        ? { side: own.side, outcome: classifiedFailure(own) }
        : ports === null
          ? null
          : (ports.left.pending() ?? ports.right.pending());
    if (pending !== null) {
      outcomes = { ...outcomes, [pending.side]: pending.outcome };
      verdict = { kind: "not-compared", side: pending.side, because: pending.outcome.kind };
    }
    // The report's own field order, unchanged.
    return {
      name: fields.name,
      route: fields.route,
      outcomes,
      verdict,
      plans: fields.plans,
      steps: fields.steps,
      cuts: fields.cuts,
      cutsOverCap: fields.cutsOverCap,
      tailSteps: fields.tailSteps,
      cpuMs: fields.cpuMs,
    };
  };

  // Before either side's run starts, and outside the `try`, which would report a bad option as a side's failure.
  const limit = mismatchLimit(options.limit);
  try {
    route = options.route ?? "legacy";
    const sides = makePorts(route);
    ports = sides;
    const correspondence = options.correspondence ?? IDENTITY;
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    /** Compares plain data; a difference or a mapping failure stops the pair. */
    const compareData = (oracle: unknown, candidate: unknown, at: ComparisonSite) => {
      let comparison;
      try {
        comparison = compareStructures(oracle, candidate, { correspondence, limit });
      } catch (error) {
        if (error instanceof MappingFailure)
          throw new Stop({ kind: "mapping-failure", at, error: error.message });
        throw error;
      }
      if (!comparison.equal)
        throw new Stop({ kind: "discrepancy", at, mismatches: comparison.mismatches });
    };
    /** Compares written records: by their texts when the correspondence is the identity, else by structure. */
    const compare = (oracle: Written, candidate: Written, at: ComparisonSite) => {
      if (
        correspondence.identity &&
        oracle.state === candidate.state &&
        oracle.traces === candidate.traces
      )
        return;
      compareData(oracle.record, candidate.record, at);
    };
    /**
     * A side's record, injected into when the options say so, and written; a record a port already wrote across
     * processes keeps its texts.
     */
    const written = (
      side: SideName,
      record: () => PortRecord,
      at: Omit<InjectionSite, "side">,
    ): Written => {
      const made = record();
      if (made.texts !== undefined && options.inject === undefined)
        return { record: made.record, state: made.texts.state, traces: made.texts.traces };
      const injected = op(
        side,
        "inject",
        () => options.inject?.(made.record, { ...at, side }) ?? made.record,
      );
      return op(side, "write", () => write(injected));
    };

    // Compile on both sides: equal rejections are equivalent, compared as diagnostics.
    const compiled = { left: sides.left.compile(), right: sides.right.compile() };
    const compileSite: ComparisonSite = {
      tail: "compile",
      cut: null,
      state: 0,
      against: "other-side",
    };
    if (compiled.left.kind === "rejected" && compiled.right.kind === "rejected") {
      outcomes = {
        left: { kind: "compile-rejected", diagnostics: compiled.left.diagnostics },
        right: { kind: "compile-rejected", diagnostics: compiled.right.diagnostics },
      };
      compareData(compiled.left.diagnostics, compiled.right.diagnostics, compileSite);
      return report({ kind: "equivalent" });
    }
    for (const side of ["left", "right"] as const) {
      const item = compiled[side];
      if (item.kind === "unsupported")
        throw notCompared(side, { kind: "unsupported-route", reason: item.reason });
    }
    for (const side of ["left", "right"] as const) {
      const item = compiled[side];
      if (item.kind === "rejected")
        throw notCompared(side, { kind: "compile-rejected", diagnostics: item.diagnostics });
    }
    const { left, right } = compiled;
    if (left.kind !== "plan" || right.kind !== "plan")
      throw new Error("Both sides have a plan here.");
    compareData(left.diagnostics, right.diagnostics, compileSite);
    planDigests = { left: sides.left.planDigest(), right: sides.right.planDigest() };

    // Where the cuts are, from the left side's uninterrupted run without records; a host call is a wait.
    cursor.stage = "probe";
    {
      const probe = sides.left.probe();
      const cutInfo = cutPoints(
        probe.steps,
        probe.waits,
        probe.emitting,
        probe.faulted,
        options.maxCuts ?? DEFAULT_MAX_CUTS,
      );
      progress.cuts = cutInfo.cuts;
      progress.overCap = cutInfo.overCap;
    }
    const cuts = new Set(progress.cuts);

    // The uninterrupted run, both sides in lockstep, keeping each side's state texts; the ports keep its restore points.
    cursor.stage = "setup";
    sides.left.start();
    sides.right.start();
    const states: { readonly left: string[]; readonly right: string[] } = { left: [], right: [] };
    let ended: { readonly left: SideOutcome; readonly right: SideOutcome };
    {
      let state = 0;
      const at = () => ({ tail: "uninterrupted" as const, cut: null, state });
      cursor.stage = "opening";
      let records = {
        left: written("left", () => sides.left.opening(0), at()),
        right: written("right", () => sides.right.opening(0), at()),
      };
      cursor.stage = "step";
      for (;;) {
        compare(records.left, records.right, { ...at(), against: "other-side" });
        states.left.push(records.left.state);
        states.right.push(records.right.state);
        if (cuts.has(state)) {
          cursor.stage = "capture";
          sides.left.capture(state);
          sides.right.capture(state);
          cursor.stage = "step";
        }
        const leftNext = sides.left.next(0);
        const rightNext = sides.right.next(0);
        if (leftNext.kind === "end" || rightNext.kind === "end") {
          const unfinished = { kind: "censored", reason: "the other side ended first" } as const;
          ended = {
            left: leftNext.kind === "end" ? leftNext.outcome : unfinished,
            right: rightNext.kind === "end" ? rightNext.outcome : unfinished,
          };
          break;
        }
        // A run that would take a step past the limit is censored before it takes it; one that ends at the limit is not.
        if (state >= maxSteps) {
          const censored = { kind: "censored", reason: `${maxSteps} steps` } as const;
          outcomes = { left: censored, right: censored };
          throw new Stop({ kind: "not-compared", side: "left", because: "censored" });
        }
        state += 1;
        progress.steps = state;
        records = {
          left: written("left", () => sides.left.apply(0), at()),
          right: written("right", () => sides.right.apply(0), at()),
        };
      }
    }
    outcomes = ended;
    compareData(ended.left, ended.right, {
      tail: "uninterrupted",
      cut: null,
      state: progress.steps,
      against: "other-side",
    });

    // Every restore route from every cut, both sides in lockstep, to the end.
    cursor.stage = "restore";
    for (const cut of progress.cuts)
      for (const tail of RESTORE_TAILS) {
        const runs = { left: sides.left.restore(tail, cut), right: sides.right.restore(tail, cut) };
        let state = cut;
        const at = () => ({ tail, cut, state });
        let records = {
          left: written("left", () => sides.left.opening(runs.left.run), at()),
          right: written("right", () => sides.right.opening(runs.right.run), at()),
        };
        for (;;) {
          compare(records.left, records.right, { ...at(), against: "other-side" });
          for (const side of ["left", "right"] as const) {
            const expected = states[side][state]!;
            if (state !== cut && records[side].state === expected) continue;
            // EVIDENCE: validation: `states` holds `canonicalText` of a record's state, which `JSON.parse` reads back.
            const reference = JSON.parse(expected) as SideRecord["state"];
            // A restored state has no operation that led to it, which its uninterrupted counterpart has.
            const counterpart =
              state === cut
                ? { ...reference, operation: "restore", host: null, result: null, decisions: [] }
                : reference;
            // Within one side the identity holds: both records are the same build's.
            const within = compareStructures(
              { state: counterpart },
              { state: records[side].record.state },
              { limit },
            );
            if (!within.equal)
              throw new Stop({
                kind: "discrepancy",
                at: { ...at(), against: "uninterrupted" },
                mismatches: within.mismatches,
              });
          }
          if (!runs.left.live || !runs.right.live) break;
          const leftNext = sides.left.next(runs.left.run);
          const rightNext = sides.right.next(runs.right.run);
          const leftEnd = leftNext.kind === "end" ? leftNext.outcome : null;
          const rightEnd = rightNext.kind === "end" ? rightNext.outcome : null;
          // Each side's restored run ends as, and where, its uninterrupted run ended.
          const ends = compareStructures(
            state === progress.steps
              ? { left: ended.left, right: ended.right }
              : { left: null, right: null },
            { left: leftEnd, right: rightEnd },
            { limit },
          );
          if (!ends.equal)
            throw new Stop({
              kind: "discrepancy",
              at: { ...at(), against: "uninterrupted" },
              mismatches: ends.mismatches,
            });
          if (leftNext.kind === "end" || rightNext.kind === "end") break;
          state += 1;
          progress.tailSteps += 1;
          records = {
            left: written("left", () => sides.left.apply(runs.left.run), at()),
            right: written("right", () => sides.right.apply(runs.right.run), at()),
          };
        }
      }
    return report({ kind: "equivalent" });
  } catch (error) {
    if (error instanceof Stop) {
      if (error.outcome !== null)
        outcomes = { ...outcomes, [error.outcome.side]: error.outcome.outcome };
      return report(error.verdict);
    }
    // A side's failure a port reported as classified data, across processes.
    if (error instanceof PortFailure) {
      outcomes = { ...outcomes, [error.failure.side]: error.failure.outcome };
      return report({
        kind: "not-compared",
        side: error.failure.side,
        because: error.failure.outcome.kind,
      });
    }
    // Any other exception is a side's failure: at the latched callback that failed, or at the cursor.
    const at: Latched =
      error instanceof CallbackFailure
        ? error.failure
        : { side: cursor.side, stage: cursor.stage, member: cursor.member, error };
    const outcome = classifiedFailure(at);
    outcomes = { ...outcomes, [at.side]: outcome };
    return report({ kind: "not-compared", side: at.side, because: outcome.kind });
  }
}
