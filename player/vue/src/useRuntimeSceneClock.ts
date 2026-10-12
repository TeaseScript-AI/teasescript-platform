import { computed, ref, shallowReactive, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import type { MediaProgressReport } from "../../../src/index.js";
import {
  catchUpPlayerRuntimeTime,
  observePlayerRuntimeTime,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";

const DISPLAY_REFRESH_MS = 250;
// Browsers fire longer `setTimeout` delays immediately; a later wake-up re-schedules the rest.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// How long one task may catch up the events of a late observation before it gives the browser a turn.
const CATCH_UP_TASK_MS = 10;

/**
 * Maps monotonic browser time onto the session's persisted scene time. The engine reads no clock: this Player
 * observes time at the next deadline, before input, before a checkpoint capture, and at page lifecycle changes.
 * Scene time continues while the page is hidden; a new or restored session is rebased so an unavailable gap is not
 * consumed. Every observation carries the media progress `mediaReports` measures, so media cues follow what was
 * actually played. A late observation without media progress catches up event by event, a task at a time
 * (`catchUp`), so the page stays responsive; `catchingUp` holds meanwhile, and input, and everything else that
 * observes, finishes it first.
 */
export function useRuntimeSceneClock(
  session: ShallowRef<PlayerRuntimeSession | null>,
  mediaReports: () => readonly MediaProgressReport[] = () => [],
  /** While it holds, scene time stands at the last observation and nothing is observed; rebase when it ends. */
  paused: Readonly<Ref<boolean>> = ref(false),
  /**
   * Whether a late observation may catch up in steps; otherwise it is one observation. Not while Debug decides random
   * draws: a draw that pauses would stand inside the catch-up, and Debug's choices could change between steps.
   */
  steps: () => boolean = () => true,
) {
  let origin = performance.now();
  const displayTimeMs = ref(0);
  // The scene time the last catch-up went to, for the sessions of its engine: a session behind it is catching up.
  const ahead = shallowRef<{
    readonly engine: PlayerRuntimeSession["engine"];
    readonly ms: number;
  } | null>(null);

  /** Whether a catch-up of the session is under way. */
  function behind(current: PlayerRuntimeSession): boolean {
    const target = ahead.value;
    return target?.engine === current.engine && current.state.observedSessionTimeMs < target.ms;
  }

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

  /** Submits an ordinary time observation and publishes the resulting session. */
  function observe(): PlayerRuntimeSession | null {
    const current = session.value;
    if (!current || paused.value) return current;
    const result = observePlayerRuntimeTime(current, sceneTimeMs(current), mediaReports());
    if (result.outcome.kind === "observed") session.value = result.session;
    return session.value;
  }

  /**
   * Observes at a deadline or another opportunity, without the result being needed at once. Media progress is measured
   * now, so an observation that reports it is one observation. Without, the observation catches up from event to event
   * (`catchUpPlayerRuntimeTime`) for one task and publishes what it reached; the next task goes on.
   */
  function catchUp() {
    const current = session.value;
    if (!current || paused.value) return;
    const targetMs = sceneTimeMs(current);
    const reports = mediaReports();
    let next = current;
    if (reports.length > 0 || !steps()) {
      const result = observePlayerRuntimeTime(current, targetMs, reports);
      if (result.outcome.kind === "observed") next = result.session;
    } else {
      const until = performance.now() + CATCH_UP_TASK_MS;
      next = catchUpPlayerRuntimeTime(current, targetMs, () => performance.now() < until);
    }
    ahead.value = { engine: next.engine, ms: targetMs };
    if (next !== current) session.value = next;
    // Time did not move on since the last observation, so the next deadline is still ahead.
    else if (current.state.observedSessionTimeMs >= targetMs) scheduleWakeUp(current);
  }

  /** Finishes a catch-up under way at once, with `observe`; otherwise gives the session as it stands. */
  function settle(): PlayerRuntimeSession | null {
    const current = session.value;
    return current !== null && behind(current) ? observe() : current;
  }

  let wakeUp: ReturnType<typeof setTimeout> | undefined;
  let nextTask: MessagePort | null = null;
  function scheduleWakeUp(current: PlayerRuntimeSession | null) {
    if (wakeUp !== undefined) clearTimeout(wakeUp);
    wakeUp = undefined;
    nextTask?.close();
    nextTask = null;
    if (!current) return;
    displayTimeMs.value = sceneTimeMs(current);
    if (paused.value) return;
    // A queued timer or media block waits for a pending storage write, and catch-up holds at its due time: an overdue
    // deadline cannot progress until the acknowledgement, whose published session schedules again. Without a queued
    // block, deadlines are observed as usual.
    if (pendingPlayerRuntimeStorageWrite(current.state) && current.state.queuedBlocks > 0) return;
    // A catch-up goes on in the next task. A message, unlike a timer, is neither clamped nor throttled while the page
    // is hidden, where late observations mostly come from.
    if (behind(current)) {
      nextTask = inNextTask(catchUp);
      return;
    }
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
    /** Whether a catch-up is under way: the session shows a slice of it, not yet the observed time. */
    catchingUp: computed(() => session.value !== null && behind(session.value)),
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
