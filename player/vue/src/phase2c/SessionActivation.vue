<script setup lang="ts">
import PlayerActionButton from "@/components/PlayerActionButton.vue";

// Explicit session activation (PLAYER-UI "Session start and user activation"). The click that starts or
// continues a session is the user activation audible playback relies on; a later refusal offers a retry.
defineProps<{ activation: "start" | "continue" | null; audioBlocked: boolean }>();
defineEmits<{ activate: []; retryAudio: [] }>();
</script>

<template>
  <div v-if="activation" class="session-activation" data-session-activation>
    <PlayerActionButton autofocus @click="$emit('activate')">
      {{ activation === "start" ? "Start" : "Continue" }}
    </PlayerActionButton>
  </div>
  <div v-else-if="audioBlocked" class="session-activation session-activation-audio" role="status">
    <p>The browser blocked audio.</p>
    <PlayerActionButton data-audio-retry @click="$emit('retryAudio')">Enable audio</PlayerActionButton>
  </div>
</template>

<style scoped>
.session-activation {
  position: absolute;
  z-index: 30;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 8px;
  justify-items: center;
  pointer-events: none;
}
.session-activation > * { pointer-events: auto; }
.session-activation-audio {
  inset: var(--player-following-control-top) 0 auto;
}
.session-activation-audio p {
  margin: 0;
  padding: 4px 12px;
  border-radius: 999px;
  color: var(--theme-text-primary);
  background: var(--surface-component);
}
</style>
