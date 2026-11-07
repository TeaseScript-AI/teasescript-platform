<script setup lang="ts">
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";

defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ tooltip?: string }>(), { tooltip: "Drag to resize" });
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <div v-bind="$attrs" class="resize-handle">
        <span class="resize-handle-marker" aria-hidden="true" />
        <slot />
      </div>
    </TooltipTrigger>
    <TooltipContent side="right">{{ tooltip }}</TooltipContent>
  </Tooltip>
</template>

<style scoped>
.resize-handle {
  position: relative;
  z-index: 35;
  flex: 0 0 var(--player-resize-rail-size);
  align-self: stretch;
  min-block-size: 0;
  border-inline-end: 1px solid var(--border);
  box-sizing: border-box;
  cursor: col-resize;
  touch-action: none;
}

.resize-handle-marker {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-end: 0;
  inline-size: 2px;
  block-size: 32px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--border-strong) 40%, transparent);
  transform: translateY(-50%);
  pointer-events: none;
  transition:
    background-color 120ms ease,
    box-shadow 120ms ease;
}

.resize-handle:hover .resize-handle-marker,
.resize-handle[data-active] .resize-handle-marker {
  background: var(--border-strong);
}

.resize-handle:focus-visible {
  outline: none;
}

.resize-handle:focus-visible .resize-handle-marker {
  background: var(--focus-ring);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--focus-ring) 28%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .resize-handle-marker {
    transition: none;
  }
}
</style>
