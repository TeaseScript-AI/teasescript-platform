import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import type { LeftPanelMode } from "../../../model.js";
import { toggleLeftPanelMode } from "../../../panel-state.js";

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
  const leftMode = ref<LeftPanelMode>("closed");
  const chrome = ref<"normal" | "compact">("normal");
  const keyboard = ref<"closed" | "open">("closed");
  const keyboardGeometry = ref<KeyboardLayout["geometry"]>("none");
  const fullscreenActive = ref(false);
  const narrow = ref(false);
  const touchInputExpected = ref(false);
  const viewportHeightBaselines = new Map<string, number>();
  const virtualKeyboard = browserVirtualKeyboard();
  let visibleForegroundHeight = 0;
  let viewportSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const leftOpen = computed(() => isLeftPanelOpen(leftMode.value, narrow.value));

  onMounted(() => {
    window.addEventListener("resize", syncViewportTransition);
    window.addEventListener("orientationchange", syncViewportTransition);
    window.visualViewport?.addEventListener("resize", syncViewportTransition);
    window.visualViewport?.addEventListener("scroll", syncViewportTransition);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    virtualKeyboard?.addEventListener("geometrychange", syncViewportTransition);

    resizeObserver = new ResizeObserver(() => {
      syncLeftPreferredWidth();
      syncOverlayChromeMode();
    });
    const player = elements.player.value;
    for (const element of [
      player,
      player?.querySelector<HTMLElement>(".player-instruments"),
      player?.querySelector<HTMLElement>(".composer"),
      player?.querySelector<HTMLElement>(".transcript"),
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
    window.removeEventListener("resize", syncViewportTransition);
    window.removeEventListener("orientationchange", syncViewportTransition);
    window.visualViewport?.removeEventListener("resize", syncViewportTransition);
    window.visualViewport?.removeEventListener("scroll", syncViewportTransition);
    document.removeEventListener("fullscreenchange", handleFullscreenChange);
    virtualKeyboard?.removeEventListener("geometrychange", syncViewportTransition);
    resizeObserver?.disconnect();
    if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
  });

  function toggleLeft(): void {
    leftMode.value = toggleLeftPanelMode(leftMode.value, !narrow.value);
    void nextTick(() => {
      syncLeftPreferredWidth();
      syncOverlayChromeMode();
    });
  }

  function closeLeft(restoreFocus = true): void {
    leftMode.value = "closed";
    void nextTick(() => {
      syncOverlayChromeMode();
      if (restoreFocus) focusLeftToggle();
    });
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

  function handleFullscreenChange(): void {
    const player = elements.player.value;
    fullscreenActive.value = player !== null && document.fullscreenElement === player;
    syncVirtualKeyboardMode();
    syncOverlayChromeMode();
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
    const style = getComputedStyle(player);
    const workbenchWidth = Number.parseFloat(style.getPropertyValue("--tool-column-width"));
    const conversationWidth = Number.parseFloat(style.getPropertyValue("--conversation-min-width"));
    // Include both workbench gutters and conversation margins, not a device label.
    const requiredWidth =
      workbenchWidth +
      conversationWidth +
      4 * Number.parseFloat(style.getPropertyValue("--conversation-gap"));
    const compactHeight = layout.usableHeight < 540;
    const nextNarrow =
      player.clientWidth -
        (player.querySelector<HTMLElement>(".player-instruments")?.getBoundingClientRect().width ??
          0) <
        requiredWidth || compactHeight;
    leftMode.value = resolveLeftPanelModeOnNarrowTransition(
      leftMode.value,
      !narrow.value && nextNarrow,
      leftPanelOwnsFocus(),
    );
    narrow.value = nextNarrow;
    player.style.setProperty("--player-usable-height", `${layout.usableHeight}px`);
    player.style.setProperty(
      "--fullscreen-player-height",
      layout.fullscreenHeight === null ? "100dvh" : `${layout.fullscreenHeight}px`,
    );
    player.style.setProperty("--fullscreen-keyboard-inset", `${layout.fullscreenInset}px`);
    keyboard.value = layout.open ? "open" : "closed";
    keyboardGeometry.value = layout.geometry;
    chrome.value = compactHeight ? "compact" : "normal";

    player.style.setProperty(
      "--composer-effective-viewport-height",
      usableViewportLength("--composer-max-viewport-height", layout.usableHeight),
    );
    const preferredMediaHeight = Math.min(
      (player.querySelector<HTMLElement>(".media-area")?.clientWidth ?? player.clientWidth) * 0.75,
      Number.parseFloat(
        usableViewportLength(
          chrome.value === "compact" ? "--media-height-compact" : "--media-height-normal",
          layout.usableHeight,
        ),
      ),
    );
    const mediaHeight = layout.open
      ? constrainedKeyboardMediaHeight(preferredMediaHeight, layout.usableHeight)
      : constrainedNormalMediaHeight(preferredMediaHeight, layout.usableHeight);
    player.style.setProperty("--media-height", `${Math.max(0, mediaHeight)}px`);
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

  function constrainedNormalMediaHeight(preferred: number, usableHeight: number): number {
    const player = elements.player.value;
    const composer = player?.querySelector<HTMLElement>(".composer");
    const input = composer?.querySelector<HTMLTextAreaElement>("textarea");
    if (player == null || composer == null || input == null) return preferred;
    const inputStyle = getComputedStyle(input);
    const inputBudget = Math.max(
      Number.parseFloat(inputStyle.minBlockSize),
      Number.parseFloat(inputStyle.maxBlockSize),
    );
    const composerChrome =
      composer.getBoundingClientRect().height - input.getBoundingClientRect().height;
    const foreground =
      player.querySelector<HTMLElement>(".foreground-controls")?.getBoundingClientRect().height ??
      0;
    const readingReserve =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 2;
    // Reserve the input's growth budget so typing changes the transcript, not the stage.
    return Math.min(
      preferred,
      Math.max(0, usableHeight - foreground - inputBudget - composerChrome - readingReserve),
    );
  }

  function constrainedKeyboardMediaHeight(
    preferredMediaHeight: number,
    usableHeight: number,
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
    const availableConversationHeight = Math.max(
      0,
      usableHeight - composer.getBoundingClientRect().height - foregroundHeight,
    );
    const boundedTranscriptReserve = Math.min(transcriptReserve, availableConversationHeight);
    return Math.min(
      Math.max(0, preferredMediaHeight),
      Math.max(0, availableConversationHeight - boundedTranscriptReserve),
    );
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
    fullscreenActive,
    keyboard,
    keyboardGeometry,
    leftMode,
    leftOpen,
    markInputBlurred,
    markTouchInputExpected,
    narrow,
    toggleFullscreen,
    toggleLeft,
  };
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
