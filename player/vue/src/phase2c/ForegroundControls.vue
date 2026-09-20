<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import { Button } from "@/components/ui/button";
import type { PlayerForegroundPresentation } from "../../../model.js";
defineProps<{ foreground: PlayerForegroundPresentation | null; disabled: boolean }>();
const emit = defineEmits<{ activate: [optionId: string | null] }>();
</script>
<template>
  <ScrollArea
    type="scroll"
    orientation="horizontal"
    v-if="foreground?.kind === 'choose' || foreground?.kind === 'show-button'"
    role="group"
    :aria-label="foreground.accessibleName"
    class="pointer-events-auto mb-2"
    content-class="flex min-w-0 [justify-content:safe_center] gap-2 p-1 pb-2"
  >
    <template v-if="foreground.kind === 'choose'">
      <Button
        v-for="option in foreground.options"
        :key="option.id"
        variant="outline"
        class="h-auto min-h-9 max-w-full shrink-0 whitespace-normal break-words"
        :disabled="disabled"
        @click="emit('activate', option.id)"
        >{{ option.label }}</Button
      >
    </template>
    <Button
      v-else
      variant="outline"
      class="h-auto min-h-9 max-w-full shrink-0 whitespace-normal break-words"
      :aria-label="foreground.accessibleName"
      :disabled="disabled"
      @click="emit('activate', null)"
      >{{ foreground.label }}</Button
    >
  </ScrollArea>
</template>
