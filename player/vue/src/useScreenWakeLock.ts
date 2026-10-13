import { tryOnScopeDispose, useEventListener } from "@vueuse/core";
import { watch } from "vue";

/**
 * Keeps the screen on while `playing` holds (PLAYER-UI "Session start and user activation"): the browser's screen wake
 * lock is requested when `playing` begins, again whenever the page becomes visible, as the browser releases it with a
 * hidden page, and released when `playing` ends or the calling scope does. Where the browser has no wake lock or refuses
 * one, nothing else changes.
 */
export function useScreenWakeLock(playing: () => boolean): void {
  let wanted = false;
  let sentinel: WakeLockSentinel | null = null;
  // One request at a time; a request meanwhile, such as the page becoming visible again, is made once it settled.
  let requesting = false;
  let again = false;

  function acquire() {
    if (!wanted || (sentinel !== null && !sentinel.released) || !("wakeLock" in navigator)) return;
    if (document.visibilityState === "hidden") return;
    if (requesting) {
      again = true;
      return;
    }
    requesting = true;
    navigator.wakeLock
      .request("screen")
      .then(
        (granted) => {
          // Granted after playing ended: not kept.
          if (wanted) sentinel = granted;
          else void granted.release();
        },
        // Refused, for example on low battery: play goes on as without a wake lock.
        () => {},
      )
      .finally(() => {
        requesting = false;
        if (!again) return;
        again = false;
        acquire();
      });
  }

  function release() {
    const held = sentinel;
    sentinel = null;
    if (held !== null && !held.released) void held.release();
  }

  watch(
    playing,
    (now) => {
      wanted = now;
      if (now) acquire();
      else release();
    },
    { immediate: true },
  );
  useEventListener(
    () => (typeof document === "undefined" ? undefined : document),
    "visibilitychange",
    acquire,
  );
  tryOnScopeDispose(() => {
    wanted = false;
    release();
  });
}
