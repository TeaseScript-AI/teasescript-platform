<script setup lang="ts">
import { Maximize, Minimize, Moon, Sun } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";

defineProps<{
  title: string;
  fullscreen: boolean;
  fullscreenSupported: boolean;
  fullscreenError: string;
  themeMode: "light" | "dark";
}>();
defineEmits<{ toggleFullscreen: []; toggleThemeMode: [] }>();
</script>

<template>
  <header data-player-top-bar class="player-top-bar">
    <div v-if="$slots.tools" class="player-top-bar-tools"><slot name="tools" /></div>
    <h1 class="player-top-bar-title"><span>{{ title }}</span></h1>
    <div class="player-top-bar-actions" role="group" aria-label="Player display controls">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            data-theme-mode-control
            variant="ghost"
            size="icon"
            class="player-top-bar-theme"
            :aria-label="themeMode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="$emit('toggleThemeMode')"
          >
            <Sun v-if="themeMode === 'dark'" class="size-4" />
            <Moon v-else class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ themeMode === 'dark' ? 'Light theme' : 'Dark theme' }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            data-fullscreen-control
            variant="ghost"
            size="icon"
            class="player-top-bar-fullscreen"
            :disabled="!fullscreenSupported"
            :aria-label="fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
            @click="$emit('toggleFullscreen')"
          >
            <Minimize v-if="fullscreen" class="size-4" />
            <Maximize v-else class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ fullscreenSupported ? (fullscreen ? 'Exit fullscreen' : 'Enter fullscreen') : 'Fullscreen unavailable in this browser' }}</TooltipContent>
      </Tooltip>
    </div>
    <p v-if="fullscreenError" role="alert" class="player-top-bar-error">{{ fullscreenError }}</p>
  </header>
</template>

<style scoped>
/* Overlay only: the composition's Stage and conversation tracks retain all space. */
.player-top-bar {
  --top-bar-control-size: calc(1rem + 16px);
  --top-bar-edge-padding: 8px;
  position: absolute;
  z-index: 20;
  inset: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: var(--top-bar-edge-padding);
  pointer-events: none;
}
.player-top-bar-tools { display: contents; }
.player-top-bar-tools :deep(button), .player-top-bar-actions {
  flex-shrink: 0;
  pointer-events: auto;
}
.player-top-bar-tools :deep(button) {
  inline-size: var(--top-bar-control-size);
  block-size: var(--top-bar-control-size);
}
.player-top-bar-actions {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  box-sizing: border-box;
  block-size: var(--top-bar-control-size);
  border: 1px solid var(--media-border);
  border-radius: 0.75rem;
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
}
.player-top-bar-actions :deep(button) {
  inline-size: var(--top-bar-control-size);
  block-size: calc(var(--top-bar-control-size) - 2px);
}
.player-top-bar-title {
  flex: 1;
  min-width: 0;
  block-size: var(--top-bar-control-size);
  display: flex;
  align-items: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
  font-weight: 500;
}
.player-top-bar-title > span {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  block-size: var(--top-bar-control-size);
  padding-inline: 0.375rem;
  border-radius: 0.375rem;
}
.player-top-bar-error {
  position: absolute;
  top: calc(100% + 0.5rem);
  inset-inline: 0;
  padding: 0.5rem;
  font-size: 0.75rem;
  color: var(--foreground);
  background: var(--surface-component);
}
</style>
