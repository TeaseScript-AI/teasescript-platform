import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";

/**
 * Whether Knip counts `file` among the entries `patterns` give, as it resolves them: a production entry's trailing `!`
 * is dropped, and the file must match a pattern and no negated one (a leading `!`).
 */
function isEntry(file, patterns) {
  const globs = patterns.map((pattern) => pattern.replace(/!$/u, ""));
  const included = globs.some((glob) => !glob.startsWith("!") && matchesGlob(file, glob));
  return (
    included && !globs.some((glob) => glob.startsWith("!") && matchesGlob(file, glob.slice(1)))
  );
}

// Knip cannot follow the Player test loader (`tests/helpers/player-modules.ts`), so `knip.json` lists the modules that
// `player/vue/vite.test-modules.config.ts` bundles for it as entries. Without its entry, a module's exports that only
// tests use read as unused.
test("knip.json lists every module of the Player test bundle as an entry", async () => {
  const { default: config } = await import("../player/vue/vite.test-modules.config.ts");
  const modules = Object.values(config.build.rolldownOptions.input);
  assert.ok(modules.length > 0, "the Player test bundle lists no modules");
  const { entry } = JSON.parse(readFileSync(new URL("../knip.json", import.meta.url), "utf8"));
  const missing = modules.filter((module) => !isEntry(module, entry));
  assert.deepEqual(missing, [], `knip.json's entries lack ${missing.join(", ")}`);
});

test("an entry is a file that a pattern matches and no negated pattern does, production entries included", () => {
  const file = "player/saved-data.ts";
  assert.equal(isEntry(file, [file]), true);
  assert.equal(isEntry(file, [`${file}!`]), true);
  assert.equal(isEntry(file, ["player/**/*.ts"]), true);
  assert.equal(isEntry(file, ["player/{runtime-adapter,saved-data}.ts"]), true);
  assert.equal(isEntry(file, [file, `!${file}`]), false);
  assert.equal(isEntry(file, ["player/**/*.ts", "!player/saved-*.ts!"]), false);
  assert.equal(isEntry(file, ["player/runtime-adapter.ts"]), false);
  assert.equal(isEntry(file, []), false);
});
