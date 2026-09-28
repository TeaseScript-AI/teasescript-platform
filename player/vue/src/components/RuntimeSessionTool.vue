<script setup lang="ts">
import { computed, useId } from "vue";
defineProps<{ canRestore: boolean; status: string }>();
const instanceId = `runtime-session-${useId()}`;
const titleId = computed(() => `${instanceId}-title`);
const saveId = computed(() => `${instanceId}-save`);
const restoreId = computed(() => `${instanceId}-restore`);

defineEmits<{ restore: []; save: [] }>();
</script>

<template>
  <section class="tool-section runtime-session-controls" :aria-labelledby="titleId">
    <h2 :id="titleId">Runtime Session</h2>
    <p>
      Restore rewinds canonical runtime/checkpoint state and the same-session runtime-event history
      used to reconstruct the transcript. Visual Lab settings, tool columns, and fixture-only
      right-rail or composer history stay local.
    </p>
    <button
      :id="saveId"
      data-save-player-checkpoint
      class="icon-button runtime-session-button"
      type="button"
      @click="$emit('save')"
    >
      Save runtime checkpoint
    </button>
    <button
      :id="restoreId"
      data-restore-player-checkpoint
      class="icon-button runtime-session-button"
      type="button"
      :disabled="!canRestore"
      @click="$emit('restore')"
    >
      Restore runtime checkpoint
    </button>
    <p
      :id="`${instanceId}-status`"
      class="runtime-session-status"
      data-player-runtime-status
      role="status"
    >
      {{ status }}
    </p>
  </section>
</template>
