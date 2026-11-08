<script setup lang="ts">
import { toRef } from "vue";
import { toast } from "vue-sonner";
import { Toaster } from "@/components/ui/sonner";
import type { PlayerNotification } from "./usePlayerNotifications.js";
import { toastOptions, usePlayerToasts } from "./usePlayerToasts.js";

// Toasts for new Player notices (PLAYER-UI "Player notices"); the notification panel keeps every notice.
const props = defineProps<{
  notifications: readonly PlayerNotification[];
  /** Notifications up to this sequence were seen in the panel, which replaces their toasts. */
  seenSequence: number;
  themeMode: "light" | "dark";
}>();

const toasterId = "player-notices";
const offset = {
  top: "calc(var(--player-top-control-size) + 2 * var(--player-edge-space))",
  left: "var(--player-edge-space)",
  right: "var(--player-edge-space)",
};

usePlayerToasts(toRef(props, "notifications"), toRef(props, "seenSequence"), {
  show: (id, notice) =>
    toast[notice.level](notice.message, { id, toasterId, ...toastOptions(notice) }),
  dismiss: (id) => toast.dismiss(id),
});
</script>

<template>
  <Toaster
    :id="toasterId"
    position="top-center"
    :theme="themeMode"
    rich-colors
    :visible-toasts="3"
    :offset="offset"
    :mobile-offset="offset"
  />
</template>

<style>
/* The theme's status roles colour each level: its soft tint as the surface, its solid tone for the border and icon. */
.player-composition [data-sonner-toaster][data-sonner-theme] {
  --info-bg: var(--theme-status-info-soft, Canvas);
  --info-border: var(--theme-status-info, CanvasText);
  --info-text: var(--foreground, CanvasText);
  --warning-bg: var(--theme-status-warning-soft, Canvas);
  --warning-border: var(--theme-status-warning, CanvasText);
  --warning-text: var(--foreground, CanvasText);
  --error-bg: var(--theme-status-error-soft, Canvas);
  --error-border: var(--theme-status-error, CanvasText);
  --error-text: var(--foreground, CanvasText);
}
/* The buttons match the Player's outline buttons, light in the light theme and dark in the dark theme, instead of
   Sonner's inverted action and tinted cancel button. */
.player-composition [data-sonner-toast][data-styled="true"] [data-button],
.player-composition [data-sonner-toaster][data-sonner-theme] [data-sonner-toast][data-styled="true"] [data-cancel] {
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-foreground);
}
.player-composition [data-sonner-toast][data-styled="true"] [data-button]:hover,
.player-composition [data-sonner-toaster][data-sonner-theme] [data-sonner-toast][data-styled="true"] [data-cancel]:hover {
  background: var(--color-accent);
  color: var(--color-accent-foreground);
}
/* With two buttons, the text keeps the line beside the icon and the buttons go below it, from the text's start. */
.player-composition [data-sonner-toast][data-styled="true"]:has([data-cancel]) {
  flex-wrap: wrap;
}
.player-composition [data-sonner-toast][data-styled="true"]:has([data-cancel]) [data-content] {
  flex: 1 1 0;
  min-width: 60%;
}
/* Sonner's icon, its margins, and the toast's gap. */
.player-composition [data-sonner-toast][data-styled="true"] [data-cancel] {
  margin-left: 23px;
}
.player-composition [data-sonner-toast][data-styled="true"] [data-cancel] + [data-button] {
  margin-left: 0;
}
/* Toasts beyond the visible three wait hidden behind the stack, out of reach of the keyboard too. */
.player-composition [data-sonner-toast][data-visible="false"] {
  visibility: hidden;
}
.player-composition [data-sonner-toast][data-type="info"] [data-icon] {
  color: var(--theme-status-info, CanvasText);
}
.player-composition [data-sonner-toast][data-type="warning"] [data-icon] {
  color: var(--theme-status-warning, CanvasText);
}
.player-composition [data-sonner-toast][data-type="error"] [data-icon] {
  color: var(--theme-status-error, CanvasText);
}
</style>
