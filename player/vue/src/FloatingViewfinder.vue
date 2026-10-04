<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { GripVertical, MoveDiagonal2 } from "@lucide/vue";
import Viewfinder from "./Viewfinder.vue";

// DEMO: the viewfinder as a floating window over the Player, like a mini player. The user moves it by dragging it or
// with its grip's arrow keys, and resizes it from its corner. Its place lasts while the Player is mounted, also while
// the viewfinder is hidden; it is presentation only.
export interface FloatingPlace {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}
defineProps<{ track: MediaStreamTrack }>();
const place = defineModel<FloatingPlace | null>("place", { default: null });

const EDGE = 8;
const MIN_WIDTH = 140;
const STEP = 16;
const root = ref<HTMLElement | null>(null);
const bounds = ref({ width: 0, height: 0 });
const ratio = ref(4 / 3);
// While the browser's picture-in-picture window shows the camera, the window keeps its place but is not shown.
const away = ref(false);

useResizeObserver(
  () => root.value?.parentElement,
  ([entry]) => {
    if (!entry) return;
    bounds.value = { width: entry.contentRect.width, height: entry.contentRect.height };
    if (place.value) place.value = clamp(place.value);
  },
);
onMounted(() => {
  const parent = root.value?.parentElement;
  if (!parent) return;
  bounds.value = { width: parent.clientWidth, height: parent.clientHeight };
  // First shown below the title, at a size that leaves the conversation readable.
  place.value = clamp(
    place.value ?? { x: EDGE * 2, y: 64, width: Math.min(Math.max(parent.clientWidth * 0.26, 200), 360) },
  );
});

function clamp({ x, y, width }: FloatingPlace): FloatingPlace {
  const { width: maxWidth, height: maxHeight } = bounds.value;
  // The available space wins over the preferred minimum, so the corner stays reachable in a small Player.
  const largest = Math.max(0, Math.min(maxWidth - 2 * EDGE, (maxHeight - 2 * EDGE) * ratio.value));
  const clampedWidth = Math.min(Math.max(width, Math.min(MIN_WIDTH, largest)), largest);
  const height = clampedWidth / ratio.value;
  return {
    width: clampedWidth,
    x: Math.min(Math.max(x, EDGE), Math.max(EDGE, maxWidth - clampedWidth - EDGE)),
    y: Math.min(Math.max(y, EDGE), Math.max(EDGE, maxHeight - height - EDGE)),
  };
}
const style = computed(() =>
  place.value
    ? { left: `${place.value.x}px`, top: `${place.value.y}px`, width: `${place.value.width}px` }
    : { visibility: "hidden" as const },
);

// One pointer drag moves the window or, from the corner, resizes it with the camera's aspect. Further pointers, such as
// a second finger, are ignored until it ends.
let dragging = false;
function drag(event: PointerEvent, mode: "move" | "resize") {
  const start = place.value;
  if (!start || event.button !== 0 || dragging) return;
  event.preventDefault();
  event.stopPropagation();
  dragging = true;
  const target = event.currentTarget as HTMLElement;
  const pointer = event.pointerId;
  target.setPointerCapture(pointer);
  const origin = { x: event.clientX, y: event.clientY };
  const moved = (next: PointerEvent) => {
    if (next.pointerId !== pointer) return;
    const dx = next.clientX - origin.x;
    const dy = next.clientY - origin.y;
    // A corner drag resizes by the movement along the window's diagonal, so it grows and shrinks.
    const grown = (dx + dy / ratio.value) / (1 + 1 / ratio.value ** 2);
    place.value = clamp(
      mode === "move"
        ? { ...start, x: start.x + dx, y: start.y + dy }
        : { ...start, width: start.width + grown },
    );
  };
  const ended = (next: PointerEvent) => {
    if (next.pointerId !== pointer) return;
    dragging = false;
    target.removeEventListener("pointermove", moved);
    target.removeEventListener("pointerup", ended);
    target.removeEventListener("pointercancel", ended);
    target.removeEventListener("lostpointercapture", ended);
  };
  target.addEventListener("pointermove", moved);
  target.addEventListener("pointerup", ended);
  target.addEventListener("pointercancel", ended);
  target.addEventListener("lostpointercapture", ended);
}
function keyboard(event: KeyboardEvent, mode: "move" | "resize") {
  const current = place.value;
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
    event.key
  ];
  if (!current || !direction) return;
  event.preventDefault();
  const [dx, dy] = direction as [number, number];
  const step = event.shiftKey ? STEP * 4 : STEP;
  place.value = clamp(
    mode === "move"
      ? { ...current, x: current.x + dx * step, y: current.y + dy * step }
      : { ...current, width: current.width + (dx + dy) * step },
  );
}
function measured(next: number) {
  ratio.value = next;
  if (place.value) place.value = clamp(place.value);
}
</script>

<template>
  <div
    ref="root"
    class="floating-viewfinder"
    :class="{ 'floating-viewfinder-away': away }"
    :inert="away || undefined"
    data-floating-viewfinder
    :style="style"
    @pointerdown="drag($event, 'move')"
  >
    <Viewfinder
      :track="track"
      class="floating-viewfinder-frame"
      @aspect="measured"
      @away="away = $event"
    >
      <!-- The grip moves the window by keyboard; the whole window drags. -->
      <button
        type="button"
        class="floating-viewfinder-grip"
        aria-label="Move camera preview"
        title="Drag to move; arrow keys move it too"
        @keydown="keyboard($event, 'move')"
      >
        <GripVertical aria-hidden="true" class="size-3.5" />
      </button>
      <button
        type="button"
        class="floating-viewfinder-resize"
        aria-label="Resize camera preview"
        title="Drag to resize; arrow keys resize it too"
        @pointerdown="drag($event, 'resize')"
        @keydown="keyboard($event, 'resize')"
      >
        <MoveDiagonal2 aria-hidden="true" class="size-3.5" />
      </button>
    </Viewfinder>
  </div>
</template>

<style scoped>
.floating-viewfinder {
  position: absolute;
  z-index: 15;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.floating-viewfinder:active { cursor: grabbing; }
.floating-viewfinder-away { pointer-events: none; }
.floating-viewfinder-frame { width: 100%; box-shadow: 0 8px 28px var(--media-shadow); }
.floating-viewfinder-grip,
.floating-viewfinder-resize {
  position: absolute;
  display: grid;
  place-items: center;
  border: 1px solid var(--media-border);
  color: var(--media-text);
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  width: 26px;
  height: 26px;
  border-radius: 9999px;
  backdrop-filter: blur(3px);
}
.floating-viewfinder-grip {
  top: 8px;
  left: 8px;
  cursor: grab;
}
.floating-viewfinder-resize {
  right: 6px;
  bottom: 6px;
  cursor: nwse-resize;
}
</style>
