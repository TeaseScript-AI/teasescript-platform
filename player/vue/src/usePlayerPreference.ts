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
// Stored text is external input, including writes from other tabs: every read maps an
// unknown value to the default.
export function usePlayerPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): Ref<T> {
  const storage = browserStorage();
  if (!storage) return shallowRef(fallback);
  return useStorage<T>(key, fallback, storage, {
    serializer: {
      read: (raw) => allowed.find((value) => value === raw) ?? fallback,
      write: (value) => value,
    },
  });
}
