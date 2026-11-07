import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

// `build:tree` is what a worker's tree builds (`sx-tree`): what the compiled suite reads, the TypeScript, the Player app
// and its test modules, so that the Player tests run there; `build` is the same with the Player's typecheck beside them
test("build:tree builds what the compiled suite reads: the TypeScript, the Player app and its test modules", async () => {
  const parsed: unknown = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"),
  );
  assert.ok(typeof parsed === "object" && parsed !== null && "scripts" in parsed);
  const scripts = new Map(Object.entries(Object(parsed.scripts)).map(([k, v]) => [k, String(v)]));
  const steps = (script: string) =>
    script
      .split(/\s*&&\s*/u)
      .flatMap((step) =>
        step.startsWith("node tools/run-parallel.mjs ")
          ? step.split(" ").slice(2)
          : [step.replace(/^npm run /u, "")],
      );
  assert.deepEqual(steps(scripts.get("build:tree")!), [
    "build:typescript",
    "build:player",
    "build:player-test-modules",
  ]);
  assert.deepEqual(steps(scripts.get("build")!), [
    "build:typescript",
    "typecheck:player",
    "build:player",
    "build:player-test-modules",
  ]);
  // (the two Player outputs that `build:typescript` alone leaves out, which the Player tests read)
  for (const output of [
    "player-app/index.html",
    "player-test-modules/player/vue/src/session/usePlayerSession.js",
  ])
    assert.ok(existsSync(resolve(import.meta.dirname, "..", output)), `dist/${output}`);
});
