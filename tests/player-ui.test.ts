import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { toggleLeftPanelMode, toggleRightPanelMode } from "../player/panel-state.js";
import { formatTimer, timerProgressPercent } from "../player/render.js";
import {
  addToolColumn,
  closeToolColumn,
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
  assert.equal(formatTimer(3599), "59:59");
  assert.equal(formatTimer(3600), "1:00:00");
  assert.equal(formatTimer(3661), "1:01:01");
  assert.equal(formatTimer(-1), "0:00");
});

test("Player tool columns prefer unused tools before deliberate blank or duplicate states", () => {
  const order = ["visuals", "scene", "layout-debug"] as const;
  const initial = [{ id: "tool-column-1", toolId: "visuals" as const }];
  const withSecond = addToolColumn(initial, "tool-column-2", order);
  assert.deepEqual(withSecond, [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-2", toolId: "scene" },
  ]);

  const withThird = addToolColumn(withSecond, "tool-column-3", order);
  assert.deepEqual(withThird, [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-2", toolId: "scene" },
    { id: "tool-column-3", toolId: "layout-debug" },
  ]);

  const withBlankFourth = addToolColumn(withThird, "tool-column-4", order);
  assert.deepEqual(withBlankFourth, [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-2", toolId: "scene" },
    { id: "tool-column-3", toolId: "layout-debug" },
    { id: "tool-column-4", toolId: null },
  ]);

  const duplicated = selectToolColumn(withBlankFourth, "tool-column-4", "visuals");
  assert.equal(duplicated[3]?.toolId, "visuals");
  assert.deepEqual(closeToolColumn(duplicated, "tool-column-2"), [
    { id: "tool-column-1", toolId: "visuals" },
    { id: "tool-column-3", toolId: "layout-debug" },
    { id: "tool-column-4", toolId: "visuals" },
  ]);
});

test("Player tool column helpers preserve the retained final column invariant", () => {
  const columns = [{ id: "tool-column-1", toolId: "visuals" as const }];
  assert.throws(
    () => addToolColumn(columns, "tool-column-1", ["visuals", "scene"]),
    /Duplicate Player tool column/u,
  );
  assert.throws(() => selectToolColumn(columns, "missing", "scene"), /Unknown Player tool column/u);
  assert.throws(() => closeToolColumn(columns, "missing"), /Unknown Player tool column/u);
  assert.throws(() => closeToolColumn(columns, "tool-column-1"), /final Player tool column/u);
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
  assert.match(html, /href="\/player\/styles\/components-layout-debug\.css"/u);
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
  assert.match(tools, /scroll-snap-type: x proximity/u);
  assert.match(tools, /inline-size: var\(--tool-column-effective-width\)/u);
  assert.match(tools, /scroll-snap-align: start/u);
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
  assert.match(
    effects,
    /\.composer form:has\(textarea:focus-visible\)[\s\S]*outline: var\(--focus-outline-width\) solid var\(--color-accent-focus\)/u,
  );
  assert.match(effects, /\.composer form:has\(textarea:not\(:disabled\):hover\)[\s\S]*border-color: var\(--color-border-hover\)/u);
  assert.match(effects, /\.composer form:has\(textarea:not\(:disabled\):active\)[\s\S]*border-color: var\(--color-border-pressed\)/u);
  assert.match(effects, /\.composer form:has\(textarea:disabled\)[\s\S]*background: var\(--color-surface-disabled\)/u);
  assert.match(responsive, /@media \(max-width: 760px\)[\s\S]*\.composer form \{[\s\S]*border: 0;[\s\S]*background: transparent;/u);
  assert.match(responsive, /\.composer textarea \{[\s\S]*border: 1px solid var\(--color-border-default\);[\s\S]*background: var\(--color-surface-component\)/u);
  assert.match(responsive, /\.composer textarea:not\(:disabled\):active[\s\S]*border-color: var\(--color-border-pressed\)/u);
  assert.match(responsive, /\.composer textarea:disabled[\s\S]*background: var\(--color-surface-disabled\)/u);
});

test("Player right controls keep the same translucent surfaces across backing modes", async () => {
  const actions = await readFile(resolve(process.cwd(), "player/styles/components-right-controls.css"), "utf8");
  const effects = await readFile(resolve(process.cwd(), "player/styles/effects.css"), "utf8");
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  assert.match(actions, /\.timer[\s\S]*var\(--color-surface-component\) 60%/u);
  assert.match(actions, /\.action-button[\s\S]*var\(--color-surface-component\) 60%/u);
  assert.match(effects, /\.action-button:not\(:disabled\):hover[\s\S]*var\(--color-component-hover\) 60%/u);
  assert.match(effects, /\.action-button:not\(:disabled\):active[\s\S]*var\(--color-component-pressed\) 60%/u);
  assert.doesNotMatch(responsive, /data-right="overlay"[^}]*\.action-button[^}]*60%/u);
});

test("Player right background toggle exposes distinct docked and overlay states", async () => {
  const base = await readFile(resolve(process.cwd(), "player/styles/components-base.css"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");

  assert.match(base, /\.right-toggle\[aria-pressed="false"\] \.panel-icon::after/u);
  assert.match(browser, /rightToggle\.setAttribute\("aria-pressed", String\(rightDocked\)\)/u);
  assert.match(browser, /rightDocked \? "Use overlay right panel background" : "Dock right panel background"/u);
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

test("Player Visual Lab exposes reversible Phase 4 geometry tuning", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");
  const composer = await readFile(resolve(process.cwd(), "player/styles/components-composer.css"), "utf8");
  const tools = await readFile(resolve(process.cwd(), "player/styles/components-tools.css"), "utf8");
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");

  assert.match(layout, /--tool-column-width: 250px/u);
  assert.match(tools, /--tool-column-effective-width: var\(--tool-column-width\)/u);
  assert.match(layout, /--media-height-normal: 62dvh/u);
  assert.match(layout, /--media-height-overlay: 64dvh/u);
  assert.match(layout, /--composer-max-lines: 6lh/u);
  assert.match(layout, /--composer-max-viewport-height: 20dvh/u);
  assert.match(layout, /--focus-outline-width: 2px/u);
  assert.match(
    composer,
    /calc\(var\(--composer-max-lines\) \+ var\(--composer-input-block-chrome\)\)/u,
  );
  assert.match(composer, /font-size: var\(--composer-font-size\)/u);
  assert.match(responsive, /--media-height: var\(--media-height-overlay\)/u);
  assert.match(render, /input\.dataset\.tuningProperty = property/u);
  assert.match(render, /"--conversation-max-width"/u);
  assert.doesNotMatch(render, /"--focus-outline-width"/u);
  assert.doesNotMatch(render, /Focus ring/u);
  assert.match(browser, /player\.style\.setProperty\(property, `\$\{input\.valueAsNumber\}\$\{unit\}`\)/u);
  assert.match(browser, /player\.style\.removeProperty\(requiredDatasetValue\(input, "tuningProperty"\)\)/u);
});


test("Player Visual Lab exposes grouped reversible Phase 4 review choices", async () => {
  const html = await readFile(resolve(process.cwd(), "player/index.html"), "utf8");
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");

  assert.match(html, /class="timer"[\s\S]*id="timer"[\s\S]*class="timer-label"[\s\S]*id="timerLabel"/u);
  assert.match(render, /"Busy Action"[\s\S]*"busy-style"[\s\S]*"Soft pulse"[\s\S]*"Slow sweep"[\s\S]*"Three dots"/u);
  assert.match(render, /"Timer label"[\s\S]*"timer-label"[\s\S]*"Inside · above"[\s\S]*"Inside · below"/u);
  assert.match(render, /"Timer count"[\s\S]*"timer-count"[\s\S]*"1 timer"[\s\S]*"4 timers"/u);
  assert.match(render, /"Action alignment"[\s\S]*"viewport-center"[\s\S]*"Viewport centre"/u);
  assert.match(render, /"Composer text"[\s\S]*"composer-font"[\s\S]*"12 px"[\s\S]*"15 px"/u);
  assert.match(render, /select\.dataset\.demoSelect = key/u);
  assert.match(browser, /busyActionDemoStyle = "off"/u);
  assert.match(browser, /timerLabelDemoPlacement = "off"/u);
  assert.match(browser, /timerCountDemo = 1/u);
  assert.match(browser, /actionAlignmentDemo = "current"/u);
  assert.match(browser, /composerFontDemo = "default"/u);
  assert.match(browser, /label\.hidden = timerLabelDemoPlacement === "off"/u);
  assert.match(browser, /player\.dataset\.demoTimerCount = String\(timerCountDemo\)/u);
});

test("Player busy Action review variants are paint-only, continuous, and reduced-motion safe", async () => {
  const actions = await readFile(resolve(process.cwd(), "player/styles/components-right-controls.css"), "utf8");
  const effects = await readFile(resolve(process.cwd(), "player/styles/effects.css"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");

  assert.match(actions, /\.action-button \{[\s\S]*position: relative/u);
  assert.match(effects, /data-busy-style="pulse"[\s\S]*animation: action-busy-pulse 2400ms ease-in-out infinite/u);
  assert.match(effects, /data-busy-style="sweep"[\s\S]*transform: translateX\(-110%\)[\s\S]*animation: action-busy-sweep 2800ms linear infinite/u);
  assert.match(effects, /@keyframes action-busy-sweep[\s\S]*translateX\(-110%\)[\s\S]*translateX\(470%\)/u);
  assert.match(effects, /data-busy-style="dots"[\s\S]*animation: action-busy-dots 2200ms ease-in-out infinite/u);
  assert.match(effects, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.action-button\[aria-busy="true"\]::after \{[\s\S]*animation: none/u);
  assert.doesNotMatch(browser, /busyActionDemoStyle[\s\S]{0,300}\.disabled\s*=/u);
});

test("Player timer-label review variants stay inside normal and compact timers", async () => {
  const actions = await readFile(resolve(process.cwd(), "player/styles/components-right-controls.css"), "utf8");
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  assert.match(actions, /\.timer\[data-label-placement="above"\],[\s\S]*\.timer\[data-label-placement="below"\][\s\S]*display: flex/u);
  assert.match(actions, /data-label-placement="above"[\s\S]*\.timer-label[\s\S]*order: 0/u);
  assert.match(actions, /data-label-placement="below"[\s\S]*\.timer-label[\s\S]*order: 1/u);
  assert.doesNotMatch(actions, /timer-cluster:has\(\.timer-label/u);
  assert.match(actions, /\.timer-list \{[\s\S]*display: grid;[\s\S]*gap: 12px/u);
  assert.match(responsive, /@media \(max-height: 600px\)[\s\S]*\.timer-list \{[\s\S]*gap: 6px/u);
  assert.match(responsive, /@media \(max-height: 600px\)[\s\S]*data-label-placement="above"[\s\S]*font-size: 10px/u);
  assert.match(responsive, /data-label-placement="below"[\s\S]*\.timer-label[\s\S]*font-size: 7px/u);
});

test("Player viewport-centred Action candidate stays centred until timer-stack collision", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");
  const actions = await readFile(resolve(process.cwd(), "player/styles/components-right-controls.css"), "utf8");
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");

  assert.match(layout, /--right-timer-stack-reserve: calc\(var\(--timer-size\) \+ 42px\)/u);
  assert.match(
    layout,
    /\.player\[data-action-alignment="viewport-center"\] \.right-zone \{[\s\S]*minmax\(var\(--right-timer-stack-reserve\), 1fr\)[\s\S]*auto[\s\S]*minmax\(0, 1fr\)[\s\S]*var\(--title-track\)/u,
  );
  assert.match(layout, /data-demo-timer-count="2"[\s\S]*--right-timer-stack-reserve/u);
  assert.match(layout, /data-demo-timer-count="4"[\s\S]*--right-timer-stack-reserve/u);
  assert.match(actions, /data-action-alignment="viewport-center"[\s\S]*\.timer-wrap \{[\s\S]*grid-row: 1/u);
  assert.match(actions, /data-action-alignment="viewport-center"[\s\S]*\.action-scroll \{[\s\S]*grid-row: 2/u);
  assert.match(responsive, /@media \(max-height: 600px\)[\s\S]*--right-timer-stack-reserve: var\(--title-height\)/u);
  assert.match(responsive, /data-demo-timer-count="4"[\s\S]*--right-timer-stack-reserve: calc\(var\(--title-height\) \+ 120px\)/u);
  assert.match(browser, /function syncDemoTimers\(\): void/u);
  assert.match(browser, /for \(let index = 2; index <= timerCountDemo; index \+= 1\)/u);
});

test("Player composer line tuning counts text lines and offers local font-size review choices", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");
  const composer = await readFile(resolve(process.cwd(), "player/styles/components-composer.css"), "utf8");
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");

  assert.match(layout, /--composer-font-size: 11px/u);
  assert.match(composer, /--composer-input-block-chrome: 22px/u);
  assert.match(composer, /calc\(var\(--composer-max-lines\) \+ var\(--composer-input-block-chrome\)\)/u);
  assert.match(responsive, /@media \(max-width: 760px\)[\s\S]*--composer-font-size: 10px/u);
  assert.match(browser, /player\.style\.setProperty\("--composer-font-size", composerFontDemo\)/u);
  assert.match(browser, /player\.style\.removeProperty\("--composer-font-size"\)/u);
});

test("Player Layout Debug exposes live development-only geometry inspection", async () => {
  const model = await readFile(resolve(process.cwd(), "player/model.ts"), "utf8");
  const demo = await readFile(resolve(process.cwd(), "player/demo-session.ts"), "utf8");
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");
  const layoutDebug = await readFile(resolve(process.cwd(), "player/layout-debug.ts"), "utf8");
  const debugCss = await readFile(resolve(process.cwd(), "player/styles/components-layout-debug.css"), "utf8");
  const playerDocs = await readFile(resolve(process.cwd(), "player/README.md"), "utf8");

  assert.match(model, /PlayerToolId = "visuals" \| "scene" \| "layout-debug"/u);
  assert.match(demo, /\{ id: "layout-debug", label: "Layout Debug" \}/u);
  assert.match(render, /case "layout-debug":[\s\S]*createLayoutDebugTool/u);
  assert.match(render, /"Grid tracks"[\s\S]*"Region bounds"[\s\S]*"Reserved regions"[\s\S]*"Safe areas"/u);
  assert.match(render, /\["Foreground", "foreground"\]/u);
  assert.match(browser, /createLayoutDebugController\([\s\S]*\(\) => toolColumns/u);
  assert.match(browser, /layoutDebug\.setOption\(requiredDatasetValue\(target, "layoutDebug"\), target\.checked\)/u);
  assert.match(layoutDebug, /const options: Record<LayoutDebugKey, boolean>/u);
  assert.match(layoutDebug, /new ResizeObserver\(queueSync\)/u);
  assert.match(layoutDebug, /getComputedStyle\(player\)[\s\S]*gridTemplateColumns[\s\S]*gridTemplateRows/u);
  assert.match(layoutDebug, /window\.visualViewport\?\.addEventListener\("resize", queueSync\)/u);
  assert.match(layoutDebug, /foreground === null[\s\S]*\? "not present"/u);
  assert.match(debugCss, /\.layout-debug-overlay \{[\s\S]*position: absolute;[\s\S]*pointer-events: none;/u);
  assert.match(debugCss, /height: var\(--safe-top\)/u);
  assert.match(debugCss, /width: var\(--safe-right\)/u);
  assert.match(playerDocs, /`Visual\s+Lab`, `Layout Debug`, and `Scene` tools/u);
});

test("Player composition changes clear temporary panel overrides", async () => {
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");
  assert.match(
    browser,
    /narrowScreen\.addEventListener\("change", \(\) => \{[\s\S]*player\.dataset\.left = "auto";[\s\S]*player\.dataset\.right = "auto";/u,
  );
  assert.match(
    browser,
    /if \(toolColumns\.length === 1\) \{[\s\S]*player\.dataset\.left = "closed";/u,
  );
});

test("Player right rail centers fitting controls and fades overflow at both edges", async () => {
  const actions = await readFile(resolve(process.cwd(), "player/styles/components-right-controls.css"), "utf8");
  assert.match(actions, /align-content: safe center/u);
  assert.match(
    actions,
    /linear-gradient\([\s\S]*transparent 0,[\s\S]*#000 18px,[\s\S]*#000 calc\(100% - 18px\),[\s\S]*transparent 100%/u,
  );
});

test("Player hover styling supports hybrid devices without primary-pointer assumptions", async () => {
  const effects = await readFile(resolve(process.cwd(), "player/styles/effects.css"), "utf8");
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");
  assert.match(effects, /@media \(any-hover: hover\)/u);
  assert.match(responsive, /@media \(any-hover: hover\)/u);
  assert.doesNotMatch(effects, /\(hover: hover\) and \(pointer: fine\)/u);
  assert.doesNotMatch(responsive, /\(hover: hover\) and \(pointer: fine\)/u);
});

test("Enabled quiet Visual Lab states do not reuse disabled semantics", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");
  const visualLab = await readFile(resolve(process.cwd(), "player/styles/components-visual-lab.css"), "utf8");
  assert.match(layout, /--color-text-quiet: var\(--palette-disabled-text\)/u);
  assert.match(visualLab, /\.lab-option-note[\s\S]*color: var\(--color-text-quiet\)/u);
  assert.match(visualLab, /\.switch-ui::after[\s\S]*background: var\(--color-text-quiet\)/u);
});

test("Player left-panel growth protects media and conversation minimums independently", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");

  assert.match(layout, /--conversation-min-width:/u);
  assert.match(layout, /--conversation-overlay-reserve:/u);
  assert.match(layout, /--primary-column-min:/u);
  assert.match(layout, /var\(--media-height\)/u);
  assert.match(layout, /var\(--conversation-min-width\)/u);
});
