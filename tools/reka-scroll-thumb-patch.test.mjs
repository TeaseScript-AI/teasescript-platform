import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { rekaScrollThumbPatch } from "../player/vue/reka-scroll-thumb-patch.ts";

// `player/vue/reka-scroll-thumb-patch.ts` refuses a build that bundles reka-ui without patching its ScrollAreaThumb. The
// development server's dependency scan runs the plugin too, with every package external: refusing it skipped the
// pre-bundling, so the server optimized dependencies while a page loaded and reloaded it (#2123).
const rekaLabel = fileURLToPath(
  new URL("../node_modules/reka-ui/dist/Label/Label.js", import.meta.url),
);

async function bundle(t, source, external) {
  const root = mkdtempSync(join(tmpdir(), "reka-scroll-thumb-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "entry.js"), source);
  await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [rekaScrollThumbPatch()],
    build: { write: false, rolldownOptions: { input: join(root, "entry.js"), external } },
  });
}

test("a build that bundles no reka-ui file, as the dependency scan, is not refused", async (t) => {
  await bundle(t, 'import { Label } from "reka-ui";\nconsole.log(Label);\n', [/^[^./]/u]);
});

test("a build that bundles reka-ui without its ScrollAreaThumb is refused", async (t) => {
  await assert.rejects(
    bundle(t, `import { Label } from ${JSON.stringify(rekaLabel)};\nconsole.log(Label);\n`, [
      /^[^./]/u,
    ]),
    /reka-ui's ScrollAreaThumb was not patched/u,
  );
});
