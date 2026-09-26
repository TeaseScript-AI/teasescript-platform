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
    <h1 class="player-top-bar-title">
      <span><span class="player-top-bar-title-text">{{ title }}</span></span>
    </h1>
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
  position: absolute;
  z-index: 20;
  inset: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: var(--player-edge-space);
  pointer-events: none;
}
.player-top-bar-tools { display: contents; }
.player-top-bar-tools :deep(button), .player-top-bar-actions {
  flex-shrink: 0;
  pointer-events: auto;
}
.player-top-bar-tools :deep(button) {
  inline-size: var(--player-top-control-size);
  block-size: var(--player-top-control-size);
}
.player-top-bar-actions {
  --action-group-radius: var(--player-top-control-radius);
  display: flex;
  align-items: center;
  gap: 0.125rem;
  box-sizing: border-box;
  block-size: var(--player-top-control-size);
  border: 1px solid var(--media-border);
  border-radius: var(--action-group-radius);
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
}
.player-top-bar-actions :deep(button) {
  inline-size: var(--player-top-control-size);
  block-size: calc(var(--player-top-control-size) - 2px);
  border-radius: 0;
}
/* Match the shared shell without clipping the buttons' keyboard focus rings. */
.player-top-bar-actions :deep(button:first-of-type) {
  border-start-start-radius: calc(var(--action-group-radius) - 1px);
  border-end-start-radius: calc(var(--action-group-radius) - 1px);
}
.player-top-bar-actions :deep(button:last-of-type) {
  border-start-end-radius: calc(var(--action-group-radius) - 1px);
  border-end-end-radius: calc(var(--action-group-radius) - 1px);
}
.player-top-bar-title {
  flex: 1;
  min-width: 0;
  block-size: var(--player-top-control-size);
  display: flex;
  align-items: center;
  font-size: var(--player-title-font-size);
  line-height: calc(1em + 8px);
  font-weight: 500;
}
.player-top-bar-title > span {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-inline-size: 0;
  max-inline-size: 100%;
  block-size: var(--player-top-control-size);
  padding-inline: 12px;
  border-radius: 9999px;
}
.player-top-bar-title-text {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

<!-- Selectors are rooted at this component; slotted controls keep the same material. -->
<style>
/* Title and all top-media controls share one polarity-aware translucent material.
   The surrounding top bar stays transparent so Stage content remains visible. */
[data-player-top-bar] {
  --media-surface: var(--theme-media-surface, oklch(96% 0.01 70 / 58%));
  --media-text: var(--theme-media-text, oklch(15% 0 0));
  --media-border: var(--theme-media-border, oklch(15% 0 0 / 22%));
  --media-shadow: var(--theme-media-shadow, rgb(0 0 0 / 22%));
}
[data-player-top-bar] button {
  --button-rest: transparent;
  --button-hover: var(--theme-media-hover, oklch(86% 0.01 70 / 68%));
  --button-pressed: var(--theme-media-pressed, oklch(78% 0.01 70 / 78%));
  --button-text: var(--media-text);
}
[data-player-top-bar] :is(.player-top-bar-tools button, .player-top-bar-title > span) {
  border: 1px solid var(--media-border);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
}
[data-player-top-bar] .player-top-bar-tools button {
  --button-rest: var(--media-surface);
}
[data-player-top-bar] .player-top-bar-title > span {
  background: var(--media-surface);
  color: var(--media-text);
}
:root[data-phase2c-theme] [data-player-top-bar] button:disabled {
  background: transparent;
  color: var(--theme-media-text-disabled);
}

</style>
