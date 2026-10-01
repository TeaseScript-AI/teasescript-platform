<script setup lang="ts">
import PlayerActionButton from "@/components/PlayerActionButton.vue";

// Explicit session activation (PLAYER-UI "Session start and user activation"). The click that starts or
// continues a session is the user activation audible playback relies on.
defineProps<{ activation: "start" | "continue" | null }>();
defineEmits<{ activate: [] }>();
</script>

<template>
  <div v-if="activation" class="session-activation" data-session-activation>
    <PlayerActionButton autofocus @click="$emit('activate')">
      {{ activation === "start" ? "Start" : "Continue" }}
    </PlayerActionButton>
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
</style>
