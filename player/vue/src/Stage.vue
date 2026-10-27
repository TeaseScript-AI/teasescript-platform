<script setup lang="ts">
import { ref, watch } from "vue";
import Viewfinder from "./Viewfinder.vue";
import ViewfinderControls from "./ViewfinderControls.vue";
const props = defineProps<{
  /**
   * The image: the URL it loads from, and its source as the Player knows it (`data-stage-source`) when that URL is a
   * prepared copy of it. The Stage reports its loads and failures by that source.
   */
  media: { src: string; alt: string; source?: string } | undefined;
  /**
   * The camera's track while the script shows the camera view over the Stage (`showCamera stage`), or while an image
   * request takes a photo there; the `camera` slot draws Player controls on that view.
   */
  camera?: MediaStreamTrack | null;
  /** An image request's preview, the image that would answer it, shown still instead of the image and camera view. */
  preview?: { src: string; alt: string } | null;
  /** The camera switch's name on the camera view, or `null` without another camera to switch to. */
  cameraSwitchLabel?: string | null;
}>();
const emit = defineEmits<{
  mediaAspect: [ratio: number];
  mediaLoad: [src: string | null];
  mediaFailure: [src: string | null];
  switchCamera: [];
  /** The camera view's picture stopped while the page is shown. */
  cameraStalled: [];
}>();
const cameraMirrored = defineModel<boolean>("cameraMirrored", { default: true });
// The camera view covers the Stage image without replacing it: the image stays loaded underneath, and the Stage follows
// the camera's aspect while the view is shown. The image's own aspect is kept for when the view goes. A preview stands
// in for both in the same way, at its own aspect.
let imageAspect = 0;
const cameraRatio = ref(4 / 3);
const imageElement = ref<HTMLImageElement | null>(null);
// The source the image on the Stage could not load or decode, or `null`. The Stage then stays empty, without the
// browser's broken-image look, until its source changes.
const failedSource = ref<string | null>(null);
watch(failedSource, (source) => emit("mediaFailure", source));
// The source the image on the Stage has loaded and decoded, or `null` while it loads, failed, or the Stage is empty.
const loadedSource = ref<string | null>(null);
watch(loadedSource, (source) => emit("mediaLoad", source));
// Only a new source needs measuring again; an equal source keeps its loaded image and aspect. A prepared photo is
// complete as soon as the image has its source, and keeps its aspect from its first frame.
watch(
  () => props.media?.src,
  () => {
    imageAspect = 0;
    failedSource.value = null;
    loadedSource.value = null;
    const image = imageElement.value;
    if (image?.complete && image.naturalHeight) loaded(image);
    else if (!props.camera && !props.preview) emit("mediaAspect", 0);
  },
  { flush: "post" },
);
watch(
  () => props.camera,
  (track) => {
    if (!track && !props.preview) emit("mediaAspect", imageAspect);
  },
);
watch(
  () => props.preview?.src,
  (src) => {
    if (src === undefined) emit("mediaAspect", props.camera ? cameraRatio.value : imageAspect);
  },
);
function previewLoaded(event: Event) {
  const image = event.currentTarget;
  if (image instanceof HTMLImageElement && image.naturalHeight)
    emit("mediaAspect", image.naturalWidth / image.naturalHeight);
}
function mediaLoaded(event: Event) {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement) || image !== imageElement.value) return;
  if (image.naturalHeight) loaded(image);
}
function loaded(image: HTMLImageElement) {
  if (!props.media) return;
  loadedSource.value = props.media.source ?? props.media.src;
  imageAspect = image.naturalWidth / image.naturalHeight;
  if (!props.camera && !props.preview) emit("mediaAspect", imageAspect);
}
// Only the image element on the Stage now counts, in its current state: a removed element, or one whose source was
// replaced, may still finish loading its earlier source. The same holds for a successful load.
function mediaFailed(event: Event) {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement) || image !== imageElement.value || !props.media) return;
  if (!image.complete || image.naturalWidth !== 0) return;
  failedSource.value = props.media.source ?? props.media.src;
}
function cameraMeasured(ratio: number) {
  cameraRatio.value = ratio;
  emit("mediaAspect", ratio);
}
</script>

<template>
  <section class="player-stage" aria-label="Primary stage">
    <div class="stage-media-frame">
      <img v-if="media" v-show="failedSource === null && !preview" ref="imageElement" :src="media.src" :alt="media.alt" :data-stage-source="media.source" class="stage-media" @load="mediaLoaded" @error="mediaFailed" />
      <img v-if="preview" :src="preview.src" :alt="preview.alt" class="stage-media" data-stage-preview @load="previewLoaded" />
      <div
        v-else-if="camera || $slots.camera"
        class="stage-camera"
        data-stage-camera
        :style="{ '--viewfinder-ratio': cameraRatio }"
      >
        <Viewfinder
          v-if="camera"
          :track="camera"
          :mirrored="cameraMirrored"
          @aspect="cameraMeasured"
          @stalled="emit('cameraStalled')"
        />
        <!-- Player controls drawn on the camera view, such as taking a photo for an image request. -->
        <slot name="camera" />
        <ViewfinderControls
          v-if="camera"
          v-model:mirrored="cameraMirrored"
          :switch-label="cameraSwitchLabel ?? null"
          @switch-camera="emit('switchCamera')"
        />
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
</style>
