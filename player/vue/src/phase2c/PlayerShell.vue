<script setup lang="ts">
import { computed } from "vue";
import { TooltipProvider } from "reka-ui";
import { providePlayerConditions } from "./usePlayerConditions";

defineProps<{ stageHeight: number; mediaAspect: number; fullscreen: boolean }>();
const conditions = providePlayerConditions(computed(() => 0));
const { viewport } = conditions;
</script>

<template>
  <div
    class="player-viewport-canvas"
    :style="{
      '--stage-height': `${stageHeight}px`,
      '--usable-width': `${viewport.width}px`,
      '--usable-height': `${viewport.height}px`,
      '--viewport-left': `${viewport.left}px`,
      '--viewport-top': `${viewport.top}px`,
    }"
  >
    <TooltipProvider :delay-duration="0">
    <main
      class="phase2c-sidebar fixed inset-x-0 flex min-h-0 flex-col overflow-hidden"
      :data-player-horizontal="conditions.horizontalConstrained.value ? 'constrained' : 'comfortable'"
      :data-player-vertical="conditions.verticalConstrained.value ? 'constrained' : 'comfortable'"
      :data-player-touch="conditions.touchAvailable.value ? 'available' : 'unavailable'"
      :data-player-hover="conditions.hoverAvailable.value ? 'available' : 'unavailable'"
      :data-player-fullscreen="fullscreen ? 'active' : 'inactive'"
      :data-player-touch-edge="conditions.touchAtScreenEdge.value ? 'protected' : 'normal'"
      :data-player-keyboard="conditions.keyboardRaised.value ? 'raised' : 'closed'"
      :data-player-edge="conditions.edgeClearance.value ? 'protected' : 'normal'"
      :style="{ '--media-aspect': mediaAspect, '--content-reserve': '0px' }"
    >
      <slot />
    </main>
    </TooltipProvider>
  </div>
</template>
