<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "../../../model.js";

const props = defineProps<{
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
}>();

const transcript = ref<HTMLElement | null>(null);
const followingLatest = ref(true);
const returnVisible = ref(false);
const scrolledFromTop = ref(false);
let settleTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.entries.length,
  async () => {
    if (!followingLatest.value) return;
    await nextTick();
    scrollToLatest("auto");
  },
);

onMounted(() => scrollToLatest("auto"));
onBeforeUnmount(() => {
  if (settleTimer !== null) clearTimeout(settleTimer);
});

function speakerFor(entry: PlayerTranscriptEntryPresentation): PlayerSpeakerPresentation | null {
  if (entry.kind !== "message") return null;
  return props.speakers[entry.speakerId] ?? null;
}

function messageStyle(entry: PlayerTranscriptEntryPresentation): Record<string, string> {
  const speaker = speakerFor(entry);
  return speaker === null
    ? {}
    : { "--speaker-accent": speaker.accent, "--speaker-font": speaker.fontFamily };
}

function handleScroll(): void {
  const element = transcript.value;
  if (element === null) return;
  const distance = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
  scrolledFromTop.value = element.scrollTop > 2;
  followingLatest.value = distance <= 36;
  returnVisible.value = false;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    returnVisible.value = !followingLatest.value;
  }, 140);
}

function returnToLatest(): void {
  followingLatest.value = true;
  returnVisible.value = false;
  scrollToLatest("smooth");
}

function scrollToLatest(behavior: ScrollBehavior): void {
  const element = transcript.value;
  if (element === null) return;
  element.scrollTo({ top: element.scrollHeight, behavior });
}
</script>

<template>
  <section
    ref="transcript"
    class="transcript"
    :data-scrolled-from-top="scrolledFromTop ? 'true' : 'false'"
    role="log"
    aria-live="polite"
    aria-relevant="additions text"
    aria-label="Conversation transcript"
    @scroll.passive="handleScroll"
  >
    <template v-for="entry in entries" :key="entry.id">
      <article
        v-if="entry.kind === 'message' && speakerFor(entry) !== null"
        class="message"
        :class="{ user: entry.speakerId === 'user' }"
        :data-transcript-entry-id="entry.id"
        :style="messageStyle(entry)"
      >
        <div class="message-row">
          <div v-if="entry.speakerId !== 'user'" class="speaker-avatar" aria-hidden="true">
            {{ speakerFor(entry)?.avatar }}
          </div>
          <div class="message-copy">
            <div class="speaker-name">{{ speakerFor(entry)?.name }}</div>
            <div class="message-body">{{ entry.text }}</div>
          </div>
          <div v-if="entry.speakerId === 'user'" class="speaker-avatar" aria-hidden="true">
            {{ speakerFor(entry)?.avatar }}
          </div>
        </div>
      </article>
      <article
        v-else-if="entry.kind === 'session-event'"
        class="session-event"
        :data-transcript-entry-id="entry.id"
      >
        <span class="session-event-text">{{ entry.text }}</span>
      </article>
    </template>
  </section>

  <button
    v-if="returnVisible"
    class="return-to-latest"
    type="button"
    aria-label="Return to latest message"
    @click="returnToLatest"
  >
    <span aria-hidden="true">↓</span>
  </button>
</template>
