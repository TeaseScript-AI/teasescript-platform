import { exactly, isRecord } from "../argument-checks.js";

/*
 * The export observation (L5h.3b): what a debug export of a session observes in the host, decided by one function,
 * `advanceExportObservation`, over closed observations. A diagnostic run is the Player activation that a Start or a
 * Continue begins, before any session exists; a rewind, a Return and Debug-off's reinstatement keep it. A Player error
 * stop is requested on receipt of its halt and committed once the work already running settled: the first committed
 * stop is the run's incident, which later stops never replace. A capture while a stop of its run is pending is refused
 * for retry, so pending never reads as a proved absence of error. Diagnostic connection state: it allocates nothing a
 * client holds.
 *
 * Retirement is absorbing. The connection's runs are numbered upward (`PlayerBridge`'s allocation), and one Player at a
 * time owns the connection, so a run begun ends every earlier one: `retiredThrough` is the highest run that ended, and
 * a begin, stop or commit of a run at or below it is refused before any effect, also when it arrives late or before the
 * host saw its run begin. Every adapter of a run's begin or stop consumes that admission (design round r2).
 */

/** A Player error that stopped a session: its error name, its run and stop, and the session's observation then. */
export interface ExportIncident {
  readonly errorName: string;
  readonly run: number;
  readonly stop: number;
  /** The stopped session's revision and delivered event boundary; `null` for a run that failed before any session. */
  readonly revision: number | null;
  readonly eventsThrough: number | null;
}

/** The diagnostic identity a publication or a stop's acknowledgement carries: its run, and the stop it committed. */
export interface DiagnosticIdentity {
  readonly run: number | null;
  readonly stop: number | null;
}

/** The run's committed incident: what a publication carries beside its marks, `null` without one. */
export function runIncident(owner: ExportObservation, run: number | null): ExportIncident | null {
  return run === null ? null : (owner.runs.get(run)?.incident ?? null);
}

/** Whether `value` is a Player error stop's arguments: an error name, and whole run, stop and `retires` numbers. */
export function isStopArguments(value: unknown): value is StopArguments {
  return (
    isRecord(value) &&
    exactly(value, ["error", "run", "stop", "retires"]) &&
    typeof value.error === "string" &&
    Number.isSafeInteger(value.run) &&
    Number.isSafeInteger(value.stop) &&
    (value.retires === null || Number.isSafeInteger(value.retires))
  );
}

/**
 * Admits run `begin.run`: whether it is the live run, begun now or already. Every host message that names an
 * activation's run carries its begin (a Start's, an introduction's and Continue's handoff, a halt's and an incident's
 * stop arguments) and goes through here first, so whichever reaches the host first begins the run and a repeat of the
 * live run changes nothing. `false` for a run that ended (`retiredThrough`): its message has no effect.
 */
export function ensureRun(owner: ExportObservation, begin: RunBegin): boolean {
  const outcome = advanceExportObservation(owner, {
    kind: "beginRun",
    run: begin.run,
    retires: begin.retires,
  });
  return outcome.kind === "admitted";
}

/** What a host op of an ended run throws, before any effect: a late or retired activation's begin or incident. */
export class RetiredRunError extends Error {
  readonly code = "retired";
  constructor(run: number) {
    super(`Diagnostic run ${run} has ended.`);
    this.name = "RetiredRunError";
  }
}

/** An activation's run, which a Start, Continue's handoff or an introduction carries: its number, and the run it ends. */
export interface RunBegin {
  readonly run: number;
  readonly retires: number | null;
}

/** Whether `value` is a run's begin: whole numbers, `retires` `null` when no run ends. */
export function isRunBegin(value: unknown): value is RunBegin {
  return (
    isRecord(value) &&
    exactly(value, ["run", "retires"]) &&
    Number.isSafeInteger(value.run) &&
    (value.retires === null || Number.isSafeInteger(value.retires))
  );
}

/**
 * The arguments of a Player error stop (a halt, or `commitIncident` without a session): the validated error name, with
 * its run and stop identity, and the run its activation ends (`RunBegin`).
 */
export interface StopArguments extends RunBegin {
  readonly error: string;
  readonly stop: number;
}

/** What a session supplies as its latest observation: its run, revision and delivered event boundary. */
export interface SessionObservation {
  readonly run: number | null;
  readonly revision: number;
  readonly eventsThrough: number;
}

/** A held session as the owner observes it: its run, and its latest publication's observation. */
export interface ObservedSession {
  run: number | null;
  observation: SessionObservation | null;
}

interface Run {
  /** The stops of the run requested and not yet committed. */
  readonly pending: Set<number>;
  incident: ExportIncident | null;
}

/** The connection's export observation: its live runs, by their number, and how far runs ended. */
export class ExportObservation {
  readonly runs = new Map<number, Run>();
  /** The run the Player began last, while it lives: a session introduced now binds to it. */
  current: number | null = null;
  /** Every run through this number ended, begun or not; none of them begins again. */
  retiredThrough = 0;
}

export type Observation =
  /** A Start or a Continue began run `run`; `retires` is the Player's run before it, which ends. */
  | { readonly kind: "beginRun"; readonly run: number; readonly retires: number | null }
  /** A session was introduced in run `run` (a Start, a restore, Continue's handoff), before it publishes. */
  | { readonly kind: "bindSession"; readonly session: ObservedSession; readonly run: number | null }
  /** A session published `revision`, delivering its events through `eventsThrough`. */
  | {
      readonly kind: "publication";
      readonly session: ObservedSession;
      readonly revision: number;
      readonly eventsThrough: number;
    }
  /** A stop's halt arrived. */
  | { readonly kind: "stopRequested"; readonly stop: StopArguments }
  /** The work running at the stop settled: `session` is the stopped session's observation, or `null` without one. */
  | {
      readonly kind: "stopCommitted";
      readonly stop: StopArguments;
      readonly session: SessionObservation | null;
    }
  /** An export capture of run `run`. */
  | { readonly kind: "capture"; readonly run: number | null }
  /** The Player retired run `run` (its disposal). */
  | { readonly kind: "retire"; readonly run: number };

export type ObservationOutcome =
  | { readonly kind: "recorded" }
  /** A begin or stop of a live run: what the adapter goes on with. */
  | { readonly kind: "admitted" }
  /** A begin, stop or commit of a run that ended: nothing changed. */
  | { readonly kind: "refused" }
  /** The run's incident after a commit, or as a capture reads it: `null` when the run committed none. */
  | { readonly kind: "incident"; readonly incident: ExportIncident | null }
  /** A capture met a stop of its run that is not committed yet: it is refused for retry. */
  | { readonly kind: "pending" };

/**
 * Decides observation `observation` of `owner`. A stop of a run that ended is refused; a capture of a run the owner
 * does not hold (never begun, or ended) reads no incident: the conservative default never invents one.
 */
export function advanceExportObservation(
  owner: ExportObservation,
  observation: Observation,
): ObservationOutcome {
  switch (observation.kind) {
    case "beginRun": {
      const { run } = observation;
      if (run <= owner.retiredThrough) return { kind: "refused" };
      if (run === owner.current) return { kind: "admitted" };
      // Runs are numbered upward and one Player owns the connection: a newer run ends every earlier one, the
      // activation's declared predecessor (`retires`) among them, begun or not.
      retireThrough(owner, run - 1);
      owner.runs.set(run, { pending: new Set(), incident: null });
      owner.current = run;
      return { kind: "admitted" };
    }
    case "bindSession": {
      observation.session.run = observation.run;
      return { kind: "recorded" };
    }
    case "publication": {
      const { session, revision, eventsThrough } = observation;
      session.observation = { run: session.run, revision, eventsThrough };
      return { kind: "recorded" };
    }
    case "stopRequested": {
      const run = owner.runs.get(observation.stop.run);
      if (run === undefined) return { kind: "refused" };
      run.pending.add(observation.stop.stop);
      return { kind: "admitted" };
    }
    case "stopCommitted": {
      const { stop, session } = observation;
      // Rechecked at the commit: a run that ended while the stop's work settled commits nothing.
      const run = owner.runs.get(stop.run);
      if (run === undefined) return { kind: "refused" };
      run.pending.delete(stop.stop);
      run.incident ??= {
        errorName: stop.error,
        run: stop.run,
        stop: stop.stop,
        revision: session?.revision ?? null,
        eventsThrough: session?.eventsThrough ?? null,
      };
      return { kind: "incident", incident: run.incident };
    }
    case "capture": {
      if (observation.run === null) return { kind: "incident", incident: null };
      const run = owner.runs.get(observation.run);
      if (run === undefined) return { kind: "incident", incident: null };
      if (run.pending.size > 0) return { kind: "pending" };
      return { kind: "incident", incident: run.incident };
    }
    case "retire": {
      retireThrough(owner, observation.run);
      return { kind: "recorded" };
    }
  }
}

/** Ends every run through `run`; a later, live run stays. */
function retireThrough(owner: ExportObservation, run: number): void {
  if (run <= owner.retiredThrough) return;
  owner.retiredThrough = run;
  for (const each of owner.runs.keys()) if (each <= run) owner.runs.delete(each);
  if (owner.current !== null && owner.current <= run) owner.current = null;
}
