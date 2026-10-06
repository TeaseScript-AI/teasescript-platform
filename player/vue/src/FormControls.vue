<script setup lang="ts">
import { Toggle } from "reka-ui";
import { Badge } from "@/components/ui/badge";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import PlayerActionButton from "./components/PlayerActionButton.vue";
import type { PlayerFormPresentation } from "../../model.js";

// One form stays in place while the player edits it: its fields wrap and scroll in a bounded region, and the submit
// button and the status stay visible below them.
defineProps<{ form: PlayerFormPresentation; accessibleName: string; disabled: boolean }>();
const emit = defineEmits<{ step: [fieldId: string]; submit: [] }>();
</script>

<template>
  <div data-foreground-controls data-form-controls role="group" :aria-label="accessibleName" class="flex min-w-0 flex-col items-center">
    <ScrollArea data-form-fields class="w-full">
      <div class="flex w-full min-w-0 flex-wrap justify-center gap-2">
        <template v-for="field in form.fields" :key="field.id">
          <!-- A toggle is a pressed button; its mark and the announced state, not its colour, show whether it is on. -->
          <Toggle
            v-if="field.kind === 'toggle'"
            as-child
            :model-value="field.pressed"
            :disabled="disabled"
            @update:model-value="emit('step', field.id)"
          >
            <PlayerActionButton :authored-fill="field.authoredFill" :disabled="disabled">
              <span aria-hidden="true">{{ field.state === null ? (field.pressed ? "✓ " : "✗ ") : "" }}</span
              >{{ field.label }}<template v-if="field.state !== null">: {{ field.state }}</template>
            </PlayerActionButton>
          </Toggle>
          <PlayerActionButton
            v-else
            :authored-fill="field.authoredFill"
            :disabled="disabled"
            @click="emit('step', field.id)"
          >
            {{ field.label }}: {{ field.state }} <span aria-hidden="true">↻</span>
          </PlayerActionButton>
        </template>
      </div>
    </ScrollArea>
    <div class="flex w-full min-w-0 flex-wrap items-center justify-center gap-2" data-form-actions>
      <PlayerActionButton
        :authored-fill="form.submit.authoredFill"
        :disabled="disabled"
        :label="form.submit.label"
        @click="emit('submit')"
      />
      <Badge variant="outline" role="status" aria-live="polite">{{ form.status }}</Badge>
    </div>
  </div>
</template>

<style scoped>
[data-form-controls] {
  gap: 8px;
  padding-block-start: var(--player-entry-gap);
}
/* An on toggle stays pressed in, besides its check mark and announced state. */
[data-form-controls] [data-state="on"] {
  background: var(--story-choice-pressed);
  box-shadow: inset 0 1px 3px #00000030;
}
/* Many fields scroll inside the form, so the submit button stays in reach, also above a software keyboard. */
[data-form-fields] :deep([data-reka-scroll-area-viewport]) {
  max-height: min(30dvh, 24rem);
}
</style>
