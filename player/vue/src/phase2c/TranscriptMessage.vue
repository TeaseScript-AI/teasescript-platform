<script setup lang="ts">
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import type { PlayerSpeakerPresentation, PlayerTranscriptEntryPresentation } from "../../../model.js";
import TranscriptMarkup from "./TranscriptMarkup.vue";
import { cornerClass, nameOf, resolveAppearance } from "./transcriptPresentation";

const props = defineProps<{
  entry: PlayerTranscriptEntryPresentation;
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  appearance: ReturnType<typeof resolveAppearance>;
  /** Whether the entry above and below belong to the same visual group. */
  continues: boolean;
  continued: boolean;
}>();
const player = props.entry.kind === "message" && props.entry.speakerId === "user";
// A run is introduced once; the bubbles below it continue the same speaker.
const name = !player && !props.continues ? nameOf(props.speakers, props.entry) : "";
</script>

<template>
  <!-- Session events carry no authored story text and receive no designed treatment. -->
  <p v-if="entry.kind === 'session-event'" class="session-event">{{ entry.text }}</p>
  <!-- Where a passage sits and how its text is set are two separate choices: a block can
       stand on the right while its lines still read from the left, which is how a
       signature sits under a letter. -->
  <div
    v-else-if="appearance.placement"
    class="prose"
    :data-align="appearance.placement.position"
    :data-text="appearance.placement.text"
    :data-panel="appearance.panel !== null || undefined"
    :style="{
      background: appearance.panel ?? undefined,
      color: appearance.ink ?? undefined,
      fontFamily: appearance.typeface ?? undefined,
    }"
  >
    <p v-if="name !== ''" class="prose-attribution">{{ name }}</p>
    <TranscriptMarkup
      v-if="entry.content"
      :content="entry.content"
      :backdrop="appearance.backdrop"
      :cover="appearance.cover"
      :link="appearance.link"
    />
    <template v-else>{{ entry.text }}</template>
  </div>
  <Message v-else :align="player ? 'end' : 'start'">
    <!-- The avatar keeps its place through the run so the bubbles stay on one line. -->
    <MessageAvatar v-if="!player" class="self-start" :class="continues ? 'invisible' : ''">
      <Avatar>
        <AvatarFallback class="text-xs font-semibold">
          {{ entry.kind === "message" ? speakers[entry.speakerId]?.avatar : "" }}
        </AvatarFallback>
      </Avatar>
    </MessageAvatar>
    <MessageContent>
      <!-- Two caps, whichever binds first: three quarters of the column keeps a bubble off
           the edge on a narrow window, and 65ch keeps the line readable on a wide one.
           The player's side is theme-owned and keeps the accent roles as they are. -->
      <Bubble
        class="max-w-[min(75%,65ch)]"
        :variant="player ? 'default' : 'secondary'"
        :align="player ? 'end' : 'start'"
      >
        <BubbleContent
          class="text-base/normal"
          :class="[
            cornerClass(continues, continued, player),
            player ? '' : 'message-speaker',
            appearance.panel ? 'message-authored' : '',
          ]"
          :style="{
            '--message-authored-fill': appearance.panel ?? undefined,
            color: appearance.ink ?? undefined,
            fontFamily: appearance.typeface ?? undefined,
          }"
        >
          <MessageHeader v-if="name !== ''" class="px-0 pb-0.5">{{ name }}</MessageHeader>
          <TranscriptMarkup
            v-if="!player && entry.content"
            :content="entry.content"
            :backdrop="appearance.backdrop"
            :cover="appearance.cover"
            :link="appearance.link"
          />
          <!-- A reply that was chosen rather than typed says so: the mark is decorative and
               the label carries it to a reader who hears the transcript instead. -->
          <template v-else
            ><span
              v-if="entry.kind === 'message' && entry.responseKind"
              class="choice-marker"
              aria-hidden="true"
              >&rsaquo; </span
            ><span v-if="entry.kind === 'message' && entry.responseKind" class="sr-only"
              >Selected option: </span
            >{{ entry.text }}</template
          >
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
</template>

<style scoped>
/* A message is its own shape before it is a colour, and a bubble can sit close enough to
   the canvas that only its edge tells them apart. The faint line does that work, so an
   authored fill is never altered merely to be seen. */
.message-speaker {
  background: var(--message-surface);
  border-color: var(--message-separator);
}
.message-speaker.message-authored {
  background: var(--message-authored-fill);
}
/* The page's link blue belongs to the player's own surfaces. Where the author painted the
   message, the one colour known to work against it is the one the message is already set
   in; a link keeps its underline and says the rest that way. */
.message-authored,
.prose[data-panel] {
  --markup-link: currentColor;
}
/* Where an author's text was broken is part of what was written, and the same goes for a
   player's own answer. Marked-up text keeps its own breaks; plain text has only this. */
:deep([data-slot="bubble-content"]) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* The name is muted against the page, not against a coloured bubble. Inside one it steps
   back from the bubble's own text colour instead, which follows the mode. */
.message-authored :deep([data-slot="message-header"]) {
  color: inherit;
  opacity: 0.72;
}
.prose {
  /* Shrink-to-fit is what makes the block's own position visible: a short passage sits
     where it was put. A long one is never given everything, so the slack left over is what
     its position spends — on a phone, the only thing left saying which side was meant. */
  width: fit-content;
  max-width: min(65ch, 75%);
  font-size: 1rem;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* A passage given a surface holds its words off the edge of it, the same distance a bubble
   does, or the colour reads as a stain rather than as a panel. Prose given none insets for
   nothing: a panel drawn under it anyway would be a colour nobody chose. */
.prose[data-panel] {
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
}
.prose[data-panel] .prose-attribution {
  color: inherit;
  opacity: 0.72;
}
.prose[data-align="left"] {
  margin-inline: 0 auto;
}
.prose[data-align="center"] {
  margin-inline: auto;
}
.prose[data-align="right"] {
  margin-inline: auto 0;
}
.prose[data-text="left"] {
  text-align: left;
}
.prose[data-text="center"] {
  text-align: center;
}
.prose[data-text="right"] {
  text-align: right;
}
/* Attribution for prose is a label on the passage, not a speaker in a conversation. */
.prose-attribution {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.session-event {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-muted);
}
</style>
