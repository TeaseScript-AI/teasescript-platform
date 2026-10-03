import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { PlayerNotice, PlayerNoticeLevel } from "../../notices.js";

/** A current notice with the moment it was last published, for the notification panel and its toast. */
export interface PlayerNotification {
  readonly notice: PlayerNotice;
  readonly publishedAt: number;
  readonly sequence: number;
}

// A toast is a temporary view of a notification; the notification itself stays in the panel.
const toastDuration: Record<PlayerNoticeLevel, number> = {
  info: 5000,
  warning: 8000,
  error: 10000,
};
const maximumToasts = 3;
const levelRank: Record<PlayerNoticeLevel, number> = { info: 0, warning: 1, error: 2 };

/**
 * Presentation state for Player notices (PLAYER-UI "Player notices"): the notification list, newest first; the toasts
 * shown for new publications; and whether the bell has something the player has not seen.
 */
export function usePlayerNotifications(notices: Readonly<Ref<readonly PlayerNotice[]>>) {
  const notifications = shallowRef<readonly PlayerNotification[]>([]);
  const toasts = shallowRef<readonly string[]>([]);
  const seenSequence = ref(0);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let sequence = 0;
  let held = false;

  function clearTimer(key: string) {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }
  function hideToast(key: string) {
    clearTimer(key);
    toasts.value = toasts.value.filter((toast) => toast !== key);
  }
  function schedule(key: string) {
    clearTimer(key);
    const notification = notifications.value.find((entry) => entry.notice.key === key);
    if (held || !notification) return;
    timers.set(
      key,
      setTimeout(() => hideToast(key), toastDuration[notification.notice.level]),
    );
  }

  watch(
    notices,
    (current) => {
      const previous = new Map(notifications.value.map((entry) => [entry.notice.key, entry]));
      const published: string[] = [];
      const next = current.map((notice) => {
        const known = previous.get(notice.key);
        if (known?.notice === notice) return known;
        published.push(notice.key);
        return { notice, publishedAt: Date.now(), sequence: (sequence += 1) };
      });
      notifications.value = next.sort((left, right) => right.sequence - left.sequence);
      const present = new Set(current.map((notice) => notice.key));
      for (const key of toasts.value) if (!present.has(key)) clearTimer(key);
      const shown = [
        ...published.reverse(),
        ...toasts.value.filter((key) => present.has(key) && !published.includes(key)),
      ];
      for (const key of shown.slice(maximumToasts)) clearTimer(key);
      toasts.value = shown.slice(0, maximumToasts);
      for (const key of published) if (toasts.value.includes(key)) schedule(key);
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    for (const key of [...timers.keys()]) clearTimer(key);
  });

  // The bell marks notifications published since the panel was last opened, and any the player must act on.
  const attention = computed(() =>
    notifications.value.filter(
      (entry) => entry.sequence > seenSequence.value || entry.notice.dismissible === false,
    ),
  );

  return {
    notifications: computed(() => notifications.value),
    toasts: computed(() =>
      toasts.value.flatMap(
        (key) => notifications.value.find((entry) => entry.notice.key === key) ?? [],
      ),
    ),
    /** The most severe level that needs the player's attention, or null. */
    attentionLevel: computed(() =>
      attention.value.reduce<PlayerNoticeLevel | null>(
        (level, entry) =>
          level === null || levelRank[entry.notice.level] > levelRank[level]
            ? entry.notice.level
            : level,
        null,
      ),
    ),
    attentionCount: computed(() => attention.value.length),
    hideToast,
    /** Pauses toast expiry while the pointer or focus is on a toast, so the player can read and use it. */
    holdToasts(hold: boolean) {
      held = hold;
      for (const key of toasts.value) schedule(key);
    },
    /** The panel shows every notification, so opening it marks them seen and replaces the toasts. */
    markSeen() {
      seenSequence.value = sequence;
      for (const key of toasts.value) clearTimer(key);
      toasts.value = [];
    },
  };
}
