<script setup lang="ts">
import { onBeforeUnmount, shallowRef, watch } from "vue";
import type { PlayerMediaPresentation, PlayerMediaTransitionFixture } from "../../../model.js";

const props = defineProps<{
  media: PlayerMediaPresentation;
  transition: PlayerMediaTransitionFixture;
}>();

const current = shallowRef(props.media);
const outgoing = shallowRef<PlayerMediaPresentation | null>(null);
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.media,
  (media) => {
    if (cleanupTimer !== null) clearTimeout(cleanupTimer);
    outgoing.value = props.transition === "crossfade" ? current.value : null;
    current.value = media;
    cleanupTimer = setTimeout(() => {
      outgoing.value = null;
      cleanupTimer = null;
    }, 360);
  },
);

onBeforeUnmount(() => {
  if (cleanupTimer !== null) clearTimeout(cleanupTimer);
});
</script>

<template>
  <section class="media-area" :data-media-transition="transition">
    <div class="media-surface" aria-label="Demo media">
      <img
        v-if="outgoing !== null && outgoing.src.length > 0"
        :key="`outgoing-${outgoing.id}`"
        class="media-content media-transition-outgoing"
        alt=""
        aria-hidden="true"
        :src="outgoing.src"
      />
      <img
        v-if="current.src.length > 0"
        :key="current.id"
        class="media-content media-transition-incoming"
        :alt="current.title"
        :src="current.src"
      />
    </div>
  </section>
</template>
