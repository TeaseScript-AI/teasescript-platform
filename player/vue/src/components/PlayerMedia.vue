<script setup lang="ts">
import type { PlayerMediaPresentation } from "../../../model.js";

defineProps<{ media: PlayerMediaPresentation }>();
</script>

<template>
  <section class="media-area">
    <div class="media-surface" aria-label="Demo media">
      <img
        v-if="media.src.length > 0"
        class="media-content"
        :alt="media.title"
        :src="media.src"
      />
    </div>
  </section>
</template>
