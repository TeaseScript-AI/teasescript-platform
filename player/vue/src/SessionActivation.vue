<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";

// The start page (PLAYER-UI "Session start and user activation"): the script's title and author from its header above
// the explicit Start, or Continue for the session the script keeps, whose click is the user activation audible playback
// relies on.
const props = defineProps<{
  activation: "start" | "continue" | null;
  title: string;
  author: string;
}>();
defineEmits<{ activate: [] }>();
// Start or Continue takes focus on page load, unless something has it, and when the start page returns (`focus`).
const page = ref<HTMLElement | null>(null);
function focus() {
  page.value?.querySelector<HTMLElement>("[data-session-start]")?.focus();
}
function focusIfIdle() {
  if (document.activeElement === null || document.activeElement === document.body) focus();
}
onMounted(focusIfIdle);
// The control appears once the kept session is known, after the page mounts.
watch(
  () => props.activation !== null,
  (shown) => shown && focusIfIdle(),
  { flush: "post" },
);
defineExpose({ focus });
</script>

<template>
  <div ref="page" class="session-activation" data-session-activation>
    <div v-if="title || author" class="mb-12 grid justify-items-center gap-2 text-center">
      <p v-if="title" class="text-3xl font-semibold text-balance" data-start-title>{{ title }}</p>
      <p v-if="author" class="text-lg text-muted-foreground" data-start-author>by {{ author }}</p>
    </div>
    <PlayerActionButton v-if="activation" data-session-start @click="$emit('activate')">
      {{ activation === "start" ? "Start" : "Continue" }}
    </PlayerActionButton>
  </div>
</template>

<style scoped>
.session-activation {
  position: absolute;
  z-index: 30;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 8px;
  justify-items: center;
  padding: var(--player-edge-space);
  pointer-events: none;
}
.session-activation > * { pointer-events: auto; }
</style>
