<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { CircleAlert, Info, TriangleAlert, X } from "@lucide/vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import { Button } from "@/components/ui/button";
import type { PlayerNotice } from "../../notices.js";

// Player notices (PLAYER-UI "Player notices"): one non-blocking region above the composer.
const props = defineProps<{ notices: readonly PlayerNotice[] }>();
const emit = defineEmits<{ dismiss: [key: string] }>();
const icons = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;
// Both live regions exist before any notice, so assistive technology announces the first one too.
const regions = computed(() => [
  { role: "status", notices: props.notices.filter((notice) => notice.level !== "error") },
  { role: "alert", notices: props.notices.filter((notice) => notice.level === "error") },
]);
const stack = ref<HTMLElement | null>(null);

// Dismissing removes the focused control, so focus moves to the nearest remaining notice control.
async function dismiss(key: string) {
  const controls = [...(stack.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  const index = controls.findIndex((control) => control.closest("[data-player-notice]")?.getAttribute("data-player-notice") === key);
  emit("dismiss", key);
  await nextTick();
  const remaining = [...(stack.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.focus();
}
</script>

<template>
  <div ref="stack" class="player-notices" data-player-notices>
    <div v-for="region in regions" :key="region.role" class="player-notice-region" :role="region.role">
      <div
        v-for="notice in region.notices"
        :key="notice.key"
        class="player-notice rounded-md border bg-card px-3 py-1 text-sm text-foreground shadow-xs"
        :data-player-notice="notice.key"
        :data-level="notice.level"
      >
        <component :is="icons[notice.level]" class="size-4 shrink-0" aria-hidden="true" />
        <span class="player-notice-message">{{ notice.message }}</span>
        <PlayerActionButton
          v-if="notice.action"
          class="shrink-0"
          :data-notice-action="notice.key"
          @click="notice.action.run()"
        >
          {{ notice.action.label }}
        </PlayerActionButton>
        <Button
          v-if="notice.dismissible !== false"
          variant="ghost"
          size="icon-xs"
          :aria-label="`Dismiss: ${notice.message}`"
          data-notice-dismiss
          @click="dismiss(notice.key)"
        >
          <X />
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-notices {
  /* The stack may use the conversation space above the composer and scrolls beyond it, so every notice and its
     controls stay reachable however small the conversation is. */
  max-height: max(
    0px,
    calc(
      var(--conversation-available-height, 100vh) - var(--composer-top-from-bottom, 0px) -
        var(--conversation-overlay-top-padding, 0px)
    )
  );
  overflow-y: auto;
  overscroll-behavior: contain;
  pointer-events: auto;
}
.player-notice-region {
  display: grid;
  justify-items: center;
  gap: 4px;
}
.player-notice-region:not(:empty) {
  margin: 0 0 8px;
}
.player-notice {
  display: flex;
  max-width: 100%;
  gap: 8px;
  align-items: center;
  justify-content: center;
}
.player-notice-message {
  min-width: 0;
}
</style>
