<script setup lang="ts">
import { h, inject } from "vue";
import type { PlayerMarkupPiece } from "../../../message-markup.js";
import { readabilityFor } from "./messageContrast";
import { enhancedTranscriptContrast } from "./transcriptContrast";

const props = defineProps<{
  pieces: readonly PlayerMarkupPiece[];
  backdrop: string;
  cover: string | null;
  link: string;
  authoredInk: string | null;
}>();
const enhancedContrast = inject(enhancedTranscriptContrast, undefined);
function authoredTreatment(piece: {
  style: Readonly<Record<string, string>>;
  href: string | null;
}) {
  if (piece.style["backgroundColor"] !== undefined) {
    if (piece.style["color"] === undefined && piece.href === null && props.authoredInk !== null)
      return { ink: props.authoredInk, cover: null };
    return null;
  }
  const colour = piece.style["color"] ?? (piece.href === null ? undefined : props.link);
  if (colour === undefined) return props.cover === null ? null : { ink: null, cover: props.cover };
  const treatment = readabilityFor(colour, props.backdrop, enhancedContrast?.value);
  return treatment.ink === colour && treatment.cover === null ? null : treatment;
}
// The canonical preparation helper supplies validated text/style/link pieces, never HTML.
function renderLine() {
  return props.pieces.map((piece) => {
    const treatment = authoredTreatment(piece);
    return h(
      piece.href === null ? "span" : "a",
      {
        class: treatment?.cover == null ? piece.classes : [...piece.classes, "markup-scrim"],
        style:
          treatment === null
            ? piece.style
            : {
                ...piece.style,
                ...(treatment.ink === null ? {} : { color: treatment.ink }),
                ...(treatment.cover === null ? {} : { backgroundColor: treatment.cover }),
              },
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
