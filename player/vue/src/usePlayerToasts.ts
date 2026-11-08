import { nextTick, watch, type Ref } from "vue";
import type { PlayerNotice, PlayerNoticeLevel } from "../../notices.js";
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

// An error's toast stays until its notice is withdrawn, dismissed, or seen in the panel, or the player swipes it away.
const durations: Record<PlayerNoticeLevel, number> = { info: 5000, warning: 8000, error: Infinity };

interface ToastButton {
  readonly label: string;
  readonly onClick: (event: Pick<Event, "preventDefault">) => void;
}

/**
 * A notice's Sonner toast options. Sonner closes its toast after a click on its cancel button always, and on its action
 * button unless the click is prevented. A notice's `action` closes its toast and its Details leaves it open, so a notice
 * with Details puts its action in the cancel button, which Sonner shows first, and Details in the action button.
 */
export function toastOptions(notice: PlayerNotice): {
  duration: number;
  action?: ToastButton;
  cancel?: ToastButton;
} {
  const { action, details } = notice;
  const act = action && { label: action.label, onClick: () => action.run() };
  const duration = durations[notice.level];
  if (details === undefined) return { duration, ...(act && { action: act }) };
  return {
    duration,
    ...(act && { cancel: act }),
    action: {
      label: "Details",
      onClick: (event) => {
        event.preventDefault();
        details();
      },
    },
  };
}
