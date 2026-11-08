import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Knip cannot follow the Player test loader (`tests/helpers/player-modules.ts`), so `knip.json` lists the modules that
// `player/vue/vite.test-modules.config.ts` bundles for it as entries. This test checks only that the two lists match:
// each bundled module's literal path is in `entry`. How knip resolves its configuration is knip's own run's to check.
test("the Player test bundle's modules and knip.json's entries match: each module is listed literally", async () => {
  const { default: config } = await import("../player/vue/vite.test-modules.config.ts");
  const modules = Object.values(config.build.rolldownOptions.input);
  assert.ok(modules.length > 0, "the Player test bundle lists no modules");
  const { entry } = JSON.parse(readFileSync(new URL("../knip.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(entry), "knip.json's entry is not a list");
  const missing = modules.filter((module) => !entry.includes(module));
  assert.deepEqual(missing, [], `knip.json's entries lack ${missing.join(", ")}`);
});
