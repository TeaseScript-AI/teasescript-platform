export const LAYOUT_DEBUG_SELECTORS = {
  instruments: ".player-instruments",
  tools: ".left-panel",
  toolColumn: ".tool-column",
  stage: ".media-area",
  transcript: ".transcript",
  foreground: ".foreground-controls",
  composer: ".composer",
  input: ".composer textarea",
  session: ".session-popover",
  timerList: ".instrument-timers .timer-list",
  sessionActions: ".session-popover .action-scroll",
  toolStrip: ".tool-strip-scroll",
  toolBodies: ".tool-column-body",
} as const;

export type LayoutDebugRegion =
  | "player"
  | "instruments"
  | "tools"
  | "toolColumn"
  | "stage"
  | "transcript"
  | "foreground"
  | "composer"
  | "input"
  | "session";

const LAYOUT_DEBUG_REGIONS: readonly LayoutDebugRegion[] = [
  "player",
  "instruments",
  "tools",
  "toolColumn",
  "stage",
  "transcript",
  "foreground",
  "composer",
  "input",
  "session",
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
  readonly instruments: number;
  readonly tools: number;
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
  readonly sessionWidth: string;
}

export interface LayoutDebugComposition {
  readonly chrome: string;
  readonly left: string;
  readonly session: string;
  readonly toolsLayout: string;
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
    `mode ${composition.chrome}; left ${composition.left}; tools ${composition.toolsLayout}; session ${composition.session}`,
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
    "session",
    "timers",
    "session-actions",
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
    instruments: query(player, LAYOUT_DEBUG_SELECTORS.instruments),
    tools: query(player, LAYOUT_DEBUG_SELECTORS.tools),
    toolColumn: query(player, LAYOUT_DEBUG_SELECTORS.toolColumn),
    stage: query(player, LAYOUT_DEBUG_SELECTORS.stage),
    transcript: query(player, LAYOUT_DEBUG_SELECTORS.transcript),
    foreground: query(player, LAYOUT_DEBUG_SELECTORS.foreground),
    composer: query(player, LAYOUT_DEBUG_SELECTORS.composer),
    input: query(player, LAYOUT_DEBUG_SELECTORS.input),
    session: query(player, LAYOUT_DEBUG_SELECTORS.session),
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
  addScroll(scroll, scrollRects, "session", regionElements.session);
  addScroll(scroll, scrollRects, "timers", query(player, LAYOUT_DEBUG_SELECTORS.timerList));
  addScroll(
    scroll,
    scrollRects,
    "session-actions",
    query(player, LAYOUT_DEBUG_SELECTORS.sessionActions),
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
      instruments: regions.instruments?.width ?? 0,
      tools: propertyPixels(style, "--left-grid-track"),
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
      sessionWidth: property(style, "--session-controls-width"),
    },
    composition: {
      chrome: data(player, "chrome"),
      left: data(player, "left"),
      session: player.querySelector(".session-trigger")?.getAttribute("data-state") ?? "absent",
      toolsLayout: data(player, "toolsLayout"),
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
