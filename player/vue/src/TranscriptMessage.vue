<script setup lang="ts">
import { computed, inject } from "vue";
import { Undo2, Variable } from "@lucide/vue";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import type { PlayerSpeakerPresentation, PlayerTranscriptEntryPresentation } from "../../model.js";
import TranscriptMarkup from "./TranscriptMarkup.vue";
import { nameOf, resolveAppearance } from "./transcriptPresentation";
import { speakerAvatarColors, speakerAvatarSource } from "./speakerAvatar";
import { explainValues } from "./explainValues";
import { rewindRows } from "./rewindPresentation";

const props = defineProps<{
  entry: PlayerTranscriptEntryPresentation;
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  appearance: ReturnType<typeof resolveAppearance>;
  continues: boolean;
  continued: boolean;
  avatarOrdinal: number | undefined;
}>();
const player = props.entry.kind === "message" && props.entry.speakerId === "user";
const speaker = props.entry.kind === "message" ? props.speakers[props.entry.speakerId] : undefined;
const resolveAvatar = inject(speakerAvatarSource, () => null);
const avatarImage = speaker?.avatarImage === undefined ? null : resolveAvatar(speaker.avatarImage);
const name = !player && !props.continues ? nameOf(props.speakers, props.entry) : "";
// While Debug runs, a script's message offers Explain values beside it, by click, tap or keyboard.
const explain = inject(explainValues, null);
const explainable = computed(
  () => !player && props.entry.kind === "message" && explain?.offers(props.entry.id) === true,
);
// While Debug runs, the player's answer to a rewind point offers Back to here.
const rewind = inject(rewindRows, null);
const backable = computed(() => player && rewind?.offers(props.entry.id) === true);
const avatarColors = computed(() => speakerAvatarColors(props.avatarOrdinal ?? 0));
const avatarStyle = computed(() => ({
  "--avatar-light-background": avatarColors.value.light.background,
  "--avatar-light-ink": avatarColors.value.light.color,
  "--avatar-dark-background": avatarColors.value.dark.background,
  "--avatar-dark-ink": avatarColors.value.dark.color,
}));
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
      :authored-ink="appearance.authoredInk"
      :authored-background="appearance.panel !== null"
    />
    <template v-else>{{ entry.text }}</template>
    <div v-if="explainable" class="explain-row">
      <Button
        variant="ghost"
        size="icon"
        class="size-11"
        aria-label="Explain values"
        data-explain-values
        @click="explain!.explain(entry.id)"
      >
        <Variable aria-hidden="true" />
      </Button>
    </div>
  </div>
  <Message v-else :align="player ? 'end' : 'start'">
    <MessageAvatar v-if="!player" class="self-start" :class="continues ? 'invisible' : ''">
      <!-- The visible speaker name identifies the message; the avatar is decorative. -->
      <Avatar aria-hidden="true">
        <AvatarImage v-if="avatarImage" :src="avatarImage" alt="" />
        <AvatarFallback data-speaker-avatar class="text-xs font-semibold" :style="avatarStyle">
          {{ speaker?.avatar }}
        </AvatarFallback>
      </Avatar>
    </MessageAvatar>
    <MessageContent :class="explainable || backable ? 'flex-row items-end' : undefined">
      <Button
        v-if="backable"
        variant="ghost"
        size="sm"
        class="min-h-11 shrink-0"
        data-back-to-here
        @click="rewind!.back(entry.id)"
      >
        <Undo2 aria-hidden="true" />
        Back to here
      </Button>
      <Bubble
        class="max-w-[min(75%,65ch)]"
        :variant="player ? 'default' : 'secondary'"
        :align="player ? 'end' : 'start'"
      >
        <BubbleContent
          size="reading"
          :join-start="continues ? (player ? 'right' : 'left') : undefined"
          :join-end="continued ? (player ? 'right' : 'left') : undefined"
          :class="[player ? '' : 'message-speaker', appearance.panel ? 'message-authored' : '']"
          :style="{
            '--message-authored-fill': appearance.panel ?? undefined,
            color: appearance.ink ?? undefined,
            fontFamily: appearance.typeface ?? undefined,
          }"
        >
          <MessageHeader v-if="name !== ''" inset>{{ name }}</MessageHeader>
          <TranscriptMarkup
            v-if="!player && entry.content"
            :content="entry.content"
            :backdrop="appearance.backdrop"
            :cover="appearance.cover"
            :link="appearance.link"
            :authored-ink="appearance.authoredInk"
            :authored-background="appearance.panel !== null"
          />
          <template v-else
            ><span
              v-if="entry.kind === 'message' && entry.responseKind"
              class="choice-marker"
              aria-hidden="true"
              >&rsaquo; </span
            ><span v-if="entry.kind === 'message' && entry.responseKind" class="sr-only"
              >{{ entry.responseKind === "form" ? "Submitted form: " : "Selected option: " }}</span
            >{{ entry.text }}</template
          >
        </BubbleContent>
      </Bubble>
      <Button
        v-if="explainable"
        variant="ghost"
        size="icon"
        class="size-11 shrink-0"
        aria-label="Explain values"
        data-explain-values
        @click="explain!.explain(entry.id)"
      >
        <Variable aria-hidden="true" />
      </Button>
    </MessageContent>
  </Message>
</template>

<style scoped>
:deep([data-speaker-avatar]) {
  background: light-dark(var(--avatar-light-background), var(--avatar-dark-background));
  color: light-dark(var(--avatar-light-ink), var(--avatar-dark-ink));
}
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
  font-size: var(--player-reading-font-size, 1rem);
  line-height: calc(1em + var(--player-reading-line-gap, 8px));
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
.explain-row {
  display: flex;
  justify-content: flex-end;
  white-space: normal;
}
.session-event {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-muted);
}
</style>
