import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";

// Knip cannot follow the Player test loader (`tests/helpers/player-modules.ts`), so `knip.json` lists the modules that
// `player/vue/vite.test-modules.config.ts` bundles for it as entries. Without its entry, a module's exports that only
// tests use read as unused.
test("knip.json lists every module of the Player test bundle as an entry", async () => {
  const { default: config } = await import("../player/vue/vite.test-modules.config.ts");
  const modules = Object.values(config.build.rolldownOptions.input);
  assert.ok(modules.length > 0, "the Player test bundle lists no modules");
  const { entry } = JSON.parse(readFileSync(new URL("../knip.json", import.meta.url), "utf8"));
  const missing = modules.filter(
    (module) => !entry.some((pattern) => matchesGlob(module, pattern)),
  );
  assert.deepEqual(missing, [], `knip.json's entries lack ${missing.join(", ")}`);
});
