import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import type { PreparedPhoto } from "./stagePhotos";

/**
 * How long a new photo that is ready to show waits for its colours. Then it shows with the colours the Player has, and
 * its own follow once they are measured.
 */
const COLOUR_WAIT_MS = 300;

type StageMedia = { readonly src: string; readonly alt: string };

/**
 * The Stage photo and its colours, shown together (PLAYER-UI.md "Stage and media presentation"). While a new photo is
 * prepared, the previous photo and its colours stay; then the photo and its swatches change at once. A photo whose
 * pixels cannot be read keeps the previous photo's swatches; the empty Stage has none and shows at once. A photo replaced
 * before it is ready is never shown.
 */
export function useStagePhoto(
  media: Readonly<Ref<StageMedia | undefined>>,
  prepare: (source: string) => PreparedPhoto,
) {
  /** The media the Stage shows, with the URL it loads them from; `null` for the empty Stage. */
  const shown = shallowRef<{ readonly media: StageMedia; readonly url: string } | null>(null);
  /** The swatches of the shown photo, or of an earlier one while its own are not known or cannot be read. */
  const swatches = shallowRef<PhotoSwatches | null>(null);
  // The prepared photo the Stage shows, and the one it waits for.
  let current: PreparedPhoto | null = null;
  let pending: PreparedPhoto | null = null;
  let wait: ReturnType<typeof setTimeout> | undefined;
  watch(
    () => media.value?.src,
    (src) => {
      clearTimeout(wait);
      pending?.release();
      pending = null;
      const next = media.value;
      if (src === undefined || next === undefined) {
        current?.release();
        current = null;
        shown.value = null;
        swatches.value = null;
        return;
      }
      if (src === shown.value?.media.src) return;
      const photo = prepare(src);
      pending = photo;
      let measured: PhotoSwatches | null | undefined;
      let url: string | undefined;
      const show = () => {
        clearTimeout(wait);
        current?.release();
        current = photo;
        pending = null;
        shown.value = { media: next, url: url! };
        if (measured) swatches.value = measured;
      };
      void photo.swatches.then((result) => {
        measured = result;
        if (photo === pending && url !== undefined) show();
        else if (photo === current && result) swatches.value = result;
      });
      void photo.shown.then((ready) => {
        if (photo !== pending) return;
        url = ready;
        if (measured !== undefined) show();
        else wait = setTimeout(show, COLOUR_WAIT_MS);
      });
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    clearTimeout(wait);
    pending?.release();
    current?.release();
  });
  return { shown, swatches };
}
