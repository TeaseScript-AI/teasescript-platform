import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type Ref } from "vue";
import { useEventListener, useMutationObserver, useResizeObserver } from "@vueuse/core";
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

type Box = { left: number; top: number; width: number; height: number };

/**
 * The box an image draws in, as it keeps its aspect inside its element (`object-fit: contain`); `null` once it failed
 * to load (as `Stage.vue` tells a failure), and `"loading"` before it has a size.
 */
function containedBox(image: HTMLImageElement): Box | null | "loading" {
  const { complete, naturalWidth, naturalHeight } = image;
  if (complete && naturalWidth === 0) return null;
  const box = image.getBoundingClientRect();
  if (naturalWidth === 0 || box.width === 0 || box.height === 0) return "loading";
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * What the Stage draws, the topmost first: an image request's preview, the camera view, or the photo, with the element
 * it is drawn by and its box. A failed preview or photo draws nothing; one still loading keeps the earlier place.
 */
function drawnVisual(
  stage: HTMLElement,
): { element: HTMLElement; box: Box | null | "loading" } | null {
  const preview = stage.querySelector<HTMLImageElement>("img[data-stage-preview]");
  if (preview) return { element: preview, box: containedBox(preview) };
  const camera = stage.querySelector<HTMLElement>("[data-stage-camera]");
  if (camera) {
    const box = camera.getBoundingClientRect();
    return { element: camera, box: box.width && box.height ? box : "loading" };
  }
  const photo = stage.querySelector<HTMLImageElement>("img.stage-media:not([data-stage-preview])");
  return photo ? { element: photo, box: containedBox(photo) } : null;
}

/**
 * Where the background's vignette is centred and how large its centre is (`--vignette-cx`, `--vignette-cy`,
 * `--vignette-w`, `--vignette-h` on the document root): the box of what the Stage draws (`drawnVisual`), or the Stage's
 * box when it draws nothing, so no earlier visual's place stays. The colours stay the photo's while a preview or the
 * camera view covers it. What is drawn can change while the canvas and the Stage keep their size, as when a preview
 * comes or goes or an image loads, so the Stage's elements, their loads and the drawn element's size are watched.
 */
function useVignetteGeometry(
  canvas: Readonly<Ref<HTMLElement | undefined>>,
  stage: Readonly<Ref<HTMLElement | undefined>>,
  photo: readonly Readonly<Ref<unknown>>[],
) {
  const root = document.documentElement;
  const drawn = shallowRef<HTMLElement>();
  let frame = 0;
  function set(box: Box, origin: DOMRect) {
    root.style.setProperty("--vignette-cx", `${box.left - origin.left + box.width / 2}px`);
    root.style.setProperty("--vignette-cy", `${box.top - origin.top + box.height / 2}px`);
    root.style.setProperty("--vignette-w", `${box.width}px`);
    root.style.setProperty("--vignette-h", `${box.height}px`);
  }
  function place() {
    frame = 0;
    if (!canvas.value || !stage.value) return;
    const visual = drawnVisual(stage.value);
    drawn.value = visual?.element;
    if (visual?.box === "loading") return;
    set(visual?.box ?? stage.value.getBoundingClientRect(), canvas.value.getBoundingClientRect());
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  useResizeObserver([canvas, stage, drawn], schedule);
  useMutationObserver(stage, schedule, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "style"],
  });
  // Loads and failures do not bubble; the Stage hears its images' in the capture phase.
  useEventListener(stage, "load", schedule, { capture: true });
  useEventListener(stage, "error", schedule, { capture: true });
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
  // Each change's fade, so that the end of an earlier one, or one after unmounting, changes nothing.
  let fadeGeneration = 0;
  // Every change fades: the first photo, the next one, the theme's return, and another mode. Authored colours adapt to
  // the background once it has settled, so they can lack contrast during the fade.
  watch(colours, () => {
    clearTimeout(fadeTimer);
    const generation = ++fadeGeneration;
    fading.value = true;
    fadeTimer = setTimeout(() => void endFade(generation), PHOTO_FADE_TIMES[fadeTime.value] + 100);
  });
  /**
   * Ends the fade once its transitions, on the root and the canvas, have finished: they start in a frame after the
   * change, which a busy page can delay past the timer, and the authored colours adapt to the background as it ends.
   * (`getAnimations` first applies pending style changes, so it also finds transitions that have not started yet.)
   */
  async function endFade(generation: number) {
    const canvas = elements.canvas.value;
    const own = (target: Element | null) =>
      target === root || (canvas !== undefined && target !== null && canvas.contains(target));
    const running = document
      .getAnimations()
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.playState === "running" &&
          animation.effect instanceof KeyframeEffect &&
          own(animation.effect.target),
      );
    // A transition cancelled or replaced meanwhile rejects its `finished`; the fade still ends.
    await Promise.allSettled(running.map((animation) => animation.finished));
    if (generation === fadeGeneration) fading.value = false;
  }
  watchEffect(() => {
    root.toggleAttribute("data-photo-colour", colours.value !== null);
    root.style.setProperty("--player-vignette", String(MODE_SURFACES[mode.value].vignette));
    root.style.setProperty("--photo-fade-duration", `${PHOTO_FADE_TIMES[fadeTime.value]}ms`);
    root.toggleAttribute("data-photo-fade", fading.value);
  });
  onBeforeUnmount(() => {
    clearTimeout(fadeTimer);
    fadeGeneration += 1;
    root.removeAttribute("data-photo-colour");
    root.removeAttribute("data-photo-fade");
    root.style.removeProperty("--player-vignette");
    root.style.removeProperty("--photo-fade-duration");
  });
  return colours;
}
