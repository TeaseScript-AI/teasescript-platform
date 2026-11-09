import type { TracingIntent } from "../../../../../engine-bridge/player-ops.js";
import { bridgeOf } from "../../../../../player-bridge.js";
import type { PlayerSession } from "../../../../../runtime-view.js";
import type { TemporalCapture } from "../useSessionActivation.js";
import type { Origin, RunOrigin } from "../useActivationRun.js";

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
}

// Each target's session, which only the scheduler reads back (`sessionOf`), to install it.
const sessions = new WeakMap<object, PlayerSession>();

/** A target for `session`, acting for `origin` while `admits` says it lives. */
export function sessionTarget(
  session: PlayerSession,
  origin: RunOrigin,
  admits: (origin: Origin) => boolean,
): SessionTarget {
  const host = bridgeOf(session);
  const admit = () => {
    if (!admits(origin)) throw new RetiredActivation("The activation this work began in retired.");
  };
  const target: SessionTarget = {
    snapshot: () => ({
      id: session.id,
      status: session.state.status,
      randomDrawId: session.state.randomDraw?.drawId ?? null,
      debugMode: session.state.debugMode,
    }),
    latest: () => sessionTarget(host.latest(session) ?? session, origin, admits),
    releaseRandom() {
      admit();
      void host.client
        .request("releaseRandom", { session: session.id }, { after: session.id })
        .catch(() => {});
    },
    beginRecording() {
      admit();
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
  };
  sessions.set(target, session);
  return target;
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
