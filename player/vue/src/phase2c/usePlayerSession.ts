import { computed, ref, shallowRef } from "vue";
import type { PlayerRuntimeSession } from "../../../runtime-adapter.js";
import { useRuntimeSceneClock } from "./useRuntimeSceneClock";

// Presentation lifecycle around the canonical runtime session. The adapter session stays the only
// Player state; this host records which session is shown, when presentation must reset, and maps
// browser time onto the session's scene time.
export function usePlayerSession() {
  const session = shallowRef<PlayerRuntimeSession | null>(null);
  // A new session remounts the transcript and resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);
  const clock = useRuntimeSceneClock(session);

  // Starts or restores a session; its scene time continues from the persisted observation, so a
  // gap while no Player ran is not consumed.
  function start(next: PlayerRuntimeSession) {
    generation.value++;
    interactionReset.value++;
    session.value = next;
    clock.rebase();
  }
  // Publishes the result of a completed runtime action.
  function update(next: PlayerRuntimeSession) {
    session.value = next;
  }

  return {
    session: computed(() => session.value),
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    /** Presented runtime timers; hidden timers have no entry. */
    timers: clock.timers,
    /** Observes elapsed time, runs the session, and returns the published session. */
    observe: clock.observe,
    start,
    update,
  };
}

export type PlayerSessionHost = ReturnType<typeof usePlayerSession>;
