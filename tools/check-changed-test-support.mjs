// What check-changed's tests share: `isolateGit()`, the fixture repository, the tool's path, and a temporary folder
// of the run's own (`TMPDIR`), removed when the process exits.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateGit } from "./fixture-git.mjs";
import { awaitFile, runSync } from "./runner-test-support.mjs";

isolateGit();

/**
 * A repository with a base branch `main` and a branch `feature` off it, each changing `a.mjs` as `edit` says. `core`
 * also changes a file of the type core on `feature` ("added", or "deleted" or "renamed" out of the core, the file being
 * on `main` for those), and `changed` adds that path on `feature`;
 * `mapper` is code the stand-in pin-suite mapper runs after its line. `passing` leaves `a.mjs` as it was and gives every
 * other check a stand-in that passes, so the mapper's verdict alone decides the run. `lock` is the lockfile's packages
 * and `installed` those the stand-in `node_modules` records as installed.
 */
export function repository({
  conflict = false,
  slowOxlint = false,
  core = false,
  changed = null,
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
  // (a stand-in test:lint, which every change but documentation runs, that passes with the other stand-ins)
  write(
    "package.json",
    JSON.stringify({
      devDependencies: { prettier: "0.0.0" },
      ...(passing ? { scripts: { "test:lint": "node -e 0" } } : {}),
    }),
  );
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
      "tools/repository-checks/readme-paths.mjs",
    ])
      write(path, "\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  run("switch", "-q", "-c", "feature");
  if (!passing) write("a.mjs", "export const a = 2;\n");
  if (core === "added") write("src/type-inference/core/answers.ts", "export const answers = 1;\n");
  if (changed !== null) write(changed, "export const changed = 1;\n");
  if (core === "deleted") rmSync(join(directory, "src/type-inference/core/answers.ts"));
  if (core === "renamed")
    run("mv", "src/type-inference/core/answers.ts", "src/type-inference/answers.ts");
  run("add", "-A");
  run("commit", "-q", "-m", "feature");
  if (conflict) {
    run("switch", "-q", "main");
    write("a.mjs", "export const a = 3;\n");
    run("commit", "-q", "-am", "main");
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

export const tool = fileURLToPath(new URL("./check-changed.mjs", import.meta.url));
// Each run gets a temporary folder of its own (`TMPDIR`), so other runs of the tool on this machine cannot change what
// is left in it. (Without `agent-prettier` on `PATH`, so the stand-in Prettier runs wherever the test does.)
export const runTmp = mkdtempSync(join(tmpdir(), "check-changed-test-"));
process.on("exit", () => rmSync(runTmp, { recursive: true, force: true }));
export const environment = {
  ...process.env,
  TMPDIR: runTmp,
  PATH: dirname(process.execPath) + ":/usr/bin:/bin",
};
export const leftovers = () =>
  readdirSync(runTmp).filter((name) => name.startsWith("check-changed-merged-"));
