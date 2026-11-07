import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROJECTS, projectsFor } from "./check-changed.mjs";

// A representative changed path for each project, and the projects it alone needs.
const REPRESENTATIVES = {
  typescript: ["src/compiler.ts", ["typescript"]],
  "player-vue": ["player/vue/src/PlayerApp.vue", ["player-vue"]],
  "oxlint-rules": ["tools/oxlint/run.mjs", ["oxlint-rules"]],
  tools: ["tools/test-shards.mjs", ["tools"]],
  documentation: ["docs/TESTING.md", []],
  unknown: [".github/workflows/ci.yml", Object.keys(PROJECTS)],
};

test("each changed path needs its project's checks, documentation none, and an unknown path every project's", () => {
  // Every project has a representative, so a new project cannot go unchecked here.
  for (const name of Object.keys(PROJECTS))
    assert.ok(name in REPRESENTATIVES, `${name} has a representative`);
  const kinds = Object.entries(REPRESENTATIVES);
  for (const [kind, [path, expected]] of kinds)
    assert.deepEqual([...projectsFor([path])].sort(), [...expected].sort(), kind);
  // Each pair of kinds needs the union of what each needs alone.
  for (const [first, [firstPath, firstExpected]] of kinds)
    for (const [second, [secondPath, secondExpected]] of kinds)
      assert.deepEqual(
        [...projectsFor([firstPath, secondPath])].sort(),
        [...new Set([...firstExpected, ...secondExpected])].sort(),
        `${first} with ${second}`,
      );
  assert.deepEqual([...projectsFor([])], []);
  // `player/` outside `player/vue/` belongs to the TypeScript project, and `player/vue/` only to the Player's.
  assert.deepEqual([...projectsFor(["player/runtime-adapter.ts"])], ["typescript"]);
  assert.deepEqual([...projectsFor(["player/vue/src/usePlayerSession.ts"])], ["player-vue"]);
});

test("without node_modules it runs no check, names the fix and exits 2", () => {
  const directory = mkdtempSync(join(tmpdir(), "check-changed-"));
  try {
    const run = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    run("init", "-q");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    writeFileSync(join(directory, "a.mjs"), "export const a = 1;\n");
    const tool = fileURLToPath(new URL("./check-changed.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [tool, "--base", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /no node_modules: (?:link|link it)/u);
    assert.doesNotMatch(result.stdout, /PASS|FAIL/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
