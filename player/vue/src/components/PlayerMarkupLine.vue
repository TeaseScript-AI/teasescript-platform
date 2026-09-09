<script setup lang="ts">
import { ref } from "vue";
import type { PlayerMarkupGroup } from "../../../message-markup.js";

defineProps<{ groups: readonly PlayerMarkupGroup[] }>();

const revealedSpoilers = ref(new Set<string>());

function reveal(spoilerId: string): void {
  revealedSpoilers.value = new Set([...revealedSpoilers.value, spoilerId]);
}
</script>

<template>
  <template v-for="(group, groupIndex) in groups" :key="`${group.spoilerId ?? 'text'}-${groupIndex}`">
    <button
      v-if="group.spoilerId !== null && !revealedSpoilers.has(group.spoilerId)"
      class="markup-spoiler"
      type="button"
      aria-label="Reveal spoiler"
      @click="reveal(group.spoilerId)"
    >
      <span aria-hidden="true">{{ group.pieces.map((piece) => piece.text).join("") }}</span>
    </button>
    <span v-else-if="group.spoilerId !== null" class="markup-spoiler-revealed">
      <template v-for="(piece, pieceIndex) in group.pieces" :key="pieceIndex">
        <a
          v-if="piece.href !== null"
          :class="piece.classes"
          :style="piece.style"
          :href="piece.href"
          target="_blank"
          rel="noopener noreferrer"
          >{{ piece.text }}</a
        >
        <span v-else :class="piece.classes" :style="piece.style">{{ piece.text }}</span>
      </template>
    </span>
    <template v-else>
      <template v-for="(piece, pieceIndex) in group.pieces" :key="pieceIndex">
        <a
          v-if="piece.href !== null"
          :class="piece.classes"
          :style="piece.style"
          :href="piece.href"
          target="_blank"
          rel="noopener noreferrer"
          >{{ piece.text }}</a
        >
        <span v-else :class="piece.classes" :style="piece.style">{{ piece.text }}</span>
      </template>
    </template>
  </template>
</template>
