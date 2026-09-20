<script setup lang="ts">
import { Button } from "@/components/ui/button";
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
      <Button
        v-for="option in foreground.options"
        :key="option.id"
        variant="outline"
        class="h-auto min-h-9 max-w-full min-w-0 whitespace-normal [overflow-wrap:anywhere]"
        :disabled="disabled"
        @click="emit('activate', option.id)"
        >{{ option.label }}</Button
      >
    </template>
    <Button
      v-else
      variant="outline"
      class="h-auto min-h-9 max-w-full min-w-0 whitespace-normal [overflow-wrap:anywhere]"
      :aria-label="foreground.accessibleName"
      :disabled="disabled"
      @click="emit('activate', null)"
      >{{ foreground.label }}</Button
    >
  </div>
</template>
