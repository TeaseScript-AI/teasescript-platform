import { computed, ref, shallowReactive, watch, type Ref, type ShallowRef } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import type { MediaProgressReport, TimeObservationOutcome } from "../../../../src/index.js";
import type { ClockTicket } from "../../../runtime/clock-ticket.js";
import {
  bridgeOf,
  endsQuietly,
  refusalCode,
  type SessionSection,
} from "../../../runtime/player-bridge.js";
import {
  nextPlayerRuntimeCatchUpStepMs,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  type PlayerSession,
} from "../../../runtime/runtime-view.js";

const DISPLAY_REFRESH_MS = 250;
// Browsers fire longer `setTimeout` delays immediately; a later wake-up re-schedules the rest.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// How long one task may catch up the events of a late observation before it gives the browser a turn. An observation
// within that time of its next event is on time and observed in one go.
const CATCH_UP_TASK_MS = 10;

/** A kind of session work that must follow the clock (`before`). */
export type ClockWork = "debugMode" | "randomControl" | "keepCapture" | "pageHide" | "audioEnded";

/**
 * What the session must have observed before each kind of work is posted: `settle`, a catch-up under way finishes first
 * as one observation (idle, nothing); `observe`, an observation now, also when idle; `none`, nothing.
 */
const CLOCK_WORK: Readonly<Record<ClockWork, "settle" | "observe" | "none">> = Object.freeze({
  // A setting's change comes no earlier than without a catch-up, with the draws it started with.
  debugMode: "settle",
  randomControl: "settle",
  // Time passed while the page was visible: the session kept when it hides is current.
  keepCapture: "observe",
  pageHide: "observe",
  // Media cues follow what was actually played.
  audioEnded: "observe",
});

/**
 * A kind of section work (`section`), and what the session observes at the section's turn, before the work's body:
 * `observeInput` or `observeTime` with the clock's now and media samples, or `none`.
 */
const SECTION_WORK = Object.freeze({
  // `runInput`, `pressPermanentButton`, `resolveRandomDraw`.
  inputAnswer: "observeInput",
  // `draftInput`: a draft has no observation.
  inputDraft: "none",
  storageEdit: "none",
  storageWriteDone: "none",
  // The lock, stored-files and camera deliveries.
  service: "observeTime",
  mediaLoadObserved: "observeTime",
  mediaLoad: "none",
} as const);
export type SectionWork = keyof typeof SECTION_WORK;

/** Creates the ticket the clock passes straight to the bridge for each section it opens. */
function mintClockTicket(): ClockTicket {
  // EVIDENCE: fixture: `ClockTicket` is type-only, with no runtime key; this value only meets the section APIs' check.
  return {} as ClockTicket;
}

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
   * still owns the UI; the Player's publication boundary. Returns the publication shown, or `null` when it does not.
   */
  publishLater: (next: PlayerSession) => PlayerSession | null = (next) => {
    if (session.value?.lineage !== next.lineage) return null;
    session.value = bridgeOf(next).latest(next);
    return session.value;
  },
) {
  let origin = performance.now();
  const displayTimeMs = ref(0);
  // The late observation being caught up on a copy of the session in the host, which goes on in its own tasks. Each
  // one has its generation: `cancel`, disposal and a new session advance it, so a late continuation does nothing. An
  // observation has its generation too (`whileLive`): a later observation (which cancels), `cancel` and disposal retire
  // it.
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

  /** The session `shown` is, when it still owns the UI: the newest publication shown of its lineage, else `null`. */
  function owned(shown: PlayerSession): PlayerSession | null {
    return !disposed && session.value?.lineage === shown.lineage ? session.value : null;
  }

  /** An observation the clock admitted: the generation it was made in, and the session it observes. */
  interface Observation {
    readonly generation: number;
    readonly session: PlayerSession;
  }

  /**
   * Runs `effect`, what the completion of `observation` does (publish, schedule, recover), only while the observation
   * is live: not retired by a later observation, `cancel` or disposal, and its session still shown; else gives
   * `otherwise`. The one lifetime decision: every completion of an observation, success or failure, goes through it.
   */
  function whileLive<T>(observation: Observation, effect: () => T, otherwise: T): T {
    const live =
      !disposed &&
      observation.generation === generation &&
      session.value?.lineage === observation.session.lineage;
    return live ? effect() : otherwise;
  }

  /**
   * Observes the clock's now and media samples in the shown session, inside a section of it, so its basis is read at
   * its own queue turn: it follows whatever the session's queue holds before it. A catch-up under way is dropped: this
   * observation covers its time. Resolves with the latest publication of the session it observed while that session
   * still owns the UI, else `null`; a refusal of the basis at its turn is retried once from the store's latest
   * revision, and a second one is no observation (`null`), with nothing published or scheduled. A stopped or lost
   * session gives `null`. While the clock is paused (an inspected state, a waiting draw), nothing is observed and the
   * shown session is the result. What the reply applies reaches the session's store; it shows only while the session
   * owns the UI (`publishLater`), so a caller rechecks that after it awaits.
   */
  function observe(): Promise<PlayerSession | null> {
    return observing(null);
  }

  /**
   * Observes as `observe` does, for a caller that needs no result: a failure of a live observation is recovered from
   * here, as a late observation's is, and the clock goes on from the latest session.
   */
  function requestObservation(): void {
    void observing(() => scheduleWakeUp(session.value));
  }

  /**
   * An observation, with `recover` for its failure, or `null` to reject with it. A later observation, `cancel`, a new
   * session or disposal retires it, which withdraws its effects (`whileLive`) but never its barrier: once admitted, it
   * sends at its turn unless the Player was disposed, the clock holds, or its session is no longer shown, so the work
   * queued behind it (as the keep's capture behind the hidden page's observation) follows an observation.
   */
  async function observing(recover: (() => void) | null): Promise<PlayerSession | null> {
    const shown = session.value;
    if (!shown || disposed) return null;
    if (paused.value) return shown;
    cancel();
    const observation: Observation = { generation, session: shown };
    let outcome: TimeObservationOutcome | "skipped" | null;
    // With `recover`, nothing below rejects: every failure, the media samples' too, is decided here.
    try {
      const args = { atMs: sceneTimeMs(shown), media: mediaReports() };
      outcome = await bridgeOf(shown).section(shown, mintClockTicket(), async (section) => {
        if (disposed || paused.value || owned(shown) === null) return "skipped";
        try {
          return await section.send<TimeObservationOutcome>("observeTime", args);
        } catch (error) {
          if (refusalCode(error) !== "basis") throw error;
          // Another publication applied before this turn: once more, from the store's latest revision.
          try {
            return await section.send<TimeObservationOutcome>("observeTime", args);
          } catch (again) {
            if (refusalCode(again) === "basis") return null;
            throw again;
          }
        }
      });
    } catch (error) {
      if (endsQuietly(error)) return null;
      return whileLive(
        observation,
        () => {
          if (recover === null) throw error;
          recover();
          return null;
        },
        null,
      );
    }
    if (outcome === null) return null;
    if (outcome === "skipped" || outcome.kind !== "observed") return owned(shown);
    return whileLive(observation, () => publishLater(shown), owned(shown));
  }

  /**
   * Runs `body` in a section of `current` that the clock opens for `work`: at the section's turn it observes what the
   * work needs (`SECTION_WORK`), then runs `body` with that observation. An observation drops a catch-up under way,
   * sends the clock's now and media samples, and shows its publication (`publishLater`); it is `null` once `owned`
   * fails, before or after it, or the session was refused as stopped or lost. While the clock is paused (an inspected
   * state, a waiting draw), nothing is observed and the section's session is the observation, as for a `none` row. The
   * body runs whatever the observation, so it decides what a `null` one means. Throws for a kind the table does not hold.
   */
  function section<T>(
    work: SectionWork,
    current: PlayerSession,
    owned: () => boolean,
    body: (section: SessionSection, observed: PlayerSession | null) => Promise<T>,
  ): Promise<T> {
    if (!Object.hasOwn(SECTION_WORK, work))
      throw new Error(`No section work is named ${String(work)}.`);
    const needs = SECTION_WORK[work];
    return bridgeOf(current).section(current, mintClockTicket(), async (opened) =>
      body(opened, needs === "none" ? opened.session : await observeIn(opened, needs, owned)),
    );
  }

  /** `section`'s observation, `op`, in `opened` at its turn. */
  async function observeIn(
    opened: SessionSection,
    op: "observeTime" | "observeInput",
    owned: () => boolean,
  ): Promise<PlayerSession | null> {
    if (!owned()) return null;
    if (paused.value) return opened.session;
    cancel();
    const shown = opened.session;
    let outcome: TimeObservationOutcome;
    try {
      outcome = await opened.send<TimeObservationOutcome>(op, {
        atMs: sceneTimeMs(shown),
        media: mediaReports(),
      });
    } catch (error) {
      // Refused as stopped, or lost with the Worker: the session no longer owns the UI.
      if (endsQuietly(error)) return null;
      throw error;
    }
    if (!owned()) return null;
    if (outcome.kind === "observed" && publishLater(opened.session) === null) return null;
    return opened.session;
  }

  /**
   * Posts what `work` needs (`CLOCK_WORK`) into the shown session's queue, so the host runs it before the work posted
   * next. Throws for a kind the table does not hold, whatever the clock's state.
   */
  function before(work: ClockWork): void {
    if (!Object.hasOwn(CLOCK_WORK, work))
      throw new Error(`No clock work is named ${String(work)}.`);
    const needs = CLOCK_WORK[work];
    if (needs === "observe" || (needs === "settle" && pending !== null)) requestObservation();
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
      return requestObservation();
    }
    const targetMs = sceneTimeMs(shown);
    const reports = mediaReports();
    const stepMs = nextPlayerRuntimeCatchUpStepMs(shown.state);
    if (reports.length > 0 || !copies() || stepMs === null || targetMs - stepMs <= CATCH_UP_TASK_MS)
      return requestObservation();
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
    else requestObservation();
  }

  let wakeUp: ReturnType<typeof setTimeout> | undefined;
  function scheduleWakeUp(current: PlayerSession | null) {
    if (wakeUp !== undefined) clearTimeout(wakeUp);
    wakeUp = undefined;
    // A completion after disposal arms nothing.
    if (disposed) return;
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
    if (wakeUp !== undefined) clearTimeout(wakeUp);
    wakeUp = undefined;
    nextTask?.close();
    nextTask = null;
    pending = null;
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

  // Showing the page again is an observation opportunity; scene time never pauses. Hiding it is the Player's: it
  // observes before it keeps the session (`before("keepCapture")`), in its own handler. `pagehide` is an opportunity
  // only: it keeps nothing and promises no completion before the page is suspended.
  useEventListener(document, "visibilitychange", () => {
    if (document.visibilityState !== "hidden") catchUp();
  });
  useEventListener(window, "pagehide", () => before("pageHide"));
  useEventListener(window, "pageshow", catchUp);

  return {
    timers,
    observe,
    requestObservation,
    before,
    section,
    catchUp,
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
