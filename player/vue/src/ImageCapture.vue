<script setup lang="ts">
import { Camera, CameraOff } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ImageCaptureView } from "./useImageCapture";

// The camera step of `askImage`, drawn on the viewfinder it fills: why there is no picture yet, or none, and the
// self-timer's countdown. The picture carries no question and no controls; they sit under the question in the chat.
defineProps<{ view: ImageCaptureView }>();
</script>

<template>
  <div class="image-capture" data-image-capture :data-phase="view.phase">
    <div v-if="!view.track" class="image-capture-cover" />
    <!--
      The self-timer's countdown, as large as the viewfinder allows; each number replaces the last. The status region
      stays while the step does, so a screen reader announces each number.
    -->
    <div class="image-capture-countdown" role="status">
      <span v-if="view.countdown !== null" :key="view.countdown" data-image-capture-countdown>{{
        view.countdown
      }}</span>
    </div>
    <!-- Why there is no picture, centred, and scrolling in a small viewfinder. -->
    <div class="image-capture-message">
      <div v-if="view.phase === 'opening'" class="image-capture-status">
        <Alert role="status">
          <Camera aria-hidden="true" />
          <AlertDescription>Opening the camera…</AlertDescription>
        </Alert>
      </div>
      <div v-else-if="view.phase === 'unavailable'" class="image-capture-status">
        <Alert>
          <CameraOff aria-hidden="true" />
          <AlertDescription>
            The camera cannot be used. Check that it is connected and that this page may use it, then try again.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Over the whole viewfinder. */
.image-capture {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
  overflow: hidden;
  color: var(--media-text);
  container: image-capture / size;
}
/* Where the camera shows no picture yet, or cannot. */
.image-capture-cover {
  position: absolute;
  inset: 0;
  background: var(--media-surface);
  backdrop-filter: blur(6px);
}
/* The message is centred and scrolls when the viewfinder is small. */
.image-capture-message {
  position: relative;
  flex: 1 1 auto;
  min-block-size: 0;
  inline-size: 100%;
  display: grid;
  place-items: center;
  overflow-y: auto;
}
/* Its words may break, so the alert fits a camera window at its smallest. */
.image-capture-status {
  position: relative;
  inline-size: min(100%, 28rem);
  overflow-wrap: anywhere;
}
/* Above the message, so a small viewfinder still shows the whole number. */
.image-capture-countdown {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  font-size: min(85cqh, 70cqw);
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--media-text);
  text-shadow:
    0 0 0.08em var(--media-surface),
    0 0.02em 0.06em var(--media-shadow);
  pointer-events: none;
}
.image-capture-countdown > span {
  animation: image-capture-count 1s ease-out both;
}
@keyframes image-capture-count {
  from {
    opacity: 0;
    transform: scale(1.4);
  }
  20% {
    opacity: 0.9;
    transform: scale(1);
  }
  to {
    opacity: 0.35;
    transform: scale(0.8);
  }
}
@media (prefers-reduced-motion: reduce) {
  .image-capture-countdown > span {
    animation: none;
    opacity: 0.8;
  }
}
</style>
