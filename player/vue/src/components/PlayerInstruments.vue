<script setup lang="ts">
defineProps<{ fullscreenActive: boolean; leftOpen: boolean; toolsAvailable: boolean }>();

defineEmits<{ toggleFullscreen: []; toggleLeft: [] }>();
</script>

<template>
  <nav class="player-instruments" aria-label="Player controls">
    <div class="player-wordmark" aria-label="TeaseScript Player">
      <span class="wordmark-full">Tease<br />Script</span><span class="wordmark-compact">TS</span>
    </div>
    <div class="instrument-timers"><slot name="timers" /></div>
    <div class="global-controls">
      <slot name="session" />
      <button
        class="icon-button tools-toggle"
        type="button"
        aria-label="Toggle tools"
        aria-controls="leftPanel"
        :aria-expanded="leftOpen"
        :disabled="!toolsAvailable"
        @click="$emit('toggleLeft')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M9 4v6M15 14v6" /></svg
        ><span>Tools</span>
      </button>
      <button
        class="icon-button fullscreen-toggle"
        type="button"
        :aria-label="fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'"
        :aria-pressed="fullscreenActive"
        @click="$emit('toggleFullscreen')"
      >
        <svg v-if="!fullscreenActive" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9h5V4m6 0v5h5M9 20v-5H4m16 0h-5v5" />
        </svg>
        <span>{{ fullscreenActive ? "Exit" : "Expand" }}</span>
      </button>
    </div>
  </nav>
</template>
