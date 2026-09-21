<script setup lang="ts">
import { h } from "vue";
import type { PlayerMarkupPiece } from "../../../message-markup.js";
import { scrimFor } from "./messageContrast";

const props = defineProps<{
  pieces: readonly PlayerMarkupPiece[];
  backdrop: string;
  cover: string | null;
  link: string;
}>();
function authoredScrim(piece: { style: Readonly<Record<string, string>>; href: string | null }) {
  if (piece.style["backgroundColor"] !== undefined) return null;
  const colour = piece.style["color"] ?? (piece.href === null ? undefined : props.link);
  if (colour === undefined) return props.cover;
  return scrimFor(colour, props.backdrop);
}
// The canonical preparation helper supplies validated text/style/link pieces, never HTML.
function renderLine() {
  return props.pieces.map((piece) => {
    const scrim = authoredScrim(piece);
    return h(
      piece.href === null ? "span" : "a",
      {
        class: scrim === null ? piece.classes : [...piece.classes, "markup-scrim"],
        style: scrim === null ? piece.style : { ...piece.style, backgroundColor: scrim },
        ...(piece.href === null
          ? {}
          : { href: piece.href, target: "_blank", rel: "noopener noreferrer" }),
      },
      piece.text,
    );
  });
}
</script>

<template><component :is="renderLine" /></template>
