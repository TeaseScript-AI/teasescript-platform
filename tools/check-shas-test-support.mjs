// The fixtures of check-shas's tests: the tool's path, a repository of empty commits, and a run of the tool on a text;
// Git is isolated from the user's configuration on import.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateGit } from "./fixture-git.mjs";

isolateGit();

export const tool = fileURLToPath(new URL("./check-shas.mjs", import.meta.url));

/** A repository with `count` empty commits, made at once by `git fast-import`; its directory and their SHAs. */
export function repository(count = 1) {
  const directory = mkdtempSync(join(tmpdir(), "check-shas-"));
  spawnSync("git", ["init", "-q", directory]);
  let stream = "";
  for (let n = 0; n < count; n += 1)
    stream += `commit refs/heads/main\ncommitter t <t@t> ${1_700_000_000 + n} +0000\ndata 1\n${n % 10}\n\n`;
  spawnSync("git", ["-C", directory, "fast-import", "--quiet"], { input: stream });
  const shas = spawnSync("git", ["-C", directory, "rev-list", "main"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n");
  return { directory, shas };
}

/** The tool's exit status and output for `text`, read from standard input, in `repositories`. */
export function check(text, repositories) {
  const result = spawnSync(
    process.execPath,
    [tool, ...repositories.flatMap((r) => ["--repo", r])],
    { input: text, encoding: "utf8" },
  );
  return { status: result.status, out: result.stdout + result.stderr };
}
