import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Requires `npm run build:player` (part of `npm run build`).
const buildRoot = resolve(import.meta.dirname, "../player-app");
const developmentMarkers = ["Stage media fixture", "Coastal Guide", "development illustration"];

test("the default Player build statically loads no development preview content", async () => {
  const html = await readFile(resolve(buildRoot, "index.html"), "utf8");
  const entry = /<script type="module"[^>]* src="\/player\/assets\/([^"]+\.js)"/u.exec(html)?.[1];
  assert.ok(entry, "The Player build has no module entry");

  // Follow only static imports: the development preview must stay behind its dynamic `?dev` import.
  const loaded = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const chunk = pending.pop()!;
    if (loaded.has(chunk)) continue;
    const source = await readFile(resolve(buildRoot, "assets", chunk), "utf8");
    loaded.set(chunk, source);
    for (const match of source.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/gu)) {
      pending.push(match[1]!);
    }
  }
  for (const [chunk, source] of loaded) {
    for (const marker of developmentMarkers) {
      assert.ok(!source.includes(marker), `${chunk} statically loads "${marker}"`);
    }
  }

  const assets = await readdir(resolve(buildRoot, "assets"));
  const preview = assets.find((name) => /^DevelopmentPreview-.+\.js$/u.test(name));
  assert.ok(preview, "The opt-in development preview chunk is missing");
  const previewSource = await readFile(resolve(buildRoot, "assets", preview), "utf8");
  assert.ok(developmentMarkers.every((marker) => previewSource.includes(marker)));
});
