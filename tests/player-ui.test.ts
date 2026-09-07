import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  canDockRightRail,
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
import { allocateRightRailPaneHeights } from "../player/right-rail-layout.js";

test("Player panel toggles preserve the current auto/manual semantics", () => {
  assert.equal(toggleLeftPanelMode("auto", true), "closed");
  assert.equal(toggleLeftPanelMode("auto", false), "open");
  assert.equal(toggleLeftPanelMode("open", false), "closed");
  assert.equal(toggleLeftPanelMode("closed", true), "open");
  assert.equal(toggleRightPanelMode("auto", true), "overlay");
  assert.equal(toggleRightPanelMode("auto", false), "docked");
  assert.equal(toggleRightPanelMode("docked", false), "overlay");
  assert.equal(toggleRightPanelMode("overlay", true), "docked");
  assert.equal(canDockRightRail(1_400, 625, 190, 495, false), true);
  assert.equal(canDockRightRail(1_024, 625, 190, 492, false), false);
  assert.equal(canDockRightRail(760, 0, 190, 380, true), false);
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

test("Player right-rail allocation preserves small panes and shares contention fairly", () => {
  assert.deepEqual(allocateRightRailPaneHeights(600, 120, 180), { timers: 120, actions: 480 });
  assert.deepEqual(allocateRightRailPaneHeights(300, 240, 180), { timers: 150, actions: 150 });
});

test("Vue Player keeps shared CSS layers and the maintained route contract", async () => {
  const root = process.cwd();
  const [main, vite, layout, responsive, media, rightControls, readme] = await Promise.all([
    readFile(resolve(root, "player/vue/src/main.ts"), "utf8"),
    readFile(resolve(root, "player/vue/vite.config.ts"), "utf8"),
    readFile(resolve(root, "player/styles/layout.css"), "utf8"),
    readFile(resolve(root, "player/styles/responsive.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-media.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-right-controls.css"), "utf8"),
    readFile(resolve(root, "player/README.md"), "utf8"),
  ]);
  assert.match(vite, /base: "\/player\/"/u);
  assert.match(vite, /outDir:.*dist\/player-app/u);
  assert.match(main, /\.\.\/\.\.\/styles\/layout\.css/u);
  assert.match(layout, /--palette-surface-base:\s*oklch\(/u);
  assert.match(layout, /--color-border-default:\s*var\(--palette-border-subtle\)/u);
  assert.match(responsive, /--mobile-drawer-width/u);
  assert.match(media, /object-fit:\s*var\(--media-fit, contain\)/u);
  assert.match(
    rightControls,
    /\.action-button[\s\S]*border: 1px solid var\(--color-border-default\)/u,
  );
  assert.match(readme, /maintained Vue Player at `\/player\//u);
  assert.doesNotMatch(readme, /manual\/vanilla legacy implementation/u);
});

test("Vue Player shared CSS retains the responsive composition contracts", async () => {
  const root = process.cwd();
  const [layout, responsive, foreground, composer, tools] = await Promise.all([
    readFile(resolve(root, "player/styles/layout.css"), "utf8"),
    readFile(resolve(root, "player/styles/responsive.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-foreground.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-composer.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-tools.css"), "utf8"),
  ]);
  assert.match(layout, /\.transcript \{[\s\S]*grid-column: 2;/u);
  assert.match(foreground, /\.foreground-controls \{[\s\S]*grid-column: 2;/u);
  assert.match(layout, /\.composer \{[\s\S]*grid-column: 2;/u);
  assert.match(composer, /width: min\(100%, var\(--conversation-max-width\)\)/u);
  assert.match(responsive, /@media \(min-width: 761px\)[\s\S]*--left-grid-track:/u);
  assert.match(responsive, /@media \(max-width: 760px\)[\s\S]*--left-grid-track: 0px;/u);
  assert.doesNotMatch(responsive, /orientation:[\s\S]*right-zone/u);
  assert.match(tools, /grid-template-columns: minmax\(0, 1fr\) auto auto/u);
  assert.match(tools, /scroll-snap-type: x proximity/u);
  assert.match(tools, /\.tool-column-body\s*\{[^}]*overflow-y:\s*auto/su);
});

test("Vue Player shared CSS retains safe-area, compact-timer, and interaction states", async () => {
  const root = process.cwd();
  const [layout, responsive, effects, rightControls] = await Promise.all([
    readFile(resolve(root, "player/styles/layout.css"), "utf8"),
    readFile(resolve(root, "player/styles/responsive.css"), "utf8"),
    readFile(resolve(root, "player/styles/effects.css"), "utf8"),
    readFile(resolve(root, "player/styles/components-right-controls.css"), "utf8"),
  ]);
  assert.match(
    layout,
    /--safe-bottom:\s*env\(safe-area-inset-bottom, 0px\);[\s\S]*--safe-bottom-reserve:\s*var\(--safe-bottom\)/u,
  );
  assert.doesNotMatch(layout, /safe-area-max-inset-bottom/u);
  assert.match(
    responsive,
    /\.player\[data-compact-timers="true"\] \.timer-list \{[\s\S]*flex-direction: row;[\s\S]*overflow-x: auto;/u,
  );
  assert.match(
    effects,
    /\.action-button:not\(:disabled\):hover[\s\S]*var\(--color-component-hover\) 60%/u,
  );
  assert.match(rightControls, /\.timer[\s\S]*var\(--color-surface-component\) 60%/u);
  assert.match(rightControls, /\.action-button[\s\S]*var\(--color-surface-component\) 60%/u);
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
