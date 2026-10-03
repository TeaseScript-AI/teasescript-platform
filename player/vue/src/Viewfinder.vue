<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { Video } from "@lucide/vue";

// A live, local preview of the session camera. It never captures: the script takes photos through `takePhoto()`.
// Mirrored like a selfie view, so moving left moves the image left; photos themselves stay unmirrored. The default
// slot holds a small reference image, such as the Stage image the script shows meanwhile.
const props = defineProps<{ track: MediaStreamTrack }>();
const emit = defineEmits<{ aspect: [ratio: number] }>();
const video = ref<HTMLVideoElement | null>(null);
// The camera's aspect ratio once its first frame is known; webcams commonly deliver 4:3.
const ratio = ref(4 / 3);
function measured() {
  const element = video.value;
  if (!element?.videoWidth || !element.videoHeight) return;
  ratio.value = element.videoWidth / element.videoHeight;
  emit("aspect", ratio.value);
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
  <figure class="viewfinder" data-viewfinder :style="{ '--viewfinder-ratio': ratio }">
    <video
      ref="video"
      class="viewfinder-video"
      muted
      autoplay
      playsinline
      aria-hidden="true"
      @loadedmetadata="measured"
      @resize="measured"
    />
    <slot />
    <figcaption class="viewfinder-label">
      <Video aria-hidden="true" class="size-3.5" />Camera preview
    </figcaption>
  </figure>
</template>

<style scoped>
.viewfinder {
  position: relative;
  margin: 0;
  aspect-ratio: var(--viewfinder-ratio);
  overflow: hidden;
  border: 1px solid var(--media-border);
  border-radius: 12px;
  background: var(--media-surface);
  box-shadow: 0 2px 10px var(--media-shadow);
}
.viewfinder-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  transform: scaleX(-1);
}
.viewfinder-label {
  position: absolute;
  top: 10px;
  left: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 8px;
  border: 1px solid var(--media-border);
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  color: var(--media-text);
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
}
</style>
