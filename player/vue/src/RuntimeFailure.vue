<script setup lang="ts">
import { computed, ref } from "vue";
import { CircleAlert } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { RuntimeSessionView } from "../../../src/index.js";

// A session an error stopped, as one short line above the composer (PLAYER-UI "Session end and failure"): it says so and
// offers Details, which opens the error dialog. The transcript and Stage stay.
const props = defineProps<{
  state: Pick<RuntimeSessionView, "failure" | "status"> | null;
  /** The error name of an exception of the Player itself. */
  hostError: string | null;
}>();
const emit = defineEmits<{ details: [] }>();

const failure = computed(() => props.state?.failure ?? null);
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
  <div v-if="failure || hostError" ref="line" class="runtime-end" data-runtime-end>
    <p
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
