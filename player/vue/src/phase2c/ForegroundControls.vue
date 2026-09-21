<script setup lang="ts">
import StoryChoice from "./StoryChoice.vue";
import type { PlayerForegroundPresentation } from "../../../model.js";
defineProps<{ foreground: PlayerForegroundPresentation | null; disabled: boolean }>();
const emit = defineEmits<{ activate: [optionId: string | null] }>();
</script>
<template>
  <div
    data-foreground-controls
    v-if="foreground?.kind === 'choose' || foreground?.kind === 'show-button'"
    role="group"
    :aria-label="foreground.accessibleName"
    class="flex min-w-0 flex-wrap justify-center gap-[12px] px-1 py-3"
  >
    <template v-if="foreground.kind === 'choose'">
      <StoryChoice
        v-for="option in foreground.options"
        :key="option.id"
        :authored-fill="option.authoredFill"
        :disabled="disabled"
        @click="emit('activate', option.id)"
        >{{ option.label }}</StoryChoice
      >
    </template>
    <StoryChoice
      v-else
      :authored-fill="foreground.authoredFill"
      :aria-label="foreground.accessibleName"
      :disabled="disabled"
      @click="emit('activate', null)"
      >{{ foreground.label }}</StoryChoice
    >
  </div>
</template>
