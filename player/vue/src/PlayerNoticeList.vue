<script setup lang="ts">
import { CircleAlert, Info, TriangleAlert, X } from "@lucide/vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import { Button } from "@/components/ui/button";
import type { PlayerNotice } from "../../notices.js";

// Player notices (PLAYER-UI "Player notices"): one non-blocking region above the composer.
defineProps<{ notices: readonly PlayerNotice[] }>();
defineEmits<{ dismiss: [key: string] }>();
const icons = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;
</script>

<template>
  <div v-if="notices.length" class="player-notices" data-player-notices>
    <div
      v-for="notice in notices"
      :key="notice.key"
      class="player-notice rounded-md border bg-card px-3 py-1 text-sm text-foreground shadow-xs"
      :role="notice.level === 'error' ? 'alert' : 'status'"
      :data-player-notice="notice.key"
      :data-level="notice.level"
    >
      <component
        :is="icons[notice.level]"
        class="size-4 shrink-0"
        aria-hidden="true"
      />
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
        variant="ghost"
        size="icon-xs"
        :aria-label="`Dismiss: ${notice.message}`"
        data-notice-dismiss
        @click="$emit('dismiss', notice.key)"
      >
        <X />
      </Button>
    </div>
  </div>
</template>

<style scoped>
.player-notices {
  display: grid;
  justify-items: center;
  gap: 4px;
  margin: 0 0 8px;
  pointer-events: auto;
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
