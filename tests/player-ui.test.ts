import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { toggleLeftPanelMode, toggleRightPanelMode } from "../player/panel-state.js";
import { formatTimer, timerProgressPercent } from "../player/render.js";
import {
  addToolColumn,
  closeToolColumn,
  ensureToolColumn,
  selectToolColumn,
} from "../player/tool-columns.js";

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

test("Player timer presentation is bounded and deterministic", () => {
  assert.equal(timerProgressPercent(161, 300), 46);
  assert.equal(timerProgressPercent(0, 300), 100);
  assert.equal(timerProgressPercent(999, 300), 0);
  assert.equal(timerProgressPercent(1, 0), 0);
  assert.equal(formatTimer(161), "2:41");
  assert.equal(formatTimer(-1), "0:00");
});

test("Player tool columns can be added, switched, duplicated, and closed independently", () => {
  const initial = [{ id: "tool-column-1", toolId: "visuals" as const }];
  const withSecond = addToolColumn(initial, "tool-column-2");
  assert.deepEqual(withSecond, [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-2", toolId: null },
  ]);

  const selected = selectToolColumn(withSecond, "tool-column-2", "visuals");
  assert.deepEqual(selected, [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-2", toolId: "visuals" },
  ]);

  const switched = selectToolColumn(selected, "tool-column-1", "scene");
  assert.deepEqual(switched, [
    { id: "tool-column-1", toolId: "scene" },
    { id: "tool-column-2", toolId: "visuals" },
  ]);

  assert.deepEqual(closeToolColumn(switched, "tool-column-1"), [
    { id: "tool-column-2", toolId: "visuals" },
  ]);
});

test("Opening an empty tool panel can create its first column in one step", () => {
  const existing = [{ id: "tool-column-1", toolId: "visuals" as const }];
  assert.deepEqual(ensureToolColumn([], "tool-column-2"), [
    { id: "tool-column-2", toolId: null },
  ]);
  assert.equal(ensureToolColumn(existing, "tool-column-2"), existing);
});

test("Player tool column helpers reject unknown or duplicate column ids", () => {
  const columns = [{ id: "tool-column-1", toolId: "visuals" as const }];
  assert.throws(() => addToolColumn(columns, "tool-column-1"), /Duplicate Player tool column/u);
  assert.throws(() => selectToolColumn(columns, "missing", "scene"), /Unknown Player tool column/u);
  assert.throws(() => closeToolColumn(columns, "missing"), /Unknown Player tool column/u);
});

test("Player entrypoint uses modular local assets without external runtime dependencies", async () => {
  const html = await readFile(resolve(process.cwd(), "player/index.html"), "utf8");

  assert.match(html, /viewport-fit=cover/u);
  assert.match(
    await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8"),
    /safe-area-inset-top/u,
  );
  assert.match(html, /src="\/dist\/player\/browser\.js"/u);
  assert.match(html, /href="\/player\/styles\/layout\.css"/u);
  assert.match(html, /href="\/player\/styles\/components-tools\.css"/u);
  assert.doesNotMatch(html, /id="addToolColumn"/u);
  assert.match(html, /id="toolStrip"/u);
  assert.doesNotMatch(html, /tool-panel-header/u);
  assert.doesNotMatch(html, /<style>/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test("Player application colours use centralized OKLCH primitives and semantic component tokens", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");
  const actions = await readFile(resolve(process.cwd(), "player/styles/components-right-controls.css"), "utf8");
  const tools = await readFile(resolve(process.cwd(), "player/styles/components-tools.css"), "utf8");

  assert.match(layout, /--palette-surface-base:\s*oklch\(95\.839% 0\.01306 71\.33\)/u);
  assert.match(layout, /--palette-border-strong:\s*oklch\(68\.851% 0\.04826 51\.55\)/u);
  assert.match(layout, /--color-border-default:\s*var\(--palette-border-subtle\)/u);
  assert.match(layout, /--color-border-pressed:\s*var\(--palette-border-strong\)/u);
  assert.match(actions, /\.action-button[\s\S]*border: 1px solid var\(--color-border-default\)/u);
  assert.match(tools, /\.tool-selector[\s\S]*background: var\(--color-surface-component\)/u);
  assert.doesNotMatch(actions, /var\(--palette-/u);
  assert.doesNotMatch(tools, /var\(--palette-/u);
});

test("Player tool chrome keeps one fixed column header and one vertical scroll owner", async () => {
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");
  const tools = await readFile(resolve(process.cwd(), "player/styles/components-tools.css"), "utf8");
  const visualLab = await readFile(resolve(process.cwd(), "player/styles/components-visual-lab.css"), "utf8");

  assert.match(render, /className = "tool-column-header"/u);
  assert.match(render, /add\.dataset\.toolColumnAdd = ""/u);
  assert.match(render, /header\.append\(selector, add, close\)/u);
  assert.match(tools, /grid-template-columns: minmax\(0, 1fr\) auto auto/u);
  assert.doesNotMatch(render, /lab-scroll/u);
  assert.doesNotMatch(render, /className = "lab-title"/u);
  const stripScroll = tools.match(/\.tool-strip-scroll\s*\{[^}]*\}/u)?.[0] ?? "";
  const columnBody = tools.match(/\.tool-column-body\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.doesNotMatch(stripScroll, /scrollbar-gutter:\s*stable/u);
  assert.match(columnBody, /overflow-y:\s*auto/u);
  assert.match(columnBody, /scrollbar-gutter:\s*stable/u);
  assert.doesNotMatch(visualLab, /overflow-y: auto/u);
});

test("Player tool-column add controls are local to each column", async () => {
  const html = await readFile(resolve(process.cwd(), "player/index.html"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");

  assert.doesNotMatch(html, /id="addToolColumn"/u);
  assert.doesNotMatch(html, /title-tool-column-add/u);
  assert.doesNotMatch(browser, /addToolColumnButton/u);
  assert.match(browser, /target\.closest\("\[data-tool-column-add\]"\)[\s\S]*appendToolColumn\(\)/u);
});

test("Player Actions stay in the dedicated right rail and are not tool-column content", async () => {
  const html = await readFile(resolve(process.cwd(), "player/index.html"), "utf8");
  const demo = await readFile(resolve(process.cwd(), "player/demo-session.ts"), "utf8");
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");

  assert.match(html, /id="actions"/u);
  assert.match(render, /targets\.actions\.replaceChildren/u);
  assert.doesNotMatch(demo, /\{ id: "actions", label: "Actions" \}/u);
  assert.doesNotMatch(render, /case "actions"/u);
});

test("Player media uses image content without duplicate fit or caption overlays", async () => {
  const html = await readFile(resolve(process.cwd(), "player/index.html"), "utf8");
  const demo = await readFile(resolve(process.cwd(), "player/demo-session.ts"), "utf8");
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");

  assert.match(html, /id="sceneMedia"/u);
  assert.doesNotMatch(html, /id="mediaFit"/u);
  assert.doesNotMatch(html, /id="mediaCaption"/u);
  assert.match(demo, /fit: "contain"/u);
  assert.match(render, /targets\.sceneMedia\.src/u);
});

test("Player media content can shrink to its grid row before contain fitting", async () => {
  const media = await readFile(resolve(process.cwd(), "player/styles/components-media.css"), "utf8");

  assert.match(media, /\.media-content\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/su);
  assert.match(media, /object-fit:\s*var\(--media-fit, contain\)/u);
  assert.match(media, /\.media-content\[hidden\]\s*\{[^}]*display:\s*none;/su);
});

test("Player conversation spacing is based on its own grid column", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");
  const composer = await readFile(resolve(process.cwd(), "player/styles/components-composer.css"), "utf8");

  assert.doesNotMatch(layout, /100vw - var\(--conversation-max-width\)/u);
  assert.match(layout, /calc\(\(100% - var\(--conversation-max-width\)\) \/ 2 \+ var\(--conversation-gap\)\)/u);
  assert.match(composer, /width: min\(100%, var\(--conversation-max-width\)\)/u);
  assert.match(layout, /\.composer \{[\s\S]*background: var\(--color-surface-canvas\)/u);
  assert.doesNotMatch(layout, /\.composer \{[\s\S]*border-top:/u);
});

test("Player composer preserves desktop shell focus and separate mobile controls", async () => {
  const composer = await readFile(resolve(process.cwd(), "player/styles/components-composer.css"), "utf8");
  const effects = await readFile(resolve(process.cwd(), "player/styles/effects.css"), "utf8");
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  assert.match(composer, /\.composer form[\s\S]*border: 1px solid var\(--color-border-default\)[\s\S]*background: var\(--color-surface-component\)/u);
  assert.match(composer, /textarea[\s\S]*border: 0;[\s\S]*background: transparent/u);
  assert.doesNotMatch(composer, /textarea:focus-visible/u);
  assert.match(effects, /\.composer form:has\(textarea:focus-visible\)[\s\S]*outline: 2px solid var\(--color-accent-focus\)/u);
  assert.match(effects, /\.composer form:has\(textarea:not\(:disabled\):hover\)[\s\S]*border-color: var\(--color-border-hover\)/u);
  assert.match(effects, /\.composer form:has\(textarea:not\(:disabled\):active\)[\s\S]*border-color: var\(--color-border-pressed\)/u);
  assert.match(effects, /\.composer form:has\(textarea:disabled\)[\s\S]*background: var\(--color-surface-disabled\)/u);
  assert.match(responsive, /@media \(max-width: 760px\)[\s\S]*\.composer form \{[\s\S]*border: 0;[\s\S]*background: transparent;/u);
  assert.match(responsive, /\.composer textarea \{[\s\S]*border: 1px solid var\(--color-border-default\);[\s\S]*background: var\(--color-surface-component\)/u);
  assert.match(responsive, /\.composer textarea:not\(:disabled\):active[\s\S]*border-color: var\(--color-border-pressed\)/u);
  assert.match(responsive, /\.composer textarea:disabled[\s\S]*background: var\(--color-surface-disabled\)/u);
});

test("Player overlay Actions keep translucent default, hover, and pressed fills", async () => {
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  assert.match(responsive, /\.player\[data-right="overlay"\] \.action-button \{[\s\S]*var\(--color-surface-component\) 60%/u);
  assert.match(responsive, /var\(--color-component-hover\) 60%/u);
  assert.match(responsive, /var\(--color-component-pressed\) 60%/u);
});

test("Player right background toggle keeps conversation geometry stable", async () => {
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  assert.match(responsive, /@media \(min-width: 761px\)[\s\S]*\.player\[data-right="overlay"\] \{[\s\S]*--right-track: var\(--right-controls-width\)/u);
  assert.match(responsive, /@media \(max-width: 760px\)[\s\S]*\.player\[data-right="auto"\],[\s\S]*\.player\[data-right="docked"\],[\s\S]*\.player\[data-right="overlay"\][\s\S]*--right-track: 0px/u);
});

test("Player narrow drawer remains opaque and timer compaction is height-driven", async () => {
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  assert.match(responsive, /--mobile-drawer-width:/u);
  assert.match(responsive, /background: var\(--color-surface-chrome\);/u);
  assert.match(responsive, /background: var\(--color-structural-scrim\);/u);
  assert.doesNotMatch(responsive, /--control-padding:/u);
  assert.match(responsive, /@media \(max-height: 600px\)[\s\S]*\.timer-cluster \.timer \{[\s\S]*inline-size: 34px;[\s\S]*border-radius: 50%;/u);
  assert.doesNotMatch(responsive, /\.timer::before \{[\s\S]*content: none;/u);

  const overlayBreakpoint = responsive.indexOf("@media (max-width: 760px) {");
  const compactBreakpoint = responsive.indexOf("@media (max-width: 480px) {");
  assert.ok(overlayBreakpoint >= 0 && compactBreakpoint > overlayBreakpoint);
  const overlayOnlyRules = responsive.slice(overlayBreakpoint, compactBreakpoint);
  assert.doesNotMatch(overlayOnlyRules, /\.timer-wrap\s*\{/u);
  assert.doesNotMatch(overlayOnlyRules, /\.timer-cluster \.timer\s*\{[^}]*inline-size/u);
});

test("Player chrome roles and restrained Penpot elevation stay on structural shells", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");
  const tools = await readFile(resolve(process.cwd(), "player/styles/components-tools.css"), "utf8");
  const visualLab = await readFile(resolve(process.cwd(), "player/styles/components-visual-lab.css"), "utf8");
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");

  assert.match(layout, /\.title-bg[\s\S]*box-shadow: 0 2px 6px var\(--color-structural-shadow\)/u);
  assert.match(layout, /\.left-panel[\s\S]*box-shadow: 3px 0 8px var\(--color-structural-shadow\)/u);
  assert.match(layout, /\.right-zone[\s\S]*box-shadow: -3px 0 8px var\(--color-structural-shadow\)/u);
  assert.doesNotMatch(layout, /1px 0 0 var\(--color-border-default\) inset/u);
  assert.match(layout, /\.player\[data-right="overlay"\] \.right-zone[\s\S]*box-shadow: none/u);

  assert.match(tools, /\.tool-column-header[\s\S]*background: transparent/u);
  assert.match(tools, /\.tool-selector[\s\S]*background: var\(--color-surface-component\)/u);
  assert.match(visualLab, /\.lab-fixed-note[\s\S]*background: var\(--color-surface-chrome\)/u);
  assert.match(visualLab, /\.lab-fixed-note-title[\s\S]*color: var\(--package-accent\)/u);
  assert.match(render, /fixedTitle\.textContent = "Always on"/u);
});

test("Player left-panel growth protects media and conversation minimums independently", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");

  assert.match(layout, /--conversation-min-width:/u);
  assert.match(layout, /--conversation-overlay-reserve:/u);
  assert.match(layout, /--primary-column-min:/u);
  assert.match(layout, /var\(--media-height\)/u);
  assert.match(layout, /var\(--conversation-min-width\)/u);
});
