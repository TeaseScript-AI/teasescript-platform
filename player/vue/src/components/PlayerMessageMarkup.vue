<script setup lang="ts">
import { computed } from "vue";
import type { MessageMarkup } from "../../../../src/message-markup.js";
import { preparePlayerMessageMarkup } from "../../../message-markup.js";
import PlayerMarkupLine from "./PlayerMarkupLine.vue";

const props = defineProps<{ content: MessageMarkup }>();
const blocks = computed(() => preparePlayerMessageMarkup(props.content));
</script>

<template>
  <div class="message-markup">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <p v-if="block.kind === 'paragraph'" class="markup-paragraph">
        <template v-for="(line, lineIndex) in block.lines" :key="lineIndex">
          <PlayerMarkupLine :groups="line.groups" /><br v-if="line.ending !== ''" />
        </template>
      </p>
      <div
        v-else-if="block.kind === 'heading'"
        class="markup-heading"
        :class="`markup-heading-${block.level}`"
        role="heading"
        :aria-level="block.level"
      >
        <PlayerMarkupLine :groups="block.line.groups" />
      </div>
      <blockquote v-else-if="block.kind === 'quote'" class="markup-quote">
        <template v-for="(line, lineIndex) in block.lines" :key="lineIndex">
          <PlayerMarkupLine :groups="line.groups" /><br v-if="line.ending !== ''" />
        </template>
      </blockquote>
      <ol v-else-if="block.ordered" class="markup-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex" :value="item.ordinal ?? undefined">
          <PlayerMarkupLine :groups="item.line.groups" />
        </li>
      </ol>
      <ul v-else class="markup-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <PlayerMarkupLine :groups="item.line.groups" />
        </li>
      </ul>
    </template>
  </div>
</template>
