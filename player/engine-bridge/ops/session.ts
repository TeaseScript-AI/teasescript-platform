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
  skipPlayerRuntimePacing,
  stepPlayerRuntimeCatchUp,
  stepPlayerRuntimeTime,
  type PlayerRuntimeCatchUp,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import { playerRuntimePacingGate } from "../../runtime-view.js";
import { isValidEpochMilliseconds } from "../../../src/temporal.js";
import { everyItem, exactly, isRecord, isStringArray, isTime } from "../argument-checks.js";
import { instructionFacts } from "../instruction-facts.js";
import { planMetadata, type PlanMetadata, type PlayerOpsContext } from "../player-ops.js";
import type { CallViewReply, Introduction, Publication } from "../session-protocol.js";
import type { BridgeOp, BridgeOps, HostSession, OpOutcome } from "../worker-host.js";

/**
 * A session the host holds: the adapter's session at its latest publication, and how many of its events the host has
 * handed out (the cursor every publication starts from). A late observation's catch-up stays inside it.
 */
export class HeldSession implements HostSession {
  #current: PlayerRuntimeSession;
  #delivered = 0;
  /** The late observation being caught up on a copy of the runner, or `null`. */
  catchUp: PlayerRuntimeCatchUp | null = null;
  /** Whether the main side views the session's calls (`viewCalls`): its publications then carry the call view. */
  viewingCalls = false;

  constructor(
    session: PlayerRuntimeSession,
    readonly planToken: string,
  ) {
    this.#current = session;
  }

  get current(): PlayerRuntimeSession {
    return this.#current;
  }

  get revision(): number {
    return this.#current.revision;
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
    const from = this.#delivered;
    const through = next.events.length;
    this.#delivered = through;
    const { calls, ...state } = next.state;
    return Object.freeze({
      revision: next.revision,
      state: Object.freeze(state),
      from,
      eventsThrough: through,
      events: next.events.slice(from),
      instructions: instructionFacts(next, this.viewingCalls),
      callView: this.viewingCalls ? Object.freeze({ calls }) : null,
    });
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

  /** What `halt`'s acknowledgement carries: the call view of the publication the stop froze, viewed or not. */
  atStop(): CallViewReply {
    return this.callView(true);
  }

  /** The session's first publication, from cursor 0, with its fixed fields; nothing was handed out before it. */
  introduce(metadata: PlanMetadata | null): Introduction {
    this.#delivered = 0;
    const publication = this.publish(this.#current);
    return Object.freeze({
      ...publication,
      from: 0,
      planToken: this.planToken,
      metadata,
      liveEventSequence: this.#current.liveEventSequence,
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

/** The shape of `start`'s options; the engine validates their content as it starts the session. */
function isStartOptions(value: unknown): value is StartOptions {
  return (
    isRecord(value) &&
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

/** A session op that publishes `next` when it differs from the session it ran on. */
export function publishing(
  held: HeldSession,
  next: PlayerRuntimeSession,
  result: unknown,
): OpOutcome {
  if (next === held.current) return { result, view: null };
  const view = held.publish(next);
  return { result, eventsThrough: view.eventsThrough, view };
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

/**
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
    held.catchUp = null;
    const result = observePlayerRuntimeTime(held.current, atMs, media);
    return publishing(held, result.session, result.outcome);
  },
);

export function sessionOps(context: PlayerOpsContext): BridgeOps {
  return {
    start: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["plan", "options", "recording"]) &&
        typeof args.plan === "string" &&
        isStartOptions(args.options) &&
        typeof args.recording === "boolean",
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { plan, options, recording } = args as {
          readonly plan: string;
          readonly options: StartOptions;
          readonly recording: boolean;
        };
        const instructions = context.plans.get(plan);
        if (instructions === undefined) throw new Error(`No plan '${plan}' is held.`);
        const held = new HeldSession(
          createPlayerRuntimeSession(instructions, {
            ...options,
            ...(recording ? { recorder: context.recorder } : {}),
          }),
          plan,
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
        const result = continuePlayerRuntimeSession(held.current, capture);
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
        held.catchUp = null;
        const next = stepPlayerRuntimeTime(held.current, targetMs);
        return publishing(held, next, { moved: next !== held.current });
      },
    ),
    beginCatchUp: sessionOp(
      (args) => isRecord(args) && exactly(args, ["targetMs"]) && isTime(args.targetMs),
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { targetMs } = args as { readonly targetMs: number };
        if (held.catchUp !== null) dropPlayerRuntimeCatchUp(held.catchUp);
        held.catchUp = beginPlayerRuntimeCatchUp(held.current, targetMs);
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
        if (step === "dropped") held.catchUp = null;
        return { result: step, view: null };
      },
      false,
    ),
    adoptCatchUp: sessionOp(
      (args) => args === null,
      (held) => {
        const catchUp = held.catchUp;
        held.catchUp = null;
        const adopted = catchUp === null ? null : adoptPlayerRuntimeCatchUp(held.current, catchUp);
        return adopted === null
          ? { result: { adopted: false }, view: null }
          : publishing(held, adopted, { adopted: true });
      },
      false,
    ),
    dropCatchUp: sessionOp(
      (args) => args === null,
      (held) => {
        if (held.catchUp !== null) dropPlayerRuntimeCatchUp(held.catchUp);
        held.catchUp = null;
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
        if (playerRuntimePacingGate(held.current)?.actionId !== actionId)
          return { result: null, view: null };
        held.catchUp = null;
        const result = skipPlayerRuntimePacing(held.current);
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
      (args) => args === null,
      (held) => {
        // The connection's recorder records the session from its state now, as Continue attaches it today.
        const attached = Object.freeze({ ...held.current, recorder: context.recorder });
        beginPlayerRuntimeRecording(attached, context.recorder);
        held.keep(attached);
        return { result: null, view: null };
      },
    ),
  };
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
