<script setup lang="ts">
import { h } from "vue";
import type { PlayerMarkupPiece } from "../../../message-markup.js";

const props = defineProps<{
  pieces: readonly PlayerMarkupPiece[];
}>();
// The canonical preparation helper supplies validated text/style/link pieces, never HTML.
function renderLine() {
  return props.pieces.map((piece) =>
    h(
      piece.href === null ? "span" : "a",
      {
        class: piece.classes,
        style: piece.style,
        ...(piece.href === null
          ? {}
          : { href: piece.href, target: "_blank", rel: "noopener noreferrer" }),
      },
      piece.text,
    ),
  );
}
</script>

<template><component :is="renderLine" /></template>
