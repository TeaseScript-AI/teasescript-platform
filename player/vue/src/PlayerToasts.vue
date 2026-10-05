<script setup lang="ts">
import { toRef } from "vue";
import { toast } from "vue-sonner";
import { Toaster } from "@/components/ui/sonner";
import type { PlayerNoticeLevel } from "../../notices.js";
import type { PlayerNotification } from "./usePlayerNotifications.js";
import { usePlayerToasts } from "./usePlayerToasts.js";

// Temporary toasts for new Player notices (PLAYER-UI "Player notices"); the notification panel keeps every notice.
const props = defineProps<{
  notifications: readonly PlayerNotification[];
  /** Notifications up to this sequence were seen in the panel, which replaces their toasts. */
  seenSequence: number;
  themeMode: "light" | "dark";
}>();

const toasterId = "player-notices";
const durations: Record<PlayerNoticeLevel, number> = { info: 5000, warning: 8000, error: 10000 };
const offset = {
  top: "calc(var(--player-top-control-size) + 2 * var(--player-edge-space))",
  left: "var(--player-edge-space)",
  right: "var(--player-edge-space)",
};

usePlayerToasts(toRef(props, "notifications"), toRef(props, "seenSequence"), {
  show: (id, notice) =>
    toast[notice.level](notice.message, {
      id,
      toasterId,
      duration: durations[notice.level],
      ...(notice.action && { action: { label: notice.action.label, onClick: notice.action.run } }),
    }),
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
/* The action matches the Player's outline buttons, light in the light theme and dark in the dark theme, instead of
   Sonner's inverted button. */
.player-composition [data-sonner-toast][data-styled="true"] [data-button] {
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-foreground);
}
.player-composition [data-sonner-toast][data-styled="true"] [data-button]:hover {
  background: var(--color-accent);
  color: var(--color-accent-foreground);
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
