import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { PhotoSwatches } from "../../theme/node-vibrant/swatches.js";

/** A photo must stay this long before the Player follows it, so fast image changes do not flicker. */
const SETTLE_MS = 200;
/** The swatches of this many recent photos are kept, so a photo shown again is not measured again. */
const CACHE_SIZE = 32;
const cache = new Map<string, PhotoSwatches | null>();

/**
 * The swatches of the Stage photo, measured once per source after it settled; `null` while the Stage shows no photo. A
 * photo whose pixels cannot be read keeps the previous photo's swatches. `read` measures the shown photo of a source:
 * `null` when its pixels cannot be read (or it throws), `undefined` when the Stage no longer shows it.
 */
export function usePhotoSwatches(
  source: Readonly<Ref<string | null>>,
  read: (source: string) => PhotoSwatches | null | undefined,
) {
  const swatches = shallowRef<PhotoSwatches | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(
    source,
    (src) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (src === null) {
          swatches.value = null;
          return;
        }
        let result = cache.get(src);
        if (result === undefined) {
          try {
            result = read(src);
          } catch {
            result = null;
          }
          if (result === undefined) return;
          cache.set(src, result);
          if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
        }
        if (result) swatches.value = result;
      }, SETTLE_MS);
    },
    { immediate: true },
  );
  onScopeDispose(() => clearTimeout(timer));
  return swatches;
}
