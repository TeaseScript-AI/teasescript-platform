import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import type { LeftPanelMode, RightPanelMode } from "../../../model.js";
import {
  canDockRightRail,
  toggleLeftPanelMode,
  toggleRightPanelMode,
} from "../../../panel-state.js";

interface PlayerLayoutElements {
  readonly player: Ref<HTMLElement | null>;
}

export function isLeftPanelOpen(mode: LeftPanelMode, narrow: boolean): boolean {
  return mode === "open" || (mode === "auto" && !narrow);
}

export function resolveLeftPanelModeOnNarrowTransition(
  mode: LeftPanelMode,
  enteringNarrow: boolean,
  panelOwnsFocus: boolean,
): LeftPanelMode {
  if (!enteringNarrow) return mode;
  if (mode === "auto") return panelOwnsFocus ? "open" : "auto";
  return mode === "open" && !panelOwnsFocus ? "closed" : mode;
}

interface BrowserVirtualKeyboard extends EventTarget {
  readonly boundingRect: DOMRectReadOnly;
  overlaysContent: boolean;
}

interface KeyboardLayout {
  readonly fullscreenHeight: number | null;
  readonly fullscreenInset: number;
  readonly geometry: "none" | "viewport" | "virtual-keyboard";
  readonly open: boolean;
  readonly usableHeight: number;
}

export function usePlayerLayout(elements: PlayerLayoutElements) {
  const leftMode = ref<LeftPanelMode>("auto");
  const rightMode = ref<RightPanelMode>("auto");
  const rightLayout = ref<"rail" | "stage">("stage");
  const rightBacking = ref<"docked" | "overlay">("overlay");
  const chrome = ref<"normal" | "overlay">("normal");
  const compactTimers = ref(false);
  const keyboard = ref<"closed" | "open">("closed");
  const keyboardGeometry = ref<KeyboardLayout["geometry"]>("none");
  const fullscreenActive = ref(false);
  const narrow = ref(false);
  const touchInputExpected = ref(false);
  const viewportHeightBaselines = new Map<string, number>();
  const virtualKeyboard = browserVirtualKeyboard();
  let visibleForegroundHeight = 0;
  let viewportSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let compositionFrame = 0;
  let resizeObserver: ResizeObserver | null = null;
  let narrowScreen: MediaQueryList | null = null;

  const leftOpen = computed(() => isLeftPanelOpen(leftMode.value, narrow.value));
  const rightDocked = computed(() => rightBacking.value === "docked");

  onMounted(() => {
    narrowScreen = window.matchMedia("(max-width: 760px)");
    narrow.value = narrowScreen.matches;
    narrowScreen.addEventListener("change", handleNarrowChange);
    window.addEventListener("resize", syncViewportTransition);
    window.addEventListener("orientationchange", syncViewportTransition);
    window.visualViewport?.addEventListener("resize", syncViewportTransition);
    window.visualViewport?.addEventListener("scroll", syncViewportTransition);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("keydown", handleDocumentKeydown);
    virtualKeyboard?.addEventListener("geometrychange", syncViewportTransition);

    resizeObserver = new ResizeObserver(() => {
      syncLeftPreferredWidth();
      queueRightCompositionSync();
    });
    const player = elements.player.value;
    for (const element of [
      player,
      player?.querySelector<HTMLElement>(".tool-strip"),
      player?.querySelector<HTMLElement>(".tool-strip-scroll"),
    ]) {
      if (element !== null && element !== undefined) resizeObserver.observe(element);
    }

    rememberViewportHeightBaseline();
    syncVirtualKeyboardMode();
    syncLeftPreferredWidth();
    syncOverlayChromeMode();
  });

  onBeforeUnmount(() => {
    narrowScreen?.removeEventListener("change", handleNarrowChange);
    window.removeEventListener("resize", syncViewportTransition);
    window.removeEventListener("orientationchange", syncViewportTransition);
    window.visualViewport?.removeEventListener("resize", syncViewportTransition);
    window.visualViewport?.removeEventListener("scroll", syncViewportTransition);
    document.removeEventListener("fullscreenchange", handleFullscreenChange);
    document.removeEventListener("keydown", handleDocumentKeydown);
    virtualKeyboard?.removeEventListener("geometrychange", syncViewportTransition);
    resizeObserver?.disconnect();
    if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
    if (compositionFrame !== 0) cancelAnimationFrame(compositionFrame);
  });

  function toggleLeft(): void {
    leftMode.value = toggleLeftPanelMode(leftMode.value, !narrow.value);
    void nextTick(() => {
      syncLeftPreferredWidth();
      queueRightCompositionSync();
    });
  }

  function closeLeft(): void {
    leftMode.value = "closed";
    void nextTick(() => {
      queueRightCompositionSync();
      focusLeftToggle();
    });
  }

  function toggleRight(): void {
    rightMode.value = toggleRightPanelMode(rightMode.value, rightLayout.value === "rail");
    syncRightComposition();
  }

  async function toggleFullscreen(): Promise<void> {
    const player = elements.player.value;
    if (player === null) return;
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else await player.requestFullscreen();
    } catch {
      // The browser or embedding harness can deny fullscreen.
    }
    handleFullscreenChange();
  }

  function markTouchInputExpected(): void {
    touchInputExpected.value = true;
    queueMicrotask(syncViewportTransition);
  }

  function markInputBlurred(): void {
    touchInputExpected.value = false;
    rememberViewportHeightBaseline();
    syncViewportTransition();
  }

  function handleNarrowChange(event: MediaQueryListEvent): void {
    const wasNarrow = narrow.value;
    narrow.value = event.matches;
    leftMode.value = resolveLeftPanelModeOnNarrowTransition(
      leftMode.value,
      !wasNarrow && event.matches,
      leftPanelOwnsFocus(),
    );
    syncLeftPreferredWidth();
    syncOverlayChromeMode();
  }

  function handleFullscreenChange(): void {
    const player = elements.player.value;
    fullscreenActive.value = player !== null && document.fullscreenElement === player;
    syncVirtualKeyboardMode();
    syncOverlayChromeMode();
  }

  function handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !narrow.value || leftMode.value !== "open") return;
    event.preventDefault();
    closeLeft();
  }

  function leftPanelOwnsFocus(): boolean {
    const panel = elements.player.value?.querySelector<HTMLElement>("#leftPanel");
    return panel !== null && panel !== undefined && panel.contains(document.activeElement);
  }

  function focusLeftToggle(): void {
    elements.player.value
      ?.querySelector<HTMLButtonElement>('button[aria-controls="leftPanel"]')
      ?.focus();
  }

  function syncVirtualKeyboardMode(): void {
    if (virtualKeyboard !== null) virtualKeyboard.overlaysContent = fullscreenActive.value;
  }

  function syncViewportTransition(): void {
    syncOverlayChromeMode();
    if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
    viewportSettleTimer = setTimeout(() => {
      viewportSettleTimer = null;
      syncOverlayChromeMode();
    }, 300);
  }

  function syncOverlayChromeMode(): void {
    const player = elements.player.value;
    if (player === null) return;
    const layout = resolveKeyboardLayout();
    player.style.setProperty("--player-usable-height", `${layout.usableHeight}px`);
    player.style.setProperty(
      "--fullscreen-player-height",
      layout.fullscreenHeight === null ? "100dvh" : `${layout.fullscreenHeight}px`,
    );
    player.style.setProperty("--fullscreen-keyboard-inset", `${layout.fullscreenInset}px`);
    keyboard.value = layout.open ? "open" : "closed";
    keyboardGeometry.value = layout.geometry;
    compactTimers.value = layout.usableHeight <= 600;
    chrome.value = fullscreenActive.value || layout.usableHeight <= 768 ? "overlay" : "normal";

    const preferredMediaHeight = Number.parseFloat(
      usableViewportLength(
        chrome.value === "overlay" ? "--media-height-overlay" : "--media-height-normal",
        layout.usableHeight,
      ),
    );
    const mediaHeight = layout.open
      ? constrainedKeyboardMediaHeight(
          preferredMediaHeight,
          layout.usableHeight,
          chrome.value === "overlay",
        )
      : preferredMediaHeight;
    player.style.setProperty("--media-height", `${Math.max(0, mediaHeight)}px`);
    player.style.setProperty(
      "--composer-effective-viewport-height",
      usableViewportLength("--composer-max-viewport-height", layout.usableHeight),
    );
    queueRightCompositionSync();
  }

  function resolveKeyboardLayout(): KeyboardLayout {
    const player = elements.player.value;
    const composer = player?.querySelector<HTMLElement>(".composer") ?? null;
    const input = composer?.querySelector("textarea") ?? null;
    const visualViewport = window.visualViewport;
    const viewportHeight = currentUsableViewportHeight();
    const orientation = viewportOrientation();
    const composerFocused = input !== null && document.activeElement === input;

    if (!composerFocused || !touchInputExpected.value) {
      viewportHeightBaselines.set(orientation, viewportHeight);
    }
    const softwareKeyboardExpected = composerFocused && touchInputExpected.value;
    const baselineReduction = softwareKeyboardExpected
      ? Math.max(0, (viewportHeightBaselines.get(orientation) ?? viewportHeight) - viewportHeight)
      : 0;
    const visualViewportReduction =
      softwareKeyboardExpected && visualViewport !== null
        ? Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop)
        : 0;
    const virtualKeyboardRect =
      softwareKeyboardExpected && fullscreenActive.value && virtualKeyboard !== null
        ? virtualKeyboard.boundingRect
        : null;
    const virtualKeyboardVisible =
      virtualKeyboardRect !== null &&
      virtualKeyboardRect.width > 0 &&
      virtualKeyboardRect.height > 0;
    const baselineHeight = Math.max(
      viewportHeightBaselines.get(orientation) ?? viewportHeight,
      viewportHeight,
    );
    const virtualKeyboardHeight = virtualKeyboardVisible
      ? Math.max(0, Math.min(baselineHeight, virtualKeyboardRect.height))
      : 0;
    const measuredKeyboardHeight = virtualKeyboardVisible
      ? virtualKeyboardHeight
      : Math.max(baselineReduction, visualViewportReduction);
    const measuredKeyboard = measuredKeyboardHeight > 0;
    const usableHeight = virtualKeyboardVisible
      ? Math.max(0, baselineHeight - virtualKeyboardHeight)
      : viewportHeight;

    return {
      fullscreenHeight: virtualKeyboardVisible ? baselineHeight : null,
      fullscreenInset: fullscreenActive.value && measuredKeyboard ? measuredKeyboardHeight : 0,
      geometry: virtualKeyboardVisible
        ? "virtual-keyboard"
        : measuredKeyboard
          ? "viewport"
          : "none",
      open: measuredKeyboard,
      usableHeight,
    };
  }

  function constrainedKeyboardMediaHeight(
    preferredMediaHeight: number,
    usableHeight: number,
    overlayChrome: boolean,
  ): number {
    const player = elements.player.value;
    const composer = player?.querySelector<HTMLElement>(".composer") ?? null;
    if (player === null || composer === null) return preferredMediaHeight;
    const foregroundElement = player.querySelector<HTMLElement>(".foreground-controls");
    const measuredForegroundHeight = foregroundElement?.getBoundingClientRect().height ?? 0;
    if (measuredForegroundHeight > 0) visibleForegroundHeight = measuredForegroundHeight;
    const foregroundHeight = foregroundElement === null ? 0 : visibleForegroundHeight;
    const style = getComputedStyle(player);
    const transcriptReserve = remPixelValue(style, "--keyboard-transcript-reserve");
    const titleTrackHeight = overlayChrome
      ? 0
      : (player.querySelector<HTMLElement>(".title-controls")?.getBoundingClientRect().height ?? 0);
    const availableConversationHeight = Math.max(
      0,
      usableHeight - titleTrackHeight - composer.getBoundingClientRect().height - foregroundHeight,
    );
    const boundedTranscriptReserve = Math.min(transcriptReserve, availableConversationHeight);
    return Math.min(
      Math.max(0, preferredMediaHeight),
      Math.max(0, availableConversationHeight - boundedTranscriptReserve),
    );
  }

  function queueRightCompositionSync(): void {
    if (compositionFrame !== 0) return;
    compositionFrame = requestAnimationFrame(() => {
      compositionFrame = 0;
      syncRightComposition();
    });
  }

  function syncRightComposition(): void {
    const player = elements.player.value;
    if (player === null) return;
    const style = getComputedStyle(player);
    const rightWidth = cssPixelValue(style, "--right-controls-width");
    const conversationMinimum = cssPixelValue(style, "--conversation-min-width");
    const stageMinimum = cssPixelValue(style, "--media-height");
    const hasTools = player.querySelector(".tool-strip") !== null;
    const desiredLeftWidth =
      hasTools && !narrow.value && leftMode.value !== "closed"
        ? cssPixelValue(style, "--left-preferred")
        : 0;
    rightLayout.value = canDockRightRail(
      player.clientWidth,
      desiredLeftWidth,
      rightWidth,
      Math.max(conversationMinimum, stageMinimum),
      narrow.value,
    )
      ? "rail"
      : "stage";
    rightBacking.value =
      rightMode.value === "docked" || (rightMode.value === "auto" && rightLayout.value === "rail")
        ? "docked"
        : "overlay";
  }

  function syncLeftPreferredWidth(): void {
    const player = elements.player.value;
    const panel = player?.querySelector<HTMLElement>(".left-panel") ?? null;
    const strip = player?.querySelector<HTMLElement>(".tool-strip") ?? null;
    const scroller = player?.querySelector<HTMLElement>(".tool-strip-scroll") ?? null;
    if (player === null || panel === null || strip === null || scroller === null) return;
    const stripWidth = Math.ceil(strip.getBoundingClientRect().width);
    const panelChromeWidth = Math.max(
      0,
      Math.ceil(panel.getBoundingClientRect().width - scroller.clientWidth),
    );
    player.style.setProperty("--left-preferred", `${stripWidth + panelChromeWidth}px`);
  }

  function usableViewportLength(property: string, usableHeight: number): string {
    const player = elements.player.value;
    if (player === null) return "0px";
    const raw = getComputedStyle(player).getPropertyValue(property).trim();
    if (raw.endsWith("dvh")) {
      const percent = Number.parseFloat(raw);
      if (Number.isFinite(percent)) return `${Math.max(0, (usableHeight * percent) / 100)}px`;
    }
    return raw.length > 0 ? raw : "0px";
  }

  function rememberViewportHeightBaseline(): void {
    viewportHeightBaselines.set(viewportOrientation(), currentUsableViewportHeight());
  }

  return {
    chrome,
    closeLeft,
    compactTimers,
    fullscreenActive,
    keyboard,
    keyboardGeometry,
    leftMode,
    leftOpen,
    markInputBlurred,
    markTouchInputExpected,
    rightBacking,
    rightDocked,
    rightLayout,
    rightMode,
    toggleFullscreen,
    toggleLeft,
    toggleRight,
  };
}

function cssPixelValue(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

function remPixelValue(style: CSSStyleDeclaration, property: string): number {
  const raw = style.getPropertyValue(property).trim();
  if (!raw.endsWith("rem")) return 0;
  const remValue = Number.parseFloat(raw);
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(remValue) && Number.isFinite(rootFontSize) ? remValue * rootFontSize : 0;
}

function currentUsableViewportHeight(): number {
  const visualViewport = window.visualViewport;
  return Math.max(
    0,
    visualViewport === null ? window.innerHeight : visualViewport.height + visualViewport.offsetTop,
  );
}

function viewportOrientation(): string {
  const type = window.screen.orientation?.type;
  if (type !== undefined) return type.startsWith("landscape") ? "landscape" : "portrait";
  return window.screen.width > window.screen.height ? "landscape" : "portrait";
}

function browserVirtualKeyboard(): BrowserVirtualKeyboard | null {
  // EVIDENCE: external contract: VirtualKeyboard is an optional browser extension of Navigator, and the optional property is feature-detected before use.
  const extendedNavigator = navigator as Navigator & {
    readonly virtualKeyboard?: BrowserVirtualKeyboard;
  };
  return extendedNavigator.virtualKeyboard ?? null;
}
