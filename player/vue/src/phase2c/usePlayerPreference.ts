import { useStorage } from "@vueuse/core";
import { shallowRef, type Ref } from "vue";

function browserStorage(): Storage | undefined {
  try {
    // A sandboxed host frame without same-origin access throws on this read.
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// Player Settings are browser-local presentation preferences, not canonical runtime state.
// Stored text is external input: an unknown value falls back to the default.
export function usePlayerPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): Ref<T> {
  const storage = browserStorage();
  const value: Ref<T> = storage ? useStorage<T>(key, fallback, storage) : shallowRef(fallback);
  if (!allowed.includes(value.value)) value.value = fallback;
  return value;
}
