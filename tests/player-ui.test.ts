import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  canReserveSideTrack,
  toggleLeftPanelMode,
  toggleRightPanelMode,
} from "../player/panel-state.js";
import {
  formatTimer,
  orderRightControls,
  readableControlText,
  timerProgressPercent,
} from "../player/presentation.js";
import { addToolColumn, closeToolColumn, selectToolColumn } from "../player/tool-columns.js";
import { resolveStageHeight } from "../player/stage-geometry.js";

test("Player panel toggles preserve the current auto/manual semantics", () => {
  assert.equal(toggleLeftPanelMode("auto", true), "closed");
  assert.equal(toggleLeftPanelMode("auto", false), "open");
  assert.equal(toggleLeftPanelMode("open", false), "closed");
  assert.equal(toggleLeftPanelMode("closed", true), "open");
  assert.equal(toggleRightPanelMode("auto", true), "overlay");
  assert.equal(toggleRightPanelMode("auto", false), "docked");
  assert.equal(toggleRightPanelMode("docked", false), "overlay");
  assert.equal(toggleRightPanelMode("overlay", true), "docked");
});

test("Side tracks are reserved only while the protected content width survives", () => {
  // One rule serves both side regions; the tool track asks with nothing else reserved.
  assert.equal(canReserveSideTrack(1_440, 0, 320, 380), true);
  assert.equal(canReserveSideTrack(390, 0, 320, 380), false);
  // The control track asks again with the resolved tool reservation counted.
  assert.equal(canReserveSideTrack(1_440, 320, 212, 380), true);
  assert.equal(canReserveSideTrack(1_024, 640, 212, 380), false);
  assert.equal(canReserveSideTrack(972, 380, 212, 380), true);
});

test("Stage height follows the media shape between its floor, cap and real remainder", () => {
  const base = {
    availableWidth: 900,
    floor: 132,
    cap: 460,
    remainingConversationHeight: 800,
    conversationReserve: 80,
  };

  // Landscape media fits its own shape and returns the rest to the conversation.
  assert.equal(resolveStageHeight({ ...base, availableWidth: 600, aspect: 16 / 9 }), 338);
  assert.equal(resolveStageHeight({ ...base, aspect: 16 / 9 }), 460);
  // Portrait media is bounded by the cap rather than growing without limit.
  assert.equal(resolveStageHeight({ ...base, aspect: 2 / 3 }), 460);
  // An empty or very wide stage never collapses below the floor.
  assert.equal(resolveStageHeight({ ...base, availableWidth: 300, aspect: 2.2 }), 136);
  assert.equal(resolveStageHeight({ ...base, availableWidth: 0, aspect: 0 }), 132);
  // The real remainder wins, and the transcript reserve is bounded by it.
  assert.equal(
    resolveStageHeight({ ...base, aspect: 2 / 3, remainingConversationHeight: 300 }),
    220,
  );
  assert.equal(resolveStageHeight({ ...base, aspect: 2 / 3, remainingConversationHeight: 40 }), 0);
  // A cap below the floor still wins, so the Player never grows past its viewport.
  assert.equal(resolveStageHeight({ ...base, aspect: 1, cap: 90 }), 90);
});

test("Player presentation helpers remain deterministic and framework-independent", () => {
  assert.equal(timerProgressPercent(161, 300), 46);
  assert.equal(timerProgressPercent(0, 300), 100);
  assert.equal(timerProgressPercent(999, 300), 0);
  assert.equal(timerProgressPercent(1, 0), 0);
  assert.equal(formatTimer(161), "2:41");
  assert.equal(formatTimer(3599), "59:59");
  assert.equal(formatTimer(3600), "1:00:00");
  assert.equal(formatTimer(3661), "1:01:01");
  assert.equal(formatTimer(-1), "0:00");
  assert.equal(readableControlText("#ffffff"), "#000000");
  assert.equal(readableControlText("#000000"), "#ffffff");
  assert.deepEqual(
    orderRightControls([
      { kind: "status", id: "status", label: "Status", detail: "ok" },
      { kind: "action", id: "action", label: "Action", priority: 1 },
    ]).map((control) => control.id),
    ["action", "status"],
  );
});

test("Player tool columns prefer unused tools and retain the final column", () => {
  const order = ["visuals", "layout-debug", "runtime-session"] as const;
  const initial = [{ id: "tool-column-1", toolId: "visuals" as const }];
  const withSecond = addToolColumn(initial, "tool-column-2", order);
  assert.deepEqual(withSecond, [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-2", toolId: "layout-debug" },
  ]);
  const withThird = addToolColumn(withSecond, "tool-column-3", order);
  assert.equal(withThird.at(-1)?.toolId, "runtime-session");
  const duplicated = selectToolColumn(withThird, "tool-column-3", "visuals");
  assert.equal(duplicated.at(-1)?.toolId, "visuals");
  assert.deepEqual(closeToolColumn(duplicated, "tool-column-2"), [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-3", toolId: "visuals" },
  ]);
  assert.throws(
    () => addToolColumn(initial, "tool-column-1", order),
    /Duplicate Player tool column/u,
  );
  assert.throws(
    () => selectToolColumn(initial, "missing", "layout-debug"),
    /Unknown Player tool column/u,
  );
  assert.throws(() => closeToolColumn(initial, "missing"), /Unknown Player tool column/u);
  assert.throws(() => closeToolColumn(initial, "tool-column-1"), /final Player tool column/u);
});

test("Vue Player keeps shared CSS layers and the maintained route contract", async () => {
  const root = process.cwd();
  const [main, vite, cascade, theme, media, readme] = await Promise.all([
    readFile(resolve(root, "player/vue/src/main.ts"), "utf8"),
    readFile(resolve(root, "player/vue/vite.config.ts"), "utf8"),
    readFile(resolve(root, "player/styles/cascade.css"), "utf8"),
    readFile(resolve(root, "player/styles/theme.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-media.css"), "utf8"),
    readFile(resolve(root, "player/README.md"), "utf8"),
  ]);
  assert.match(vite, /base: "\/player\/"/u);
  assert.match(vite, /outDir:.*dist\/player-app/u);
  assert.match(main, /\.\.\/\.\.\/styles\/theme\.css/u);
  assert.match(main, /\.\.\/\.\.\/styles\/layout\.css/u);
  assert.match(cascade, /@layer reset, theme, layout, components, effects, responsive;/u);
  assert.match(media, /object-fit:\s*var\(--media-fit, contain\)/u);
  assert.match(readme, /maintained Vue Player at `\/player\//u);
  assert.doesNotMatch(readme, /manual\/vanilla legacy implementation/u);

  // Both themes map the same semantic roles from OKLCH primitives.
  assert.match(theme, /--palette-surface-base:\s*oklch\(/u);
  assert.match(theme, /--color-border-default:\s*var\(--palette-border-subtle\)/u);
  for (const selector of [
    /:root,\s*\.player\[data-theme="stage"\]/u,
    /\.player\[data-theme="daylight"\]/u,
  ]) {
    assert.match(theme, selector);
  }
  for (const primitive of [
    "--palette-surface-base",
    "--palette-surface-chrome",
    "--palette-surface-component",
    "--palette-text-primary",
    "--palette-accent-solid",
  ]) {
    assert.equal(
      theme.split(`${primitive}:`).length - 1,
      2,
      `${primitive} is declared by both themes`,
    );
    assert.equal(
      theme.split(`var(${primitive})`).length - 1,
      1,
      `${primitive} is mapped to its semantic role once`,
    );
  }
});

test("Vue Player shared CSS keeps one primary content column and its composition contracts", async () => {
  const root = process.cwd();
  const [layout, foreground, composer, tools, transcript] = await Promise.all([
    readFile(resolve(root, "player/styles/layout.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-foreground.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-composer.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-tools.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-transcript.css"), "utf8"),
  ]);

  // Stage, transcript, response lane and composer stay one vertical column in
  // grid-column 2; the tool track and control rail are the only side tracks.
  assert.match(layout, /\.media-area \{[\s\S]*grid-column: 2;[\s\S]*grid-row: 1;/u);
  assert.match(layout, /\.transcript \{[\s\S]*grid-column: 2;[\s\S]*grid-row: 2;/u);
  assert.match(layout, /\.foreground-controls \{[\s\S]*grid-column: 2;[\s\S]*grid-row: 4;/u);
  assert.match(layout, /\.composer \{[\s\S]*grid-column: 2;[\s\S]*grid-row: 5;/u);
  assert.match(layout, /\.left-panel \{[\s\S]*grid-column: 1;/u);
  assert.match(layout, /\.instrument-zone \{[\s\S]*grid-column: 3;/u);
  assert.match(
    layout,
    /grid-template-columns: var\(--tools-track\) minmax\(0, 1fr\) var\(--rail-track\)/u,
  );

  // The prose column keeps a readability cap while the response lane does not.
  assert.match(transcript, /inline-size: min\(100%, var\(--conversation-max-width\)\)/u);
  assert.match(composer, /width: min\(100%, var\(--conversation-max-width\)\)/u);
  assert.doesNotMatch(foreground, /--conversation-max-width/u);

  assert.match(tools, /grid-template-columns: minmax\(0, 1fr\) auto auto/u);
  assert.match(tools, /scroll-snap-type: x proximity/u);
  assert.match(tools, /\.tool-column-body\s*\{[^}]*overflow-y:\s*auto/su);
});

test("Vue Player responsive composition is constraint-driven rather than device-driven", async () => {
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  // Every responsive branch keys off a measured composition state, never a
  // viewport width, device class, or comparison screenshot size.
  assert.doesNotMatch(responsive, /@media\s*\([^)]*(?:min|max)-(?:width|height)/u);
  for (const state of [
    /\.player\[data-tools="docked"\]\[data-tools-open="true"\]/u,
    /\.player\[data-tools="drawer"\]\[data-tools-open="true"\] \.left-panel/u,
    /\.player\[data-conversation="compact"\] \.composer form/u,
    /\.player\[data-chrome="immersive"\]/u,
    /\.player\[data-compact-timers="true"\] \.timer-list \{[\s\S]*flex-direction: row;[\s\S]*overflow-x: auto;/u,
  ]) {
    assert.match(responsive, state);
  }
});

test("Vue Player shared CSS retains safe-area, instrument and interaction contracts", async () => {
  const root = process.cwd();
  const [layout, effects, rightControls, media] = await Promise.all([
    readFile(resolve(root, "player/styles/layout.css"), "utf8"),
    readFile(resolve(root, "player/styles/effects.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-right-controls.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-media.css"), "utf8"),
  ]);

  // Safe areas are derived on the Player so a host or test override propagates
  // to every dependent reservation instead of resolving once at the document root.
  assert.match(
    layout,
    /\.player \{[\s\S]*--safe-bottom:\s*env\(safe-area-inset-bottom, 0px\);[\s\S]*--safe-bottom-reserve:\s*var\(--safe-bottom\)/u,
  );
  assert.doesNotMatch(layout, /safe-area-max-inset-bottom/u);
  assert.match(layout, /\.player\[data-keyboard="open"\] \{[\s\S]*--safe-bottom-reserve: 0px;/u);

  // One control group, three geometries, no separate component per geometry.
  assert.match(rightControls, /\.player\[data-right-layout="tray"\] \.action-scroll/u);
  assert.match(rightControls, /\.instrument-sheet \{[\s\S]*--reka-popper-available-height/u);
  assert.match(rightControls, /\.player\[data-right-backing="overlay"\] \.right-control/u);

  // Timers own stage space rather than a rail pane.
  assert.match(media, /\.stage-timers \{[\s\S]*position: absolute;/u);
  assert.match(media, /\.stage-timers \{[\s\S]*pointer-events: none;/u);
  assert.match(media, /\.timer-dial \{[\s\S]*conic-gradient\([\s\S]*var\(--timer-progress\)/u);

  assert.match(effects, /\.action-button:not\(:disabled\):hover/u);
  assert.match(effects, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("Vue Player development route preserves explicit Layout Debug activation", async () => {
  const [app, smoke] = await Promise.all([
    readFile(resolve(process.cwd(), "player/vue/src/App.vue"), "utf8"),
    readFile(resolve(process.cwd(), "tools/player-browser-smoke.mjs"), "utf8"),
  ]);
  assert.match(app, /get\("layout-debug"\) === "1"/u);
  assert.match(smoke, /\/player\/\?layout-debug=1/u);
  assert.doesNotMatch(smoke, /\/player-vue\//u);
});
