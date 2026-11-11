// What two or more of compiler-replay's steps share: the tree's root and its areas, the queue call and its temporary
// folders, the usage error, and the mode names.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatorFolders, holdsGenerators } from "../../tests/families/sources.mjs";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SHARDS = 16;
export const CASES = path.join(homedir(), "work", "o4-m4-g3", "cases.json");
export const USAGE =
  "usage: node tools/compiler-replay.mjs submit|collect|rerun-shard|rerun-stalls|aside|plan-checks … (its header)";

export class Usage extends Error {}

/** The areas, as `baselines.mjs` takes them: each `{ name, folder }`, the folder relative to a tree's root. */
export function areasOf(root) {
  const fixture = path.join(root, "tools", "corpus", "fixture");
  return [
    ...generatorFolders(path.join(root, "tests", "families")),
    ...(holdsGenerators(fixture) ? [fixture] : []),
  ].map((folder) => ({ name: path.basename(folder), folder: path.relative(root, folder) }));
}

/** An argument as a shell word, for `sx-job submit-batch`'s lines. */
export const quoted = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * `use(folder)`'s result, `folder` a new temporary folder of this invocation (under `os.tmpdir()`: a queue job's own
 * `TMPDIR`), removed by its path once `use` returns or throws (#2433); a signal that ends the process leaves it.
 */
export function inTemporaryFolder(use) {
  const folder = mkdtempSync(path.join(tmpdir(), "compiler-replay-"));
  try {
    return use(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** `sx-job` with `args`: its job ids, or a usage error naming its output. */
export function queue(args) {
  const run = spawnSync("sx-job", args, { encoding: "utf8" });
  if (run.status !== 0)
    throw new Usage(`sx-job ${args[0]} failed: ${run.stderr.trim() || run.stdout.trim()}`);
  return run.stdout.split("\n").filter((line) => /^[0-9a-f]{14}$/u.test(line.trim()));
}

export const git = (...args) => {
  const run = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) throw new Usage(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.trim();
};

/** The set's modes as the runner names them, in `HELD_MODES`' order (shared first, forward then reversed). */
export const MODES = ["src-on", "rev-on", "src-off", "rev-off"];
/** The runner's name of a set record's mode: its `HELD_MODES` name, or a number (before #2342) by that order. */
const LABEL_OF = {
  forward: "src-on",
  reversed: "rev-on",
  "forward, unshared": "src-off",
  "reversed, unshared": "rev-off",
};
export const labelOf = (mode) => (typeof mode === "number" ? MODES[mode] : LABEL_OF[mode]);
export const MODE_OF = {
  "src-on": { reversed: false, unshared: false },
  "src-off": { reversed: false, unshared: true },
  "rev-on": { reversed: true, unshared: false },
  "rev-off": { reversed: true, unshared: true },
};
