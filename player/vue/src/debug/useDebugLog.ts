import { computed, shallowRef } from "vue";

const LOG_LINES = 200;

/** One line of the Debug log; local development state, never transcript, notice, or checkpoint data. */
export interface DebugLogLine {
  readonly id: number;
  readonly text: string;
}

/** The Debug log of the Player with `?dev`: the latest lines, newest first. */
export function useDebugLog() {
  const lines = shallowRef<readonly DebugLogLine[]>([]);
  let count = 0;
  return {
    lines: computed(() => lines.value),
    add(text: string) {
      lines.value = [{ id: ++count, text }, ...lines.value.slice(0, LOG_LINES - 1)];
    },
  };
}

export type DebugLog = ReturnType<typeof useDebugLog>;
