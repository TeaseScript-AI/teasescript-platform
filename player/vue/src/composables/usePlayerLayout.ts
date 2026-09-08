import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import type { LeftPanelMode, RightPanelMode } from "../../../model.js";
import {
  canReserveSideTrack,
  toggleLeftPanelMode,
  toggleRightPanelMode,
} from "../../../panel-state.js";
import { resolveStageHeight, type StageHeightConstraints } from "../../../stage-geometry.js";

interface PlayerLayoutElements {
  readonly player: Ref<HTMLElement | null>;
}

export type PlayerRightLayout = "rail" | "sheet" | "tray";
export type PlayerToolsGeometry = "docked" | "drawer";

export function isLeftPanelOpen(mode: LeftPanelMode, toolsUseDrawer: boolean): boolean {
  return mode === "open" || (mode === "auto" && !toolsUseDrawer);
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

/*
  The conversation column becomes compact once it can no longer carry the
  comfortable presentation. The margin above the protected minimum keeps a
  window that is merely a little tight from flipping back and forth.
*/
const COMPACT_CONVERSATION_MARGIN_PX = 96;
const SHEET_HYSTERESIS_PX = 24;

export function usePlayerLayout(elements: PlayerLayoutElements) {
  const leftMode = ref<LeftPanelMode>("auto");
  const rightMode = ref<RightPanelMode>("auto");
  const rightLayout = ref<PlayerRightLayout>("tray");
  const rightBacking = ref<"docked" | "overlay">("overlay");
  const toolsGeometry = ref<PlayerToolsGeometry>("drawer");
  const conversationDensity = ref<"compact" | "regular">("regular");
  const chrome = ref<"immersive" | "normal">("normal");
  const compactTimers = ref(false);
  const keyboard = ref<"closed" | "open">("closed");
  const keyboardGeometry = ref<KeyboardLayout["geometry"]>("none");
  const fullscreenActive = ref(false);
  const sheetOpen = ref(false);
  const touchInputExpected = ref(false);
  const viewportHeightBaselines = new Map<string, number>();
  const virtualKeyboard = browserVirtualKeyboard();
  let stageAspect: number | null = null;
  let visibleForegroundHeight = 0;
  let visibleInstrumentHeight = 0;
  let viewportSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let compositionFrame = 0;
  let resizeObserver: ResizeObserver | null = null;
  let observedElements: readonly (HTMLElement | null)[] = [];

  const leftOpen = computed(() =>
    isLeftPanelOpen(leftMode.value, toolsGeometry.value === "drawer"),
  );
  const rightDocked = computed(() => rightBacking.value === "docked");

  onMounted(() => {
    window.addEventListener("resize", syncViewportTransition);
    window.addEventListener("orientationchange", syncViewportTransition);
    window.visualViewport?.addEventListener("resize", syncViewportTransition);
    window.visualViewport?.addEventListener("scroll", syncViewportTransition);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("keydown", handleDocumentKeydown);
    virtualKeyboard?.addEventListener("geometrychange", syncViewportTransition);

    resizeObserver = new ResizeObserver(queueComposition);
    syncObservedElements();

    rememberViewportHeightBaseline();
    syncVirtualKeyboardMode();
    syncComposition();
  });

  onBeforeUnmount(() => {
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

  /*
    Regions that come and go — the response lane, the control tray, the tool
    strip — must join the measured set when they appear, or the composition keeps
    solving against a region that is no longer the one on screen. Re-observing is
    skipped while the element set is unchanged, because observing an element
    fires the observer again and would otherwise loop.
  */
  function syncObservedElements(): void {
    const player = elements.player.value;
    if (player === null || resizeObserver === null) return;
    const next = [
      player,
      player.querySelector<HTMLElement>(".tool-strip"),
      player.querySelector<HTMLElement>(".tool-strip-scroll"),
      player.querySelector<HTMLElement>(".composer"),
      player.querySelector<HTMLElement>(".foreground-controls"),
      player.querySelector<HTMLElement>("#rightZone"),
      player.querySelector<HTMLElement>(".global-bar"),
    ];
    if (
      next.length === observedElements.length &&
      next.every((element, index) => element === observedElements[index])
    ) {
      return;
    }
    observedElements = next;
    resizeObserver.disconnect();
    for (const element of next) {
      if (element !== null) resizeObserver.observe(element);
    }
  }

  function toggleLeft(): void {
    leftMode.value = toggleLeftPanelMode(leftMode.value, toolsGeometry.value === "docked");
    void nextTick(syncComposition);
  }

  function closeLeft(): void {
    leftMode.value = "closed";
    void nextTick(() => {
      queueComposition();
      focusLeftToggle();
    });
  }

  function toggleRight(): void {
    rightMode.value = toggleRightPanelMode(rightMode.value, rightBacking.value === "docked");
    syncComposition();
  }

  function setSheetOpen(open: boolean): void {
    sheetOpen.value = open;
    void nextTick(syncComposition);
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

  /*
    Media aspect is captured once per session so the stage keeps a stable height
    while media appears, changes and disappears. Extreme aspects are clamped so
    one unusual asset cannot produce an unusable stage. The captured value is
    published as the live custom property, which keeps one source of truth and
    makes the resolved shape inspectable through Layout Debug.
  */
  function observeStageMedia(naturalWidth: number, naturalHeight: number): void {
    const player = elements.player.value;
    if (stageAspect !== null || player === null || naturalWidth <= 0 || naturalHeight <= 0) return;
    stageAspect = Math.min(2.2, Math.max(0.62, naturalWidth / naturalHeight));
    player.style.setProperty("--stage-aspect", String(stageAspect));
    syncComposition();
  }

  function handleFullscreenChange(): void {
    const player = elements.player.value;
    fullscreenActive.value = player !== null && document.fullscreenElement === player;
    syncVirtualKeyboardMode();
    syncComposition();
  }

  function handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (toolsGeometry.value === "drawer" && leftMode.value === "open") {
      event.preventDefault();
      closeLeft();
    }
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
    syncComposition();
    if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
    viewportSettleTimer = setTimeout(() => {
      viewportSettleTimer = null;
      syncComposition();
    }, 300);
  }

  function queueComposition(): void {
    if (compositionFrame !== 0) return;
    compositionFrame = requestAnimationFrame(() => {
      compositionFrame = 0;
      syncComposition();
    });
  }

  function syncComposition(): void {
    const player = elements.player.value;
    if (player === null) return;
    syncObservedElements();
    const style = getComputedStyle(player);
    const layout = resolveKeyboardLayout();

    player.style.setProperty("--player-usable-height", `${layout.usableHeight}px`);
    player.style.setProperty(
      "--fullscreen-player-height",
      layout.fullscreenHeight === null ? "100dvh" : `${layout.fullscreenHeight}px`,
    );
    player.style.setProperty("--fullscreen-keyboard-inset", `${layout.fullscreenInset}px`);
    player.style.setProperty(
      "--chrome-overlay-height",
      `${measuredHeight(player, ".global-bar", 0)}px`,
    );
    player.style.setProperty(
      "--composer-effective-viewport-height",
      usableViewportLength(style, "--composer-max-viewport-height", layout.usableHeight),
    );

    keyboard.value = layout.open ? "open" : "closed";
    keyboardGeometry.value = layout.geometry;
    compactTimers.value = layout.usableHeight <= 620;
    chrome.value = fullscreenActive.value || layout.usableHeight <= 720 ? "immersive" : "normal";

    syncToolStripPreference(player);
    syncSideTracks(player, style, layout.usableHeight);
    syncStageHeight(player, style, layout.usableHeight);
  }

  /*
    Side tracks are resolved from the space each one needs against the space the
    primary content column must keep. Tools claim first because a tool strip has
    no alternative geometry; the long-lived control group yields to a tray and
    then to an anchored sheet.
  */
  function syncSideTracks(
    player: HTMLElement,
    style: CSSStyleDeclaration,
    usableHeight: number,
  ): void {
    const available = player.clientWidth;
    const railWidth = cssPixelValue(style, "--rail-width");
    const conversationMinimum = cssPixelValue(style, "--conversation-min-width");
    const toolsSingle = cssPixelValue(style, "--tools-single");
    const toolsPreferred = Math.max(toolsSingle, cssPixelValue(style, "--tools-preferred"));
    const hasTools = player.querySelector(".tool-strip") !== null;

    /*
      A docked track needs room for one complete tool column, never for every
      open column: extra columns scroll inside the track rather than widening it
      past the protected conversation width.

      Manual open/closed intent survives a composition change. An open docked
      strip that becomes an overlay drawer while focus is elsewhere closes, so a
      newly overlaid drawer never covers the Player while the user is working in
      another region.
    */
    const nextToolsGeometry: PlayerToolsGeometry =
      hasTools && canReserveSideTrack(available, 0, toolsSingle, conversationMinimum)
        ? "docked"
        : "drawer";
    if (nextToolsGeometry !== toolsGeometry.value) {
      leftMode.value = resolveLeftPanelModeOnNarrowTransition(
        leftMode.value,
        toolsGeometry.value === "docked" && nextToolsGeometry === "drawer",
        leftPanelOwnsFocus(),
      );
      toolsGeometry.value = nextToolsGeometry;
    }
    const toolsReserved =
      toolsGeometry.value === "docked" && leftOpen.value
        ? Math.max(toolsSingle, Math.min(toolsPreferred, available - conversationMinimum))
        : 0;

    const railFits = canReserveSideTrack(available, toolsReserved, railWidth, conversationMinimum);
    const conversationWidth = available - toolsReserved - (railFits ? railWidth : 0);
    conversationDensity.value =
      conversationWidth < conversationMinimum + COMPACT_CONVERSATION_MARGIN_PX
        ? "compact"
        : "regular";

    rightLayout.value = railFits
      ? "rail"
      : resolveTrayOrSheet(player, style, usableHeight, rightLayout.value);
    if (rightLayout.value !== "sheet") sheetOpen.value = false;

    rightBacking.value =
      rightMode.value === "docked" || (rightMode.value === "auto" && railFits)
        ? "docked"
        : "overlay";
  }

  /*
    The tray keeps long-lived controls next to the composer while a row of them
    still leaves the conversation its reserve. Below that the same controls move
    into an anchored sheet so the stage and conversation stay usable.
  */
  function resolveTrayOrSheet(
    player: HTMLElement,
    style: CSSStyleDeclaration,
    usableHeight: number,
    current: PlayerRightLayout,
  ): PlayerRightLayout {
    /*
      Only a rendered tray measures a tray. A rail fills its whole side track, so
      its height says nothing about the row a tray would need, and a sheet is not
      in flow at all. Both fall back to the last real tray measurement, then to
      one control row plus its padding.
    */
    if (current === "tray") {
      const measured = measuredHeight(player, "#rightZone", 0);
      if (measured > 0) visibleInstrumentHeight = measured;
    } else if (visibleInstrumentHeight === 0) {
      visibleInstrumentHeight = cssPixelValue(style, "--instrument-height") + 12;
    }
    const reserve = remPixelValue(style, "--keyboard-transcript-reserve");
    const stageFloor = stageFloorHeight(style, usableHeight);
    const room =
      usableHeight -
      stageFloor -
      measuredHeight(player, ".composer", 0) -
      foregroundHeight(player) -
      visibleInstrumentHeight;
    const threshold = current === "sheet" ? reserve + SHEET_HYSTERESIS_PX : reserve;
    return room >= threshold ? "tray" : "sheet";
  }

  function syncStageHeight(
    player: HTMLElement,
    style: CSSStyleDeclaration,
    usableHeight: number,
  ): void {
    const stage = player.querySelector<HTMLElement>(".media-area");
    const stageWidth = stage === null ? player.clientWidth : stage.clientWidth;
    const constraints: StageHeightConstraints = {
      availableWidth: stageWidth,
      aspect: cssNumberValue(style, "--stage-aspect", 4 / 3),
      floor: stageFloorHeight(style, usableHeight),
      cap:
        (usableHeight *
          cssNumberValue(
            style,
            chrome.value === "immersive" ? "--stage-cap-immersive" : "--stage-cap",
            46,
          )) /
        100,
      remainingConversationHeight: Math.max(
        0,
        usableHeight -
          measuredHeight(player, ".composer", 0) -
          foregroundHeight(player) -
          instrumentRowHeight(player),
      ),
      conversationReserve: remPixelValue(style, "--keyboard-transcript-reserve"),
    };
    player.style.setProperty("--stage-height", `${resolveStageHeight(constraints)}px`);
  }

  function stageFloorHeight(style: CSSStyleDeclaration, usableHeight: number): number {
    return Math.max(
      cssPixelValue(style, "--stage-min-height"),
      (usableHeight * cssNumberValue(style, "--stage-floor", 22)) / 100,
    );
  }

  /*
    Whatever the long-lived controls put between the conversation and the
    response lane costs the same height to the stage: the tray itself while it is
    in flow, or the disclosure control that replaces it once a sheet is used.
  */
  function instrumentRowHeight(player: HTMLElement): number {
    return rightLayout.value === "tray"
      ? measuredHeight(player, "#rightZone", 0)
      : measuredHeight(player, ".instrument-disclosure", 0);
  }

  function foregroundHeight(player: HTMLElement): number {
    const element = player.querySelector<HTMLElement>(".foreground-controls");
    const measured = element?.getBoundingClientRect().height ?? 0;
    if (measured > 0) visibleForegroundHeight = measured;
    return element === null ? 0 : visibleForegroundHeight;
  }

  function syncToolStripPreference(player: HTMLElement): void {
    const panel = player.querySelector<HTMLElement>(".left-panel");
    const strip = player.querySelector<HTMLElement>(".tool-strip");
    const scroller = player.querySelector<HTMLElement>(".tool-strip-scroll");
    if (panel === null || strip === null || scroller === null) return;
    const stripWidth = Math.ceil(strip.getBoundingClientRect().width);
    if (stripWidth <= 0) return;
    const panelChromeWidth = Math.max(
      0,
      Math.ceil(panel.getBoundingClientRect().width - scroller.clientWidth),
    );
    player.style.setProperty("--tools-preferred", `${stripWidth + panelChromeWidth}px`);
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

  function usableViewportLength(
    style: CSSStyleDeclaration,
    property: string,
    usableHeight: number,
  ): string {
    const raw = style.getPropertyValue(property).trim();
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
    conversationDensity,
    fullscreenActive,
    keyboard,
    keyboardGeometry,
    leftMode,
    leftOpen,
    markInputBlurred,
    markTouchInputExpected,
    observeStageMedia,
    refreshComposition: queueComposition,
    rightBacking,
    rightDocked,
    rightLayout,
    rightMode,
    setSheetOpen,
    sheetOpen,
    toggleFullscreen,
    toggleLeft,
    toggleRight,
    toolsGeometry,
  };
}

function measuredHeight(player: HTMLElement, selector: string, fallback: number): number {
  const element = player.querySelector<HTMLElement>(selector);
  return element === null ? fallback : element.getBoundingClientRect().height;
}

function cssPixelValue(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

function cssNumberValue(style: CSSStyleDeclaration, property: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
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
