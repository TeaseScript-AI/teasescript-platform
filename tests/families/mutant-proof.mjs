// node tests/families/mutant-proof.mjs <checkout> <patch>
// The proof that a mutant's checkout is its head with the patch applied as the queue applies it (#1684), by doing it
// again: in the checkout's own repository (its config and attributes), a fresh detached worktree of the head, the
// queue's command on the same patch bytes (`git apply --whitespace=nowarn`), and the paths that application touched
// (`git status --porcelain -z --ignored --untracked-files=all` in the fresh tree, every path whole). Whatever git
// converts on the way it converts alike on both sides, so nothing is decoded: for each touched path the checkout must
// hold what the fresh tree holds, the same kind (file, link or none), executable bit and raw bytes. A path the
// checkout changed that the application did not touch is outside the proof's claim (a mutant is its patch's paths),
// reported, not refused.
// Prints the proof as one JSON object (the patch's sha256, each touched path with its kind, mode and sha256, and the
// paths outside); exits 2 where the fresh application fails (an empty or broken patch, a filter driver the worker
// lacks), 1 where the checkout differs at a touched path, naming it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [checkoutArgument, patchFile] = process.argv.slice(2);
if (patchFile === undefined) {
  process.stderr.write("usage: node tests/families/mutant-proof.mjs <checkout> <patch>\n");
  process.exit(2);
}
const [checkout, patch] = [resolve(checkoutArgument), resolve(patchFile)];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A git command's run in `cwd`. */
const git = (cwd, args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 1 << 28 });

/** The paths `git status` lists in `cwd`, whole (`-z`: `XY path`, a rename's or copy's source after it). */
function changed(cwd, extra) {
  const ran = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...extra]);
  if (ran.status !== 0) throw new Error(`git status: ${ran.stderr.toString().trim()}`);
  const fields = ran.stdout.toString("utf8").split("\0");
  const paths = [];
  for (let index = 0; index < fields.length - 1; index += 1) {
    const entry = fields[index];
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") paths.push(fields[++index]);
  }
  return paths;
}

/** A path's state in a tree: its kind, executable bit and the sha256 of its bytes (a link's target). */
function state(root, path) {
  const full = join(root, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { kind: "none" };
  }
  if (stat.isSymbolicLink()) return { kind: "link", sha256: sha256(readlinkSync(full)) };
  if (!stat.isFile()) return { kind: "other" };
  return {
    kind: "file",
    executable: (stat.mode & 0o111) !== 0,
    sha256: sha256(readFileSync(full)),
  };
}

const scratch = mkdtempSync(join(tmpdir(), "mutant-proof-"));
const fresh = join(scratch, "fresh");
let added = false;
const cleanup = () => {
  if (added) git(checkout, ["worktree", "remove", "--force", fresh]);
  rmSync(scratch, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cleanup();
    process.exit(2);
  });
let status = 0;
let message = "";
try {
  const add = git(checkout, ["worktree", "add", "--quiet", "--detach", fresh, "HEAD"]);
  if (add.status !== 0) throw new Error(`git worktree add: ${add.stderr.toString().trim()}`);
  added = true;
  const applied = git(fresh, ["apply", "--whitespace=nowarn", patch]);
  if (applied.status !== 0) {
    status = 2;
    message = `the patch does not apply to the head as the queue applies it: ${applied.stderr.toString().trim()}`;
  } else {
    const touched = [...new Set(changed(fresh, ["--ignored"]))].sort();
    const paths = touched.map((path) => ({ path, ...state(fresh, path) }));
    const differing = paths.filter(
      ({ path, ...expected }) => JSON.stringify(state(checkout, path)) !== JSON.stringify(expected),
    );
    const outside = changed(checkout, []).filter((path) => !touched.includes(path));
    process.stdout.write(
      `${JSON.stringify({ patch: sha256(readFileSync(patch)), paths, outside })}\n`,
    );
    if (touched.length === 0) {
      status = 2;
      message = "the patch touches no path";
    } else if (differing.length > 0) {
      status = 1;
      message = `the checkout is not the head with the patch applied at ${differing.map((each) => JSON.stringify(each.path)).join(", ")}`;
    } else if (outside.length > 0)
      process.stderr.write(
        `mutant-proof: changed outside the patch's paths, not part of the proof: ${outside.map((path) => JSON.stringify(path)).join(", ")}\n`,
      );
  }
} catch (error) {
  status = 2;
  message = error instanceof Error ? error.message : String(error);
} finally {
  cleanup();
}
if (status !== 0) process.stderr.write(`mutant-proof: ${message}\n`);
process.exit(status);
