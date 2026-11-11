import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

// A `pre-push` hook: before a push replaces a branch's head on the remote with one that does not contain it (a
// force-push) or deletes the branch, it pushes that old head to `refs/archive/<full sha>` on the same remote, so a
// commit a report or review cites stays readable there (`tools/check-shas.mjs` reads such refs on origin). A
// fast-forward, a new branch and any other ref outside `refs/archive/` cost nothing. A push that would delete or move
// an archive ref is refused: archives are kept. So is a pruning push (`--mirror`, `--prune`, or a remote with
// `remote.<name>.mirror`): git lists the refs it prunes to no hook, so it could delete an archive unseen. The pruning
// options are read from the git process this hook runs under (`/proc`), as git parses them; where `/proc` cannot be
// read, they are not checked.
//
//   node tools/archive-replaced-heads.mjs <remote name> <remote URL>     (git's pre-push arguments; its ref lines on
//                                                                        standard input)
//
// It prints each head it archived. When an old head cannot be archived (this clone lacks it, or the archive push
// fails), it exits 1 and git refuses the whole push. The archive push runs with `--no-verify`, so it never runs this
// hook again. Git gives the hook no sign of `--dry-run`, so a dry run that would replace a head archives it too.

const ZERO = /^0+$/u;
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

/** The `git push` options a long option `arg` names, by git's own table and its unique-prefix rule, or `null`. */
function pushOption(arg, options) {
  const name = `--${arg.slice(2).split("=")[0]}`;
  if (options.includes(name)) return name;
  const candidates = options.filter((option) => option.startsWith(name));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Whether the push this hook runs under prunes: `remote.<remote>.mirror`, or `--mirror` or `--prune` (in any spelling
 * git accepts, the last of `--x` and `--no-x` winning) on the nearest ancestor process whose executable is git,
 * whatever name invoked it. `null` when `/proc` cannot be read or no git ancestor is found; `true` when that ancestor
 * shows no `push`, as its options cannot be read.
 */
function pruningPush(remote) {
  if (git("config", "--bool", `remote.${remote}.mirror`).stdout.trim() === "true") return true;
  for (let pid = process.ppid; pid > 1;) {
    let argv;
    let stat;
    let executable;
    try {
      executable = readlinkSync(`/proc/${pid}/exe`);
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return null;
    }
    if (basename(executable) === "git") {
      const push = argv.indexOf("push", 1);
      if (push < 0) return true;
      // (git's own table of push's long options, hidden ones included)
      const options = git("push", "--git-completion-helper-all").stdout.trim().split(/\s+/u);
      const set = new Map();
      for (const arg of argv.slice(push + 1)) {
        if (arg === "--") break;
        const option = arg.startsWith("--") ? pushOption(arg, options) : null;
        for (const pruning of ["mirror", "prune"])
          if (option === `--${pruning}`) set.set(pruning, true);
          else if (option === `--no-${pruning}`) set.set(pruning, false);
      }
      return set.get("mirror") === true || set.get("prune") === true;
    }
    // (the parent's id: the second field after the parenthesized command name)
    pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  return null;
}

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
  const [remote, url] = process.argv.slice(2);
  const fail = (message) => {
    process.stderr.write(`archive-replaced-heads: ${message}; push refused\n`);
    process.exit(1);
  };
  if (url === undefined) fail("usage: node tools/archive-replaced-heads.mjs <remote> <url>");
  const lines = readFileSync(0, "utf8");
  if (pruningPush(remote))
    fail("a pruning push (--mirror or --prune) can delete archive refs unseen: push without it");
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
  const pushed = git(
    "push",
    "--no-verify",
    "--quiet",
    url,
    // (each old head once: branches that shared it share its archive)
    ...new Set(replaced.map(({ old }) => `${old}:refs/archive/${old}`)),
  );
  if (pushed.status !== 0)
    fail(`cannot archive the replaced heads (${pushed.stderr.trim().split("\n").at(-1)})`);
  for (const { ref, old } of replaced)
    process.stderr.write(
      `archive-replaced-heads: ${ref} was ${old}: archived as refs/archive/${old}\n`,
    );
}

if (import.meta.main) main();
