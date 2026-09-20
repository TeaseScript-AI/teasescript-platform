<script setup lang="ts">
import type { PlayerMarkupPiece } from "../../../message-markup.js";
defineProps<{ pieces: readonly PlayerMarkupPiece[] }>();
</script>

<template>
  <template v-for="(piece, pieceIndex) in pieces" :key="pieceIndex">
    <a v-if="piece.href !== null" :class="piece.classes" :style="piece.style"
      :href="piece.href" target="_blank" rel="noopener noreferrer">{{ piece.text }}</a>
    <span v-else :class="piece.classes" :style="piece.style">{{ piece.text }}</span>
  </template>
</template>
