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
  continues: boolean;
  continued: boolean;
}>();
const player = props.entry.kind === "message" && props.entry.speakerId === "user";
const name = !player && !props.continues ? nameOf(props.speakers, props.entry) : "";
</script>

<template>
  <p v-if="entry.kind === 'session-event'" class="session-event">{{ entry.text }}</p>
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
    <MessageAvatar v-if="!player" class="self-start" :class="continues ? 'invisible' : ''">
      <Avatar>
        <AvatarFallback class="text-xs font-semibold">
          {{ entry.kind === "message" ? speakers[entry.speakerId]?.avatar : "" }}
        </AvatarFallback>
      </Avatar>
    </MessageAvatar>
    <MessageContent>
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
.message-speaker {
  background: var(--message-surface);
  border-color: var(--message-separator);
}
.message-speaker.message-authored {
  background: var(--message-authored-fill);
}
.message-authored,
.prose[data-panel] {
  --markup-link: currentColor;
}
:deep([data-slot="bubble-content"]) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.message-authored :deep([data-slot="message-header"]) {
  color: inherit;
  opacity: 0.72;
}
.prose {
  width: fit-content;
  max-width: min(65ch, 75%);
  font-size: 1rem;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
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
