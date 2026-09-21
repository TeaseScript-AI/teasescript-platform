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
import { inkFor, scrimFor } from "./messageContrast";

const props = defineProps<{
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  bottomInset?: number;
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
// What the author painted on this one message, already resolved: a speaker's colour is a
// colour for words, and what it means for a given message is the runtime's to work out,
// not something to be read back off the speaker and guessed at here. The player's own
// lines are authored by nobody, arrive with no presentation, and stay theme-owned.
// Some entries are also meant to be read rather than heard, and the same resolved
// presentation is what says which: a letter and a note about the interface differ
// because the author gave them different presentation, not because the player sorts them.
function authoredOn(entry: PlayerTranscriptEntryPresentation) {
  return entry.kind === "message" ? entry.presentation ?? null : null;
}
const rows = computed(() => virtualizer.value.getVirtualItems().map((item) => {
  const entry = props.entries[item.index]!;
  const authored = authoredOn(entry);
  const words = authored?.color ?? null;
  const written = authored?.background ?? null;
  const surface = written ?? palette.value.surface;
  // Where both colours are the author's, he wrote them in one breath and was looking
  // straight at the pairing, so it stands as written. Where only the words are his, what
  // they land on is the player's own surface, and covering it until they can be read is
  // the player correcting itself rather than overruling him. The cover goes behind the
  // words and no further: a bubble repainted whole would announce a decision the author
  // never made, while a cover the width of the text reads as what it is.
  const cover = written === null && words !== null ? scrimFor(words, surface) : null;
  return {
    item, entry, cover, panel: written,
    // An unchosen placement arrives as null. Centred is what fills it in: a passage set
    // apart from the column of bubbles reads as the different thing it is, and draws the
    // eye for the same reason.
    placement: authored?.kind !== "prose" ? null : {
      position: authored.position ?? "center",
      text: authored.align ?? "center",
    },
    // Words the author left uncoloured are measured against the surface he chose for
    // them; a colour written behind words is still a colour somebody has to read off.
    ink: words ?? (written === null ? null : inkFor(written)),
    backdrop: surface,
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
// The name is the author's to give. A speaker who was given none shows none, and the space
// it would have taken goes with it; nothing here supplies a stand-in.
function nameOf(entry: PlayerTranscriptEntryPresentation) {
  return entry.kind === "message" ? (props.speakers[entry.speakerId]?.name ?? "").trim() : "";
}
// A run is introduced once; the bubbles below it continue the same speaker.
function showsName(index: number, player: boolean) {
  return !player && startsGroup(index) && nameOf(props.entries[index]!) !== "";
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
        <article v-for="{ item, entry, panel, cover, placement, ink, backdrop } in rows" :key="entry.id"
          :ref="(element) => virtualizer.measureElement(element as HTMLElement | null)"
          :data-index="item.index" :data-message-id="entry.id" :data-speaker-id="entry.kind === 'message' ? entry.speakerId : undefined"
          role="listitem" :aria-posinset="item.index + 1" :aria-setsize="entries.length"
          class="transcript-entry" :data-continues="!startsGroup(item.index)"
          :data-prose="placement !== null || undefined"
          :style="{ transform: `translateY(${item.start}px)` }">
          <!-- Session events carry no authored story text and receive no designed treatment. -->
          <p v-if="entry.kind === 'session-event'" class="session-event">{{ entry.text }}</p>
          <!-- Prose carries no bubble and no avatar. Where the block sits and how its text is
               set are two separate choices: a block can stand on the right while its lines
               still read from the left, which is how a signature sits under a letter. -->
          <div v-else-if="placement" class="prose"
            :data-align="placement.position" :data-text="placement.text"
            :data-panel="panel !== null || undefined"
            :style="{ background: panel ?? undefined, color: ink ?? undefined }">
            <p v-if="showsName(item.index, false)" class="prose-attribution">
              {{ nameOf(entry) }}
            </p>
            <TranscriptMarkup v-if="entry.content" :content="entry.content"
              :backdrop="backdrop" :cover="cover" />
            <template v-else>{{ entry.text }}</template>
          </div>
          <Message v-else :align="entry.speakerId === 'user' ? 'end' : 'start'">
            <!-- The avatar keeps its place through the run so the bubbles stay on one line. -->
            <MessageAvatar v-if="entry.speakerId !== 'user'"
              class="self-start" :class="startsGroup(item.index) ? '' : 'invisible'">
              <Avatar>
                <AvatarFallback class="text-xs font-semibold">{{ speakers[entry.speakerId]?.avatar }}</AvatarFallback>
              </Avatar>
            </MessageAvatar>
            <MessageContent>
              <!-- Two caps, whichever binds first: three quarters of the column keeps a bubble
                   off the edge on a narrow window, and 65ch keeps the line readable on a wide one. -->
              <!-- The player's side is theme-owned and keeps the accent roles as they are. -->
              <Bubble class="max-w-[min(75%,65ch)]"
                :variant="entry.speakerId === 'user' ? 'default' : 'secondary'"
                :align="entry.speakerId === 'user' ? 'end' : 'start'">
                <BubbleContent class="text-base/normal"
                  :class="[cornerClass(item.index, entry.speakerId === 'user'),
                    entry.speakerId === 'user' ? '' : 'message-speaker', panel ? 'message-authored' : '']"
                  :style="{ '--message-authored-fill': panel ?? undefined, color: ink ?? undefined }">
                  <MessageHeader v-if="showsName(item.index, entry.speakerId === 'user')"
                    class="px-0 pb-0.5">
                    {{ nameOf(entry) }}
                  </MessageHeader>
                  <TranscriptMarkup v-if="entry.speakerId !== 'user' && entry.content" :content="entry.content"
                    :backdrop="backdrop" :cover="cover" />
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
  /* A link has been blue for as long as there have been links, and a reader recognises one
     before reading a word of it. The two tones are the same blue seen in each mode, dark
     enough to read on the page and light enough to read on a dark one. */
  --markup-link: light-dark(oklch(50% 0.17 254), oklch(79% 0.12 240));
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
/* That blue belongs to the player's own surfaces. Where the author painted the message he
   chose what would be read there, and the one colour known to work against it is the one
   the message is already set in; a link keeps its underline and says the rest that way. */
.message-authored,
.prose[data-panel] {
  --markup-link: currentColor;
}
/* Where an author's text was broken is part of what was written, and where a player's own
   answer was broken is part of what they said. Marked-up text keeps its own breaks; plain
   text has only this, and without it a typed reply of three lines arrives as one. */
:deep([data-slot="bubble-content"]) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* The name is muted against the page, not against a coloured bubble. Inside one it
   steps back from the bubble's own text colour instead, which follows the mode. */
.message-authored :deep([data-slot="message-header"]) { color: inherit; opacity: 0.72; }
/* Prose is read, not overheard, so it asks for the room a paragraph needs: air above and
   below to separate it from speech, and a looser line than a bubble would carry. */
/* Prose carries no avatar, so it indents for none: left meets the line the avatars stand
   on and right meets the one the player's bubbles end at, which are the two edges the
   column already has. Every position therefore moves the block inside the same box, and
   centre lands between the other two rather than measuring from an edge they never see. */
.transcript-entry[data-prose] { padding-block: 1.75rem 0.75rem; }
.prose {
  /* Shrink-to-fit is what makes the block's own position visible: a short passage sits
     where it was put. A long one would fill whatever it is given, so it is never given
     everything: the slack left over is what its position spends, and on a phone, where the
     measure has no room to show itself, that slack is the only thing left saying which
     side was meant. The share matches a bubble's, so the two readings reach equally far. */
  width: fit-content;
  max-width: min(65ch, 75%);
  font-size: 1rem;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* A passage given a surface has to hold its words off the edge of it, the same distance a
   bubble does, or the colour reads as a stain rather than as a panel. Prose given none
   sits straight on the theme's own canvas and insets for nothing: a panel drawn under it
   anyway would be a colour nobody chose. */
.prose[data-panel] { padding: 0.5rem 0.75rem; border-radius: 0.5rem; }
/* The label is muted against the page; on a panel it steps back from the panel's own
   text colour instead, which is the only one known to read there. */
.prose[data-panel] .prose-attribution { color: inherit; opacity: 0.72; }
.prose[data-align="left"] { margin-inline: 0 auto; }
.prose[data-align="center"] { margin-inline: auto; }
.prose[data-align="right"] { margin-inline: auto 0; }
.prose[data-text="left"] { text-align: left; }
.prose[data-text="center"] { text-align: center; }
.prose[data-text="right"] { text-align: right; }
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
