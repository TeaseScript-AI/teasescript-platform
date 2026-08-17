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
  assert.match(html, /id="addToolColumn"/u);
  assert.match(html, /id="toolStrip"/u);
  assert.doesNotMatch(html, /tool-panel-header/u);
  assert.doesNotMatch(html, /<style>/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test("Player tool chrome keeps one fixed column header and one vertical scroll owner", async () => {
  const browser = await readFile(resolve(process.cwd(), "player/browser.ts"), "utf8");
  const render = await readFile(resolve(process.cwd(), "player/render.ts"), "utf8");
  const tools = await readFile(resolve(process.cwd(), "player/styles/components-tools.css"), "utf8");
  const visualLab = await readFile(resolve(process.cwd(), "player/styles/components-visual-lab.css"), "utf8");

  assert.match(render, /className = "tool-column-header"/u);
  assert.match(render, /add\.dataset\.toolColumnAdd = ""/u);
  assert.match(browser, /target\.closest<HTMLButtonElement>\("\[data-tool-column-add\]"\)[\s\S]*appendToolColumn\(\)/u);
  assert.match(browser, /addToolColumnButton\.addEventListener\("click", appendToolColumn\)/u);
  assert.match(tools, /\.player:has\(\.tool-column\) \.tool-column-add-global[\s\S]*display: none/u);
  assert.doesNotMatch(render, /lab-scroll/u);
  assert.doesNotMatch(render, /className = "lab-title"/u);
  assert.match(tools, /\.tool-column-body[\s\S]*overflow-y: auto/u);
  assert.doesNotMatch(visualLab, /overflow-y: auto/u);
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
});

test("Player narrow drawer remains opaque and timer compaction is height-driven", async () => {
  const responsive = await readFile(resolve(process.cwd(), "player/styles/responsive.css"), "utf8");

  assert.match(responsive, /--mobile-drawer-width:/u);
  assert.match(responsive, /background: var\(--side-bg\);/u);
  assert.match(responsive, /background: rgb\(56 45 42 \/ 18%\);/u);
  assert.match(responsive, /@media \(max-height: 600px\)[\s\S]*\.timer::before \{[\s\S]*content: none;/u);
});

test("Player left-panel growth protects media and conversation minimums independently", async () => {
  const layout = await readFile(resolve(process.cwd(), "player/styles/layout.css"), "utf8");

  assert.match(layout, /--conversation-min-width:/u);
  assert.match(layout, /--conversation-overlay-reserve:/u);
  assert.match(layout, /--primary-column-min:/u);
  assert.match(layout, /var\(--media-height\)/u);
  assert.match(layout, /var\(--conversation-min-width\)/u);
});
