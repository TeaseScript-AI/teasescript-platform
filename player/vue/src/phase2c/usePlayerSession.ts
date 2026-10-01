import { computed, ref, shallowRef } from "vue";
import type { PlayerRuntimeSession } from "../../../runtime-adapter.js";

// Presentation lifecycle around the canonical runtime session. The adapter session stays the only
// Player state; this host only records which session is shown and when presentation must reset.
export function usePlayerSession() {
  const session = shallowRef<PlayerRuntimeSession | null>(null);
  // A new session remounts the transcript and resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);

  function start(next: PlayerRuntimeSession) {
    generation.value++;
    interactionReset.value++;
    session.value = next;
  }
  // Publishes the result of a completed runtime action.
  function update(next: PlayerRuntimeSession) {
    session.value = next;
  }

  return {
    session: computed(() => session.value),
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    start,
    update,
  };
}

export type PlayerSessionHost = ReturnType<typeof usePlayerSession>;
