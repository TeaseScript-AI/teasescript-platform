<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { Camera } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import type { ImageCaptureView } from "./useImageCapture";

// Taking a photo for `askImage`, drawn on the viewfinder it fills: the request's question over the live camera with the
// shutter on the picture, then the photo taken with "Use this" and "Retake". These are Player controls, not story
// messages: nothing here enters the transcript, and the request is answered only by "Use this". The view opens by
// itself with the request, so it takes keyboard focus only once the player works in it.
const props = defineProps<{ view: ImageCaptureView }>();
const emit = defineEmits<{ shutter: []; retake: []; use: []; retry: [] }>();
const questionId = useId();
const root = ref<HTMLElement | null>(null);
const focusInside = ref(false);

const status = computed(() =>
  props.view.phase === "opening"
    ? "Opening the camera…"
    : props.view.phase === "unavailable"
      ? "The camera cannot be used. Check that it is connected and that this page may use it, then try again."
      : "",
);

// After the player's step, focus moves to the next step's main control, so the flow can be completed from the keyboard.
watch(
  () => props.view.phase,
  async (phase) => {
    if (!focusInside.value) return;
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
);
function focusOut(event: FocusEvent) {
  // A control that disappears with its step keeps the focus "inside" until the next step's control takes it.
  if (event.relatedTarget instanceof Node && !root.value?.contains(event.relatedTarget))
    focusInside.value = false;
}
</script>

<template>
  <div
    ref="root"
    class="image-capture"
    role="group"
    data-image-capture
    :data-phase="view.phase"
    :aria-labelledby="questionId"
    @focusin="focusInside = true"
    @focusout="focusOut"
  >
    <img
      v-if="view.photo"
      :src="view.photo"
      alt="The photo you took"
      class="image-capture-photo"
      data-image-capture-photo
    />
    <div v-else-if="!view.track" class="image-capture-cover" />
    <p :id="questionId" class="image-capture-question">{{ view.question }}</p>
    <p v-if="status" class="image-capture-status" role="status">{{ status }}</p>
    <!-- In a floating window, pressing a control does not start moving the window. -->
    <div class="image-capture-controls" @pointerdown.stop>
      <div v-if="view.phase === 'live' || view.phase === 'taking'" class="image-capture-shutter">
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Take photo"
          title="Take photo"
          data-image-capture-shutter
          :disabled="view.phase === 'taking'"
          @click="emit('shutter')"
        >
          <Camera aria-hidden="true" />
        </Button>
      </div>
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
/*
 * Over the whole viewfinder: the question and the controls at the bottom of the picture, so its top stays clear for the
 * Player's title and controls over the Stage.
 */
.image-capture {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 8px;
  color: var(--media-text);
  container: image-capture / size;
}
.image-capture-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--media-surface);
}
/* Where the camera shows no picture yet, or cannot. */
.image-capture-cover {
  position: absolute;
  inset: 0;
  background: var(--media-surface);
  backdrop-filter: blur(6px);
}
.image-capture-question,
.image-capture-status {
  position: relative;
  margin: 0;
  max-inline-size: 100%;
  padding: 4px 12px;
  border: 1px solid var(--media-border);
  border-radius: 8px;
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
  text-align: center;
  overflow-wrap: anywhere;
}
.image-capture-question {
  font-weight: 700;
}
/* Why there is no picture, in the middle of the frame. */
.image-capture-status {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  inline-size: max-content;
  max-inline-size: min(calc(100% - 16px), 28rem);
  font-size: 0.875rem;
}
.image-capture-controls {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 8px;
}
/* The shutter: a round control on the picture, in the media-control material. */
.image-capture-shutter {
  display: flex;
  border: 2px solid var(--media-border);
  border-radius: 999px;
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
  overflow: hidden;
}
/* A small viewfinder keeps the picture readable: the question shrinks, the controls stay. */
@container image-capture (max-height: 200px) {
  .image-capture-question {
    font-size: 0.75rem;
    padding: 2px 8px;
  }
}
</style>
