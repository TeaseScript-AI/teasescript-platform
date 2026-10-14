import { useStorage } from "@vueuse/core";
import { shallowRef, type Ref } from "vue";

/** This browser's local storage, or `undefined` when the host frame denies it. */
export function browserStorage(): Storage | undefined {
  try {
    // A sandboxed host frame without same-origin access throws on this read.
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// Player Settings are browser-local presentation preferences, not canonical runtime state.
// Stored text is external input, including writes from other tabs: every read maps an
// unknown value to the default. Only a choice is stored, so an untouched preference follows a changed default.
export function usePlayerPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): Ref<T> {
  const storage = browserStorage();
  if (!storage) return shallowRef(fallback);
  return useStorage<T>(key, fallback, storage, {
    writeDefaults: false,
    serializer: {
      read: (raw) => allowed.find((value) => value === raw) ?? fallback,
      write: (value) => value,
    },
  });
}

/**
 * Moves the choice stored for the former Photo colour transition A/B test, which changed the fade time and the blending
 * together, to the two tests that replaced it (owner decision 2026-10-14): its A, 0.6 s blended in Oklab, chooses A in
 * both, and its B, 0.3 s blended in sRGB, B in both, so a choice stays when a default changes.
 */
export function migratePhotoTransition(storage: Storage | undefined) {
  if (!storage) return;
  try {
    const stored = storage.getItem("player-photo-transition");
    if (stored === null) return;
    if (stored === "oklab" || stored === "srgb") {
      storage.setItem("player-photo-fade-time", stored === "oklab" ? "0.6s" : "0.3s");
      storage.setItem("player-photo-blending", stored);
    }
    storage.removeItem("player-photo-transition");
  } catch {
    // A storage that refuses the write keeps the old choice, so the next load moves it.
  }
}

/** A number preference from `min` to `max`; stored text that is no such number reads as the default. */
export function usePlayerNumberPreference(
  key: string,
  { min, max }: { readonly min: number; readonly max: number },
  fallback: number,
): Ref<number> {
  const storage = browserStorage();
  if (!storage) return shallowRef(fallback);
  return useStorage<number>(key, fallback, storage, {
    writeDefaults: false,
    serializer: {
      read: (raw) => {
        const value = raw.trim() === "" ? Number.NaN : Number(raw);
        return value >= min && value <= max ? value : fallback;
      },
      write: (value) => String(value),
    },
  });
}
