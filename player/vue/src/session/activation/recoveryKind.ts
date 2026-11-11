/*
 * What a lost engine connection leaves the player to recover (PLAYER-UI "Session end and failure"): the one function
 * that decides it from the Player's state at the loss.
 */

/** A shown session's status, as the Player's state names it, or `null` while none shows. */
export type ShownStatus = "ready" | "running" | "waiting" | "halted" | "failed";

/** The Player's state at the loss, as `recoveryKind` reads it. */
export interface LossState {
  /** Whether the Player was unmounted. */
  readonly disposed: boolean;
  /** Whether a replacement can prepare the script again in a fresh connection. */
  readonly replaceable: boolean;
  /** The status of the session shown, or `null`. */
  readonly shown: ShownStatus | null;
  /** Whether the session shown is a state Debug's rewind restored for inspection, whose live session it left. */
  readonly inspecting: boolean;
  /** The kind of the player's Start or Continue click still under way, or `null`. */
  readonly clicking: "start" | "continue" | null;
  /** The kind of the Start or Continue the start page offers, or `null`. */
  readonly prepared: "start" | "continue" | null;
}

/**
 * What the player can recover after the loss:
 * - `kept`: a session that ran or waited stopped; Continue is offered when the browser keeps an unended point of it,
 *   else Start again (the offer reads the store);
 * - `start` or `continue` with `shown`: a click lost before its session showed; the start page offers it again;
 * - `start` or `continue` without `shown`: the start page offered it and stays as it is; its click recovers;
 * - `ended`: the session ended before the loss; its end shows as it is, and the next Start recovers;
 * - `null`: nothing to recover from the page (the Player's error stop): no replacement, the page unmounted, or a loss
 *   before the start page was prepared.
 */
export type Recovery =
  | { readonly kind: "kept" }
  | { readonly kind: "start" | "continue"; readonly shown: boolean }
  | { readonly kind: "ended" };

export function recoveryKind(state: LossState): Recovery | null {
  if (state.disposed || !state.replaceable) return null;
  if (state.clicking !== null) return { kind: state.clicking, shown: true };
  // An inspected state, also an ended one, stands for the live session it left, which a keep never left behind.
  if (state.inspecting) return { kind: "kept" };
  switch (state.shown) {
    case "ready":
    case "running":
    case "waiting":
      return { kind: "kept" };
    case "halted":
    case "failed":
      return { kind: "ended" };
    case null:
      return state.prepared === null ? null : { kind: state.prepared, shown: false };
    default:
      // A status this Player does not know: the error stop.
      return null;
  }
}
