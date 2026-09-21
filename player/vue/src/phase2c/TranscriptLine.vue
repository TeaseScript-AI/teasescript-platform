<script setup lang="ts">
import { h } from "vue";
import type { PlayerMarkupPiece } from "../../../message-markup.js";
import { scrimFor } from "./messageContrast";

const props = defineProps<{
  pieces: readonly PlayerMarkupPiece[];
  /** The realized surface already under these words. */
  backdrop: string;
  /** Cover the whole message needs, for pieces the author left uncoloured. */
  cover: string | null;
  /** The colour a link is really painted in here, which is not always the message's. */
  link: string;
}>();
// A pair the author wrote together stands as written; a pair he never saw is covered
// until it can be read. See docs/ui/PLAYER-UI.md for the rule this follows.
function authoredScrim(piece: { style: Readonly<Record<string, string>>; href: string | null }) {
  if (piece.style["backgroundColor"] !== undefined) return null;
  // A link the author did not colour himself is not painted in the message's colour at
  // all: the page gives it its own. Handing it the message's cover would protect a colour
  // that is nowhere on the screen, and leave the one that is there sitting on it.
  const colour = piece.style["color"] ?? (piece.href === null ? undefined : props.link);
  // An uncoloured piece takes the message's colour, so it takes the cover that colour
  // needed; re-measuring per piece would only arrive at the same answer.
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
