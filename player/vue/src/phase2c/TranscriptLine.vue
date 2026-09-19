<script setup lang="ts">
import { h } from "vue";
import type { PlayerMarkupGroup } from "../../../message-markup.js";

const props = defineProps<{
  groups: readonly PlayerMarkupGroup[];
  lineKey: string;
  revealed: ReadonlySet<string>;
}>();
const emit = defineEmits<{ reveal: [key: string] }>();
// The canonical preparation helper supplies validated text/style/link pieces, never HTML.
function renderLine() {
  return props.groups.map((group, index) => {
    const key = `${props.lineKey}:${index}`;
    if (group.spoilerId !== null && !props.revealed.has(key)) {
      return h(
        "button",
        {
          type: "button",
          class: "transcript-spoiler",
          "aria-label": "Reveal spoiler",
          onClick: () => emit("reveal", key),
        },
        h("span", { "aria-hidden": "true" }, group.pieces.map((piece) => piece.text).join("")),
      );
    }
    return group.pieces.map((piece) =>
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
  });
}
</script>

<template><component :is="renderLine" /></template>
