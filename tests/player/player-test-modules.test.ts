import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript-vue";
import {
  extendedFiles,
  tsconfigClosure,
  walkSources,
} from "../../player/vue/test-modules-sources.js";

// A compiled-only run after a Player or engine edit used the bundle of the code before it, and passed (#2141). The
// fixture is a checkout with the real stamp plugin, the compiled loader and its compiled walk: a Player module importing
// two symlinks, one to a module beside it and one to a file outside the checkout, compiled under a tsconfig that
// extends a root file.
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
const CLOCK = `import { round } from "./rounding.ts";\nimport { limit } from "./limit.ts";\nexport const minutes = (seconds: number): number => limit(round(seconds / 60));\n`;
const STALE = (paths: string) =>
  `The Player test bundle is older than its sources (${paths}): run \`npm run build:player-test-modules\`, or \`npm test -- dist/tests/<file>.test.js\`, before a compiled-only run.`;

function checkout(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "player-test-modules-"));
  const outside = mkdtempSync(join(tmpdir(), "player-test-modules-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
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
  writeFileSync(join(outside, "limit.ts"), "export const limit = (minutes: number) => minutes;\n");
  symlinkSync(join(outside, "limit.ts"), path("player/limit.ts"));
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
  const minutesOf90 = (loads = 1, between = "", cwd = root) => {
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
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  return { root, outside, path, write, build, minutesOf90 };
}

test("a Player test bundle is refused once a file in the stamped area changes", (t) => {
  const { root, outside, path, write, build, minutesOf90 } = checkout(t);
  assert.equal(build().status, 0);
  assert.equal(minutesOf90(), "2");
  // the built checkout, moved with its links, is the same checkout
  const moved = join(outside, "moved/checkout");
  cpSync(root, moved, { recursive: true, verbatimSymlinks: true });
  assert.equal(minutesOf90(1, "", moved), "2");

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
    // the file outside the checkout that a link in the area reads
    [
      "player/limit.ts",
      () => {
        const before = readFileSync(join(outside, "limit.ts"), "utf8");
        writeFileSync(join(outside, "limit.ts"), `${before}// edited\n`);
        return () => writeFileSync(join(outside, "limit.ts"), before);
      },
    ],
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
  refused(/reads \.env files from .*tools, outside the stamped area/u, () => {
    write(
      "player/vue/vite.test-modules.config.ts",
      config().replace(
        "publicDir: false,",
        'publicDir: false,\n  envDir: fileURLToPath(new URL("../../tools", import.meta.url)),',
      ),
    );
    return () => write("player/vue/vite.test-modules.config.ts", config());
  });
  refused(/extends .*tools\/options\.json, outside the stamped area/u, () => {
    write("compiler-options.json", JSON.stringify({ extends: "./tools/options.json" }));
    return () =>
      write("compiler-options.json", JSON.stringify({ compilerOptions: { strict: true } }));
  });
  // a project reference is a local path, also without "./"
  write("tools/tsconfig.json", "{}\n");
  for (const reference of ["tools", "tools/options.json"])
    refused(/references .*tools\/(?:tsconfig|options)\.json, outside the stamped area/u, () => {
      write("compiler-options.json", JSON.stringify({ references: [{ path: reference }] }));
      return () =>
        write("compiler-options.json", JSON.stringify({ compilerOptions: { strict: true } }));
    });
  // a link to a folder, in the area or in place of an area folder
  refused(/player\/tools cannot be stamped \(folder link /u, () => {
    symlinkSync("../tools", path("player/tools"));
    return () => unlinkSync(path("player/tools"));
  });
  write("actual-src/value.ts", "export const value = 1;\n");
  refused(/src cannot be stamped \(folder link actual-src\)/u, () => {
    symlinkSync("actual-src", path("src"));
    return () => unlinkSync(path("src"));
  });
  assert.equal(build().status, 0);
});

test("the stamp's root entries are its files and links to files, apart from the checkout's bookkeeping", (t) => {
  const root = mkdtempSync(join(tmpdir(), "player-test-modules-root-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "player-test-modules-elsewhere-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
  for (const name of [".git", ".sha", ".complete", ".fourth", "README.md", "target.txt"])
    writeFileSync(join(root, name), name);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/guide.md"), "guide");
  symlinkSync(elsewhere, join(root, "node_modules"), "junction");
  symlinkSync(join(root, "docs"), join(root, "docs-link"), "junction");
  symlinkSync("target.txt", join(root, "file-link.txt"));
  assert.deepEqual(
    [...walkSources(root).keys()],
    [".fourth", "README.md", "file-link.txt", "target.txt"],
  );
});

// The entry rule, generated: a name, a kind and a placement; each expected stamp follows from the clauses. A file or a
// link to one is an entry everywhere; a folder is entered in the area unless it is named `node_modules`, and is no root
// entry; a link to a folder is skipped where it is named `node_modules` or lies in the root, and fails anywhere else.
for (const name of ["node_modules", "other"])
  for (const kind of ["file", "file link", "folder", "folder link"])
    for (const placement of ["the root", "an area folder", "a nested folder"])
      test(`a ${kind} named ${name} in ${placement}`, (t) => {
        const root = mkdtempSync(join(tmpdir(), "player-test-modules-entry-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const folder = {
          "the root": "",
          "an area folder": "player",
          "a nested folder": "player/nested",
        }[placement]!;
        const path = join(folder, name).replaceAll("\\", "/");
        mkdirSync(join(root, folder), { recursive: true });
        mkdirSync(join(root, "targets/folder"), { recursive: true });
        writeFileSync(join(root, "targets/file.ts"), "file");
        writeFileSync(join(root, "targets/folder/inner.ts"), "inner");
        if (kind === "file") writeFileSync(join(root, path), "entry");
        else if (kind === "file link") symlinkSync(join(root, "targets/file.ts"), join(root, path));
        else if (kind === "folder") {
          mkdirSync(join(root, path));
          writeFileSync(join(root, path, "inner.ts"), "inner");
        } else symlinkSync(join(root, "targets/folder"), join(root, path), "junction");
        const stamp = walkSources(root);
        const inRoot = placement === "the root";
        const expected =
          kind === "file" || kind === "file link"
            ? [path]
            : kind === "folder"
              ? inRoot || name === "node_modules"
                ? []
                : [`${path}/inner.ts`]
              : inRoot || name === "node_modules"
                ? []
                : [path];
        assert.deepEqual(
          [...stamp.keys()].filter((key) => key.startsWith(path)),
          expected,
        );
        if (kind === "folder link" && expected.length > 0)
          assert.match(stamp.get(path) ?? "", /^folder link /u, "a folder link fails the build");
      });

// The compiler edges, generated: an edge kind, its spelling and the files beside it. The expected result is
// TypeScript's own: its resolved target must exist and lie in the area (`src/`, `player/`, a root file), or, for an
// `extends`, in a package under `node_modules`.
const EDGE_LAYOUTS: Record<string, readonly string[]> = {
  "nothing there": [],
  "a root x.json": ["x.json"],
  "a root folder x": ["x/tsconfig.json"],
  "a root x.json and a root folder x": ["x.json", "x/tsconfig.json"],
  "a root file x": ["x"],
  "player/x.json": ["player/x.json"],
  "a folder player/x": ["player/x/tsconfig.json"],
  "tools/x.json": ["tools/x.json"],
  "a package x": ["node_modules/x/tsconfig.json"],
};
const inTheArea = (root: string, file: string) => {
  const parts = relative(root, file).replaceAll("\\", "/").split("/");
  if (parts[0] === ".." || parts.slice(0, -1).includes("node_modules")) return false;
  return parts.length === 1 || parts[0] === "src" || parts[0] === "player";
};
for (const kind of ["extends", "references"] as const)
  for (const edge of [
    "./x",
    "x",
    "./x.json",
    "./player/x",
    "player/x",
    "./player/x.json",
    "./tools/x",
  ])
    for (const [layout, files] of Object.entries(EDGE_LAYOUTS))
      test(`${kind} "${edge}" with ${layout}`, async (t) => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "player-test-modules-edge-")));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        for (const file of files) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), "{}\n");
        }
        const start = join(root, "tsconfig.json");
        writeFileSync(
          start,
          JSON.stringify(kind === "extends" ? { extends: edge } : { references: [{ path: edge }] }),
        );
        // TypeScript's own answer: the file it resolves the edge to, and whether it reports the edge.
        const parsed = ts.getParsedCommandLineOfConfigFile(start, undefined, {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        });
        const target =
          kind === "extends"
            ? extendedFiles(parsed?.options ?? {})[0]
            : ts.resolveProjectReferencePath({ path: resolve(root, edge) });
        const reported = (parsed?.errors ?? []).some(
          (diagnostic) =>
            diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code !== 18003,
        );
        const passes =
          !reported &&
          target !== undefined &&
          existsSync(target) &&
          statSync(target).isFile() &&
          (inTheArea(root, target) ||
            (kind === "extends" &&
              relative(root, target).replaceAll("\\", "/").startsWith("node_modules/")));
        const outcome = await tsconfigClosure(root, start).then(
          () => "passes",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        if (passes) assert.equal(outcome, "passes", `TypeScript resolves it to ${target}`);
        else assert.notEqual(outcome, "passes", `TypeScript resolves it to ${target ?? "nothing"}`);
      });
