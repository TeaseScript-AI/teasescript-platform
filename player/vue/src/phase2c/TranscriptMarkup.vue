<script setup lang="ts">
import { computed } from "vue";
import type { MessageMarkup } from "../../../../src/message-markup.js";
import { preparePlayerMessageMarkup } from "../../../message-markup.js";
import TranscriptLine from "./TranscriptLine.vue";

const props = defineProps<{
  content: MessageMarkup;
  /** The realized bubble colour an authored text colour has to survive against. */
  backdrop: string;
  /** Cover the whole message needs, for pieces the author left uncoloured. */
  cover: string | null;
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
        <TranscriptLine :pieces="block.line.pieces" :backdrop="backdrop" :cover="cover" />
      </div>
      <component
        :is="block.kind === 'quote' ? 'blockquote' : 'div'"
        v-else-if="block.kind === 'paragraph' || block.kind === 'quote'"
        :class="{ 'markup-paragraph': block.kind === 'paragraph' }"
      >
        <template v-for="(line, li) in block.lines" :key="li"
          ><TranscriptLine :pieces="line.pieces" :backdrop="backdrop" :cover="cover" /><br v-if="line.ending"
        /></template>
      </component>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else>
        <li v-for="(item, li) in block.items" :key="li" :value="item.ordinal ?? undefined">
          <TranscriptLine :pieces="item.line.pieces" :backdrop="backdrop" :cover="cover" />
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
/* The author chose the colour, the reader chose the theme, and they meet here. Where the
   pair would leave the words unreadable a cover is painted behind them, measured per
   message and supplied as a background layer; only its shape belongs here.
   Words that reach the end of a line carry on underneath the next one, and by default the
   cover is cut straight through at the turn: a square edge and no inset where the reader
   can plainly see the sentence continues. Cloned, every piece of it is shaped like the
   whole, so the cover reads as one thing wrapped rather than two things abutting. */
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
</style>
