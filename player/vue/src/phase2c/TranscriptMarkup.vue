<script setup lang="ts">
import { computed } from "vue";
import type { MessageMarkup } from "../../../../src/message-markup.js";
import { preparePlayerMessageMarkup } from "../../../message-markup.js";
import TranscriptLine from "./TranscriptLine.vue";

const props = defineProps<{
  content: MessageMarkup;
  /** The realized bubble colour an authored text colour has to survive against. */
  backdrop: string;
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
        <TranscriptLine :pieces="block.line.pieces" :backdrop="backdrop" />
      </div>
      <component
        :is="block.kind === 'quote' ? 'blockquote' : 'div'"
        v-else-if="block.kind === 'paragraph' || block.kind === 'quote'"
        :class="{ 'markup-paragraph': block.kind === 'paragraph' }"
      >
        <template v-for="(line, li) in block.lines" :key="li"
          ><TranscriptLine :pieces="line.pieces" :backdrop="backdrop" /><br v-if="line.ending"
        /></template>
      </component>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else>
        <li v-for="(item, li) in block.items" :key="li" :value="item.ordinal ?? undefined">
          <TranscriptLine :pieces="item.line.pieces" :backdrop="backdrop" />
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
/* The author chose the colour, the reader chose the theme, and they meet here. Where both
   land on the same side of the light/dark divide the words would disappear, so a scrim
   behind them restores the contrast and leaves the authored colour exactly as written.
   --message-ink is 1 on a light bubble and 0 on a dark one; the clash term is 1 only when
   the two sides agree, which fades the scrim out entirely everywhere else. */
:deep(.markup-scrim) {
  --scrim-clash: calc(1 - (var(--author-light) + var(--message-ink, 1)
    - 2 * var(--author-light) * var(--message-ink, 1)));
  background: oklch(calc(1 - var(--author-light)) 0 0 / calc(var(--scrim-clash) * var(--scrim-alpha)));
  border-radius: 0.2em;
  padding-inline: 0.12em;
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
