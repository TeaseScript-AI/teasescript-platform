<script setup lang="ts">
import type { PlayerTimerKind, PlayerTimerPresentation } from "../../../model.js";
import PlayerTimer from "./PlayerTimer.vue";

defineProps<{
  compactTimers: boolean;
  fullscreenActive: boolean;
  leftOpen: boolean;
  rightDocked: boolean;
  timer: PlayerTimerPresentation;
  timerCount: number;
  timerKind: PlayerTimerKind;
  toolsAvailable: boolean;
}>();

defineEmits<{ toggleFullscreen: []; toggleLeft: []; toggleRight: [] }>();
</script>

<template>
  <div class="title-bg" aria-hidden="true"></div>
  <header class="title-controls">
    <button
      class="icon-button"
      type="button"
      aria-label="Toggle tools"
      aria-controls="leftPanel"
      :aria-expanded="leftOpen"
      :disabled="!toolsAvailable"
      @click="$emit('toggleLeft')"
    >
      <span class="menu-icon" aria-hidden="true"><span></span><span></span><span></span></span>
    </button>

    <div class="title-text">TeaseScript Player</div>

    <div class="toolbar-spacer compact-timer-host">
      <PlayerTimer
        v-if="compactTimers"
        :timer="timer"
        :timer-count="timerCount"
        :timer-kind="timerKind"
      />
    </div>

    <div class="global-controls">
      <button
        class="icon-button right-toggle"
        type="button"
        aria-controls="rightZone"
        :aria-label="
          rightDocked ? 'Use overlay right panel background' : 'Dock right panel background'
        "
        :aria-pressed="rightDocked"
        @click="$emit('toggleRight')"
      >
        <span class="panel-icon" aria-hidden="true"></span>
      </button>

      <button
        class="icon-button fullscreen-toggle"
        type="button"
        :aria-label="fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'"
        :aria-pressed="fullscreenActive"
        @click="$emit('toggleFullscreen')"
      >
        <span class="fullscreen-icon" aria-hidden="true">⛶</span>
      </button>
    </div>
  </header>
</template>
