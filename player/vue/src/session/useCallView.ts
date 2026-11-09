import { watch, type Ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { type PlayerSession } from "../../../runtime/runtime-view.js";
import { bridgeOf, endsQuietly, refusalCode } from "../../../runtime/player-bridge.js";

/*
 * Debug's call view (L5f), moved from `usePlayerSession` unchanged: who asks for the shown session's active calls, and
 * the requests that follow the shown lineage while anyone does.
 */

/** What the call view needs from the Player's session composable. */
interface CallViewHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly isDisposed: () => boolean;
  readonly publishOwned: (next: PlayerSession) => PlayerSession | null;
  readonly reportPageError: (error: unknown) => void;
}

export function useCallView({
  session,
  stopped,
  isDisposed,
  publishOwned,
  reportPageError,
}: CallViewHost) {
  // The call view (L5f): Debug's Now view and the error dialog read the active calls, which only publications of a
  // session whose calls are viewed carry. While any demand stands, the shown session's calls are viewed; the view moves
  // with the shown lineage, as Debug's rewind and Return move it, and ends with the last demand. A stopped session needs
  // no request: its stop's acknowledgement froze it with its call view.
  let callDemands = 0;
  let callViewed: PlayerSession | null = null;
  function viewCalls(target: PlayerSession, on: boolean) {
    void bridgeOf(target)
      .viewCalls(target, on)
      .then(
        (merged) => {
          if (merged !== null) publishOwned(merged);
        },
        (error) => {
          // A stopped or released session, or a lost Worker, takes no call view: the stop or the loss reports itself, and
          // nothing ends further.
          if (endsQuietly(error) || refusalCode(error) === "session") return;
          if (!isDisposed() && !stopped.value && session.value?.lineage === target.lineage)
            reportPageError(error);
        },
      );
  }
  function followCallView() {
    const shown = isDisposed() || stopped.value || callDemands === 0 ? null : session.value;
    if (callViewed !== null && callViewed.lineage !== shown?.lineage) {
      if (!stopped.value) viewCalls(callViewed, false);
      callViewed = null;
    }
    if (shown !== null && callViewed === null) {
      callViewed = shown;
      viewCalls(shown, true);
    }
  }
  watch([() => session.value?.lineage, stopped], followCallView);
  tryOnScopeDispose(() => {
    callDemands = 0;
    followCallView();
  });
  /** Asks for the shown session's call view until `release`, which only the first call of does anything. */
  function demandCallView(): { release(): void } {
    callDemands += 1;
    followCallView();
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        callDemands -= 1;
        followCallView();
      },
    };
  }
  return { demandCallView };
}
