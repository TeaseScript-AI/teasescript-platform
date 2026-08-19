import type { PlayerToolColumnState } from "./model.js";

type LayoutDebugKey =
  | "grid"
  | "regions"
  | "reserves"
  | "safe-areas"
  | "overflow"
  | "constraints"
  | "viewport-offsets";

interface LayoutDebugOverlay {
  readonly root: HTMLElement;
  readonly gridLayer: HTMLElement;
  readonly regionLayer: HTMLElement;
  readonly reserveLayer: HTMLElement;
  readonly overflowLayer: HTMLElement;
  readonly safeLayer: HTMLElement;
  readonly safeTop: HTMLElement;
  readonly safeRight: HTMLElement;
  readonly safeBottom: HTMLElement;
  readonly safeLeft: HTMLElement;
}

interface LayoutDebugElements {
  readonly player: HTMLElement;
  readonly toolStrip: HTMLElement;
  readonly toolStripScroll: HTMLElement;
  readonly titleControls: HTMLElement;
  readonly leftPanel: HTMLElement;
  readonly mediaArea: HTMLElement;
  readonly transcript: HTMLElement;
  readonly composer: HTMLElement;
  readonly rightZone: HTMLElement;
  readonly actions: HTMLElement;
  readonly timerList: HTMLElement;
}

export interface LayoutDebugController {
  setOption(key: string, enabled: boolean): void;
  sync(): void;
  queueSync(): void;
}

export function createLayoutDebugController(
  elements: LayoutDebugElements,
  getToolColumns: () => readonly PlayerToolColumnState[],
): LayoutDebugController {
  const {
    player,
    toolStrip,
    toolStripScroll,
    titleControls,
    leftPanel,
    mediaArea,
    transcript,
    composer,
    rightZone,
    actions,
    timerList,
  } = elements;
  const narrowScreen = window.matchMedia("(max-width: 760px)");
  const compactScreen = window.matchMedia("(max-width: 480px)");
  const lowHeightScreen = window.matchMedia("(max-height: 600px)");
  const landscapeScreen = window.matchMedia("(orientation: landscape)");
  const composerInput = requireComposerInput(composer);

  const options: Record<LayoutDebugKey, boolean> = {
    grid: true,
    regions: true,
    reserves: true,
    "safe-areas": true,
    overflow: true,
    constraints: true,
    "viewport-offsets": true,
  };
  const overlay = createLayoutDebugOverlay();
  let syncQueued = false;

  player.append(overlay.root);

  const controller: LayoutDebugController = {
    setOption(key: string, enabled: boolean): void {
      if (!isLayoutDebugKey(key)) {
        throw new Error(`Unknown layout debug option: ${key}`);
      }
      options[key] = enabled;
      sync();
    },
    sync,
    queueSync,
  };

  const observer = new ResizeObserver(queueSync);
  for (const element of [
    player,
    leftPanel,
    toolStripScroll,
    mediaArea,
    transcript,
    composer,
    composerInput,
    rightZone,
    actions,
    timerList,
  ]) {
    observer.observe(element);
  }
  window.visualViewport?.addEventListener("resize", queueSync);
  window.visualViewport?.addEventListener("scroll", queueSync);
  document.addEventListener("scroll", queueSync, true);
  document.addEventListener("fullscreenchange", queueSync);
  composerInput.addEventListener("input", queueSync);

  return controller;

  function queueSync(): void {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      sync();
    });
  }

  function sync(): void {
    const debugToolOpen = getToolColumns().some((column) => column.toolId === "layout-debug");
    overlay.root.hidden = !debugToolOpen;

    for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-layout-debug]")) {
      const key = requiredDatasetValue(input, "layoutDebug");
      if (!isLayoutDebugKey(key)) throw new Error(`Unknown layout debug option: ${key}`);
      input.checked = options[key];
    }

    for (const section of toolStrip.querySelectorAll<HTMLElement>("[data-layout-debug-section]")) {
      const key = requiredDatasetValue(section, "layoutDebugSection");
      if (!isLayoutDebugKey(key)) throw new Error(`Unknown layout debug section: ${key}`);
      section.hidden = !options[key];
    }

    if (!debugToolOpen) return;

    const playerRect = player.getBoundingClientRect();
    const gridStyle = getComputedStyle(player);
    const columns = parseResolvedTracks(gridStyle.gridTemplateColumns);
    const rows = parseResolvedTracks(gridStyle.gridTemplateRows);

    syncGrid(playerRect, columns, rows);
    syncRegions(playerRect);
    syncReserves(playerRect, columns, rows);
    syncOverflow(playerRect);
    overlay.safeLayer.dataset.active = String(options["safe-areas"]);
    syncReadout(playerRect, columns, rows, gridStyle);
  }

  function syncGrid(
    playerRect: DOMRect,
    columns: readonly number[],
    rows: readonly number[],
  ): void {
    const layer = overlay.gridLayer;
    layer.replaceChildren();
    layer.hidden = !options.grid;
    if (layer.hidden) return;

    const outline = document.createElement("div");
    outline.className = "layout-debug-grid-outline";
    layer.append(outline);

    let x = 0;
    for (const size of columns.slice(0, -1)) {
      x += size;
      layer.append(createDebugGridLine("vertical", x));
    }

    let y = 0;
    for (const size of rows.slice(0, -1)) {
      y += size;
      layer.append(createDebugGridLine("horizontal", y));
    }

    layer.style.width = `${playerRect.width}px`;
    layer.style.height = `${playerRect.height}px`;
  }

  function syncRegions(playerRect: DOMRect): void {
    const layer = overlay.regionLayer;
    layer.replaceChildren();
    layer.hidden = !options.regions;
    if (layer.hidden) return;

    appendDebugElementBox(layer, playerRect, titleControls, "title", "title");
    appendDebugElementBox(
      layer,
      playerRect,
      leftPanel,
      "tools",
      `tools · ${effectiveLeftPresentation()}`,
    );
    appendDebugElementBox(layer, playerRect, mediaArea, "stage", "stage");
    appendDebugElementBox(layer, playerRect, transcript, "transcript", "transcript");

    const foreground = player.querySelector<HTMLElement>(
      ".foreground-controls, [data-foreground-controls]",
    );
    if (foreground !== null) {
      appendDebugElementBox(layer, playerRect, foreground, "foreground", "foreground");
    }

    appendDebugElementBox(layer, playerRect, composer, "composer", "composer");
    appendDebugElementBox(
      layer,
      playerRect,
      rightZone,
      "right",
      `right · ${effectiveRightPresentation()}`,
    );
  }

  function syncReserves(
    playerRect: DOMRect,
    columns: readonly number[],
    rows: readonly number[],
  ): void {
    const layer = overlay.reserveLayer;
    layer.replaceChildren();
    layer.hidden = !options.reserves;
    if (layer.hidden) return;

    const titleTrack = rows[0] ?? 0;
    const bodyHeight = Math.max(0, playerRect.height - titleTrack);
    const leftReserve = columns[0] ?? 0;
    const rightReserve = columns.at(-1) ?? 0;

    if (leftReserve > 0.5) {
      layer.append(createDebugBox(0, titleTrack, leftReserve, bodyHeight, "reserve-left", "left reserve"));
    }

    if (rightReserve > 0.5) {
      layer.append(
        createDebugBox(
          Math.max(0, playerRect.width - rightReserve),
          titleTrack,
          rightReserve,
          bodyHeight,
          "reserve-right",
          "right reserve",
        ),
      );
    }

    const transcriptRect = transcript.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const conversationReserve = Math.max(0, playerRect.right - transcriptRect.right);
    if (conversationReserve > rightReserve + 1) {
      layer.append(
        createDebugBox(
          transcriptRect.right - playerRect.left,
          transcriptRect.top - playerRect.top,
          conversationReserve,
          Math.max(0, composerRect.bottom - transcriptRect.top),
          "reserve-conversation",
          "conversation reserve",
        ),
      );
    }
  }

  function syncOverflow(playerRect: DOMRect): void {
    const layer = overlay.overflowLayer;
    layer.replaceChildren();
    layer.hidden = !options.overflow;
    if (layer.hidden) return;

    const owners: Array<readonly [HTMLElement, ScrollAxis, string]> = [
      [transcript, "y", "transcript"],
      [toolStripScroll, "x", "tool strip"],
      [composerInput, "y", "composer input"],
      [rightZone, "y", "right rail"],
      [actions, "y", "actions"],
    ];

    for (const [index, toolBody] of [...toolStrip.querySelectorAll<HTMLElement>(".tool-body")].entries()) {
      owners.push([toolBody, "y", `tool body ${index + 1}`]);
    }

    for (const [element, axis, label] of owners) {
      const metrics = measureScroll(element, axis);
      if (metrics.max <= 1) continue;
      appendDebugElementBox(
        layer,
        playerRect,
        element,
        "overflow",
        `${label} · +${formatPixels(metrics.max)} ${axis}`,
      );
    }
  }

  function syncReadout(
    playerRect: DOMRect,
    columns: readonly number[],
    rows: readonly number[],
    playerStyle: CSSStyleDeclaration,
  ): void {
    const visualViewport = window.visualViewport;
    const visualWidth = visualViewport?.width ?? window.innerWidth;
    const visualHeight = visualViewport?.height ?? window.innerHeight;
    const visualReduction = Math.max(0, window.innerHeight - visualHeight);
    const foreground = player.querySelector<HTMLElement>(
      ".foreground-controls, [data-foreground-controls]",
    );
    const transcriptRect = transcript.getBoundingClientRect();
    const leftReserve = columns[0] ?? 0;
    const rightReserve = columns.at(-1) ?? 0;
    const conversationReserve = Math.max(0, playerRect.right - transcriptRect.right);
    const safeTop = overlay.safeTop.getBoundingClientRect().height;
    const safeRight = overlay.safeRight.getBoundingClientRect().width;
    const safeBottom = overlay.safeBottom.getBoundingClientRect().height;
    const safeLeft = overlay.safeLeft.getBoundingClientRect().width;
    const toolBodies = [...toolStrip.querySelectorAll<HTMLElement>(".tool-body")];
    const firstToolColumn = toolStrip.querySelector<HTMLElement>(".tool-column");
    const activeStageTarget = cssCustomValue(
      playerStyle,
      lowHeightScreen.matches ? "--media-height-overlay" : "--media-height-normal",
    );

    const values: Readonly<Record<string, string>> = {
      composition: compactScreen.matches
        ? "narrow · compact"
        : narrowScreen.matches
          ? "narrow"
          : "wide",
      chrome: lowHeightScreen.matches ? "overlay chrome" : "normal",
      orientation: landscapeScreen.matches ? "landscape" : "portrait",
      "left-panel": `${currentLeftMode()} → ${effectiveLeftPresentation()}`,
      "right-panel": `${currentRightMode()} → ${effectiveRightPresentation()}`,
      fullscreen: document.fullscreenElement === null ? "inactive" : "active",
      "visual-viewport": visualReduction > 1
        ? `reduced by ${formatPixels(visualReduction)}`
        : "full height",
      "action-layout": player.dataset.actionAlignment === "viewport-center"
        ? "viewport centre"
        : "current",
      viewport: `${formatPixels(window.innerWidth)} × ${formatPixels(window.innerHeight)}`,
      "visual-viewport-size": `${formatPixels(visualWidth)} × ${formatPixels(visualHeight)} · scale ${formatScale(visualViewport?.scale ?? 1)}`,
      "grid-columns": formatTrackList(columns),
      "grid-rows": formatTrackList(rows),
      stage: formatRectSize(mediaArea.getBoundingClientRect()),
      transcript: formatRectSize(transcriptRect),
      foreground: foreground === null
        ? "not present"
        : formatRectSize(foreground.getBoundingClientRect()),
      composer: formatRectSize(composer.getBoundingClientRect()),
      tools: formatRectSize(leftPanel.getBoundingClientRect()),
      "right-zone": formatRectSize(rightZone.getBoundingClientRect()),
      reserves: `L ${formatPixels(leftReserve)} · R ${formatPixels(rightReserve)} · conversation ${formatPixels(conversationReserve)}`,
      "safe-area": `T ${formatPixels(safeTop)} · R ${formatPixels(safeRight)} · B ${formatPixels(safeBottom)} · L ${formatPixels(safeLeft)}`,
      "player-scroll": formatScrollMetrics(player, "y"),
      "transcript-scroll": formatScrollMetrics(transcript, "y"),
      "tool-strip-scroll": formatScrollMetrics(toolStripScroll, "x"),
      "tool-bodies-scroll": formatToolBodyScroll(toolBodies),
      "composer-scroll": formatScrollMetrics(composerInput, "y"),
      "right-rail-scroll": formatScrollMetrics(rightZone, "y"),
      "actions-scroll": formatScrollMetrics(actions, "y"),
      "constraint-stage": `${formatPixels(mediaArea.getBoundingClientRect().height)} measured · target ${activeStageTarget}`,
      "constraint-tool-column": firstToolColumn === null
        ? "not present"
        : `${formatPixels(firstToolColumn.getBoundingClientRect().width)} measured · target ${cssCustomValue(playerStyle, "--tool-column-width")}`,
      "constraint-conversation": `${formatPixels(transcriptRect.width)} measured · min ${cssCustomValue(playerStyle, "--conversation-min-width")} · max ${cssCustomValue(playerStyle, "--conversation-max-width")}`,
      "constraint-composer": `${formatPixels(composerInput.getBoundingClientRect().height)} measured · max ${cssCustomValue(playerStyle, "--composer-max-lines")} / ${cssCustomValue(playerStyle, "--composer-max-viewport-height")}`,
      "constraint-right-rail": `${formatPixels(rightZone.getBoundingClientRect().width)} measured · target ${cssCustomValue(playerStyle, "--right-controls-width")}`,
      "visual-offset": visualViewport === null
        ? "unsupported"
        : `x ${formatPixels(visualViewport.offsetLeft)} · y ${formatPixels(visualViewport.offsetTop)}`,
      "visual-page-origin": visualViewport === null
        ? "unsupported"
        : `x ${formatPixels(visualViewport.pageLeft)} · y ${formatPixels(visualViewport.pageTop)}`,
    };

    for (const element of toolStrip.querySelectorAll<HTMLElement>("[data-layout-debug-value]")) {
      const key = requiredDatasetValue(element, "layoutDebugValue");
      element.textContent = values[key] ?? "—";
    }
  }

  function effectiveLeftPresentation(): string {
    const mode = currentLeftMode();
    const open = mode === "open" || (mode === "auto" && !narrowScreen.matches);
    if (!open) return "closed";
    return narrowScreen.matches ? "overlay drawer" : "docked";
  }

  function effectiveRightPresentation(): string {
    const mode = currentRightMode();
    if (narrowScreen.matches) {
      return mode === "docked" ? "overlay geometry · docked backing" : "overlay";
    }
    return mode === "overlay" ? "overlay" : "docked";
  }

  function currentLeftMode(): "auto" | "closed" | "open" {
    const value = player.dataset.left;
    return value === "closed" || value === "open" ? value : "auto";
  }

  function currentRightMode(): "auto" | "docked" | "overlay" {
    const value = player.dataset.right;
    return value === "docked" || value === "overlay" ? value : "auto";
  }
}

function createLayoutDebugOverlay(): LayoutDebugOverlay {
  const root = document.createElement("div");
  root.className = "layout-debug-overlay";
  root.hidden = true;
  root.setAttribute("aria-hidden", "true");

  const gridLayer = createDebugLayer("layout-debug-grid-layer");
  const regionLayer = createDebugLayer("layout-debug-region-layer");
  const reserveLayer = createDebugLayer("layout-debug-reserve-layer");
  const overflowLayer = createDebugLayer("layout-debug-overflow-layer");
  const safeLayer = createDebugLayer("layout-debug-safe-layer");

  const safeTop = createSafeAreaEdge("top");
  const safeRight = createSafeAreaEdge("right");
  const safeBottom = createSafeAreaEdge("bottom");
  const safeLeft = createSafeAreaEdge("left");
  safeLayer.append(safeTop, safeRight, safeBottom, safeLeft);

  root.append(gridLayer, reserveLayer, regionLayer, overflowLayer, safeLayer);
  return {
    root,
    gridLayer,
    regionLayer,
    reserveLayer,
    overflowLayer,
    safeLayer,
    safeTop,
    safeRight,
    safeBottom,
    safeLeft,
  };
}

function createDebugLayer(className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function createSafeAreaEdge(edge: "top" | "right" | "bottom" | "left"): HTMLElement {
  const element = document.createElement("div");
  element.className = "layout-debug-safe-edge";
  element.dataset.edge = edge;
  return element;
}

function createDebugGridLine(axis: "vertical" | "horizontal", offset: number): HTMLElement {
  const line = document.createElement("div");
  line.className = `layout-debug-grid-line ${axis}`;
  if (axis === "vertical") {
    line.style.left = `${offset}px`;
  } else {
    line.style.top = `${offset}px`;
  }
  return line;
}

function appendDebugElementBox(
  layer: HTMLElement,
  playerRect: DOMRect,
  element: HTMLElement,
  kind: string,
  label: string,
): void {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  layer.append(
    createDebugBox(
      rect.left - playerRect.left,
      rect.top - playerRect.top,
      rect.width,
      rect.height,
      kind,
      label,
    ),
  );
}

function createDebugBox(
  left: number,
  top: number,
  width: number,
  height: number,
  kind: string,
  label: string,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "layout-debug-box";
  box.dataset.debugKind = kind;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;

  const caption = document.createElement("span");
  caption.className = "layout-debug-box-label";
  caption.textContent = label;
  box.append(caption);
  return box;
}

function parseResolvedTracks(value: string): readonly number[] {
  return [...value.matchAll(/(-?\d+(?:\.\d+)?)px/gu)]
    .map((match) => Number.parseFloat(match[1] ?? ""))
    .filter(Number.isFinite);
}

function formatRectSize(rect: DOMRect): string {
  return `${formatPixels(rect.width)} × ${formatPixels(rect.height)}`;
}

function formatTrackList(tracks: readonly number[]): string {
  return tracks.length === 0 ? "—" : tracks.map(formatPixels).join(" · ");
}

function formatPixels(value: number): string {
  return `${Math.round(value)}px`;
}

function formatScale(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "1.00";
}

type ScrollAxis = "x" | "y";

interface ScrollMetrics {
  readonly viewport: number;
  readonly content: number;
  readonly position: number;
  readonly max: number;
  readonly mode: string;
}

function measureScroll(element: HTMLElement, axis: ScrollAxis): ScrollMetrics {
  const style = getComputedStyle(element);
  const viewport = axis === "x" ? element.clientWidth : element.clientHeight;
  const content = axis === "x" ? element.scrollWidth : element.scrollHeight;
  const position = axis === "x" ? element.scrollLeft : element.scrollTop;
  const mode = axis === "x" ? style.overflowX : style.overflowY;
  return {
    viewport,
    content,
    position,
    max: Math.max(0, content - viewport),
    mode,
  };
}

function formatScrollMetrics(element: HTMLElement, axis: ScrollAxis): string {
  const metrics = measureScroll(element, axis);
  const state = metrics.max > 1
    ? `scroll ${formatPixels(metrics.position)}/${formatPixels(metrics.max)}`
    : "fits";
  return `view ${formatPixels(metrics.viewport)} · content ${formatPixels(metrics.content)} · ${metrics.mode} · ${state}`;
}

function formatToolBodyScroll(toolBodies: readonly HTMLElement[]): string {
  if (toolBodies.length === 0) return "not present";
  const metrics = toolBodies.map((element) => measureScroll(element, "y"));
  const overflowing = metrics.filter((item) => item.max > 1);
  const maxOverflow = Math.max(0, ...overflowing.map((item) => item.max));
  return overflowing.length === 0
    ? `${toolBodies.length} bodies · all fit`
    : `${overflowing.length}/${toolBodies.length} overflow · max +${formatPixels(maxOverflow)}`;
}

function cssCustomValue(style: CSSStyleDeclaration, name: string): string {
  const value = style.getPropertyValue(name).trim();
  return value.length === 0 ? "—" : value;
}

function isLayoutDebugKey(value: string): value is LayoutDebugKey {
  return value === "grid"
    || value === "regions"
    || value === "reserves"
    || value === "safe-areas"
    || value === "overflow"
    || value === "constraints"
    || value === "viewport-offsets";
}

function requireComposerInput(composer: HTMLElement): HTMLTextAreaElement {
  const input = composer.querySelector<HTMLTextAreaElement>("textarea");
  if (input === null) throw new Error("Layout Debug requires the Player composer textarea.");
  return input;
}

function requiredDatasetValue(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`Player element is missing data-${key}.`);
  }
  return value;
}
