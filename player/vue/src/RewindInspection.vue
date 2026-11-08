<script setup lang="ts">
import { computed } from "vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import type { DebugRewind } from "./useDebugRewind";

// Debug's rewind while a restored state is inspected (DEBUGGER.md "Rewind"): it says the session is a Debug fork,
// what was answered here before, and offers Forward, Resume, and Return to session. Back is each answer's Back to here.
const props = defineProps<{
  rewind: DebugRewind;
  working: boolean;
  /** Whether a switch of the rewind is under way (`switching`), which refuses every control here. */
  switching: boolean;
}>();

const state = computed(() => props.rewind.state.value);
// The answer the interaction shown got before the rewind, when the state shown is a point.
const earlier = computed(() => {
  const { inspection, shown, points } = state.value;
  const point = inspection === null ? undefined : points[inspection.points - 1];
  return point !== undefined && point.id === shown?.id ? (point.response?.text ?? null) : null;
});
const idle = computed(() => !props.working && !props.switching && !props.rewind.busy.value);
</script>

<template>
  <!-- Above the composer, over the transcript's end like the failure card, so it takes pointer input itself. -->
  <div class="rewind-inspection">
    <section
      class="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 text-sm shadow-lg"
      aria-label="Debug rewind"
      data-rewind-inspection
    >
      <Badge variant="secondary" data-rewind-fork>Debug fork</Badge>
      <p v-if="earlier !== null" class="rewind-lead min-w-0 flex-1 break-words" data-rewind-earlier>
        Answered before: {{ earlier }}
      </p>
      <p v-else class="rewind-lead min-w-0 flex-1">An earlier state, paused. New input continues from here.</p>
      <p
        v-if="rewind.problem.value"
        class="w-full text-destructive"
        role="alert"
        data-rewind-problem
      >
        {{ rewind.problem.value }}
      </p>
      <div class="flex flex-wrap gap-2">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="outline"
              class="min-h-11"
              :disabled="!idle || !state.inspection?.canForward"
              data-rewind-forward
              @click="rewind.forward()"
            >
              Forward
            </Button>
          </TooltipTrigger>
          <TooltipContent>Restore the state you went back from</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="outline"
              class="min-h-11"
              :disabled="!idle"
              data-rewind-resume
              @click="rewind.resume()"
            >
              Resume
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go on from this state; the later messages are discarded</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              :variant="idle ? 'default' : 'outline'"
              class="min-h-11"
              :disabled="!idle"
              data-rewind-return
              @click="rewind.returnToSession()"
            >
              Return to session
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go back to the session as it was before the rewind</TooltipContent>
        </Tooltip>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rewind-inspection {
  display: grid;
  justify-items: center;
  padding-bottom: 8px;
}
.rewind-inspection > * {
  max-width: 36rem;
  pointer-events: auto;
}
/* Where a switch's animation has no room beside the bar, it shows at the end of this first line (RewindStatus.vue). */
@container (width < 41rem) {
  .rewind-lead {
    padding-inline-end: 28px;
  }
}
</style>
