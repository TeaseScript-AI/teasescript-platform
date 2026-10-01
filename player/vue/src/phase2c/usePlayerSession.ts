import { computed, ref, shallowRef } from "vue";
import {
  restorePlayerRuntimeSession,
  type PlayerRuntimeRestorePoint,
  type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";

// Presentation lifecycle around the canonical runtime session. The adapter session stays the only
// Player state; this host only records which session is shown and when presentation must reset.
export function usePlayerSession() {
  const session = shallowRef<PlayerRuntimeSession | null>(null);
  // A new session remounts the transcript; any session change resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);

  function start(next: PlayerRuntimeSession) {
    generation.value++;
    interactionReset.value++;
    session.value = next;
  }
  function restore(point: PlayerRuntimeRestorePoint) {
    interactionReset.value++;
    session.value = restorePlayerRuntimeSession(point);
  }
  // Publishes the result of a completed runtime action.
  function update(next: PlayerRuntimeSession) {
    session.value = next;
  }
  function clear() {
    session.value = null;
  }

  return {
    session: computed(() => session.value),
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    start,
    restore,
    update,
    clear,
  };
}

export type PlayerSessionHost = ReturnType<typeof usePlayerSession>;
