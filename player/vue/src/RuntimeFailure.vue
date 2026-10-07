<script setup lang="ts">
import { computed, ref } from "vue";
import { CircleAlert, RotateCcw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { RuntimeSessionView } from "../../../src/index.js";

// How a session ended, as one short line above the composer (PLAYER-UI "Session end and failure"): after an error it
// says so and offers Details, which opens the error dialog; after an ordinary end, once the end dialog is closed, it
// offers Play again. The transcript and Stage stay.
const props = defineProps<{
  state: Pick<RuntimeSessionView, "failure" | "status"> | null;
  /** The error name of an exception of the Player itself. */
  hostError: string | null;
  canPlayAgain: boolean;
  /** While the end dialog is open, the end line waits until it closes, so the end is said once. */
  endDialogOpen: boolean;
}>();
const emit = defineEmits<{ details: []; playAgain: [] }>();

const failure = computed(() => props.state?.failure ?? null);
const ended = computed(
  () => props.state?.status === "halted" && props.hostError === null && !props.endDialogOpen,
);
const line = ref<HTMLElement | null>(null);
defineExpose({
  /** Focuses the line's control, where a dialog about the end returns focus; `false` without one. */
  focus(): boolean {
    const control = line.value?.querySelector("button");
    control?.focus();
    return control !== null && control !== undefined;
  },
});
</script>

<template>
  <div v-if="failure || hostError || ended" ref="line" class="runtime-end" data-runtime-end>
    <p
      v-if="failure || hostError"
      class="flex items-center gap-2 rounded-md border bg-card py-1 ps-3 pe-1 text-sm text-destructive shadow-sm"
      data-runtime-failure
    >
      <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0">{{
        failure ? "The script stopped because of an error." : "The Player ran into an error."
      }}</span>
      <Button
        variant="outline"
        class="min-h-11 shrink-0"
        data-runtime-failure-details
        @click="emit('details')"
      >
        Details
      </Button>
    </p>
    <p
      v-else
      class="flex items-center gap-1 rounded-md border bg-card ps-3 text-sm text-muted-foreground shadow-sm"
      :class="canPlayAgain ? 'pe-1' : 'py-2 pe-3'"
      role="status"
      data-runtime-ended
    >
      The end.
      <Button
        v-if="canPlayAgain"
        variant="ghost"
        class="min-h-11"
        data-runtime-play-again
        @click="emit('playAgain')"
      >
        <RotateCcw />
        Play again
      </Button>
    </p>
  </div>
</template>

<style scoped>
/* In the conversation overlay above the composer, which is measured, so the transcript scrolls clear of it. */
.runtime-end {
  display: grid;
  justify-items: center;
  padding-bottom: 8px;
}
.runtime-end > * {
  max-width: 36rem;
  pointer-events: auto;
}
</style>
