<script setup lang="ts">
import { computed, onMounted, ref, useId } from "vue";
import { useResizeObserver } from "@vueuse/core";
import Viewfinder from "./Viewfinder.vue";
import ViewfinderMirrorButton from "./ViewfinderMirrorButton.vue";

// The viewfinder as a floating window over the Player, like a mini player. A slim title bar shows that it is a window.
// The user drags it anywhere, resizes it from any edge or corner like a desktop window, keeping the camera's aspect, or
// focuses it and moves it with the arrow keys and resizes it with + and -. It floats in the whole Player shell, so
// showing or hiding the tools sidebar never moves it: it lies over a docked sidebar and under the narrow-layout drawer.
// Its place lasts while the Player is mounted, also while the viewfinder is hidden; it is presentation only.
export interface FloatingPlace {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}
defineProps<{ track: MediaStreamTrack }>();
const place = defineModel<FloatingPlace | null>("place", { default: null });
const mirrored = defineModel<boolean>("mirrored", { default: true });

const EDGE = 8;
const MIN_WIDTH = 140;
const STEP = 16;
/** The title bar's height in pixels, part of the window's height. */
const BAR = 32;
// The edge or corner a resize drags: which way it moves the left/right and top/bottom side, or 0 where it keeps it.
const HANDLES = [
  { name: "n", x: 0, y: -1 },
  { name: "s", x: 0, y: 1 },
  { name: "w", x: -1, y: 0 },
  { name: "e", x: 1, y: 0 },
  { name: "nw", x: -1, y: -1 },
  { name: "ne", x: 1, y: -1 },
  { name: "sw", x: -1, y: 1 },
  { name: "se", x: 1, y: 1 },
] as const;
type Handle = (typeof HANDLES)[number];
const anchor = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);
const helpId = useId();
const bounds = ref({ width: 0, height: 0 });
const ratio = ref(4 / 3);

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
  const area = anchor.value?.parentElement;
  if (!parent || !area) return;
  bounds.value = { width: parent.clientWidth, height: parent.clientHeight };
  // First shown in the Player area beside the sidebar, below the title, at a size that leaves the conversation readable.
  const shell = parent.getBoundingClientRect();
  const start = area.getBoundingClientRect();
  place.value = clamp(
    place.value ?? {
      x: start.left - shell.left + EDGE * 2,
      y: start.top - shell.top + 64,
      width: Math.min(Math.max(start.width * 0.26, 200), 360),
    },
  );
});

const heightOf = (width: number) => width / ratio.value + BAR;
/** The widest window whose height fits in `height`. */
const widthFitting = (height: number) => Math.max(0, (height - BAR) * ratio.value);
function clamp({ x, y, width }: FloatingPlace): FloatingPlace {
  const { width: maxWidth, height: maxHeight } = bounds.value;
  // The available space wins over the preferred minimum, so the window stays inside a small Player.
  const largest = Math.max(0, Math.min(maxWidth - 2 * EDGE, widthFitting(maxHeight - 2 * EDGE)));
  const clampedWidth = Math.min(Math.max(width, Math.min(MIN_WIDTH, largest)), largest);
  return {
    width: clampedWidth,
    x: Math.min(Math.max(x, EDGE), Math.max(EDGE, maxWidth - clampedWidth - EDGE)),
    y: Math.min(Math.max(y, EDGE), Math.max(EDGE, maxHeight - heightOf(clampedWidth) - EDGE)),
  };
}
/**
 * The window resized from `handle` by a pointer movement. The sides opposite the dragged ones stay where they are; an
 * edge keeps the window's top or left side. A corner follows the movement along the window's diagonal.
 */
function resized(start: FloatingPlace, handle: Handle, dx: number, dy: number): FloatingPlace {
  const r = ratio.value;
  const grown =
    handle.x !== 0 && handle.y !== 0
      ? (handle.x * dx + (handle.y * dy) / r) / (1 + 1 / r ** 2)
      : handle.x !== 0
        ? handle.x * dx
        : handle.y * dy * r;
  const startHeight = heightOf(start.width);
  // The kept sides limit the size: the window grows only into the space beyond its moving sides.
  const room = Math.min(
    handle.x < 0 ? start.x + start.width - EDGE : bounds.value.width - EDGE - start.x,
    widthFitting(handle.y < 0 ? start.y + startHeight - EDGE : bounds.value.height - EDGE - start.y),
  );
  const width = Math.min(Math.max(start.width + grown, Math.min(MIN_WIDTH, room)), room);
  return clamp({
    width,
    x: handle.x < 0 ? start.x + start.width - width : start.x,
    y: handle.y < 0 ? start.y + startHeight - heightOf(width) : start.y,
  });
}
const style = computed(() =>
  place.value
    ? { left: `${place.value.x}px`, top: `${place.value.y}px`, width: `${place.value.width}px` }
    : { visibility: "hidden" as const },
);

// One pointer drag moves the window or, from an edge or corner, resizes it with the camera's aspect. Further pointers,
// such as a second finger, are ignored until it ends.
let dragging = false;
function drag(event: PointerEvent, handle: Handle | null) {
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
    place.value =
      handle === null
        ? clamp({ ...start, x: start.x + dx, y: start.y + dy })
        : resized(start, handle, dx, dy);
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
function keyboard(event: KeyboardEvent) {
  const current = place.value;
  // Keys on a control inside the window belong to that control.
  if (!current || event.target !== event.currentTarget) return;
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
    event.key
  ];
  const growth = { "+": 1, "=": 1, "-": -1 }[event.key];
  if (!direction && !growth) return;
  event.preventDefault();
  if (direction) {
    const [dx, dy] = direction as [number, number];
    const step = event.shiftKey ? STEP * 4 : STEP;
    place.value = clamp({ ...current, x: current.x + dx * step, y: current.y + dy * step });
    return;
  }
  // Typing + often needs Shift itself, so + and - keep one step.
  place.value = clamp({ ...current, width: current.width + growth! * STEP });
}
function measured(next: number) {
  ratio.value = next;
  if (place.value) place.value = clamp(place.value);
}
</script>

<template>
  <!-- Marks the Player area the window first appears in; the window itself floats in the whole shell. -->
  <span ref="anchor" class="floating-viewfinder-anchor" aria-hidden="true" />
  <Teleport to="#player-shell">
    <div
      ref="root"
      class="floating-viewfinder"
      data-floating-viewfinder
      role="group"
      aria-label="Camera preview window"
      :aria-describedby="helpId"
      tabindex="0"
      :style="style"
      @pointerdown="drag($event, null)"
      @keydown="keyboard"
    >
      <span :id="helpId" class="sr-only">
        Drag to move, or drag an edge to resize. Arrow keys move it; plus and minus resize it.
      </span>
      <div class="floating-viewfinder-window">
        <div class="floating-viewfinder-bar" :style="{ height: `${BAR}px` }">
          <ViewfinderMirrorButton v-model="mirrored" />
        </div>
        <Viewfinder :track="track" :mirrored="mirrored" @aspect="measured" />
      </div>
      <span
        v-for="handle in HANDLES"
        :key="handle.name"
        class="floating-viewfinder-handle"
        :data-handle="handle.name"
        aria-hidden="true"
        @pointerdown="drag($event, handle)"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.floating-viewfinder-anchor { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.floating-viewfinder {
  position: absolute;
  z-index: 15;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.floating-viewfinder:active { cursor: grabbing; }
.floating-viewfinder:focus-visible { outline: none; }
.floating-viewfinder:focus-visible .floating-viewfinder-window {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.floating-viewfinder-window {
  overflow: hidden;
  border: 1px solid var(--media-border);
  border-radius: 12px;
  background: var(--media-surface);
  box-shadow: 0 8px 28px var(--media-shadow);
  /* Firefox does not clip a transformed video to these rounded corners, so the video takes the lower ones itself. */
  --viewfinder-video-radius: 0 0 11px 11px;
}
.floating-viewfinder-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-inline: 2px;
  color: var(--media-text);
  border-bottom: 1px solid var(--media-border);
  backdrop-filter: blur(6px);
}
/* Invisible bands over the window's edges and corners, like a desktop window's resize borders; corners lie on top. */
.floating-viewfinder-handle { position: absolute; }
[data-handle="n"] { top: -4px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
[data-handle="s"] { bottom: -4px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
[data-handle="w"] { left: -4px; top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
[data-handle="e"] { right: -4px; top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
[data-handle="nw"] { top: -4px; left: -4px; width: 14px; height: 14px; cursor: nwse-resize; }
[data-handle="ne"] { top: -4px; right: -4px; width: 14px; height: 14px; cursor: nesw-resize; }
[data-handle="sw"] { bottom: -4px; left: -4px; width: 14px; height: 14px; cursor: nesw-resize; }
[data-handle="se"] { bottom: -4px; right: -4px; width: 14px; height: 14px; cursor: nwse-resize; }
</style>
