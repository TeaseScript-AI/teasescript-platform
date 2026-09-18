<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowReactive, watch } from "vue";
import { elementScroll, observeElementRect, useVirtualizer } from "@tanstack/vue-virtual";
import { ArrowDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { PlayerTranscriptEntryPresentation, PlayerSpeakerPresentation } from "../../../model.js";
import TranscriptMarkup from "./TranscriptMarkup.vue";

const props = defineProps<{
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  bottomInset?: number;
}>();
// Reader state survives virtual row unmounts; it is not canonical transcript data.
const revealedSpoilers = shallowReactive(new Set<string>());
const scrollElement = ref<HTMLDivElement | null>(null);
const touching = ref(false);
const latestThreshold = 24;
const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>(computed(() => {
  // Capture the supplied list so replacing fixtures retains the previous key mapping on prepend.
  void props.revision; // The canonical adapter appends in place and publishes a revision.
  const entries = props.entries;
  return {
    count: entries.length,
    getScrollElement: () => scrollElement.value,
    getItemKey: (index: number) => entries[index]!.id,
    estimateSize: () => 140,
    overscan: 5,
    paddingEnd: props.bottomInset ?? 0,
    anchorTo: "end" as const,
    followOnAppend: true,
    scrollEndThreshold: latestThreshold,
    // Vue commits the new virtual spacer after options change. Apply TanStack's target
    // after that commit so the browser cannot clamp a prepend to the old scroll height.
    scrollToFn: (offset, options, instance) => {
      void nextTick(() => elementScroll(offset, options, instance));
    },
    // TanStack observes both viewport and row sizes. Only a viewport-height change needs
    // an explicit follow request; keyed reading-anchor corrections stay with the virtualizer.
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => {
      const previous = instance.scrollRect;
      const following = previous !== null &&
        instance.getTotalSize() - (instance.scrollOffset ?? 0) - previous.height <= latestThreshold;
      callback(rect);
      if (following && !touching.value && previous?.height !== rect.height) {
        void nextTick(() => instance.scrollToEnd());
      }
    }),
  };
}));
watch(() => props.bottomInset ?? 0, (inset, previous) => {
  const instance = virtualizer.value;
  // Recover distance using the previous inset regardless of Vue's options-update order.
  const previousDistance = instance.getTotalSize() - instance.options.paddingEnd + previous
    - (instance.scrollOffset ?? 0) - (instance.scrollRect?.height ?? 0);
  if (inset !== previous && previousDistance <= latestThreshold && !touching.value)
    void nextTick(() => instance.scrollToEnd());
});
const rows = computed(() => virtualizer.value.getVirtualItems().map((item) => ({
  item, entry: props.entries[item.index]!,
})));
const showLatest = computed(() => !touching.value && !virtualizer.value.isScrolling &&
  virtualizer.value.getDistanceFromEnd() > Math.max(80, (virtualizer.value.scrollRect?.height ?? 0) / 2));
const scrolled = computed(() => (virtualizer.value.scrollOffset ?? 0) > 1);
function interruptFollow() {
  // Replace an in-flight measured end target before native user scrolling starts.
  virtualizer.value.scrollToOffset(scrollElement.value?.scrollTop ?? 0);
}
function onWheel(event: WheelEvent) {
  if (event.deltaY < 0) interruptFollow();
}
function onTouchStart() {
  touching.value = true;
  interruptFollow();
}
function onScrollKeydown(event: KeyboardEvent) {
  if (event.target !== scrollElement.value || event.altKey || event.metaKey) return;
  // Native End targets an estimated DOM height. Use the same measured destination as
  // follow-latest, and let Home replace any in-flight end reconciliation.
  if (event.key === "Home") {
    event.preventDefault();
    virtualizer.value.scrollToOffset(0);
  } else if (event.key === "ArrowUp" || event.key === "PageUp") {
    interruptFollow();
  } else if (event.key === "End") {
    event.preventDefault();
    virtualizer.value.scrollToEnd();
  }
}
function returnToLatest() {
  virtualizer.value.scrollToEnd();
  scrollElement.value?.focus({ preventScroll: true });
}
onMounted(() => { void nextTick(() => virtualizer.value.scrollToEnd()); });
</script>

<template>
  <section class="transcript" aria-label="Conversation" :style="{ '--transcript-bottom-inset': `${bottomInset ?? 0}px` }">
    <div ref="scrollElement" class="transcript-scroll" :data-scrolled="scrolled"
      role="region" aria-label="Transcript" tabindex="0" @keydown="onScrollKeydown"
      @wheel.passive="onWheel"
      @touchstart.passive="onTouchStart" @touchend.passive="touching = false" @touchcancel.passive="touching = false">
      <div class="transcript-history" role="list" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <article v-for="{ item, entry } in rows" :key="entry.id"
          :ref="(element) => virtualizer.measureElement(element as HTMLElement | null)"
          :data-index="item.index" :data-message-id="entry.id" :data-speaker-id="entry.kind === 'message' ? entry.speakerId : undefined"
          role="listitem" :aria-posinset="item.index + 1" :aria-setsize="entries.length"
          class="transcript-entry" :style="{ transform: `translateY(${item.start}px)` }">
          <div class="message" :data-author="entry.kind === 'session-event' ? 'session-event' : entry.speakerId === 'user' ? 'player' : 'speaker'">
            <div class="message-copy"><strong v-if="entry.kind === 'message' && entry.speakerId !== 'user'">{{ speakers[entry.speakerId]?.name ?? entry.speakerId }}: </strong><TranscriptMarkup v-if="entry.kind === 'message' && entry.speakerId !== 'user' && entry.content" :content="entry.content" :entry-id="entry.id" :revealed="revealedSpoilers" @reveal="revealedSpoilers.add($event)" /><template v-else>{{ entry.text }}</template></div>
          </div>
        </article>
      </div>
      <p v-if="!entries.length" class="transcript-empty">No messages yet.</p>
    </div>
    <Button v-if="showLatest" variant="ghost" size="icon" class="return-to-latest"
      aria-label="Return to latest" @click="returnToLatest"><ArrowDown class="size-4" /></Button>
  </section>
</template>

<style scoped>
.transcript { position: relative; flex: 1; min-height: 0; min-width: 0; }
.transcript-scroll {
  height: 100%; overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain;
  /* Browser scroll anchoring would compete with TanStack's keyed corrections. */
  overflow-anchor: none; scrollbar-gutter: stable;
}
.transcript-scroll:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
/* Keep transcript contrast intact through the composer's upper half, then
   reduce it below the midpoint while retaining a faint trace to the bottom. */
.transcript-scroll {
  --transcript-top-fade: 0px;
  mask-image: linear-gradient(to bottom,
    transparent 0, black var(--transcript-top-fade),
    black max(var(--transcript-top-fade), calc(100% - (var(--composer-top-from-bottom, 0px) + var(--composer-bottom-from-bottom, 0px)) / 2)),
    rgb(0 0 0 / 10%) calc(100% - var(--composer-bottom-from-bottom, 0px)),
    rgb(0 0 0 / 10%) 100%);
}
.transcript-scroll[data-scrolled="true"] { --transcript-top-fade: 1rem; }
.transcript-history { position: relative; width: 100%; }
.transcript-entry { position: absolute; top: 0; left: 0; width: 100%; padding-block: 0.5rem 1rem; }
.message { max-width: 90%; }
.message-copy {
  margin: 0; max-width: 65ch; white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: 0.875rem; line-height: 1.5;
}
.message[data-author="player"] {
  width: fit-content; margin-left: auto; padding: 0.75rem 1rem;
  border: 1px solid var(--border); border-radius: 0.75rem;
  background: var(--surface-component);
}
.transcript-empty { padding: 1rem; font-size: 0.875rem; color: var(--muted-foreground); }
.return-to-latest {
  position: absolute; bottom: calc(var(--transcript-bottom-inset, 0px) + 0.5rem); right: 0.25rem; width: 2.75rem; height: 2.75rem;
  border: 1px solid var(--border); border-radius: 50%;
  background: color-mix(in srgb, var(--surface-component) 80%, transparent); backdrop-filter: blur(4px);
}
</style>
