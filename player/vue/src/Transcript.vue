<script setup lang="ts">
import { ScrollAreaRoot, ScrollAreaViewport } from "reka-ui";
import ScrollBar from "@/components/ui/scroll-area/ScrollBar.vue";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  elementScroll,
  measureElement,
  observeElementRect,
  useVirtualizer,
} from "@tanstack/vue-virtual";
import { ChangedContentMeasurement } from "../../transcript-measurement.js";
import { ConversationEntrances, ConversationGlide } from "../../conversation-motion.js";
import { usePreferredReducedMotion, useResizeObserver } from "@vueuse/core";
import { ArrowDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { PlayerTranscriptEntryPresentation, PlayerSpeakerPresentation } from "../../model.js";
import TranscriptMessage from "./TranscriptMessage.vue";
import { recordSpeakerAvatarMessage, speakerAvatarPalette } from "./speakerAvatar";
import { backdropBehind, resolveColour } from "./messageContrast";
import { adjoins, resolveAppearance } from "./transcriptPresentation";
import { enhancedTranscriptContrast } from "./transcriptContrast";

const props = defineProps<{
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  /** The revision through which updates show directly, like history: what development time jumps published. */
  jumpedRevision?: number;
  bottomInset?: number;
}>();
const avatarOrdinals = reactive(new Map<string, number>());
let assignedEntries = props.entries;
let assignedThrough = 0;
const avatarMessageCounts = Array<number>(speakerAvatarPalette.length).fill(0);
function avatarIdentity(speakerId: string): string {
  return props.speakers[speakerId]?.identityId ?? speakerId;
}
watch(
  [() => props.entries, () => props.entries.length, () => props.revision],
  () => {
    if (props.entries !== assignedEntries || props.entries.length < assignedThrough) {
      avatarOrdinals.clear();
      assignedEntries = props.entries;
      assignedThrough = 0;
      avatarMessageCounts.fill(0);
    }
    for (let index = assignedThrough; index < props.entries.length; index += 1) {
      const entry = props.entries[index]!;
      if (entry.kind !== "message" || entry.speakerId === "user") continue;
      recordSpeakerAvatarMessage(
        avatarOrdinals,
        avatarMessageCounts,
        avatarIdentity(entry.speakerId),
        entry.presentation?.kind !== "prose",
      );
    }
    assignedThrough = props.entries.length;
  },
  { immediate: true },
);
// Whether the entry at `index` is a grey future message of Debug's rewind.
function future(index: number): boolean {
  const entry = props.entries[index];
  return entry?.kind === "message" && entry.future === true;
}
const enhancedContrast = inject(enhancedTranscriptContrast, undefined);
const scrollElement = ref<HTMLDivElement | null>(null);
const scrollViewport = ref<InstanceType<typeof ScrollAreaViewport> | null>(null);
watch(
  () => scrollViewport.value?.viewportElement,
  (element) => {
    scrollElement.value = element instanceof HTMLDivElement ? element : null;
  },
  { flush: "post" },
);
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
// TanStack rebuilds every measurement when the key callback changes identity, so keep one
// callback per entries array instead of one per option update (for example composer growth).
let keyedEntries: readonly PlayerTranscriptEntryPresentation[] | null = null;
let entryKey = (_index: number): string => "";
function itemKeyFor(entries: readonly PlayerTranscriptEntryPresentation[]) {
  if (entries !== keyedEntries) {
    keyedEntries = entries;
    entryKey = (index) => entries[index]!.id;
  }
  return entryKey;
}
const measurement = new ChangedContentMeasurement();
watch(
  () => props.entries,
  () => measurement.clear(),
);
// Each measurement reports the row and content its element shows; an entry updated in place is ahead of the element
// until Vue renders it.
const measureEntry: typeof measureElement<HTMLElement> = (element, entry, instance) => {
  const key = element.dataset.messageId;
  if (key !== undefined)
    measurement.measured(key, element.dataset.contentSequence, entry !== undefined);
  return measureElement(element, entry, instance);
};
// What live play adds enters the conversation, and while the reader follows the newest content, the conversation glides
// up to make room (PLAYER-UI.md "Message presentation and provenance"). History shows directly: what the transcript
// shows when it mounts, for a new session, a restored state, or Debug's rewind; another list of entries, such as when an
// inspected state is adopted; what development time jumps publish; and more than an update can show entering: many
// entries at once, or, while following, more than a viewport of new content.
const ENTERING_AT_MOST = 8;
// How long after a live update the scroll corrections that follow it still glide.
const LIVE_UPDATE_MS = 250;
const reducedMotion = usePreferredReducedMotion();
const historyElement = ref<HTMLElement | null>(null);
const entrances = new ConversationEntrances(() => performance.now());
const glide = new ConversationGlide(
  () => performance.now(),
  () => virtualizer.value.scrollRect?.height ?? 0,
);
let liveUntil = 0;
let shown = { entries: props.entries, length: props.entries.length, revision: props.revision ?? 0 };
// While following, the first entry the latest update added: following scrolls no further than to show it at the top.
let firstNewEntry: number | null = null;
// Whether following stopped there, with more of the update below.
const heldAtNewEntry = ref(false);
// Corrections that follow a live update glide; the reader's own scrolling ends that.
function gliding() {
  return performance.now() < liveUntil && !touching.value && reducedMotion.value !== "reduce";
}
function glideTargets() {
  return [historyElement.value, foregroundElement.value].filter((element) => element !== null);
}
watch(
  [() => props.entries, () => props.revision, () => props.entries.length],
  () => {
    const previous = shown;
    shown = { entries: props.entries, length: props.entries.length, revision: props.revision ?? 0 };
    if (shown.revision === previous.revision && shown.entries === previous.entries) return;
    const added = props.entries.slice(previous.length);
    firstNewEntry =
      following.value && props.entries === previous.entries && added.length > 0
        ? previous.length
        : null;
    if (
      initialPositioning ||
      reducedMotion.value === "reduce" ||
      props.entries !== previous.entries ||
      shown.revision <= (props.jumpedRevision ?? -1) ||
      added.length > ENTERING_AT_MOST
    ) {
      liveUntil = 0;
      entrances.clear();
      glide.stop();
      return;
    }
    liveUntil = performance.now() + LIVE_UPDATE_MS;
    entrances.admit(
      added.flatMap((entry) =>
        entry.kind === "message" && entry.future !== true ? [entry.id] : [],
      ),
    );
  },
  { flush: "pre" },
);
// The answer controls of a new interaction enter with the update that shows them; those of a mounted transcript do not.
let shownControls: Element | null = null;
function showControls(live: boolean) {
  const controls = foregroundElement.value?.querySelector("[data-foreground-controls]") ?? null;
  if (live && controls !== shownControls && controls instanceof HTMLElement)
    entrances.enter(controls);
  shownControls = controls;
}
watch(
  [() => props.entries, () => props.revision],
  () => showControls(performance.now() < liveUntil),
  { flush: "post" },
);
onMounted(() => showControls(false));
function measureRow(element: HTMLElement | null, id: string) {
  virtualizer.value.measureElement(element);
  if (element !== null) entrances.play(id, element);
}
const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>(
  computed(() => {
    // Capture the supplied list so replacing fixtures retains the previous key mapping on prepend.
    void props.revision; // The canonical adapter appends in place and publishes a revision.
    const entries = props.entries;
    return {
      count: entries.length,
      getScrollElement: () => scrollElement.value,
      getItemKey: itemKeyFor(entries),
      estimateSize: () => 140,
      measureElement: measureEntry,
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
        void nextTick(() => {
          const element = scrollElement.value;
          const before = element?.scrollTop ?? 0;
          // Following never scrolls the first entry of an update out of view: there the reader starts reading.
          const first =
            options.adjustments === undefined && firstNewEntry !== null
              ? instance.measurementsCache[firstNewEntry]?.start
              : undefined;
          if (first !== undefined && offset > first + 1) {
            offset = first;
            following.value = false;
            heldAtNewEntry.value = true;
            // The end is no longer the target to reconcile toward.
            instance.scrollToOffset(first);
          }
          elementScroll(offset, options, instance);
          // A correction that keeps the text in view in place moves nothing that is drawn.
          if (
            element !== null &&
            options.adjustments === undefined &&
            gliding() &&
            !glide.shift(glideTargets(), element.scrollTop - before)
          ) {
            liveUntil = 0;
            entrances.clear();
          }
        });
      },
      // Preserve follow/reading intent before changing the viewport and leading space.
      observeElementRect: (instance, callback) =>
        observeElementRect(instance, (rect) => {
          const previous = instance.scrollRect;
          const offset = instance.scrollOffset ?? 0;
          // On growth the browser may already have clamped scrollTop to the new end.
          const following =
            previous === null ||
            previous.height === 0 ||
            instance.getTotalSize() - offset - Math.max(previous.height, rect.height) <=
              latestThreshold;
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
  }),
);
// A message whose text changed out of view keeps the text being read in place as it is measured again on the way up.
virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
  measurement.compensates(item, instance);
// Once Vue has rendered every row, a message whose new text kept its size counts as measured with that text.
watch(
  [() => props.entries, () => props.revision],
  () => {
    const sizes = virtualizer.value.itemSizeCache;
    for (const element of scrollElement.value?.querySelectorAll<HTMLElement>(".transcript-entry") ??
      []) {
      const key = element.dataset.messageId;
      if (key === undefined) continue;
      measurement.rendered(key, element.dataset.contentSequence, sizes.get(key), () =>
        Math.round(element.getBoundingClientRect().height),
      );
    }
  },
  { flush: "post" },
);
watch(endInset, (inset, previous) => {
  const instance = virtualizer.value;
  const previousDistance =
    instance.getTotalSize() -
    instance.options.paddingEnd +
    previous -
    (instance.scrollOffset ?? 0) -
    (instance.scrollRect?.height ?? 0);
  if (inset !== previous && previousDistance <= latestThreshold && !touching.value)
    void nextTick(() => instance.scrollToEnd());
});
const palette = ref({ surface: "#ffffff", canvas: "#ffffff", link: "#0000ee" });
function readPalette() {
  const element = scrollElement.value;
  if (element === null) return;
  palette.value = {
    surface: resolveColour(element, "var(--message-surface)", "#ffffff"),
    canvas: backdropBehind(element),
    link: resolveColour(element, "var(--markup-link)", "#0000ee"),
  };
}
// Theme changes update the document, not this component's props.
let paletteObserver: MutationObserver | null = null;
onMounted(() => {
  paletteObserver = new MutationObserver(readPalette);
  paletteObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-player-theme"],
  });
});
onBeforeUnmount(() => {
  paletteObserver?.disconnect();
});
const rows = computed(() =>
  virtualizer.value.getVirtualItems().map((item) => {
    const entry = props.entries[item.index]!;
    return {
      item,
      entry,
      appearance: resolveAppearance(entry, palette.value, enhancedContrast?.value),
    };
  }),
);
const showLatest = computed(
  () =>
    !touching.value &&
    !virtualizer.value.isScrolling &&
    virtualizer.value.getDistanceFromEnd() >
      (heldAtNewEntry.value
        ? latestThreshold
        : Math.max(80, (virtualizer.value.scrollRect?.height ?? 0) / 2)),
);
const scrolled = computed(() => (virtualizer.value.scrollOffset ?? 0) > 1);
function continues(index: number) {
  return adjoins(props.entries, index, index - 1);
}
function continued(index: number) {
  return adjoins(props.entries, index, index + 1);
}
const following = ref(true);
let initialPositioning = true;
// Read the DOM: the virtualizer may already reflect rows Vue has not rendered.
function readingLatest() {
  const viewport = scrollElement.value;
  return (
    viewport === null ||
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= latestThreshold
  );
}
function rememberFollow() {
  if (!initialPositioning && !touching.value) following.value = readingLatest();
}
// Shrinking row measurements can mimic reaching the end; do not resume follow here.
function releaseFollow() {
  if (!initialPositioning && !touching.value && !readingLatest()) following.value = false;
  else if (readingLatest()) heldAtNewEntry.value = false;
}
// Capture intent before rendering; revision also covers in-place adapter updates.
watch([() => props.entries, () => props.revision, () => props.entries.length], rememberFollow, {
  flush: "pre",
});
let measuredTotal = 0;
let measuredInset = 0;
watch(
  () => [virtualizer.value.getTotalSize(), endInset.value] as const,
  ([total, inset]) => {
    // Exclude composer/control clearance changes from message remeasurement.
    const messagesGrew = total - measuredTotal !== inset - measuredInset;
    measuredTotal = total;
    measuredInset = inset;
    if (!messagesGrew || !following.value || touching.value || props.entries.length === 0) return;
    const instance = virtualizer.value;
    void nextTick(() =>
      instance.scrollToOffset(
        Math.max(instance.getTotalSize() - (instance.scrollRect?.height ?? 0), 0),
      ),
    );
  },
);
// A message changed in place can replace the element inside it that had focus, such as a link. Focus then moves to the
// message itself, without scrolling, and the message is a tab stop only until focus leaves it.
let focusedEntry: string | null = null;
watch(
  () => props.revision,
  () => {
    const active = document.activeElement;
    const entry =
      active instanceof HTMLElement && scrollElement.value?.contains(active)
        ? active.closest<HTMLElement>(".transcript-entry")
        : null;
    focusedEntry = entry?.dataset.messageId ?? null;
  },
  { flush: "pre" },
);
watch(
  () => props.revision,
  () => {
    const id = focusedEntry;
    focusedEntry = null;
    if (
      id === null ||
      (document.activeElement !== null && document.activeElement !== document.body)
    )
      return;
    const entry = scrollElement.value?.querySelector<HTMLElement>(
      `.transcript-entry[data-message-id="${CSS.escape(id)}"]`,
    );
    if (entry === null || entry === undefined) return;
    entry.tabIndex = -1;
    entry.addEventListener("blur", () => entry.removeAttribute("tabindex"), { once: true });
    entry.focus({ preventScroll: true });
  },
  { flush: "post" },
);
function interruptFollow() {
  following.value = false;
  liveUntil = 0;
  firstNewEntry = null;
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
    following.value = false;
    liveUntil = 0;
    firstNewEntry = null;
    virtualizer.value.scrollToOffset(0);
  } else if (event.key === "ArrowUp" || event.key === "PageUp") {
    interruptFollow();
  } else if (event.key === "End") {
    event.preventDefault();
    following.value = true;
    liveUntil = 0;
    firstNewEntry = null;
    heldAtNewEntry.value = false;
    virtualizer.value.scrollToEnd();
  }
}
function returnToLatest() {
  following.value = true;
  liveUntil = 0;
  firstNewEntry = null;
  heldAtNewEntry.value = false;
  virtualizer.value.scrollToEnd();
  scrollElement.value?.focus({ preventScroll: true });
}
onMounted(() => {
  void nextTick(() => {
    readPalette();
    // The viewport, measured rows, and foreground can all grow during the first paint.
    requestAnimationFrame(() => {
      virtualizer.value.scrollToEnd();
      requestAnimationFrame(() => {
        virtualizer.value.scrollToEnd();
        initialPositioning = false;
      });
    });
  });
});
</script>

<template>
  <section
    class="transcript"
    aria-label="Conversation"
    @wheel.stop
    :style="{ '--transcript-bottom-inset': `${bottomInset ?? 0}px` }"
  >
    <!-- Keep the overlay track inside the native viewport. The section stops
         Reka's document wheel handler without cancelling native scrolling. -->
    <ScrollAreaRoot type="scroll" class="transcript-scroll-area">
      <ScrollAreaViewport
        ref="scrollViewport"
        class="transcript-scroll"
        :data-scrolled="scrolled"
        role="region"
        aria-label="Transcript"
        :tabindex="0"
        @keydown="onScrollKeydown"
        @wheel="onWheel"
        @scroll="releaseFollow"
        @touchstart="onTouchStart"
        @touchend="touching = false"
        @touchcancel="touching = false"
      >
        <div class="transcript-scroll-content">
          <div class="transcript-native-overlay">
            <ScrollBar
              reveal-on-hover
              :style="{ height: `${Math.max(0, viewportHeight - (bottomInset ?? 0))}px` }"
            />
          </div>
          <div
            ref="historyElement"
            class="transcript-history"
            :style="{ height: `${virtualizer.getTotalSize()}px` }"
          >
            <div role="list">
              <article
                v-for="{ item, entry, appearance } in rows"
                :key="entry.id"
                :ref="(element) => measureRow(element as HTMLElement | null, entry.id)"
                :data-index="item.index"
                :data-message-id="entry.id"
                :data-content-sequence="
                  entry.kind === 'message' ? entry.contentSequence : undefined
                "
                :data-speaker-id="entry.kind === 'message' ? entry.speakerId : undefined"
                role="listitem"
                :aria-posinset="item.index + 1"
                :aria-setsize="entries.length"
                class="transcript-entry"
                :data-continues="continues(item.index)"
                :data-prose="appearance.placement !== null || undefined"
                :data-future="future(item.index) || undefined"
                :style="{ transform: `translateY(${item.start}px)` }"
              >
                <!-- Debug's rewind: the later messages a restored state has not reached, which Forward restores. -->
                <p
                  v-if="future(item.index) && !future(item.index - 1)"
                  class="future-label"
                  data-future-label
                >
                  Future · Forward restores it
                </p>
                <TranscriptMessage
                  :entry="entry"
                  :speakers="speakers"
                  :avatar-ordinal="
                    entry.kind === 'message'
                      ? avatarOrdinals.get(avatarIdentity(entry.speakerId))
                      : undefined
                  "
                  :appearance="appearance"
                  :continues="continues(item.index)"
                  :continued="continued(item.index)"
                />
              </article>
            </div>
            <div
              ref="foregroundElement"
              class="transcript-foreground"
              :style="{ top: `${virtualizer.getTotalSize() - endInset}px` }"
            >
              <p v-if="!entries.length" class="transcript-empty">No messages yet.</p>
              <slot name="foreground" />
            </div>
          </div>
        </div>
      </ScrollAreaViewport>
    </ScrollAreaRoot>
    <Button
      v-if="showLatest"
      variant="ghost"
      size="icon"
      class="return-to-latest"
      aria-label="Return to latest"
      @click="returnToLatest"
      ><ArrowDown class="size-4"
    /></Button>
  </section>
</template>

<style scoped>
.transcript {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  --message-surface: var(--surface-component);
  --message-separator: var(--border);
  --markup-link: light-dark(oklch(50% 0.17 254), oklch(79% 0.12 240));
  --transcript-typeface: ui-sans-serif, system-ui, sans-serif;
}
/* One native viewport spans the reading column and both surrounding margins. */
.transcript-scroll-area {
  height: 100%;
  width: 100%;
  --scroll-area-bottom-inset: var(--transcript-bottom-inset);
}
/* Keep the track inside the 8px reading gutter while retaining its 5px thumb. */
.transcript-scroll-area :deep([data-slot="scroll-area-scrollbar"][data-orientation="vertical"]) {
  width: 8px;
  padding-inline: 1.5px;
}
:deep(.transcript-scroll-content) {
  min-height: 100%;
  /* While the conversation glides up to new content, what it draws below its end takes no scroll space. */
  overflow-y: clip;
}
:deep(.transcript-scroll) {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  /* Browser scroll anchoring would compete with TanStack's keyed corrections. */
  overflow-anchor: none;
  scrollbar-width: none;
}

:deep(.transcript-scroll:focus-visible) {
  outline: 2px solid var(--focus-ring, var(--border-strong));
  outline-offset: -2px;
}
/* Keep transcript contrast intact above the composer, then reduce it across
   the complete composer height while retaining a faint trace to the bottom. */
:deep(.transcript-scroll) {
  --transcript-top-fade: 0px;
  mask-image:
    linear-gradient(
      to bottom,
      transparent 0,
      black var(--transcript-top-fade),
      black max(var(--transcript-top-fade), calc(100% - var(--composer-top-from-bottom, 0px))),
      rgb(0 0 0 / 20%) calc(100% - var(--composer-bottom-from-bottom, 0px)),
      rgb(0 0 0 / 20%) 100%
    ),
    linear-gradient(
      /* The thumb retains full opacity inside its existing reading gutter. */ to right,
      transparent calc(var(--conversation-offset) + var(--conversation-width) - 8px),
      black calc(var(--conversation-offset) + var(--conversation-width) - 8px),
      black calc(var(--conversation-offset) + var(--conversation-width)),
      transparent calc(var(--conversation-offset) + var(--conversation-width))
    );
}
:deep(.transcript-scroll[data-scrolled="true"]) {
  --transcript-top-fade: 1rem;
}
.transcript-foreground {
  position: absolute;
  left: 0;
  width: 100%;
}
.transcript-history {
  position: relative;
  width: calc(var(--conversation-width) - 2 * var(--conversation-inline-inset));
  margin-inline-start: calc(var(--conversation-offset) + var(--conversation-inline-inset));
}
.transcript-native-overlay {
  position: sticky;
  top: 0;
  height: 0;
  width: var(--conversation-width);
  margin-inline-start: var(--conversation-offset);
  z-index: 1;
}
.transcript-entry {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  padding-block: var(--player-entry-gap) 0;
}
.transcript-entry[data-continues="true"] {
  padding-block-start: 3px;
}
.transcript-entry[data-prose] {
  padding-block: 1.75rem 0.75rem;
}
.transcript-entry[data-future] {
  filter: grayscale(1);
  opacity: 0.72;
}
.future-label {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.transcript-empty {
  padding: 1rem;
  font-size: 0.875rem;
  color: var(--muted-foreground);
}
.return-to-latest {
  position: absolute;
  bottom: calc(var(--transcript-bottom-inset, 0px) + 0.5rem);
  right: calc(
    100% - var(--conversation-offset) - var(--conversation-width) +
      var(--conversation-inline-inset) + 0.25rem
  );
  width: 2.75rem;
  height: 2.75rem;
  border: 1px solid var(--border);
  border-radius: 50%;
  --button-rest: color-mix(in srgb, var(--surface-component) 80%, transparent);
  backdrop-filter: blur(4px);
}
</style>
