// The fixtures the structure report's tests share (`structure-report.test.mjs`, `structure-report-modes.test.mjs`): the
// report's path, files of a given length or with a function of one, and a Git history of a base and a change. Git is
// isolated from the user's configuration when this module loads (`fixture-git.mjs`).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isolateGit } from "./fixture-git.mjs";

isolateGit();

export const tool = fileURLToPath(new URL("./structure-report.mjs", import.meta.url));

/** `count` lines of code. */
export const lines = (count, prefix = "export const x") =>
  Array.from({ length: count }, (_, i) => `${prefix}${i} = ${i};`).join("\n");
/** A file whose function `name` spans `count` lines. */
export const longFunction = (name, count) =>
  `export function ${name}() {\n${Array.from({ length: count - 2 }, (_, i) => `  const v${i} = ${i};`).join("\n")}\n}`;

export function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A repository with `base` committed, then `change` committed over it; its folder, `git` and the base commit. */
export function history(base, change, setUp = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "structure-report-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  setUp(root, git);
  write(root, base);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  write(root, change);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return { root, git, base: baseCommit };
}
