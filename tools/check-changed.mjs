import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { costlyTestSeconds } from "./costly-test-files.mjs";
import { isSuiteTestPath, isTypeCoreTestFile } from "./test-shards.mjs";

// Runs, before a push, the checks CI fails on for what changed since a base, in parallel, and prints one line per check
// with its verdict and seconds, and the full output of a check that failed:
//
//   node tools/check-changed.mjs [--merged] [--base <ref>]
//
// The base is `--base`, else the open pull request's base (`gh pr view`, as `origin/<base>`), else `origin/main`; the
// changes are those since its merge-base with HEAD, committed or not, untracked files included. Always: `git diff
// --check`, the format check of the changed files, oxlint, knip, the doc links and the imports, each as CI runs it.
// Then each project a changed path belongs to (`projectsFor`): its type check and tests. A root configuration file
// belongs to the checks that read it, and needs no project when only those that always run do. A changed path no
// project claims, other than documentation, runs every project's checks. It never builds the TypeScript or runs the
// compiled test suite, which CI does: a change that shows only there, such as the root tsconfig's emit settings, passes
// here. When a changed file is under `src/type-inference/core/`, it also prints the suites that pin the core's work or
// its published answers, as `tools/repository-checks/pin-suites.mjs` lists them: the focused list such a change runs
// before review (`docs/TESTING.md`, "Pinned work"), which it does not run itself. When a changed type-core test file has
// no entry in `tools/costly-test-files.mjs`, it prints one line saying so: the file runs in full, as every file does,
// and the entry lands from CI at merge.
//
// `--merged` checks what CI tests after a squash instead: HEAD merged into the base's current commit, in a temporary
// detached worktree (`git merge --no-commit --no-ff`) with this worktree's `node_modules` linked in. Uncommitted
// changes are not in HEAD, so not in the merge; a conflict is exit 2, naming the files. The worktree is removed at the
// end, also on SIGINT, SIGTERM and SIGHUP; only killing this process outright (`kill -9`) leaves it, for `git worktree
// prune` and the temporary folder's cleanup.
//
// Without `node_modules`, which it never installs, it links main's: that of the checkout `TEASESCRIPT_MAIN` names
// (unset or empty, `/opt/teasescript-agents/teasescript-main/current`), as `linkMainNodeModules` says. It runs no
// check with a `node_modules` that does not install the checked tree's `package-lock.json` (`notInstalled`), and
// gives no verdict when it no longer does once the checks ended.
//
// Exit status: 0 when every check passed, 1 when one failed, 2 when the checks cannot run (no base, a merge conflict,
// a leftover it may not remove, no `node_modules` it can link, or one that does not install the lockfile, before or
// after the checks).

/** The projects a changed path can belong to, each with the npm scripts or commands that check it. */
export const PROJECTS = {
  typescript: {
    // (and the tests' fixture data, which only the tests read: CI runs them)
    claims: (path) =>
      (/^(?:src|tests|playground|player)\/.*\.(?:ts|mts|cts|tsx)$/u.test(path) &&
        !path.startsWith("player/vue/")) ||
      path.startsWith("tests/fixtures/") ||
      path === "tsconfig.json",
    checks: ["tsc"],
  },
  families: { claims: (path) => path.startsWith("tests/families/"), checks: ["test:families"] },
  "player-vue": {
    claims: (path) => path.startsWith("player/vue/"),
    checks: ["typecheck:player", "lint:design"],
  },
  // (`tools/oxlint/tsconfig.json`, which `test:lint` compiles the rules with, extends the root one)
  "oxlint-rules": {
    claims: (path) => path.startsWith("tools/oxlint/") || path === "tsconfig.json",
    checks: ["test:lint"],
  },
  tools: {
    claims: (path) =>
      /^tools\/[^/]+\.(?:mjs|cjs|js)$/u.test(path) ||
      path.startsWith("tools/repository-checks/") ||
      path === "knip.json",
    checks: ["test:verification"],
  },
  // Prettier's configuration and ignore file change how every file formats, not only the changed ones.
  formatting: {
    claims: (path) => path === ".prettierrc.json" || path === ".prettierignore",
    checks: ["format:check"],
  },
  // (the shadcn rules resolve component imports through the root tsconfig's paths, then the Player's)
  "design-lint": {
    claims: (path) =>
      path === "eslint.design.config.mjs" ||
      path === "tsconfig.json" ||
      path === "player/vue/tsconfig.json",
    checks: ["lint:design", "test:lint:design"],
  },
};

/** Root configuration files that only the checks run for every change read: oxlint's. */
const READ_BY_ALWAYS_RUN_CHECKS = new Set([".oxlintrc.json"]);

/** A documentation path selects no project's checks; its Markdown links are checked on every run (`doc links`). */
const isDocumentation = (path) => path.endsWith(".md") || path.startsWith("docs/");

/**
 * The projects whose checks `paths` need. A path no project claims, documentation and the configuration only the checks
 * run for every change read aside, needs every project: an unknown kind of path is checked by everything, never by
 * nothing.
 */
export function projectsFor(paths) {
  const projects = new Set();
  for (const path of paths) {
    if (isDocumentation(path) || READ_BY_ALWAYS_RUN_CHECKS.has(path)) continue;
    const claiming = Object.keys(PROJECTS).filter((name) => PROJECTS[name].claims(path));
    for (const name of claiming.length > 0 ? claiming : Object.keys(PROJECTS)) projects.add(name);
  }
  return projects;
}

/** The checks `projects` run, each once although several projects name it, in the order the projects name them. */
export function checksOf(projects) {
  return [...new Set([...projects].flatMap((project) => PROJECTS[project].checks))];
}

/** The core, a change to which prints the suites that pin its work. */
const CORE = "src/type-inference/core/";

/** The line a changed type-core test file that `tools/costly-test-files.mjs` does not list prints (#2088). */
export const UNKNOWN_TO_COSTLY =
  "unknown to costly-test-files: run in full; the entry lands from CI at merge";

/**
 * The type-core test files among `paths` that `tools/costly-test-files.mjs` does not list (#2088). The table lists every
 * type-core test file, so a new one is the unknown kind, and its default is the conservative one: it runs in full, as
 * every file does (`tools/test-shards.mjs` counts it at `otherTestSeconds`), and the coordinator lands its entry from
 * the merge's CI runs. Another test file the table lacks is not unknown: the table lists only those of 10 s or more.
 */
export function unknownToCostly(paths) {
  return paths.filter(
    (path) =>
      path.startsWith("tests/") &&
      isSuiteTestPath(path.slice("tests/".length), ".test.ts") &&
      isTypeCoreTestFile(path) &&
      costlyTestSeconds[path.slice("tests/".length).replace(/\.ts$/u, ".js")] === undefined,
  );
}

/** The extensions `npm run format:check` covers. */
const FORMATTED = /\.(?:ts|tsx|cts|mts|js|jsx|cjs|mjs|vue)$/u;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** A reason the checks cannot run: exit 2. */
class CannotRun extends Error {}

function cannotRun(message) {
  throw new CannotRun(message);
}

const USAGE = "usage: node tools/check-changed.mjs [--merged] [--base <ref>]";

/** `--merged`, and the base: `--base`, else the open pull request's base, else `origin/main`. */
function options(argv) {
  const merged = argv.includes("--merged");
  const rest = argv.filter((argument) => argument !== "--merged");
  if (rest.length > 0 && !(rest.length === 2 && rest[0] === "--base")) cannotRun(USAGE);
  if (rest.length === 2) return { merged, ref: rest[1] };
  const pr = spawnSync("gh", ["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"], {
    encoding: "utf8",
  });
  return {
    merged,
    ref: pr.status === 0 && pr.stdout.trim() !== "" ? `origin/${pr.stdout.trim()}` : "origin/main",
  };
}

/** The prefix of every temporary worktree `--merged` makes. */
const TEMPORARY_PREFIX = join(tmpdir(), "check-changed-merged-");

/** The LXC's own checkout of main, which an unset or empty `TEASESCRIPT_MAIN` means. */
export const MAIN_CHECKOUT = "/opt/teasescript-agents/teasescript-main/current";

/**
 * Links main's `node_modules` into `cwd` and says what it linked: the `node_modules` folder of the checkout
 * `TEASESCRIPT_MAIN` names in `env` (relative to `cwd`; unset or empty, `fallback`). The link holds that path as named,
 * which the system opens through any link in it at each use, so a link to the default follows `current` from slot to
 * slot as teasescript-main's refresh switches it. A link already there whose target is gone (`ENOENT`, `ENOTDIR`) it
 * replaces. Anything else there, or no such folder, it refuses with why and the two fixes, and leaves as it is.
 */
export function linkMainNodeModules(env, cwd, fallback = MAIN_CHECKOUT) {
  const main = env.TEASESCRIPT_MAIN || fallback;
  const refuse = (why) =>
    cannotRun(
      `no node_modules, and ${why}: run \`npm ci\`, or set TEASESCRIPT_MAIN to a checkout of main that has node_modules`,
    );
  const target = join(cwd, "node_modules");
  let there = null;
  try {
    there = lstatSync(target);
  } catch {}
  if (there !== null) {
    let gone = false;
    try {
      if (there.isSymbolicLink()) statSync(target);
    } catch (error) {
      gone = error.code === "ENOENT" || error.code === "ENOTDIR";
    }
    if (!gone)
      refuse("node_modules is there but is no link whose target is gone, so it is left as it is");
  }
  // (concatenated, not joined: `join` would drop a `..` after a link that the system follows first)
  const source = `${isAbsolute(main) ? "" : `${cwd}/`}${main}/node_modules`;
  try {
    if (!statSync(source).isDirectory()) throw Object.assign(new Error(), { code: "not a folder" });
  } catch (error) {
    refuse(`${main} has no node_modules folder (${error.code})`);
  }
  if (there !== null) rmSync(target);
  symlinkSync(source, target);
  return `${there === null ? "linked" : "replaced a stale link with"} node_modules from ${source}`;
}

/**
 * The packages the lockfile `lock` names that the install `installed` (its `node_modules/.package-lock.json`, which
 * npm writes at each install) does not hold as the lockfile names them, each as `<path> <version> (<what is there>)`:
 * an entry missing, unless `optional` (a package for another platform), or with another version, `resolved` or
 * `integrity`. A lockfile without `packages` (npm's lockfile versions 2 and 3 have it) cannot be compared: it throws.
 */
export function notInstalled(lock, installed) {
  if (typeof lock.packages !== "object" || lock.packages === null)
    throw new Error("package-lock.json has no `packages` to compare node_modules with");
  const differences = [];
  for (const [path, wanted] of Object.entries(lock.packages)) {
    if (path === "") continue;
    const there = installed.packages?.[path];
    if (there === undefined) {
      if (!wanted.optional) differences.push(`${path} ${wanted.version} (not installed)`);
    } else if (["version", "resolved", "integrity"].some((key) => there[key] !== wanted[key]))
      differences.push(`${path} ${wanted.version} (installed: ${there.version})`);
  }
  return differences;
}

/**
 * Why the `node_modules` in the working folder does not install its `package-lock.json` (#2087), naming the first
 * differences and the remedies, or `null` when it does. A folder without a lockfile has nothing to compare.
 */
function lockfileMismatch() {
  if (!existsSync("package-lock.json")) return null;
  const why = (what) =>
    `node_modules (${realpathSync("node_modules")}) does not install package-lock.json: ${what}. ` +
    "Main's lockfile: wait for teasescript-main's refresh, and remove a node_modules link pinned to a slot instead of " +
    "`current` (check-changed then links `current`). A branch behind main's lockfile: rebase, or check with --merged. " +
    "A lockfile the branch changes: run the checks in the queue";
  if (!existsSync("node_modules/.package-lock.json"))
    return why("it has no .package-lock.json, which npm writes at each install");
  let differences;
  try {
    differences = notInstalled(
      JSON.parse(readFileSync("package-lock.json", "utf8")),
      JSON.parse(readFileSync("node_modules/.package-lock.json", "utf8")),
    );
  } catch (error) {
    return `cannot compare node_modules with package-lock.json: ${error.message}`;
  }
  return differences.length === 0
    ? null
    : why(
        differences.slice(0, 5).join(", ") +
          (differences.length > 5 ? `, and ${differences.length - 5} more` : ""),
      );
}

/**
 * Removes `directory`, a temporary worktree of the repository at `repository`, and returns `null`; or, when
 * `directory` is not one this tool made (its absolute path under `TEMPORARY_PREFIX`) and registered as a worktree of
 * that repository, removes nothing and returns why.
 */
export function removeTemporaryWorktree(directory, repository) {
  const real = (path) => (existsSync(path) ? realpathSync(path) : resolve(path));
  if (resolve(directory) !== directory || !directory.startsWith(TEMPORARY_PREFIX))
    return `${directory} is not a temporary worktree of check-changed`;
  const listed = spawnSync("git", ["-C", repository, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  }).stdout.split("\n");
  if (!listed.includes(`worktree ${real(directory)}`) && !listed.includes(`worktree ${directory}`))
    return `${directory} is not a worktree of ${repository}`;
  if (
    spawnSync("git", ["-C", repository, "worktree", "remove", "--force", directory]).status !== 0
  ) {
    rmSync(directory, { recursive: true, force: true });
    spawnSync("git", ["-C", repository, "worktree", "prune"]);
  }
  return null;
}

/** The checks running now, each its own process group, so `stop` reaches their children too. */
const running = new Set();
const stop = () => {
  for (const child of running)
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
};

/** The formatter CI's version pins: `agent-prettier` on the LXC, else the installed one when its version is the pin. */
function prettier() {
  if (spawnSync("agent-prettier", ["--version"], { stdio: "ignore" }).status === 0)
    return ["agent-prettier"];
  const pinned = JSON.parse(readFileSync("package.json", "utf8")).devDependencies?.prettier;
  if (!existsSync("node_modules/prettier/package.json"))
    cannotRun("node_modules has no prettier: link or install the repository's");
  const installed = JSON.parse(readFileSync("node_modules/prettier/package.json", "utf8")).version;
  if (installed !== pinned)
    cannotRun(
      `node_modules has prettier ${installed}, but package.json pins ${pinned}: link or install matching ones`,
    );
  return [process.execPath, "node_modules/prettier/bin/prettier.cjs"];
}

/** A check's run: its verdict, seconds and output; `shown` prints the output also when it passes. */
function run(name, command, args, shown = false) {
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    running.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) =>
      resolve({ name, passed: false, seconds: 0, output: error.message, shown }),
    );
    child.on("close", (code) => {
      running.delete(child);
      const seconds = (performance.now() - start) / 1000;
      resolve({ name, passed: code === 0, seconds, output, shown });
    });
  });
}

/**
 * `--merged`: HEAD merged into the base's commit in a temporary worktree, which `cleanup` removes. The process then
 * runs in that worktree, and the base it compares with is the base's commit.
 */
function enterMerge(ref, cleanups) {
  const repository = git("rev-parse", "--show-toplevel");
  const head = git("rev-parse", "HEAD");
  let baseCommit;
  try {
    baseCommit = git("rev-parse", `${ref}^{commit}`);
  } catch {
    cannotRun(`no commit ${ref}: fetch it, or name one with --base`);
  }
  if (git("status", "--porcelain") !== "")
    process.stderr.write(
      "check-changed: warning: uncommitted changes are not in HEAD, so not in the merge\n",
    );
  const directory = mkdtempSync(TEMPORARY_PREFIX);
  cleanups.push(() => {
    const refused = removeTemporaryWorktree(directory, repository);
    if (refused !== null) {
      process.stderr.write(`check-changed: left ${directory} in place: ${refused}\n`);
      process.exitCode = 2;
    }
  });
  git("worktree", "add", "--quiet", "--detach", directory, baseCommit);
  // (git asks a merge for a committer even with `--no-commit`, and a CI runner or a fresh worker has none)
  const identity = ["-c", "user.name=check-changed", "-c", "user.email=check-changed@localhost"];
  const merge = spawnSync(
    "git",
    ["-C", directory, ...identity, "merge", "--quiet", "--no-commit", "--no-ff", head],
    { encoding: "utf8" },
  );
  if (merge.status !== 0) {
    const conflicts = spawnSync(
      "git",
      ["-C", directory, "diff", "--name-only", "--diff-filter=U"],
      { encoding: "utf8" },
    ).stdout.trim();
    cannotRun(
      `HEAD does not merge into ${ref} (${baseCommit.slice(0, 9)}): ${conflicts.split("\n").join(", ") || merge.stderr.trim()}`,
    );
  }
  symlinkSync(realpathSync(join(repository, "node_modules")), join(directory, "node_modules"));
  process.chdir(directory);
  process.stdout.write(
    `check-changed: the merge of HEAD (${head.slice(0, 9)}) into ${ref} (${baseCommit.slice(0, 9)})\n`,
  );
  return baseCommit;
}

async function check(cleanups) {
  const { merged, ref } = options(process.argv.slice(2));
  if (!existsSync("node_modules")) {
    process.stdout.write(`check-changed: ${linkMainNodeModules(process.env, process.cwd())}\n`);
  }
  let mergeBase;
  if (merged) mergeBase = enterMerge(ref, cleanups);
  else
    try {
      mergeBase = git("merge-base", "HEAD", ref);
    } catch {
      cannotRun(`no merge-base of HEAD and ${ref}: fetch it, or name one with --base`);
    }
  const mismatch = lockfileMismatch();
  if (mismatch !== null) cannotRun(mismatch);

  const changed = [
    ...git("diff", "--name-only", "--diff-filter=d", mergeBase).split("\n"),
    // (the merge's worktree has no untracked file but the linked `node_modules`)
    ...(merged ? [] : git("ls-files", "--others", "--exclude-standard").split("\n")),
  ].filter((path) => path !== "" && existsSync(path));
  const projects = projectsFor(changed);
  process.stdout.write(
    `check-changed: ${changed.length} changed files since ${ref} (${mergeBase.slice(0, 9)}); ` +
      `projects: ${[...projects].join(", ") || "none"}\n`,
  );
  const unknown = unknownToCostly(changed);
  if (unknown.length > 0) process.stdout.write(`${unknown.join(", ")}: ${UNKNOWN_TO_COSTLY}\n`);

  // (a deleted core file counts too, which `changed`, holding the files that exist, leaves out, and a file moved out of
  // the core, whose old path only `--no-renames` lists)
  const coreChanged = [
    ...git("diff", "--name-only", "--no-renames", mergeBase).split("\n"),
    ...changed,
  ].some((path) => path.startsWith(CORE));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const formatted = changed.filter((path) => FORMATTED.test(path));
  const [formatter, ...formatterArgs] = prettier();
  const checks = [
    run("diff --check", "git", ["diff", "--check", mergeBase]),
    ...(formatted.length > 0
      ? [run("format", formatter, [...formatterArgs, "--check", ...formatted])]
      : []),
    run("oxlint", process.execPath, ["tools/oxlint/run.mjs"]),
    run("knip", process.execPath, ["node_modules/knip/bin/knip.js"]),
    run("doc links", process.execPath, ["tools/repository-checks/doc-links.mjs"]),
    run("imports", process.execPath, ["tools/repository-checks/imports.mjs"]),
    ...(coreChanged
      ? [
          run(
            "pin suites",
            process.execPath,
            ["tools/repository-checks/pin-suites.mjs", "--base", mergeBase],
            true,
          ),
        ]
      : []),
  ];
  for (const check of checksOf(projects))
    checks.push(
      check === "tsc"
        ? run("tsc", "node_modules/.bin/tsc", ["--noEmit", "-p", "tsconfig.json"])
        : run(check, npm, ["run", "--silent", check]),
    );
  const results = await Promise.all(checks);
  for (const { name, passed, seconds } of results)
    process.stdout.write(
      `${passed ? "PASS" : "FAIL"}  ${name.padEnd(18)} ${seconds.toFixed(1)}s\n`,
    );
  for (const { name, passed, output, shown } of results)
    if (!passed || shown) process.stdout.write(`\n--- ${name} ---\n${output}`);
  process.exitCode = results.every(({ passed }) => passed) ? 0 : 1;
  // (a link through main's `current` follows its refresh, which can switch it to another install while the checks run)
  const after = lockfileMismatch();
  if (after !== null) {
    process.stderr.write(
      `check-changed: node_modules changed while the checks ran, so their verdicts do not count: ${after}\n`,
    );
    process.exitCode = 2;
  }
}

async function main() {
  const cleanups = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    stop();
    for (const step of cleanups) step();
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  try {
    await check(cleanups);
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    process.stderr.write(`check-changed: ${error.message}\n`);
    process.exitCode = 2;
  } finally {
    cleanup();
  }
}

if (import.meta.main) await main();
