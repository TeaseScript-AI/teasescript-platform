<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip/index.js";

/*
  Global chrome floats over the top of the stage instead of reserving a band, so
  the same composition serves normal, short and fullscreen presentation. Every
  required global control stays visible rather than auto-hiding.
*/
defineProps<{
  fullscreenActive: boolean;
  leftOpen: boolean;
  rightDocked: boolean;
  title: string;
  toolsAvailable: boolean;
  tooltipHost: HTMLElement | null;
}>();

defineEmits<{ toggleFullscreen: []; toggleLeft: []; toggleRight: [] }>();
</script>

<template>
  <header class="global-bar">
    <Tooltip :disabled="tooltipHost === null">
      <TooltipTrigger as-child>
        <button
          class="icon-button instrument"
          type="button"
          aria-label="Toggle tools"
          aria-controls="leftPanel"
          :aria-expanded="leftOpen"
          :disabled="!toolsAvailable"
          @click="$emit('toggleLeft')"
        >
          <span class="menu-icon" aria-hidden="true"><span></span><span></span><span></span></span>
        </button>
      </TooltipTrigger>
      <TooltipContent v-if="tooltipHost !== null" :to="tooltipHost">Tools</TooltipContent>
    </Tooltip>

    <p class="global-title instrument">{{ title }}</p>

    <div class="global-actions">
      <Tooltip :disabled="tooltipHost === null">
        <TooltipTrigger as-child>
          <button
            class="icon-button instrument right-toggle"
            type="button"
            aria-controls="rightZone"
            :aria-label="
              rightDocked ? 'Use floating background controls' : 'Dock background controls'
            "
            :aria-pressed="rightDocked"
            @click="$emit('toggleRight')"
          >
            <span class="panel-icon" aria-hidden="true"></span>
          </button>
        </TooltipTrigger>
        <TooltipContent v-if="tooltipHost !== null" :to="tooltipHost">
          {{ rightDocked ? "Float background controls" : "Dock background controls" }}
        </TooltipContent>
      </Tooltip>

      <Tooltip :disabled="tooltipHost === null">
        <TooltipTrigger as-child>
          <button
            class="icon-button instrument fullscreen-toggle"
            type="button"
            :aria-label="fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'"
            :aria-pressed="fullscreenActive"
            @click="$emit('toggleFullscreen')"
          >
            <span class="fullscreen-icon" aria-hidden="true">⛶</span>
          </button>
        </TooltipTrigger>
        <TooltipContent v-if="tooltipHost !== null" :to="tooltipHost">
          {{ fullscreenActive ? "Exit fullscreen" : "Fullscreen" }}
        </TooltipContent>
      </Tooltip>
    </div>
  </header>
</template>
