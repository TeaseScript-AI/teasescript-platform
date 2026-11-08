import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type Ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import type { PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import { MODE_SURFACES } from "../../theme/palette.js";
import { photoColours, type PhotoColourChoice } from "../../theme/photo-theme.js";

// Photo colours (PLAYER-UI.md "Stage and media presentation"): the Stage photo colours the Player.

/**
 * How long the Player's colours take to fade to a new photo's colour, in milliseconds, per the Photo colour fade time A/B
 * test: A, 0.6 s, or B, 0.3 s like Milovana's player. The Photo colour blending A/B test sets how the colours blend
 * (`usePlayerTheme.ts`).
 */
const PHOTO_FADE_TIMES = { "0.6s": 600, "0.3s": 300 } as const;
export type PhotoFadeTime = keyof typeof PHOTO_FADE_TIMES;

/** The Stage's photo, not an image request's preview over it. */
function stageImage(stage: HTMLElement | undefined) {
  return (
    stage?.querySelector<HTMLImageElement>("img.stage-media:not([data-stage-preview])") ?? undefined
  );
}

/**
 * Where the background's vignette is centred and how large its centre is (`--vignette-cx`, `--vignette-cy`,
 * `--vignette-w`, `--vignette-h` on the document root): the photo as it is drawn, or without a photo the Stage's box, so
 * no earlier photo's place stays. The Stage image keeps its aspect inside its box (`object-fit: contain`). Its box can
 * change while the canvas and the Stage keep their size, as when a preview or the camera view over it goes, so the
 * image is observed too.
 */
function useVignetteGeometry(
  canvas: Readonly<Ref<HTMLElement | undefined>>,
  stage: Readonly<Ref<HTMLElement | undefined>>,
  photo: readonly Readonly<Ref<unknown>>[],
) {
  const root = document.documentElement;
  const image = shallowRef<HTMLImageElement>();
  let frame = 0;
  function set(box: { left: number; top: number; width: number; height: number }, origin: DOMRect) {
    root.style.setProperty("--vignette-cx", `${box.left - origin.left + box.width / 2}px`);
    root.style.setProperty("--vignette-cy", `${box.top - origin.top + box.height / 2}px`);
    root.style.setProperty("--vignette-w", `${box.width}px`);
    root.style.setProperty("--vignette-h", `${box.height}px`);
  }
  function place() {
    frame = 0;
    image.value = stageImage(stage.value);
    if (!canvas.value) return;
    const origin = canvas.value.getBoundingClientRect();
    // No photo, or one that failed to load (as `Stage.vue` tells a failure): the middle of the Stage.
    if (!image.value || (image.value.complete && image.value.naturalWidth === 0)) {
      if (stage.value) set(stage.value.getBoundingClientRect(), origin);
      return;
    }
    const { naturalWidth, naturalHeight } = image.value;
    const box = image.value.getBoundingClientRect();
    // A photo still loading, or hidden by an image request's preview: the effects keep their place.
    if (naturalWidth === 0 || box.width === 0 || box.height === 0) return;
    const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    set(
      {
        left: box.left + (box.width - width) / 2,
        top: box.top + (box.height - height) / 2,
        width,
        height,
      },
      origin,
    );
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  useResizeObserver([canvas, stage, image], schedule);
  watch(photo, schedule, { flush: "post" });
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    for (const name of ["--vignette-cx", "--vignette-cy", "--vignette-w", "--vignette-h"])
      root.style.removeProperty(name);
  });
}

/**
 * The Player's photo colours from the swatches of the photo the Stage shows (`photo`; `null` swatches keep the theme's
 * own colours). While they apply, the document root has `data-photo-colour`. The vignette's strength
 * (`--player-vignette`) is the mode's, with or without a photo; for a moment after the colours change the root has
 * `data-photo-fade`, during which `style.css` fades the background and the message bubbles.
 */
export function usePhotoColour(
  photo: Readonly<Ref<unknown>>,
  swatches: Readonly<Ref<PhotoSwatches | null>>,
  mode: Readonly<Ref<"light" | "dark">>,
  /** The swatch family the colours come from; another choice maps the same swatches again, without measuring. */
  choice: Readonly<Ref<PhotoColourChoice>>,
  fadeTime: Readonly<Ref<PhotoFadeTime>>,
  elements: {
    readonly canvas: Readonly<Ref<HTMLElement | undefined>>;
    readonly stage: Readonly<Ref<HTMLElement | undefined>>;
  },
) {
  const colours = computed(() =>
    swatches.value ? photoColours(swatches.value, mode.value, choice.value) : null,
  );
  useVignetteGeometry(elements.canvas, elements.stage, [photo, swatches]);
  const root = document.documentElement;
  const fading = ref(false);
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  // Every change fades: the first photo, the next one, the theme's return, and another mode. Authored colours adapt to
  // the background once it has settled, so they can lack contrast during the fade.
  watch(colours, () => {
    clearTimeout(fadeTimer);
    fading.value = true;
    fadeTimer = setTimeout(() => (fading.value = false), PHOTO_FADE_TIMES[fadeTime.value] + 100);
  });
  watchEffect(() => {
    root.toggleAttribute("data-photo-colour", colours.value !== null);
    root.style.setProperty("--player-vignette", String(MODE_SURFACES[mode.value].vignette));
    root.style.setProperty("--photo-fade-duration", `${PHOTO_FADE_TIMES[fadeTime.value]}ms`);
    root.toggleAttribute("data-photo-fade", fading.value);
  });
  onBeforeUnmount(() => {
    clearTimeout(fadeTimer);
    root.removeAttribute("data-photo-colour");
    root.removeAttribute("data-photo-fade");
    root.style.removeProperty("--player-vignette");
    root.style.removeProperty("--photo-fade-duration");
  });
  return colours;
}
