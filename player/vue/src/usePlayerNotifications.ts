import { computed, ref, shallowRef, watch, type Ref } from "vue";
import type { PlayerNotice, PlayerNoticeLevel } from "../../notices.js";

/** A current notice with the moment it was last published, for the notification panel and its toast. */
export interface PlayerNotification {
  readonly notice: PlayerNotice;
  readonly publishedAt: number;
  readonly sequence: number;
}

const levelRank: Record<PlayerNoticeLevel, number> = { info: 0, warning: 1, error: 2 };

/**
 * Presentation state for Player notices (PLAYER-UI "Player notices"): the notification list, newest first, numbered in
 * publication order for its toasts; and whether the bell has something the player has not seen.
 */
export function usePlayerNotifications(notices: Readonly<Ref<readonly PlayerNotice[]>>) {
  const notifications = shallowRef<readonly PlayerNotification[]>([]);
  const seenSequence = ref(0);
  let sequence = 0;

  watch(
    notices,
    (current) => {
      const previous = new Map(notifications.value.map((entry) => [entry.notice.key, entry]));
      notifications.value = current
        .map((notice) => {
          const known = previous.get(notice.key);
          if (known?.notice === notice) return known;
          return { notice, publishedAt: Date.now(), sequence: (sequence += 1) };
        })
        .sort((left, right) => right.sequence - left.sequence);
    },
    // Synchronous, so each publication is numbered in order even when several happen in one tick.
    { immediate: true, flush: "sync" },
  );

  // The bell marks notifications published since the panel was last opened, and any the player must act on.
  const attention = computed(() =>
    notifications.value.filter(
      (entry) => entry.sequence > seenSequence.value || entry.notice.dismissible === false,
    ),
  );

  return {
    notifications: computed(() => notifications.value),
    seenSequence: computed(() => seenSequence.value),
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
    /** The panel shows every notification, so opening it marks them seen and replaces their toasts. */
    markSeen() {
      seenSequence.value = sequence;
    },
  };
}
