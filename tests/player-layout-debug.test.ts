import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  createLayoutDebugOptions,
  setLayoutDebugOption,
} from "../player/vue/src/devtools/layoutDebug.js";
import {
  buildDiagnosticCardLines,
  captureRect,
  captureScrollMetrics,
  formatRect,
  LAYOUT_DEBUG_SELECTORS,
  parseGridTracks,
  type LayoutDebugSnapshot,
} from "../player/vue/src/devtools/layoutDebugMeasurement.js";

test("Layout Debug options retain individual layers while the master is toggled", () => {
  const defaults = createLayoutDebugOptions();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.grid, true);
  assert.equal(defaults.viewportOffsets, true);

  const withoutGrid = setLayoutDebugOption(defaults, "grid", false);
  const enabled = setLayoutDebugOption(withoutGrid, "enabled", true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.grid, false);
  assert.equal(defaults.grid, true);
});

test("Layout Debug pure measurement helpers normalize geometry, overflow, and grid tracks", () => {
  const rect = captureRect({
    x: 10.25,
    y: 20.5,
    width: 320.75,
    height: 180.25,
    top: 20.5,
    right: 331,
    bottom: 200.75,
    left: 10.25,
  });
  assert.equal(formatRect(rect), "320.8px × 180.3px @ 10.3px, 20.5px");

  assert.deepEqual(
    captureScrollMetrics({
      clientWidth: 300,
      clientHeight: 200,
      scrollWidth: 480,
      scrollHeight: 190,
      scrollLeft: 22,
      scrollTop: 0,
    }),
    {
      clientWidth: 300,
      clientHeight: 200,
      scrollWidth: 480,
      scrollHeight: 190,
      scrollLeft: 22,
      scrollTop: 0,
      overflowX: 180,
      overflowY: 0,
    },
  );
  assert.deepEqual(parseGridTracks("300px 640.5px 190px", 8), [
    { offset: 0, size: 300 },
    { offset: 308, size: 640.5 },
    { offset: 956.5, size: 190 },
  ]);
  assert.deepEqual(parseGridTracks("300px minmax(0, 1fr)"), []);
});

test("Layout Debug card is screenshot-focused and excludes noisy composer and context fields", () => {
  const playerRect = captureRect({
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
    top: 0,
    right: 1280,
    bottom: 720,
    left: 0,
  });
  const scroll = captureScrollMetrics({
    clientWidth: 800,
    clientHeight: 200,
    scrollWidth: 800,
    scrollHeight: 420,
    scrollLeft: 0,
    scrollTop: 120,
  });
  const snapshot: LayoutDebugSnapshot = {
    regions: {
      player: playerRect,
      stage: { ...playerRect, height: 360, bottom: 360 },
      transcript: { ...playerRect, y: 360, top: 360, height: 200, bottom: 560 },
      foreground: { ...playerRect, y: 560, top: 560, height: 60, bottom: 620 },
      composer: { ...playerRect, y: 620, top: 620, height: 100, bottom: 720 },
    },
    scroll: {
      player: { ...scroll, overflowY: 0 },
      transcript: scroll,
      composer: { ...scroll, overflowY: 40 },
      "tool-strip": { ...scroll, overflowX: 240 },
      "tool-body-1": { ...scroll, overflowY: 300 },
      right: { ...scroll, overflowY: 80 },
    },
    scrollRects: {},
    columnTracks: [],
    rowTracks: [],
    viewport: {
      layoutWidth: 1280,
      layoutHeight: 720,
      visualWidth: 900,
      visualHeight: 640,
      offsetLeft: 12,
      offsetTop: 36,
      pageLeft: 12,
      pageTop: 136,
      scale: 1.25,
    },
    safeAreas: { top: 20, right: 0, bottom: 12, left: 0 },
    reservations: { instruments: 88, tools: 300, composerBottom: 12, keyboardBottom: 0 },
    constraints: {
      mediaHeight: "360px",
      conversationMinWidth: "380px",
      conversationMaxWidth: "900px",
      composerMaxLines: "96px",
      composerMaxViewportHeight: "144px",
      usableHeight: "640px",
      toolColumnWidth: "300px",
      sessionWidth: "190px",
    },
    composition: {
      chrome: "compact",
      left: "open",
      session: "open",
      toolsLayout: "docked",
      keyboard: "open",
      keyboardGeometry: "viewport",
      fullscreen: false,
    },
    composerFocused: true,
  };

  const card = buildDiagnosticCardLines(snapshot).join("\n");
  assert.match(card, /visual 900px × 640px @ 12px, 36px scale 1\.25/u);
  assert.match(card, /composer focus yes/u);
  assert.match(card, /tool-body-1 scroll/u);
  assert.doesNotMatch(card, /secure|placeholder|composer value|secret draft/iu);
});

test("Layout Debug uses the rendered Vue tool-body contract and declarative overlay ownership", async () => {
  assert.equal(LAYOUT_DEBUG_SELECTORS.toolBodies, ".tool-column-body");
  assert.equal(LAYOUT_DEBUG_SELECTORS.toolColumn, ".tool-column");
  assert.equal(LAYOUT_DEBUG_SELECTORS.timerList, ".instrument-timers .timer-list");
  assert.equal(LAYOUT_DEBUG_SELECTORS.sessionActions, ".session-popover .action-scroll");
  assert.doesNotMatch(JSON.stringify(LAYOUT_DEBUG_SELECTORS), /"\.tool-body"/u);

  const root = process.cwd();
  const [measurement, overlay, lifecycle] = await Promise.all([
    readFile(resolve(root, "player/vue/src/devtools/layoutDebugMeasurement.ts"), "utf8"),
    readFile(resolve(root, "player/vue/src/devtools/PlayerLayoutDebugOverlay.vue"), "utf8"),
    readFile(resolve(root, "player/vue/src/devtools/usePlayerLayoutDebug.ts"), "utf8"),
  ]);
  assert.match(measurement, /querySelectorAll<HTMLElement>\(LAYOUT_DEBUG_SELECTORS\.toolBodies\)/u);
  assert.match(measurement, /"timers"/u);
  assert.match(measurement, /"session-actions"/u);
  assert.match(overlay, /current\.regions\.transcript\?\.width/u);
  assert.match(overlay, /regions\.toolColumn\?\.width/u);
  assert.match(overlay, /regions\.input\?\.height/u);
  assert.match(overlay, /constraints\.toolColumnWidth/u);
  assert.match(overlay, /constraints\.sessionWidth/u);
  assert.doesNotMatch(measurement, /\.tool-body["']/u);
  assert.doesNotMatch(overlay, /appendChild|append\(|replaceChildren|innerHTML/u);
  assert.match(overlay, /pointer-events:\s*none/u);
  assert.match(lifecycle, /resizeObserver\?\.disconnect\(\)/u);
  assert.match(lifecycle, /mutationObserver\?\.disconnect\(\)/u);
  assert.match(lifecycle, /cancelAnimationFrame/u);
});
