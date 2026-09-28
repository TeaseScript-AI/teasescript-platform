<script setup lang="ts">
import { ref } from "vue";
import type {
  PlayerMessagePresentation,
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "../../../model.js";
import PlayerTranscript from "./PlayerTranscript.vue";

const INITIAL_HISTORY_SIZE = 2_000;
const PREPEND_BATCH_SIZE = 12;

const firstIndex = ref(0);
const nextIndex = ref(INITIAL_HISTORY_SIZE);
const entries = ref<readonly PlayerTranscriptEntryPresentation[]>(
  makeEntries(0, INITIAL_HISTORY_SIZE),
);
const compact = ref(false);
const speakers: Readonly<Record<string, PlayerSpeakerPresentation>> = {
  eva: { name: "Mistress Eva", accent: "#9e3f56", avatar: "E", fontFamily: "inherit" },
  user: { name: "You", accent: "#4d7180", avatar: "Y", fontFamily: "inherit" },
};

function makeEntries(start: number, count: number): readonly PlayerTranscriptEntryPresentation[] {
  return Array.from({ length: count }, (_, offset) => makeEntry(start + offset));
}

function makeEntry(index: number): PlayerMessagePresentation {
  const longText =
    index % 7 === 0
      ? " This deliberately wraps across several lines so the virtualizer must measure a changing message height."
      : "";
  const user = index % 5 === 0;
  return {
    kind: "message",
    id: `stress-${index}`,
    speakerId: user ? "user" : "eva",
    text: `${user ? "Reply" : "History"} ${index}: stable anchor content.${longText}`,
  };
}

function prependHistory(): void {
  const start = firstIndex.value - PREPEND_BATCH_SIZE;
  firstIndex.value = start;
  entries.value = [...makeEntries(start, PREPEND_BATCH_SIZE), ...entries.value];
}

function appendMessage(): void {
  const index = nextIndex.value;
  nextIndex.value += 1;
  entries.value = [...entries.value, makeEntry(index)];
}

function growLatest(): void {
  const latest = entries.value.at(-1);
  if (latest?.kind !== "message") return;
  entries.value = [
    ...entries.value.slice(0, -1),
    {
      ...latest,
      text: `${latest.text} Streaming output grows below the current reading anchor. `.repeat(5),
    },
  ];
}

function toggleFixtureSize(): void {
  compact.value = !compact.value;
}
</script>

<template>
  <main
    class="transcript-stress-fixture"
    data-transcript-fixture="stress"
    :data-compact="String(compact)"
  >
    <header class="transcript-stress-controls" aria-label="Transcript stress fixture controls">
      <span>Development transcript fixture</span>
      <button type="button" data-stress-prepend @click="prependHistory">Load older</button>
      <button type="button" data-stress-append @click="appendMessage">Add latest</button>
      <button type="button" data-stress-grow @click="growLatest">Grow latest</button>
      <button type="button" data-stress-resize @click="toggleFixtureSize">Resize viewport</button>
      <output data-stress-count>{{ entries.length }} entries</output>
    </header>
    <PlayerTranscript :entries="entries" :speakers="speakers" />
  </main>
</template>

<style scoped>
.transcript-stress-fixture {
  --color-surface-canvas: #f4ede6;
  --color-surface-component: #fffaf5;
  --color-text-primary: #493b35;
  --color-text-muted: #806e65;
  --color-border-default: #d9c8ba;
  --conversation-max-width: 900px;
  --conversation-gap: 18px;
  --safe-left: 0px;
  --safe-right: 0px;
  --transcript-edge-fade: 28px;

  position: relative;
  inline-size: min(100vw, 980px);
  block-size: 100vh;
  margin: 0 auto;
  overflow: hidden;
  background: var(--color-surface-canvas);
  color: var(--color-text-primary);
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

.transcript-stress-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--color-border-default);
  background: var(--color-surface-component);
  font-size: 12px;
}

.transcript-stress-controls span {
  margin-inline-end: auto;
  font-weight: 700;
}

.transcript-stress-controls button {
  padding: 5px 8px;
  border: 1px solid var(--color-border-default);
  border-radius: 5px;
  background: var(--color-surface-canvas);
  color: inherit;
  cursor: pointer;
}

.transcript-stress-controls output {
  min-inline-size: 72px;
  text-align: right;
}

.transcript-stress-fixture :deep(.transcript) {
  position: relative;
  inset: auto;
  inline-size: 100%;
  block-size: var(--fixture-transcript-size);
  grid-column: auto;
  grid-row: auto;
}

.transcript-stress-fixture[data-compact="false"] {
  --fixture-transcript-size: 560px;
}

.transcript-stress-fixture[data-compact="true"] {
  --fixture-transcript-size: 280px;
}

.transcript-stress-fixture :deep(.return-to-latest) {
  position: absolute;
  inset: auto 12px 12px auto;
  margin: 0;
  grid-column: auto;
  grid-row: auto;
}
</style>
