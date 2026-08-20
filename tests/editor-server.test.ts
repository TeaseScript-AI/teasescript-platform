import assert from "node:assert/strict";
import test from "node:test";

import { EDITOR_POC_DEFAULT_SOURCE } from "../editor/browser.js";
import { startEditorServer } from "../editor/server.js";
import { compileSource } from "../src/compiler.js";

test("editor POC serves its own page, compiled integration, and local Monaco assets", async () => {
  const server = await startEditorServer({ port: 0 });
  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const origin = `http://127.0.0.1:${address.port}`;

    const [page, browserModule, loader, editorMain] = await Promise.all([
      fetch(`${origin}/editor/`),
      fetch(`${origin}/dist/editor/browser.js`),
      fetch(`${origin}/monaco/vs/loader.js`),
      fetch(`${origin}/monaco/vs/editor/editor.main.js`),
    ]);
    assert.equal(page.status, 200);
    assert.equal(browserModule.status, 200);
    assert.equal(loader.status, 200);
    assert.equal(editorMain.status, 200);

    const html = await page.text();
    assert.match(html, /\/monaco\/vs\/loader\.js/u);
    assert.match(html, /\/dist\/editor\/browser\.js/u);
    assert.doesNotMatch(html, /https?:\/\//u);

    const traversal = await fetch(`${origin}/dist/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
  }
});


test("editor POC default document is valid current TeaseScript", () => {
  const result = compileSource(EDITOR_POC_DEFAULT_SOURCE);
  assert.equal(result.plan === null, false);
  assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
});
