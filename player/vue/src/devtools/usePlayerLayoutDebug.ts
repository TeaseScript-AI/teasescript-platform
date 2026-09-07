import { onBeforeUnmount, onMounted, shallowRef, watch, type MaybeRefOrGetter } from "vue";
import { toValue } from "vue";
import {
  LAYOUT_DEBUG_SELECTORS,
  measurePlayerLayout,
  type LayoutDebugSnapshot,
} from "./layoutDebugMeasurement.js";

export function usePlayerLayoutDebug(player: MaybeRefOrGetter<HTMLElement | null>) {
  const snapshot = shallowRef<LayoutDebugSnapshot | null>(null);
  let connectedPlayer: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let frame = 0;

  function refresh(): void {
    const element = toValue(player);
    snapshot.value = element === null ? null : measurePlayerLayout(element);
  }

  function scheduleRefresh(): void {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }

  function connect(element: HTMLElement | null): void {
    disconnectPlayer();
    connectedPlayer = element;
    if (element === null) {
      snapshot.value = null;
      return;
    }
    resizeObserver = new ResizeObserver(scheduleRefresh);
    observeMeasuredElements(element);
    mutationObserver = new MutationObserver((records) => {
      const playerMutation = records.some(
        (record) =>
          !(record.target instanceof Element) ||
          record.target.closest("[data-layout-debug-overlay]") === null,
      );
      if (!playerMutation) return;
      observeMeasuredElements(element);
      scheduleRefresh();
    });
    mutationObserver.observe(element, {
      attributes: true,
      attributeFilter: [
        "class",
        "data-chrome",
        "data-keyboard",
        "data-keyboard-geometry",
        "data-left",
        "data-tools-layout",
        "data-state",
        "style",
      ],
      childList: true,
      subtree: true,
    });
    element.addEventListener("scroll", scheduleRefresh, true);
    scheduleRefresh();
  }

  function observeMeasuredElements(element: HTMLElement): void {
    resizeObserver?.disconnect();
    resizeObserver?.observe(element);
    for (const selector of Object.values(LAYOUT_DEBUG_SELECTORS)) {
      element.querySelectorAll<HTMLElement>(selector).forEach((candidate) => {
        resizeObserver?.observe(candidate);
      });
    }
  }

  function disconnectPlayer(): void {
    connectedPlayer?.removeEventListener("scroll", scheduleRefresh, true);
    connectedPlayer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
  }

  function handleViewportChange(): void {
    scheduleRefresh();
  }

  onMounted(() => {
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);
    document.addEventListener("fullscreenchange", handleViewportChange);
    document.addEventListener("focusin", handleViewportChange);
    document.addEventListener("focusout", handleViewportChange);
  });

  watch(
    () => toValue(player),
    (element) => connect(element),
    { flush: "post", immediate: true },
  );

  onBeforeUnmount(() => {
    disconnectPlayer();
    window.removeEventListener("resize", handleViewportChange);
    window.removeEventListener("orientationchange", handleViewportChange);
    window.visualViewport?.removeEventListener("resize", handleViewportChange);
    window.visualViewport?.removeEventListener("scroll", handleViewportChange);
    document.removeEventListener("fullscreenchange", handleViewportChange);
    document.removeEventListener("focusin", handleViewportChange);
    document.removeEventListener("focusout", handleViewportChange);
    if (frame !== 0) cancelAnimationFrame(frame);
  });

  return { refresh, snapshot } as const;
}
