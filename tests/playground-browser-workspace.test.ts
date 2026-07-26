import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("browser playground exposes the bounded editable workspace controls", async () => {
  const [html, browser] = await Promise.all([
    readFile(resolve(process.cwd(), "playground/index.html"), "utf8"),
    readFile(resolve(process.cwd(), "playground/browser.ts"), "utf8"),
  ]);
  for (const id of ["source-code", "source-lines", "compile", "run", "step", "reset", "reload-example", "import-source", "export-source", "refresh-workspace"]) assert.match(html, new RegExp(`id="${id}"`, "u"));
  assert.match(html, /<textarea id="source-code"/u);
  assert.match(browser, /teasescript-playground-draft-v1/u);
  assert.match(browser, /compiledRevision === sourceRevision/u);
  assert.match(browser, /sourceEdited/u);
  assert.match(browser, /renderSourceLines/u);
  const styles = await readFile(resolve(process.cwd(), "playground/playground.css"), "utf8");
  assert.match(styles, /\.source-editor[^}]*resize: vertical/u);
  assert.match(styles, /\.player-panel \.transcript[^}]*flex: 1 1 auto/u);
  const helper = await readFile(resolve(process.cwd(), "playground/workspace.ts"), "utf8");
  assert.doesNotMatch(helper, /Buffer\.byteLength/u);
});
