import { onScopeDispose, readonly, ref } from "vue";

/**
 * One shared animation-frame clock for every lab candidate, so a page full of
 * rings cannot drift apart or start its own competing loop.
 */
const frameNow = ref(performance.now());
let subscribers = 0;
let frame = 0;

/**
 * Minimum gap between published updates. Zero follows the display; a larger
 * value deliberately steps, which is both a design option to compare and the
 * lever that decides how much work the page does per second.
 */
const minIntervalMs = ref(0);

function tick(): void {
  const value = performance.now();
  if (value - frameNow.value >= minIntervalMs.value) frameNow.value = value;
  frame = requestAnimationFrame(tick);
}

export function setLabClockInterval(intervalMs: number): void {
  minIntervalMs.value = Math.max(0, intervalMs);
}

export function useLabClock() {
  subscribers += 1;
  if (subscribers === 1) frame = requestAnimationFrame(tick);

  onScopeDispose(() => {
    subscribers -= 1;
    if (subscribers === 0) cancelAnimationFrame(frame);
  });

  return readonly(frameNow);
}

/** Presentation-only timer view passed to every candidate. */
export interface LabTimerView {
  key: string;
  /** Resolved label text, or null when this timer shows no label. */
  label: string | null;
  totalSeconds: number;
  /** Fractional remaining seconds; drives smooth ring motion, not the digits. */
  remainingSeconds: number;
  /** 0 at start, 1 at completion. */
  elapsed: number;
}
