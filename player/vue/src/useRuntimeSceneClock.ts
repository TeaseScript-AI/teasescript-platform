import { computed, ref, shallowReactive, watch, type Ref, type ShallowRef } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import type { MediaProgressReport, TimeObservationOutcome } from "../../../src/index.js";
import { observeNow } from "../../engine-bridge/in-process.js";
import { bridgeOf } from "../../player-bridge.js";
import {
  nextPlayerRuntimeCatchUpStepMs,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  type PlayerSession,
} from "../../runtime-view.js";

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
  session: ShallowRef<PlayerSession | null>,
  mediaReports: () => readonly MediaProgressReport[] = () => [],
  /** While it holds, scene time stands at the last observation and nothing is observed; rebase when it ends. */
  paused: Readonly<Ref<boolean>> = ref(false),
  /** Whether a late observation may catch up on a copy; otherwise it is one observation. */
  copies: () => boolean = () => true,
  /**
   * Shows what an observation or catch-up over the bridge published once its reply arrived, if the session it observed
   * still owns the UI; the Player's publication boundary.
   */
  publishLater: (next: PlayerSession) => void = (next) => {
    if (session.value?.lineage === next.lineage) session.value = bridgeOf(next).latest(next);
  },
) {
  let origin = performance.now();
  const displayTimeMs = ref(0);
  // The late observation being caught up on a copy of the session in the host, which goes on in its own tasks. Each
  // one has its generation: `cancel`, disposal and a new session advance it, so a late continuation does nothing.
  let pending: { readonly generation: number; readonly session: PlayerSession } | null = null;
  let generation = 0;
  let nextTask: MessagePort | null = null;
  let disposed = false;

  function sceneTimeMs(current: PlayerSession): number {
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
    generation += 1;
    if (pending !== null) {
      const { session: caughtUp } = pending;
      void bridgeOf(caughtUp)
        .request(caughtUp, "dropCatchUp", null)
        .catch(() => {});
    }
    pending = null;
  }

  /** Whether `own` is still the catch-up under way, on the session shown. */
  const current = (own: NonNullable<typeof pending>) =>
    !disposed &&
    pending === own &&
    own.generation === generation &&
    session.value?.id === own.session.id;

  /**
   * Submits an ordinary time observation and publishes the resulting session, at once. A catch-up under way is dropped:
   * this observation covers its time.
   */
  function observe(): PlayerSession | null {
    const shown = session.value;
    if (!shown || paused.value) return shown;
    cancel();
    const result = observeNow(shown, sceneTimeMs(shown), mediaReports());
    if (result.outcome.kind === "observed") session.value = result.session;
    return session.value;
  }

  /** Observes at once while a catch-up is under way, so what follows comes after it; otherwise does nothing. */
  function settle(): PlayerSession | null {
    return pending === null ? session.value : observe();
  }

  /** One observation over the bridge, published once it was observed and its session is still the one shown. */
  async function observeLater(
    shown: PlayerSession,
    atMs: number,
    reports: readonly MediaProgressReport[],
  ) {
    const bridge = bridgeOf(shown);
    let outcome: TimeObservationOutcome;
    try {
      outcome = await bridge.request<TimeObservationOutcome>(shown, "observeTime", {
        atMs,
        media: reports,
      });
    } catch {
      // Refused (another op published meanwhile) or failed: nothing is shown; the clock goes on from the latest.
      return void scheduleWakeUp(session.value);
    }
    if (outcome.kind === "observed") publishLater(shown);
  }

  /**
   * Observes at a deadline or another opportunity, without the result being needed at once. An observation on time,
   * or one with media progress, which is measured now, is one observation. A late one catches up on a copy of the
   * session in the host, one task at a time, and publishes nothing until the session adopts the copy; if the session
   * was used meanwhile, the copy is gone and the session observes in one go.
   */
  function catchUp() {
    const shown = session.value;
    if (!shown || paused.value || disposed) return;
    if (pending !== null) {
      if (copies()) return void step(pending);
      // Debug started meanwhile: Debug follows every observation as it happens.
      return void observe();
    }
    const targetMs = sceneTimeMs(shown);
    const reports = mediaReports();
    const stepMs = nextPlayerRuntimeCatchUpStepMs(shown.state);
    if (reports.length > 0 || !copies() || stepMs === null || targetMs - stepMs <= CATCH_UP_TASK_MS)
      return void observeLater(shown, targetMs, reports);
    const own = { generation, session: shown };
    pending = own;
    void (async () => {
      try {
        await bridgeOf(shown).request(shown, "beginCatchUp", { targetMs });
      } catch {
        return void end(own, false);
      }
      if (current(own)) await step(own);
    })();
  }

  /** One task of the catch-up `own`: its own request, so input and acknowledgements can come between tasks. */
  async function step(own: NonNullable<typeof pending>): Promise<void> {
    if (!current(own)) return;
    let result: "more" | "done" | "dropped";
    try {
      result = await bridgeOf(own.session).request(own.session, "stepCatchUp", {
        budgetMs: CATCH_UP_TASK_MS,
      });
    } catch {
      result = "dropped";
    }
    if (!current(own)) return;
    // The next task goes on. A message, unlike a timer, is neither clamped nor throttled while the page is hidden,
    // where late observations mostly come from.
    if (result === "more") {
      nextTask?.close();
      nextTask = inNextTask(() => void step(own));
      return;
    }
    if (result === "dropped") return end(own, false);
    let adopted = false;
    try {
      ({ adopted } = await bridgeOf(own.session).request<{ readonly adopted: boolean }>(
        own.session,
        "adoptCatchUp",
        null,
      ));
    } catch {
      adopted = false;
    }
    if (current(own)) end(own, adopted);
  }

  /**
   * Ends the catch-up `own` and schedules from the latest session: an adopted copy publishes; a dropped or refused one
   * leaves the session to observe in one go, as today's "the copy is gone" does.
   */
  function end(own: NonNullable<typeof pending>, adopted: boolean) {
    if (pending !== own) return;
    pending = null;
    nextTask?.close();
    nextTask = null;
    if (disposed || session.value?.lineage !== own.session.lineage) return;
    if (adopted) publishLater(own.session);
    else observe();
  }

  let wakeUp: ReturnType<typeof setTimeout> | undefined;
  function scheduleWakeUp(current: PlayerSession | null) {
    if (wakeUp !== undefined) clearTimeout(wakeUp);
    wakeUp = undefined;
    // A catch-up belongs to its session and runs only while nothing holds; any other publication leaves it to notice
    // whether the session was used meanwhile.
    if (pending !== null && (paused.value || pending.session.id !== current?.id)) cancel();
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
  tryOnScopeDispose(() => {
    disposed = true;
    generation += 1;
    scheduleWakeUp(null);
  });

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
    /** Where scene time stands for `current` now: what an observation of it reports. */
    sceneTimeMs,
    /** Drops a catch-up under way, before an observation that covers its time. */
    cancel,
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
