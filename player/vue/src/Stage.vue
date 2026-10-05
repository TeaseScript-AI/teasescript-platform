<script setup lang="ts">
import { ref, watch } from "vue";
import Viewfinder from "./Viewfinder.vue";
import ViewfinderMirrorButton from "./ViewfinderMirrorButton.vue";
const props = defineProps<{
  media: { src: string; alt: string } | undefined;
  /**
   * The camera's track while the script shows the camera view over the Stage (`showCamera stage`), or while an image
   * request takes a photo there; the `camera` slot draws Player controls on that view.
   */
  camera?: MediaStreamTrack | null;
}>();
const emit = defineEmits<{ mediaAspect: [ratio: number]; mediaError: [src: string] }>();
const cameraMirrored = defineModel<boolean>("cameraMirrored", { default: true });
// The camera view covers the Stage image without replacing it: the image stays loaded underneath, and the Stage follows
// the camera's aspect while the view is shown. The image's own aspect is kept for when the view goes.
let imageAspect = 0;
const cameraRatio = ref(4 / 3);
// An image the browser cannot load or decode leaves the Stage empty, without the browser's broken-image look.
const failed = ref(false);
// Only a new source needs measuring again; an equal source keeps its loaded image and aspect.
watch(
  () => props.media?.src,
  () => {
    imageAspect = 0;
    failed.value = false;
    if (!props.camera) emit("mediaAspect", 0);
  },
);
watch(
  () => props.camera,
  (track) => {
    if (!track) emit("mediaAspect", imageAspect);
  },
);
function mediaLoaded(event: Event) {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement) || !image.naturalHeight) return;
  imageAspect = image.naturalWidth / image.naturalHeight;
  if (!props.camera) emit("mediaAspect", imageAspect);
}
// The image failed to load or decode. The element's current state decides, so a late error of a replaced source is not
// reported: the element then loads, or has loaded, its new source.
function mediaFailed(event: Event) {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement) || !props.media) return;
  if (!image.complete || image.naturalWidth !== 0) return;
  failed.value = true;
  emit("mediaError", props.media.src);
}
function cameraMeasured(ratio: number) {
  cameraRatio.value = ratio;
  emit("mediaAspect", ratio);
}
</script>

<template>
  <section class="player-stage" aria-label="Primary stage">
    <div class="stage-media-frame">
      <img v-if="media" v-show="!failed" :src="media.src" :alt="media.alt" class="stage-media" @load="mediaLoaded" @error="mediaFailed" />
      <div
        v-if="camera || $slots.camera"
        class="stage-camera"
        data-stage-camera
        :style="{ '--viewfinder-ratio': cameraRatio }"
      >
        <Viewfinder v-if="camera" :track="camera" :mirrored="cameraMirrored" @aspect="cameraMeasured" />
        <!-- Player controls drawn on the camera view, such as taking a photo for an image request. -->
        <slot name="camera" />
        <div v-if="camera" class="stage-camera-mirror">
          <ViewfinderMirrorButton v-model="cameraMirrored" />
        </div>
      </div>
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
/* Over the image, at the camera's aspect, as large as the Stage allows. */
.stage-camera {
  position: absolute; inset: 0; margin: auto;
  width: min(100%, 100cqh * var(--viewfinder-ratio)); max-height: 100%;
  /* Its own height, so the margins centre it like the image underneath. */
  aspect-ratio: var(--viewfinder-ratio);
}
.stage-camera-mirror {
  position: absolute; top: 8px; right: 8px; display: flex;
  border: 1px solid var(--media-border); border-radius: 8px; color: var(--media-text);
  background: var(--media-surface); box-shadow: 0 1px 3px var(--media-shadow); backdrop-filter: blur(3px);
}
</style>
