import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A compiled-only run after a Player or engine edit used the bundle of the code before it, and passed (#2141). The
// fixture is a checkout with the real bundle plugin and the compiled loader: a two-module Player whose imported module
// changes after its bundle was built.
const repository = fileURLToPath(new URL("../../../", import.meta.url));

const CONFIG = `import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { testModulesSources } from "./test-modules-sources.ts";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "warn",
  publicDir: false,
  plugins: [testModulesSources()],
  build: {
    ssr: true,
    outDir: "dist/player-test-modules",
    emptyOutDir: true,
    rolldownOptions: { input: { "player/clock": "player/clock.ts" }, output: { entryFileNames: "[name].js" } },
  },
});
`;
const CLOCK = `import { round } from "./rounding.ts";\nexport const minutes = (seconds: number): number => round(seconds / 60);\n`;

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "player-test-modules-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write("player/vue/vite.test-modules.config.ts", CONFIG);
  write("player/clock.ts", CLOCK);
  write("player/rounding.ts", "export const round = Math.round;\n");
  for (const path of [
    "player/vue/test-modules-sources.ts",
    "dist/tests/helpers/player-modules.js",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  const build = () => {
    const result = spawnSync(
      process.execPath,
      [
        join(repository, "node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        "player/vue/vite.test-modules.config.ts",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  // `minutes(90)` in a test process of its own, as the loader checks once a process, or the error it refuses with
  const minutesOf90 = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { loadPlayerModule } = await import("./dist/tests/helpers/player-modules.js");
try { console.log((await loadPlayerModule("player/clock.ts")).minutes(90)); }
catch (error) { console.log(error.message); }`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  return { root, write, build, minutesOf90 };
}

test("a Player test bundle older than its sources is refused, also after an imported module changed", (t) => {
  const { root, write, build, minutesOf90 } = checkout();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  build();
  assert.equal(minutesOf90(), "2");

  write("player/rounding.ts", "export const round = Math.floor;\n");
  assert.equal(
    minutesOf90(),
    "The Player test bundle is older than its sources (player/rounding.ts): run `npm run build:player-test-modules`, or `npm test -- dist/tests/<file>.test.js`, before a compiled-only run.",
  );
  build();
  assert.equal(minutesOf90(), "1");
  write("player/vue/vite.test-modules.config.ts", CONFIG.replace('"warn"', '"error"'));
  assert.match(
    minutesOf90(),
    /older than its sources \(player\/vue\/vite\.test-modules\.config\.ts\)/u,
  );
  write("player/vue/vite.test-modules.config.ts", CONFIG);

  unlinkSync(join(root, "player/rounding.ts"));
  assert.match(
    minutesOf90(),
    /^The Player test bundle is older than its sources \(player\/rounding\.ts\)/u,
  );
  unlinkSync(join(root, "dist/player-test-modules/sources.json"));
  assert.match(
    minutesOf90(),
    /has no readable sources\.json .*: run `npm run build:player-test-modules`\.$/u,
  );
});
