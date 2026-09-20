<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { elementScroll, observeElementRect, useVirtualizer } from "@tanstack/vue-virtual";
import { ArrowDown } from "@lucide/vue";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import type { PlayerTranscriptEntryPresentation, PlayerSpeakerPresentation } from "../../../model.js";
import TranscriptMarkup from "./TranscriptMarkup.vue";
import type { TranscriptDesign } from "./transcriptDesign";
import { inkFor } from "./messageContrast";

const props = defineProps<{
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  bottomInset?: number;
  design: TranscriptDesign;
}>();
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
// The theme's own colours, resolved once rather than modelled: an authored colour has to
// be weighed against the bubble it will really land on, and that bubble comes from a
// palette this component does not own.
const palette = ref({
  surface: "#ffffff",
});
function readPalette() {
  const element = scrollElement.value;
  if (element === null) return;
  palette.value = {
    surface: getComputedStyle(element).getPropertyValue("--message-surface").trim() || "#ffffff",
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
// An authored colour is content, so it is carried through exactly as written; "inherit"
// means the speaker sets none. The player's side is not authored at all and keeps the
// theme's own accent roles.
function authoredFill(entry: PlayerTranscriptEntryPresentation) {
  if (entry.kind !== "message" || entry.speakerId === "user") return null;
  const accent = props.speakers[entry.speakerId]?.accent;
  return accent !== undefined && accent !== "inherit" ? accent : null;
}
// Some entries are meant to be read rather than heard: narration, a description, a letter.
// What marks one is a content question this component does not answer; the narrator stands
// in for it here so the reading itself can be judged.
function isProse(entry: PlayerTranscriptEntryPresentation) {
  return entry.kind === "message" && entry.speakerId === "narrator";
}
const rows = computed(() => virtualizer.value.getVirtualItems().map((item) => {
  const entry = props.entries[item.index]!;
  const prose = props.design.prose !== "bubble" && isProse(entry);
  // Prose has no bubble to fill, so an authored colour has nothing to land on here.
  const fill = prose ? null : authoredFill(entry);
  return {
    item, entry, fill, prose,
    // Whatever an authored colour turns out to be, the words on it are measured against it.
    ink: fill === null ? null : inkFor(fill),
    backdrop: fill ?? palette.value.surface,
  };
}));
const showLatest = computed(() => !touching.value && !virtualizer.value.isScrolling &&
  virtualizer.value.getDistanceFromEnd() > Math.max(80, (virtualizer.value.scrollRect?.height ?? 0) / 2));
const scrolled = computed(() => (virtualizer.value.scrollOffset ?? 0) > 1);
// Virtual rows are independent, so grouping is decided per row from its neighbours.
function sameSpeaker(index: number, other: number) {
  const entry = props.entries[index];
  const neighbour = props.entries[other];
  return entry?.kind === "message" && neighbour?.kind === "message" &&
    neighbour.speakerId === entry.speakerId;
}
function startsGroup(index: number) {
  return !sameSpeaker(index, index - 1);
}
function endsGroup(index: number) {
  return !sameSpeaker(index, index + 1);
}
// A run is introduced once; the bubbles below it continue the same speaker.
function showsName(index: number, player: boolean) {
  return !player && startsGroup(index);
}
// Flattening the touching corners makes a run read as one block instead of separate cards.
// Only the speaker's own side is flattened: bubbles all start there, so they truly meet,
// while the free side ends wherever the text happens to wrap.
// Tailwind scans for literal class names, so every corner is spelled out.
function cornerClass(index: number, player: boolean) {
  const classes: string[] = [];
  if (!startsGroup(index)) classes.push(player ? "rounded-tr-sm" : "rounded-tl-sm");
  if (!endsGroup(index)) classes.push(player ? "rounded-br-sm" : "rounded-bl-sm");
  return classes.join(" ");
}
function interruptFollow() {
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
onMounted(() => { void nextTick(() => { readPalette(); virtualizer.value.scrollToEnd(); }); });
</script>

<template>
  <section class="transcript" aria-label="Conversation"
    :style="{ '--transcript-bottom-inset': `${bottomInset ?? 0}px` }">
    <ScrollArea type="scroll" class="transcript-scroll-area" viewport-class="transcript-scroll"
      content-class="transcript-scroll-content"
      @viewport="scrollElement = $event"
      :viewport-attrs="{ 'data-scrolled': scrolled, role: 'region', 'aria-label': 'Transcript',
        tabindex: 0, onKeydown: onScrollKeydown, onWheel: onWheel,
        onTouchstart: onTouchStart, onTouchend: () => touching = false,
        onTouchcancel: () => touching = false }">
      <div class="transcript-history" role="list" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <article v-for="{ item, entry, fill, prose, ink, backdrop } in rows" :key="entry.id"
          :ref="(element) => virtualizer.measureElement(element as HTMLElement | null)"
          :data-index="item.index" :data-message-id="entry.id" :data-speaker-id="entry.kind === 'message' ? entry.speakerId : undefined"
          role="listitem" :aria-posinset="item.index + 1" :aria-setsize="entries.length"
          class="transcript-entry" :data-continues="!startsGroup(item.index)"
          :data-prose="prose ? design.prose : undefined"
          :style="{ transform: `translateY(${item.start}px)` }">
          <!-- Session events carry no authored story text and receive no designed treatment. -->
          <p v-if="entry.kind === 'session-event'" class="session-event">{{ entry.text }}</p>
          <!-- A reading column leaves the conversation's alignment behind entirely: no side,
               no avatar, a measure of its own and the attribution set above the text. -->
          <div v-else-if="prose && design.prose === 'column'" class="prose-column">
            <p v-if="startsGroup(item.index)" class="prose-attribution">
              {{ speakers[entry.speakerId]?.name ?? entry.speakerId }}
            </p>
            <TranscriptMarkup v-if="entry.content" :content="entry.content"
              :entry-id="entry.id" :backdrop="backdrop" :revealed="revealedSpoilers"
              @reveal="revealedSpoilers.add($event)" />
            <template v-else>{{ entry.text }}</template>
          </div>
          <Message v-else :align="entry.speakerId === 'user' ? 'end' : 'start'">
            <!-- The avatar keeps its place through the run so the bubbles stay on one line. -->
            <MessageAvatar v-if="entry.speakerId !== 'user'"
              class="self-start" :class="startsGroup(item.index) && !prose ? '' : 'invisible'">
              <Avatar>
                <AvatarFallback class="text-xs font-semibold">{{ speakers[entry.speakerId]?.avatar }}</AvatarFallback>
              </Avatar>
            </MessageAvatar>
            <MessageContent>
              <!-- Two caps, whichever binds first: three quarters of the column keeps a bubble
                   off the edge on a narrow window, and 65ch keeps the line readable on a wide one. -->
              <!-- The player's side is theme-owned and keeps the accent roles as they are. -->
              <!-- Quiet prose keeps the conversation's own column and simply takes off the
                   bubble's skin, so a passage can follow a line of dialogue without moving. -->
              <Bubble :class="prose ? 'max-w-[65ch]' : 'max-w-[min(75%,65ch)]'"
                :variant="entry.speakerId === 'user' ? 'default' : 'secondary'"
                :align="entry.speakerId === 'user' ? 'end' : 'start'">
                <BubbleContent class="text-base/normal"
                  :class="[prose ? 'prose-quiet' : cornerClass(item.index, entry.speakerId === 'user'),
                    entry.speakerId === 'user' || prose ? '' : 'message-speaker', fill ? 'message-authored' : '']"
                  :style="fill ? { '--message-authored-fill': fill, color: ink } : undefined">
                  <MessageHeader v-if="showsName(item.index, entry.speakerId === 'user')"
                    class="px-0 pb-0.5">
                    {{ speakers[entry.speakerId]?.name ?? entry.speakerId }}
                  </MessageHeader>
                  <TranscriptMarkup v-if="entry.speakerId !== 'user' && entry.content" :content="entry.content"
                    :entry-id="entry.id" :backdrop="backdrop" :revealed="revealedSpoilers"
                    @reveal="revealedSpoilers.add($event)" />
                  <template v-else>{{ entry.text }}</template>
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        </article>
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
.transcript-history { position: relative; width: 100%; }
/* The gap above a row separates it from the previous one: a run stays tight,
   a change of speaker gets the full separation. */
.transcript-entry { position: absolute; top: 0; left: 0; width: 100%; padding-block: 1rem 0; }
.transcript-entry[data-continues="true"] { padding-block-start: 0.125rem; }
/* A message is its own shape before it is a colour, and a bubble can sit close enough to
   the canvas that only its edge tells them apart. The faint line does that work, so an
   authored fill is never altered merely to be seen. */
.message-speaker {
  background: var(--message-surface);
  border-color: var(--message-separator);
}
.message-speaker.message-authored { background: var(--message-authored-fill); }
/* The name is muted against the page, not against a coloured bubble. Inside one it
   steps back from the bubble's own text colour instead, which follows the mode. */
.message-authored :deep([data-slot="message-header"]) { color: inherit; opacity: 0.72; }
/* Prose is read, not overheard, so it asks for the room a paragraph needs: air above and
   below to separate it from speech, and a looser line than a bubble would carry. */
.transcript-entry[data-prose] { padding-block: 1.75rem 0.75rem; }
.prose-quiet {
  background: none;
  border-color: transparent;
  padding-inline: 0;
  padding-block: 0;
  line-height: 1.7;
}
.prose-column {
  max-width: 68ch;
  margin-inline: auto;
  padding-inline: 1rem;
  font-size: 1.0625rem;
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Attribution for prose is a label on the passage, not a speaker in a conversation. */
.prose-attribution {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.session-event { margin: 0; font-size: 0.8125rem; color: var(--text-muted); }
.transcript-empty { padding: 1rem; font-size: 0.875rem; color: var(--muted-foreground); }
.return-to-latest {
  position: absolute; bottom: calc(var(--transcript-bottom-inset, 0px) + 0.5rem); right: 0.25rem; width: 2.75rem; height: 2.75rem;
  border: 1px solid var(--border); border-radius: 50%;
  --button-rest: color-mix(in srgb, var(--surface-component) 80%, transparent);
  backdrop-filter: blur(4px);
}
</style>
