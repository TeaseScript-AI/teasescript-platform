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

// Its sibling modules load only after this guard: run as a lone copy outside its checkout, it says so in one line and
// exits 2 instead of failing on an import (#2366).
let siblings;
try {
  siblings = await Promise.all([
    import("./costly-test-files.mjs"),
    import("./run-parallel.mjs"),
    import("./test-shards.mjs"),
  ]);
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  process.stderr.write(
    `check-changed: run it from its checkout, whose tools/ holds the modules it imports (${error.message}); on a ` +
      "branch that predates it, run main's from your worktree: node /opt/teasescript-agents/teasescript-main/current/tools/check-changed.mjs\n",
  );
  process.exit(2);
}
const [{ costlyTestSeconds }, { summaryLine }, { isSuiteTestPath, isTypeCoreTestFile }] = siblings;

// Runs, before a push, the checks CI fails on for what changed since a base, in parallel, and prints one line per check
// with its verdict and seconds, and the full output of a check that failed:
//
//   node tools/check-changed.mjs [--merged] [--base <ref>]
//   node tools/check-changed.mjs --merged-checkout <commit> --base <ref>
//
// The base is `--base`, else the open pull request's base (`gh pr view`, as `origin/<base>`), else the long-lived branch
// HEAD's own line leaves, `origin/main` or `origin/runtime-v2`, which it prints, or exit 2 when it cannot prove which
// (`branchedFrom`); the changes are those since its merge-base with HEAD, committed or not, untracked files, deleted
// ones and both sides of a move included. Always: `git diff --check`, the format check of the changed files, oxlint,
// knip, the doc links, the imports and `test:verification`, each as CI runs it, and `merge commits`: since the
// merge-base, no merge commit but one whose later parents are on origin/main or origin/runtime-v2 and not on the base
// (`strayMerges`). `test:verification` reads more than a claim can name, documentation included (#2472): on main
// cfbf2b415 it read 471 tracked files besides the tools and checks it tests, among them every `.ts` file under
// `tests/` (`pin-suites`) and the documents the reading route lists (`reading-route-size`).
// Then each project a changed path belongs to (`projectsFor`): its type check and tests. A root configuration file
// belongs to the checks that read it, and needs no project when only those that always run do. A changed path no
// project claims, other than documentation, runs every project's checks. Every change but documentation (a path ending
// in `.md` or under `docs/`, `isDocumentation`) runs `test:lint` and `typecheck:player` (`everyChange`), which read
// more than a claim can name but no documentation. The checks run side by side: with
// `test:lint` a run peaked at about 5.5 GiB summed over its processes (#2431), and a queue job asks `--mem 8G` for it.
// It never builds the TypeScript or runs the compiled test suite, which CI does: a change that shows only there, such
// as the root tsconfig's emit settings, passes here. When a changed file is under `src/type-inference/core/`, it also prints the suites that pin the core's work or
// its published answers, as `tools/repository-checks/pin-suites.mjs` lists them: the focused list such a change runs
// before review (`docs/TESTING.md`, "Pinned work"), which it does not run itself. When a changed type-core test file has
// no entry in `tools/costly-test-files.mjs`, it prints one line saying so: the file runs in full, as every file does,
// and the entry lands from CI at merge. Its last line, also when the checks cannot run, names what ran, failed and did
// not run, the compiled suite and the checks no changed path needs included (`summaryLine`, #2106).
//
// `--merged` checks what CI tests after a squash instead: HEAD merged into the base's current commit, in a temporary
// detached worktree (`git merge --no-commit --no-ff`) with this worktree's `node_modules` linked in. Uncommitted
// changes are not in HEAD, so not in the merge; a conflict is exit 2, naming the files. The worktree is removed at the
// end, also on SIGINT, SIGTERM and SIGHUP; only killing this process outright (`kill -9`) leaves it, for `git worktree
// prune` and the temporary folder's cleanup.
//
// `--merged-checkout <commit> --base <ref>` checks a checkout that already is that merge, made by a runner such as the
// queue's `--merged-with`: HEAD is the commit merged with the base's (`git merge --no-ff`: its first parent the commit,
// its second the base's), or the commit itself when it already holds the base. Anything else is exit 2. `merge commits`
// then reads the commit's side only, so the runner's merge is not judged. Only the commit named tells that merge from a
// builder's merge of the base into the branch, which has the same shape and fails.
//
// Without `node_modules`, which it never installs, it links main's: that of the checkout `TEASESCRIPT_MAIN` names
// (unset or empty, `/opt/teasescript-agents/teasescript-main/current`), as `linkMainNodeModules` says. It runs no
// check unless npm's record of the install, `node_modules/.package-lock.json`, holds every package of the checked
// tree's `package-lock.json` that applies to this host at the lockfile's version, source and integrity
// (`notInstalled`), and gives no verdict when the record no longer does once the checks ended. It compares that record,
// not the installed files, and says nothing of a package the lockfile does not name. A run that spans two of
// teasescript-main's refreshes (every 10 minutes, plus a build) can read another install between its two comparisons
// and end on a matching one, unseen; the runs measured take 1 to 5 minutes.
//
// Exit status: 0 when every check passed, 1 when one failed, 2 when the checks cannot run (no base, a merge conflict,
// a leftover it may not remove, no `node_modules` it can link, or one whose record does not hold the lockfile, before or
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
  "player-vue": { claims: (path) => path.startsWith("player/vue/"), checks: ["lint:design"] },
  // vue-tsc type-checks the Player against every file it imports: on main cfbf2b415, 314 tracked files outside
  // `player/vue/`, from `src/`, `player/` and `playground/`, a set that moves with the Player's imports, and no
  // documentation (#2472). So it runs for every change but documentation, as `test:lint` does.
  "player-types": {
    claims: (path) => path.startsWith("player/vue/"),
    everyChange: true,
    checks: ["typecheck:player"],
  },
  // `test:lint`'s rule tests read far more than a claim can name: `.oxlintrc.json`, the tools that run and count them
  // (one by a computed path), and the repository's own sources and test helpers, which they lint as fixtures; a trace
  // found 859 tracked files (#2431). So it runs for every change that is not documentation only, as oxlint does, which
  // takes longer and runs beside it. Its claim stays, so that a path under it is not an unknown kind (every project).
  // (`tools/oxlint/tsconfig.json`, which `test:lint` compiles the rules with, extends the root one)
  "oxlint-rules": {
    claims: (path) => path.startsWith("tools/oxlint/") || path === "tsconfig.json",
    everyChange: true,
    checks: ["test:lint"],
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

/**
 * Paths that only the checks run for every change read, so they need no project: oxlint's configuration, which
 * `test:lint` reads too, and the tools, the repository checks and knip's configuration, which `test:verification` and
 * knip read (and `typecheck:player` and `test:lint` one tool each).
 */
const readByAlwaysRunChecks = (path) =>
  path === ".oxlintrc.json" ||
  /^tools\/[^/]+\.(?:mjs|cjs|js)$/u.test(path) ||
  path.startsWith("tools/repository-checks/") ||
  path === "knip.json";

/** A documentation path selects no project's checks; its Markdown links are checked on every run (`doc links`). */
const isDocumentation = (path) => path.endsWith(".md") || path.startsWith("docs/");

/**
 * The projects whose checks `paths` need. A project with `everyChange` is needed by every path but documentation. A path
 * no project claims, documentation and the paths only the checks run for every change read aside, needs every
 * project: an unknown kind of path is checked by everything, never by nothing.
 */
export function projectsFor(paths) {
  const projects = new Set();
  for (const path of paths) {
    if (isDocumentation(path)) continue;
    for (const name of Object.keys(PROJECTS)) if (PROJECTS[name].everyChange) projects.add(name);
    if (readByAlwaysRunChecks(path)) continue;
    const claiming = Object.keys(PROJECTS).filter((name) => PROJECTS[name].claims(path));
    for (const name of claiming.length > 0 ? claiming : Object.keys(PROJECTS)) projects.add(name);
  }
  // (in `PROJECTS`' order, whatever path came first)
  return new Set(Object.keys(PROJECTS).filter((name) => projects.has(name)));
}

/** The checks `projects` run, each once although several projects name it, in the order the projects name them. */
export function checksOf(projects) {
  return [...new Set([...projects].flatMap((project) => PROJECTS[project].checks))];
}

/** What it never runs, named in its last line. */
export const NEVER_RUN = "the compiled test suite (CI runs it)";

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

/**
 * The long-lived branches the workflow merges into each other, on merge branches such as `rt2/merge-main-…`. Both the
 * default base (`branchedFrom`) and `merge commits` (`strayMerges`) read them here; once runtime-v2 is retired, a
 * missing `origin/runtime-v2` is the normal state, and its entry goes from here, for both.
 */
const MERGED_INTO_EACH_OTHER = ["origin/main", "origin/runtime-v2"];

/**
 * The merge commits in `from..head` that the workflow does not make (#2106), each as `<commit> <subject>: <why and what
 * to do>`, run with `git` in the working folder. A merge passes only when each parent after its first is on `origin/main`
 * or `origin/runtime-v2` and not on `base` (named `baseName`), the commit the run compares with: so merging main into a
 * branch of runtime-v2, or runtime-v2 into a branch of main, passes, and merging a branch's own base into it, or any
 * other branch, does not; a lane branch rebases instead. Which line the first parent is on is not checked. A lookup git
 * cannot answer (a missing ref or commit), or answers "no" in a shallow clone, fails as unproven, with the advice to
 * fetch or deepen the clone. With `queueHint`, `head` as a merge of exactly the base's commit is named first as what the
 * queue's merged checkout makes, with the `--merged-checkout` command; it still fails, as it may be a builder's own.
 */
export function strayMerges(from, head, base, baseName, queueHint = false) {
  // (a shallow clone lacks history, so there git's "not an ancestor" proves nothing)
  const shallow = git("rev-parse", "--is-shallow-repository") === "true";
  // (true or false, or why git cannot answer)
  const holds = (ref, commit, name = ref) => {
    const lookup = spawnSync("git", ["merge-base", "--is-ancestor", commit, ref], {
      encoding: "utf8",
    });
    if (lookup.status === 0) return true;
    if (lookup.status === 1) return shallow ? `${name}: the clone is shallow` : false;
    return `${name}: ${lookup.stderr.trim().split("\n")[0] || `git exit ${lookup.status}`}`;
  };
  const refs = [baseName, ...MERGED_INTO_EACH_OTHER].join(", ");
  const stray = [];
  for (const line of git("rev-list", "--merges", "--parents", `${from}..${head}`).split("\n")) {
    if (line === "") continue;
    const [commit, first, ...merged] = line.split(" ");
    const why = [];
    for (const parent of merged) {
      const short = parent.slice(0, 9);
      if (
        queueHint &&
        commit === head &&
        merged.length === 1 &&
        parent ===
          spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
            encoding: "utf8",
          }).stdout.trim()
      ) {
        why.push(
          `merges ${short}, the base's commit itself, as the queue's merged checkout does: if this is one, run it as ` +
            `--merged-checkout ${first} --base ${baseName}; if you merged the base into your branch yourself, rebase ` +
            `onto ${baseName} instead`,
        );
        continue;
      }
      const onBase = holds(base, parent, baseName);
      if (onBase === true) {
        why.push(`merges ${short}, which the base already holds: rebase onto ${baseName} instead`);
        continue;
      }
      const onBranches = MERGED_INTO_EACH_OTHER.map((ref) => holds(ref, parent));
      if (onBase === false && onBranches.includes(true)) continue;
      const errors = [
        ...new Set([onBase, ...onBranches].filter((answer) => typeof answer === "string")),
      ];
      why.push(
        errors.length > 0
          ? `merges ${short}, which git cannot place (${errors.join("; ")}): ` +
              (shallow ? "deepen the clone (git fetch --unshallow)" : `fetch ${refs}`) +
              " and run again"
          : `merges ${short}, which neither ${MERGED_INTO_EACH_OTHER.join(" nor ")} holds: rebase onto ` +
              `${baseName} instead, or, if it has landed on one of them since your last fetch, fetch ${refs} and run again`,
      );
    }
    if (why.length > 0)
      stray.push(
        `${commit.slice(0, 9)} ${git("log", "-1", "--format=%s", commit)}: ${why.join("; ")}`,
      );
  }
  return stray;
}

/** The extensions `npm run format:check` covers. */
const FORMATTED = /\.(?:ts|tsx|cts|mts|js|jsx|cjs|mjs|vue)$/u;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/**
 * The path names a Git command lists with `-z`, each as it is named: elsewhere Git quotes a name with a quote or, by
 * default, a non-ASCII character. (A name that is not UTF-8 reads with U+FFFD for its bad bytes.)
 */
const namesFrom = (...args) =>
  execFileSync("git", args, { encoding: "utf8" })
    .split("\0")
    .filter((name) => name !== "");

/** A reason the checks cannot run: exit 2. */
export class CannotRun extends Error {}

function cannotRun(message) {
  throw new CannotRun(message);
}

const USAGE =
  "usage: node tools/check-changed.mjs [--merged] [--base <ref>], or --merged-checkout <commit> --base <ref>";

/**
 * `--merged`, `--merged-checkout`'s commit (or null), and the base: `--base`, which `--merged-checkout` needs, else the
 * open pull request's base, else `branchedFrom`'s, which it prints.
 */
function options(argv) {
  let merged = false;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--merged" && !merged) merged = true;
    else if (
      (argument === "--base" || argument === "--merged-checkout") &&
      !values.has(argument) &&
      index + 1 < argv.length
    )
      values.set(argument, argv[(index += 1)]);
    else cannotRun(USAGE);
  }
  const mergedCheckout = values.get("--merged-checkout") ?? null;
  if (mergedCheckout !== null && (merged || !values.has("--base"))) cannotRun(USAGE);
  if (values.has("--base")) return { merged, mergedCheckout, ref: values.get("--base") };
  const pr = spawnSync("gh", ["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"], {
    encoding: "utf8",
  });
  if (pr.status === 0 && pr.stdout.trim() !== "")
    return { merged, mergedCheckout, ref: `origin/${pr.stdout.trim()}` };
  const { ref, line } = branchedFrom();
  process.stdout.write(`${line}\n`);
  return { merged, mergedCheckout, ref };
}

/**
 * The base of a branch without a pull request: the long-lived branch whose own line HEAD's own line leaves. Both are
 * read as first-parent lines (`git rev-list --first-parent`), so a merge into either, as main merged into a branch of
 * runtime-v2, does not count. Main lands squashed, and runtime-v2 takes main through merges whose first parent is its
 * own, so a commit after the two split is on one line only; a commit on both is from before the split, and gives
 * `origin/main`. That landing premise is assumed, not checked; if it fails, the inference can return a wrong ref rather
 * than exit 2. Merges keep it by their route: main reaches runtime-v2 only through a pull request merged with a merge
 * commit, whose first parent is runtime-v2's tip. History is read as Git presents it, replaced refs and grafts
 * included. A branch stacked on another lane is given its long-lived line, not the lane: its pull request's base, or
 * `--base`, names the lane. Returns that ref and a line naming it, with the commit where HEAD's line leaves it. Exit 2
 * when it cannot prove which: in a shallow clone, without either ref, or when HEAD's line meets neither (#2409).
 */
export function branchedFrom() {
  const pass = "name the base with --base";
  if (git("rev-parse", "--is-shallow-repository") === "true")
    cannotRun(
      `no --base and no pull request, and the clone is shallow: deepen it (git fetch --unshallow), or ${pass}`,
    );
  const lines = MERGED_INTO_EACH_OTHER.map((ref) => {
    const line = spawnSync("git", ["rev-list", "--first-parent", ref, "--"], { encoding: "utf8" });
    if (line.status !== 0)
      cannotRun(
        `no --base and no pull request, and no ${ref} to tell the base by: fetch ` +
          `${MERGED_INTO_EACH_OTHER.join(" and ")}, or ${pass}`,
      );
    return [ref, new Set(line.stdout.split("\n"))];
  });
  const own = git("rev-list", "--first-parent", "HEAD", "--").split("\n");
  for (const [back, commit] of own.entries()) {
    const on = lines.find(([, line]) => line.has(commit));
    if (on !== undefined)
      return {
        ref: on[0],
        line:
          `check-changed: no --base and no pull request: base ${on[0]}, whose own line HEAD's leaves at ` +
          `${commit.slice(0, 9)}, ${back} commits back`,
      };
  }
  return cannotRun(
    `no --base and no pull request, and HEAD's line meets neither ${MERGED_INTO_EACH_OTHER.join(" nor ")}'s: ${pass}`,
  );
}

/**
 * `--merged-checkout`: the commit `name` names, once HEAD is proven to be it, or its merge with `ref`'s commit, the
 * commit first.
 */
function mergedCheckoutCommit(name, ref) {
  // (a commit's full SHA, and how the message names it: a full SHA as its first 9 characters)
  const commit = (of) => {
    let sha;
    try {
      sha = git("rev-parse", "--verify", "--quiet", `${of}^{commit}`);
    } catch {
      cannotRun(`no commit ${of}: fetch it`);
    }
    return [sha, of === sha ? sha.slice(0, 9) : `${of} (${sha.slice(0, 9)})`];
  };
  const [branch, branchName] = commit(name);
  const [base, baseName] = commit(ref);
  const [head, ...parents] = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  if (head === branch) return branch;
  if (parents.length === 2 && parents[0] === branch && parents[1] === base) {
    process.stdout.write(
      `check-changed: HEAD (${head.slice(0, 9)}) merges ${baseName} into ${branchName}; only ` +
        `${branchName}'s merge commits are judged\n`,
    );
    return branch;
  }
  return cannotRun(
    `--merged-checkout ${branchName}: HEAD (${head.slice(0, 9)}) is neither that commit nor its merge with ` +
      `${baseName}, whose first parent is that commit and second the base's`,
  );
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
 * This host's C library as npm-install-checks 8 finds it (`lib/current-env.js`): on Linux, from `/usr/bin/ldd`'s text,
 * else from the process report (glibc's version, or a musl shared object); `null` when neither says, and off Linux.
 */
function hostLibc() {
  if (process.platform !== "linux") return null;
  try {
    const ldd = readFileSync("/usr/bin/ldd", "utf8");
    return ldd.includes("musl") ? "musl" : ldd.includes("GNU C Library") ? "glibc" : null;
  } catch {}
  const report = process.report.getReport();
  if (report.header?.glibcVersionRuntime) return "glibc";
  return (report.sharedObjects ?? []).some((file) => /libc\.musl-|ld-musl-/u.test(file))
    ? "musl"
    : null;
}

/** This host as npm's `os`, `cpu` and `libc` fields name it. */
const HOST = { os: process.platform, cpu: process.arch, libc: hostLibc() };

/**
 * Whether npm's list `list` (an `os`, `cpu` or `libc` field, `!` negating, `any`) admits `value`, as npm-install-checks
 * reads it: no list admits everything, and a list never admits a host without that value (a `libc` field off Linux).
 */
function admits(list, value) {
  if (list === undefined) return true;
  if (value === null) return false;
  const entries = typeof list === "string" ? [list] : list;
  if (entries.length === 1 && entries[0] === "any") return true;
  let negated = 0;
  let match = false;
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      negated += 1;
      if (entry.slice(1) === value) return false;
    } else match ||= entry === value;
  }
  return match || negated === entries.length;
}

/**
 * The packages of the lockfile `lock` that apply to `host` and that npm's record of the install, `installed` (its
 * `node_modules/.package-lock.json`, written at each install), does not hold at the lockfile's version, source
 * (`resolved`) and integrity, each as `<path> <version> (<what is there>)`. A package applies unless it is `optional`
 * and either its own `os`, `cpu` or `libc` field excludes `host` (another platform's binary) or no package the record
 * holds depends on it (so only an excluded package needs it, as the WebAssembly bindings' helpers, which have none of
 * those fields). It compares the record, not the installed files, and says nothing of a package the lockfile does not
 * name. A lockfile without `packages` (npm's lockfile versions 2 and 3 have it) cannot be compared: it throws.
 */
export function notInstalled(lock, installed, host = HOST) {
  if (typeof lock.packages !== "object" || lock.packages === null)
    throw new Error("package-lock.json has no `packages` to compare node_modules with");
  const recorded = (path) => path === "" || installed.packages?.[path] !== undefined;
  // (the path a package at `from` reaches for `name`: its own node_modules, then each enclosing one, as Node resolves)
  const resolve = (from, name) => {
    for (
      let folder = from;
      ;
      folder = folder.slice(0, Math.max(0, folder.lastIndexOf("/node_modules/")))
    ) {
      const path = `${folder === "" ? "" : `${folder}/`}node_modules/${name}`;
      if (lock.packages[path] !== undefined) return path;
      if (folder === "") return null;
    }
  };
  const needed = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!recorded(path)) continue;
    const optionalPeers = entry.peerDependenciesMeta ?? {};
    for (const name of [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...(path === "" ? Object.keys(entry.devDependencies ?? {}) : []),
      ...Object.keys(entry.peerDependencies ?? {}).filter((peer) => !optionalPeers[peer]?.optional),
    ])
      needed.add(resolve(path, name));
  }
  const differences = [];
  for (const [path, wanted] of Object.entries(lock.packages)) {
    if (path === "") continue;
    const there = installed.packages?.[path];
    if (there === undefined) {
      const excluded =
        !admits(wanted.os, host.os) ||
        !admits(wanted.cpu, host.cpu) ||
        !admits(wanted.libc, host.libc);
      if (!wanted.optional || (!excluded && needed.has(path)))
        differences.push(`${path} ${wanted.version} (not installed)`);
    } else if (["version", "resolved", "integrity"].some((key) => there[key] !== wanted[key]))
      differences.push(`${path} ${wanted.version} (installed: ${there.version})`);
  }
  return differences;
}

/**
 * Why npm's record of the `node_modules` in the folder `root` (the working folder by default) does not hold its
 * `package-lock.json` (#2087, as `notInstalled` compares them), naming the first differences and the remedies, or `null`
 * when it does. A folder without a lockfile has nothing to compare.
 */
export function lockfileMismatch(root = ".") {
  if (!existsSync(join(root, "package-lock.json"))) return null;
  const why = (what) =>
    `npm's record of node_modules (${realpathSync(join(root, "node_modules"))}) does not hold package-lock.json: ${what}. ` +
    "Main's lockfile: wait for teasescript-main's refresh, and remove a node_modules link pinned to a slot instead of " +
    "`current` (check-changed then links `current`). A branch behind main's lockfile: rebase, or check with --merged. " +
    "A lockfile the branch changes: run the checks in the queue. Your own node_modules: run `npm ci`";
  if (!existsSync(join(root, "node_modules/.package-lock.json")))
    return why("it has no .package-lock.json, which npm writes at each install");
  let differences;
  try {
    differences = notInstalled(
      JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
      JSON.parse(readFileSync(join(root, "node_modules/.package-lock.json"), "utf8")),
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

/**
 * The checks this run started, in order, the verdicts of those that ended, and, once every check has started, the
 * project checks no changed path needs: what the last line names (`lastLine`).
 */
const progress = { started: [], ended: new Map(), notNeeded: null };

/** A check's run: its verdict, seconds and output; `shown` prints the output also when it passes. */
function run(name, command, args, shown = false) {
  const start = performance.now();
  progress.started.push(name);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    running.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      progress.ended.set(name, false);
      resolve({ name, passed: false, seconds: 0, output: error.message, shown });
    });
    child.on("close", (code) => {
      running.delete(child);
      progress.ended.set(name, code === 0);
      const seconds = (performance.now() - start) / 1000;
      resolve({ name, passed: code === 0, seconds, output, shown });
    });
  });
}

/** A check that has already ended (the merge-commit scan, in this process): its result, which the last line counts. */
function settled(name, passed, seconds, output) {
  progress.started.push(name);
  progress.ended.set(name, passed);
  return { name, passed, seconds, output, shown: false };
}

/**
 * The last line (#2106), so that no run, also one that cannot run or is stopped, can be read as one that ran more: what
 * ran, failed, and did not run, a check a signal stopped, a project check no changed path needs and the compiled suite
 * included.
 */
function lastLine() {
  if (progress.notNeeded === null)
    return `check-changed: ${summaryLine([{ name: "every check", status: "NOT RUN" }])}`;
  const verdict = (name) =>
    progress.ended.has(name) ? (progress.ended.get(name) ? "PASS" : "FAIL") : "ABORTED";
  return `check-changed: ${summaryLine([
    ...progress.started.map((name) => ({ name, status: verdict(name) })),
    ...progress.notNeeded.map((name) => ({ name, status: "NOT RUN" })),
    { name: NEVER_RUN, status: "NOT RUN" },
  ])}`;
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
    const conflicts = namesFrom("-C", directory, "diff", "-z", "--name-only", "--diff-filter=U");
    cannotRun(
      `HEAD does not merge into ${ref} (${baseCommit.slice(0, 9)}): ${conflicts.join(", ") || merge.stderr.trim()}`,
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
  const { merged, mergedCheckout, ref } = options(process.argv.slice(2));
  if (!existsSync("node_modules")) {
    process.stdout.write(`check-changed: ${linkMainNodeModules(process.env, process.cwd())}\n`);
  }
  // (the branch's commit: read before `--merged` enters its worktree, whose HEAD is the base's commit)
  const head =
    mergedCheckout === null ? git("rev-parse", "HEAD") : mergedCheckoutCommit(mergedCheckout, ref);
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

  // Every path the change touches selects checks: a deleted one, whose project's checks or test:lint can then fail
  // (#2431), and both sides of a move, which only `--no-renames` lists, each as it is named (`namesFrom`). The checks
  // that read the files get those that exist (`changed`).
  const touched = [
    ...new Set([
      ...namesFrom("diff", "-z", "--name-only", "--no-renames", mergeBase),
      // (the merge's worktree has no untracked file but the linked `node_modules`)
      ...(merged ? [] : namesFrom("ls-files", "-z", "--others", "--exclude-standard")),
    ]),
  ];
  const changed = touched.filter((path) => existsSync(path));
  const projects = projectsFor(touched);
  process.stdout.write(
    `check-changed: ${touched.length} changed files since ${ref} (${mergeBase.slice(0, 9)}); ` +
      `projects: ${[...projects].join(", ") || "none"}\n`,
  );
  const unknown = unknownToCostly(changed);
  if (unknown.length > 0) process.stdout.write(`${unknown.join(", ")}: ${UNKNOWN_TO_COSTLY}\n`);

  const coreChanged = touched.some((path) => path.startsWith(CORE));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const formatted = changed.filter((path) => FORMATTED.test(path));
  const [formatter, ...formatterArgs] = prettier();
  const scan = performance.now();
  // (under --merged-checkout, the head's own merge of the base is the builder's: no queue hint)
  const stray = strayMerges(
    mergeBase,
    head,
    merged ? mergeBase : ref,
    ref,
    mergedCheckout === null,
  );
  const scanSeconds = (performance.now() - scan) / 1000;
  const checks = [
    run("diff --check", "git", ["diff", "--check", mergeBase]),
    settled(
      "merge commits",
      stray.length === 0,
      scanSeconds,
      stray.map((line) => `${line}\n`).join(""),
    ),
    ...(formatted.length > 0
      ? [run("format", formatter, [...formatterArgs, "--check", ...formatted])]
      : []),
    run("oxlint", process.execPath, ["tools/oxlint/run.mjs"]),
    run("knip", process.execPath, ["node_modules/knip/bin/knip.js"]),
    run("doc links", process.execPath, ["tools/repository-checks/doc-links.mjs"]),
    run("imports", process.execPath, ["tools/repository-checks/imports.mjs"]),
    run("test:verification", npm, ["run", "--silent", "test:verification"]),
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
  const selected = checksOf(projects);
  progress.notNeeded = checksOf(Object.keys(PROJECTS)).filter((check) => !selected.includes(check));
  const results = await Promise.all(checks);
  // (a signal has ended the run: its verdicts are not printed)
  if (ended) return null;
  for (const { name, passed, seconds } of results)
    process.stdout.write(
      `${passed ? "PASS" : "FAIL"}  ${name.padEnd(18)} ${seconds.toFixed(1)}s\n`,
    );
  for (const { name, passed, output, shown } of results)
    if (!passed || shown) process.stdout.write(`\n--- ${name} ---\n${output}`);
  // (a link through main's `current` follows its refresh, which can switch it to another install while the checks run)
  const after = lockfileMismatch();
  if (after !== null) {
    process.stderr.write(
      `check-changed: node_modules changed while the checks ran, so their verdicts do not count: ${after}\n`,
    );
    return 2;
  }
  return results.every(({ passed }) => passed) ? 0 : 1;
}

/** Whether the run's end is decided (`main`'s `end`): from then on nothing changes its status or its last line. */
let ended = false;

async function main() {
  const cleanups = [];
  const cleanup = () => {
    stop();
    for (const step of cleanups) step();
  };
  /**
   * The run's one end, whichever path comes first: a normal end, one that cannot run, or a signal. It stops the checks,
   * cleans up, then writes the last line, once; a later call, as a signal during that, or while the last line waits for
   * a slow reader, changes nothing. A cleanup that refuses (exit 2) outranks a verdict, not a signal. The last line
   * follows a blank one, unless the run could not start its checks.
   */
  const end = (code, { exit = false, blank = true } = {}) => {
    if (ended) return;
    ended = true;
    cleanup();
    const status = process.exitCode === 2 && code < 2 ? 2 : code;
    process.exitCode = status;
    process.stdout.write(`${blank ? "\n" : ""}${lastLine()}\n`, () => {
      if (exit) process.exit(status);
    });
  };
  // (installed until the process exits)
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])
    process.on(signal, () => end(code, { exit: true }));
  let code;
  try {
    code = await check(cleanups);
  } catch (error) {
    if (!(error instanceof CannotRun)) {
      cleanup();
      throw error;
    }
    if (!ended) process.stderr.write(`check-changed: ${error.message}\n`);
    end(2, { blank: false });
    return;
  }
  if (code !== null) end(code);
}

if (import.meta.main) await main();
