<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Bell, CircleAlert, Info, TriangleAlert, X } from "@lucide/vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import { Button } from "@/components/ui/button";
import Popover from "@/components/ui/popover/Popover.vue";
import PopoverContent from "@/components/ui/popover/PopoverContent.vue";
import PopoverTrigger from "@/components/ui/popover/PopoverTrigger.vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import type { PlayerNoticeLevel } from "../../notices.js";
import type { PlayerNotification } from "./usePlayerNotifications.js";

// The Player's notification bell and panel (PLAYER-UI "Player notices"), part of the Player's own top controls.
const props = defineProps<{
  notifications: readonly PlayerNotification[];
  attentionLevel: PlayerNoticeLevel | null;
  attentionCount: number;
}>();
const emit = defineEmits<{ dismiss: [key: string]; open: [] }>();
const icons = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;
const levelLabels = { info: "Info", warning: "Warning", error: "Error" } as const;
const open = ref(false);
const now = ref(Date.now());
const list = ref<HTMLElement | null>(null);
const bellLabel = computed(() =>
  props.attentionCount ? `Notifications, ${props.attentionCount} need attention` : "Notifications",
);
const dismissible = computed(() =>
  props.notifications.filter((entry) => entry.notice.dismissible !== false),
);
const ageFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function age(publishedAt: number) {
  const seconds = Math.max(0, Math.round((now.value - publishedAt) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return ageFormat.format(-Math.floor(seconds / 60), "minute");
  return ageFormat.format(-Math.floor(seconds / 3600), "hour");
}

function changeOpen(value: boolean) {
  open.value = value;
  if (!value) return;
  now.value = Date.now();
  emit("open");
}

// Dismissing removes the focused control, so focus moves to the nearest remaining control in the panel.
async function dismiss(key: string) {
  const controls = [...(list.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  const index = controls.findIndex((control) => control.closest("[data-player-notice]")?.getAttribute("data-player-notice") === key);
  emit("dismiss", key);
  await nextTick();
  const remaining = [...(list.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.focus();
}

function clearAll() {
  for (const entry of dismissible.value) emit("dismiss", entry.notice.key);
}
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <span class="player-notification-trigger">
        <Popover :open="open" @update:open="changeOpen">
          <PopoverTrigger as-child>
            <Button data-notification-bell variant="ghost" size="icon" :aria-label="bellLabel">
              <span class="player-notification-bell">
                <Bell class="size-4" />
                <span v-if="attentionLevel" class="player-notification-dot" :data-notice-level="attentionLevel" aria-hidden="true" />
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" class="player-notification-panel" data-player-notification-panel>
            <div class="player-notification-head">
              <h2>Notifications</h2>
              <Button v-if="dismissible.length" variant="ghost" size="sm" data-notifications-clear @click="clearAll">Clear all</Button>
            </div>
            <p v-if="!notifications.length" class="player-notification-empty">No notifications.</p>
            <ul v-else ref="list" class="player-notification-list">
              <li
                v-for="entry in notifications"
                :key="entry.notice.key"
                class="player-notification"
                :data-player-notice="entry.notice.key"
                :data-notice-level="entry.notice.level"
              >
                <div class="player-notification-row">
                  <component :is="icons[entry.notice.level]" class="size-4 shrink-0" aria-hidden="true" />
                  <span class="player-notification-message">
                    <span class="sr-only">{{ levelLabels[entry.notice.level] }}: </span>{{ entry.notice.message }}
                  </span>
                  <span v-if="entry.notice.dismissible === false" class="player-notification-tag">Needs action</span>
                  <Button
                    v-else
                    variant="ghost"
                    size="icon-xs"
                    :aria-label="`Dismiss: ${entry.notice.message}`"
                    data-notice-dismiss
                    @click="dismiss(entry.notice.key)"
                  >
                    <X />
                  </Button>
                </div>
                <div class="player-notification-row player-notification-meta">
                  <time :datetime="new Date(entry.publishedAt).toISOString()">{{ age(entry.publishedAt) }}</time>
                  <PlayerActionButton
                    v-if="entry.notice.action"
                    class="shrink-0"
                    :data-notice-action="entry.notice.key"
                    @click="entry.notice.action.run()"
                  >
                    {{ entry.notice.action.label }}
                  </PlayerActionButton>
                </div>
              </li>
            </ul>
          </PopoverContent>
        </Popover>
      </span>
    </TooltipTrigger>
    <TooltipContent>Notifications</TooltipContent>
  </Tooltip>
</template>

<style scoped>
.player-notification-trigger {
  display: inline-flex;
}
.player-notification-bell {
  position: relative;
  display: inline-flex;
}
.player-notification-dot {
  position: absolute;
  inset-block-start: -3px;
  inset-inline-end: -3px;
  inline-size: 8px;
  block-size: 8px;
  border-radius: 9999px;
  /* The most severe level that needs attention colours the mark; the bell's label carries the count. */
  background: var(--notice-solid);
  box-shadow: 0 0 0 2px var(--media-surface);
}
</style>

<!-- The panel is portaled to the body, so its styles are not scoped to this component. -->
<style>
[data-slot="popover-content"].player-notification-panel {
  inline-size: min(22.5rem, calc(100vw - 2 * var(--player-edge-space)));
  padding: 0;
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.35;
}
.player-notification-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-block-size: 44px;
  padding: 4px 8px 4px 14px;
  border-block-end: 1px solid var(--border);
}
.player-notification-head h2 {
  font-weight: 600;
}
.player-notification-empty {
  padding: 12px 14px;
  color: var(--text-muted);
}
.player-notification-list {
  max-block-size: min(60vh, 24rem);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.player-notification {
  display: grid;
  gap: 6px;
  padding: 10px 14px 10px 11px;
  /* The level's tint and mark, as on its toast. */
  border-inline-start: 3px solid var(--notice-solid);
  background: var(--notice-soft);
}
.player-notification + .player-notification {
  border-block-start: 1px solid var(--border);
}
.player-notification-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.player-notification-row > svg {
  margin-block-start: 1px;
  color: var(--notice-solid);
}
.player-notification-message {
  flex: 1;
  min-inline-size: 0;
}
.player-notification-tag {
  flex-shrink: 0;
  padding: 0 6px;
  border: 1px solid var(--notice-solid);
  background: var(--notice-soft);
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
}
.player-notification-meta {
  align-items: center;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 0.75rem;
}
</style>
