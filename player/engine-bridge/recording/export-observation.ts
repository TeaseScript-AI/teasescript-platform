import { exactly, isRecord } from "../argument-checks.js";

/*
 * The export observation (L5h.3b): what a debug export of a session observes in the host, decided by one function,
 * `advanceExportObservation`, over closed observations. A diagnostic run is the Player activation that a Start or a
 * Continue begins, before any session exists; a rewind, a Return and Debug-off's reinstatement keep it. A Player error
 * stop is requested on receipt of its halt and committed once the work already running settled: the first committed
 * stop is the run's incident, which later stops never replace. A capture while a stop of its run is pending is refused
 * for retry, so pending never reads as a proved absence of error. Diagnostic connection state: it allocates nothing a
 * client holds.
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
 * Begins run `begin.run`, ending `begin.retires`, unless the owner saw it already. Every host message that names an
 * activation's run carries its begin (a Start's, an introduction's and Continue's handoff, a halt's and an incident's
 * stop arguments), and goes through here or `beginRun` first: whichever reaches the host first begins the run.
 */
export function ensureRun(owner: ExportObservation, begin: RunBegin): void {
  if (owner.runs.has(begin.run)) return;
  advanceExportObservation(owner, { kind: "beginRun", run: begin.run, retires: begin.retires });
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

/** The connection's export observation: its runs, by their number. */
export class ExportObservation {
  readonly runs = new Map<number, Run>();
  /** The run the Player began last: a session introduced now binds to it. */
  current: number | null = null;
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
  /** The run's incident after a commit, or as a capture reads it: `null` when the run committed none. */
  | { readonly kind: "incident"; readonly incident: ExportIncident | null }
  /** A capture met a stop of its run that is not committed yet: it is refused for retry. */
  | { readonly kind: "pending" };

/**
 * Decides observation `observation` of `owner`. A stop or capture of a run the owner does not hold (never begun, or
 * retired) records nothing and reads no incident: the conservative default never invents one.
 */
export function advanceExportObservation(
  owner: ExportObservation,
  observation: Observation,
): ObservationOutcome {
  switch (observation.kind) {
    case "beginRun": {
      if (observation.retires !== null) owner.runs.delete(observation.retires);
      if (!owner.runs.has(observation.run))
        owner.runs.set(observation.run, { pending: new Set(), incident: null });
      owner.current = observation.run;
      return { kind: "recorded" };
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
      owner.runs.get(observation.stop.run)?.pending.add(observation.stop.stop);
      return { kind: "recorded" };
    }
    case "stopCommitted": {
      const { stop, session } = observation;
      const run = owner.runs.get(stop.run);
      if (run === undefined) return { kind: "incident", incident: null };
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
      owner.runs.delete(observation.run);
      if (owner.current === observation.run) owner.current = null;
      return { kind: "recorded" };
    }
  }
}
