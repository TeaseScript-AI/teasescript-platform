<script setup lang="ts">
import { watch } from "vue";
const props = defineProps<{
  media: { src: string; alt: string } | undefined;
}>();
const emit = defineEmits<{ mediaAspect: [ratio: number] }>();
watch(() => props.media, () => emit("mediaAspect", 0));
function mediaLoaded(event: Event) {
  const image = event.currentTarget;
  if (image instanceof HTMLImageElement && image.naturalHeight)
    emit("mediaAspect", image.naturalWidth / image.naturalHeight);
}
</script>

<template>
  <section class="player-stage" aria-label="Primary stage">
    <div class="stage-media-frame">
      <img v-if="media" :src="media.src" :alt="media.alt" class="stage-media" @load="mediaLoaded" />
    </div>
    <slot name="right-rail" />
  </section>
</template>

<style scoped>
.player-stage {
  flex: 1;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container: player-stage / size;
}
.stage-media-frame {
  position: absolute; top: 0; bottom: 0;
  left: var(--content-offset); width: var(--content-width);
}
.stage-media { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
