import type {
  MediaProgressReport,
  RuntimeScriptStorageEntrySnapshot,
  TemporalContext,
} from "../../../src/playback.js";
import type { RuntimePlayerProfileInput } from "../../../src/runtime/host-data/player-profile.js";
import {
  adoptPlayerRuntimeCatchUp,
  beginPlayerRuntimeCatchUp,
  beginPlayerRuntimeRecording,
  continuePlayerRuntimeSession,
  createPlayerRuntimeSession,
  dropPlayerRuntimeCatchUp,
  observePlayerRuntimeTime,
  setPlayerRuntimeRandomControl,
  skipPlayerRuntimePacing,
  stepPlayerRuntimeCatchUp,
  stepPlayerRuntimeTime,
  withPlayerRuntimeDebugTrace,
  type PlayerRuntimeCatchUp,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import { playerRuntimePacingGate } from "../../runtime-view.js";
import { isValidEpochMilliseconds } from "../../../src/temporal.js";
import {
  everyItem,
  exactly,
  isPlainRecord,
  isRecord,
  isStringArray,
  isTime,
} from "../argument-checks.js";
import { instructionFacts } from "../instruction-facts.js";
import type { RandomControlOptions } from "../../../src/runtime/random/random-control.js";
import { type PlayerOpsContext } from "../player-ops.js";
import {
  alignRandom,
  isRandomIntent,
  ownedRandom,
  type RandomIntent,
} from "../connection-state.js";
import { planMetadata, type PlanMetadata } from "../plan-facts.js";
import { NO_MARKS, marksAfterEdit, type HistoryMarks } from "../../debug-history-marks.js";
import type { CallViewReply, Introduction, Publication, StopReply } from "../session-protocol.js";
import {
  advanceExportObservation,
  ensureRun,
  isRunBegin,
  RetiredRunError,
  isStopArguments,
  runIncident,
  type RunBegin,
  type ObservedSession,
  type SessionObservation,
} from "../recording/export-observation.js";
import type { BridgeOp, BridgeOps, HostSession, OpOutcome } from "../worker-host.js";

/** What adopting an op's result session did (`HeldSession.adoptResult`). */
export type Adoption =
  | { readonly kind: "same" }
  | { readonly kind: "kept" }
  | { readonly kind: "published"; readonly view: Publication };

const SAME: Adoption = Object.freeze({ kind: "same" });
const KEPT: Adoption = Object.freeze({ kind: "kept" });

/**
 * A session the host holds: the adapter's session at its latest publication, and how many of its events the host has
 * handed out (the cursor every publication starts from). A late observation's catch-up stays inside it.
 */
let nextHistoryKey = 1;

export class HeldSession implements HostSession, ObservedSession {
  #current: PlayerRuntimeSession;
  #delivered = 0;
  readonly #connection: PlayerOpsContext;
  /** The late observation being caught up on a copy of the runner, or `null`; see `endCatchUp`. */
  #catchUp: PlayerRuntimeCatchUp | null = null;
  /**
   * The Player whose random control the session runs with (`RandomState.owner`): the one that started it, or that
   * adopted it (`adoptRandom`); `null` for a session nobody holds, as a restore until its adoption, or a Continue's
   * session it released (`releaseRandom`) until its kept draw went on.
   */
  #owner: number | null;
  /** The random control the session's engine runs with now. */
  #control: RandomControlOptions | null;
  /** Whether the main side views the session's calls (`viewCalls`): its publications then carry the call view. */
  viewingCalls = false;
  /**
   * The session's marks for a debug export (`HistoryMarks`): given at its construction, by every route that makes one,
   * and changed only by an applied storage edit (`marksEdited`). Every publication carries them.
   */
  #marks: HistoryMarks;
  /** The key Debug's rewind history names this session's lineage by (`HistoryRegistry`). */
  readonly historyKey = `l${nextHistoryKey++}`;
  /** The diagnostic run the session belongs to (`ExportObservation`), bound as it is made; `null` outside any run. */
  run: number | null = null;
  /** The session's latest publication as the export observes it. */
  observation: SessionObservation | null = null;
  /** The Player error stop that froze the session (`atStop`), or `null`: a debug export's diagnostic identity. */
  stoppedBy: number | null = null;

  constructor(
    session: PlayerRuntimeSession,
    readonly planToken: string,
    connection: PlayerOpsContext,
    marks: HistoryMarks,
    owner: number | null = null,
    control: RandomControlOptions | null = null,
  ) {
    this.#current = session;
    this.#connection = connection;
    this.#marks = marks;
    this.#owner = owner;
    this.#control = control;
    // Every route that makes a session binds it to the Player's current run before it publishes.
    this.bindRun();
  }

  /** Binds the session to the connection's current run, as it is made and as Continue hands an existing one over. */
  bindRun(): void {
    const owner = this.#connection.exportObservation;
    advanceExportObservation(owner, { kind: "bindSession", session: this, run: owner.current });
  }

  /**
   * The session at its latest publication, made ready for an operation: the connection's value trace and its owner's
   * random control reach it here, a change since applied as a keep that publishes nothing. A changed control ends a
   * catch-up in flight first, so no draw runs with the control a newer intent replaced. Every op that runs the session
   * calls this; only `adoptCatchUp` adopts a copy, from `publication`, which changes nothing.
   */
  sessionForOperation(): PlayerRuntimeSession {
    const trace = this.#connection.trace;
    if (this.#current.debugTrace !== trace)
      this.#current = withPlayerRuntimeDebugTrace(this.#current, trace);
    // A session nobody holds runs with none; one of a Player that ended keeps its own, which decides nothing.
    const owned = ownedRandom(this.#connection, this.#owner);
    const control = owned !== null ? owned.control : this.#owner === null ? null : this.#control;
    const { status } = this.#current.state;
    if (control !== this.#control && status !== "halted" && status !== "failed") {
      const catchUp = this.endCatchUp();
      if (catchUp !== null) dropPlayerRuntimeCatchUp(catchUp);
      setPlayerRuntimeRandomControl(this.#current, control);
      this.#control = control;
    }
    return this.#current;
  }

  /** The session at its latest publication as it is, changing nothing: for adopting a catch-up only. */
  get publication(): PlayerRuntimeSession {
    return this.#current;
  }

  /** The session's marks now. */
  get marks(): HistoryMarks {
    return this.#marks;
  }

  /** Records an applied storage edit at the session's observed time, in the edit's own host step. */
  marksEdited(): void {
    this.#marks = marksAfterEdit(this.#marks, this.#current.state.observedSessionTimeMs);
  }

  /** The Player whose random control the session runs with, or `null`. */
  get owner(): number | null {
    return this.#owner;
  }

  /**
   * Gives the session `owner`'s random control from its next operation on, as Start and Continue do; `null` gives up
   * any, as a Continue's restored session does until its kept draw went on naturally.
   */
  adopt(owner: number | null): void {
    this.#owner = owner;
  }

  /** The catch-up in flight, or `null`. */
  get catchUp(): PlayerRuntimeCatchUp | null {
    return this.#catchUp;
  }

  /** Begins `catchUp`; one in flight must have ended first (`endCatchUp`). */
  beginCatchUp(catchUp: PlayerRuntimeCatchUp): void {
    this.#catchUp = catchUp;
  }

  /**
   * Ends the catch-up in flight and returns it, or `null`: the only way one ends, which every op that ends or replaces
   * one calls before it calls `sessionForOperation`.
   */
  endCatchUp(): PlayerRuntimeCatchUp | null {
    const catchUp = this.#catchUp;
    this.#catchUp = null;
    return catchUp;
  }

  get revision(): number {
    return this.#current.revision;
  }

  /** How many of the session's events the host has handed out: the events a capture of its state goes with. */
  get delivered(): number {
    return this.#delivered;
  }

  /** Whether an op made from `basis` may run, by the adapter's rule (`PlayerRuntimeEngine.accepts`). */
  accepts(basis: number | null): boolean {
    return basis === null || this.#current.engine.accepts(basis);
  }

  /** Whether the session's runner ended with a call that threw; its next use rebuilds it from the recorder. */
  get broken(): boolean {
    return this.#current.engine.broken;
  }

  /**
   * Makes `next` the session's latest publication without handing it out, as when a recorder is attached: what it shows
   * reaches the main side with the next publication.
   */
  keep(next: PlayerRuntimeSession): void {
    this.#current = next;
  }

  /**
   * Makes `next` the latest publication and hands it out: its critical state, revision, the events after the cursor,
   * and the call view while the main side views the session's calls.
   */
  publish(next: PlayerRuntimeSession): Publication {
    this.#current = next;
    // Every publication passes the connection's rewind history, which takes a point from this same `next`.
    const history = this.#connection.history.observePublication(this, next);
    const from = this.#delivered;
    const through = next.events.length;
    this.#delivered = through;
    const { calls, ...state } = next.state;
    const owner = this.#connection.exportObservation;
    // The export observes what the engine holds, which a failed delivery does not undo, unlike the history's record of
    // what the page was shown: the capture's identity match then refuses until a publication the page applied.
    advanceExportObservation(owner, {
      kind: "publication",
      session: this,
      revision: next.revision,
      eventsThrough: through,
    });
    return Object.freeze({
      revision: next.revision,
      state: Object.freeze(state),
      from,
      eventsThrough: through,
      events: next.events.slice(from),
      instructions: instructionFacts(next, this.viewingCalls),
      callView: this.viewingCalls ? Object.freeze({ calls }) : null,
      marks: this.#marks,
      diagnostic: Object.freeze({ run: this.run, stop: null }),
      incident: runIncident(owner, this.run),
      history,
    });
  }

  /**
   * Adopts `next`, the session an op returned, and says what it did: the session itself changes nothing (`same`);
   * another of the same revision, as a trace-only or recorder wrapper, is kept without publishing (`kept`); a new
   * revision is published once, with the events after the cursor (`published`). The UI never received a same-revision
   * publication: the main side's store drops one whose revision is not newer than its own (`SessionStore.apply`). What
   * the op returns and whether it ends a catch-up stay its own.
   */
  adoptResult(next: PlayerRuntimeSession): Adoption {
    if (next === this.#current) return SAME;
    if (next.revision === this.#current.revision) {
      this.keep(next);
      return KEPT;
    }
    return { kind: "published", view: this.publish(next) };
  }

  /** The latest publication's call view, with its instruction facts: with the calls when `calls`, else none. */
  callView(calls: boolean): CallViewReply {
    const current = this.#current;
    return Object.freeze({
      revision: current.revision,
      instructions: instructionFacts(current, calls),
      callView: calls ? Object.freeze({ calls: current.state.calls }) : null,
    });
  }

  /** Whether `args` are a Player error stop's (`StopArguments`); a plain halt, as of a superseded session, has none. */
  checkStop(args: unknown): boolean {
    return isStopArguments(args);
  }

  /**
   * A Player error stop of this session arrived: the run's capture waits for its commit. The stopped session is the
   * stop's run's, also a Continue's restored session the error stopped before Continue handed it over (`bindRun`).
   * `false` for a stop of a run that ended, which changes nothing and is refused (`halt`); a plain halt is admitted.
   */
  stopRequested(args: unknown): boolean {
    if (!isStopArguments(args)) return true;
    const owner = this.#connection.exportObservation;
    // The stop's run begins here when the host has not seen it, as when its Continue failed before its handoff.
    if (!ensureRun(owner, args)) return false;
    advanceExportObservation(owner, { kind: "bindSession", session: this, run: args.run });
    return (
      advanceExportObservation(owner, { kind: "stopRequested", stop: args }).kind === "admitted"
    );
  }

  /**
   * What `halt`'s acknowledgement carries: the call view of the publication the stop froze, viewed or not; for a Player
   * error stop, also its diagnostic identity and the run's incident, which the stop commits now, as the work running at
   * it settled. A stop whose run ended meanwhile commits nothing and carries the call view only.
   */
  atStop(args: unknown = null): CallViewReply | StopReply {
    const view = this.callView(true);
    if (!isStopArguments(args)) return view;
    const committed = advanceExportObservation(this.#connection.exportObservation, {
      kind: "stopCommitted",
      stop: args,
      session: this.observation,
    });
    if (committed.kind !== "incident") return view;
    const { incident } = committed;
    // The first stop froze the session; a later one changes neither it nor the run's incident.
    this.stoppedBy ??= args.stop;
    return Object.freeze({
      ...view,
      diagnostic: Object.freeze({ run: args.run, stop: args.stop }),
      incident,
    });
  }

  /** The session's first publication, from cursor 0, with its fixed fields; nothing was handed out before it. */
  introduce(metadata: PlanMetadata | null): Introduction {
    this.#delivered = 0;
    const publication = this.publish(this.sessionForOperation());
    return Object.freeze({
      ...publication,
      from: 0,
      planToken: this.planToken,
      metadata,
      liveEventSequence: this.#current.liveEventSequence,
      historyKey: this.historyKey,
    });
  }
}

/** The data options of a Start, as `start` takes them; the recorder, trace and random control are the host's. */
export interface StartOptions {
  readonly scriptStorage?: readonly RuntimeScriptStorageEntrySnapshot[];
  readonly persistentScriptStorage?: boolean;
  readonly temporalContext?: TemporalContext;
  readonly wallClockMs?: number;
  readonly debugMode?: boolean;
  readonly storedFiles?: readonly string[];
  readonly playerProfile?: RuntimePlayerProfileInput;
}

const START_OPTIONS = [
  "scriptStorage",
  "persistentScriptStorage",
  "temporalContext",
  "wallClockMs",
  "debugMode",
  "storedFiles",
  "playerProfile",
];

/** A wall clock's moment: whole epoch milliseconds within the engine's years 0000–9999, also before 1970. */
const isEpochTime = (value: unknown): value is number =>
  typeof value === "number" && isValidEpochMilliseconds(value);

/**
 * The shape of `start`'s options, a plain record (a `Date` or a `Map` is none); the engine validates their content as it
 * starts the session.
 */
function isStartOptions(value: unknown): value is StartOptions {
  return (
    isPlainRecord(value) &&
    exactly(value, [], START_OPTIONS) &&
    (value.scriptStorage === undefined || everyItem(value.scriptStorage, isRecord)) &&
    (value.persistentScriptStorage === undefined ||
      typeof value.persistentScriptStorage === "boolean") &&
    (value.temporalContext === undefined || isRecord(value.temporalContext)) &&
    (value.wallClockMs === undefined || isEpochTime(value.wallClockMs)) &&
    (value.debugMode === undefined || typeof value.debugMode === "boolean") &&
    (value.storedFiles === undefined || isStringArray(value.storedFiles)) &&
    (value.playerProfile === undefined || isRecord(value.playerProfile))
  );
}

const isMediaReport = (value: unknown): boolean =>
  isRecord(value) &&
  exactly(value, ["mediaId", "segment", "progressMs"]) &&
  typeof value.mediaId === "number" &&
  typeof value.segment === "number" &&
  typeof value.progressMs === "number";

/** What a session op works on: the session the request names, as the host holds it. */
function heldOf(session: { readonly value: HostSession } | null): HeldSession {
  // EVIDENCE: validation: every session the Player's ops add is a HeldSession, and the host passes an existing one.
  return session!.value as HeldSession;
}

/** Whether an op's error left the runner ended (reported, not deleting the session, which recovers on its next use). */
const ended = (_error: unknown, session: HostSession | null): boolean =>
  session instanceof HeldSession && session.broken;

/** A session op's outcome: `result`, with the publication of `next` when it is a new revision (`adoptResult`). */
export function publishing(
  held: HeldSession,
  next: PlayerRuntimeSession,
  result: unknown,
): OpOutcome {
  const adoption = held.adoptResult(next);
  if (adoption.kind !== "published") return { result, view: null };
  return { result, eventsThrough: adoption.view.eventsThrough, view: adoption.view };
}

/** An op of an existing session, which reads its basis unless `readsBasis` is false. */
export function sessionOp(
  checkArguments: (args: unknown) => boolean,
  run: (held: HeldSession, args: unknown) => OpOutcome,
  readsBasis = true,
): BridgeOp {
  return {
    session: "existing",
    readsBasis,
    checkArguments,
    run: (args, _sessions, session) => run(heldOf(session), args),
    ended,
  };
}

/*
 * L5b's ops: Start, Continue, time (observe, step, catch-up) and pacing skip, and the recording's start. Each wraps
 * the adapter's function of the same work; `basis` is the revision the caller acted on.
 */
/** A time observation at `atMs`, with the media progress played; a basis an op since replaced refuses it. */
const observeTime = sessionOp(
  (args) =>
    isRecord(args) &&
    exactly(args, ["atMs", "media"]) &&
    isTime(args.atMs) &&
    everyItem(args.media, isMediaReport),
  (held, args) => {
    // EVIDENCE: validation: checkArguments accepted these arguments before run.
    const { atMs, media } = args as {
      readonly atMs: number;
      readonly media: readonly MediaProgressReport[];
    };
    held.endCatchUp();
    const result = observePlayerRuntimeTime(held.sessionForOperation(), atMs, media);
    return publishing(held, result.session, result.outcome);
  },
);

export function sessionOps(context: PlayerOpsContext): BridgeOps {
  return {
    start: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["plan", "options", "recording"], ["random", "run"]) &&
        typeof args.plan === "string" &&
        isStartOptions(args.options) &&
        typeof args.recording === "boolean" &&
        (args.random === undefined || isStartRandom(args.random)) &&
        (args.run === undefined || isRunBegin(args.run)),
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { plan, options, recording, random, run } = args as {
          readonly plan: string;
          readonly options: StartOptions;
          readonly recording: boolean;
          readonly random?: StartRandom;
          readonly run?: RunBegin;
        };
        // The Start's run begins before its session, which binds to it; a Start of a run that ended starts nothing.
        if (run !== undefined && !ensureRun(context.exportObservation, run))
          throw new RetiredRunError(run.run);
        const instructions = context.plans.get(plan);
        if (instructions === undefined) throw new Error(`No plan '${plan}' is held.`);
        const control = startRandom(context, random);
        const held = new HeldSession(
          createPlayerRuntimeSession(instructions, {
            ...options,
            ...(recording ? { recorder: context.recorder } : {}),
            ...(context.trace === null ? {} : { debugTrace: context.trace }),
            ...(control === null ? {} : { randomControl: control }),
          }),
          plan,
          context,
          NO_MARKS,
          random?.owner ?? null,
          control,
        );
        const id = sessions.add(held);
        const view = held.introduce(null);
        return { result: null, session: id, eventsThrough: view.eventsThrough, view };
      },
    },
    continue: sessionOp(
      (args) =>
        isRecord(args) &&
        exactly(args, ["capture"]) &&
        isRecord(args.capture) &&
        exactly(args.capture, ["wallClockMs", "temporalContext"]) &&
        isEpochTime(args.capture.wallClockMs) &&
        isRecord(args.capture.temporalContext),
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { capture } = args as {
          readonly capture: {
            readonly wallClockMs: number;
            readonly temporalContext: TemporalContext;
          };
        };
        const result = continuePlayerRuntimeSession(held.sessionForOperation(), capture);
        return publishing(held, result.session, result.outcome);
      },
    ),
    observeTime,
    // The input chain's observation (L5c), which reads no basis: an input's staleness is its action ID's.
    observeInput: { ...observeTime, readsBasis: false },
    stepTime: sessionOp(
      (args) => isRecord(args) && exactly(args, ["targetMs"]) && isTime(args.targetMs),
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { targetMs } = args as { readonly targetMs: number };
        held.endCatchUp();
        const next = stepPlayerRuntimeTime(held.sessionForOperation(), targetMs);
        return publishing(held, next, { moved: next !== held.sessionForOperation() });
      },
    ),
    beginCatchUp: sessionOp(
      (args) => isRecord(args) && exactly(args, ["targetMs"]) && isTime(args.targetMs),
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { targetMs } = args as { readonly targetMs: number };
        const replaced = held.endCatchUp();
        if (replaced !== null) dropPlayerRuntimeCatchUp(replaced);
        held.beginCatchUp(beginPlayerRuntimeCatchUp(held.sessionForOperation(), targetMs));
        return { result: null, view: null };
      },
    ),
    stepCatchUp: sessionOp(
      (args) => isRecord(args) && exactly(args, ["budgetMs"]) && isTime(args.budgetMs),
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { budgetMs } = args as { readonly budgetMs: number };
        const catchUp = held.catchUp;
        if (catchUp === null) return { result: "dropped", view: null };
        // A duration on the host's own clock: after each step the catch-up goes on while it lasts.
        const until = performance.now() + budgetMs;
        const step = stepPlayerRuntimeCatchUp(catchUp, () => performance.now() < until);
        if (step === "dropped") held.endCatchUp();
        return { result: step, view: null };
      },
      false,
    ),
    adoptCatchUp: sessionOp(
      (args) => args === null,
      (held) => {
        // The copy ran with the control it began with: it is adopted on the publication as it is, and published before
        // anything calls `sessionForOperation`, which attaches a control changed since.
        const catchUp = held.endCatchUp();
        const adopted =
          catchUp === null ? null : adoptPlayerRuntimeCatchUp(held.publication, catchUp);
        if (adopted === null) return { result: { adopted: false }, view: null };
        const view = held.publish(adopted);
        return { result: { adopted: true }, eventsThrough: view.eventsThrough, view };
      },
      false,
    ),
    dropCatchUp: sessionOp(
      (args) => args === null,
      (held) => {
        const dropped = held.endCatchUp();
        if (dropped !== null) dropPlayerRuntimeCatchUp(dropped);
        return { result: null, view: null };
      },
      false,
    ),
    skipPacing: sessionOp(
      (args) => isRecord(args) && exactly(args, ["actionId"]) && typeof args.actionId === "number",
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { actionId } = args as { readonly actionId: number };
        // The gate the caller saw: input never targets another action.
        if (playerRuntimePacingGate(held.sessionForOperation())?.actionId !== actionId)
          return { result: null, view: null };
        held.endCatchUp();
        const result = skipPlayerRuntimePacing(held.sessionForOperation());
        return result === null
          ? { result: null, view: null }
          : publishing(held, result.session, result.outcome);
      },
      // Input: its staleness is the gate's action ID, checked above, not a basis (L5c).
      false,
    ),
    // Starts or ends the call view of the session's publications (L5f). Its reply is the latest publication's call view,
    // which the main side merges into the publication of the same revision; it publishes nothing.
    viewCalls: sessionOp(
      (args) => isRecord(args) && exactly(args, ["on"]) && typeof args.on === "boolean",
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted `on` as a boolean.
        const { on } = args as { readonly on: boolean };
        held.viewingCalls = on;
        return { result: held.callView(on), view: null };
      },
      false,
    ),
    beginRecording: sessionOp(
      (args) => args === null || isRunBegin(args),
      (held, args) => {
        // Continue hands over a session the Player held already: it begins Continue's run, which the session joins.
        // EVIDENCE: validation: the op's check admitted `null` or a run's begin.
        const run = args as RunBegin | null;
        if (run !== null && !ensureRun(context.exportObservation, run))
          throw new RetiredRunError(run.run);
        held.bindRun();
        beginRecordingAt(held, context);
        return { result: null, view: null };
      },
    ),
  };
}

/**
 * The random part of work that begins a session: the Player that starts it, whose session it is from its first
 * statement, and its newest random intent, which the host aligns to first (Sol r1 R2 of L5i.3, for random control).
 */
export interface StartRandom {
  readonly owner: number;
  readonly intent?: RandomIntent;
}

const isStartRandom = (value: unknown): value is StartRandom =>
  isRecord(value) &&
  exactly(value, ["owner"], ["intent"]) &&
  typeof value.owner === "number" &&
  Number.isSafeInteger(value.owner) &&
  value.owner >= 1 &&
  (value.intent === undefined ||
    (isRandomIntent(value.intent) && value.intent.owner === value.owner));

/** Aligns to a Start's random intent; the control its owner's session starts with, or `null`. */
export function startRandom(
  context: PlayerOpsContext,
  random: StartRandom | undefined,
): RandomControlOptions | null {
  if (random === undefined) return null;
  if (random.intent !== undefined) alignRandom(context, random.intent);
  return ownedRandom(context, random.owner)?.control ?? null;
}

/** Begins the connection's recording at `held` as it stands, as Continue and Debug's Return do. */
export function beginRecordingAt(held: HeldSession, context: PlayerOpsContext): void {
  const attached = Object.freeze({ ...held.sessionForOperation(), recorder: context.recorder });
  beginPlayerRuntimeRecording(attached, context.recorder);
  held.keep(attached);
}

/** A held session's introduction, with its plan's metadata when the plan is its own. */
export function introduction(
  held: HeldSession,
  context: PlayerOpsContext,
  own: boolean,
): Introduction {
  const plan = context.plans.get(held.planToken);
  return held.introduce(own && plan !== undefined ? planMetadata(plan) : null);
}
