<script setup lang="ts">
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from "reka-ui";

withDefaults(defineProps<{ initialStageSize?: number }>(), { initialStageSize: 60 });
const hitAreaMargins = { fine: 0, coarse: 0 };
</script>

<template>
  <div class="player-composition relative flex min-h-0 min-w-0 flex-1">
    <slot name="topbar" />
    <SplitterGroup direction="vertical" class="min-h-0 min-w-0 flex-1">
      <SplitterPanel :default-size="initialStageSize" :min-size="20" class="flex min-h-0 flex-col">
        <slot name="stage" />
      </SplitterPanel>
      <SplitterResizeHandle class="conversation-resize" aria-label="Resize media and conversation"
        title="Drag or use arrow keys to resize media and conversation"
        :hit-area-margins="hitAreaMargins">
        <span aria-hidden="true" />
      </SplitterResizeHandle>
      <SplitterPanel :default-size="100 - initialStageSize" :min-size="20" class="flex min-h-0 flex-col">
        <slot />
      </SplitterPanel>
    </SplitterGroup>
  </div>
</template>

<style scoped>
.conversation-resize { position: relative; flex: 0 0 24px; width: 56px; height: 24px; margin-block: -12px; align-self: center; z-index: 3; }
.conversation-resize > span {
  position: absolute; width: 32px; height: 2px; left: 50%; top: 11px;
  transform: translateX(-50%); border-radius: 999px;
  background: var(--border-strong); opacity: 0.45; pointer-events: none;
}
.conversation-resize:hover > span,
.conversation-resize[data-state="drag"] > span { opacity: 1; }
.conversation-resize:focus-visible { outline: none; }
.conversation-resize:focus-visible > span {
  opacity: 1; background: var(--focus-ring);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--focus-ring) 28%, transparent);
}
</style>
