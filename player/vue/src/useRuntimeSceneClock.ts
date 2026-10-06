import { computed, ref, shallowReactive, watch, type Ref, type ShallowRef } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import type { MediaProgressReport } from "../../../src/index.js";
import {
  observePlayerRuntimeTime,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";

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
  /** While it holds, scene time stands at the last observation and nothing is observed; rebase when it ends. */
  paused: Readonly<Ref<boolean>> = ref(false),
) {
  let origin = performance.now();
  const displayTimeMs = ref(0);

  function sceneTimeMs(current: PlayerRuntimeSession): number {
    if (paused.value) return current.snapshot.observedSessionTimeMs;
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
    if (!current || paused.value) return current;
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
    if (paused.value) return;
    // A queued timer or media block waits for a pending storage write, and catch-up holds at its due time: an overdue
    // deadline cannot progress until the acknowledgement, whose published session schedules again. Without a queued
    // block, deadlines are observed as usual.
    if (
      pendingPlayerRuntimeStorageWrite(current.snapshot) &&
      current.snapshot.pendingTimerHandlers.length > 0
    )
      return;
    const deadlines = playerRuntimeDeadlines(current.snapshot);
    if (deadlines.length === 0) return;
    const delay = Math.min(...deadlines) - sceneTimeMs(current);
    wakeUp = setTimeout(observe, Math.min(MAX_TIMEOUT_MS, Math.max(0, delay)));
  }
  watch([session, paused], () => scheduleWakeUp(session.value), { immediate: true });
  tryOnScopeDispose(() => scheduleWakeUp(null));

  const timers = computed(() =>
    session.value ? playerRuntimeTimers(session.value.snapshot, displayTimeMs.value) : [],
  );
  // Presentation estimates only; canonical scene time advances through observations. Presented timers keep the estimate
  // current, and so does any other presentation that asks while it is shown, such as a Debug countdown.
  const refreshDemands = shallowReactive(new Set<() => boolean>());
  const refresh = useIntervalFn(
    () => {
      if (session.value) displayTimeMs.value = sceneTimeMs(session.value);
    },
    DISPLAY_REFRESH_MS,
    { immediate: false },
  );
  watch(
    () => timers.value.length > 0 || [...refreshDemands].some((demand) => demand()),
    (presented) => {
      if (!presented) return refresh.pause();
      // A stopped estimate may be long stale: sample at once rather than at the first interval.
      if (session.value) displayTimeMs.value = sceneTimeMs(session.value);
      refresh.resume();
    },
    { immediate: true },
  );
  /** Keeps the display estimate refreshing while `demand` holds, until the calling scope ends. */
  function refreshWhile(demand: () => boolean) {
    refreshDemands.add(demand);
    tryOnScopeDispose(() => refreshDemands.delete(demand));
  }

  // Visibility changes are observation opportunities in both directions; they never pause scene time.
  useEventListener(document, "visibilitychange", observe);
  useEventListener(window, "pagehide", observe);
  useEventListener(window, "pageshow", observe);

  return {
    timers,
    observe,
    rebase,
    /** The display estimate of scene time; it refreshes only while something presented needs it. */
    displayTimeMs: computed(() => displayTimeMs.value),
    refreshWhile,
  };
}
