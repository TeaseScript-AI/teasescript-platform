// node tests/families/mutant-proof.mjs <checkout> <patch>
// The proof that a mutant's checkout is its head with the patch applied as written (#1684), read from the patch the
// queue applied (`--patch`: the job's `$SX_IN/patch-main.diff`), the head's objects and the checkout's files at the
// patch's paths, never the checkout's status or ignores. Every git call reads paths literally (`GIT_LITERAL_PATHSPECS`).
// - Admission, from the patch's text: at least one path, each a text change of a regular file (100644, 100755) at the
//   head, and no path created, deleted, renamed, copied or re-moded (`git apply --summary` prints nothing), so the
//   queue's `git apply` of it changes those files and nothing else.
// - Equality: the patch applied again to the head in a private index gives each path's expected blob without the
//   checkout; each path's file in the checkout must hash to it.
// Prints the proof as one JSON object: the patch's sha256 and, per path, its blob at the head, the expected blob and
// the checkout's; exits 2 for a patch it refuses, 1 where the checkout is not the head with the patch applied.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [checkout, patchFile] = process.argv.slice(2);
if (patchFile === undefined) {
  process.stderr.write("usage: node tests/families/mutant-proof.mjs <checkout> <patch>\n");
  process.exit(2);
}
const patch = resolve(patchFile);
const refuse = (status, why) => {
  process.stderr.write(`mutant-proof: ${why}\n`);
  process.exit(status);
};

/** A git command's standard output in the checkout, paths literal; a failing command ends the proof. */
function git(args, extra = {}) {
  const ran = spawnSync("git", ["-C", checkout, ...args], {
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...extra },
    encoding: "buffer",
    maxBuffer: 1 << 28,
  });
  if (ran.status !== 0) refuse(2, `git ${args[0]} failed: ${ran.stderr.toString().trim()}`);
  return ran.stdout;
}

// (admission: the patch's own text)
if (git(["apply", "--summary", patch]).length > 0)
  refuse(
    2,
    "the patch creates, deletes, renames, copies or re-modes a path; a mutant changes files' text only",
  );
const records = git(["apply", "--numstat", "-z", patch]).toString("utf8").split("\0");
const paths = [];
for (let index = 0; index < records.length - 1; index += 1) {
  const [added, deleted, path] = records[index].split("\t");
  if (added === "-" || deleted === "-") refuse(2, `${JSON.stringify(path)} is a binary change`);
  if (path === undefined || path === "") refuse(2, "the patch renames or copies a path");
  paths.push(path);
}
if (paths.length === 0) refuse(2, "the patch changes nothing");
const head = new Map();
for (const path of paths) {
  const entry = git(["ls-tree", "-z", "HEAD", "--", path]).toString("utf8").split("\0")[0];
  const found = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
  if (found === null) refuse(2, `${JSON.stringify(path)} is no regular file at the head`);
  head.set(path, found[2]);
}

// (equality: the patch applied again to the head in a private index, against the checkout's files)
const scratch = mkdtempSync(join(tmpdir(), "mutant-proof-"));
const expected = new Map();
try {
  const index = { GIT_INDEX_FILE: join(scratch, "index") };
  git(["read-tree", "HEAD"], index);
  git(["apply", "--cached", "--whitespace=nowarn", patch], index);
  for (const path of paths) {
    const entry = git(["ls-files", "-s", "-z", "--", path], index).toString("utf8").split("\0")[0];
    expected.set(path, /^\d+ ([0-9a-f]+) /.exec(entry)?.[1] ?? "");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const proof = {
  patch: createHash("sha256").update(readFileSync(patch)).digest("hex"),
  paths: paths.map((path) => ({
    path,
    head: head.get(path),
    expected: expected.get(path),
    checkout: git(["hash-object", "--", path]).toString("utf8").trim(),
  })),
};
process.stdout.write(`${JSON.stringify(proof)}\n`);
const differing = proof.paths.filter((each) => each.checkout !== each.expected);
if (differing.length > 0)
  refuse(
    1,
    `the checkout is not the head with the patch applied at ${differing.map((each) => JSON.stringify(each.path)).join(", ")}`,
  );
