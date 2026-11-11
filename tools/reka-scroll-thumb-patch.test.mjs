import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { rekaScrollThumbPatch } from "../player/vue/reka-scroll-thumb-patch.ts";

// `player/vue/reka-scroll-thumb-patch.ts` refuses a build that bundles reka-ui without patching its ScrollAreaThumb. The
// development server's dependency scan runs the plugin too, with every package external: refusing it skipped the
// pre-bundling, so the server optimized dependencies while a page loaded and reloaded it (#2123).
const reka = (path) => fileURLToPath(new URL(`../node_modules/reka-ui/${path}`, import.meta.url));
const NOT_PATCHED = /reka-ui's ScrollAreaThumb was not patched/u;

/**
 * Builds `entry.js` (source) in a scratch folder that also holds a copy of the thumb at another place in its package
 * (`node_modules/reka-ui/lib/ScrollAreaThumb.mjs`, as an upgrade could move it). Only the files the entry imports by
 * path are bundled; a package it names, and whatever those files import, are external.
 */
async function bundle(t, source, plugin = rekaScrollThumbPatch()) {
  const root = mkdtempSync(join(tmpdir(), "reka-scroll-thumb-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "entry.js");
  writeFileSync(entry, source);
  mkdirSync(join(root, "node_modules/reka-ui/lib"), { recursive: true });
  copyFileSync(
    reka("dist/ScrollArea/ScrollAreaThumb.js"),
    join(root, "node_modules/reka-ui/lib/ScrollAreaThumb.mjs"),
  );
  const outputs = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [plugin],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        external: (id, importer) => importer !== entry || !(id.startsWith(".") || isAbsolute(id)),
      },
    },
  });
  return [outputs].flat()[0].output[0].code;
}
const importing = (path) => `export * from ${JSON.stringify(path)};\n`;
const MOVED = importing("./node_modules/reka-ui/lib/ScrollAreaThumb.mjs");

test("a build that bundles no reka-ui file, as the dependency scan, is not refused", async (t) => {
  await bundle(t, 'import { Label } from "reka-ui";\nconsole.log(Label);\n');
});

test("a build that bundles reka-ui without its ScrollAreaThumb is refused", async (t) => {
  await assert.rejects(bundle(t, importing(reka("dist/Label/Label.js"))), NOT_PATCHED);
});

test("a build that bundles the thumb from another place in its package is refused", async (t) => {
  await assert.rejects(bundle(t, MOVED), NOT_PATCHED);
});

test("one plugin judges each build alone: a patched build does not admit a later unpatched one", async (t) => {
  const plugin = rekaScrollThumbPatch();
  const code = await bundle(t, importing(reka("dist/ScrollArea/ScrollAreaThumb.js")), plugin);
  assert.match(code, /settlingScrollListener/u);
  await assert.rejects(bundle(t, MOVED, plugin), NOT_PATCHED);
});
