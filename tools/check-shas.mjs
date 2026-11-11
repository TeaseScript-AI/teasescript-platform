import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Checks that the commit SHAs a report or pull-request body names exist and are on a remote, before it is sent:
//
//   node tools/check-shas.mjs [--repo <path>]... [--append] [<file>]   (the text from <file>, else from standard input)
//
// `--append` writes the run's last line into <file> as its last line, after a blank line, replacing such a line of its
// own already there (which is left out of the check), so that the report sent is that file and its line is never
// copied by hand.
//
// A SHA-shaped token is 7 to 40 lowercase hex characters, bounded by no letter, digit or `_`. Each is resolved with
// `git rev-parse --verify --quiet <token>^{commit}` in each `--repo` (default: the current repository) and reported as
// resolved (in which repository, to which full SHA), ambiguous (a short token several commits share), or unresolved.
// A resolved commit must also be on a remote, as a reader outside this clone needs it: a remote-tracking ref of a
// repository that resolves it must contain it (`git for-each-ref --contains` over `refs/remotes`), or a ref on its
// `origin` that the default fetch does not mirror must: an archived head (`refs/archive/*`) or a pull request's head
// (`refs/pull/<n>/head`, which keeps a squash-merged branch's commits). Those come from one `git ls-remote origin` per
// repository, asked only for a commit on no remote-tracking ref; a tip commit this clone has counts with its history,
// and the commit is reported as on origin at that ref. Else it is local only, such as a head from before a rebase. A
// repository without remote-tracking refs is named once, and its tokens are not checked for that. An unresolved token
// may be a commit not fetched yet: the message says to fetch it; this tool never fetches. A token that is no commit
// but a tree, such as a stored baseline's `src` tree hash, is reported as a tree, resolved, without the remote check:
// proving a tree reachable from a remote ref is costly.
// Unfilled placeholders (`PLACEHOLDERS`) outside fenced code blocks are reported too. Every run that completes ends
// with one line counting the tokens by result and the placeholders, so no output means it did not run.
//
// Tokens that need not be commits are checked, and skipped when no repository resolves them, so no rule hides a SHA:
// - only digits: a CI run, comment or issue id;
// - 14 characters whose first 10 are digits: a queue job id (`sx-job`: the month to the second, then 4 hex), such as
//   `1107175450d1b5`;
// - only the letters a-f: a word, such as `defaced`;
// - right after the word `sha256` (with a space, `:` or `=` between): a file's hash, such as `sha256 4322b2e0e668`;
// - shorter than 40 and inside a URL or a path, except after `/commit/`, `/commits/`, `/tree/` or `/blob/`: a file's
//   or a job's name. A full 40-character SHA in a path, such as an evidence folder, must resolve.
//
// Exit status: 0 when every token that must be a commit resolved on a remote and no placeholder is left, 1 otherwise,
// 2 when it
// cannot run (bad arguments, an unreadable file, or a `--repo` that is no git repository).

/** A last line this tool wrote with `--append`, with the blank lines and white space before it. */
const OWN_LINE = /\s*\n?check-shas: \d+ tokens: [^\n]*\s*$/u;

/** The unfilled placeholders a report can carry, case-insensitive. */
export const PLACEHOLDERS = [
  /<(?:full[ -])?(?:sha|commit|head|base)(?:[ -][a-z]+)?>/giu,
  /\bX{7,40}\b/giu,
];

const TOKEN = /(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])/gu;

/** Why a token need not be a commit, or `null` when it must resolve. */
export function excuse(token, text, index) {
  if (/^\d+$/u.test(token)) return "only digits, an id";
  if (/^\d{10}[0-9a-f]{4}$/u.test(token)) return "a queue job id";
  if (/^[a-f]+$/u.test(token)) return "a word";
  if (/\bsha256[\s:=]+$/iu.test(text.slice(Math.max(0, index - 16), index)))
    return "a file's sha256";
  // The run of non-space characters the token is in: a URL or a path, unless it names the commit itself.
  const start = text.slice(0, index).search(/\S*$/u);
  const before = text.slice(start, index);
  if (token.length === 40 || /(?:^|\/)(?:commit|commits|tree|blob)\/$/u.test(before)) return null;
  if (/:\/\//u.test(before) || /^[`("']?(?:~|\.{1,2})?\//u.test(before) || before.includes("/"))
    return "inside a URL or a path";
  return null;
}

/** Each distinct SHA-shaped token of `text`, with why it need not be a commit, or `null`. */
export function tokensOf(text) {
  const found = new Map();
  for (const match of text.matchAll(TOKEN)) {
    const why = excuse(match[0], text, match.index);
    // (a token that must be a commit anywhere must be one)
    if (!found.has(match[0]) || why === null) found.set(match[0], why);
  }
  return found;
}

/**
 * The unfilled placeholders of `text`, outside fenced code blocks: a fenced block shows a command's form, such as
 * `git worktree add <dir> <base commit>`, while a report's own values stand inline.
 */
export function placeholdersOf(text) {
  const prose = text.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gmu, "");
  return [
    ...new Set(PLACEHOLDERS.flatMap((pattern) => [...prose.matchAll(pattern)].map((m) => m[0]))),
  ];
}

/**
 * `token` in `repository`: `{ sha }` when one commit has it, `{ tree }` when it is no commit but a tree, `{ ambiguous:
 * n }` when several commits share it, else `null`.
 */
function resolve(token, repository) {
  const verified = spawnSync(
    "git",
    ["-C", repository, "rev-parse", "--verify", "--quiet", `${token}^{commit}`],
    { encoding: "utf8" },
  );
  if (verified.status === 0) return { sha: verified.stdout.trim() };
  // (no commit: a tree, such as a stored baseline's `src` tree, is a citation too; a commit would have peeled above)
  if (
    spawnSync("git", ["-C", repository, "cat-file", "-t", token], {
      encoding: "utf8",
    }).stdout.trim() === "tree"
  )
    return {
      tree: spawnSync(
        "git",
        ["-C", repository, "rev-parse", "--verify", "--quiet", `${token}^{tree}`],
        { encoding: "utf8" },
      ).stdout.trim(),
    };
  const candidates = spawnSync("git", ["-C", repository, "rev-parse", `--disambiguate=${token}`], {
    encoding: "utf8",
  }).stdout.trim();
  const commits =
    candidates === ""
      ? []
      : candidates
          .split("\n")
          .filter(
            (sha) =>
              spawnSync("git", ["-C", repository, "cat-file", "-t", sha], {
                encoding: "utf8",
              }).stdout.trim() === "commit",
          );
  return commits.length > 1 ? { ambiguous: commits.length } : null;
}

/**
 * The commits that a ref on `repository`'s `origin` under `refs/archive/*` or `refs/pull/<n>/head` contains, each
 * with that ref, from one `git ls-remote origin`; `{ error }` when that fails. Only the history of a tip this clone
 * has is walked, as the tool never fetches; a commit a remote-tracking ref has is left out, as it is never local only.
 */
function unmirroredOriginRefs(repository) {
  // (why a run failed: its error, such as a timeout or a full buffer, else its last line of standard error)
  const why = (result, command) =>
    result.error?.message ||
    result.stderr?.trim().split("\n").at(-1) ||
    `${command} exit ${result.status}`;
  const listed = spawnSync("git", ["-C", repository, "ls-remote", "origin"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 1 << 28,
    timeout: 60_000,
  });
  if (listed.status !== 0) return { error: why(listed, "git ls-remote") };
  const refOf = new Map();
  for (const line of listed.stdout.split("\n")) {
    // (an annotated tag's ref is listed twice: as the tag, and peeled to its commit with `^{}`, which is no ref name)
    const [tip, listedRef] = line.split("\t");
    const ref = listedRef?.replace(/\^\{\}$/u, "");
    if (/^refs\/(?:archive\/.+|pull\/\d+\/head)$/u.test(ref ?? "") && !refOf.has(tip))
      refOf.set(tip, ref);
  }
  const checked = spawnSync(
    "git",
    ["-C", repository, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
    { input: [...refOf.keys(), ""].join("\n"), encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (checked.status !== 0) return { error: why(checked, "git cat-file") };
  const tips = checked.stdout
    .split("\n")
    .filter((line) => line.endsWith(" commit"))
    .map((line) => line.split(" ")[0]);
  const contains = new Map();
  // (no tips: `git log --stdin` would walk `HEAD` instead)
  if (tips.length === 0) return { contains };
  const walked = spawnSync(
    "git",
    ["-C", repository, "log", "--source", "--format=%H %S", "--stdin", "--not", "--remotes"],
    { input: [...tips, ""].join("\n"), encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (walked.status !== 0) return { error: why(walked, "git log") };
  for (const line of walked.stdout.split("\n")) {
    const [commit, tip] = line.split(" ");
    if (refOf.has(tip)) contains.set(commit, refOf.get(tip));
  }
  return { contains };
}

function cannotRun(message) {
  process.stderr.write(`check-shas: ${message}\n`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const repositories = [];
  const files = [];
  let append = false;
  for (let index = 0; index < argv.length; index += 1)
    if (argv[index] === "--append") append = true;
    else if (argv[index] === "--repo") {
      if (index + 1 >= argv.length) cannotRun("--repo needs a path");
      repositories.push(argv[(index += 1)]);
    } else if (argv[index].startsWith("-")) cannotRun(`unknown option ${argv[index]}`);
    else files.push(argv[index]);
  if (files.length > 1 || (append && files.length === 0))
    cannotRun("usage: node tools/check-shas.mjs [--repo <path>]... [--append] [<file>]");
  if (repositories.length === 0) repositories.push(".");
  for (const repository of repositories)
    if (
      spawnSync("git", ["-C", repository, "rev-parse", "--git-dir"], { stdio: "ignore" }).status !==
      0
    )
      cannotRun(`${repository} is no git repository`);
  if (files.length === 1 && !existsSync(files[0])) cannotRun(`no file ${files[0]}`);
  const read = readFileSync(files.length === 1 ? files[0] : 0, "utf8");
  // (with `--append`, a last line of this tool's own, written by an earlier run, is no part of the text)
  const text = append ? read.replace(OWN_LINE, "") : read;

  let failed = false;
  const counts = { resolved: 0, trees: 0, ambiguous: 0, unresolved: 0, local: 0, skipped: 0 };
  // Whether each repository has remote-tracking refs, named once when it has none.
  const remoteRefs = new Map();
  const hasRemoteRefs = (repository) => {
    if (!remoteRefs.has(repository)) {
      const refs = spawnSync(
        "git",
        ["-C", repository, "for-each-ref", "--count=1", "refs/remotes"],
        { encoding: "utf8" },
      ).stdout.trim();
      remoteRefs.set(repository, refs !== "");
      if (refs === "")
        process.stdout.write(
          `check-shas: no remote refs in ${repository}: reachability not checked\n`,
        );
    }
    return remoteRefs.get(repository);
  };
  // Whether a remote-tracking ref of `repository` contains `sha`, or `null` when it has none to ask.
  const onRemote = (sha, repository) =>
    hasRemoteRefs(repository)
      ? spawnSync(
          "git",
          ["-C", repository, "for-each-ref", "--count=1", "--contains", sha, "refs/remotes"],
          { encoding: "utf8" },
        ).stdout.trim() !== ""
      : null;
  // The ref on origin that contains `sha` though no remote-tracking ref does, or `undefined`; asked once per
  // repository, and a failure is named once.
  const originRefs = new Map();
  const onOriginAt = (sha, repository) => {
    if (!originRefs.has(repository)) {
      const refs = unmirroredOriginRefs(repository);
      originRefs.set(repository, refs.contains ?? new Map());
      if (refs.error)
        process.stdout.write(
          `check-shas: cannot list origin's refs in ${repository} (${refs.error}): archived and pull-request heads not checked\n`,
        );
    }
    return originRefs.get(repository).get(sha);
  };
  for (const [token, why] of tokensOf(text)) {
    const answers = repositories.map((repository) => ({
      repository,
      answer: resolve(token, repository),
    }));
    // A repository that has it on a remote, or cannot tell, before one that has it only locally.
    const found = answers
      .filter(({ answer }) => answer?.sha)
      .map((entry) => ({ ...entry, remote: onRemote(entry.answer.sha, entry.repository) }));
    const resolved =
      found.find(({ remote }) => remote !== false) ??
      found
        .map((entry) => ({ ...entry, at: onOriginAt(entry.answer.sha, entry.repository) }))
        .find(({ at }) => at !== undefined);
    const local = resolved ? undefined : found[0];
    const tree = resolved || local ? undefined : answers.find(({ answer }) => answer?.tree);
    const ambiguous = answers.find(({ answer }) => answer?.ambiguous);
    counts[
      resolved
        ? "resolved"
        : tree
          ? "trees"
          : local
            ? "local"
            : ambiguous
              ? "ambiguous"
              : why !== null
                ? "skipped"
                : "unresolved"
    ] += 1;
    if (local) {
      failed = true;
      process.stdout.write(
        `local only  ${token}  ${local.answer.sha} in ${local.repository}, on no remote ref: push it, or cite one on origin; ` +
          "for exact pre-rebase heads, push one archive ref whose parents are the cited heads\n",
      );
    } else if (tree)
      process.stdout.write(
        `tree        ${token}  ${tree.answer.tree} in ${tree.repository}: a tree, not checked on a remote\n`,
      );
    else if (resolved)
      process.stdout.write(
        `resolved    ${token}  ${resolved.answer.sha} in ${resolved.repository}` +
          `${resolved.at ? `, on origin at ${resolved.at}` : ""}\n`,
      );
    else if (ambiguous) {
      failed = true;
      process.stdout.write(
        `ambiguous   ${token}  ${ambiguous.answer.ambiguous} commits in ${ambiguous.repository} start with it: give more characters\n`,
      );
    } else if (why === null) {
      failed = true;
      process.stdout.write(
        `unresolved  ${token}  no commit in ${repositories.join(", ")}: fetch it (git fetch origin <branch>), or correct it\n`,
      );
    }
  }
  const placeholders = placeholdersOf(text);
  for (const placeholder of placeholders) {
    failed = true;
    process.stdout.write(`placeholder ${placeholder}  unfilled\n`);
  }
  const tokens = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const line =
    `check-shas: ${tokens} tokens: ${counts.resolved} resolved, ${counts.trees} trees, ${counts.ambiguous} ambiguous, ` +
    `${counts.unresolved} unresolved, ${counts.local} local only, ${counts.skipped} skipped (ids, words, paths, sha256s); ` +
    `${placeholders.length} placeholders`;
  if (append) writeFileSync(files[0], `${text.replace(/\s*$/u, "")}\n\n${line}\n`);
  process.stdout.write(`${line}\n`);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) main();
