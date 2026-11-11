import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  openSync,
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
  CannotRun,
  PROJECTS,
  UNKNOWN_TO_COSTLY,
  checksOf,
  MAIN_CHECKOUT,
  branchedFrom,
  linkMainNodeModules,
  notInstalled,
  projectsFor,
  removeTemporaryWorktree,
  strayMerges,
  unknownToCostly,
} from "./check-changed.mjs";
import {
  awaitFile,
  BOUND_SECONDS,
  bounded,
  runSync,
  slowReader,
  waitFor,
} from "./runner-test-support.mjs";

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

test("each changed path needs its project's checks, documentation and oxlint's configuration none, and an unknown path every project's", () => {
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
});

test("without node_modules it can link, it runs no check, says why and the two fixes, and exits 2", () => {
  const directory = mkdtempSync(join(tmpdir(), "check-changed-"));
  const main = mkdtempSync(join(tmpdir(), "check-changed-main-"));
  try {
    const run = (...args) => runSync("git", args, { cwd: directory, encoding: "utf8" });
    run("init", "-q");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    writeFileSync(join(directory, "a.mjs"), "export const a = 1;\n");
    const tool = fileURLToPath(new URL("./check-changed.mjs", import.meta.url));
    const result = runSync(process.execPath, [tool, "--base", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, TEASESCRIPT_MAIN: main },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stdout, /PASS|FAIL/u);
    assert.equal(result.stdout, "check-changed: ran: none; failed: none; not run: every check\n");
    assert.equal(
      result.stderr,
      `check-changed: no node_modules, and ${main} has no node_modules folder (ENOENT): run \`npm ci\`, or set TEASESCRIPT_MAIN to a checkout of main that has node_modules\n`,
    );
    assert.equal(existsSync(join(directory, "node_modules")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  }
});

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
  const run = (...args) => runSync("git", args, { cwd: directory, encoding: "utf8" });
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
  write(
    "tools/oxlint/run.mjs",
    slowOxlint ? `${awaitFile("release-oxlint", "the test to release oxlint")}\n` : "\n",
  );
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

test("--merged checks the merge in a temporary worktree and removes it", () => {
  const { directory, worktrees } = repository();
  const before = leftovers();
  try {
    const result = runSync(process.execPath, [tool, "--merged", "--base", "main"], {
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
});

test("--merged names a conflict, exits 2 and leaves no worktree", () => {
  const { directory, worktrees } = repository({ conflict: true });
  try {
    const result = runSync(process.execPath, [tool, "--merged", "--base", "main"], {
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

test("a signal during --merged stops the checks and removes the worktree; more during that cleanup change nothing (#2106)", async (t) => {
  // (a git whose worktree removal marks its start and waits for the test's release, so the signals land during it)
  const slowGit = mkdtempSync(join(tmpdir(), "check-changed-slow-git-"));
  const git = runSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(slowGit, "git"),
    `#!/bin/sh\ncase "$*" in *"worktree remove"*) : > "${slowGit}/removing"; i=0; ` +
      `while [ ! -e "${slowGit}/release" ]; do i=$((i + 1)); [ "$i" -gt ${BOUND_SECONDS * 50} ] && exit 1; ` +
      `sleep 0.02; done;; esac\nexec ${git} "$@"\n`,
  );
  chmodSync(join(slowGit, "git"), 0o755);
  try {
    for (const more of [false, true]) {
      const { directory, worktrees } = repository({ slowOxlint: true });
      rmSync(join(slowGit, "removing"), { force: true });
      rmSync(join(slowGit, "release"), { force: true });
      try {
        const child = spawn(process.execPath, [tool, "--merged", "--base", "main"], {
          cwd: directory,
          env: { ...environment, PATH: `${slowGit}:${environment.PATH}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
        t.after(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        const closed = new Promise((done) => child.on("close", done));
        // (the worktree exists once the merge line is out)
        await waitFor("the merge's worktree", () => output.includes("the merge of HEAD"), child);
        child.kill("SIGTERM");
        await waitFor(
          "the worktree's removal to start",
          () => existsSync(join(slowGit, "removing")),
          child,
        );
        // (three more while the removal waits: a process that stopped handling them would die of one)
        if (more)
          for (let index = 0; index < 3; index += 1) {
            child.kill("SIGTERM");
            await new Promise((wait) => setTimeout(wait, 20));
          }
        writeFileSync(join(slowGit, "release"), "");
        assert.equal(await bounded(closed, "check-changed to end"), 143, output);
        // (its last line still says what ran: oxlint, which waits, was stopped, so it did not run: #2106)
        const last = output.trimEnd().split("\n").at(-1);
        assert.match(
          last,
          /^check-changed: ran: [^;]*; failed: [^;]*; not run: (?:[^;]+, )?oxlint, (?:[^;]+, )?the compiled test suite \(CI runs it\)$/u,
          `${more ? "more signals" : "one signal"}: ${output}`,
        );
        assert.equal(output.split(last).length, 2, output);
        assert.doesNotMatch(last.split("; not run:")[0], /oxlint/u);
        assert.equal(worktrees(), 1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(slowGit, { recursive: true, force: true });
  }
});

test("only a registered temporary worktree of check-changed is ever removed", () => {
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
});

test("a change to the type core prints the pin-suite mapper's list, plain and merged, a deletion and a move out of it too, and another change does not run it", () => {
  for (const merged of [false, true])
    for (const core of ["added", "deleted", "renamed", false]) {
      const { directory } = repository({ core });
      try {
        const result = runSync(
          process.execPath,
          [tool, ...(merged ? ["--merged"] : []), "--base", "main"],
          { cwd: directory, encoding: "utf8", env: environment },
        );
        const base = runSync("git", ["merge-base", "HEAD", "main"], {
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
});

test("the pin-suite mapper's verdict alone decides a run whose other checks pass, its output printed", () => {
  for (const fails of [false, true]) {
    const { directory } = repository({
      core: "added",
      passing: true,
      mapper: fails ? 'console.error("no merge-base"); process.exitCode = 2;\n' : "",
    });
    try {
      const result = runSync(process.execPath, [tool, "--base", "main"], {
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
});

test("a changed type-core test file that costly-test-files does not list prints one line, and fails nothing (#2088)", () => {
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
      const result = runSync(process.execPath, [tool, "--base", "main"], {
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
});

test("the node_modules link it makes is no change: under the tracked ignore rules alone, a docs change selects no project", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-changed-ignored-")));
  const repo = join(root, "repo");
  try {
    mkdirSync(join(root, "main", "node_modules"), { recursive: true });
    mkdirSync(repo);
    const git = (...args) =>
      runSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
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
    const result = runSync(process.execPath, [tool, "--base", "HEAD"], {
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
});

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

test("run as a lone copy outside its checkout, it says it needs its checkout in one line and exits 2 (#2366)", () => {
  const folder = mkdtempSync(join(tmpdir(), "check-changed-alone-"));
  try {
    const copy = join(folder, "check-changed.mjs");
    writeFileSync(copy, readFileSync(new URL("./check-changed.mjs", import.meta.url)));
    const result = runSync(process.execPath, [copy], { cwd: folder, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "check-changed: run it from its checkout, whose tools/ holds the modules it imports (Cannot find module " +
        `'${join(folder, "costly-test-files.mjs")}' imported from ${copy}); on a branch that predates it, run main's ` +
        "from your worktree: node /opt/teasescript-agents/teasescript-main/current/tools/check-changed.mjs\n",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
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

test("with a node_modules that does not install the lockfile it runs no check, plain or merged, says what differs, and exits 2 (#2087)", () => {
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
        const result = runSync(
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
});

test("a node_modules link switched while the checks run to an install of another lockfile voids their verdicts: exit 2, before the last line (#2087)", () => {
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
      // (stdout and stderr on one file, so their order is the order of the writes)
      const log = `${installs}.log`;
      const descriptor = openSync(log, "w");
      const result = runSync(process.execPath, [tool, "--base", "main"], {
        cwd: directory,
        env: environment,
        stdio: ["ignore", descriptor, descriptor],
      });
      closeSync(descriptor);
      const output = readFileSync(log, "utf8");
      rmSync(log);
      rmSync(installs, { recursive: true, force: true });
      if (switchedTo["node_modules/remark"] !== undefined) {
        assert.equal(result.status, 0, output);
        continue;
      }
      assert.equal(result.status, 2, output);
      assert.match(output, /^PASS {2}knip /mu);
      // the refusal, then the last line, last (#2106)
      const message =
        "check-changed: node_modules changed while the checks ran, so their verdicts do not count: " +
        `npm's record of node_modules (${join(installs, "b")}) does not hold package-lock.json: ` +
        `node_modules/remark 15.0.1 (not installed). ${REMEDIES}\n`;
      assert.equal(output.split(message).length, 2, output);
      assert.match(
        output.split(message)[1],
        /^\ncheck-changed: ran: [^\n]*; failed: none; not run: [^\n]*the compiled test suite \(CI runs it\)\n$/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("with this host's platform binding absent from the install record it runs no check and exits 2; another platform's absent passes (Sol final r3 on #2322)", () => {
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
      const result = runSync(process.execPath, [tool, "--base", "main"], {
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
});

test("its last line names what ran, what failed, and what it did not run: the checks no changed path needs and the compiled suite (#2106)", () => {
  for (const fails of [false, true]) {
    const { directory } = repository({
      core: "added",
      passing: true,
      mapper: fails ? "process.exitCode = 1;\n" : "",
    });
    try {
      const result = runSync(process.execPath, [tool, "--base", "main"], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
      assert.equal(
        result.stdout.trimEnd().split("\n").at(-1),
        "check-changed: ran: diff --check, merge commits, format, oxlint, knip, doc links, imports, pin suites, tsc; " +
          `failed: ${fails ? "pin suites" : "none"}; ` +
          "not run: test:families, typecheck:player, lint:design, test:lint, test:verification, format:check, " +
          "test:lint:design, the compiled test suite (CI runs it)",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test(
  "a signal while the last line waits for a slow reader changes neither the verdict nor the last line, which comes once (#2106)",
  { skip: process.platform === "win32" },
  async (t) => {
    const { directory } = repository({
      core: "added",
      passing: true,
      mapper: "process.exitCode = 1;\n",
    });
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // (the FIFO's and the preload's own files are no change)
    writeFileSync(
      join(directory, ".git", "info", "exclude"),
      "stdout.fifo\nmark-last-line.mjs\nlast-line\n",
    );
    const result = await slowReader(t, {
      cwd: directory,
      args: [tool, "--base", "main"],
      env: environment,
      signalsBefore: false,
    });
    const last =
      "check-changed: ran: diff --check, merge commits, format, oxlint, knip, doc links, imports, pin suites, tsc; " +
      "failed: pin suites; not run: test:families, typecheck:player, lint:design, test:lint, test:verification, " +
      "format:check, test:lint:design, the compiled test suite (CI runs it)";
    const at = result.stdout + result.stderr;
    assert.deepEqual([result.code, result.signal], [1, null], at);
    assert.ok(result.stdout.endsWith(`\n${last}\n`), at);
    assert.equal(result.stdout.split(last).length, 2, at);
  },
);

/**
 * One repository for the merge-commit tests: from one base, `runtime-v2`, `other` (another lane's branch) and `main`
 * each grow a commit, then `main` and `runtime-v2` grow another, with `origin/main` and `origin/runtime-v2` at their
 * tips. `lane(base, merges)` makes `lane` anew off `base`'s commit before that last growth, with a commit of its own and
 * then a merge of `merges` (none for null), and returns its SHA; merging main or runtime-v2 is so a merge commit.
 * `queueMerge(base)` checks out `lane` merged with `base` as the queue's `--merged-with` makes it (`git merge --no-ff`,
 * which makes no commit when the lane already holds the base).
 */
function mergeGraph() {
  const { directory } = repository({ passing: true });
  const git = (...args) => {
    const result = runSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (branch, file) => {
    git("switch", "-q", branch);
    writeFileSync(join(directory, file), `${branch}\n`);
    git("add", file);
    git("commit", "-q", "-m", `${branch} grows`);
  };
  git("branch", "runtime-v2", "main");
  git("branch", "other", "main");
  commit("runtime-v2", "runtime-v2.md");
  commit("other", "other.md");
  commit("main", "main.md");
  commit("main", "main-later.md");
  commit("runtime-v2", "runtime-v2-later.md");
  git("update-ref", "refs/remotes/origin/main", "main");
  git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
  const lane = (base, merges) => {
    git("switch", "-q", "-C", "lane", `${base.replace(/^origin\//u, "")}~1`);
    writeFileSync(join(directory, "lane.md"), "lane\n");
    git("add", "lane.md");
    git("commit", "-q", "-m", "lane grows");
    if (merges !== null) git("merge", "-q", "--no-edit", merges);
    return git("rev-parse", "lane");
  };
  const queueMerge = (base) => {
    git("switch", "-q", "--detach", "lane");
    git("merge", "-q", "--no-ff", "--no-edit", base);
  };
  return { directory, git, commit, lane, queueMerge };
}

/** `fn()` run with the working folder at `directory`, as `strayMerges` reads git there. */
function inside(directory, fn) {
  const before = process.cwd();
  process.chdir(directory);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

test("strayMerges fails a merge commit unless it merges main or runtime-v2 into the other, and says what git cannot place (#2106)", () => {
  const graph = mergeGraph();
  const { directory, git } = graph;
  try {
    for (const [base, merges, failure, tweak] of [
      // [the branch's base, what its merge commit merges, the reason it fails, or null when it passes]
      ["main", "main", "which the base already holds: rebase onto main instead"],
      [
        "main",
        "other",
        "which neither origin/main nor origin/runtime-v2 holds: rebase onto main instead, or, if it has landed on " +
          "one of them since your last fetch, fetch main, origin/main, origin/runtime-v2 and run again",
      ],
      ["main", "runtime-v2", null],
      ["runtime-v2", "main", null],
      ["runtime-v2", "runtime-v2", "which the base already holds: rebase onto runtime-v2 instead"],
      ["main", null, null],
      // a ref the clone lacks: unproven, so it fails, with the advice to fetch, and a parent the other ref holds passes
      [
        "main",
        "runtime-v2",
        "which git cannot place (origin/runtime-v2: fatal: Not a valid object name origin/runtime-v2): fetch main, " +
          "origin/main, origin/runtime-v2 and run again",
        "origin/runtime-v2",
      ],
      ["runtime-v2", "main", null, "origin/runtime-v2"],
      // a stale origin/main, which lacks the main commit merged: the advice names the fetch beside the rebase
      [
        "runtime-v2",
        "main",
        "which neither origin/main nor origin/runtime-v2 holds: rebase onto runtime-v2 instead, or, if it has " +
          "landed on one of them since your last fetch, fetch runtime-v2, origin/main, origin/runtime-v2 and run again",
        "stale",
      ],
      // a shallow clone, whose "no" proves nothing: unproven, with the advice to deepen it (Sol r2)
      [
        "origin/main",
        "runtime-v2",
        "which git cannot place (origin/main: the clone is shallow): deepen the clone (git fetch --unshallow) and " +
          "run again",
        "shallow",
      ],
    ]) {
      const head = graph.lane(base, merges);
      let cwd = directory;
      if (tweak === "origin/runtime-v2") git("update-ref", "-d", "refs/remotes/origin/runtime-v2");
      if (tweak === "stale") git("update-ref", "refs/remotes/origin/main", "main~1");
      if (tweak === "shallow") {
        // (a branch deeper than the clone, so the clone lacks history, while main's and the lane's are whole)
        git("branch", "-f", "deep", "main");
        for (const step of [1, 2, 3, 4]) graph.commit("deep", `deep-${step}.md`);
        git("switch", "-q", "lane");
        cwd = `${directory}-shallow`;
        git("clone", "-q", "--depth=3", "--no-single-branch", `file://${directory}`, cwd);
      }
      try {
        const stray = inside(cwd, () =>
          strayMerges(git("-C", cwd, "merge-base", "HEAD", base), head, base, base),
        );
        const at = `a branch of ${base} merging ${merges}${tweak ? `, ${tweak}` : ""}`;
        assert.deepEqual(
          stray,
          failure === null
            ? []
            : [
                `${head.slice(0, 9)} Merge branch '${merges}' into lane: merges ` +
                  `${git("rev-parse", "--short=9", "lane^2")}, ${failure}`,
              ],
          at,
        );
      } finally {
        if (tweak === "shallow") rmSync(cwd, { recursive: true, force: true });
        git("update-ref", "refs/remotes/origin/main", "main");
        git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("`merge commits` runs in every run, plain, merged and in a merged checkout, judging the head's merge commits and not the queue's own merge, and the other checks still run (#2106)", () => {
  const graph = mergeGraph();
  const { directory, git } = graph;
  const check = (...args) =>
    runSync(process.execPath, [tool, ...args], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
  /** `check(...args)`'s run, asserted: its status, every check in it, and `merge commits`' lines (none when it passes). */
  const verdict = (at, args, status, lines = []) => {
    const result = check(...args);
    assert.equal(result.status, status, `${at}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(
      result.stdout.match(/^(?:PASS|FAIL) {2}\S.*$/gmu).map((line) => line.split(/ {2,}/u)[1]),
      ["diff --check", "merge commits", "oxlint", "knip", "doc links", "imports"],
      at,
    );
    if (lines.length > 0)
      assert.ok(
        result.stdout.includes(
          `--- merge commits ---\n${lines.map((line) => `${line}\n`).join("")}`,
        ),
        `${at}: ${result.stdout}`,
      );
    else assert.match(result.stdout, /^PASS {2}merge commits /mu, at);
  };
  // The queue's merged checkout, named first when HEAD merges exactly the base's commit outside `--merged-checkout`;
  // still a failure, as it may be the builder's own merge of its base
  const queueHint = (first, baseName) =>
    `the base's commit itself, as the queue's merged checkout does: if this is one, run it as ` +
    `--merged-checkout ${first} --base ${baseName}; if you merged the base into your branch yourself, rebase ` +
    `onto ${baseName} instead`;
  const mergeLine = (commit, merges, why) =>
    `${git("rev-parse", "--short=9", commit)} Merge branch '${merges}' into lane: merges ` +
    `${git("rev-parse", "--short=9", `${commit}^2`)}, ${why}`;
  try {
    // plain and --merged: the lane's merge of its own base's tip fails, with the queue's case named first; a merge of
    // the other long-lived line passes
    for (const mode of [[], ["--merged"]]) {
      const own = graph.lane("main", "main");
      verdict(`${mode} own base`, [...mode, "--base", "main"], 1, [
        mergeLine("lane", "main", queueHint(git("rev-parse", `${own}^1`), "main")),
      ]);
      graph.lane("main", "runtime-v2");
      verdict(`${mode} runtime-v2 into a lane of main`, [...mode, "--base", "main"], 0);
    }
    // --merged-checkout, HEAD as the queue makes it. Behind its base, the queue made a merge commit: not judged
    const behind = graph.lane("main", null);
    graph.queueMerge("main");
    verdict("merged checkout behind its base", ["--merged-checkout", behind, "--base", "main"], 0);
    // by shape alone, as `--base HEAD^2` reads it, that merge is the base merged into the branch: it fails, naming
    // the queue's case first
    const runner = git("rev-parse", "--short=9", "HEAD");
    const byShape = check("--base", "HEAD^2");
    assert.equal(byShape.status, 1, byShape.stdout);
    assert.ok(
      byShape.stdout.includes(
        `${runner} Merge branch 'main' into HEAD: merges ${git("rev-parse", "--short=9", "HEAD^2")}, ` +
          `${queueHint(behind, "HEAD^2")}\n`,
      ),
      byShape.stdout,
    );
    // a commit that is not the merge's first parent, or both forms at once, cannot run
    const wrong = check("--merged-checkout", `${behind}~1`, "--base", "main");
    assert.equal(wrong.status, 2, `${wrong.stdout}${wrong.stderr}`);
    assert.match(
      wrong.stderr,
      new RegExp(
        `--merged-checkout ${behind}~1 \\(\\w{9}\\): HEAD \\(${runner}\\) is neither `,
        "u",
      ),
    );
    assert.equal(check("--merged", "--merged-checkout", behind).status, 2);
    // a stray merge on the branch's side is still judged, and so is the lane's own merge of its base, when the queue
    // merges nothing, without the queue's case
    const stray = graph.lane("main", "other");
    graph.queueMerge("main");
    verdict(
      "merged checkout, another lane merged",
      ["--merged-checkout", stray, "--base", "main"],
      1,
      [
        mergeLine(
          stray,
          "other",
          "which neither origin/main nor origin/runtime-v2 holds: rebase onto main instead, or, if it has landed on " +
            "one of them since your last fetch, fetch main, origin/main, origin/runtime-v2 and run again",
        ),
      ],
    );
    const own = graph.lane("main", "main");
    graph.queueMerge("main");
    verdict(
      "merged checkout, its own base merged",
      ["--merged-checkout", own, "--base", "main"],
      1,
      [mergeLine(own, "main", "which the base already holds: rebase onto main instead")],
    );
    // main merged into a lane of runtime-v2, checked as the queue merges it with runtime-v2
    const rt2 = graph.lane("runtime-v2", "main");
    graph.queueMerge("runtime-v2");
    verdict(
      "merged checkout, main into a lane of runtime-v2",
      ["--merged-checkout", rt2, "--base", "runtime-v2"],
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("without --base or a pull request, the base is the long-lived line HEAD's own line leaves, named, or exit 2 when unproven (#2409)", () => {
  const graph = mergeGraph();
  const { directory, git } = graph;
  const base = (ref, at, back) => ({
    ref,
    line:
      `check-changed: no --base and no pull request: base ${ref}, whose own line HEAD's leaves at ` +
      `${git("rev-parse", "--short=9", at)}, ${back} commits back`,
  });
  const fails = (at, message, cwd = directory) =>
    assert.throws(
      () => inside(cwd, branchedFrom),
      (error) => error instanceof CannotRun && error.message === message,
      at,
    );
  try {
    graph.lane("runtime-v2", null);
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/runtime-v2", "runtime-v2~1", 1),
      "runtime-v2",
    );
    graph.lane("main", null);
    assert.deepEqual(inside(directory, branchedFrom), base("origin/main", "main~1", 1), "main");
    // off the commit both lines hold, from before they split: main
    graph.lane("main~1", null);
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/main", "main~2", 1),
      "before the split",
    );
    // a lane of main merging runtime-v2, and one of runtime-v2 merging main: each its own line's, though the other's
    // tip is nearer by commits (Sol r1)
    graph.lane("main", "runtime-v2");
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/main", "main~1", 2),
      "main merging runtime-v2",
    );
    git("switch", "-q", "runtime-v2");
    git("merge", "-q", "--no-edit", "main~1");
    git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
    for (const step of [1, 2, 3, 4, 5]) graph.commit("main", `main-${step}.md`);
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-C", "lane", "runtime-v2");
    graph.commit("lane", "lane.md");
    git("merge", "-q", "--no-edit", "main");
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/runtime-v2", "runtime-v2", 2),
      "runtime-v2, holding an older main, merging a newer main",
    );
    const lane = git("rev-parse", "lane");
    // unproven: a missing ref, and a shallow clone
    git("update-ref", "-d", "refs/remotes/origin/runtime-v2");
    fails(
      "no origin/runtime-v2",
      "no --base and no pull request, and no origin/runtime-v2 to tell the base by: fetch origin/main and " +
        "origin/runtime-v2, or name the base with --base",
    );
    git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
    const shallow = `${directory}-shallow`;
    git("clone", "-q", "--depth=2", "--no-single-branch", `file://${directory}`, shallow);
    try {
      fails(
        "shallow",
        "no --base and no pull request, and the clone is shallow: deepen it (git fetch --unshallow), or name the " +
          "base with --base",
        shallow,
      );
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
    // --merged-checkout needs --base: the queue's merge of a lane of runtime-v2 with main, its second parent main
    git("switch", "-q", "--detach", "lane");
    git("merge", "-q", "--no-ff", "--no-edit", "origin/main~1");
    const merged = runSync(process.execPath, [tool, "--merged-checkout", lane], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(merged.status, 2, `${merged.stdout}${merged.stderr}`);
    assert.match(merged.stderr, /usage: .* --merged-checkout <commit> --base <ref>/u);
    // the run itself: a lane of runtime-v2 checked against runtime-v2, its one commit the change
    graph.lane("runtime-v2", null);
    const result = runSync(process.execPath, [tool], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(
      result.stdout.startsWith(`${base("origin/runtime-v2", "runtime-v2~1", 1).line}\n`),
      result.stdout,
    );
    assert.match(
      result.stdout,
      /^check-changed: 1 changed files since origin\/runtime-v2 /mu,
      result.stdout,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
