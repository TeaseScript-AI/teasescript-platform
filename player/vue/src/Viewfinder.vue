<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

// A live, local preview of the session camera. It never captures: the script takes photos through `takePhoto()`.
// Mirrored like a selfie view by default, so moving left moves the image left; photos themselves stay unmirrored. The
// default slot holds content over the preview, such as a small reference image or controls. Unframed, it fills a frame
// its parent draws, such as a window.
const props = withDefaults(
  defineProps<{ track: MediaStreamTrack; mirrored?: boolean; framed?: boolean }>(),
  { mirrored: true, framed: true },
);
const emit = defineEmits<{ aspect: [ratio: number] }>();
const video = ref<HTMLVideoElement | null>(null);
// The camera's aspect ratio once a frame has a size; webcams commonly deliver 4:3. A browser may play frames before
// they have a size, as Firefox does with some cameras, so playing frames are measured too; only a change is reported.
const ratio = ref(4 / 3);
let reported: number | null = null;
function measured() {
  const element = video.value;
  if (!element?.videoWidth || !element.videoHeight) return;
  const measuredRatio = element.videoWidth / element.videoHeight;
  if (measuredRatio === reported) return;
  reported = ratio.value = measuredRatio;
  emit("aspect", measuredRatio);
}

watch(
  [video, () => props.track],
  ([element, track]) => {
    if (!element) return;
    element.srcObject = new MediaStream([track]);
    // Muted inline video may play without a user activation; a refusal leaves the element showing its first frame.
    element.play().catch(() => {});
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  // Detaching never stops the track: the session camera stays open for `takePhoto()`.
  if (video.value) video.value.srcObject = null;
});
</script>

<template>
  <figure
    class="viewfinder"
    :class="{ 'viewfinder-framed': framed }"
    data-viewfinder
    :style="{ '--viewfinder-ratio': ratio }"
  >
    <!-- The browser's own picture-in-picture toggle stays off: the Player's viewfinder is the only one. -->
    <video
      ref="video"
      class="viewfinder-video"
      :class="{ 'viewfinder-mirrored': mirrored }"
      muted
      autoplay
      playsinline
      disablepictureinpicture
      aria-hidden="true"
      @loadedmetadata="measured"
      @resize="measured"
      @timeupdate="measured"
    />
    <slot />
    <!-- The live picture speaks for itself; the name is for assistive technology only. -->
    <figcaption class="sr-only">Camera preview</figcaption>
  </figure>
</template>

<style scoped>
.viewfinder {
  position: relative;
  margin: 0;
  aspect-ratio: var(--viewfinder-ratio);
  overflow: hidden;
  background: var(--media-surface);
}
.viewfinder-framed {
  --viewfinder-radius: 12px;
  border: 1px solid var(--media-border);
  border-radius: var(--viewfinder-radius);
  box-shadow: 0 2px 10px var(--media-shadow);
  /* Firefox does not clip a transformed video to its container's rounded corners; inside the 1px border. */
  --viewfinder-video-radius: calc(var(--viewfinder-radius) - 1px);
}
.viewfinder-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* An unframed preview takes the corners of its parent's frame. */
  border-radius: var(--viewfinder-video-radius, 0);
}
.viewfinder-mirrored { transform: scaleX(-1); }
</style>
