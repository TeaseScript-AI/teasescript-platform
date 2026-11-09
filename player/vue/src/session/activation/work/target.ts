import type { StopArguments } from "../../../../../engine-bridge/recording/export-observation.js";
import type { BridgeResult } from "../../../../../engine-bridge/client.js";
import type { RandomIntent, TracingIntent } from "../../../../../engine-bridge/player-ops.js";
import { bridgeOf } from "../../../../../player-bridge.js";
import type { PlayerSession } from "../../../../../runtime-view.js";
import type { TemporalCapture } from "../useSessionActivation.js";
import { stopArguments, type Origin, type useActivationRun } from "../useActivationRun.js";

/** The activations' record owner, whose admission each operation asks at its action. */
type Runs = Pick<ReturnType<typeof useActivationRun>, "admits">;

/*
 * The session an activation's work acts on, as that work may hold it (session split S2, HEAD 0 §2): bound to the
 * activation's origin and to the session's connection, with only the operations the work uses. Each operation admits
 * its origin immediately before it acts, and refuses a retired one (`RetiredActivation`); the work never holds the
 * session, its bridge or its client. A target is made only synchronously, from a session in hand.
 */

/** What work decides on, copied from a target's session: no callable, bridge or ref is in it. */
export interface SessionSnapshot {
  readonly id: string;
  readonly status: PlayerSession["state"]["status"];
  /** The random draw the session is paused at, or `null`. */
  readonly randomDrawId: number | null;
  readonly debugMode: boolean;
}

/** A target's operation refused because its origin retired: the work goes no further. */
export class RetiredActivation extends Error {
  override readonly name = "RetiredActivation";
}

export interface SessionTarget {
  /** The session's state as plain data, now. */
  snapshot(): SessionSnapshot;
  /** The session's latest publication, as a target bound to the same origin. */
  latest(): SessionTarget;
  /** Gives the session up from this Player's random control, after its earlier requests; its failure is quiet. */
  releaseRandom(): void;
  /** Begins the host's recording of the session for the origin's run. */
  beginRecording(): Promise<void>;
  /** Begins a new epoch of the host's value trace with `tracing`. */
  restartTrace(tracing: TracingIntent): Promise<void>;
  /** Lets the random draw `drawId` the session is paused at go on with its natural outcome. */
  resolveDrawNaturally(drawId: number): Promise<void>;
  /** Tells the script whether Debug is on. */
  setDebugMode(on: boolean): Promise<void>;
  /** Continues the session with the click's `capture`. */
  continueWith(capture: TemporalCapture): Promise<void>;
  /** Gives the session this Player's random control from its next op on: the host's reply, with the revision. */
  adoptRandom(intent: RandomIntent): Promise<BridgeResult>;
  /**
   * Tells the script whether Debug is on, its publications shown through `publish` while the origin lives: whether the
   * host set it (`set`) or found it so.
   */
  setDebugModeShown(
    on: boolean,
    publish: (next: PlayerSession) => void,
  ): Promise<{ readonly kind: string }>;
}

// Each target's session, which only the scheduler reads back (`sessionOf`), to install it.
const sessions = new WeakMap<object, PlayerSession>();

/** A target for `session`, acting for `origin` while `runs` admits it. */
export function sessionTarget(session: PlayerSession, origin: Origin, runs: Runs): SessionTarget {
  const host = bridgeOf(session);
  const admit = () => {
    if (!runs.admits(origin))
      throw new RetiredActivation("The activation this work began in retired.");
  };
  const target: SessionTarget = {
    snapshot: () => ({
      id: session.id,
      status: session.state.status,
      randomDrawId: session.state.randomDraw?.drawId ?? null,
      debugMode: session.state.debugMode,
    }),
    latest: () => sessionTarget(host.latest(session) ?? session, origin, runs),
    releaseRandom() {
      admit();
      void host.client
        .request("releaseRandom", { session: session.id }, { after: session.id })
        .catch(() => {});
    },
    beginRecording() {
      admit();
      if (origin.kind !== "run") throw new TypeError("The initial record has no run to record.");
      return host.request<void>(session, "beginRecording", origin.begin);
    },
    restartTrace(tracing) {
      admit();
      return host.request<void>(session, "restartTrace", { tracing });
    },
    resolveDrawNaturally(drawId) {
      admit();
      return host.request<void>(session, "resolveDraw", {
        drawId,
        outcome: "natural",
        record: null,
      });
    },
    setDebugMode(on) {
      admit();
      return host.request<void>(session, "setDebugMode", { on });
    },
    continueWith(capture) {
      admit();
      return host.request<void>(session, "continue", { capture });
    },
    adoptRandom(intent) {
      admit();
      return host.client.request(
        "adoptRandom",
        { session: session.id, intent },
        { after: session.id },
      );
    },
    setDebugModeShown(on, publish) {
      admit();
      return host.request<{ readonly kind: string }>(
        session,
        "setDebugMode",
        { on },
        // The publication shows only while the origin lives: a retired activation's reply shows nothing.
        { publish: (next) => void (runs.admits(origin) && publish(next)) },
      );
    },
  };
  sessions.set(target, session);
  return target;
}

/**
 * The session a Player error stops, as the stop's work holds it: bound to the stop's origin (the initial record, or an
 * activation's run). Its halt and the failure capture admit that origin first.
 */
export interface StopTarget {
  /** Stops the session at error `error`, stop `stop`; resolves once its store froze at the host's acknowledgement. */
  halt(error: string, stop: number): Promise<void>;
  /** Whether the session's store already froze, as it does at once in-process. */
  frozen(): boolean;
  /** Captures the run's failure recording of the stopped session, once per run; none for the initial record. */
  captureFailure(): void;
}

// Each stop target's session, which only the scheduler reads back to commit the final publication (`stoppedSession`).
const stopped = new WeakMap<object, PlayerSession>();

/** A stop target for `session`, acting for `origin` while `runs` admits it. */
export function stopTarget(session: PlayerSession, origin: Origin, runs: Runs): StopTarget {
  const host = bridgeOf(session);
  const retired = () => new RetiredActivation("The activation this stop began in retired.");
  const target: StopTarget = {
    halt(error, stop) {
      if (!runs.admits(origin)) throw retired();
      const args: StopArguments | null = stopArguments(origin, error, stop);
      return host.halt(session, args);
    },
    frozen: () => host.frozen(session),
    captureFailure() {
      if (!runs.admits(origin)) throw retired();
      if (origin.kind === "run") origin.failure.stopped(session);
    },
  };
  stopped.set(target, session);
  return target;
}

/** The session a stop target names, and its connection's latest publication of it: the scheduler's, to commit it. */
export function stoppedSession(target: StopTarget): {
  readonly session: PlayerSession;
  readonly final: PlayerSession | null;
} {
  const session = stopped.get(target);
  if (session === undefined) throw new TypeError("Not a stop target.");
  return { session, final: bridgeOf(session).latest(session) };
}

/** Commits the no-session incident of a Player error in `origin`'s run, while it lives; none for the initial record. */
export function commitIncident(origin: Origin, error: string, stop: number, runs: Runs): void {
  const args = stopArguments(origin, error, stop);
  if (origin.kind === "run" && args !== null && runs.admits(origin))
    void origin.bridge.commitIncident(args).catch(() => {});
}

/** Whether `value` is a target (a Continue's begin gives one; a Start's gives its session). */
export function isSessionTarget(value: PlayerSession | SessionTarget): value is SessionTarget {
  return sessions.has(value);
}

/** The session a target names: the scheduler's, to install it. */
export function sessionOf(target: SessionTarget): PlayerSession {
  const session = sessions.get(target);
  if (session === undefined) throw new TypeError("Not a session target.");
  return session;
}
