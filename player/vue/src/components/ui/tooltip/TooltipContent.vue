<script setup lang="ts">
import { TooltipContent, TooltipPortal } from "reka-ui";

/*
  Repository-owned shadcn-vue tooltip surface. Reka owns positioning, collision
  handling, delay grouping and dismissal; the Player owns the paint. The portal
  target is the Player element rather than the document body so anchored chrome
  keeps working while the Player is in browser fullscreen.
*/
withDefaults(
  defineProps<{ to: HTMLElement | string; side?: "bottom" | "left" | "right" | "top" }>(),
  { side: "bottom" },
);
</script>

<template>
  <TooltipPortal :to="to">
    <TooltipContent class="player-tooltip" :side="side" :side-offset="8" :collision-padding="10">
      <slot />
    </TooltipContent>
  </TooltipPortal>
</template>
