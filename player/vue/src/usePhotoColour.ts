import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type Ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { photoSwatches, type PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import { photoColours } from "../../theme/photo-theme.js";
import { usePhotoSwatches } from "./usePhotoSwatches";

// Photo colours (PLAYER-UI.md "Stage and media presentation"): the Stage photo colours the Player.

/** The photo is measured at this longest side: enough pixels for six swatches, few enough to stay cheap. */
const MEASURE_SIDE = 128;
/** How long the background and the message bubbles take to fade to a new photo's colour, as in `style.css`. */
const FADE_MS = 600;

/**
 * The swatches of the photo the Stage shows, read from its own image element: the browser downloads and decodes it
 * once, for the Stage. An image from another origin that its server does not share leaves the canvas unreadable, and
 * this throws.
 */
function measure(image: HTMLImageElement): PhotoSwatches | null {
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return null;
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
 * The Player's photo colours for the photo the Stage shows (`source`, `null` without one): `null` keeps the theme's own
 * colours. While they apply, the document root has `data-photo-colour` and the vignette strength `--photo-vignette`;
 * for a moment after one photo's colour follows another's it has `data-photo-fade`, during which `style.css` fades the
 * background and the message bubbles.
 */
export function usePhotoColour(
  source: Readonly<Ref<string | null>>,
  mode: Readonly<Ref<"light" | "dark">>,
  elements: {
    readonly canvas: Readonly<Ref<HTMLElement | undefined>>;
    readonly stage: Readonly<Ref<HTMLElement | undefined>>;
  },
) {
  // The Stage's own image of that source, while it still shows it.
  const swatches = usePhotoSwatches(source, (src) => {
    const image = stageImage(elements.stage.value);
    return image?.getAttribute("src") === src && image.complete ? measure(image) : undefined;
  });
  const colours = computed(() =>
    swatches.value ? photoColours(swatches.value, mode.value) : null,
  );
  usePhotoGeometry(elements.canvas, elements.stage, [source, swatches]);
  const root = document.documentElement;
  const fading = ref(false);
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  // Between two photos in one mode the surfaces keep their tones, so they fade without changing the contrast of anything
  // on them. Any other change, such as the first photo, the theme's return, or another mode, changes how light the
  // surfaces are: it switches at once, together with the text and the authored colours drawn on them.
  watch(colours, (next, previous) => {
    clearTimeout(fadeTimer);
    fading.value =
      next !== null && previous !== null && next.surfaces.tones === previous.surfaces.tones;
    if (fading.value) fadeTimer = setTimeout(() => (fading.value = false), FADE_MS + 100);
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
