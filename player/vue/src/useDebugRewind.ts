import { computed } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import type { PlayerSessionHost } from "./usePlayerSession";

/**
 * Debug's rewind (DEBUGGER.md "Rewind") while the Debug features run: the view of the shown session's history, which
 * the engine's host keeps (`player/engine-bridge/history/`), and Back, Forward, Resume, and Return. Everything they
 * decide is the Player's rewind owner's (`rewind.owner`, `rewindOwner.ts`), which outlives this scope: it opens the
 * history as the scope begins and closes it as the scope ends, as Debug off, or as the Player's disposal when the Player
 * itself unmounts (`endWithPlayer`).
 */
export function useDebugRewind(player: PlayerSessionHost) {
  const { rewind } = player;
  const { owner } = rewind;
  let ended = false;
  // Set when the Player itself unmounts, which ends the history as its disposal, not as Debug off.
  let withPlayer = false;
  // The host may become reachable after the scope began, or never; Debug runs once it is, while the scope lives.
  void player.bridge.then(
    () => ended || owner.debugOn(),
    // A host that never became reachable is the bridge promise's failure, which the composable reports itself.
    () => {},
  );
  tryOnScopeDispose(() => {
    ended = true;
    if (withPlayer) owner.disposal();
    else owner.debugOff();
  });

  return {
    /** The history's state, recomputed whenever it changes. */
    state: computed(() => {
      // The view changes in place: its revision says when.
      void owner.revision.value;
      const timeline = owner.view.value?.timeline ?? null;
      return {
        /** The open history's serial in the host, or `null` while none is open. */
        history: timeline?.history ?? null,
        points: timeline?.points ?? [],
        inspection: timeline?.inspection ?? null,
        shown: timeline?.inspection?.shown ?? null,
        future: timeline?.inspection?.future ?? null,
        complete: timeline?.complete ?? true,
        memoryChars: timeline?.memoryChars ?? 0,
        spilledCount: timeline?.spilledCount ?? 0,
      };
    }),
    /** The grey future: the messages of the state Forward restores that the shown state has not reached, or `null`. */
    future: owner.future,
    /** Whether a rewind step runs now. */
    busy: owner.busy,
    /** Why the last rewind step changed nothing, or `null`. */
    problem: owner.problem,
    /** Restores the point `point` (its ID); the state left stays for Forward. Resolves to whether it was restored. */
    back: (point: number) => owner.back(point),
    /** Restores the state the last Back left. */
    forward: () => owner.forward(),
    /** Marks the coming end of these features as the Player's unmount; `usePlayerDebug` calls it as it unmounts. */
    endWithPlayer: () => {
      withPlayer = true;
    },
    /** Adopts the inspected state without new input, so it runs on; resolves to whether it was adopted. */
    resume: () => rewind.resume(),
    /** Reinstates the session the first Back left, through the restart gate; resolves to whether it was. */
    returnToSession: () => owner.returnToSession(),
  };
}

export type DebugRewind = ReturnType<typeof useDebugRewind>;
