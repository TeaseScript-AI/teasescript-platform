import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { walkSources } from "../../player/vue/test-modules-sources.js";

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
  `The Player test bundle was built before a file of this checkout changed (${paths}): run \`npm run build:player-test-modules\` to rebuild it.`;

function checkout(t: TestContext, sources = repository) {
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
  // Written, not copied with their mode: the tests edit them, and a queue `--commit` tree's sources are read-only.
  for (const name of [
    "player/vue/test-modules-sources.ts",
    "dist/tests/helpers/player-modules.js",
    "dist/player/vue/test-modules-sources.js",
  ])
    write(name, readFileSync(join(sources, name), "utf8"));
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
  const minutesOf90 = (loads = 1, between = "", cwd = root, value = "minutes(90)") => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeFileSync } from "node:fs";
const { loadPlayerModule } = await import("./dist/tests/helpers/player-modules.js");
for (let load = 0; load < ${loads}; load++) {
  if (load > 0) { ${between} }
  try { console.log(JSON.stringify((await loadPlayerModule("player/clock.ts")).${value})); }
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

test("a Player test bundle is refused once a file of the checkout changes", (t) => {
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
    // a file the resolver could choose now, a file in `src/`, a root file of any kind, a test, a tool, a nested file
    ...[
      "player/clock.js",
      "src/unrelated.ts",
      ".env",
      "README.md",
      "tests/unit.test.ts",
      "tools/added.mjs",
      "docs/deep/nested/note.md",
    ].map((name) => [name, add(name)] as const),
    [
      "player/clock.ts",
      () => {
        const before = text("player/clock.ts");
        unlinkSync(path("player/clock.ts"));
        return () => write("player/clock.ts", before);
      },
    ],
    // an added entry the walk refuses, under a key the bundle never had: a name that is not UTF-8, a FIFO
    [
      "tools/\ufffd.txt",
      () => {
        const raw = Buffer.concat([
          Buffer.from(path("tools/")),
          Buffer.from([0xff]),
          Buffer.from(".txt"),
        ]);
        writeFileSync(raw, "raw");
        return () => rmSync(raw);
      },
    ],
    [
      "tools/pipe",
      () => {
        assert.equal(spawnSync("mkfifo", [path("tools/pipe")]).status, 0);
        return () => unlinkSync(path("tools/pipe"));
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

test("an entry the walk does not admit fails the build: a folder link, a name that is not UTF-8, a special file", (t) => {
  const { path, write, build } = checkout(t);
  const refused = (expected: RegExp, make: () => () => void) => {
    const undo = make();
    const result = build();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    undo();
  };
  const link = (name: string, target: string) => () => {
    symlinkSync(target, path(name), "junction");
    return () => unlinkSync(path(name));
  };
  write("actual-src/value.ts", "export const value = 1;\n");
  refused(
    /player\/tools cannot be stamped \(a link to a folder, tools\)/u,
    link("player/tools", "../tools"),
  );
  refused(/src cannot be stamped \(a link to a folder, actual-src\)/u, link("src", "actual-src"));
  refused(
    /docs-link cannot be stamped \(a link to a folder, actual-src\)/u,
    link("docs-link", "actual-src"),
  );
  // a name that is not UTF-8, shown decoded with its bytes; the names family below holds the rule
  refused(
    /tools\/\ufffd\.txt cannot be stamped \(a name that is not valid UTF-8, bytes ff2e747874\)/u,
    () => {
      const raw = Buffer.concat([
        Buffer.from(path("tools/")),
        Buffer.from([0xff]),
        Buffer.from(".txt"),
      ]);
      writeFileSync(raw, "raw");
      return () => rmSync(raw);
    },
  );
  // a special file is not read, so a FIFO with no writer cannot hang the walk
  const fifo = (name: string) => () => {
    assert.equal(spawnSync("mkfifo", [path(name)]).status, 0);
    return () => unlinkSync(path(name));
  };
  refused(/tools\/pipe cannot be stamped \(a special file\)/u, fifo("tools/pipe"));
  refused(/player\/pipe-link cannot be stamped \(a link to a special file, tools\/pipe\)/u, () => {
    const undo = fifo("tools/pipe")();
    symlinkSync("../tools/pipe", path("player/pipe-link"));
    return () => {
      unlinkSync(path("player/pipe-link"));
      undo();
    };
  });
  assert.equal(build().status, 0);
});

// Round 2's witness: a link retargeted from a valid name to a target whose name is not UTF-8 but decodes to it, with the
// same content, which the configuration reads through the link. It is refused, and so is its rebuild.
test("a link retargeted to a name that is not UTF-8 is refused, and its rebuild fails", (t) => {
  const { path, write, build, minutesOf90 } = checkout(t);
  const raw = Buffer.concat([
    Buffer.from(path("dist/raw/")),
    Buffer.from([0xff]),
    Buffer.from(".txt"),
  ]);
  write("dist/raw/\ufffd.txt", "same");
  writeFileSync(raw, "same");
  symlinkSync("../dist/raw/\ufffd.txt", path("tools/input.txt"));
  write(
    "player/vue/vite.test-modules.config.ts",
    `import { readlinkSync } from "node:fs";\n${config().replace(
      "publicDir: false,",
      'publicDir: false,\n  define: { __WITNESS__: JSON.stringify(readlinkSync("tools/input.txt", { encoding: "buffer" }).toString("hex")) },',
    )}`,
  );
  write("player/clock.ts", `${CLOCK}export const witness = __WITNESS__;\n`);
  const built = build();
  assert.equal(built.status, 0, built.stderr);
  const target = (bytes: Buffer) =>
    JSON.stringify(Buffer.concat([Buffer.from("../dist/raw/"), bytes]).toString("hex"));
  assert.equal(minutesOf90(1, "", path(""), "witness"), target(Buffer.from("\ufffd.txt")));
  unlinkSync(path("tools/input.txt"));
  symlinkSync(
    Buffer.concat([Buffer.from("../dist/raw/"), Buffer.from([0xff]), Buffer.from(".txt")]),
    path("tools/input.txt"),
  );
  assert.equal(minutesOf90(1, "", path(""), "witness"), STALE("tools/input.txt"));
  const rebuilt = build();
  assert.notEqual(rebuilt.status, 0);
  assert.match(
    rebuilt.stderr,
    /tools\/input\.txt cannot be stamped \(a link whose target's path is not valid UTF-8\)/u,
  );
});

test("two names that differ only by a backslash are two entries, each stamped by its own content", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "player-test-modules-backslash-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools/data.txt"), "slash");
  writeFileSync(join(root, "tools\\data.txt"), "backslash");
  const before = walkSources(root).stamp;
  assert.deepEqual([...before.keys()], ["tools/data.txt", "tools\\data.txt"]);
  for (const name of ["tools/data.txt", "tools\\data.txt"]) {
    writeFileSync(join(root, name), "edited");
    const after = walkSources(root).stamp;
    assert.deepEqual(
      [...after.keys()].filter((key) => after.get(key) !== before.get(key)),
      [name],
    );
    writeFileSync(join(root, name), name.includes("\\") ? "backslash" : "slash");
  }
});

test("the fixture's copies stay writable when their sources are read-only, as in a queue --commit tree", (t) => {
  const sources = mkdtempSync(join(tmpdir(), "player-test-modules-sources-"));
  t.after(() => rmSync(sources, { recursive: true, force: true }));
  for (const name of [
    "player/vue/test-modules-sources.ts",
    "dist/tests/helpers/player-modules.js",
    "dist/player/vue/test-modules-sources.js",
  ]) {
    mkdirSync(dirname(join(sources, name)), { recursive: true });
    writeFileSync(join(sources, name), readFileSync(join(repository, name)));
    chmodSync(join(sources, name), 0o444);
  }
  const { write, build, minutesOf90 } = checkout(t, sources);
  assert.equal(build().status, 0);
  write("player/vue/test-modules-sources.ts", "// edited\n");
  assert.equal(minutesOf90(), STALE("player/vue/test-modules-sources.ts"));
});

// The witnesses of review rounds 3 to 6, each an input the stamp missed before it covered the whole checkout, and two of
// round 7's: each builds and loads, then an edit of only the witness's file is refused, naming it, and a rebuild loads
// the edited value.
type Witness = {
  /** The witness's files, written before the first build. */
  files: Record<string, string>;
  /** The configuration's extra lines, if any. */
  configuration?: (text: string) => string;
  /** The witness's file and its edited content. */
  edit: readonly [string, string];
  /** `witness` as loaded before and after the edit and a rebuild. */
  values: readonly [unknown, unknown];
};
const CLASS_FIELD = 'export const witness = Object.hasOwn(new class { f: unknown; }(), "f");\n';
const WITNESSES = (root: string): Record<string, Witness> => ({
  "round 3: a file named node_modules that the configuration reads": {
    files: {
      "player/nested/node_modules": "first",
      "player/clock.ts": `${CLOCK}export const witness = __WITNESS__;\n`,
    },
    configuration: (text) =>
      `import { readFileSync } from "node:fs";\n${text.replace(
        "publicDir: false,",
        'publicDir: false,\n  define: { __WITNESS__: JSON.stringify(readFileSync("player/nested/node_modules", "utf8")) },',
      )}`,
    edit: ["player/nested/node_modules", "second"],
    values: ["first", "second"],
  },
  'round 4: "extends": "./tools", which the compiler reads as tools/tsconfig.json': {
    files: {
      "tsconfig.json": JSON.stringify({ extends: "./tools" }),
      "tools.json": JSON.stringify({ compilerOptions: { useDefineForClassFields: true } }),
      "tools/tsconfig.json": JSON.stringify({
        compilerOptions: { useDefineForClassFields: false },
      }),
      "player/clock.ts": `${CLOCK}${CLASS_FIELD}`,
    },
    edit: [
      "tools/tsconfig.json",
      JSON.stringify({ compilerOptions: { useDefineForClassFields: true } }),
    ],
    values: [false, true],
  },
  "round 5: a constant the bundler inlines": {
    files: {
      "tools/value.ts": "export const value = 1;\n",
      "player/clock.ts": `import { value } from "../tools/value.ts";\n${CLOCK}export const witness = value;\n`,
    },
    edit: ["tools/value.ts", "export const value = 2;\n"],
    values: [1, 2],
  },
  "round 5: a re-export the bundler drops": {
    files: {
      "player/one.ts": "export const value = 1;\n",
      "player/two.ts": "export const value = 2;\n",
      "tools/bridge.ts": 'export { value } from "../player/one.ts";\n',
      "player/clock.ts": `import { value } from "../tools/bridge.ts";\n${CLOCK}export const witness = value;\n`,
    },
    edit: ["tools/bridge.ts", 'export { value } from "../player/two.ts";\n'],
    values: [1, 2],
  },
  "round 5: a ?raw text the bundler inlines": {
    files: {
      "tools/word.txt": "old",
      "player/clock.ts": `import text from "../tools/word.txt?raw";\n${CLOCK}export const witness = text;\n`,
    },
    edit: ["tools/word.txt", "new"],
    values: ["old", "new"],
  },
  "round 6: a manifest that redirects a folder import into the area": {
    files: {
      "player/one.ts": "export const value = 1;\n",
      "player/two.ts": "export const value = 2;\n",
      "tools/redirect/package.json": JSON.stringify({ main: "../../player/one.ts" }),
      "player/clock.ts": `import { value } from "../tools/redirect";\n${CLOCK}export const witness = value;\n`,
    },
    edit: ["tools/redirect/package.json", JSON.stringify({ main: "../../player/two.ts" })],
    values: [1, 2],
  },
  "round 6: a local external by #imports": {
    files: {
      "package.json": JSON.stringify({
        type: "module",
        imports: { "#probe": "./tools/value.mjs" },
      }),
      "tools/value.mjs": "export const value = 1;\n",
      "player/clock.ts": `import { value } from "#probe";\n${CLOCK}export const witness = value;\n`,
    },
    edit: ["tools/value.mjs", "export const value = 2;\n"],
    values: [1, 2],
  },
  "round 6: a local external by file URL": {
    files: {
      "tools/value.mjs": "export const value = 1;\n",
      "player/clock.ts": `import { value } from "file://${root}/tools/value.mjs";\n${CLOCK}export const witness = value;\n`,
    },
    edit: ["tools/value.mjs", "export const value = 2;\n"],
    values: [1, 2],
  },
  "a source module in a nested folder named node_modules": {
    files: {
      "player/node_modules/dep/value.ts": "export const value = 1;\n",
      "player/clock.ts": `import { value } from "./node_modules/dep/value.ts";\n${CLOCK}export const witness = value;\n`,
    },
    edit: ["player/node_modules/dep/value.ts", "export const value = 2;\n"],
    values: [1, 2],
  },
  "a source module in a nested folder named dist": {
    files: {
      "player/dist/value.ts": "export const value = 1;\n",
      "player/clock.ts": `import { value } from "./dist/value.ts";\n${CLOCK}export const witness = value;\n`,
    },
    edit: ["player/dist/value.ts", "export const value = 2;\n"],
    values: [1, 2],
  },
});
for (const name of Object.keys(WITNESSES("")))
  test(`${name}: an edit is refused, and a rebuild loads it`, (t) => {
    const { root, write, build, minutesOf90 } = checkout(t);
    const witness = WITNESSES(realpathSync(root))[name]!;
    for (const [file, text] of Object.entries(witness.files)) write(file, text);
    if (witness.configuration !== undefined)
      write("player/vue/vite.test-modules.config.ts", witness.configuration(config()));
    const value = () => minutesOf90(1, "", root, "witness");
    const built = build();
    assert.equal(built.status, 0, built.stderr);
    assert.equal(value(), JSON.stringify(witness.values[0]));
    const [file, edited] = witness.edit;
    write(file, edited);
    assert.equal(value(), STALE(file));
    assert.equal(build().status, 0);
    assert.equal(value(), JSON.stringify(witness.values[1]));
  });

test("the stamp covers the checkout apart from the root's bookkeeping, node_modules and dist", (t) => {
  const root = mkdtempSync(join(tmpdir(), "player-test-modules-root-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "player-test-modules-elsewhere-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
  for (const name of [".git", ".sha", ".complete", ".fourth", "README.md", "target.txt"])
    writeFileSync(join(root, name), name);
  for (const folder of ["docs", "dist", "tools"]) {
    mkdirSync(join(root, folder));
    writeFileSync(join(root, folder, "inner.md"), folder);
  }
  symlinkSync(elsewhere, join(root, "node_modules"), "junction");
  symlinkSync("target.txt", join(root, "file-link.txt"));
  const { stamp, refused } = walkSources(root);
  assert.deepEqual(refused, []);
  assert.deepEqual(
    [...stamp.keys()],
    [".fourth", "README.md", "docs/inner.md", "file-link.txt", "target.txt", "tools/inner.md"],
  );
});

// The entry rule, generated: a name, a kind and a placement; each expected stamp follows from the clauses. A key is the
// names joined with `/`, none rewritten. A file or a link to one is an entry everywhere. A folder is entered everywhere,
// except a folder or a link to one named `node_modules` or `dist` in the root, which is left out. Any other link to a
// folder, and a special file, are refused.
for (const name of ["node_modules", "dist", "other", "with\\backslash"])
  for (const kind of ["file", "file link", "folder", "folder link", "special file"])
    for (const placement of ["the root", "an area folder", "a nested folder", "tools/"])
      test(`a ${kind} named ${name} in ${placement}`, (t) => {
        const root = mkdtempSync(join(tmpdir(), "player-test-modules-entry-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const folder = {
          "the root": "",
          "an area folder": "player",
          "a nested folder": "player/nested",
          "tools/": "tools",
        }[placement]!;
        const path = folder === "" ? name : `${folder}/${name}`;
        mkdirSync(join(root, folder), { recursive: true });
        mkdirSync(join(root, "targets/folder"), { recursive: true });
        writeFileSync(join(root, "targets/file.ts"), "file");
        writeFileSync(join(root, "targets/folder/inner.ts"), "inner");
        if (kind === "file") writeFileSync(join(root, path), "entry");
        else if (kind === "file link") symlinkSync(join(root, "targets/file.ts"), join(root, path));
        else if (kind === "special file")
          assert.equal(spawnSync("mkfifo", [join(root, path)]).status, 0);
        else if (kind === "folder") {
          mkdirSync(join(root, path));
          writeFileSync(join(root, path, "inner.ts"), "inner");
        } else symlinkSync(join(root, "targets/folder"), join(root, path), "junction");
        const { stamp, refused } = walkSources(root);
        const leftOut =
          placement === "the root" &&
          (name === "node_modules" || name === "dist") &&
          kind.startsWith("folder");
        const expected = leftOut ? [] : kind === "folder" ? [`${path}/inner.ts`] : [path];
        assert.deepEqual(
          [...stamp.keys(), ...refused.map(([key]) => key)]
            .filter((key) => key === path || key.startsWith(`${path}/`))
            .sort(),
          expected,
        );
        const reason = new Map(refused).get(path);
        if (expected.length === 0) return;
        if (kind === "file") assert.match(stamp.get(path) ?? "", /^file [0-9a-f]{64}$/u);
        if (kind === "file link")
          assert.match(stamp.get(path) ?? "", /^link targets\/file\.ts [0-9a-f]{64}$/u);
        if (kind === "folder link") assert.equal(reason, "a link to a folder, targets/folder");
        if (kind === "special file") assert.equal(reason, "a special file");
      });

// The names family: an entry is admitted exactly when the bytes of its name, or of its link's target, are UTF-8, and two
// admitted entries with different bytes never share a key or an identity. The expectations are UTF-8's, not a decoder's.
const NAMES: readonly (readonly [string, readonly number[], boolean])[] = [
  ["ASCII", [0x61], true],
  ["a two-byte sequence", [0xc3, 0xa9], true],
  ["a three-byte sequence", [0xe2, 0x82, 0xac], true],
  ["a four-byte sequence", [0xf0, 0x9f, 0x98, 0x80], true],
  ["a leading byte order mark", [0xef, 0xbb, 0xbf], true],
  ["a backslash", [0x5c], true],
  ["an invalid lead byte", [0xff], false],
  ["a truncated sequence", [0xe2, 0x82], false],
  ["an overlong encoding", [0xc0, 0xaf], false],
  ["an encoded surrogate half", [0xed, 0xa0, 0x80], false],
];
type Position = "a file" | "a folder" | "a link" | "a link's target";
const POSITIONS: readonly Position[] = ["a file", "a folder", "a link", "a link's target"];

/** Makes one entry whose name, or whose link's target's name, is `bytes` and `-name`, in `folder` of `root`. */
function named(root: string, position: Position, folder: string, bytes: Buffer, index: number) {
  const prefix = folder === "" ? "" : `${folder}/`;
  const at = (...parts: Buffer[]) => Buffer.concat([Buffer.from(`${root}/`), ...parts]);
  const name = Buffer.concat([bytes, Buffer.from("-name")]);
  mkdirSync(join(root, folder), { recursive: true });
  if (position === "a link's target") {
    mkdirSync(join(root, "dist", folder), { recursive: true });
    writeFileSync(at(Buffer.from(`dist/${prefix}`), name), "target");
    symlinkSync(at(Buffer.from(`dist/${prefix}`), name), join(root, prefix, `link-${index}.txt`));
    const key = `${prefix}link-${index}.txt`;
    return {
      key,
      shown: key,
      value: `link dist/${prefix}${name.toString()} `,
      reason: "a link whose target's path is not valid UTF-8",
    };
  }
  const path = at(Buffer.from(prefix), name);
  if (position === "a file") writeFileSync(path, "entry");
  else if (position === "a link") {
    mkdirSync(join(root, "targets"), { recursive: true });
    writeFileSync(join(root, "targets/file.txt"), "target");
    symlinkSync(join(root, "targets/file.txt"), path);
  } else {
    mkdirSync(path);
    writeFileSync(Buffer.concat([path, Buffer.from("/inner.txt")]), "inner");
  }
  const key = `${prefix}${name.toString()}`;
  return {
    key: position === "a folder" ? `${key}/inner.txt` : key,
    shown: key,
    value: { "a file": "file ", "a link": "link targets/file.txt ", "a folder": "file " }[position],
    reason: `a name that is not valid UTF-8, bytes ${name.toString("hex")}`,
  };
}

const namesRoot = (t: TestContext) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "player-test-modules-names-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
/** The stamp's keys apart from the shared link target, which the family's links read. */
const ownKeys = (stamp: Map<string, string>) =>
  [...stamp.keys()].filter((key) => key !== "targets/file.txt").sort();

for (const position of POSITIONS)
  for (const folder of ["", "player/nested"]) {
    for (const [label, bytes, valid] of NAMES)
      test(`${position} whose name has ${label}, in ${folder || "the root"}: ${valid ? "admitted" : "refused"}`, (t) => {
        const root = namesRoot(t);
        const entry = named(root, position, folder, Buffer.from(bytes), 0);
        // beside a name that is not UTF-8, the valid name it decodes to, which is admitted on its own
        const lossy = Buffer.from(Buffer.from(bytes).toString());
        const twin = valid ? undefined : named(root, position, folder, lossy, 1);
        const { stamp, refused } = walkSources(root);
        assert.deepEqual(refused, valid ? [] : [[entry.shown, entry.reason]]);
        const admitted = valid ? [entry] : [twin!];
        assert.deepEqual(ownKeys(stamp), admitted.map(({ key }) => key).sort());
        for (const { key, value } of admitted) assert.ok(stamp.get(key)?.startsWith(value), key);
      });
    test(`every name at once as ${position} in ${folder || "the root"}: no two admitted entries share a key or an identity`, (t) => {
      const root = namesRoot(t);
      const made = NAMES.map(([, bytes, valid], index) => ({
        valid,
        ...named(root, position, folder, Buffer.from(bytes), index),
      }));
      // the valid names the invalid ones decode to, once each
      const twins = [
        ...new Set(
          NAMES.filter(([, , valid]) => !valid).map(([, bytes]) => Buffer.from(bytes).toString()),
        ),
      ].map((text, index) =>
        named(root, position, folder, Buffer.from(text), NAMES.length + index),
      );
      const { stamp, refused } = walkSources(root);
      assert.deepEqual(
        refused.map(([key]) => key).sort(),
        made
          .filter(({ valid }) => !valid)
          .map(({ shown }) => shown)
          .sort(),
      );
      const admitted = [...made.filter(({ valid }) => valid), ...twins];
      assert.deepEqual(ownKeys(stamp), admitted.map(({ key }) => key).sort());
      for (const { key, value } of admitted) assert.ok(stamp.get(key)?.startsWith(value), key);
    });
  }
