<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { elementScroll, observeElementRect, useVirtualizer } from "@tanstack/vue-virtual";
import { useResizeObserver } from "@vueuse/core";
import { ArrowDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { PlayerTranscriptEntryPresentation, PlayerSpeakerPresentation } from "../../../model.js";
import TranscriptMessage from "./TranscriptMessage.vue";
import { backdropBehind, resolveColour } from "./messageContrast";
import { adjoins, resolveAppearance } from "./transcriptPresentation";

const props = defineProps<{
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  bottomInset?: number;
}>();
const scrollElement = ref<HTMLDivElement | null>(null);
const touching = ref(false);
const viewportHeight = ref(0);
const foregroundElement = ref<HTMLElement | null>(null);
const foregroundHeight = ref(0);
useResizeObserver(foregroundElement, () => {
  foregroundHeight.value = foregroundElement.value?.getBoundingClientRect().height ?? 0;
});
// Include the live controls in the same measured scroll extent and follow target.
const endInset = computed(() => (props.bottomInset ?? 0) + foregroundHeight.value);
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
    // A viewport of leading space keeps even a single message scrollable.
    paddingStart: viewportHeight.value,
    paddingEnd: endInset.value,
    anchorTo: "end" as const,
    followOnAppend: true,
    scrollEndThreshold: latestThreshold,
    // Vue commits the new virtual spacer after options change. Apply TanStack's target
    // after that commit so the browser cannot clamp a prepend to the old scroll height.
    scrollToFn: (offset, options, instance) => {
      void nextTick(() => elementScroll(offset, options, instance));
    },
    // Preserve follow/reading intent before changing the viewport and leading space.
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => {
      const previous = instance.scrollRect;
      const offset = instance.scrollOffset ?? 0;
      // On growth the browser may already have clamped scrollTop to the new end.
      const following = previous === null || previous.height === 0 ||
        instance.getTotalSize() - offset - Math.max(previous.height, rect.height) <= latestThreshold;
      viewportHeight.value = rect.height;
      callback(rect);
      if (previous?.height !== rect.height) {
        void nextTick(() => {
          if (following && !touching.value) instance.scrollToEnd();
          else instance.scrollToOffset(offset + rect.height - (previous?.height ?? 0));
        });
      }
    }),
  };
}));
watch(endInset, (inset, previous) => {
  const instance = virtualizer.value;
  const previousDistance = instance.getTotalSize() - instance.options.paddingEnd + previous
    - (instance.scrollOffset ?? 0) - (instance.scrollRect?.height ?? 0);
  if (inset !== previous && previousDistance <= latestThreshold && !touching.value)
    void nextTick(() => instance.scrollToEnd());
});
// The theme's own colours, resolved once rather than modelled: an authored colour has to
// be weighed against the bubble it will really land on, and that bubble comes from a
// palette this component does not own.
const palette = ref({
  surface: "#ffffff",
  canvas: "#ffffff",
  link: "#0000ee",
});
function readPalette() {
  const element = scrollElement.value;
  if (element === null) return;
  palette.value = {
    surface: resolveColour(element, "var(--message-surface)", "#ffffff"),
    // A passage with no panel of its own is read against the page, not against the
    // surface a bubble would have given it.
    canvas: backdropBehind(element),
    link: resolveColour(element, "var(--markup-link)", "#0000ee"),
  };
}
// The palette is applied to the document by whoever owns the theme, so watching our own
// props would miss a change of theme. Follow the document instead.
let paletteObserver: MutationObserver | null = null;
onMounted(() => {
  paletteObserver = new MutationObserver(readPalette);
  paletteObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ["style", "class", "data-phase2c-theme"],
  });
});
onBeforeUnmount(() => { paletteObserver?.disconnect(); });
const rows = computed(() =>
  virtualizer.value.getVirtualItems().map((item) => {
    const entry = props.entries[item.index]!;
    return { item, entry, appearance: resolveAppearance(entry, palette.value) };
  }));
const showLatest = computed(() => !touching.value && !virtualizer.value.isScrolling &&
  virtualizer.value.getDistanceFromEnd() > Math.max(80, (virtualizer.value.scrollRect?.height ?? 0) / 2));
const scrolled = computed(() => (virtualizer.value.scrollOffset ?? 0) > 1);
// Virtual rows are independent, so grouping is decided per row from its neighbours.
function continues(index: number) {
  return adjoins(props.entries, index, index - 1);
}
function continued(index: number) {
  return adjoins(props.entries, index, index + 1);
}
const following = ref(true);
// Asked at the moment a list changes, the virtualizer has already moved its own offset to
// compensate for rows the page has not been given yet, so it would answer for a scroll
// position nobody is looking at. What the reader can see is on the page: ask that.
function readingLatest() {
  const viewport = scrollElement.value;
  return viewport === null ||
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= latestThreshold;
}
function rememberFollow() {
  if (!touching.value) following.value = readingLatest();
}
// Scrolling can only be a reader leaving the latest, never rejoining it: while rows are
// still being measured the list shortens under the scroll, and a moment that merely looks
// like the end would otherwise pull the reader straight back to it. Returning is
// deliberate — the control, the End key, or a new message arriving while already there.
function releaseFollow() {
  if (!touching.value && !readingLatest()) following.value = false;
}
// A scroll event arrives too late to say where the reader was when the list changed, so
// the intent is read off the list still on screen, before this change is rendered.
// The canonical adapter appends in place and publishes a revision, so the list itself
// is not always a new one; watch what actually announces a change.
watch([() => props.entries, () => props.revision, () => props.entries.length],
  rememberFollow, { flush: "pre" });
// Room reserved for the controls also changes the total, and a composer that grows or
// shrinks is not the list saying anything new; that case is reconciled on its own below.
let measuredTotal = 0;
let measuredInset = 0;
watch(() => [virtualizer.value.getTotalSize(), endInset.value] as const, ([total, inset]) => {
  const messagesGrew = total - measuredTotal !== inset - measuredInset;
  measuredTotal = total;
  measuredInset = inset;
  if (!messagesGrew || !following.value || touching.value || props.entries.length === 0) return;
  const instance = virtualizer.value;
  void nextTick(() =>
    instance.scrollToOffset(
      Math.max(instance.getTotalSize() - (instance.scrollRect?.height ?? 0), 0)));
});
function interruptFollow() {
  following.value = false;
  // Replace an in-flight measured end target before native user scrolling starts.
  virtualizer.value.scrollToOffset(scrollElement.value?.scrollTop ?? 0);
}
function onWheel(event: WheelEvent) {
  if (event.deltaY < 0) interruptFollow();
}
function scrollFromMargin(event: WheelEvent) {
  const viewport = scrollElement.value;
  if (!viewport || event.ctrlKey || event.defaultPrevented ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY ||
      viewport.scrollHeight <= viewport.clientHeight) return;
  // Wheel deltas can be pixels, text lines or pages depending on the input device.
  const style = getComputedStyle(viewport);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? lineHeight
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
  event.preventDefault();
  onWheel(event);
  const delta = event.deltaY * unit;
  // interruptFollow schedules its scroll write after Vue's DOM commit; apply
  // this wheel movement after that cancellation, just like a native wheel.
  void nextTick(() => viewport.scrollBy({ top: delta, behavior: "instant" }));
}
defineExpose({ scrollFromMargin });
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
    following.value = false;
    virtualizer.value.scrollToOffset(0);
  } else if (event.key === "ArrowUp" || event.key === "PageUp") {
    interruptFollow();
  } else if (event.key === "End") {
    event.preventDefault();
    following.value = true;
    virtualizer.value.scrollToEnd();
  }
}
function returnToLatest() {
  following.value = true;
  virtualizer.value.scrollToEnd();
  scrollElement.value?.focus({ preventScroll: true });
}
onMounted(() => { void nextTick(() => { readPalette(); virtualizer.value.scrollToEnd(); }); });
</script>

<template>
  <section class="transcript" aria-label="Conversation"
    :style="{ '--transcript-bottom-inset': `${bottomInset ?? 0}px` }">
    <ScrollArea type="scroll" class="transcript-scroll-area" viewport-class="transcript-scroll"
      content-class="transcript-scroll-content"
      @viewport="scrollElement = $event"
      :viewport-attrs="{ 'data-scrolled': scrolled, role: 'region', 'aria-label': 'Transcript',
        tabindex: 0, onKeydown: onScrollKeydown, onWheel: onWheel, onScroll: releaseFollow,
        onTouchstart: onTouchStart, onTouchend: () => touching = false,
        onTouchcancel: () => touching = false }">
      <div class="transcript-history" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <div role="list">
          <article v-for="{ item, entry, appearance } in rows" :key="entry.id"
            :ref="(element) => virtualizer.measureElement(element as HTMLElement | null)"
            :data-index="item.index" :data-message-id="entry.id" :data-speaker-id="entry.kind === 'message' ? entry.speakerId : undefined"
            role="listitem" :aria-posinset="item.index + 1" :aria-setsize="entries.length"
            class="transcript-entry" :data-continues="continues(item.index)"
            :data-prose="appearance.placement !== null || undefined"
            :style="{ transform: `translateY(${item.start}px)` }">
            <TranscriptMessage :entry="entry" :speakers="speakers" :appearance="appearance"
              :continues="continues(item.index)" :continued="continued(item.index)" />
          </article>
        </div>
        <div ref="foregroundElement" class="transcript-foreground"
          :style="{ top: `${virtualizer.getTotalSize() - endInset}px` }">
          <slot name="foreground" />
        </div>
      </div>
      <p v-if="!entries.length" class="transcript-empty">No messages yet.</p>
    </ScrollArea>
    <Button v-if="showLatest" variant="ghost" size="icon" class="return-to-latest"
      aria-label="Return to latest" @click="returnToLatest"><ArrowDown class="size-4" /></Button>
  </section>
</template>

<style scoped>
/* A message is not a panel. It carries authored content, it repeats down a column, and it
   has to read as its own shape. Naming its surfaces here keeps them free to move without
   disturbing anything else that happens to share a token today. */
.transcript {
  position: relative; flex: 1; min-height: 0; min-width: 0;
  --message-surface: var(--surface-component);
  --message-separator: var(--border);
  /* A link has been blue for as long as there have been links, and a reader recognises one
     before reading a word of it. The two tones are the same blue seen in each mode, dark
     enough to read on the page and light enough to read on a dark one. */
  --markup-link: light-dark(oklch(50% 0.17 254), oklch(79% 0.12 240));
  /* What a message falls back to when the typeface its author named is not on this device.
     Without it the browser would drop to its own default instead of the theme's. */
  --transcript-typeface: ui-sans-serif, system-ui, sans-serif;
}
/* Keep clipping and the scrollbar in the existing conversation padding, outside
   the reading column. This also preserves borders at fractional pixel positions. */
.transcript-scroll-area {
  height: 100%;
  width: calc(100% + 2 * var(--conversation-inline-inset));
  margin-inline: calc(-1 * var(--conversation-inline-inset));
  --scroll-area-bottom-inset: var(--transcript-bottom-inset);
}
:deep(.transcript-scroll-content) { padding-inline: var(--conversation-inline-inset); }
:deep(.transcript-scroll) {
  height: 100%; overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain;
  /* Browser scroll anchoring would compete with TanStack's keyed corrections. */
  overflow-anchor: none; scrollbar-width: none;
}

:deep(.transcript-scroll:focus-visible) { outline: 2px solid var(--focus-ring, var(--border-strong)); outline-offset: -2px; }
/* Keep transcript contrast intact above the composer, then reduce it across
   the complete composer height while retaining a faint trace to the bottom. */
:deep(.transcript-scroll) {
  --transcript-top-fade: 0px;
  mask-image: linear-gradient(to bottom,
    transparent 0, black var(--transcript-top-fade),
    black max(var(--transcript-top-fade), calc(100% - var(--composer-top-from-bottom, 0px))),
    rgb(0 0 0 / 20%) calc(100% - var(--composer-bottom-from-bottom, 0px)),
    rgb(0 0 0 / 20%) 100%);
}
:deep(.transcript-scroll[data-scrolled="true"]) { --transcript-top-fade: 1rem; }
.transcript-foreground { position: absolute; left: 0; width: 100%; }
.transcript-history { position: relative; width: 100%; }
/* The gap above a row separates it from the previous one: a run stays tight,
   a change of speaker gets the full separation. */
.transcript-entry { position: absolute; top: 0; left: 0; width: 100%; padding-block: 1rem 0; }
.transcript-entry[data-continues="true"] { padding-block-start: 0.125rem; }
/* Prose is read, not overheard, so it asks for the room a paragraph needs: air above
   and below to separate it from speech. */
.transcript-entry[data-prose] { padding-block: 1.75rem 0.75rem; }
.transcript-empty { padding: 1rem; font-size: 0.875rem; color: var(--muted-foreground); }
.return-to-latest {
  position: absolute; bottom: calc(var(--transcript-bottom-inset, 0px) + 0.5rem); right: 0.25rem; width: 2.75rem; height: 2.75rem;
  border: 1px solid var(--border); border-radius: 50%;
  --button-rest: color-mix(in srgb, var(--surface-component) 80%, transparent);
  backdrop-filter: blur(4px);
}
</style>
