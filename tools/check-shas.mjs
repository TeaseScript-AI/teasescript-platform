import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Checks that the commit SHAs a report or pull-request body names exist, before it is sent:
//
//   node tools/check-shas.mjs [--repo <path>]... [<file>]     (the text from <file>, else from standard input)
//
// A SHA-shaped token is 7 to 40 lowercase hex characters, bounded by no letter, digit or `_`. Each is resolved with
// `git rev-parse --verify --quiet <token>^{commit}` in each `--repo` (default: the current repository) and reported as
// resolved (in which repository, to which full SHA), ambiguous (a short token several commits share), or unresolved.
// An unresolved token may be a commit not fetched yet: the message says to fetch it; this tool never fetches.
// Unfilled placeholders (`PLACEHOLDERS`) outside fenced code blocks are reported too. Every run that completes ends
// with one line counting the tokens by result and the placeholders, so no output means it did not run.
//
// Tokens that need not be commits are checked, and skipped when no repository resolves them, so no rule hides a SHA:
// - only digits: a CI run, comment or issue id;
// - 14 characters whose first 10 are digits: a queue job id (`sx-job`: the month to the second, then 4 hex), such as
//   `1107175450d1b5`;
// - only the letters a-f: a word, such as `defaced`;
// - shorter than 40 and inside a URL or a path, except after `/commit/`, `/commits/`, `/tree/` or `/blob/`: a file's
//   or a job's name. A full 40-character SHA in a path, such as an evidence folder, must resolve.
//
// Exit status: 0 when every token that must be a commit resolved and no placeholder is left, 1 otherwise, 2 when it
// cannot run (bad arguments, an unreadable file, or a `--repo` that is no git repository).

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

/** `token` in `repository`: `{ sha }` when one commit has it, `{ ambiguous: n }` when several do, else `null`. */
function resolve(token, repository) {
  const verified = spawnSync(
    "git",
    ["-C", repository, "rev-parse", "--verify", "--quiet", `${token}^{commit}`],
    { encoding: "utf8" },
  );
  if (verified.status === 0) return { sha: verified.stdout.trim() };
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

function cannotRun(message) {
  process.stderr.write(`check-shas: ${message}\n`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const repositories = [];
  const files = [];
  for (let index = 0; index < argv.length; index += 1)
    if (argv[index] === "--repo") {
      if (index + 1 >= argv.length) cannotRun("--repo needs a path");
      repositories.push(argv[(index += 1)]);
    } else if (argv[index].startsWith("-")) cannotRun(`unknown option ${argv[index]}`);
    else files.push(argv[index]);
  if (files.length > 1) cannotRun("usage: node tools/check-shas.mjs [--repo <path>]... [<file>]");
  if (repositories.length === 0) repositories.push(".");
  for (const repository of repositories)
    if (
      spawnSync("git", ["-C", repository, "rev-parse", "--git-dir"], { stdio: "ignore" }).status !==
      0
    )
      cannotRun(`${repository} is no git repository`);
  if (files.length === 1 && !existsSync(files[0])) cannotRun(`no file ${files[0]}`);
  const text = readFileSync(files.length === 1 ? files[0] : 0, "utf8");

  let failed = false;
  const counts = { resolved: 0, ambiguous: 0, unresolved: 0, skipped: 0 };
  for (const [token, why] of tokensOf(text)) {
    const answers = repositories.map((repository) => ({
      repository,
      answer: resolve(token, repository),
    }));
    const resolved = answers.find(({ answer }) => answer?.sha);
    const ambiguous = answers.find(({ answer }) => answer?.ambiguous);
    counts[
      resolved ? "resolved" : ambiguous ? "ambiguous" : why !== null ? "skipped" : "unresolved"
    ] += 1;
    if (resolved)
      process.stdout.write(
        `resolved    ${token}  ${resolved.answer.sha} in ${resolved.repository}\n`,
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
  process.stdout.write(
    `check-shas: ${tokens} tokens: ${counts.resolved} resolved, ${counts.ambiguous} ambiguous, ` +
      `${counts.unresolved} unresolved, ${counts.skipped} skipped (ids, words, paths); ` +
      `${placeholders.length} placeholders\n`,
  );
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) main();
