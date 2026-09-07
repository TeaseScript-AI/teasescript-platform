<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import type {
  PlayerMessagePresentation,
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "../../../model.js";

const FOLLOW_DISTANCE_PX = 36;
const SCROLL_SETTLE_MS = 140;
const TOP_FADE_DISTANCE_PX = 2;
const MESSAGE_ESTIMATE_PX = 96;
const SESSION_EVENT_ESTIMATE_PX = 32;

const props = defineProps<{
  entries: readonly PlayerTranscriptEntryPresentation[];
  revision?: number;
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
}>();

const transcript = ref<HTMLElement | null>(null);
const followingLatest = ref(true);
const returnVisible = ref(false);
const scrolledFromTop = ref(false);
const scrollSettled = ref(true);
const touchActive = ref(false);
const pointerActive = ref(false);
const returningLatest = ref(false);
const virtualizerOptions = computed(() => {
  void props.revision;
  const entries = props.entries;
  return {
    count: entries.length,
    getScrollElement: () => transcript.value,
    estimateSize: (index: number) =>
      entries[index]?.kind === "session-event" ? SESSION_EVENT_ESTIMATE_PX : MESSAGE_ESTIMATE_PX,
    getItemKey: (index: number) => entries[index]?.id ?? `missing-entry-${index}`,
    anchorTo: "end" as const,
    followOnAppend: true,
    scrollEndThreshold: FOLLOW_DISTANCE_PX,
    overscan: 6,
    gap: 12,
  };
});
const virtualizer = useVirtualizer(virtualizerOptions);
const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame: number | null = null;

onMounted(() => {
  const element = transcript.value;
  if (element !== null) {
    resizeObserver = new ResizeObserver(handleTranscriptResize);
    resizeObserver.observe(element);
  }
  void nextTick(() => {
    requestAnimationFrame(() => scrollToLatest("auto"));
  });
});

onBeforeUnmount(() => {
  if (settleTimer !== null) clearTimeout(settleTimer);
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
  resizeObserver?.disconnect();
});

function speakerFor(entry: PlayerTranscriptEntryPresentation): PlayerSpeakerPresentation | null {
  if (entry.kind !== "message") return null;
  return props.speakers[entry.speakerId] ?? null;
}

function entryFor(index: number): PlayerTranscriptEntryPresentation | null {
  return props.entries[index] ?? null;
}

function messageFor(index: number): PlayerMessagePresentation | null {
  const entry = entryFor(index);
  return entry?.kind === "message" ? entry : null;
}

function speakerForIndex(index: number): PlayerSpeakerPresentation | null {
  const entry = messageFor(index);
  return entry === null ? null : speakerFor(entry);
}

function messageStyleFor(index: number): Record<string, string> {
  const entry = messageFor(index);
  return entry === null ? {} : messageStyle(entry);
}

function entryId(index: number): string | undefined {
  return entryFor(index)?.id;
}

function entryText(index: number): string | undefined {
  return entryFor(index)?.text;
}

function isUserMessage(index: number): boolean {
  return messageFor(index)?.speakerId === "user";
}

function isSessionEvent(index: number): boolean {
  return entryFor(index)?.kind === "session-event";
}

function messageStyle(entry: PlayerTranscriptEntryPresentation): Record<string, string> {
  const speaker = speakerFor(entry);
  return speaker === null
    ? {}
    : {
        "--speaker-accent": speaker.accent,
        ...(speaker.fontFamily === "inherit" ? {} : { "--speaker-font": speaker.fontFamily }),
      };
}

function virtualItemStyle(start: number): CSSProperties {
  return {
    position: "absolute",
    insetInlineStart: 0,
    inlineSize: "100%",
    transform: `translateY(${start}px)`,
  };
}

function measureElement(node: unknown): void {
  if (node instanceof HTMLElement) virtualizer.value.measureElement(node);
}

function handleTranscriptResize(): void {
  if (!followingLatest.value) return;
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    if (followingLatest.value) scrollToLatest("auto");
  });
}

function handleScroll(): void {
  const element = transcript.value;
  if (element === null) return;
  const atEnd = virtualizer.value.isAtEnd(FOLLOW_DISTANCE_PX);
  scrolledFromTop.value = element.scrollTop > TOP_FADE_DISTANCE_PX;
  updateFollowState(atEnd);
  if (!returningLatest.value) scrollSettled.value = false;
  returnVisible.value = false;
  scheduleScrollSettled();
  requestAnimationFrame(() => {
    if (transcript.value === null) return;
    updateFollowState(virtualizer.value.isAtEnd(FOLLOW_DISTANCE_PX));
  });
}

function updateFollowState(atEnd: boolean): void {
  if (returningLatest.value) {
    if (atEnd) {
      returningLatest.value = false;
      followingLatest.value = true;
      scrollSettled.value = true;
    }
    return;
  }
  followingLatest.value = atEnd;
}

function markInteractionStart(): void {
  returningLatest.value = false;
  scrollSettled.value = false;
  returnVisible.value = false;
  scheduleScrollSettled();
}

function markTouchStart(): void {
  touchActive.value = true;
  markInteractionStart();
}

function markTouchEnd(): void {
  touchActive.value = false;
  scheduleScrollSettled();
}

function markPointerStart(event: PointerEvent): void {
  pointerActive.value = true;
  markInteractionStart();
  transcript.value?.setPointerCapture(event.pointerId);
}

function markPointerEnd(event: PointerEvent): void {
  pointerActive.value = false;
  const element = transcript.value;
  if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  scheduleScrollSettled();
}

function scheduleScrollSettled(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (touchActive.value || pointerActive.value) return;
    scrollSettled.value = true;
    if (virtualizer.value.isAtEnd(FOLLOW_DISTANCE_PX)) followingLatest.value = true;
    returnVisible.value = !followingLatest.value;
  }, SCROLL_SETTLE_MS);
}

function returnToLatest(): void {
  returningLatest.value = true;
  followingLatest.value = true;
  scrollSettled.value = true;
  returnVisible.value = false;
  scrollToLatest("auto");
}

function scrollToLatest(behavior: ScrollBehavior): void {
  virtualizer.value.scrollToEnd({ behavior });
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
    @touchstart.passive="markTouchStart"
    @touchend.passive="markTouchEnd"
    @touchcancel.passive="markTouchEnd"
    @pointerdown.passive="markPointerStart"
    @pointerup.passive="markPointerEnd"
    @pointercancel.passive="markPointerEnd"
    @lostpointercapture.passive="markPointerEnd"
    @wheel.passive="markInteractionStart"
  >
    <div class="transcript-virtualizer" :style="{ blockSize: `${totalSize}px` }">
      <div
        v-for="virtualItem in virtualItems"
        :key="String(virtualItem.key)"
        :ref="measureElement"
        class="transcript-virtual-item"
        :data-index="virtualItem.index"
        :style="virtualItemStyle(virtualItem.start)"
      >
        <article
          v-if="messageFor(virtualItem.index) !== null"
          class="message"
          :class="{ user: isUserMessage(virtualItem.index) }"
          :data-transcript-entry-id="entryId(virtualItem.index)"
          :style="messageStyleFor(virtualItem.index)"
        >
          <div class="message-row">
            <div
              v-if="!isUserMessage(virtualItem.index) && speakerForIndex(virtualItem.index)?.avatar"
              class="speaker-avatar"
              aria-hidden="true"
            >
              {{ speakerForIndex(virtualItem.index)?.avatar }}
            </div>
            <div class="message-copy">
              <div v-if="speakerForIndex(virtualItem.index)?.name" class="speaker-name">
                {{ speakerForIndex(virtualItem.index)?.name }}
              </div>
              <div class="message-body">{{ entryText(virtualItem.index) }}</div>
            </div>
            <div
              v-if="isUserMessage(virtualItem.index) && speakerForIndex(virtualItem.index)?.avatar"
              class="speaker-avatar"
              aria-hidden="true"
            >
              {{ speakerForIndex(virtualItem.index)?.avatar }}
            </div>
          </div>
        </article>
        <article
          v-else-if="isSessionEvent(virtualItem.index)"
          class="session-event"
          :data-transcript-entry-id="entryId(virtualItem.index)"
        >
          <span class="session-event-text">{{ entryText(virtualItem.index) }}</span>
        </article>
      </div>
    </div>
  </section>

  <button
    v-if="returnVisible && scrollSettled"
    class="return-to-latest"
    type="button"
    aria-label="Return to latest message"
    @click="returnToLatest"
  >
    <span aria-hidden="true">↓</span>
  </button>
</template>
