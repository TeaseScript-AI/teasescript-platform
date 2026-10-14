import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type Ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import type { PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import { photoColours, type PhotoColourChoice } from "../../theme/photo-theme.js";

// Photo colours (PLAYER-UI.md "Stage and media presentation"): the Stage photo colours the Player.

/**
 * How long the Player's colours take to fade to a new photo's colour, per the Photo colour transition A/B test: A, 0.6 s
 * blended in Oklab, or B, 0.3 s blended in sRGB like Milovana's player (`usePlayerTheme.ts` writes the colours for it).
 */
const PHOTO_TRANSITIONS = { oklab: 600, srgb: 300 } as const;
export type PhotoTransition = keyof typeof PHOTO_TRANSITIONS;

/** The Stage's photo, not an image request's preview over it. */
function stageImage(stage: HTMLElement | undefined) {
  return (
    stage?.querySelector<HTMLImageElement>("img.stage-media:not([data-stage-preview])") ?? undefined
  );
}

/**
 * Where the photo is drawn on the Player's background (`--photo-cx`, `--photo-cy`, `--photo-w`, `--photo-h` on the
 * document root), so the background centres its effects on it. The Stage image keeps its aspect inside its box
 * (`object-fit: contain`). Its box can change while the canvas and the Stage keep their size, as when a preview or the
 * camera view over it goes, so the image is observed too.
 */
function usePhotoGeometry(
  canvas: Readonly<Ref<HTMLElement | undefined>>,
  stage: Readonly<Ref<HTMLElement | undefined>>,
  photo: readonly Readonly<Ref<unknown>>[],
) {
  const root = document.documentElement;
  const image = shallowRef<HTMLImageElement>();
  let frame = 0;
  function place() {
    frame = 0;
    image.value = stageImage(stage.value);
    if (!canvas.value || !image.value || image.value.naturalWidth === 0) return;
    const { naturalWidth, naturalHeight } = image.value;
    const box = image.value.getBoundingClientRect();
    // An image request's preview hides the photo: its effects keep their place.
    if (box.width === 0 || box.height === 0) return;
    const origin = canvas.value.getBoundingClientRect();
    const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
    root.style.setProperty("--photo-cx", `${box.left - origin.left + box.width / 2}px`);
    root.style.setProperty("--photo-cy", `${box.top - origin.top + box.height / 2}px`);
    root.style.setProperty("--photo-w", `${naturalWidth * scale}px`);
    root.style.setProperty("--photo-h", `${naturalHeight * scale}px`);
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  useResizeObserver([canvas, stage, image], schedule);
  watch(photo, schedule, { flush: "post" });
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    for (const name of ["--photo-cx", "--photo-cy", "--photo-w", "--photo-h"])
      root.style.removeProperty(name);
  });
}

/**
 * The Player's photo colours from the swatches of the photo the Stage shows (`photo`; `null` swatches keep the theme's
 * own colours). While they apply, the document root has `data-photo-colour` and the vignette strength
 * `--photo-vignette`; for a moment after they change it has `data-photo-fade`, during which `style.css` fades the
 * background and the message bubbles.
 */
export function usePhotoColour(
  photo: Readonly<Ref<unknown>>,
  swatches: Readonly<Ref<PhotoSwatches | null>>,
  mode: Readonly<Ref<"light" | "dark">>,
  /** The swatch family the colours come from; another choice maps the same swatches again, without measuring. */
  choice: Readonly<Ref<PhotoColourChoice>>,
  transition: Readonly<Ref<PhotoTransition>>,
  elements: {
    readonly canvas: Readonly<Ref<HTMLElement | undefined>>;
    readonly stage: Readonly<Ref<HTMLElement | undefined>>;
  },
) {
  const colours = computed(() =>
    swatches.value ? photoColours(swatches.value, mode.value, choice.value) : null,
  );
  usePhotoGeometry(elements.canvas, elements.stage, [photo, swatches]);
  const root = document.documentElement;
  const fading = ref(false);
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  // Every change fades: the first photo, the next one, the theme's return, and another mode. Authored colours adapt to
  // the background once it has settled, so they can lack contrast during the fade.
  watch(colours, () => {
    clearTimeout(fadeTimer);
    fading.value = true;
    fadeTimer = setTimeout(() => (fading.value = false), PHOTO_TRANSITIONS[transition.value] + 100);
  });
  watchEffect(() => {
    const vignette = colours.value?.vignette;
    root.toggleAttribute("data-photo-colour", vignette !== undefined);
    if (vignette === undefined) root.style.removeProperty("--photo-vignette");
    else root.style.setProperty("--photo-vignette", String(vignette));
    root.style.setProperty("--photo-fade-duration", `${PHOTO_TRANSITIONS[transition.value]}ms`);
    root.toggleAttribute("data-photo-fade", fading.value);
  });
  onBeforeUnmount(() => {
    clearTimeout(fadeTimer);
    root.removeAttribute("data-photo-colour");
    root.removeAttribute("data-photo-fade");
    root.style.removeProperty("--photo-vignette");
    root.style.removeProperty("--photo-fade-duration");
  });
  return colours;
}
