import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cycleGroups, isGeneratedComponentGroup } from "./imports.mjs";
import { isolateGit } from "../fixture-git.mjs";

isolateGit();

// The wrapper's own part: Git's file list, the two cruises' ownership, the cycle groups, the generated-component
// exception, the waiting list, the messages and exit status, and ending on a signal. dependency-cruiser's own suite
// covers how it reads and resolves imports. Not told apart here (Sol r3's R3-1), though the wrapper handles each: a
// regular-file filter from an existence one (a dangling symlink), an unread file that is not code (a `.json`), and an
// unread file that only erased imports reach.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tool = fileURLToPath(new URL("./imports.mjs", import.meta.url));

/** A checkout holding `files` (path to text), committed, with the repository's `node_modules`; its folder. */
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "imports-"));
  for (const [path, text] of Object.entries({
    ".gitignore": "node_modules\n",
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*.ts", "player/**/*.ts"],
      exclude: ["player/vue/**/*.ts"],
    }),
    "player/vue/tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "bundler",
        verbatimModuleSyntax: true,
        strict: true,
        noEmit: true,
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src/**/*.ts", "src/**/*.vue"],
    }),
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return root;
}

const FILES = {
  // B1, and B2 with a built-in and a package not admitted beside an admitted one
  "src/crosses.ts":
    'import { p } from "../player/p.js";\nimport fs from "fs";\nimport { ref } from "vue";\nimport Color from "colorjs.io";\nexport const x = [p, fs, ref, Color];\n',
  "player/p.ts": "export const p = 1;\n",
  // B3, twice: player/vue/ and a built-in; the Vue project's cruise also reaches this file, through uses-adapter.ts
  "player/adapter.ts":
    'import { w } from "./vue/src/widget.js";\nimport { o } from "@/other";\nimport fs from "node:fs";\nexport const x = [w, o, fs];\n',
  "player/vue/src/widget.ts": "export const w = 1;\n",
  "player/vue/src/other.ts": "export const o = 1;\n",
  "player/vue/src/uses-adapter.ts": 'import { x } from "../../adapter";\nexport const y = x;\n',
  // a Node file may import Node's built-ins; another file in its folder may not
  "player/engine-bridge/node-host.ts":
    'import { Worker } from "node:worker_threads";\nexport const w = Worker;\n',
  "player/engine-bridge/other.ts":
    'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n',
  // a package whose name a pattern of `colorjs.io` would match, unescaped: refused
  "src/lookalike.ts": 'import x from "colorjsXio";\nexport const y = x;\n',
  "src/node_modules/colorjsXio/package.json": JSON.stringify({
    name: "colorjsXio",
    type: "module",
    exports: "./index.js",
  }),
  "src/node_modules/colorjsXio/index.js": "export default 1;\n",
  // a folder whose name starts with `src` is not `src/`
  "src-extra/a.ts": 'import { p } from "../player/p.js";\nexport const x = p;\n',
  // files Git ignores, which a cruise reaches from a tracked file of the other project: refused, both ways
  ".gitignore": "node_modules\nplayer/hidden.ts\nplayer/vue/src/hidden.ts\n",
  "player/vue/src/a.ts": 'import { h } from "../../hidden.js";\nexport const a: number = h;\n',
  "player/hidden.ts": 'import { a } from "./vue/src/a.js";\nexport const h: number = a;\n',
  "playground/a.ts": 'import { v } from "../player/vue/src/hidden.js";\nexport const a = v;\n',
  "player/vue/src/hidden.ts":
    'import { a } from "../../../playground/a.js";\nexport const v = a;\n',
  // a tracked file deleted from the working tree, without staging (the test deletes it)
  "src/deleted.ts": "export const d = 1;\n",
  // a crossing the waiting list holds
  "src/listed-cross.ts": 'import { p } from "../player/p.js";\nexport const x = p;\n',
  // a value cycle, a listed one, and a cycle through imports the compiler erases
  "src/cycle-a.ts": 'import { b } from "./cycle-b.js";\nexport const a = () => b;\n',
  "src/cycle-b.ts": 'import { a } from "./cycle-a.js";\nexport const b = () => a;\n',
  "src/listed-a.ts": 'import { b } from "./listed-b.js";\nexport const a = () => b;\n',
  "src/listed-b.ts": 'import { a } from "./listed-a.js";\nexport const b = () => a;\n',
  "src/type-a.ts": 'import type { B } from "./type-b.js";\nexport interface A { b?: B }\n',
  "src/type-b.ts": 'import type { A } from "./type-a.js";\nexport interface B { a?: A }\n',
  // erased in the root project, which owns the pair, though the Vue project's cruise, reaching it, keeps the import
  "src/inline-a.ts":
    'import { type B } from "./inline-b.js";\nexport const a = 1;\nexport type A = B;\n',
  "src/inline-b.ts":
    'import { a } from "./inline-a.js";\nexport const b = a;\nexport type B = number;\n',
  "player/vue/src/uses-inline.ts":
    'import { a } from "../../../src/inline-a.js";\nexport const u = a;\n',
  // under the Vue project's verbatimModuleSyntax, `import { type B }` still loads the module: a value cycle
  "player/vue/src/vms-a.ts":
    'import { type B } from "./vms-b";\nexport const a = 1;\nexport type A = B;\n',
  "player/vue/src/vms-b.ts":
    'import { a } from "./vms-a";\nexport const b = a;\nexport type B = number;\n',
  // shadcn-vue's shape: admitted
  "player/vue/src/components/ui/button/Button.vue":
    '<script setup lang="ts">\nimport { buttonVariants } from ".";\nconst c = buttonVariants;\n</script>\n<template><button :class="c" /></template>\n',
  "player/vue/src/components/ui/button/index.ts":
    'export { default as Button } from "./Button.vue";\nexport const buttonVariants = "b";\n',
  // the same shape reaching outside its folder: refused
  "player/vue/src/components/ui/badge/Badge.vue":
    '<script setup lang="ts">\nimport { badgeVariants } from ".";\nconst c = badgeVariants;\n</script>\n<template><span :class="c" /></template>\n',
  "player/vue/src/components/ui/badge/index.ts":
    'import { shared } from "../shared";\nexport { default as Badge } from "./Badge.vue";\nexport const badgeVariants = shared;\n',
  "player/vue/src/components/ui/shared.ts":
    'import { Badge } from "./badge";\nexport const shared = "s";\nexport const uses = Badge;\n',
  "tools/repository-checks/imports-waiting.json": JSON.stringify([
    { cycle: ["src/listed-b.ts", "src/listed-a.ts"], waits: "a test" },
    { cycle: ["src/gone-a.ts", "src/gone-b.ts"], waits: "a test" },
    { file: "src/listed-cross.ts", imports: "player/p.ts", waits: "a test" },
  ]),
};

test(
  "a crossing, a value cycle and a stale waiting entry are each refused once, and the exceptions hold",
  { timeout: 120_000 },
  () => {
    const root = checkout(FILES);
    try {
      rmSync(join(root, "src/deleted.ts"));
      const result = spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const findings = result.stderr.trim().split("\n");
      assert.equal(findings.pop(), "check:imports: 14 findings");
      // each finding once, by what it names: the Vue project's cruise reaching player/adapter.ts adds nothing
      assert.deepEqual(
        findings
          .map((line) => {
            const crossing = /^(\S+): (B\d) \(.*\): .*, but this imports '(.*)'$/u.exec(line);
            if (crossing)
              return `${crossing[1]} ${crossing[2]} ${crossing[3].replace(/^.*node_modules\/([^/]+)\/.*$/u, "package $1")}`;
            const cycle = /without cycles\): (.*): break the cycle/u.exec(line);
            if (cycle) return `cycle ${cycle[1]}`;
            return line;
          })
          .sort(),
        [
          // the root project cannot resolve `@/`; the Vue project's cruise, reaching this file, can: only the owner's reading counts
          "player/adapter.ts B3 @/other",
          "player/adapter.ts B3 fs",
          "player/adapter.ts B3 player/vue/src/widget.ts",
          "player/engine-bridge/other.ts B3 fs",
          "src/crosses.ts B1 player/p.ts",
          "src/crosses.ts B2 fs",
          "src/crosses.ts B2 package vue",
          "src/lookalike.ts B2 package colorjsXio",
          "player/hidden.ts: player/vue/src/a.ts imports it, but it is not among Git's files (ignored, or outside the list), so its own project's cruise does not read it: track it, or stop importing it",
          "player/vue/src/hidden.ts: playground/a.ts imports it, but it is not among Git's files (ignored, or outside the list), so its own project's cruise does not read it: track it, or stop importing it",
          "cycle player/vue/src/components/ui/badge/Badge.vue, player/vue/src/components/ui/badge/index.ts, player/vue/src/components/ui/shared.ts",
          "cycle player/vue/src/vms-a.ts, player/vue/src/vms-b.ts",
          "cycle src/cycle-a.ts, src/cycle-b.ts",
          "imports-waiting.json lists the cycle src/gone-a.ts, src/gone-b.ts, which no longer exists as listed: remove or correct the entry (the list only shrinks)",
        ].sort(),
      );
      assert.equal(
        result.stdout,
        "check:imports: 2 groups of files form a cycle once imports the compiler erases count (advisory, not refused); the largest, 2 files, holds src/inline-a.ts\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the groups are strongly connected components, and the generated-component exception is exactly its shape", () => {
  const edges = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["a", "d"]],
    ["d", []],
    ["e", ["e"]],
  ]);
  // one group of three, though a cycle-per-module report could name fewer; a self-import is no group of files
  assert.deepEqual(cycleGroups(edges), [["a", "b", "c"]]);
  const ui = "player/vue/src/components/ui";
  assert.equal(
    isGeneratedComponentGroup([`${ui}/button/Button.vue`, `${ui}/button/index.ts`]),
    true,
  );
  assert.equal(
    isGeneratedComponentGroup([
      `${ui}/button/Button.vue`,
      `${ui}/button/Icon.vue`,
      `${ui}/button/index.ts`,
    ]),
    true,
  );
  for (const group of [
    [`${ui}/button/Button.vue`, `${ui}/badge/index.ts`],
    [`${ui}/button/Button.vue`, `${ui}/button/helpers.ts`],
    [`${ui}/button/Button.vue`, `${ui}/button/index.ts`, `${ui}/shared.ts`],
    [`${ui}/button/a/A.vue`, `${ui}/button/a/index.ts`],
    [`${ui}/button/Button.vue`, `${ui}/button/Icon.vue`],
    ["player/vue/src/other/X.vue", "player/vue/src/other/index.ts"],
  ])
    assert.equal(isGeneratedComponentGroup(group), false, group.join(" "));
});

test("a malformed waiting list, an entry of another shape and a cruise result that is not JSON stop the check", () => {
  const root = checkout({ "src/a.ts": "export const a = 1;\n" });
  const waiting = join(root, "tools/repository-checks/imports-waiting.json");
  // a cruise that prints part of a result, then ends as if it succeeded
  const preload = join(root, "partial.mjs");
  writeFileSync(
    preload,
    'if (process.argv.includes("--cruise")) { process.stdout.write(\'{"modules":\'); process.exit(0); }\n',
  );
  const run = (env = process.env) =>
    spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8", env });
  try {
    mkdirSync(dirname(waiting), { recursive: true });
    for (const [text, message] of [
      ["[", /^check:imports: cannot read tools\/repository-checks\/imports-waiting\.json: /u],
      ["[{}]", /, entry 1, is not a list of cycles/u],
      [
        JSON.stringify([
          { cycle: ["src/a.ts", "src/b.ts"], waits: "x" },
          { file: "src/a.ts", imports: "x" },
        ]),
        /, entry 2, is not a list of cycles/u,
      ],
      [
        JSON.stringify([{ cycle: ["src/a.ts", "src/b.ts"], waits: "x", wait: "y" }]),
        /, entry 1, /u,
      ],
      [JSON.stringify({ cycle: [] }), /imports-waiting\.json is not a list of cycles/u],
    ]) {
      writeFileSync(waiting, text);
      const result = run();
      assert.equal(result.status, 2, `${text}: ${result.stderr}`);
      assert.match(result.stderr, message, text);
    }
    writeFileSync(waiting, "[]");
    const result = run({ ...process.env, NODE_OPTIONS: `--import ${preload}` });
    assert.equal(result.status, 2, result.stderr);
    assert.match(
      result.stderr,
      /^check:imports: the \w+ project's cruise printed no JSON result: /u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The cruise processes running in `root`, by their working folder. */
function cruisesIn(root) {
  const folder = realpathSync(root);
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .filter((pid) => {
      try {
        return (
          readlinkSync(`/proc/${pid}/cwd`) === folder &&
          readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--cruise")
        );
      } catch {
        return false;
      }
    });
}

test("a signal ends the check by that signal", { timeout: 120_000 }, async () => {
  const root = checkout(FILES);
  try {
    const child = spawn(process.execPath, [tool], { cwd: root, stdio: "ignore" });
    const ended = new Promise((resolve) =>
      child.on("close", (status, signal) => resolve({ status, signal })),
    );
    // while its cruises run
    const deadline = Date.now() + 20_000;
    while (cruisesIn(root).length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cruisesIn(root).length, 2, "both cruises started");
    child.kill("SIGTERM");
    assert.deepEqual(await ended, { status: null, signal: "SIGTERM" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
