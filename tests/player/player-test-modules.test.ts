import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// A compiled-only run after a Player or engine edit used the bundle of the code before it, and passed (#2141). The
// fixture is a checkout with the real bundle plugin and the compiled loader: a two-module Player, its imported module a
// symlink, whose sources and build configuration change after its bundle was built.
const repository = fileURLToPath(new URL("../../../", import.meta.url));

const config = (plugins = "testModulesSources()") => `import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { testModulesSources } from "./test-modules-sources.ts";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "warn",
  publicDir: false,
  plugins: [${plugins}],
  build: {
    ssr: true,
    outDir: "dist/player-test-modules",
    emptyOutDir: true,
    rolldownOptions: { input: { "player/clock": "player/clock.ts" }, output: { entryFileNames: "[name].js" } },
  },
});
`;
const CLOCK = `import { round } from "./rounding.ts";\nexport const minutes = (seconds: number): number => round(seconds / 60);\n`;
const STALE =
  "The Player test bundle is older than its sources (player/rounding.ts): run `npm run build:player-test-modules`, or `npm test -- dist/tests/<file>.test.js`, before a compiled-only run.";

function checkout(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "player-test-modules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = (name: string) => join(root, name);
  const write = (name: string, text: string) => {
    mkdirSync(dirname(path(name)), { recursive: true });
    writeFileSync(path(name), text);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { useDefineForClassFields: true } }));
  write("player/vue/vite.test-modules.config.ts", config());
  write("player/clock.ts", CLOCK);
  write("player/round.ts", "export const round = Math.round;\n");
  write("player/ceil.ts", "export const round = Math.ceil;\n");
  symlinkSync("round.ts", path("player/rounding.ts"));
  for (const name of [
    "player/vue/test-modules-sources.ts",
    "dist/tests/helpers/player-modules.js",
  ]) {
    mkdirSync(dirname(path(name)), { recursive: true });
    copyFileSync(join(repository, name), path(name));
  }
  symlinkSync(join(repository, "node_modules"), path("node_modules"));
  const build = () =>
    spawnSync(
      process.execPath,
      [
        join(repository, "node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        "player/vue/vite.test-modules.config.ts",
      ],
      { cwd: root, encoding: "utf8" },
    );
  // `minutes(90)` from each load in a test process of its own, as the loader checks once a process, or the error it
  // refuses with; `between` runs in that process between two loads.
  const minutesOf90 = (loads = 1, between = "") => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeFileSync } from "node:fs";
const { loadPlayerModule } = await import("./dist/tests/helpers/player-modules.js");
for (let load = 0; load < ${loads}; load++) {
  if (load > 0) { ${between} }
  try { console.log((await loadPlayerModule("player/clock.ts")).minutes(90)); }
  catch (error) { console.log(error.message); }
}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  return { path, write, build, minutesOf90 };
}

test("a Player test bundle is refused once a file it was built from or by changes", (t) => {
  const { path, build, minutesOf90 } = checkout(t);
  assert.equal(build().status, 0);
  assert.equal(minutesOf90(), "2");

  // the imported module, edited through its symlink's target, then rebuilt: the new code loads
  writeFileSync(path("player/round.ts"), "export const round = Math.floor;\n");
  assert.equal(minutesOf90(), STALE);
  assert.equal(build().status, 0);
  assert.equal(minutesOf90(), "1");

  // each change is refused, naming its file alone, so the change before it was undone
  const original = (name: string) => readFileSync(path(name), "utf8");
  const changes: readonly (readonly [string, () => () => void])[] = [
    [
      "player/rounding.ts",
      () => {
        unlinkSync(path("player/rounding.ts"));
        symlinkSync("ceil.ts", path("player/rounding.ts"));
        return () => {
          unlinkSync(path("player/rounding.ts"));
          symlinkSync("round.ts", path("player/rounding.ts"));
        };
      },
    ],
    ...[
      "player/clock.ts",
      "player/vue/vite.test-modules.config.ts",
      "player/vue/test-modules-sources.ts",
      "tsconfig.json",
      "package.json",
    ].map(
      (name) =>
        [
          name,
          () => {
            const text = original(name);
            writeFileSync(
              path(name),
              name.endsWith(".json") ? text.replace("{", '{"edited":1,') : `${text}\n// edited\n`,
            );
            return () => writeFileSync(path(name), text);
          },
        ] as const,
    ),
    ...["player/tsconfig.json", "player/package.json", ".env"].map(
      (name) =>
        [
          name,
          () => {
            writeFileSync(path(name), name === ".env" ? "VITE_EDITED=1\n" : "{}\n");
            return () => unlinkSync(path(name));
          },
        ] as const,
    ),
    [
      "player/clock.ts",
      () => {
        const text = original("player/clock.ts");
        unlinkSync(path("player/clock.ts"));
        return () => writeFileSync(path("player/clock.ts"), text);
      },
    ],
  ];
  for (const [name, change] of changes) {
    const undo = change();
    assert.match(
      minutesOf90(),
      new RegExp(
        `^The Player test bundle is older than its sources \\(${name.replaceAll(".", "\\.")}\\)`,
        "u",
      ),
      name,
    );
    undo();
  }

  // checked once a process: a change after the first load does not refuse the second
  assert.equal(
    minutesOf90(2, 'writeFileSync("player/clock.ts", "// edited\\n", { flag: "a" });'),
    "1\n1",
  );
  writeFileSync(path("player/clock.ts"), CLOCK);
  unlinkSync(path("dist/player-test-modules/sources.json"));
  assert.match(
    minutesOf90(),
    /has no readable sources\.json .*: run `npm run build:player-test-modules`\.$/u,
  );
});

test("a Player test bundle is not built from a module the stamp does not cover", (t) => {
  const { write, build } = checkout(t);
  write("player/note.txt", "a note\n");
  write("player/clock.ts", `import note from "./note.txt?raw";\n${CLOCK}export { note };\n`);
  assert.match(build().stderr, /player\/note\.txt\?raw is a form the stamp does not cover/u);
  write("player/style.css", "p { color: red; }\n");
  write("player/clock.ts", `import "./style.css";\n${CLOCK}`);
  assert.match(build().stderr, /player\/style\.css is a form the stamp does not cover/u);
  // A module another plugin loads before this one is bundled without being read here.
  write("player/clock.ts", CLOCK);
  write(
    "player/vue/vite.test-modules.config.ts",
    config(
      '{ name: "earlier", enforce: "pre", load: (id) => (id.endsWith("/rounding.ts") ? "export const round = Math.ceil;" : null) }, testModulesSources()',
    ),
  );
  assert.match(build().stderr, /player\/rounding\.ts was bundled without being hashed/u);
});
