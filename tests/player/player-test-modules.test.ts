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
// fixture is a checkout with the real stamp plugin, the compiled loader and its compiled walk: a two-module Player, its
// imported module a symlink, compiled under a tsconfig that extends a root file.
const repository = fileURLToPath(new URL("../../../", import.meta.url));

const config = (head = "") => `import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { testModulesSources } from "./test-modules-sources.ts";
${head}
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
const STALE = (paths: string) =>
  `The Player test bundle is older than its sources (${paths}): run \`npm run build:player-test-modules\`, or \`npm test -- dist/tests/<file>.test.js\`, before a compiled-only run.`;

function checkout(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "player-test-modules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = (name: string) => join(root, name);
  const write = (name: string, text: string) => {
    mkdirSync(dirname(path(name)), { recursive: true });
    writeFileSync(path(name), text);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write("tsconfig.json", JSON.stringify({ extends: "./compiler-options.json" }));
  write("compiler-options.json", JSON.stringify({ compilerOptions: { strict: true } }));
  write("player/vue/vite.test-modules.config.ts", config());
  write("player/clock.ts", CLOCK);
  write("player/round.ts", "export const round = Math.round;\n");
  write("player/round-copy.ts", "export const round = Math.round;\n");
  write("tools/options.json", "{}\n");
  symlinkSync("round.ts", path("player/rounding.ts"));
  for (const name of [
    "player/vue/test-modules-sources.ts",
    "dist/tests/helpers/player-modules.js",
    "dist/player/vue/test-modules-sources.js",
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

test("a Player test bundle is refused once a file in the stamped area changes", (t) => {
  const { path, write, build, minutesOf90 } = checkout(t);
  assert.equal(build().status, 0);
  assert.equal(minutesOf90(), "2");

  // the imported module, edited through its symlink's target, then rebuilt: the new code loads
  write("player/round.ts", "export const round = Math.floor;\n");
  assert.equal(minutesOf90(), STALE("player/round.ts, player/rounding.ts"));
  write("player/round-copy.ts", "export const round = Math.floor;\n");
  assert.equal(build().status, 0);
  assert.equal(minutesOf90(), "1");

  // each change is refused, naming its path alone, so the change before it was undone
  const text = (name: string) => readFileSync(path(name), "utf8");
  const edit = (name: string) => () => {
    const before = text(name);
    write(
      name,
      name.endsWith(".json") ? before.replace("{", '{"edited":1,') : `${before}// edited\n`,
    );
    return () => write(name, before);
  };
  const add = (name: string) => () => {
    write(name, "export const added = 1;\n");
    return () => unlinkSync(path(name));
  };
  const changes: readonly (readonly [string, () => () => void])[] = [
    // a link retargeted to another file of the same content
    [
      "player/rounding.ts",
      () => {
        unlinkSync(path("player/rounding.ts"));
        symlinkSync("round-copy.ts", path("player/rounding.ts"));
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
      "compiler-options.json",
      "package.json",
    ].map((name) => [name, edit(name)] as const),
    // a file the resolver could choose now, a file in `src/`, a root file of any kind
    ...["player/clock.js", "src/unrelated.ts", ".env", "README.md"].map(
      (name) => [name, add(name)] as const,
    ),
    [
      "player/clock.ts",
      () => {
        const before = text("player/clock.ts");
        unlinkSync(path("player/clock.ts"));
        return () => write("player/clock.ts", before);
      },
    ],
  ];
  for (const [name, change] of changes) {
    const undo = change();
    assert.equal(minutesOf90(), STALE(name), name);
    undo();
  }

  // checked once a process: a change after the first load does not refuse the second
  assert.equal(
    minutesOf90(2, 'writeFileSync("player/clock.ts", "// edited\\n", { flag: "a" });'),
    "1\n1",
  );
  write("player/clock.ts", CLOCK);
  unlinkSync(path("dist/player-test-modules/sources.json"));
  assert.match(
    minutesOf90(),
    /has no readable sources\.json .*: run `npm run build:player-test-modules`\.$/u,
  );
});

test("a Player test bundle is not built from an input the stamp does not cover", (t) => {
  const { path, write, build } = checkout(t);
  const refused = (expected: RegExp, change: () => () => void) => {
    const undo = change();
    assert.match(build().stderr, expected);
    undo();
  };
  const clock = (text: string) => () => {
    write("player/clock.ts", text);
    return () => write("player/clock.ts", CLOCK);
  };
  write("player/note.txt", "a note\n");
  write("player/style.css", "p { color: red; }\n");
  refused(
    /player\/note\.txt\?raw is a form the stamp does not cover/u,
    clock(`import note from "./note.txt?raw";\n${CLOCK}export { note };\n`),
  );
  refused(
    /player\/style\.css is a form the stamp does not cover/u,
    clock(`import "./style.css";\n${CLOCK}`),
  );
  write("tools/round.ts", "export const round = Math.ceil;\n");
  refused(
    /tools\/round\.ts is bundled from outside the stamped area/u,
    clock(CLOCK.replace("./rounding.ts", "../tools/round.ts")),
  );
  refused(/the configuration reads .*tools\/round\.ts, outside the stamped area/u, () => {
    write("player/vue/vite.test-modules.config.ts", config('import "../../tools/round.ts";\n'));
    return () => write("player/vue/vite.test-modules.config.ts", config());
  });
  refused(/reaches .*tools\/options\.json, outside the stamped area/u, () => {
    write("compiler-options.json", JSON.stringify({ extends: "./tools/options.json" }));
    return () =>
      write("compiler-options.json", JSON.stringify({ compilerOptions: { strict: true } }));
  });
  refused(/player\/tools cannot be stamped \(folder link /u, () => {
    symlinkSync("../tools", path("player/tools"));
    return () => unlinkSync(path("player/tools"));
  });
  assert.equal(build().status, 0);
});
