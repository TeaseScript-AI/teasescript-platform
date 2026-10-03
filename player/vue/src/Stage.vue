<script setup lang="ts">
import { watch } from "vue";
import Viewfinder from "./Viewfinder.vue";
const props = defineProps<{
  media: { src: string; alt: string } | undefined;
  /** The session camera's track while the viewfinder is shown; it leads, and the Stage image becomes its reference. */
  viewfinder?: MediaStreamTrack | null;
}>();
const emit = defineEmits<{ mediaAspect: [ratio: number] }>();
// Only a new source needs measuring again; an equal source keeps its loaded image and aspect. A leading viewfinder
// keeps the camera's aspect while its reference image changes.
watch(
  () => props.media?.src,
  () => props.viewfinder || emit("mediaAspect", 0),
);
// A hidden viewfinder leaves no camera aspect behind; a returning image measures its own again.
watch(
  () => props.viewfinder,
  (track) => track || emit("mediaAspect", 0),
);
function mediaLoaded(event: Event) {
  const image = event.currentTarget;
  if (image instanceof HTMLImageElement && image.naturalHeight)
    emit("mediaAspect", image.naturalWidth / image.naturalHeight);
}
</script>

<template>
  <section class="player-stage" aria-label="Primary stage">
    <div class="stage-media-frame">
      <!-- While shown, the Stage follows the camera's aspect; the image's own is measured again when it returns. -->
      <Viewfinder
        v-if="viewfinder"
        :track="viewfinder"
        class="stage-viewfinder"
        @aspect="emit('mediaAspect', $event)"
      >
        <img v-if="media" :src="media.src" :alt="media.alt" class="stage-viewfinder-reference" />
      </Viewfinder>
      <img v-else-if="media" :src="media.src" :alt="media.alt" class="stage-media" @load="mediaLoaded" />
    </div>
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
.stage-viewfinder {
  position: absolute; inset: 0; margin: auto;
  width: min(100%, 100cqh * var(--viewfinder-ratio)); max-height: 100%;
}
.stage-viewfinder-reference {
  position: absolute; left: 10px; bottom: 10px;
  width: clamp(72px, 24%, 220px); max-height: 40%; object-fit: contain;
  border: 1px solid var(--media-border); border-radius: 8px;
  box-shadow: 0 1px 3px var(--media-shadow);
}
</style>
