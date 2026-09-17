<script setup lang="ts">
import { computed } from "vue";
import type { MessageMarkup } from "../../../../src/message-markup.js";
import { preparePlayerMessageMarkup } from "../../../message-markup.js";
import TranscriptLine from "./TranscriptLine.vue";

const props = defineProps<{
  content: MessageMarkup;
  entryId: string;
  revealed: ReadonlySet<string>;
}>();
const emit = defineEmits<{ reveal: [key: string] }>();
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
          :groups="block.line.groups"
          :line-key="`${entryId}:${bi}:0`"
          :revealed="revealed"
          @reveal="emit('reveal', $event)"
        />
      </div>
      <component
        :is="block.kind === 'quote' ? 'blockquote' : 'div'"
        v-else-if="block.kind === 'paragraph' || block.kind === 'quote'"
        :class="{ 'markup-paragraph': block.kind === 'paragraph' }"
      >
        <template v-for="(line, li) in block.lines" :key="li"
          ><TranscriptLine
            :groups="line.groups"
            :line-key="`${entryId}:${bi}:${li}`"
            :revealed="revealed"
            @reveal="emit('reveal', $event)" /><br v-if="line.ending"
        /></template>
      </component>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else>
        <li v-for="(item, li) in block.items" :key="li" :value="item.ordinal ?? undefined">
          <TranscriptLine
            :groups="item.line.groups"
            :line-key="`${entryId}:${bi}:${li}`"
            :revealed="revealed"
            @reveal="emit('reveal', $event)"
          />
        </li>
      </component>
    </template>
  </div>
</template>

<style scoped>
.transcript-markup {
  display: inline;
}
.markup-paragraph:first-child {
  display: inline;
}
.markup-heading {
  font-weight: 700;
}
ol {
  list-style: decimal;
  padding-inline-start: 1.5em;
}
ul {
  list-style: disc;
  padding-inline-start: 1.5em;
}
blockquote {
  border-inline-start: 2px solid var(--border);
  padding-inline-start: 0.75em;
}
:deep(a) {
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
  font-family: monospace;
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
:deep(.transcript-spoiler) {
  color: transparent;
  background: var(--text-muted);
  border-radius: 0.2em;
  cursor: pointer;
}
:deep(.transcript-spoiler:focus-visible) {
  outline: 2px solid var(--border-strong);
  outline-offset: 2px;
}
</style>
