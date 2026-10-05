import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import {
  activePlayerRuntimeInteraction,
  advancePlayerRuntimeTime,
  nextPlayerRuntimeEventMs,
  playerRuntimeAwaitsHost,
  playerRuntimeMedia,
  stepPlayerRuntimeTime,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import type { RuntimeSnapshot } from "../../../src/index.js";
import type { PlayerSessionHost } from "./usePlayerSession";

const LISTED_JUMPS = 20;
// How long one task may observe events of a jump before it yields to input and rendering.
const JUMP_TASK_MS = 10;

/** One jump as the development panel reports it; never part of the transcript, notices, or checkpoints. */
export interface DevelopmentTimeJump {
  readonly id: number;
  readonly text: string;
}

/**
 * Development time controls of the Player with `?dev` (#615). Skip advances scene time to the next timed event, and
 * +10 s or +1 min advance it while the script waits for player input. Auto-skip skips event after event while no input
 * is pending, yielding between tasks; the player's think time before an answer stays real time. Every jump is made of
 * ordinary observations of the session, see `advancePlayerRuntimeTime`.
 */
export function useDevelopmentTime(
  player: PlayerSessionHost,
  initial: { readonly enabled: boolean; readonly autoSkip: boolean },
) {
  const enabled = ref(initial.enabled);
  const autoSkip = ref(initial.autoSkip);
  const jumping = ref(false);
  const jumps = shallowRef<readonly DevelopmentTimeJump[]>([]);
  let jumpCount = 0;

  const snapshot = computed(() => player.session.value?.snapshot ?? null);
  const canSkip = computed(
    () => enabled.value && !jumping.value && snapshot.value !== null && skippable(snapshot.value),
  );
  const canAdvance = computed(
    () =>
      enabled.value &&
      !jumping.value &&
      snapshot.value !== null &&
      activePlayerRuntimeInteraction(snapshot.value) !== null,
  );
  const autoSkipDue = computed(
    () => canSkip.value && autoSkip.value && autoSkippable(snapshot.value!),
  );

  function record(from: PlayerRuntimeSession, to: PlayerRuntimeSession) {
    const skippedMs = to.snapshot.observedSessionTimeMs - from.snapshot.observedSessionTimeMs;
    if (skippedMs <= 0) return;
    jumps.value = [
      { id: ++jumpCount, text: `⏩ ${durationText(skippedMs)} skipped` },
      ...jumps.value.slice(0, LISTED_JUMPS - 1),
    ];
  }

  // A jump that waits for the host continues with the next published session.
  let wake: (() => void) | null = null;
  let disposed = false;
  watch([player.session, enabled], () => {
    wake?.();
    wake = null;
  });

  async function jump(target: (session: PlayerRuntimeSession) => number | null) {
    jumping.value = true;
    const generation = player.generation.value;
    try {
      // Time that really elapsed is observed first, with the media progress actually played.
      const start = player.observe();
      const targetMs = start === null ? null : target(start);
      if (start === null || targetMs === null || playerRuntimeAwaitsHost(start.snapshot)) return;
      let current = start;
      for (;;) {
        // Each task observes events for a bounded time, so a long jump stays responsive and can be switched off.
        const published = current;
        const until = performance.now() + JUMP_TASK_MS;
        for (let next = stepPlayerRuntimeTime(current, targetMs); next !== current;) {
          current = next;
          if (performance.now() >= until) break;
          next = stepPlayerRuntimeTime(current, targetMs);
        }
        if (current !== published) player.publishJump(current);
        if (current.snapshot.observedSessionTimeMs >= targetMs) break;
        // A save, delete, or photo waits for the host; the jump continues once its answer is published.
        if (playerRuntimeAwaitsHost(current.snapshot))
          await new Promise<void>((resolve) => (wake = resolve));
        else if (current !== published) await new Promise((resolve) => setTimeout(resolve, 0));
        else break;
        if (disposed || !enabled.value || player.generation.value !== generation) break;
        current = player.session.value ?? current;
      }
      if (player.generation.value === generation) record(start, current);
    } finally {
      jumping.value = false;
    }
  }

  async function skip() {
    if (canSkip.value) await jump((session) => nextPlayerRuntimeEventMs(session.snapshot));
  }
  async function advanceBy(milliseconds: number) {
    if (!canAdvance.value) return;
    await jump((session) =>
      activePlayerRuntimeInteraction(session.snapshot) === null
        ? null
        : session.snapshot.observedSessionTimeMs + milliseconds,
    );
  }

  /** Skips events for one task, then publishes them as one jump. */
  function autoSkipTask() {
    const start = player.observe();
    if (start === null || !autoSkippable(start.snapshot)) return;
    let current = start;
    const until = performance.now() + JUMP_TASK_MS;
    do {
      current = advancePlayerRuntimeTime(current, nextPlayerRuntimeEventMs(current.snapshot)!);
    } while (performance.now() < until && autoSkippable(current.snapshot));
    player.publishJump(current);
    record(start, current);
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

  return {
    /** Whether the controls are on; off, scene time keeps what was skipped and runs at real time again. */
    enabled,
    autoSkip,
    canSkip,
    canAdvance,
    skip,
    advanceBy,
    /** The latest jumps, newest first. */
    jumps: computed(() => jumps.value),
  };
}

export type DevelopmentTime = ReturnType<typeof useDevelopmentTime>;

function skippable(snapshot: RuntimeSnapshot): boolean {
  return !playerRuntimeAwaitsHost(snapshot) && nextPlayerRuntimeEventMs(snapshot) !== null;
}

/** Auto-skip leaves input to the player and does not run ahead of a load result, which decides what happens next. */
function autoSkippable(snapshot: RuntimeSnapshot): boolean {
  return (
    skippable(snapshot) &&
    activePlayerRuntimeInteraction(snapshot) === null &&
    playerRuntimeMedia(snapshot).media.every((media) => media.loaded)
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
