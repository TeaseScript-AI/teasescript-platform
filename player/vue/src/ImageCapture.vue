<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { Camera, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import Viewfinder from "./Viewfinder.vue";
import ViewfinderMirrorButton from "./ViewfinderMirrorButton.vue";
import type { ImageCaptureView } from "./useImageCapture";

// Taking a photo for `askImage` on the Stage: the request's question over the live camera with a shutter, then the photo
// with "Use this" and "Retake". These are Player controls, not story messages: nothing here enters the transcript, and
// the request is answered only by "Use this". Closing returns to the composer, where the request still waits.
const props = defineProps<{ view: ImageCaptureView }>();
const mirrored = defineModel<boolean>("mirrored", { default: true });
const emit = defineEmits<{ shutter: []; retake: []; use: []; close: []; retry: [] }>();
const questionId = useId();
const liveRatio = ref(4 / 3);
const root = ref<HTMLElement | null>(null);

const status = computed(() =>
  props.view.phase === "opening"
    ? "Opening the camera…"
    : props.view.phase === "unavailable"
      ? "The camera cannot be used. Check that it is connected and that this page may use it, then try again."
      : "",
);

// Each step puts keyboard focus on its main control, so the flow can be completed from the keyboard.
watch(
  () => props.view.phase,
  async (phase) => {
    await nextTick();
    const target =
      phase === "live"
        ? "[data-image-capture-shutter]"
        : phase === "review"
          ? "[data-image-capture-use]"
          : phase === "unavailable"
            ? "[data-image-capture-retry]"
            : null;
    if (target) root.value?.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
  },
  { immediate: true },
);
</script>

<template>
  <div
    ref="root"
    class="image-capture"
    role="group"
    data-image-capture
    :data-phase="view.phase"
    :aria-labelledby="questionId"
    @keydown.esc="emit('close')"
  >
    <p :id="questionId" class="image-capture-question">{{ view.question }}</p>
    <div class="image-capture-picture">
      <div
        v-if="view.track"
        class="image-capture-live"
        :style="{ '--viewfinder-ratio': liveRatio }"
      >
        <Viewfinder :track="view.track" :mirrored="mirrored" @aspect="liveRatio = $event" />
        <div class="image-capture-mirror">
          <ViewfinderMirrorButton v-model="mirrored" />
        </div>
      </div>
      <img
        v-else-if="view.photo"
        :src="view.photo"
        alt="The photo you took"
        class="image-capture-photo"
        data-image-capture-photo
      />
      <p v-else class="image-capture-status" role="status">{{ status }}</p>
    </div>
    <div class="image-capture-controls">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close the camera"
        title="Close the camera"
        data-image-capture-close
        @click="emit('close')"
      >
        <X aria-hidden="true" />
      </Button>
      <PlayerActionButton
        v-if="view.phase === 'live' || view.phase === 'taking'"
        data-image-capture-shutter
        :inactive="view.phase === 'taking'"
        @click="view.phase === 'live' && emit('shutter')"
      >
        <Camera aria-hidden="true" class="size-4" />
        Take photo
      </PlayerActionButton>
      <template v-else-if="view.phase === 'review'">
        <PlayerActionButton data-image-capture-retake @click="emit('retake')">Retake</PlayerActionButton>
        <PlayerActionButton data-image-capture-use @click="emit('use')">Use this</PlayerActionButton>
      </template>
      <PlayerActionButton
        v-else-if="view.phase === 'unavailable'"
        data-image-capture-retry
        @click="emit('retry')"
      >
        Try again
      </PlayerActionButton>
    </div>
  </div>
</template>

<style scoped>
/* Over the whole Stage, the question above the picture and the controls below it. */
.image-capture {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 8px;
  padding: 8px;
  /* Clear of the title and global controls that overlay the top of the Stage. */
  padding-block-start: calc(var(--player-top-control-size) + 16px);
  background: var(--media-surface);
  color: var(--media-text);
  backdrop-filter: blur(6px);
}
.image-capture-question {
  margin: 0;
  justify-self: center;
  max-inline-size: 100%;
  padding: 4px 12px;
  text-align: center;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.image-capture-picture {
  position: relative;
  display: grid;
  place-items: center;
  min-block-size: 0;
  container: image-capture-picture / size;
}
/* The live picture and the photo keep their aspect, as large as the area allows. */
.image-capture-live {
  position: relative;
  width: min(100%, 100cqh * var(--viewfinder-ratio));
  max-height: 100%;
  aspect-ratio: var(--viewfinder-ratio);
}
.image-capture-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.image-capture-mirror {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  border: 1px solid var(--media-border);
  border-radius: 8px;
  background: var(--media-surface);
}
.image-capture-status {
  margin: 0;
  max-inline-size: 32rem;
  text-align: center;
}
.image-capture-controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 8px;
}
</style>
