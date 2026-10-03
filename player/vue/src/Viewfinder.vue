<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { PictureInPicture2, Video } from "@lucide/vue";

// A live, local preview of the session camera. It never captures: the script takes photos through `takePhoto()`.
// Mirrored like a selfie view, so moving left moves the image left; photos themselves stay unmirrored. The default
// slot holds content over the preview, such as a small reference image or window controls.
const props = withDefaults(defineProps<{ track: MediaStreamTrack; label?: boolean }>(), {
  label: true,
});
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

// DEMO: the browser's own picture-in-picture window, which also floats over other apps. Browsers open it only from a
// user's click. Document picture-in-picture (Chromium, current Firefox) keeps the mirrored view, and the browser's own
// pop-out toggle on the video then stays off; video picture-in-picture (Safari) shows the camera unmirrored. Without
// either there is no button.
interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}
const documentPip = (window as { documentPictureInPicture?: DocumentPictureInPicture })
  .documentPictureInPicture;
const pictureInPicture = documentPip !== undefined || document.pictureInPictureEnabled === true;
let pipWindow: Window | null = null;
let unmounted = false;
async function openPictureInPicture() {
  if (!documentPip) {
    const element = video.value;
    await element?.requestPictureInPicture().catch(() => {});
    // Hidden while the browser opened the window: the camera must not stay on view.
    if (unmounted && element && document.pictureInPictureElement === element)
      await document.exitPictureInPicture();
    return;
  }
  pipWindow?.close();
  const opened = await documentPip.requestWindow({
    width: 360,
    height: Math.round(360 / ratio.value),
  });
  // Hidden while the browser opened the window: the camera must not stay on view.
  if (unmounted) return opened.close();
  pipWindow = opened;
  const copy = opened.document.createElement("video");
  copy.muted = true;
  copy.playsInline = true;
  copy.srcObject = new MediaStream([props.track]);
  copy.style.cssText =
    "display:block;width:100%;height:100%;object-fit:contain;transform:scaleX(-1)";
  opened.document.body.style.cssText = "margin:0;background:canvas";
  opened.document.body.append(copy);
  copy.play().catch(() => {});
  opened.addEventListener("pagehide", () => {
    copy.srcObject = null;
    if (pipWindow === opened) pipWindow = null;
  });
}

onBeforeUnmount(() => {
  // Hiding the viewfinder also closes its picture-in-picture window. Detaching never stops the track: the session
  // camera stays open for `takePhoto()`.
  unmounted = true;
  pipWindow?.close();
  if (video.value && document.pictureInPictureElement === video.value)
    void document.exitPictureInPicture();
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
      :disablePictureInPicture.prop="documentPip !== undefined"
      @loadedmetadata="measured"
      @resize="measured"
      @timeupdate="measured"
    />
    <slot />
    <!-- Without its visible label the preview keeps its name. -->
    <figcaption :class="label ? 'viewfinder-label' : 'sr-only'">
      <Video v-if="label" aria-hidden="true" class="size-3.5" />Camera preview
    </figcaption>
    <button
      v-if="pictureInPicture"
      type="button"
      class="viewfinder-pip"
      aria-label="Open camera preview in picture-in-picture"
      title="Picture-in-picture"
      data-viewfinder-pip
      @pointerdown.stop
      @click="openPictureInPicture"
    >
      <PictureInPicture2 aria-hidden="true" class="size-4" />
    </button>
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
.viewfinder-label,
.viewfinder-pip {
  position: absolute;
  top: 10px;
  border: 1px solid var(--media-border);
  border-radius: 9999px;
  color: var(--media-text);
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
}
.viewfinder-label {
  left: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 8px;
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
}
.viewfinder-pip {
  right: 10px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 26px;
}
</style>
