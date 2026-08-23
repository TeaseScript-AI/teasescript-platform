<script setup lang="ts">
import { onMounted, ref } from "vue";
import { DEMO_PRESENTATION } from "../../demo-session.js";
import type { PlayerPresentation } from "../../model.js";
import PlayerCore from "./PlayerCore.vue";

const presentation = ref<PlayerPresentation>(DEMO_PRESENTATION);

onMounted(async () => {
  const media = await loadDemoMedia();
  if (media === null) return;
  presentation.value = {
    ...DEMO_PRESENTATION,
    media: { ...DEMO_PRESENTATION.media, ...media },
  };
});

async function loadDemoMedia(): Promise<{
  readonly id: string;
  readonly src: string;
  readonly title: string;
} | null> {
  try {
    const response = await fetch("/player/demo-media/random", { cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json() as unknown;
    if (!isDemoMedia(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isDemoMedia(value: unknown): value is {
  readonly id: string;
  readonly src: string;
  readonly title: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.src === "string"
    && typeof candidate.title === "string";
}
</script>

<template>
  <PlayerCore :presentation="presentation" tool-label="Scene">
    <template #tool>
      <p class="tool-placeholder">No scene details are available in this parity fixture.</p>
    </template>
  </PlayerCore>
</template>
