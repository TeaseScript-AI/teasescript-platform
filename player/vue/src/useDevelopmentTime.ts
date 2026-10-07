import { computed, ref, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import {
  activePlayerRuntimeInteraction,
  advancePlayerRuntimeTime,
  nextPlayerRuntimeEventMs,
  playerRuntimeAwaitsHost,
  playerRuntimeMedia,
  stepPlayerRuntimeTime,
  type PlayerRuntimeSession,
  type PlayerRuntimeState,
} from "../../runtime-adapter.js";
import type { PlayerSessionHost } from "./usePlayerSession";

// How long one task may observe events of a jump before it yields to input and rendering.
const JUMP_TASK_MS = 10;

/**
 * Development time controls of the Player with `?dev` (#615), always active there. Skip advances scene time to the next
 * timed event, and +10 s or +1 min advance it by that amount while the session runs, also during waits and pacing.
 * Auto-skip skips event after event while no input is pending, yielding between tasks; the player's think time before
 * an answer stays real time.
 * Every jump is made of ordinary observations of the session, see `advancePlayerRuntimeTime`, and `log` receives a
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
  const canSkip = computed(() => !jumping.value && state.value !== null && skippable(state.value));
  // A session that ended has no scene time left to advance.
  const canAdvance = computed(
    () =>
      !jumping.value &&
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

  // A jump that waits for the host continues with the next published session.
  let wake: (() => void) | null = null;
  let disposed = false;
  watch(player.session, () => {
    wake?.();
    wake = null;
  });

  async function jump(target: (session: PlayerRuntimeSession) => number | null) {
    jumping.value = true;
    const generation = player.generation.value;
    try {
      // Skipping is input to a state Debug's rewind restored: it adopts the state first.
      if (!(await player.prepareInput())) return;
      if (disposed || player.generation.value !== generation) return;
      // Time that really elapsed is observed first, with the media progress actually played.
      const start = player.observe();
      const targetMs = start === null ? null : target(start);
      if (start === null || targetMs === null) return;
      let current = start;
      // Only the jump's own steps count as skipped: real time that passed while it waited for the host does not.
      let skippedMs = 0;
      for (;;) {
        // Each task observes events for a bounded time, so a long jump keeps input and rendering responsive.
        const published = current;
        const until = performance.now() + JUMP_TASK_MS;
        for (let next = stepPlayerRuntimeTime(current, targetMs); next !== current;) {
          current = next;
          if (performance.now() >= until) break;
          next = stepPlayerRuntimeTime(current, targetMs);
        }
        skippedMs += current.state.observedSessionTimeMs - published.state.observedSessionTimeMs;
        if (current !== published) player.publishJump(current);
        if (current.state.observedSessionTimeMs >= targetMs) break;
        // A save, delete, or photo waits for the host; the jump continues once its answer is published.
        if (playerRuntimeAwaitsHost(current.state))
          await new Promise<void>((resolve) => (wake = resolve));
        else if (current !== published) await new Promise((resolve) => setTimeout(resolve, 0));
        else break;
        if (disposed || player.generation.value !== generation) break;
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
  function autoSkipTask() {
    const start = player.observe();
    if (start === null || !autoSkippable(start.state)) return;
    let current = start;
    const until = performance.now() + JUMP_TASK_MS;
    do {
      current = advancePlayerRuntimeTime(current, nextPlayerRuntimeEventMs(current.state)!);
    } while (performance.now() < until && autoSkippable(current.state));
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
        if (autoSkipDue.value) autoSkipTask();
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

function skippable(state: PlayerRuntimeState): boolean {
  return !playerRuntimeAwaitsHost(state) && nextPlayerRuntimeEventMs(state) !== null;
}

/** Auto-skip leaves input to the player and does not run ahead of a load result, which decides what happens next. */
function autoSkippable(state: PlayerRuntimeState): boolean {
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
