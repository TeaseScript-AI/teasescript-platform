<script setup lang="ts">
defineProps<{ canRestore: boolean; status: string }>();

defineEmits<{ restore: []; save: [] }>();
</script>

<template>
  <section class="tool-section runtime-session-controls" aria-labelledby="runtime-session-title">
    <h2 id="runtime-session-title">Runtime Session</h2>
    <p>
      Restore rewinds canonical runtime/checkpoint state and the same-session runtime-event history
      used to reconstruct the transcript. Visual Lab settings, tool columns, and fixture-only
      right-rail or composer history stay local.
    </p>
    <button
      id="save-player-checkpoint"
      class="icon-button runtime-session-button"
      type="button"
      @click="$emit('save')"
    >
      Save runtime checkpoint
    </button>
    <button
      id="restore-player-checkpoint"
      class="icon-button runtime-session-button"
      type="button"
      :disabled="!canRestore"
      @click="$emit('restore')"
    >
      Restore runtime checkpoint
    </button>
    <p id="player-runtime-status" class="runtime-session-status" role="status">
      {{ status }}
    </p>
  </section>
</template>
