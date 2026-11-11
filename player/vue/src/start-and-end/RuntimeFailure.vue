<script setup lang="ts">
import { computed, ref } from "vue";
import { CircleAlert } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { RuntimeSessionView } from "../../../../src/index.js";

// A session an error stopped, as one short line above the composer (PLAYER-UI "Session end and failure"): it says so and
// offers Details, which opens the error dialog. A session stopped by the engine's lost connection offers instead what
// recovers it. The transcript and Stage stay.
const props = defineProps<{
  state: Pick<RuntimeSessionView, "failure" | "status"> | null;
  /** The error name of an exception of the Player itself. */
  hostError: string | null;
  /** After a lost connection, what the click recovers: Continue from the last kept point, or Start again. */
  recovery: "start" | "continue" | null;
}>();
const emit = defineEmits<{ details: []; activate: [] }>();

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
  <div v-if="recovery" ref="line" class="runtime-end" data-runtime-end>
    <!-- The button goes below the sentence where both do not fit side by side. -->
    <p
      class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-card py-1 ps-3 pe-1 text-sm text-destructive shadow-sm"
      data-connection-lost
    >
      <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 basis-48">{{
        recovery === "continue"
          ? "The session stopped unexpectedly. You can continue from the last kept point. Progress since then may be lost."
          : "The session stopped unexpectedly."
      }}</span>
      <Button
        variant="outline"
        class="ms-auto min-h-11 shrink-0"
        data-connection-recover
        @click="emit('activate')"
      >
        {{ recovery === "continue" ? "Continue from last kept point" : "Start again" }}
      </Button>
    </p>
  </div>
  <div v-else-if="failure || hostError" ref="line" class="runtime-end" data-runtime-end>
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
