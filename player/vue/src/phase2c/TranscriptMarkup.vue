<script setup lang="ts">
import { computed } from "vue";
import type { MessageMarkup } from "../../../../src/message-markup.js";
import { preparePlayerMessageMarkup } from "../../../message-markup.js";
import TranscriptLine from "./TranscriptLine.vue";

const props = defineProps<{
  content: MessageMarkup;
  backdrop: string;
  cover: string | null;
  link: string;
  authoredInk: string | null;
  authoredBackground: boolean;
}>();
const blocks = computed(() => preparePlayerMessageMarkup(props.content));
</script>

<template>
  <div class="transcript-markup">
    <template v-for="(block, bi) in blocks" :key="bi">
      <div
        v-if="block.kind === 'heading'"
        role="heading"
        :aria-level="block.level"
        class="markup-heading"
      >
        <TranscriptLine
          :pieces="block.line.pieces"
          :backdrop="backdrop"
          :cover="cover"
          :link="link"
          :authored-ink="authoredInk"
          :authored-background="authoredBackground"
        />
      </div>
      <component
        :is="block.kind === 'quote' ? 'blockquote' : 'div'"
        v-else-if="block.kind === 'paragraph' || block.kind === 'quote'"
        :class="{ 'markup-paragraph': block.kind === 'paragraph' }"
      >
        <template v-for="(line, li) in block.lines" :key="li"
          ><TranscriptLine
            :pieces="line.pieces"
            :backdrop="backdrop"
            :cover="cover"
            :link="link"
            :authored-ink="authoredInk"
            :authored-background="authoredBackground" /><br v-if="line.ending"
        /></template>
      </component>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else>
        <li v-for="(item, li) in block.items" :key="li" :value="item.ordinal ?? undefined"
          :data-backed="cover !== null || undefined">
          <!-- Native markers cannot paint a background. Keep their numbering and
               list semantics, with an aria-hidden painted copy only when needed. -->
          <span v-if="cover !== null" aria-hidden="true" class="markup-list-marker markup-scrim"
            :style="{ backgroundColor: cover }" />
          <TranscriptLine
            :pieces="item.line.pieces"
            :backdrop="backdrop"
            :cover="cover"
            :link="link"
            :authored-ink="authoredInk"
            :authored-background="authoredBackground"
          />
        </li>
      </component>
    </template>
  </div>
</template>

<style scoped>
.transcript-markup {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.markup-heading {
  font-weight: 700;
  line-height: calc(1em + var(--player-reading-line-gap, 8px));
}
.markup-heading[aria-level="1"] {
  font-size: 1.45em;
}
.markup-heading[aria-level="2"] {
  font-size: 1.2em;
}
.markup-heading[aria-level="3"] {
  font-size: 1em;
}
ol {
  list-style: decimal;
  padding-inline-start: 1.5em;
}
ul {
  list-style: disc;
  padding-inline-start: 1.5em;
}
li[data-backed] {
  position: relative;
}
li[data-backed]::marker {
  color: transparent;
}
.markup-list-marker {
  position: absolute;
  inset-inline-end: calc(100% + 0.25em);
  white-space: nowrap;
}
.markup-list-marker::before {
  content: counter(list-item) ".";
}
ul .markup-list-marker::before {
  content: "•";
}
blockquote {
  border-inline-start: 2px solid var(--border);
  padding-inline-start: 0.75em;
}
:deep(a) {
  color: var(--markup-link);
  text-decoration: underline;
}
:deep(.markup-bold) {
  font-weight: 700;
}
:deep(.markup-italic) {
  font-style: italic;
}
:deep(.markup-strikethrough) {
  text-decoration: line-through;
}
:deep(.markup-underline) {
  text-decoration: underline;
}
:deep(.markup-strikethrough.markup-underline) {
  text-decoration: line-through underline;
}
:deep(.markup-code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: color-mix(in oklab, currentColor 8%, transparent);
  border: 1px solid color-mix(in oklab, currentColor 18%, transparent);
  border-radius: 0.3em;
  padding-inline: 0.3em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
:deep(.markup-scrim) {
  border-radius: 0.2em;
  padding-inline: 0.12em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
:deep(.markup-size-small) {
  font-size: 0.85em;
}
:deep(.markup-size-normal) {
  font-size: 1em;
}
:deep(.markup-size-large) {
  font-size: 1.15em;
}
:deep(.markup-size-x-large) {
  font-size: 1.3em;
}
:deep(:is(.markup-size-small, .markup-size-normal, .markup-size-large, .markup-size-x-large)) {
  line-height: calc(1em + var(--player-reading-line-gap, 8px));
}
</style>
