<script setup lang="ts">
import { computed } from "vue";
import { CircleAlert, Info, SquarePlay, TriangleAlert, X } from "@lucide/vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import { Button } from "@/components/ui/button";
import type { PlayerNotification } from "./usePlayerNotifications.js";

// Temporary toasts for new Player notices (PLAYER-UI "Player notices"); the notification panel keeps every notice.
const props = defineProps<{
  notifications: readonly PlayerNotification[];
  toasts: readonly PlayerNotification[];
}>();
const emit = defineEmits<{ hide: [key: string]; hold: [hold: boolean] }>();
const icons = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;
const levelLabels = { info: "Info", warning: "Warning", error: "Error" } as const;
// Separate announcers carry every current message: both exist before any notice, so assistive technology announces
// the first one too, whether or not its toast is still visible; errors use the alert announcer.
const announcers = computed(() => [
  { role: "status", notifications: props.notifications.filter((entry) => entry.notice.level !== "error") },
  { role: "alert", notifications: props.notifications.filter((entry) => entry.notice.level === "error") },
]);

function leave(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) emit("hold", false);
}
</script>

<template>
  <div v-for="announcer in announcers" :key="announcer.role" class="sr-only" :role="announcer.role">
    <p v-for="entry in announcer.notifications" :key="entry.notice.key">
      {{ levelLabels[entry.notice.level] }}: {{ entry.notice.message }}
    </p>
  </div>
  <div
    class="player-toasts"
    data-player-toasts
    @pointerenter="emit('hold', true)"
    @pointerleave="emit('hold', false)"
    @focusin="emit('hold', true)"
    @focusout="leave"
  >
    <div
      v-for="entry in toasts"
      :key="entry.notice.key"
      class="player-toast"
      :data-player-toast="entry.notice.key"
      :data-level="entry.notice.level"
    >
      <div class="player-toast-head">
        <SquarePlay class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="player-toast-source">Player</span>
        <Button
          variant="ghost"
          size="icon-xs"
          :aria-label="`Hide notification: ${entry.notice.message}`"
          data-toast-hide
          @click="emit('hide', entry.notice.key)"
        >
          <X />
        </Button>
      </div>
      <div class="player-toast-row">
        <component :is="icons[entry.notice.level]" class="size-4 shrink-0" aria-hidden="true" />
        <span class="player-toast-message">{{ entry.notice.message }}</span>
      </div>
      <div v-if="entry.notice.action" class="player-toast-actions">
        <PlayerActionButton :data-notice-action="entry.notice.key" @click="entry.notice.action.run()">
          {{ entry.notice.action.label }}
        </PlayerActionButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Below the Player's top controls, right-aligned; left of the timer rail when timers occupy the top right. On a
   screen too narrow for that, the toast keeps a readable width and may cover the timer, but stays in view. */
.player-toasts {
  --toast-min-width: min(15rem, 100% - 2 * var(--player-edge-space));
  --toast-right: clamp(
    var(--player-edge-space),
    var(--player-notice-right, var(--player-edge-space)),
    100% - var(--toast-min-width) - var(--player-edge-space)
  );
  position: absolute;
  z-index: 25;
  inset-block-start: calc(var(--player-top-control-size) + 2 * var(--player-edge-space));
  inset-inline-end: var(--toast-right);
  display: grid;
  gap: 8px;
  inline-size: min(21.25rem, 100% - var(--toast-right) - var(--player-edge-space));
  pointer-events: none;
}
.player-toast {
  display: grid;
  gap: 6px;
  padding: 8px 8px 10px 12px;
  border: 1px solid var(--theme-border-floating, var(--border));
  border-radius: 12px;
  background: var(--popover);
  color: var(--foreground);
  box-shadow: 0 12px 28px -6px var(--theme-floating-shadow, rgb(0 0 0 / 18%)),
    0 2px 6px -2px var(--theme-floating-shadow, rgb(0 0 0 / 12%));
  font-size: 0.875rem;
  line-height: 1.35;
  pointer-events: auto;
}
.player-toast-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 0.75rem;
}
.player-toast-source {
  flex: 1;
  font-weight: 600;
}
.player-toast-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding-inline-end: 4px;
}
.player-toast-row > svg {
  margin-block-start: 1px;
}
.player-toast-message {
  min-inline-size: 0;
}
.player-toast-actions {
  display: flex;
  justify-content: flex-end;
  padding-inline-end: 4px;
}
</style>

<style>
/* Timers occupy the top of the right rail, so toasts keep clear of it. */
.player-composition:has(.stage-right-rail .timer-display) {
  --player-notice-right: calc(var(--player-timer-rail-width) + 2 * var(--player-edge-space));
}
</style>
