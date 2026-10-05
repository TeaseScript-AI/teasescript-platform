import { nextTick, watch, type Ref } from "vue";
import type { PlayerNotice } from "../../notices.js";
import type { PlayerNotification } from "./usePlayerNotifications.js";

/** Draws and retires toasts by id: Sonner in the Player. */
export interface PlayerToastSink {
  show(id: string, notice: PlayerNotice): void;
  dismiss(id: string): void;
}

// Each publication has its own toast. A replaced notice retires its old toast and shows in front with its current
// level, duration and action; retiring an old toast never reaches a newer publication of the same notice.
const toastId = (entry: PlayerNotification) => `${entry.notice.key}#${entry.sequence}`;

/**
 * Shows a toast for each new publication (PLAYER-UI "Player notices"), and retires it when its notice is replaced,
 * withdrawn, dismissed, or seen in the panel.
 */
export function usePlayerToasts(
  notifications: Readonly<Ref<readonly PlayerNotification[]>>,
  seenSequence: Readonly<Ref<number>>,
  sink: PlayerToastSink,
) {
  const current = (entry: PlayerNotification) =>
    entry.sequence > seenSequence.value &&
    notifications.value.some((candidate) => candidate.sequence === entry.sequence);
  // vue-sonner orders its stack by mount, so toasts created in one render stack in reverse; each one mounts in its
  // own render, if its publication is still current and unseen by then.
  let queue = Promise.resolve();
  let shownSequence = 0;

  watch(
    notifications,
    (entries, previous = []) => {
      const ids = new Set(entries.map(toastId));
      for (const entry of previous) if (!ids.has(toastId(entry))) sink.dismiss(toastId(entry));
      // Oldest first, so the newest publication is in front.
      for (const entry of [...entries].reverse()) {
        if (entry.sequence <= shownSequence) continue;
        queue = queue.then(async () => {
          if (!current(entry)) return;
          sink.show(toastId(entry), entry.notice);
          await nextTick();
        });
      }
      shownSequence = Math.max(shownSequence, ...entries.map((entry) => entry.sequence));
    },
    { immediate: true },
  );
  watch(seenSequence, (seen) => {
    for (const entry of notifications.value)
      if (entry.sequence <= seen) sink.dismiss(toastId(entry));
  });
}
