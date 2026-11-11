import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A `pre-push` hook: before a push replaces a branch's head on the remote with one that does not contain it (a
// force-push) or deletes the branch, it pushes that old head to `refs/archive/<full sha>` on the same remote, so a
// commit a report or review cites stays readable there (`tools/check-shas.mjs` reads such refs on origin). A
// fast-forward, a new branch and any ref outside `refs/heads/` cost nothing.
//
//   node tools/archive-replaced-heads.mjs <remote name> <remote URL>     (git's pre-push arguments; its ref lines on
//                                                                        standard input)
//
// It prints each head it archived. When an old head cannot be archived (this clone lacks it, or the archive push
// fails), it exits 1 and git refuses the whole push. The archive push runs with `--no-verify`, so it never runs this
// hook again.

const ZERO = /^0+$/u;
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

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
  const replaced = replacedHeads(readFileSync(0, "utf8"));
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
  const pushed = git(
    "push",
    "--no-verify",
    "--quiet",
    url,
    ...replaced.map(({ old }) => `${old}:refs/archive/${old}`),
  );
  if (pushed.status !== 0)
    fail(`cannot archive the replaced heads (${pushed.stderr.trim().split("\n").at(-1)})`);
  for (const { ref, old } of replaced)
    process.stderr.write(
      `archive-replaced-heads: ${ref} was ${old}: archived as refs/archive/${old}\n`,
    );
}

if (import.meta.main) main();
