<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import type { TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/** Reproduces the existing Player ring so candidates can be judged against it. */
const percent = computed(() =>
  props.kind === "mystery" ? 28 : Math.round(Math.min(1, Math.max(0, props.view.elapsed)) * 100),
);
</script>

<template>
  <div class="legacy" aria-hidden="true" :style="{ '--progress': `${percent}%` }"></div>
</template>

<style scoped>
.legacy {
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  background: conic-gradient(
    var(--tl-accent) 0 var(--progress),
    color-mix(in srgb, var(--tl-track) 90%, transparent) var(--progress) 100%
  );
  mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
}
</style>
