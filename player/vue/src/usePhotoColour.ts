import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type Ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { photoSwatches, type PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import { photoColours } from "../../theme/photo-theme.js";

// Photo colours (PLAYER-UI.md "Stage and media presentation"): the Stage photo colours the Player.

/** The photo is measured at this longest side: enough pixels for six swatches, few enough to stay cheap. */
const MEASURE_SIDE = 128;
/** A photo must stay this long before the Player follows it, so fast image changes do not flicker. */
const SETTLE_MS = 200;
/** How long the background and the message bubbles take to fade to a new photo's colour, as in `style.css`. */
const FADE_MS = 600;
/** The swatches of this many recent photos are kept, so a photo shown again is not measured again. */
const CACHE_SIZE = 32;
const cache = new Map<string, PhotoSwatches | null>();

/** The photo's swatches, or `null` when the browser cannot read its pixels. */
async function measure(source: string): Promise<PhotoSwatches | null> {
  const image = new Image();
  // Before the source: an image from another origin then loads readable when its server allows it, and fails to load
  // otherwise, instead of tainting the canvas.
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = source;
  await image.decode();
  const scale = Math.min(1, MEASURE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return photoSwatches(context.getImageData(0, 0, canvas.width, canvas.height).data);
}

/**
 * The swatches of the Stage photo, measured once per source after it settled; `null` while the Stage shows no photo. A
 * photo whose pixels cannot be read keeps the previous photo's swatches.
 */
function usePhotoSwatches(source: Readonly<Ref<string | null>>) {
  const swatches = shallowRef<PhotoSwatches | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  watch(
    source,
    (src) => {
      clearTimeout(timer);
      const current = ++generation;
      timer = setTimeout(async () => {
        if (src === null) {
          swatches.value = null;
          return;
        }
        let result = cache.get(src);
        if (result === undefined) {
          try {
            result = await measure(src);
          } catch {
            result = null;
          }
          cache.set(src, result);
          if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
        }
        if (current === generation && result) swatches.value = result;
      }, SETTLE_MS);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => clearTimeout(timer));
  return swatches;
}

/**
 * Where the photo is drawn on the Player's background (`--photo-cx`, `--photo-cy`, `--photo-w`, `--photo-h` on the
 * document root), so the background centres its effects on it. The Stage image keeps its aspect inside its box
 * (`object-fit: contain`).
 */
function usePhotoGeometry(
  canvas: Readonly<Ref<HTMLElement | undefined>>,
  stage: Readonly<Ref<HTMLElement | undefined>>,
  photo: readonly Readonly<Ref<unknown>>[],
) {
  const root = document.documentElement;
  let frame = 0;
  function place() {
    frame = 0;
    const image = stage.value?.querySelector<HTMLImageElement>(
      "img.stage-media:not([data-stage-preview])",
    );
    if (!canvas.value || !image || image.naturalWidth === 0) return;
    const box = image.getBoundingClientRect();
    // An image request's preview hides the photo: its effects keep their place.
    if (box.width === 0 || box.height === 0) return;
    const origin = canvas.value.getBoundingClientRect();
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    root.style.setProperty("--photo-cx", `${box.left - origin.left + box.width / 2}px`);
    root.style.setProperty("--photo-cy", `${box.top - origin.top + box.height / 2}px`);
    root.style.setProperty("--photo-w", `${image.naturalWidth * scale}px`);
    root.style.setProperty("--photo-h", `${image.naturalHeight * scale}px`);
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  useResizeObserver(canvas, schedule);
  useResizeObserver(stage, schedule);
  watch(photo, schedule, { flush: "post" });
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    for (const name of ["--photo-cx", "--photo-cy", "--photo-w", "--photo-h"])
      root.style.removeProperty(name);
  });
}

/**
 * The Player's photo colours for the photo the Stage shows (`source`, `null` without one): `null` keeps the theme's own
 * colours. While they apply, the document root has `data-photo-colour` and the vignette strength `--photo-vignette`;
 * for a moment after the photo colour changes it has `data-photo-fade`, during which `style.css` fades the background
 * and the message bubbles.
 */
export function usePhotoColour(
  source: Readonly<Ref<string | null>>,
  mode: Readonly<Ref<"light" | "dark">>,
  elements: {
    readonly canvas: Readonly<Ref<HTMLElement | undefined>>;
    readonly stage: Readonly<Ref<HTMLElement | undefined>>;
  },
) {
  const swatches = usePhotoSwatches(source);
  const colours = computed(() =>
    swatches.value ? photoColours(swatches.value, mode.value) : null,
  );
  usePhotoGeometry(elements.canvas, elements.stage, [source, swatches]);
  const root = document.documentElement;
  const fading = ref(false);
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  watch(swatches, () => {
    fading.value = true;
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => (fading.value = false), FADE_MS + 100);
  });
  watchEffect(() => {
    const vignette = colours.value?.vignette;
    root.toggleAttribute("data-photo-colour", vignette !== undefined);
    if (vignette === undefined) root.style.removeProperty("--photo-vignette");
    else root.style.setProperty("--photo-vignette", String(vignette));
    root.toggleAttribute("data-photo-fade", fading.value);
  });
  onBeforeUnmount(() => {
    clearTimeout(fadeTimer);
    root.removeAttribute("data-photo-colour");
    root.removeAttribute("data-photo-fade");
    root.style.removeProperty("--photo-vignette");
  });
  return colours;
}
