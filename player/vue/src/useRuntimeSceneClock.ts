import { computed, ref, shallowReactive, watch, type Ref, type ShallowRef } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import type { MediaProgressReport } from "../../../src/index.js";
import {
  adoptPlayerRuntimeCatchUp,
  beginPlayerRuntimeCatchUp,
  dropPlayerRuntimeCatchUp,
  nextPlayerRuntimeCatchUpStepMs,
  observePlayerRuntimeTime,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  stepPlayerRuntimeCatchUp,
  type PlayerRuntimeCatchUp,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";

const DISPLAY_REFRESH_MS = 250;
// Browsers fire longer `setTimeout` delays immediately; a later wake-up re-schedules the rest.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// How long one task may catch up the events of a late observation before it gives the browser a turn. An observation
// within that time of its next event is on time and observed in one go.
const CATCH_UP_TASK_MS = 10;

/**
 * Maps monotonic browser time onto the session's persisted scene time. The engine reads no clock: this Player
 * observes time at the next deadline, before input, before a checkpoint capture, and at page lifecycle changes.
 * Scene time continues while the page is hidden; a new or restored session is rebased so an unavailable gap is not
 * consumed. Every observation carries the media progress `mediaReports` measures, so media cues follow what was
 * actually played. A late observation without media progress catches up on a copy of the session, a task at a time
 * (`catchUp`), so the page stays responsive; the session adopts the copy in one publication once it is done, and input,
 * and everything else that observes, observes in one go instead.
 */
export function useRuntimeSceneClock(
  session: ShallowRef<PlayerRuntimeSession | null>,
  mediaReports: () => readonly MediaProgressReport[] = () => [],
  /** While it holds, scene time stands at the last observation and nothing is observed; rebase when it ends. */
  paused: Readonly<Ref<boolean>> = ref(false),
  /** Whether a late observation may catch up on a copy; otherwise it is one observation. */
  copies: () => boolean = () => true,
) {
  let origin = performance.now();
  const displayTimeMs = ref(0);
  // The late observation being caught up on a copy of the session, which goes on in its own tasks.
  let pending: PlayerRuntimeCatchUp | null = null;
  let nextTask: MessagePort | null = null;

  function sceneTimeMs(current: PlayerRuntimeSession): number {
    if (paused.value) return current.state.observedSessionTimeMs;
    return Math.max(current.state.observedSessionTimeMs, performance.now() - origin);
  }

  /** Continues from the session's persisted time; call after starting or restoring a session. */
  function rebase() {
    const current = session.value;
    if (!current) return;
    origin = performance.now() - current.state.observedSessionTimeMs;
    displayTimeMs.value = current.state.observedSessionTimeMs;
  }

  /** Drops a catch-up under way; the session stays as it is. */
  function cancel() {
    nextTask?.close();
    nextTask = null;
    if (pending !== null) dropPlayerRuntimeCatchUp(pending);
    pending = null;
  }

  /**
   * Submits an ordinary time observation and publishes the resulting session. A catch-up under way is dropped: this
   * observation covers its time.
   */
  function observe(): PlayerRuntimeSession | null {
    const current = session.value;
    if (!current || paused.value) return current;
    cancel();
    const result = observePlayerRuntimeTime(current, sceneTimeMs(current), mediaReports());
    if (result.outcome.kind === "observed") session.value = result.session;
    return session.value;
  }

  /** Observes at once while a catch-up is under way, so what follows comes after it; otherwise does nothing. */
  function settle(): PlayerRuntimeSession | null {
    return pending === null ? session.value : observe();
  }

  /**
   * Observes at a deadline or another opportunity, without the result being needed at once. An observation on time,
   * or one with media progress, which is measured now, is one observation. A late one catches up on a copy of the
   * session (`beginPlayerRuntimeCatchUp`) for one task at a time and publishes nothing until the session adopts the
   * copy; if the session was used meanwhile, the copy is gone and the session observes in one go.
   */
  function catchUp() {
    const current = session.value;
    if (!current || paused.value) return;
    if (pending !== null) {
      if (copies()) return continueCatchUp(current, pending);
      // Debug started meanwhile: Debug follows every observation as it happens.
      return void observe();
    }
    const targetMs = sceneTimeMs(current);
    const reports = mediaReports();
    const stepMs = nextPlayerRuntimeCatchUpStepMs(current.state);
    if (
      reports.length > 0 ||
      !copies() ||
      stepMs === null ||
      targetMs - stepMs <= CATCH_UP_TASK_MS
    ) {
      const result = observePlayerRuntimeTime(current, targetMs, reports);
      if (result.outcome.kind === "observed") session.value = result.session;
      return;
    }
    pending = beginPlayerRuntimeCatchUp(current, targetMs);
    continueCatchUp(current, pending);
  }

  function continueCatchUp(current: PlayerRuntimeSession, catchingUp: PlayerRuntimeCatchUp) {
    const until = performance.now() + CATCH_UP_TASK_MS;
    const step = stepPlayerRuntimeCatchUp(catchingUp, () => performance.now() < until);
    // The next task goes on. A message, unlike a timer, is neither clamped nor throttled while the page is hidden,
    // where late observations mostly come from.
    if (step === "more") {
      nextTask = inNextTask(catchUp);
      return;
    }
    pending = null;
    const adopted = step === "done" ? adoptPlayerRuntimeCatchUp(current, catchingUp) : null;
    if (adopted !== null) session.value = adopted;
    else observe();
  }

  let wakeUp: ReturnType<typeof setTimeout> | undefined;
  function scheduleWakeUp(current: PlayerRuntimeSession | null) {
    if (wakeUp !== undefined) clearTimeout(wakeUp);
    wakeUp = undefined;
    // A catch-up belongs to its session and runs only while nothing holds; any other publication leaves it to notice
    // whether the session was used meanwhile.
    if (pending !== null && (paused.value || pending.engine !== current?.engine)) cancel();
    if (!current) return;
    displayTimeMs.value = sceneTimeMs(current);
    if (paused.value || pending !== null) return;
    // A queued timer or media block waits for a pending storage write, and catch-up holds at its due time: an overdue
    // deadline cannot progress until the acknowledgement, whose published session schedules again. Without a queued
    // block, deadlines are observed as usual.
    if (pendingPlayerRuntimeStorageWrite(current.state) && current.state.queuedBlocks > 0) return;
    const deadlines = playerRuntimeDeadlines(current.state);
    if (deadlines.length === 0) return;
    const delay = Math.min(...deadlines) - sceneTimeMs(current);
    wakeUp = setTimeout(catchUp, Math.min(MAX_TIMEOUT_MS, Math.max(0, delay)));
  }
  watch([session, paused], () => scheduleWakeUp(session.value), { immediate: true });
  tryOnScopeDispose(() => scheduleWakeUp(null));

  const timers = computed(() =>
    session.value ? playerRuntimeTimers(session.value.state, displayTimeMs.value) : [],
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

  // Visibility changes are observation opportunities in both directions; they never pause scene time. Hiding the page
  // finishes a catch-up at once, so the session kept then is current.
  useEventListener(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") observe();
    else catchUp();
  });
  useEventListener(window, "pagehide", observe);
  useEventListener(window, "pageshow", catchUp);

  return {
    timers,
    observe,
    catchUp,
    settle,
    rebase,
    /** The display estimate of scene time; it refreshes only while something presented needs it. */
    displayTimeMs: computed(() => displayTimeMs.value),
    refreshWhile,
  };
}

/** Runs `task` in a task of its own after this one; closing the returned port cancels it. */
function inNextTask(task: () => void): MessagePort {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    task();
  };
  channel.port2.postMessage(null);
  return channel.port1;
}
