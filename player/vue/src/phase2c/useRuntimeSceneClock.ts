import { computed, ref, watch, type ShallowRef } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import type { MediaProgressReport } from "../../../../src/index.js";
import {
  observePlayerRuntimeTime,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";

const DISPLAY_REFRESH_MS = 250;
// Browsers fire longer `setTimeout` delays immediately; a later wake-up re-schedules the rest.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Maps monotonic browser time onto the session's persisted scene time. The engine reads no clock: this Player
 * observes time at the next deadline, before input, before a checkpoint capture, and at page lifecycle changes.
 * Scene time continues while the page is hidden; a new or restored session is rebased so an unavailable gap is not
 * consumed. Every observation carries the media progress `mediaReports` measures, so media cues follow what was
 * actually played.
 */
export function useRuntimeSceneClock(
  session: ShallowRef<PlayerRuntimeSession | null>,
  mediaReports: () => readonly MediaProgressReport[] = () => [],
) {
  let origin = performance.now();
  const displayTimeMs = ref(0);

  function sceneTimeMs(current: PlayerRuntimeSession): number {
    return Math.max(current.snapshot.observedSessionTimeMs, performance.now() - origin);
  }

  /** Continues from the session's persisted time; call after starting or restoring a session. */
  function rebase() {
    const current = session.value;
    if (!current) return;
    origin = performance.now() - current.snapshot.observedSessionTimeMs;
    displayTimeMs.value = current.snapshot.observedSessionTimeMs;
  }

  /** Submits an ordinary time observation and publishes the resulting session. */
  function observe(): PlayerRuntimeSession | null {
    const current = session.value;
    if (!current) return null;
    const result = observePlayerRuntimeTime(current, sceneTimeMs(current), mediaReports());
    if (result.outcome.kind === "observed") session.value = result.session;
    return session.value;
  }

  let wakeUp: ReturnType<typeof setTimeout> | undefined;
  function scheduleWakeUp(current: PlayerRuntimeSession | null) {
    if (wakeUp !== undefined) clearTimeout(wakeUp);
    wakeUp = undefined;
    if (!current) return;
    displayTimeMs.value = sceneTimeMs(current);
    const deadlines = playerRuntimeDeadlines(current.snapshot);
    if (deadlines.length === 0) return;
    const delay = Math.min(...deadlines) - sceneTimeMs(current);
    wakeUp = setTimeout(observe, Math.min(MAX_TIMEOUT_MS, Math.max(0, delay)));
  }
  watch(session, scheduleWakeUp, { immediate: true });
  tryOnScopeDispose(() => scheduleWakeUp(null));

  const timers = computed(() =>
    session.value ? playerRuntimeTimers(session.value.snapshot, displayTimeMs.value) : [],
  );
  // Presentation estimates only; canonical scene time advances through observations.
  const refresh = useIntervalFn(
    () => {
      if (session.value) displayTimeMs.value = sceneTimeMs(session.value);
    },
    DISPLAY_REFRESH_MS,
    { immediate: false },
  );
  watch(
    () => timers.value.length > 0,
    (presented) => (presented ? refresh.resume() : refresh.pause()),
    { immediate: true },
  );

  // Visibility changes are observation opportunities in both directions; they never pause scene time.
  useEventListener(document, "visibilitychange", observe);
  useEventListener(window, "pagehide", observe);
  useEventListener(window, "pageshow", observe);

  return { timers, observe, rebase };
}
