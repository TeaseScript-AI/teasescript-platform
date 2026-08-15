import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { toggleLeftPanelMode, toggleRightPanelMode } from "../player/panel-state.js";
import { formatTimer, timerProgressPercent } from "../player/render.js";
import { addToolColumn, closeToolColumn, selectToolColumn } from "../player/tool-columns.js";

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
  assert.doesNotMatch(html, /<style>/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});
