export const LAYOUT_DEBUG_SELECTORS = {
  title: ".title-controls",
  tools: ".left-panel",
  stage: ".media-area",
  transcript: ".transcript",
  foreground: ".foreground-controls",
  composer: ".composer",
  input: ".composer textarea",
  right: "#rightZone",
  rightTimerList: "#rightZone .timer-list",
  rightActions: "#rightZone .action-scroll",
  toolStrip: ".tool-strip-scroll",
  toolBodies: ".tool-column-body",
} as const;

export type LayoutDebugRegion =
  | "player"
  | "title"
  | "tools"
  | "stage"
  | "transcript"
  | "foreground"
  | "composer"
  | "input"
  | "right";

const LAYOUT_DEBUG_REGIONS: readonly LayoutDebugRegion[] = [
  "player",
  "title",
  "tools",
  "stage",
  "transcript",
  "foreground",
  "composer",
  "input",
  "right",
];

export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface LayoutScrollMetrics {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly overflowX: number;
  readonly overflowY: number;
}

export interface LayoutGridTrack {
  readonly offset: number;
  readonly size: number;
}

export interface LayoutDebugViewport {
  readonly layoutWidth: number;
  readonly layoutHeight: number;
  readonly visualWidth: number;
  readonly visualHeight: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly pageLeft: number;
  readonly pageTop: number;
  readonly scale: number;
}

export interface LayoutDebugInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface LayoutDebugReservations {
  readonly title: number;
  readonly left: number;
  readonly right: number;
  readonly composerBottom: number;
  readonly keyboardBottom: number;
}

export interface LayoutDebugConstraints {
  readonly mediaHeight: string;
  readonly conversationMinWidth: string;
  readonly conversationMaxWidth: string;
  readonly composerMaxLines: string;
  readonly composerMaxViewportHeight: string;
  readonly usableHeight: string;
  readonly toolColumnWidth: string;
  readonly rightRailWidth: string;
}

export interface LayoutDebugComposition {
  readonly chrome: string;
  readonly left: string;
  readonly right: string;
  readonly rightBacking: string;
  readonly rightLayout: string;
  readonly keyboard: string;
  readonly keyboardGeometry: string;
  readonly fullscreen: boolean;
}

export interface LayoutDebugSnapshot {
  readonly regions: Readonly<Partial<Record<LayoutDebugRegion, LayoutRect>>>;
  readonly scroll: Readonly<Record<string, LayoutScrollMetrics>>;
  readonly scrollRects: Readonly<Record<string, LayoutRect>>;
  readonly columnTracks: readonly LayoutGridTrack[];
  readonly rowTracks: readonly LayoutGridTrack[];
  readonly viewport: LayoutDebugViewport;
  readonly safeAreas: LayoutDebugInsets;
  readonly reservations: LayoutDebugReservations;
  readonly constraints: LayoutDebugConstraints;
  readonly composition: LayoutDebugComposition;
  readonly composerFocused: boolean;
}

export interface RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ScrollLike {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export function captureRect(rect: RectLike): LayoutRect {
  return {
    x: finite(rect.x),
    y: finite(rect.y),
    width: nonNegative(rect.width),
    height: nonNegative(rect.height),
    top: finite(rect.top),
    right: finite(rect.right),
    bottom: finite(rect.bottom),
    left: finite(rect.left),
  };
}

export function captureScrollMetrics(element: ScrollLike): LayoutScrollMetrics {
  const clientWidth = nonNegative(element.clientWidth);
  const clientHeight = nonNegative(element.clientHeight);
  const scrollWidth = nonNegative(element.scrollWidth);
  const scrollHeight = nonNegative(element.scrollHeight);
  return {
    clientWidth,
    clientHeight,
    scrollWidth,
    scrollHeight,
    scrollLeft: finite(element.scrollLeft),
    scrollTop: finite(element.scrollTop),
    overflowX: Math.max(0, scrollWidth - clientWidth),
    overflowY: Math.max(0, scrollHeight - clientHeight),
  };
}

export function parseGridTracks(value: string, gap = 0): readonly LayoutGridTrack[] {
  const sizes = value
    .trim()
    .split(/\s+/u)
    .map((part) => (/^-?(?:\d+\.?\d*|\.\d+)px$/u.test(part) ? Number.parseFloat(part) : NaN));
  if (sizes.length === 0 || sizes.some((size) => !Number.isFinite(size) || size < 0)) return [];
  let offset = 0;
  return sizes.map((size) => {
    const track = { offset, size };
    offset += size + nonNegative(gap);
    return track;
  });
}

export function formatPixels(value: number): string {
  return `${Math.round(finite(value) * 10) / 10}px`;
}

export function formatRect(rect: LayoutRect | undefined): string {
  if (rect === undefined) return "not rendered";
  return `${formatPixels(rect.width)} × ${formatPixels(rect.height)} @ ${formatPixels(rect.left)}, ${formatPixels(rect.top)}`;
}

export function formatScroll(metrics: LayoutScrollMetrics | undefined): string {
  if (metrics === undefined) return "not rendered";
  return `${formatPixels(metrics.overflowX)} x / ${formatPixels(metrics.overflowY)} y; pos ${formatPixels(metrics.scrollLeft)}, ${formatPixels(metrics.scrollTop)}`;
}

export function buildDiagnosticCardLines(snapshot: LayoutDebugSnapshot): readonly string[] {
  const { viewport, composition } = snapshot;
  const lines = [
    `viewport ${formatPixels(viewport.layoutWidth)} × ${formatPixels(viewport.layoutHeight)}`,
    `visual ${formatPixels(viewport.visualWidth)} × ${formatPixels(viewport.visualHeight)} @ ${formatPixels(viewport.offsetLeft)}, ${formatPixels(viewport.offsetTop)} scale ${String(viewport.scale)}`,
    `mode ${composition.chrome}; left ${composition.left}; right ${composition.right}/${composition.rightBacking}/${composition.rightLayout}`,
    `fullscreen ${yesNo(composition.fullscreen)}; keyboard ${composition.keyboard}/${composition.keyboardGeometry}; composer focus ${yesNo(snapshot.composerFocused)}`,
  ];
  for (const region of ["player", "stage", "transcript", "foreground", "composer"] as const) {
    lines.push(`${region} ${formatRect(snapshot.regions[region])}`);
  }
  for (const name of [
    "player",
    "transcript",
    "composer",
    "tool-strip",
    "right",
    "right-timer-list",
    "right-actions",
  ] as const) {
    lines.push(`${name} scroll ${formatScroll(snapshot.scroll[name])}`);
  }
  const toolBodies = Object.entries(snapshot.scroll).filter(([name]) =>
    name.startsWith("tool-body-"),
  );
  for (const [name, metrics] of toolBodies) lines.push(`${name} scroll ${formatScroll(metrics)}`);
  return lines;
}

export function measurePlayerLayout(player: HTMLElement): LayoutDebugSnapshot {
  const style = getComputedStyle(player);
  const regionElements = {
    player,
    title: query(player, LAYOUT_DEBUG_SELECTORS.title),
    tools: query(player, LAYOUT_DEBUG_SELECTORS.tools),
    stage: query(player, LAYOUT_DEBUG_SELECTORS.stage),
    transcript: query(player, LAYOUT_DEBUG_SELECTORS.transcript),
    foreground: query(player, LAYOUT_DEBUG_SELECTORS.foreground),
    composer: query(player, LAYOUT_DEBUG_SELECTORS.composer),
    input: query(player, LAYOUT_DEBUG_SELECTORS.input),
    right: query(player, LAYOUT_DEBUG_SELECTORS.right),
  } satisfies Record<LayoutDebugRegion, HTMLElement | null>;
  const playerRect = captureRect(player.getBoundingClientRect());
  const regions: Partial<Record<LayoutDebugRegion, LayoutRect>> = {};
  for (const name of LAYOUT_DEBUG_REGIONS) {
    const element = regionElements[name];
    if (element !== null) regions[name] = captureRect(element.getBoundingClientRect());
  }

  const scroll: Record<string, LayoutScrollMetrics> = { player: captureScrollMetrics(player) };
  const scrollRects: Record<string, LayoutRect> = { player: playerRect };
  addScroll(scroll, scrollRects, "transcript", regionElements.transcript);
  addScroll(scroll, scrollRects, "composer", regionElements.input ?? regionElements.composer);
  addScroll(scroll, scrollRects, "right", regionElements.right);
  addScroll(
    scroll,
    scrollRects,
    "right-timer-list",
    query(player, LAYOUT_DEBUG_SELECTORS.rightTimerList),
  );
  addScroll(
    scroll,
    scrollRects,
    "right-actions",
    query(player, LAYOUT_DEBUG_SELECTORS.rightActions),
  );
  addScroll(scroll, scrollRects, "tool-strip", query(player, LAYOUT_DEBUG_SELECTORS.toolStrip));
  const toolBodies = player.querySelectorAll<HTMLElement>(LAYOUT_DEBUG_SELECTORS.toolBodies);
  toolBodies.forEach((element, index) =>
    addScroll(scroll, scrollRects, `tool-body-${index + 1}`, element),
  );

  const visual = window.visualViewport;
  return {
    regions,
    scroll,
    scrollRects,
    columnTracks: parseGridTracks(style.gridTemplateColumns, pixels(style.columnGap)),
    rowTracks: parseGridTracks(style.gridTemplateRows, pixels(style.rowGap)),
    viewport: {
      layoutWidth: window.innerWidth,
      layoutHeight: window.innerHeight,
      visualWidth: visual?.width ?? window.innerWidth,
      visualHeight: visual?.height ?? window.innerHeight,
      offsetLeft: visual?.offsetLeft ?? 0,
      offsetTop: visual?.offsetTop ?? 0,
      pageLeft: visual?.pageLeft ?? window.scrollX,
      pageTop: visual?.pageTop ?? window.scrollY,
      scale: visual?.scale ?? 1,
    },
    safeAreas: {
      top: propertyPixels(style, "--safe-top"),
      right: propertyPixels(style, "--safe-right"),
      bottom: propertyPixels(style, "--safe-bottom"),
      left: propertyPixels(style, "--safe-left"),
    },
    reservations: {
      title: propertyPixels(style, "--title-track"),
      left: propertyPixels(style, "--left-reserve"),
      right: propertyPixels(style, "--right-reserve"),
      composerBottom: propertyPixels(style, "--safe-bottom-reserve"),
      keyboardBottom: propertyPixels(style, "--fullscreen-keyboard-inset"),
    },
    constraints: {
      mediaHeight: property(style, "--media-height"),
      conversationMinWidth: property(style, "--conversation-min-width"),
      conversationMaxWidth: property(style, "--conversation-max-width"),
      composerMaxLines: property(style, "--composer-max-lines"),
      composerMaxViewportHeight: property(style, "--composer-effective-viewport-height"),
      usableHeight: property(style, "--player-usable-height"),
      toolColumnWidth: property(style, "--tool-column-width"),
      rightRailWidth: property(style, "--right-controls-width"),
    },
    composition: {
      chrome: data(player, "chrome"),
      left: data(player, "left"),
      right: data(player, "right"),
      rightBacking: data(player, "rightBacking"),
      rightLayout: data(player, "rightLayout"),
      keyboard: data(player, "keyboard"),
      keyboardGeometry: data(player, "keyboardGeometry"),
      fullscreen: document.fullscreenElement === player,
    },
    composerFocused:
      regionElements.input !== null && regionElements.input === document.activeElement,
  };
}

function query(player: HTMLElement, selector: string): HTMLElement | null {
  return player.querySelector<HTMLElement>(selector);
}

function addScroll(
  scroll: Record<string, LayoutScrollMetrics>,
  scrollRects: Record<string, LayoutRect>,
  name: string,
  element: HTMLElement | null,
): void {
  if (element === null) return;
  scroll[name] = captureScrollMetrics(element);
  scrollRects[name] = captureRect(element.getBoundingClientRect());
}

function property(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim() || "unset";
}

function propertyPixels(style: CSSStyleDeclaration, name: string): number {
  return pixels(style.getPropertyValue(name));
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function data(player: HTMLElement, name: string): string {
  return player.dataset[name] ?? "unset";
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function nonNegative(value: number): number {
  return Math.max(0, finite(value));
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
