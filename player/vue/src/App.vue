<script setup lang="ts">
import { onMounted, ref } from "vue";
import { DEMO_PRESENTATION } from "../../demo-session.js";
import type { PlayerPresentation } from "../../model.js";
import type { PlayerRuntimeRestorePoint } from "../../runtime-adapter.js";
import PlayerCore from "./PlayerCore.vue";
import TranscriptStressFixture from "./components/TranscriptStressFixture.vue";

const presentation = ref<PlayerPresentation>(DEMO_PRESENTATION);
const playerCore = ref<InstanceType<typeof PlayerCore> | null>(null);
const runtimeSource = ref<string | null>(null);
const runtimeStatus = ref("Loading runtime source…");
const savedRestorePoint = ref<PlayerRuntimeRestorePoint | null>(null);
const fixture =
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fixture");
const transcriptStressFixture = fixture === "transcript-stress";

onMounted(async () => {
  if (transcriptStressFixture) return;
  const [media, source] = await Promise.all([loadDemoMedia(), loadRuntimeSource()]);
  if (media !== null) {
    presentation.value = { ...DEMO_PRESENTATION, media: { ...DEMO_PRESENTATION.media, ...media } };
  }
  if (source !== null) {
    runtimeSource.value = source;
    runtimeStatus.value = "Runtime source loaded.";
  }
});

function saveCheckpoint(): void {
  const restorePoint = playerCore.value?.saveCheckpoint();
  if (restorePoint === undefined) return;
  savedRestorePoint.value = restorePoint;
  runtimeStatus.value = "Runtime checkpoint saved.";
}

function restoreCheckpoint(): void {
  if (savedRestorePoint.value === null) {
    runtimeStatus.value = "No runtime checkpoint has been saved.";
    return;
  }
  playerCore.value?.restoreCheckpoint(savedRestorePoint.value);
  runtimeStatus.value = "Runtime checkpoint restored.";
}

async function loadRuntimeSource(): Promise<string | null> {
  if (fixture === "runtime-unskippable") {
    return 'say unskippable "Locked", 60\nsay "After", 60';
  }
  if (fixture === "runtime-skippable-long") {
    return 'say "Long pacing", 60\nsay "After", 60\nshowButton "Continue"';
  }
  try {
    const response = await fetch("/examples/playground/player-controls.tease", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Runtime source request failed with HTTP ${response.status}.`);
    return await response.text();
  } catch (error) {
    runtimeStatus.value =
      error instanceof Error ? error.message : "Runtime source could not be loaded.";
    return null;
  }
}

async function loadDemoMedia(): Promise<{
  readonly id: string;
  readonly src: string;
  readonly title: string;
} | null> {
  try {
    const response = await fetch("/player/demo-media/random", { cache: "no-store" });
    if (!response.ok) return null;
    const value = (await response.json()) as unknown;
    if (!isDemoMedia(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isDemoMedia(
  value: unknown,
): value is { readonly id: string; readonly src: string; readonly title: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.src === "string" &&
    typeof candidate.title === "string"
  );
}
</script>

<template>
  <TranscriptStressFixture v-if="transcriptStressFixture" />
  <p v-else-if="runtimeSource === null" id="player-runtime-status" role="status">
    {{ runtimeStatus }}
  </p>
  <PlayerCore
    v-else
    ref="playerCore"
    :presentation="presentation"
    :runtime-source="runtimeSource"
    tool-label="Session"
  >
    <template #tool>
      <div class="tool-section runtime-session-controls">
        <button
          id="save-player-checkpoint"
          class="icon-button runtime-session-button"
          type="button"
          @click="saveCheckpoint"
        >
          Save checkpoint
        </button>
        <button
          id="restore-player-checkpoint"
          class="icon-button runtime-session-button"
          type="button"
          :disabled="savedRestorePoint === null"
          @click="restoreCheckpoint"
        >
          Restore checkpoint
        </button>
        <p id="player-runtime-status" class="runtime-session-status" role="status">
          {{ runtimeStatus }}
        </p>
      </div>
    </template>
  </PlayerCore>
</template>
