import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Runs, before a push, the checks CI fails on for what changed since a base, in parallel, and prints one line per check
// with its verdict and seconds, and the full output of a check that failed:
//
//   node tools/check-changed.mjs [--base <ref>]
//
// The base is `--base`, else the open pull request's base (`gh pr view`, as `origin/<base>`), else `origin/main`; the
// changes are those since its merge-base with HEAD, committed or not, untracked files included. Always: `git diff
// --check`, the format check of the changed files, oxlint and knip, each as CI runs it. Then each project a changed
// path belongs to (`projectsFor`): its type check and tests. A changed path no project claims, other than
// documentation, runs every project's checks.
//
// Exit status: 0 when every check passed, 1 when one failed, 2 when the checks cannot run (no base, or no
// `node_modules`, which it never installs: it names the fix).

/** The projects a changed path can belong to, each with the npm scripts or commands that check it. */
export const PROJECTS = {
  typescript: {
    // (and the tests' fixture data, which only the tests read: CI runs them)
    claims: (path) =>
      (/^(?:src|tests|playground|player)\/.*\.(?:ts|mts|cts|tsx)$/u.test(path) &&
        !path.startsWith("player/vue/")) ||
      path.startsWith("tests/fixtures/"),
    checks: ["tsc"],
  },
  families: { claims: (path) => path.startsWith("tests/families/"), checks: ["test:families"] },
  "player-vue": {
    claims: (path) => path.startsWith("player/vue/"),
    checks: ["typecheck:player", "lint:design"],
  },
  "oxlint-rules": { claims: (path) => path.startsWith("tools/oxlint/"), checks: ["test:lint"] },
  tools: {
    claims: (path) => /^tools\/[^/]+\.(?:mjs|cjs|js)$/u.test(path),
    checks: ["test:verification"],
  },
};

/** A path whose change no project's check covers, as CI checks none of it: documentation. */
const isDocumentation = (path) => path.endsWith(".md") || path.startsWith("docs/");

/**
 * The projects whose checks `paths` need. A path no project claims, documentation aside, needs every project: an
 * unknown kind of path is checked by everything, never by nothing.
 */
export function projectsFor(paths) {
  const projects = new Set();
  for (const path of paths) {
    if (isDocumentation(path)) continue;
    const claiming = Object.keys(PROJECTS).filter((name) => PROJECTS[name].claims(path));
    for (const name of claiming.length > 0 ? claiming : Object.keys(PROJECTS)) projects.add(name);
  }
  return projects;
}

/** The extensions `npm run format:check` covers. */
const FORMATTED = /\.(?:ts|tsx|cts|mts|js|jsx|cjs|mjs)$/u;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function cannotRun(message) {
  process.stderr.write(`check-changed: ${message}\n`);
  process.exit(2);
}

function base(argv) {
  if (argv[0] === "--base") {
    if (argv.length !== 2) cannotRun("usage: node tools/check-changed.mjs [--base <ref>]");
    return argv[1];
  }
  if (argv.length > 0) cannotRun("usage: node tools/check-changed.mjs [--base <ref>]");
  const pr = spawnSync("gh", ["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"], {
    encoding: "utf8",
  });
  return pr.status === 0 && pr.stdout.trim() !== "" ? `origin/${pr.stdout.trim()}` : "origin/main";
}

/** The formatter CI's version pins: `agent-prettier` on the LXC, else the installed one when its version is the pin. */
function prettier() {
  if (spawnSync("agent-prettier", ["--version"], { stdio: "ignore" }).status === 0)
    return ["agent-prettier"];
  const pinned = JSON.parse(readFileSync("package.json", "utf8")).devDependencies?.prettier;
  const installed = JSON.parse(readFileSync("node_modules/prettier/package.json", "utf8")).version;
  if (installed !== pinned)
    cannotRun(
      `node_modules has prettier ${installed}, but package.json pins ${pinned}: link or install matching ones`,
    );
  return [process.execPath, "node_modules/prettier/bin/prettier.cjs"];
}

function run(name, command, args) {
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) =>
      resolve({ name, passed: false, seconds: 0, output: error.message }),
    );
    child.on("close", (code) =>
      resolve({ name, passed: code === 0, seconds: (performance.now() - start) / 1000, output }),
    );
  });
}

async function main() {
  const ref = base(process.argv.slice(2));
  let mergeBase;
  try {
    mergeBase = git("merge-base", "HEAD", ref);
  } catch {
    cannotRun(`no merge-base of HEAD and ${ref}: fetch it, or name one with --base`);
  }
  if (!existsSync("node_modules")) {
    const lxc = "/opt/agent-stack/teasescript-main/current/node_modules";
    cannotRun(
      existsSync(lxc)
        ? `no node_modules: link it with \`ln -s ${lxc} node_modules\``
        : `no node_modules: link \`$(sx-tree ${mergeBase})/node_modules\`, or run \`npm ci\``,
    );
  }
  const linkedLock = join(dirname(realpathSync("node_modules")), "package-lock.json");
  if (
    existsSync(linkedLock) &&
    readFileSync(linkedLock, "utf8") !== readFileSync("package-lock.json", "utf8")
  )
    process.stderr.write(
      `check-changed: warning: node_modules was installed from ${linkedLock}, another lockfile\n`,
    );

  const changed = [
    ...git("diff", "--name-only", "--diff-filter=d", mergeBase).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter((path) => path !== "" && existsSync(path));
  const projects = projectsFor(changed);
  process.stdout.write(
    `check-changed: ${changed.length} changed files since ${ref} (${mergeBase.slice(0, 9)}); ` +
      `projects: ${[...projects].join(", ") || "none"}\n`,
  );

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
  ];
  for (const project of projects)
    for (const check of PROJECTS[project].checks)
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
  for (const { name, passed, output } of results)
    if (!passed) process.stdout.write(`\n--- ${name} ---\n${output}`);
  process.exitCode = results.every(({ passed }) => passed) ? 0 : 1;
}

if (import.meta.main) await main();
