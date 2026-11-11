import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROJECTS,
  UNKNOWN_TO_COSTLY,
  checksOf,
  MAIN_CHECKOUT,
  linkMainNodeModules,
  notInstalled,
  projectsFor,
  removeTemporaryWorktree,
  unknownToCostly,
} from "./check-changed.mjs";

// A representative changed path for each project, and the projects it alone needs.
const REPRESENTATIVES = {
  typescript: ["src/compiler.ts", ["typescript"]],
  "player-vue": ["player/vue/src/PlayerApp.vue", ["player-vue"]],
  "oxlint-rules": ["tools/oxlint/run.mjs", ["oxlint-rules"]],
  tools: ["tools/test-shards.mjs", ["tools"]],
  "repository checks": ["tools/repository-checks/regression-cases.mjs", ["tools"]],
  families: [
    "tests/families/copies/copy-admission/named-and-nested-composite-admission.mjs",
    ["families"],
  ],
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
  "without node_modules it can link, it runs no check, says why and the two fixes, and exits 2",
  { timeout: 30_000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "check-changed-"));
    const main = mkdtempSync(join(tmpdir(), "check-changed-main-"));
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
        env: { ...process.env, TEASESCRIPT_MAIN: main },
      });
      assert.equal(result.status, 2, result.stderr);
      assert.doesNotMatch(result.stdout, /PASS|FAIL/u);
      assert.equal(
        result.stderr,
        `check-changed: no node_modules, and ${main} has no node_modules folder (ENOENT): run \`npm ci\`, or set TEASESCRIPT_MAIN to a checkout of main that has node_modules\n`,
      );
      assert.equal(existsSync(join(directory, "node_modules")), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  },
);

/**
 * A repository with a base branch `main` and a branch `feature` off it, each changing `a.mjs` as `edit` says. `core`
 * also changes a file of the type core on `feature` ("added", or "deleted" or "renamed" out of the core, the file being
 * on `main` for those);
 * `mapper` is code the stand-in pin-suite mapper runs after its line. `passing` leaves `a.mjs` as it was and gives every
 * other check a stand-in that passes, so the mapper's verdict alone decides the run. `lock` is the lockfile's packages
 * and `installed` those the stand-in `node_modules` records as installed.
 */
function repository({
  conflict = false,
  slowOxlint = false,
  core = false,
  mapper = "",
  passing = false,
  lock = {},
  installed = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "check-changed-repo-"));
  const run = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  const write = (path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  run("init", "-q", "-b", "main");
  write("a.mjs", "export const a = 1;\n");
  write("package.json", JSON.stringify({ devDependencies: { prettier: "0.0.0" } }));
  write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...lock } }));
  write(".gitignore", "node_modules/\n");
  // (the checks the merge runs: oxlint waits when asked, so a signal meets a running check)
  write("tools/oxlint/run.mjs", slowOxlint ? "setTimeout(() => {}, 60_000);\n" : "\n");
  // (a stand-in for the pin-suite mapper that says how it was asked)
  write(
    "tools/repository-checks/pin-suites.mjs",
    `console.log(\`listed for \${process.argv.slice(2).join(" ")}\`);\n${mapper}`,
  );
  if (core === "deleted" || core === "renamed")
    write("src/type-inference/core/answers.ts", "export const answers = 1;\n");
  if (passing)
    for (const path of [
      "tools/repository-checks/doc-links.mjs",
      "tools/repository-checks/imports.mjs",
    ])
      write(path, "\n");
  run("add", ".");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  run("switch", "-q", "-c", "feature");
  if (!passing) write("a.mjs", "export const a = 2;\n");
  if (core === "added") write("src/type-inference/core/answers.ts", "export const answers = 1;\n");
  if (core === "deleted") rmSync(join(directory, "src/type-inference/core/answers.ts"));
  if (core === "renamed")
    run("mv", "src/type-inference/core/answers.ts", "src/type-inference/answers.ts");
  run("add", "-A");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feature");
  if (conflict) {
    run("switch", "-q", "main");
    write("a.mjs", "export const a = 3;\n");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "main");
    run("switch", "-q", "feature");
  }
  // A stand-in `node_modules` whose Prettier is the pinned one and does nothing.
  write(
    "node_modules/.package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages: installed }),
  );
  write("node_modules/prettier/package.json", JSON.stringify({ version: "0.0.0" }));
  write("node_modules/prettier/bin/prettier.cjs", "\n");
  if (passing) {
    write("node_modules/knip/bin/knip.js", "\n");
    write("node_modules/.bin/tsc", "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, "node_modules/.bin/tsc"), 0o755);
  }
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

test(
  "a change to the type core prints the pin-suite mapper's list, plain and merged, a deletion and a move out of it too, and another change does not run it",
  { timeout: 60_000 },
  () => {
    for (const merged of [false, true])
      for (const core of ["added", "deleted", "renamed", false]) {
        const { directory } = repository({ core });
        try {
          const result = spawnSync(
            process.execPath,
            [tool, ...(merged ? ["--merged"] : []), "--base", "main"],
            { cwd: directory, encoding: "utf8", env: environment },
          );
          const base = spawnSync("git", ["merge-base", "HEAD", "main"], {
            cwd: directory,
            encoding: "utf8",
          }).stdout.trim();
          const at = `${merged ? "merged" : "plain"}, ${core || "no core change"}`;
          if (core) {
            assert.match(
              result.stdout,
              /^PASS {2}pin suites +\d+\.\ds$/mu,
              `${at}: ${result.stderr}`,
            );
            assert.match(
              result.stdout,
              new RegExp(`--- pin suites ---\\nlisted for --base ${base}\\n`, "u"),
              at,
            );
          } else assert.doesNotMatch(result.stdout, /pin suites/u, at);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
  },
);

test(
  "the pin-suite mapper's verdict alone decides a run whose other checks pass, its output printed",
  { timeout: 30_000 },
  () => {
    for (const fails of [false, true]) {
      const { directory } = repository({
        core: "added",
        passing: true,
        mapper: fails ? 'console.error("no merge-base"); process.exitCode = 2;\n' : "",
      });
      try {
        const result = spawnSync(process.execPath, [tool, "--base", "main"], {
          cwd: directory,
          encoding: "utf8",
          env: environment,
        });
        assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
        assert.deepEqual(
          result.stdout.match(/^FAIL {2}\S.*$/gmu)?.map((line) => line.split(/ {2,}/u)[1]) ?? [],
          fails ? ["pin suites"] : [],
        );
        // (its stdout and stderr arrive in either order)
        if (fails) assert.match(result.stdout, /--- pin suites ---\n[^]*no merge-base\n/u);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  "a changed type-core test file that costly-test-files does not list prints one line, and fails nothing (#2088)",
  { timeout: 30_000 },
  () => {
    assert.equal(
      UNKNOWN_TO_COSTLY,
      "unknown to costly-test-files: run in full; the entry lands from CI at merge",
    );
    // (only a type-core test file the table lacks is unknown: the table lists every one, and another file only at 10 s
    // or more)
    assert.deepEqual(
      unknownToCostly([
        "tests/type-core-unlisted.test.ts",
        "tests/type-core/type-core-cells.test.ts",
        "tests/unlisted-other.test.ts",
        "tests/helpers/type-core-unlisted.ts",
        "src/type-inference/core/type-core-unlisted.test.ts",
      ]),
      ["tests/type-core-unlisted.test.ts"],
    );
    for (const file of [
      "tests/type-core-unlisted.test.ts",
      "tests/type-core/type-core-cells.test.ts",
    ]) {
      const { directory } = repository({ passing: true });
      try {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), "\n");
        const result = spawnSync(process.execPath, [tool, "--base", "main"], {
          cwd: directory,
          encoding: "utf8",
          env: environment,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const lines = result.stdout.split("\n").filter((line) => line.includes(UNKNOWN_TO_COSTLY));
        assert.deepEqual(
          lines,
          file.includes("unlisted") ? [`${file}: ${UNKNOWN_TO_COSTLY}`] : [],
          result.stdout + result.stderr,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  "the node_modules link it makes is no change: under the tracked ignore rules alone, a docs change selects no project",
  { timeout: 60_000 },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "check-changed-ignored-")));
    const repo = join(root, "repo");
    try {
      mkdirSync(join(root, "main", "node_modules"), { recursive: true });
      mkdirSync(repo);
      const git = (...args) =>
        spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
          cwd: repo,
          encoding: "utf8",
        });
      git("init", "-q");
      // the repository's own ignore rules, and no local exclude
      writeFileSync(
        join(repo, ".gitignore"),
        readFileSync(new URL("../.gitignore", import.meta.url)),
      );
      writeFileSync(join(repo, ".git", "info", "exclude"), "");
      git("add", ".gitignore");
      git("commit", "-q", "-m", "base");
      writeFileSync(join(repo, "README.md"), "docs\n");
      const tool = fileURLToPath(new URL("./check-changed.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [tool, "--base", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, TEASESCRIPT_MAIN: join(root, "main") },
      });
      const [linked, changed] = result.stdout.split("\n");
      assert.equal(
        linked,
        `check-changed: linked node_modules from ${join(root, "main", "node_modules")}`,
      );
      assert.match(
        changed,
        /^check-changed: 1 changed files since HEAD \([0-9a-f]{9}\); projects: none$/u,
        result.stdout,
      );
      assert.equal(git("status", "--porcelain").stdout, "?? README.md\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("it links the node_modules main's checkout has, replaces only a stale link, and refuses anything else", () => {
  assert.equal(MAIN_CHECKOUT, "/opt/teasescript-agents/teasescript-main/current");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-changed-link-")));
  const repo = join(root, "repo");
  const target = join(repo, "node_modules");
  const checkout = (name) => {
    mkdirSync(join(root, name, "node_modules"), { recursive: true });
    writeFileSync(join(root, name, "node_modules", "id"), name);
    return join(root, name);
  };
  const linked = () => readFileSync(join(target, "id"), "utf8");
  try {
    mkdirSync(repo);
    // it links: the default when unset or empty, and a relative name as the system opens it (a link before `..`)
    const lxc = checkout("lxc");
    for (const env of [{}, { TEASESCRIPT_MAIN: "" }]) {
      assert.equal(
        linkMainNodeModules(env, repo, lxc),
        `linked node_modules from ${lxc}/node_modules`,
      );
      assert.equal(linked(), "lxc");
      rmSync(target);
    }
    mkdirSync(join(root, "slots", "current"), { recursive: true });
    symlinkSync(join(root, "slots", "current"), join(repo, "link"));
    checkout("slots/x");
    checkout("repo/x");
    linkMainNodeModules({ TEASESCRIPT_MAIN: "./link/../x" }, repo);
    assert.equal(linked(), "slots/x");
    rmSync(target);
    // a link through main's `current` follows it when the refresh switches it to the other slot (#2087)
    checkout("main/slot-a");
    checkout("main/slot-b");
    const current = join(root, "main", "current");
    symlinkSync("slot-a", current);
    linkMainNodeModules({ TEASESCRIPT_MAIN: current }, repo);
    assert.equal(linked(), "main/slot-a");
    rmSync(current);
    symlinkSync("slot-b", current);
    assert.equal(linked(), "main/slot-b");
    rmSync(target);
    // it refuses by name a checkout without a node_modules folder, and links nothing
    writeFileSync(join(root, "file"), "");
    mkdirSync(join(root, "bare"));
    mkdirSync(join(root, "modules-file"));
    writeFileSync(join(root, "modules-file", "node_modules"), "");
    for (const [name, code] of [
      ["absent", "ENOENT"],
      ["file", "ENOTDIR"],
      ["bare", "ENOENT"],
      ["modules-file", "not a folder"],
    ])
      assert.throws(() => linkMainNodeModules({ TEASESCRIPT_MAIN: join(root, name) }, repo), {
        message: `no node_modules, and ${join(root, name)} has no node_modules folder (${code}): run \`npm ci\`, or set TEASESCRIPT_MAIN to a checkout of main that has node_modules`,
      });
    assert.equal(existsSync(target), false);
    // it replaces a link whose target is gone, or whose target's parent is a file
    for (const gone of [join(root, "gone"), join(root, "file", "below")]) {
      symlinkSync(gone, target);
      assert.equal(
        linkMainNodeModules({}, repo, lxc),
        `replaced a stale link with node_modules from ${lxc}/node_modules`,
      );
      assert.equal(linked(), "lxc");
      rmSync(target);
    }
    // it leaves anything else there as it is: a link it may not open, a loop, a live link, a folder, a file
    mkdirSync(join(root, "denied", "node_modules"), { recursive: true });
    for (const make of [
      () => {
        symlinkSync(join(root, "denied", "node_modules"), target);
        chmodSync(join(root, "denied"), 0);
      },
      () => symlinkSync(target, target),
      () => symlinkSync(join(lxc, "node_modules"), target),
      () => mkdirSync(target),
      () => writeFileSync(target, "kept"),
    ]) {
      make();
      const before = lstatSync(target);
      try {
        assert.throws(() => linkMainNodeModules({}, repo, lxc), {
          message:
            /^no node_modules, and node_modules is there but is no link whose target is gone, so it is left as it is: /u,
        });
        assert.deepEqual(
          [lstatSync(target).ino, lstatSync(target).mtimeMs],
          [before.ino, before.mtimeMs],
        );
      } finally {
        chmodSync(join(root, "denied"), 0o755);
        rmSync(target, { recursive: true, force: true });
      }
    }
  } finally {
    if (existsSync(join(root, "denied"))) chmodSync(join(root, "denied"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test("notInstalled names each lockfile package the install lacks or holds otherwise, and refuses a lockfile without packages", () => {
  const remark = {
    version: "15.0.1",
    resolved: "https://registry.npmjs.org/remark/-/remark-15.0.1.tgz",
    integrity: "sha512-a",
  };
  const platform = { version: "1.0.0", resolved: "r", integrity: "i", optional: true };
  const lock = {
    packages: {
      "": { name: "root" },
      "node_modules/remark": remark,
      "node_modules/@x/linux": platform,
    },
  };
  // as the lockfile names it, its root and another platform's optional package not installed, and extra packages
  assert.deepEqual(
    notInstalled(lock, {
      packages: { "node_modules/remark": remark, "node_modules/extra": remark },
    }),
    [],
  );
  // missing, another version, another tarball (`resolved`, `integrity`), or no install record at all
  for (const [installed, expected] of [
    [{}, ["node_modules/remark 15.0.1 (not installed)"]],
    [{ packages: {} }, ["node_modules/remark 15.0.1 (not installed)"]],
    [
      { packages: { "node_modules/remark": { ...remark, version: "15.0.0" } } },
      ["node_modules/remark 15.0.1 (installed: 15.0.0)"],
    ],
    [
      { packages: { "node_modules/remark": { ...remark, resolved: "elsewhere" } } },
      ["node_modules/remark 15.0.1 (installed: 15.0.1)"],
    ],
    [
      { packages: { "node_modules/remark": { ...remark, integrity: "sha512-b" } } },
      ["node_modules/remark 15.0.1 (installed: 15.0.1)"],
    ],
  ])
    assert.deepEqual(notInstalled(lock, installed), expected);
  // an optional package installed at another version is no install of the lockfile either
  assert.deepEqual(
    notInstalled(lock, {
      packages: {
        "node_modules/remark": remark,
        "node_modules/@x/linux": { ...platform, version: "0.9.0" },
      },
    }),
    ["node_modules/@x/linux 1.0.0 (installed: 0.9.0)"],
  );
  for (const unknown of [{}, { lockfileVersion: 1, dependencies: {} }, { packages: null }])
    assert.throws(() => notInstalled(unknown, { packages: {} }), {
      message: "package-lock.json has no `packages` to compare node_modules with",
    });
});

test("notInstalled excuses an absent optional package only when its os, cpu or libc exclude the host, or nothing recorded needs it (Sol final r3 on #2322)", () => {
  const host = { os: "linux", cpu: "x64", libc: "glibc" };
  const tool = (extra) => ({
    version: "1.0.0",
    resolved: "t",
    integrity: "i",
    optionalDependencies: {
      "@x/binding-linux-x64-gnu": "1",
      "@x/binding-darwin-arm64": "1",
      "@x/binding-linux-x64-musl": "1",
      "@x/binding-not-windows": "1",
      "@x/wasm": "1",
    },
    ...extra,
  });
  const binding = (os, cpu, libc) => ({
    version: "1.0.0",
    resolved: "b",
    integrity: "i",
    optional: true,
    os,
    cpu,
    ...(libc === undefined ? {} : { libc }),
  });
  const lock = {
    packages: {
      "": { devDependencies: { x: "1" } },
      "node_modules/x": tool(),
      "node_modules/@x/binding-linux-x64-gnu": binding(["linux"], ["x64"], ["glibc"]),
      "node_modules/@x/binding-linux-x64-musl": binding(["linux"], ["x64"], ["musl"]),
      "node_modules/@x/binding-darwin-arm64": binding(["darwin"], ["arm64"]),
      "node_modules/@x/binding-not-windows": binding(["!win32"], ["x64"]),
      // (the WebAssembly binding, excluded by its cpu, and a helper only it needs, with no platform field)
      "node_modules/@x/wasm": { ...binding(undefined, ["wasm32"]), dependencies: { helper: "1" } },
      "node_modules/helper": { version: "1.0.0", resolved: "h", integrity: "i", optional: true },
    },
  };
  const record = (...paths) => ({
    packages: Object.fromEntries(paths.map((path) => [path, lock.packages[path]])),
  });
  // a correct install on this host: its binding recorded; another platform's, the musl one and the wasm side absent
  assert.deepEqual(
    notInstalled(lock, record("node_modules/x", "node_modules/@x/binding-linux-x64-gnu"), host),
    ["node_modules/@x/binding-not-windows 1.0.0 (not installed)"],
  );
  const complete = record(
    "node_modules/x",
    "node_modules/@x/binding-linux-x64-gnu",
    "node_modules/@x/binding-not-windows",
  );
  assert.deepEqual(notInstalled(lock, complete, host), []);
  // this host's binding absent, which its tool needs: missing, like any other package
  assert.deepEqual(
    notInstalled(lock, record("node_modules/x", "node_modules/@x/binding-not-windows"), host),
    ["node_modules/@x/binding-linux-x64-gnu 1.0.0 (not installed)"],
  );
  // a helper with no platform field: absent is fine while only an excluded package needs it, missing once a recorded
  // one does
  const needed = structuredClone(lock);
  needed.packages["node_modules/x"].dependencies = { helper: "1" };
  assert.deepEqual(notInstalled(needed, complete, host), [
    "node_modules/helper 1.0.0 (not installed)",
  ]);
  // the same lockfile on a musl host or a Mac: their own binding is the needed one
  assert.deepEqual(notInstalled(lock, complete, { os: "linux", cpu: "x64", libc: "musl" }), [
    "node_modules/@x/binding-linux-x64-musl 1.0.0 (not installed)",
  ]);
  assert.deepEqual(notInstalled(lock, complete, { os: "darwin", cpu: "arm64", libc: null }), [
    "node_modules/@x/binding-darwin-arm64 1.0.0 (not installed)",
  ]);
});

test("notInstalled reads a libc field as npm does: it excludes a host without a C library it knows, off Linux or not (Sol r4 on #2322)", () => {
  const glibcOnly = {
    version: "1.0.0",
    resolved: "g",
    integrity: "i",
    optional: true,
    libc: ["glibc"],
  };
  const lock = {
    packages: { "": { optionalDependencies: { g: "1" } }, "node_modules/g": glibcOnly },
  };
  const none = { packages: {} };
  // absent: missing on glibc Linux, which it applies to; excluded on musl, on a Mac and on a Linux of unknown libc
  assert.deepEqual(notInstalled(lock, none, { os: "linux", cpu: "x64", libc: "glibc" }), [
    "node_modules/g 1.0.0 (not installed)",
  ]);
  for (const host of [
    { os: "linux", cpu: "x64", libc: "musl" },
    { os: "darwin", cpu: "arm64", libc: null },
    { os: "linux", cpu: "x64", libc: null },
  ])
    assert.deepEqual(notInstalled(lock, none, host), [], JSON.stringify(host));
});

/** What a refusal of a node_modules whose record does not hold the lockfile says to do. */
const REMEDIES =
  "Main's lockfile: wait for teasescript-main's refresh, and remove a node_modules link pinned to a slot instead of " +
  "`current` (check-changed then links `current`). A branch behind main's lockfile: rebase, or check with --merged. " +
  "A lockfile the branch changes: run the checks in the queue. Your own node_modules: run `npm ci`";

test(
  "with a node_modules that does not install the lockfile it runs no check, plain or merged, says what differs, and exits 2 (#2087)",
  { timeout: 60_000 },
  () => {
    const remark = { version: "15.0.1", resolved: "r", integrity: "i" };
    const platform = { version: "1.0.0", resolved: "p", integrity: "i", optional: true };
    const lock = { "node_modules/remark": remark, "node_modules/@x/linux": platform };
    for (const merged of [false, true])
      for (const [installed, what] of [
        [{}, "node_modules/remark 15.0.1 (not installed)"],
        [
          { "node_modules/remark": { ...remark, version: "15.0.0" } },
          "node_modules/remark 15.0.1 (installed: 15.0.0)",
        ],
        [null, "it has no .package-lock.json, which npm writes at each install"],
        [{ "node_modules/remark": remark }, null],
      ]) {
        const { directory } = repository({ passing: true, lock, installed: installed ?? {} });
        try {
          if (installed === null) rmSync(join(directory, "node_modules/.package-lock.json"));
          const result = spawnSync(
            process.execPath,
            [tool, ...(merged ? ["--merged"] : []), "--base", "main"],
            { cwd: directory, encoding: "utf8", env: environment },
          );
          const at = `${merged ? "merged" : "plain"}, ${what}`;
          if (what === null) {
            assert.equal(result.status, 0, `${at}: ${result.stdout}${result.stderr}`);
            continue;
          }
          assert.equal(result.status, 2, at);
          assert.doesNotMatch(result.stdout, /PASS|FAIL/u, at);
          assert.equal(
            result.stderr,
            `check-changed: npm's record of node_modules (${realpathSync(join(directory, "node_modules"))}) does ` +
              `not hold package-lock.json: ${what}. ${REMEDIES}\n`,
            at,
          );
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
  },
);

test(
  "a node_modules link switched while the checks run to an install of another lockfile voids their verdicts: exit 2 (#2087)",
  { timeout: 30_000 },
  () => {
    const remark = { version: "15.0.1", resolved: "r", integrity: "i" };
    for (const switchedTo of [{}, { "node_modules/remark": remark }]) {
      const { directory } = repository({
        passing: true,
        lock: { "node_modules/remark": remark },
        installed: { "node_modules/remark": remark },
      });
      try {
        // as teasescript-main's refresh does to `current`: the stand-in knip, a check, re-points the link to install b
        const installs = join(directory, "..", `${basename(directory)}-installs`);
        mkdirSync(installs);
        cpSync(join(directory, "node_modules"), join(installs, "a"), { recursive: true });
        cpSync(join(directory, "node_modules"), join(installs, "b"), { recursive: true });
        rmSync(join(directory, "node_modules"), { recursive: true });
        symlinkSync(join(installs, "a"), join(directory, "node_modules"));
        // (the stand-in repository ignores a node_modules folder, not a link)
        writeFileSync(join(directory, ".git", "info", "exclude"), "node_modules\n");
        writeFileSync(
          join(installs, "b", ".package-lock.json"),
          JSON.stringify({ lockfileVersion: 3, packages: switchedTo }),
        );
        writeFileSync(
          join(installs, "a", "knip", "bin", "knip.js"),
          'import { rmSync, symlinkSync } from "node:fs";\n' +
            `rmSync("node_modules"); symlinkSync(${JSON.stringify(join(installs, "b"))}, "node_modules");\n`,
        );
        const result = spawnSync(process.execPath, [tool, "--base", "main"], {
          cwd: directory,
          encoding: "utf8",
          env: environment,
        });
        rmSync(installs, { recursive: true, force: true });
        if (switchedTo["node_modules/remark"] !== undefined) {
          assert.equal(result.status, 0, result.stdout + result.stderr);
          continue;
        }
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stdout, /^PASS {2}knip /mu);
        assert.equal(
          result.stderr,
          "check-changed: node_modules changed while the checks ran, so their verdicts do not count: " +
            `npm's record of node_modules (${join(installs, "b")}) does not hold package-lock.json: ` +
            `node_modules/remark 15.0.1 (not installed). ${REMEDIES}\n`,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  "with this host's platform binding absent from the install record it runs no check and exits 2; another platform's absent passes (Sol final r3 on #2322)",
  { timeout: 60_000 },
  () => {
    const entry = (extra) => ({ version: "1.0.0", resolved: "r", integrity: "i", ...extra });
    const binding = (os, cpu) => entry({ optional: true, os: [os], cpu: [cpu] });
    const lock = {
      "node_modules/x": entry({
        optionalDependencies: { "@x/binding-here": "1", "@x/binding-elsewhere": "1" },
      }),
      "node_modules/@x/binding-here": binding(process.platform, process.arch),
      "node_modules/@x/binding-elsewhere": binding(
        process.platform === "aix" ? "sunos" : "aix",
        "ppc64",
      ),
    };
    for (const [installed, status] of [
      [["node_modules/x", "node_modules/@x/binding-here"], 0],
      [["node_modules/x"], 2],
    ]) {
      const { directory } = repository({
        passing: true,
        lock,
        installed: Object.fromEntries(installed.map((path) => [path, lock[path]])),
      });
      try {
        const result = spawnSync(process.execPath, [tool, "--base", "main"], {
          cwd: directory,
          encoding: "utf8",
          env: environment,
        });
        assert.equal(result.status, status, result.stdout + result.stderr);
        if (status === 2) {
          assert.doesNotMatch(result.stdout, /PASS|FAIL/u);
          assert.match(
            result.stderr,
            /does not hold package-lock\.json: node_modules\/@x\/binding-here 1\.0\.0 \(not installed\)\. /u,
          );
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);
