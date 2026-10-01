import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("browser playground exposes the bounded editable workspace controls", async () => {
  const [html, browser] = await Promise.all([
    readFile(resolve(process.cwd(), "playground/index.html"), "utf8"),
    readFile(resolve(process.cwd(), "playground/browser.ts"), "utf8"),
  ]);
  const requiredElementIds = [
    "source-code",
    "source-lines",
    "source-panel",
    "player-panel",
    "compile",
    "run",
    "step",
    "reset",
    "interaction-region",
    "interaction-controls",
    "interaction-feedback",
    "composer-form",
    "composer-input",
    "composer-submit",
    "reload-example",
    "import-source",
    "export-source",
    "refresh-workspace",
  ];
  for (const id of requiredElementIds) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /<textarea id="source-code"/u);
  assert.match(html, /Reserved for future timer UI/u);
  assert.match(html, /future-timer-circle/u);
  assert.match(html, /aria-label="Player viewport"/u);
  assert.match(html, /role="alert"/u);
  assert.doesNotMatch(html, />Pause</u);
  assert.match(browser, /teasescript-playground-draft-v1/u);
  assert.match(browser, /compiledRevision === sourceRevision/u);
  assert.match(browser, /sourceEdited/u);
  assert.match(browser, /renderSourceLines/u);
  assert.match(browser, /new ResizeObserver/u);
  assert.match(
    browser,
    /replaceSource\(\s*await response\.text\(\),\s*"Repository example loaded\.",\s*PLAYGROUND_EXAMPLES\[currentExample\]\.label,\s*false,\s*\)/u,
  );
  assert.match(browser, /decodeWorkspaceSourceBytes\(await file\.arrayBuffer\(\)\)/u);
  assert.match(browser, /applyResult\(data\.result, true\)/u);
  assert.match(browser, /compiledRevision = null/u);
  const styles = await readFile(resolve(process.cwd(), "playground/playground.css"), "utf8");
  assert.match(styles, /\.source-editor[^}]*resize: vertical/u);
  assert.match(styles, /\.player-panel \.transcript[^}]*flex: 1 1 auto/u);
  assert.match(styles, /\.future-timer-slot[^}]*top: \.85rem/u);
  assert.match(styles, /\.player-panel > h2 \{\s*min-height: 3\.75rem/u);
  assert.match(styles, /\.source-panel \{ align-self: start; \}/u);
  assert.match(styles, /\.composer[^}]*grid-template-columns: minmax\(0, 1fr\) auto/u);
  assert.match(styles, /@media \(max-width: 520px\)/u);
  assert.match(styles, /\.choice-select \{ display: block; \}/u);
  const helper = await readFile(
    resolve(process.cwd(), "playground/workspace/controller.ts"),
    "utf8",
  );
  assert.doesNotMatch(helper, /Buffer\.byteLength/u);
});
