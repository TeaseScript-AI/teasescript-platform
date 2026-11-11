import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A `pre-push` hook. Before a push deletes a ref outside `refs/archive/`, or replaces its value with one that does not
// contain it (anything but a commit moving to a descendant), it pushes the old value to `refs/archive/<full sha>` on the
// same remote and keeps the same ref in this clone, so a commit a report or review cites stays readable there
// (`tools/check-shas.mjs` reads such refs on origin). When that fails, it exits 1 and git refuses the whole push.
//
//   node tools/archive-replaced-heads.mjs <remote name> <remote URL>     (git's pre-push arguments; its ref lines on
//                                                                        standard input)
//
// - Archives are written once: one that already holds the old value is left; one that holds anything else refuses the
//   push, naming it; a new one is pushed with a lease that it does not exist yet, so a different one written meanwhile
//   refuses too.
// - A push whose lines delete or rewrite a ref under `refs/archive/` is refused.
// - It judges only those lines, never the command, and pushes its archives with `--no-verify`, so it runs once per push.
// - Git prunes on the remote only refs that no ref of this clone maps onto, so the local archive refs keep a mirror or
//   pruning push from deleting the archives.
//
// Limit: an archive can be deleted by a mirror or pruning push that maps no ref of this clone onto it: one this clone
// has no local ref for, or any archive when a push refspec or `mirror` is configured for the remote. Git lists such a
// deletion to no hook. The agents' clone configures neither, and holds every archive as a local ref. A mirror push
// also deletes, unarchived, the branches and tags this clone lacks, and publishes `refs/t3/`: to this repository's
// origin it is not an agent's to run. The server-side archive is the owner's option if that limit is ever met. Git
// gives the hook no sign of `--dry-run`, so a dry run archives too.

const ZERO = /^0+$/u;
const ARCHIVE = "refs/archive/";
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

/** The push's ref lines, `{ local, ref, old }` each. */
const parse = (lines) =>
  lines
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length === 4)
    .map(([, local, ref, old]) => ({ local, ref, old }));

/** The archive refs the pushed `lines` would delete or rewrite. */
export function movedArchives(lines) {
  return parse(lines)
    .filter(({ local, ref, old }) => ref.startsWith(ARCHIVE) && !ZERO.test(old) && local !== old)
    .map(({ ref }) => ref);
}

/** The refs outside `refs/archive/` whose old value the pushed `lines` delete or replace: `{ ref, old }` each. */
export function replacedValues(lines) {
  const kept = (old, local) =>
    git("cat-file", "-t", old).stdout.trim() === "commit" &&
    git("merge-base", "--is-ancestor", old, local).status === 0;
  return parse(lines)
    .filter(({ local, ref, old }) => !ref.startsWith(ARCHIVE) && !ZERO.test(old) && local !== old)
    .filter(({ local, old }) => ZERO.test(local) || !kept(old, local))
    .map(({ ref, old }) => ({ ref, old }));
}

function main() {
  const [, url] = process.argv.slice(2);
  const fail = (message) => {
    process.stderr.write(`archive-replaced-heads: ${message}; push refused\n`);
    process.exit(1);
  };
  const last = (result) => result.stderr.trim().split("\n").at(-1);
  if (url === undefined) fail("usage: node tools/archive-replaced-heads.mjs <remote> <url>");
  const lines = readFileSync(0, "utf8");
  const moved = movedArchives(lines);
  if (moved.length > 0)
    fail(`${moved.join(", ")} would be deleted or rewritten, and archives are kept`);
  const replaced = replacedValues(lines);
  if (replaced.length === 0) return;
  const missing = replaced.filter(({ old }) => git("cat-file", "-e", old).status !== 0);
  if (missing.length > 0)
    fail(
      missing
        .map(({ ref, old }) => `${ref} is ${old} there, which this clone lacks: fetch it`)
        .join("; "),
    );
  // (each old value once: refs that shared it share its archive)
  const olds = [...new Set(replaced.map(({ old }) => old))];
  const refs = olds.map((old) => `${ARCHIVE}${old}`);
  const listed = git("ls-remote", url, ...refs);
  if (listed.status !== 0) fail(`cannot list the remote's archives (${last(listed)})`);
  // (`ls-remote` matches its patterns at the end of a ref's name: keep only the exact refs)
  const there = new Map(
    listed.stdout
      .split("\n")
      .map((line) => line.split("\t").reverse())
      .filter(([ref]) => refs.includes(ref)),
  );
  const here = new Map(
    refs.map((ref) => [ref, git("rev-parse", "--verify", "--quiet", ref).stdout.trim()]),
  );
  const holds = (ref) => ref.slice(ARCHIVE.length);
  // (a value the remote's or this clone's archive ref holds other than its own name)
  const found = (ref) =>
    [there.get(ref), here.get(ref)].find((value) => value && value !== holds(ref));
  const wrong = refs.filter(found);
  if (wrong.length > 0) fail(wrong.map((ref) => `${ref} holds ${found(ref)}`).join("; "));
  const toPush = refs.filter((ref) => !there.has(ref));
  if (toPush.length > 0) {
    const pushed = git(
      "push",
      "--no-verify",
      "--quiet",
      ...toPush.map((ref) => `--force-with-lease=${ref}:`),
      url,
      ...toPush.map((ref) => `${holds(ref)}:${ref}`),
    );
    if (pushed.status !== 0) fail(`cannot archive the replaced values (${last(pushed)})`);
  }
  // (the clone's own archive refs, so that a pruning push from it does not delete them on the remote)
  for (const ref of refs.filter((ref) => here.get(ref) === "")) {
    const kept = git("update-ref", ref, holds(ref), "");
    if (kept.status !== 0) fail(`cannot keep ${ref} in this clone (${kept.stderr.trim()})`);
  }
  for (const { ref, old } of replaced)
    process.stderr.write(
      `archive-replaced-heads: ${ref} was ${old}: archived as ${ARCHIVE}${old}\n`,
    );
}

if (import.meta.main) main();
