import { computed, ref } from "vue";

/**
 * The lab's running time, shared by the stage that advances it and the toolbar
 * control that scrubs it. Keeping it outside both components means the toolbar
 * re-renders only when the rounded percentage actually changes, instead of on
 * every animation frame.
 */
const DURATIONS = [180, 900, 4500];
/** Start part-way through so every candidate shows a meaningful state on load. */
export const START_ELAPSED = 0.38;

export const totals = ref<number[]>([...DURATIONS]);
export const remaining = ref<number[]>(DURATIONS.map((value) => value * (1 - START_ELAPSED)));

/** Scrubbing sets every timer to the same elapsed fraction of its own run. */
export function scrubTo(percent: number): void {
  const elapsed = Math.min(1, Math.max(0, percent / 100));
  remaining.value = totals.value.map((total) => total * (1 - elapsed));
}

export function resetSession(): void {
  totals.value = [...DURATIONS];
  scrubTo(START_ELAPSED * 100);
}

export function jumpToFinish(): void {
  remaining.value = remaining.value.map(() => 12);
}

export const elapsedPercent = computed({
  get: () => {
    const total = totals.value[0] ?? 0;
    const left = remaining.value[0] ?? 0;
    return total > 0 ? Math.round((1 - left / total) * 100) : 0;
  },
  set: scrubTo,
});
