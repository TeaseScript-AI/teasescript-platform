import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROJECTS, checksOf, projectsFor, removeTemporaryWorktree } from "./check-changed.mjs";

// A representative changed path for each project, and the projects it alone needs.
const REPRESENTATIVES = {
  typescript: ["src/compiler.ts", ["typescript"]],
  "player-vue": ["player/vue/src/PlayerApp.vue", ["player-vue"]],
  "oxlint-rules": ["tools/oxlint/run.mjs", ["oxlint-rules"]],
  tools: ["tools/test-shards.mjs", ["tools"]],
  "repository checks": ["tools/repository-checks/regression-cases.mjs", ["tools"]],
  families: ["tests/families/copies/1313-astra-composite-cases.mjs", ["families"]],
  fixtures: ["tests/fixtures/type-core/cells.jsonl", ["typescript"]],
  documentation: ["docs/TESTING.md", []],
  // root configuration files, each needing the projects whose checks read it
  "root tsconfig": ["tsconfig.json", ["typescript", "oxlint-rules", "design-lint"]],
  "Player tsconfig": ["player/vue/tsconfig.json", ["player-vue", "design-lint"]],
  "knip config": ["knip.json", ["tools"]],
  formatting: [".prettierrc.json", ["formatting"]],
  "Prettier ignore file": [".prettierignore", ["formatting"]],
  "design-lint": ["eslint.design.config.mjs", ["design-lint"]],
  "oxlint config": [".oxlintrc.json", []],
  unknown: [".github/workflows/ci.yml", Object.keys(PROJECTS)],
  "package manifest": ["package.json", Object.keys(PROJECTS)],
};

test(
  "each changed path needs its project's checks, documentation and oxlint's configuration none, and an unknown path every project's",
  { timeout: 30_000 },
  () => {
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
    // A check that several projects name runs once: `lint:design` is the Player's and the design lint's.
    const everyCheck = checksOf(projectsFor([".github/workflows/ci.yml"]));
    assert.deepEqual(everyCheck, [
      ...new Set(Object.values(PROJECTS).flatMap(({ checks }) => checks)),
    ]);
    assert.equal(everyCheck.filter((check) => check === "lint:design").length, 1);
  },
);

test(
  "without node_modules it runs no check, names the fix and exits 2",
  { timeout: 30_000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "check-changed-"));
    try {
      const run = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      run("init", "-q");
      run(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "base",
      );
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
  },
);

/** A repository with a base branch `main` and a branch `feature` off it, each changing `a.mjs` as `edit` says. */
function repository({ conflict = false, slowOxlint = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "check-changed-repo-"));
  const run = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  const write = (path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  run("init", "-q", "-b", "main");
  write("a.mjs", "export const a = 1;\n");
  write("package.json", JSON.stringify({ devDependencies: { prettier: "0.0.0" } }));
  write("package-lock.json", "{}\n");
  write(".gitignore", "node_modules/\n");
  // (the checks the merge runs: oxlint waits when asked, so a signal meets a running check)
  write("tools/oxlint/run.mjs", slowOxlint ? "setTimeout(() => {}, 60_000);\n" : "\n");
  run("add", ".");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  run("switch", "-q", "-c", "feature");
  write("a.mjs", "export const a = 2;\n");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "feature");
  if (conflict) {
    run("switch", "-q", "main");
    write("a.mjs", "export const a = 3;\n");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "main");
    run("switch", "-q", "feature");
  }
  // A stand-in `node_modules` whose Prettier is the pinned one and does nothing.
  write("node_modules/prettier/package.json", JSON.stringify({ version: "0.0.0" }));
  write("node_modules/prettier/bin/prettier.cjs", "\n");
  return { directory, worktrees: () => run("worktree", "list").stdout.trim().split("\n").length };
}

const tool = fileURLToPath(new URL("./check-changed.mjs", import.meta.url));
// Each run gets a temporary folder of its own (`TMPDIR`), so other runs of the tool on this machine cannot change what
// is left in it. (Without `agent-prettier` on `PATH`, so the stand-in Prettier runs wherever the test does.)
const runTmp = mkdtempSync(join(tmpdir(), "check-changed-test-"));
process.on("exit", () => rmSync(runTmp, { recursive: true, force: true }));
const environment = {
  ...process.env,
  TMPDIR: runTmp,
  PATH: dirname(process.execPath) + ":/usr/bin:/bin",
};
const leftovers = () =>
  readdirSync(runTmp).filter((name) => name.startsWith("check-changed-merged-"));

test(
  "--merged checks the merge in a temporary worktree and removes it",
  { timeout: 30_000 },
  () => {
    const { directory, worktrees } = repository();
    const before = leftovers();
    try {
      const result = spawnSync(process.execPath, [tool, "--merged", "--base", "main"], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      assert.match(result.stdout, /the merge of HEAD \(\w+\) into main/u, result.stderr);
      assert.match(result.stdout, /1 changed files/u);
      assert.equal(worktrees(), 1, "only the repository's own worktree is left");
      assert.deepEqual(leftovers(), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("--merged names a conflict, exits 2 and leaves no worktree", { timeout: 30_000 }, () => {
  const { directory, worktrees } = repository({ conflict: true });
  try {
    const result = spawnSync(process.execPath, [tool, "--merged", "--base", "main"], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /does not merge into main .*a\.mjs/u);
    assert.doesNotMatch(result.stdout, /PASS|FAIL/u);
    assert.equal(worktrees(), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a signal during --merged stops the checks and removes the worktree",
  { timeout: 30_000 },
  async () => {
    const { directory, worktrees } = repository({ slowOxlint: true });
    try {
      const child = spawn(process.execPath, [tool, "--merged", "--base", "main"], {
        cwd: directory,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      // (the worktree exists once the merge line is out)
      let ended = false;
      child.on("close", () => (ended = true));
      while (!output.includes("the merge of HEAD") && !ended)
        await new Promise((wait) => setTimeout(wait, 50));
      assert.ok(!ended, "the tool reached its checks");
      const [code] = await Promise.all([
        new Promise((done) => child.on("close", (exit) => done(exit))),
        Promise.resolve(child.kill("SIGTERM")),
      ]);
      assert.equal(code, 143);
      assert.equal(worktrees(), 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "only a registered temporary worktree of check-changed is ever removed",
  { timeout: 30_000 },
  () => {
    const { directory } = repository();
    const elsewhere = mkdtempSync(join(tmpdir(), "not-check-changed-"));
    const unregistered = mkdtempSync(join(tmpdir(), "check-changed-merged-"));
    try {
      for (const path of [elsewhere, unregistered, `${unregistered}/../${basename(elsewhere)}`]) {
        assert.match(removeTemporaryWorktree(path, directory), /is not a/u, path);
        assert.ok(existsSync(path), `${path} was left`);
      }
    } finally {
      for (const path of [directory, elsewhere, unregistered])
        rmSync(path, { recursive: true, force: true });
    }
  },
);
