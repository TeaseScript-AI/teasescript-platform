import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Knip cannot follow the Player test loader (`tests/helpers/player-modules.ts`), so `knip.json` lists the modules that
// `player/vue/vite.test-modules.config.ts` bundles for it as entries. Without its entry, a module's exports that only
// tests use read as unused. The check does not resolve knip's patterns: it accepts only a convention under which every
// listed module is certainly an entry, each module's literal path in `entry` and no negated pattern there. A glob or a
// negation in `entry` therefore needs this check changed first.
test("knip.json lists every module of the Player test bundle by its literal path, and negates no entry", async () => {
  const { default: config } = await import("../player/vue/vite.test-modules.config.ts");
  const modules = Object.values(config.build.rolldownOptions.input);
  assert.ok(modules.length > 0, "the Player test bundle lists no modules");
  const { entry } = JSON.parse(readFileSync(new URL("../knip.json", import.meta.url), "utf8"));
  const negated = entry.filter((pattern) => pattern.startsWith("!"));
  assert.deepEqual(
    negated,
    [],
    `knip.json's entries negate ${negated.join(", ")}; change this check first`,
  );
  const missing = modules.filter((module) => !entry.includes(module));
  assert.deepEqual(
    missing,
    [],
    `knip.json's entries lack ${missing.join(", ")}: list each module literally`,
  );
});
