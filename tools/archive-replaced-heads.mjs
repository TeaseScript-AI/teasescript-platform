import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A `pre-push` hook: before a push replaces a branch's head on the remote with one that does not contain it (a
// force-push) or deletes the branch, it pushes that old head to `refs/archive/<full sha>` on the same remote, so a
// commit a report or review cites stays readable there (`tools/check-shas.mjs` reads such refs on origin), and keeps
// the same ref in this clone. A fast-forward, a new branch and any other ref outside `refs/archive/` cost nothing.
//
//   node tools/archive-replaced-heads.mjs <remote name> <remote URL>     (git's pre-push arguments; its ref lines on
//                                                                        standard input)
//
// Archives are written once and kept:
// - An archive ref that already holds the old head is left; one that holds anything else refuses the push. The new
//   ones are pushed with a lease that they do not exist yet, so a race refuses too.
// - Each archive is also a ref in this clone, and git prunes on the remote only a ref this clone lacks: a `--mirror`
//   or `--prune` push, which lists the refs it prunes to no hook, therefore leaves every archive this clone has.
// - A push that lists a deletion or move of an archive ref is refused.
// Limit: an archive made from another clone and not yet fetched here (`+refs/archive/*:refs/archive/*`) can be pruned
// by a pruning push from this clone.
//
// It prints each head it archived. When an old head cannot be archived (this clone lacks it, or the archive push
// fails), it exits 1 and git refuses the whole push. The archive push runs with `--no-verify`, so it never runs this
// hook again. Git gives the hook no sign of `--dry-run`, so a dry run that would replace a head archives it too.

const ZERO = /^0+$/u;
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

/** The archive refs the pushed `lines` would delete or move. */
export function movedArchives(lines) {
  return lines
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter(
      ([, local, ref, old]) => ref?.startsWith("refs/archive/") && !ZERO.test(old) && local !== old,
    )
    .map(([, , ref]) => ref);
}

/** The old heads the pushed `lines` replace without containing them, or delete: `{ ref, old }` each. */
export function replacedHeads(lines) {
  const replaced = [];
  for (const line of lines.split("\n")) {
    const [, local, ref, old] = line.trim().split(/\s+/u);
    if (ref === undefined || !ref.startsWith("refs/heads/") || ZERO.test(old)) continue;
    // (a deletion pushes the zero id; else the old head must be an ancestor of the new one)
    if (ZERO.test(local) || git("merge-base", "--is-ancestor", old, local).status !== 0)
      replaced.push({ ref, old });
  }
  return replaced;
}

function main() {
  const [, url] = process.argv.slice(2);
  const fail = (message) => {
    process.stderr.write(`archive-replaced-heads: ${message}; push refused\n`);
    process.exit(1);
  };
  if (url === undefined) fail("usage: node tools/archive-replaced-heads.mjs <remote> <url>");
  const lines = readFileSync(0, "utf8");
  const moved = movedArchives(lines);
  if (moved.length > 0)
    fail(`${moved.join(", ")} would be deleted or moved, and archives are kept`);
  const replaced = replacedHeads(lines);
  if (replaced.length === 0) return;
  const missing = replaced.filter(
    ({ old }) => git("cat-file", "-e", `${old}^{commit}`).status !== 0,
  );
  if (missing.length > 0)
    fail(
      missing
        .map(({ ref, old }) => `${ref} is ${old} there, which this clone lacks: fetch it`)
        .join("; "),
    );
  // (each old head once: branches that shared it share its archive)
  const olds = [...new Set(replaced.map(({ old }) => old))];
  const refs = olds.map((old) => `refs/archive/${old}`);
  const listed = git("ls-remote", url, ...refs);
  if (listed.status !== 0)
    fail(`cannot list the remote's archives (${listed.stderr.trim().split("\n").at(-1)})`);
  // (`ls-remote` matches its patterns at the end of a ref's name: keep only the exact refs)
  const there = new Map(
    listed.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").reverse())
      .filter(([ref]) => refs.includes(ref)),
  );
  const here = new Map(
    refs.map((ref) => [ref, git("rev-parse", "--verify", "--quiet", ref).stdout.trim()]),
  );
  const wrong = refs.filter(
    (ref) =>
      (there.has(ref) && there.get(ref) !== ref.slice(13)) ||
      (here.get(ref) !== "" && here.get(ref) !== ref.slice(13)),
  );
  if (wrong.length > 0) fail(`${wrong.join(", ")} holds another commit`);
  const toPush = olds.filter((old) => !there.has(`refs/archive/${old}`));
  if (toPush.length > 0) {
    const pushed = git(
      "push",
      "--no-verify",
      "--quiet",
      ...toPush.map((old) => `--force-with-lease=refs/archive/${old}:`),
      url,
      ...toPush.map((old) => `${old}:refs/archive/${old}`),
    );
    if (pushed.status !== 0)
      fail(`cannot archive the replaced heads (${pushed.stderr.trim().split("\n").at(-1)})`);
  }
  // (the clone's own archive refs, so that a pruning push from it never deletes them on the remote)
  for (const old of olds)
    if (here.get(`refs/archive/${old}`) === "") {
      const kept = git("update-ref", `refs/archive/${old}`, old, "");
      if (kept.status !== 0)
        fail(`cannot keep refs/archive/${old} in this clone (${kept.stderr.trim()})`);
    }
  for (const { ref, old } of replaced)
    process.stderr.write(
      `archive-replaced-heads: ${ref} was ${old}: archived as refs/archive/${old}\n`,
    );
}

if (import.meta.main) main();
