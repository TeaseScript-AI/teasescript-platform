<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Button } from "@/components/ui/button";
import PlayerActionButton from "@/components/PlayerActionButton.vue";

// The start page (PLAYER-UI "Session start and user activation"): the script's title and author from its header above
// the explicit Start, or Continue for the session the script keeps, whose click is the user activation audible playback
// relies on. The debug room's (DEBUGGER.md "Debug room") names its session and, once it has something to delete, offers
// to start it anew.
const props = defineProps<{
  activation: "start" | "continue" | null;
  title: string;
  author: string;
  debugRoom: boolean;
  /** Whether the debug room has a session or saved values to delete. */
  startAnew: boolean;
}>();
defineEmits<{ activate: []; reload: []; reset: [] }>();
const label = computed(() =>
  props.activation === "continue"
    ? props.debugRoom
      ? "Continue debug session"
      : "Continue"
    : props.debugRoom
      ? "Start debug session"
      : "Start",
);
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
    <template v-if="activation">
      <PlayerActionButton data-session-start @click="$emit('activate')">{{ label }}</PlayerActionButton>
      <template v-if="debugRoom && startAnew">
        <p class="mt-4 text-center text-sm text-balance text-muted-foreground">
          Reload deletes the debug session and keeps what it saved. Reset deletes both.
        </p>
        <div class="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="ghost" class="min-h-11" data-debug-reload @click="$emit('reload')">
            Reload session
          </Button>
          <Button type="button" variant="ghost" class="min-h-11" data-debug-reset @click="$emit('reset')">
            Reset session
          </Button>
        </div>
      </template>
    </template>
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
