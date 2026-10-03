<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CircleAlert, Info, SquarePlay, TriangleAlert, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useFocusRecovery } from "./useFocusRecovery.js";
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

// Pointer and focus hold the toasts independently, so leaving one while the other stays keeps them.
const stack = ref<HTMLElement | null>(null);
let pointerInside = false;
let focusInside = false;
function hold(pointer: boolean, focus: boolean) {
  const before = pointerInside || focusInside;
  pointerInside = pointer;
  focusInside = focus;
  if (before !== (pointer || focus)) emit("hold", pointer || focus);
}
function focusOut(event: FocusEvent) {
  hold(pointerInside, stack.value?.contains(event.relatedTarget as Node | null) ?? false);
}
// Removing the last toast fires no pointer or focus exit, so an empty stack releases its hold.
watch(
  () => props.toasts.length,
  (length) => {
    if (length === 0) hold(false, false);
  },
);
// With no toast control left, keyboard focus continues at the notification bell, where every notice remains.
useFocusRecovery(stack, () =>
  stack.value?.closest(".player-composition")?.querySelector<HTMLElement>("[data-notification-bell]")?.focus(),
);
</script>

<template>
  <div v-for="announcer in announcers" :key="announcer.role" class="sr-only" :role="announcer.role">
    <p v-for="entry in announcer.notifications" :key="entry.notice.key">
      {{ levelLabels[entry.notice.level] }}: {{ entry.notice.message }}
    </p>
  </div>
  <div
    ref="stack"
    class="player-toasts"
    data-player-toasts
    @pointerenter="hold(true, focusInside)"
    @pointerleave="hold(false, focusInside)"
    @focusin="hold(pointerInside, true)"
    @focusout="focusOut"
  >
    <div
      v-for="entry in toasts"
      :key="entry.notice.key"
      class="player-toast"
      :data-player-toast="entry.notice.key"
      :data-notice-level="entry.notice.level"
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
        <component :is="icons[entry.notice.level]" class="player-toast-icon size-4" aria-hidden="true" />
        <div class="player-toast-body">
          <p>{{ entry.notice.message }}</p>
          <Button
            v-if="entry.notice.action"
            variant="outline"
            size="sm"
            :data-notice-action="entry.notice.key"
            @click="entry.notice.action.run()"
          >
            {{ entry.notice.action.label }}
          </Button>
        </div>
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
  /* Room inside the scroll box for the cards' shadows and focus rings. */
  --toast-bleed: 12px;
  position: absolute;
  z-index: 25;
  inset-block-start: calc(var(--player-top-control-size) + 2 * var(--player-edge-space) - var(--toast-bleed));
  inset-inline-end: calc(var(--toast-right) - var(--toast-bleed));
  display: grid;
  align-content: start;
  gap: 8px;
  box-sizing: border-box;
  inline-size: calc(min(21.25rem, 100% - var(--toast-right) - var(--player-edge-space)) + 2 * var(--toast-bleed));
  /* A short screen scrolls the stack, down to the Player's bottom edge, instead of clipping it. Wheel and touch
     scrolling over a card still reach this box, although the box itself passes pointer input through. */
  max-block-size: calc(100% - var(--player-top-control-size) - 2 * var(--player-edge-space) + var(--toast-bleed));
  scroll-padding-block: var(--toast-bleed);
  padding: var(--toast-bleed);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  pointer-events: none;
}
.player-toast {
  display: grid;
  gap: 6px;
  padding: 8px 8px 10px 12px;
  border: 1px solid var(--notice-solid);
  border-radius: 12px;
  background: var(--notice-soft);
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
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr);
  column-gap: 10px;
  align-items: start;
  padding-inline-end: 4px;
}
.player-toast-icon {
  margin-block-start: 2px;
  color: var(--notice-solid);
}
.player-toast-body {
  display: grid;
  justify-items: start;
  gap: 8px;
}
</style>

<style>
/* Timers occupy the top of the right rail, so toasts keep clear of it. */
.player-composition:has(.stage-right-rail .timer-display) {
  --player-notice-right: calc(var(--player-timer-rail-width) + 2 * var(--player-edge-space));
}
</style>
