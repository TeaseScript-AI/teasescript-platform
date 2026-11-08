import type { RecordingCaptureReply } from "../../../engine-bridge/session-protocol.js";
import type { PlayerBridge } from "../../../player-bridge.js";
import type { PlayerSession } from "../../../runtime-view.js";

/*
 * The recording up to a Player error (L5h.3b), as a debug export of the stopped session selects it: captured in the host
 * under a ticket as the stop is sent, after the work the stop lets finish, so a later restart of the recorder (Debug's
 * rewind, Return, Debug-off's reinstatement) cannot replace it. The first settled outcome of an activation stays, also
 * across later stops; the next activation or the Player's disposal retires it, releasing its ticket, and a capture that
 * settles after that is released as it arrives.
 */

/** The failure recording's state: none yet, a capture under way, or its settled outcome with its ticket. */
type FailureState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly settled: Promise<void> }
  | { readonly kind: "captured"; readonly bridge: PlayerBridge; readonly ticket: string }
  | { readonly kind: "unavailable" };

const NONE: FailureState = { kind: "none" };
const UNAVAILABLE: FailureState = { kind: "unavailable" };

export function useFailureRecording() {
  let state: FailureState = NONE;
  /** Counts the activations: a capture of an earlier one settles into nothing. */
  let generation = 0;

  /**
   * Settles the capture of `generation` with `reply`, or with `null` for a capture that failed or was lost: the one place
   * a capture's outcome lands. A capture of a retired activation, or after a first outcome, releases its ticket.
   */
  function settle(bridge: PlayerBridge, of: number, reply: RecordingCaptureReply | null): void {
    const ticket = reply?.kind === "captured" ? reply.ticket : null;
    if (of !== generation || state.kind !== "pending") {
      if (ticket !== null) void bridge.releaseRecording(ticket).catch(() => {});
      return;
    }
    state = ticket === null ? UNAVAILABLE : { kind: "captured", bridge, ticket };
  }

  return {
    /**
     * Captures the recording of `stopped`, the session a Player error stopped, once per activation: a later stop keeps the
     * first capture. Sent right after the stop's halt, so the host captures after the work the stop lets finish.
     */
    stopped(stopped: PlayerSession): void {
      if (state.kind !== "none") return;
      const bridge = stopped.connection;
      const of = generation;
      const settled = bridge.read(stopped, "captureRecording").then(
        (reply) => settle(bridge, of, reply),
        () => settle(bridge, of, null),
      );
      state = { kind: "pending", settled };
    },
    /**
     * Before the host restarts the recorder (Debug's rewind, Return, Debug-off's reinstatement): resolves once the failure
     * capture under way settled, never rejecting; at once without one.
     */
    beforeRestart(): Promise<void> {
      return state.kind === "pending" ? state.settled : Promise.resolve();
    },
    /** The ticket of the captured failure recording, or `null`: none, still pending, or unavailable. */
    ticket(): { readonly bridge: PlayerBridge; readonly ticket: string } | null {
      return state.kind === "captured" ? state : null;
    },
    /**
     * The recording a debug export selects, once a capture under way settled: the failure's ticket; `none` when it
     * settled unavailable, which never means the recorder's later recording; `current` when no Player error captured.
     */
    async selection(): Promise<
      "current" | "none" | { readonly bridge: PlayerBridge; readonly ticket: string }
    > {
      if (state.kind === "pending") await state.settled;
      // The settlement replaced the state; `state` is read again here.
      const settled: FailureState = state;
      if (settled.kind === "captured") return settled;
      return settled.kind === "unavailable" ? "none" : "current";
    },
    /** Retires the activation's failure recording, at the next activation or the Player's disposal. */
    retire(): void {
      generation += 1;
      if (state.kind === "captured")
        void state.bridge.releaseRecording(state.ticket).catch(() => {});
      state = NONE;
    },
  };
}
