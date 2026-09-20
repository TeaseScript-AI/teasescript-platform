<script setup lang="ts">
import { h } from "vue";
import type { PlayerMarkupPiece } from "../../../message-markup.js";
import { scrimFor } from "./messageContrast";

const props = defineProps<{
  pieces: readonly PlayerMarkupPiece[];
  /** Every layer already under these words, outermost first. */
  backdrop: readonly string[];
}>();
// An authored colour lands on a surface the author never saw, and an author who sets both
// the words and what is behind them can still put one on top of the other. Rather than
// alter either colour, the pair is measured as painted and covered by however much this
// pairing needs; a reader who cannot read the line is not served by anyone's intent.
function authoredScrim(piece: { style: Readonly<Record<string, string>> }) {
  const colour = piece.style["color"];
  if (colour === undefined) return null;
  const background = piece.style["backgroundColor"];
  return scrimFor(colour, background === undefined
    ? props.backdrop : [...props.backdrop, background]);
}
// The canonical preparation helper supplies validated text/style/link pieces, never HTML.
function renderLine() {
  return props.pieces.map((piece) => {
    const scrim = authoredScrim(piece);
    return h(
      piece.href === null ? "span" : "a",
      {
        class: scrim === null ? piece.classes : [...piece.classes, "markup-scrim"],
        // The cover is its own layer above an authored background, so that background
        // survives as written and the two never compete for one declaration.
        style: scrim === null ? piece.style
          : { ...piece.style, backgroundImage: `linear-gradient(${scrim}, ${scrim})` },
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
