import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("browser playground exposes the bounded editable workspace controls", async () => {
  const [html, browser] = await Promise.all([
    readFile(resolve(process.cwd(), "playground/index.html"), "utf8"),
    readFile(resolve(process.cwd(), "playground/browser.ts"), "utf8"),
  ]);
  for (const id of ["source-code", "source-lines", "source-panel", "player-panel", "compile", "run", "step", "reset", "reload-example", "import-source", "export-source", "refresh-workspace"]) assert.match(html, new RegExp(`id="${id}"`, "u"));
  assert.match(html, /<textarea id="source-code"/u);
  assert.match(html, /Reserved for future timer UI/u);
  assert.match(html, /future-timer-circle/u);
  assert.match(browser, /teasescript-playground-draft-v1/u);
  assert.match(browser, /compiledRevision === sourceRevision/u);
  assert.match(browser, /sourceEdited/u);
  assert.match(browser, /renderSourceLines/u);
  assert.match(browser, /new ResizeObserver/u);
  assert.match(browser, /replaceSource\(await response\.text\(\), "Repository example loaded\."[^\n]*false\)/u);
  assert.match(browser, /decodeWorkspaceSourceBytes\(await file\.arrayBuffer\(\)\)/u);
  assert.match(browser, /applyResult\(data\.result, true\)/u);
  assert.match(browser, /compiledRevision = null/u);
  const styles = await readFile(resolve(process.cwd(), "playground/playground.css"), "utf8");
  assert.match(styles, /\.source-editor[^}]*resize: vertical/u);
  assert.match(styles, /\.player-panel \.transcript[^}]*flex: 1 1 auto/u);
  assert.match(styles, /\.future-timer-slot[^}]*top: \.85rem/u);
  assert.match(styles, /\.player-panel > h2 \{ min-height: 3\.75rem/u);
  assert.match(styles, /\.source-panel \{ align-self: start; \}/u);
  const helper = await readFile(resolve(process.cwd(), "playground/workspace.ts"), "utf8");
  assert.doesNotMatch(helper, /Buffer\.byteLength/u);
});
