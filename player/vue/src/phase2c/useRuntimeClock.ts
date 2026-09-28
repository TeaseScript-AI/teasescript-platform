import { onBeforeUnmount, onMounted, watch, type ShallowRef } from "vue";
import { useEventListener } from "@vueuse/core";
import { observePlayerRuntimeTime, type PlayerRuntimeSession } from "../../../runtime-adapter.js";

export function useRuntimeClock(session: ShallowRef<PlayerRuntimeSession | null>) {
  let sessionTimeOriginMs = performance.now();
  let timeTimer: ReturnType<typeof setTimeout> | null = null;

  function observeCurrentTime() {
    const current = session.value;
    if (!current) return;
    const now = Math.max(
      current.snapshot.currentSessionTimeMs,
      Math.floor(performance.now() - sessionTimeOriginMs),
    );
    const result = observePlayerRuntimeTime(current, now);
    if (result.outcome.kind === "invalidObservation") throw new Error(result.outcome.message);
    session.value = result.session;
  }

  function scheduleTimeObservation() {
    if (timeTimer !== null) clearTimeout(timeTimer);
    timeTimer = null;
    const current = session.value;
    if (!current) return;
    let nextDeadline = Infinity;
    for (const action of [
      current.snapshot.foregroundAction,
      ...current.snapshot.backgroundActions,
    ]) {
      if (action?.kind === "delay" || action?.kind === "chatPacingGate") {
        nextDeadline = Math.min(nextDeadline, action.deadlineMs);
      }
    }
    if (nextDeadline === Infinity) return;
    const now = Math.max(
      current.snapshot.currentSessionTimeMs,
      Math.floor(performance.now() - sessionTimeOriginMs),
    );
    timeTimer = setTimeout(
      observeCurrentTime,
      Math.min(Math.max(0, nextDeadline - now) + 1, 2_147_483_647),
    );
  }

  function resetOrigin(current: PlayerRuntimeSession) {
    sessionTimeOriginMs = performance.now() - current.snapshot.currentSessionTimeMs;
  }

  watch(session, scheduleTimeObservation);
  onMounted(scheduleTimeObservation);
  onBeforeUnmount(() => {
    if (timeTimer !== null) clearTimeout(timeTimer);
  });
  useEventListener(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") observeCurrentTime();
  });

  return { resetOrigin };
}
