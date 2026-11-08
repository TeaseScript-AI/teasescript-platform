import { computed, ref, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import type { PlayerCriticalState } from "../../engine-bridge/session-protocol.js";
import { bridgeOf } from "../../player-bridge.js";
import {
  activePlayerRuntimeInteraction,
  nextPlayerRuntimeEventMs,
  playerRuntimeAwaitsHost,
  playerRuntimeMedia,
  type PlayerSession,
} from "../../runtime-view.js";
import type { PlayerSessionHost } from "./usePlayerSession";

// How long one task may observe events of a jump before it yields to input and rendering.
const JUMP_TASK_MS = 10;

/**
 * One step of a jump toward `targetMs` (the `stepTime` op): the session after it, or `current` itself when time did not
 * move, as at the target or while the session waits for the host. Each step is a request of its own, so the session is
 * never held while the jump waits; nothing is shown until the jump publishes.
 */
async function stepTo(current: PlayerSession, targetMs: number): Promise<PlayerSession> {
  const bridge = bridgeOf(current);
  const { moved } = await bridge.request<{ readonly moved: boolean }>(current, "stepTime", {
    targetMs,
  });
  return moved ? (bridge.latest(current) ?? current) : current;
}

/** Steps to `targetMs` until time stops moving there: `advancePlayerRuntimeTime` over the bridge. */
async function advanceTo(current: PlayerSession, targetMs: number): Promise<PlayerSession> {
  for (
    let next = await stepTo(current, targetMs);
    next !== current;
    next = await stepTo(next, targetMs)
  )
    current = next;
  return current;
}

/**
 * Development time controls of the Player with `?dev` (#615), always active there. Skip advances scene time to the next
 * timed event, and +10 s or +1 min advance it by that amount while the session runs, also during waits and pacing.
 * Auto-skip skips event after event while no input is pending, yielding between tasks; the player's think time before
 * an answer stays real time.
 * Every jump is made of ordinary observations of the session (the `stepTime` op), and `log` receives a
 * line for it ("⏩ 30 s skipped").
 */
export function useDevelopmentTime(
  player: PlayerSessionHost,
  initial: { readonly autoSkip: boolean },
  log: (text: string) => void,
) {
  const autoSkip = ref(initial.autoSkip);
  const jumping = ref(false);

  const state = computed(() => player.session.value?.state ?? null);
  // A session that a Player error stopped takes no time any more.
  // While a switch of Debug's rewind is under way, an inspected state takes no time either (DEBUGGER.md "Rewind").
  const canSkip = computed(
    () =>
      !jumping.value &&
      !player.stopped.value &&
      !player.rewind.inputHeld.value &&
      state.value !== null &&
      skippable(state.value),
  );
  // A session that ended has no scene time left to advance.
  const canAdvance = computed(
    () =>
      !jumping.value &&
      !player.stopped.value &&
      !player.rewind.inputHeld.value &&
      state.value !== null &&
      state.value.status !== "halted" &&
      state.value.status !== "failed",
  );
  // A state Debug's rewind restored is inspected until input adopts it; auto-skip waits for that.
  const autoSkipDue = computed(
    () =>
      canSkip.value &&
      autoSkip.value &&
      !player.rewind.inspecting.value &&
      autoSkippable(state.value!),
  );

  function record(skippedMs: number) {
    if (skippedMs > 0) log(`⏩ ${durationText(skippedMs)} skipped`);
  }

  // A jump that waits for the host continues with the next published session, or ends when the session stopped.
  let wake: (() => void) | null = null;
  let disposed = false;
  watch([player.session, player.stopped], () => {
    wake?.();
    wake = null;
  });

  async function jump(target: (session: PlayerSession) => number | null) {
    jumping.value = true;
    const generation = player.generation.value;
    try {
      // Skipping is input to a state Debug's rewind restored: it adopts the state first.
      if (!(await player.prepareInput())) return;
      if (disposed || player.generation.value !== generation) return;
      // Time that really elapsed is observed first, with the media progress actually played; a stopped session gives
      // nothing to jump. The jump's own observation, not the clock's policy (`before`): it needs the observed session.
      const start = await player.observe();
      if (disposed || player.generation.value !== generation) return;
      const targetMs = start === null ? null : target(start);
      if (start === null || targetMs === null) return;
      let current = start;
      // Only the jump's own steps count as skipped: real time that passed while it waited for the host does not.
      let skippedMs = 0;
      for (;;) {
        // Each task observes events for a bounded time, so a long jump keeps input and rendering responsive.
        const published = current;
        const until = performance.now() + JUMP_TASK_MS;
        try {
          for (let next = await stepTo(current, targetMs); next !== current;) {
            current = next;
            if (performance.now() >= until) break;
            next = await stepTo(current, targetMs);
          }
        } catch {
          // Refused, as after another op of the session, or failed: the jump ends with what it reached.
          break;
        }
        if (disposed || player.generation.value !== generation) return;
        skippedMs += current.state.observedSessionTimeMs - published.state.observedSessionTimeMs;
        if (current !== published) player.publishJump(current);
        if (current.state.observedSessionTimeMs >= targetMs) break;
        // A save, delete, or photo waits for the host; the jump continues once its answer is published.
        if (playerRuntimeAwaitsHost(current.state))
          await new Promise<void>((resolve) => (wake = resolve));
        else if (current !== published) await new Promise((resolve) => setTimeout(resolve, 0));
        else break;
        // The jump goes on from the published session without observing it: an observation would sample media the jump
        // just moved, and publishing it would wake the jump again. A stop ends the jump, as it gives input no session.
        if (disposed || player.generation.value !== generation || player.stopped.value) break;
        current = player.session.value ?? current;
      }
      if (player.generation.value === generation) record(skippedMs);
    } finally {
      jumping.value = false;
    }
  }

  async function skip() {
    if (canSkip.value)
      await jump((session) =>
        playerRuntimeAwaitsHost(session.state) ? null : nextPlayerRuntimeEventMs(session.state),
      );
  }
  // A jump that starts while the host answers a save, delete, or photo waits for that answer first.
  async function advanceBy(milliseconds: number) {
    if (canAdvance.value)
      await jump((session) => session.state.observedSessionTimeMs + milliseconds);
  }

  /** Skips events for one task, then publishes them as one jump. */
  async function autoSkipTask() {
    const generation = player.generation.value;
    // Its own observation, as a jump's.
    const start = await player.observe();
    if (start === null || disposed || player.generation.value !== generation) return;
    if (!autoSkippable(start.state)) return;
    let current = start;
    const until = performance.now() + JUMP_TASK_MS;
    try {
      do {
        current = await advanceTo(current, nextPlayerRuntimeEventMs(current.state)!);
      } while (performance.now() < until && autoSkippable(current.state));
    } catch {
      // Refused or failed: the task publishes what it reached.
    }
    if (disposed || player.generation.value !== generation || player.stopped.value) return;
    player.publishJump(current);
    record(current.state.observedSessionTimeMs - start.state.observedSessionTimeMs);
  }
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  watch(
    [player.session, autoSkipDue],
    () => {
      if (scheduled !== undefined || !autoSkipDue.value) return;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        if (autoSkipDue.value) void autoSkipTask();
      }, 0);
    },
    { immediate: true },
  );
  tryOnScopeDispose(() => {
    disposed = true;
    clearTimeout(scheduled);
    wake?.();
  });

  return { autoSkip, canSkip, canAdvance, skip, advanceBy };
}

export type DevelopmentTime = ReturnType<typeof useDevelopmentTime>;

function skippable(state: PlayerCriticalState): boolean {
  return !playerRuntimeAwaitsHost(state) && nextPlayerRuntimeEventMs(state) !== null;
}

/** Auto-skip leaves input to the player and does not run ahead of a load result, which decides what happens next. */
function autoSkippable(state: PlayerCriticalState): boolean {
  return (
    skippable(state) &&
    activePlayerRuntimeInteraction(state) === null &&
    playerRuntimeMedia(state).media.every((media) => media.loaded)
  );
}

/** A skipped duration as the panel shows it: `250 ms`, `2.5 s`, `30 s`, `1 min 30 s`. */
function durationText(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 10_000) return `${Math.round(milliseconds / 100) / 10} s`;
  const seconds = Math.round(milliseconds / 1000);
  const parts: Array<readonly [number, string]> = [
    [Math.floor(seconds / 3600), "h"],
    [Math.floor(seconds / 60) % 60, "min"],
    [seconds % 60, "s"],
  ];
  return parts
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value} ${unit}`)
    .join(" ");
}
