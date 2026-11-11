import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";

// Checks that the commit SHAs a report or pull-request body names exist and are on a remote, before it is sent:
//
//   node tools/check-shas.mjs [--repo <path>]... [--append] [<file>]   (the text from <file>, else from standard input)
//   (with --append, no other process writes <file> while it runs)
//
// `--append` writes the run's last line into <file> as its last line, after a blank line, replacing such a line of its
// own already there (which is left out of the check), so that the report sent is that file and its line is never
// copied by hand. Only a whole last line in the tool's own form is its own; a quoted or partial one is text. The file is
// held through one descriptor from before its read until after its write, and written in place, through a link: read
// again and cut after its text only if its name still names it and it is still as it was read, then the line written
// there. A file that cannot be opened for reading and writing or is no regular file, and a failure to read or cut leave
// it as it was; one while writing or closing leaves its text and maybe part of the line, which the message says to
// remove; all exit 2. Bound: the report is not written by another process while `--append` runs; a change it detects is
// refused (exit 2, the file as the other writer left it): content between its reads, a replaced file; nothing else is
// promised.
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
// Unfilled placeholders (`PLACEHOLDERS`) outside fenced code blocks are reported too, and so is a closing clause that
// names several issues after one keyword, in code too, which as closing syntax closes only the first
// (`closingClausesOf`). Paths into the disposable scratch area `/tmp/agent-work/`, whose files are deleted after
// inactivity, are named and counted, not failed: a report may mention one rightly (a command it ran, a reviewer's
// folder), and a reader who needs the file needs a retained copy (`scratchPathsOf` says which spellings it reads).
// Every run that completes ends with one line counting the tokens by result, the placeholders, those clauses and those
// paths, so no output means it did not run.
//
// Tokens that need not be commits are checked, and skipped when no repository resolves them, so no rule hides a SHA:
// - only digits: a CI run, comment or issue id;
// - 14 characters whose first 10 are digits: a queue job id (`sx-job`: the month to the second, then 4 hex), such as
//   `1107175450d1b5`;
// - only the letters a-f: a word, such as `defaced`;
// - a group of a UUID, five groups of 8, 4, 4, 4 and 12 hexadecimal digits in either case joined by `-` and touched by
//   no letter, digit or `_`: an id, such as a T3 thread's `0e63ae8e-efaf-446b-abad-52bba33d4f81`;
// - a number's fractional digits followed by `e` and its exponent, the number standing alone: no word character of
//   any script (a letter, mark, number or connector) touches it on either side, and no `.` precedes it, so `v1.`, `β1.`
//   and a dotted version stay checked, while any quote, backtick, bracket, operator or white space admits it
//   (`floatDigits`): a float's digits, such as `1.7976931348623157e+308` or `6.02214076e23`. A token of that shape
//   after any punctuation is therefore skipped when unresolved, which is acceptable as the rule reaches only a token no
//   repository resolves, of digits, one `e` and an exponent, directly after `<digits>.`;
// - right after the word `sha256` (with a space, `:` or `=` between): a file's hash, such as `sha256 4322b2e0e668`;
// - shorter than 40 and inside a URL or a path, except after `/commit/`, `/commits/`, `/tree/` or `/blob/`: a file's
//   or a job's name. A full 40-character SHA in a path, such as an evidence folder, must resolve.
//
// Exit status: 0 when every token that must be a commit resolved on a remote and no placeholder or several-issue
// closing clause is left (scratch paths do not change it), 1 otherwise, 2 when it cannot run (bad arguments, an
// unreadable file, a `--repo` that is no git repository, or a failed `--append` write).

/** A whole last line in this tool's own form, as `--append` writes it. */
const OWN_LINE =
  /^check-shas: \d+ tokens: \d+ resolved, \d+ trees, \d+ ambiguous, \d+ unresolved, \d+ local only, \d+ skipped \(ids, words, paths, sha256s\); \d+ placeholders, \d+ multi-issue closing clauses, \d+ scratch paths$/u;

/** `text` without a last line of this tool's own and the white space around it, read from the end once. */
function withoutOwnLine(text) {
  const trimmed = text.trimEnd();
  const start = trimmed.lastIndexOf("\n") + 1;
  return OWN_LINE.test(trimmed.slice(start)) ? trimmed.slice(0, start).trimEnd() : text;
}

/** All of `descriptor`'s bytes, read from its start. */
function readAll(descriptor) {
  const chunks = [];
  for (let position = 0; ;) {
    const chunk = Buffer.alloc(65_536);
    const length = readSync(descriptor, chunk, 0, chunk.length, position);
    if (length === 0) return Buffer.concat(chunks);
    chunks.push(chunk.subarray(0, length));
    position += length;
  }
}

/**
 * `file` opened for `--append`, for reading and writing, and its bytes read through that descriptor. A file that cannot
 * be opened or read so, or that is no regular file once opened (a link to one is followed), exits 2 before anything is
 * written; the descriptor then closes with the process.
 */
function openForAppend(file) {
  try {
    const descriptor = openSync(file, "r+");
    if (!fstatSync(descriptor).isFile())
      cannotRun(`cannot write ${file}: it is no regular file; it is as it was`);
    return { descriptor, bytes: readAll(descriptor) };
  } catch (error) {
    cannotRun(`cannot write ${file} (${error.code ?? error.message}); it is as it was`);
  }
}

/**
 * Writes `line` as `file`'s last line, in place, through `descriptor`, which read `bytes`: the file is read again, and
 * only if `file` still names it and it is still `bytes` cut where `kept`, its text before trailing white space and an own last line, ends, and
 * the blank line and `line` are written there. A file another writer changed meanwhile is left as that writer left it;
 * a failure to read or cut leaves it as it was; a later failure, closing included, leaves its text, maybe with all or
 * part of the line. Each exits 2, naming the first failure and what it left.
 */
function appendLine(file, descriptor, bytes, kept, line) {
  const end = Buffer.byteLength(kept);
  // (the text was read as UTF-8: cut only where its bytes are the same, so no character is split)
  if (!bytes.subarray(0, end).equals(Buffer.from(kept)))
    cannotRun(`cannot write ${file}: it is not UTF-8 text; it is as it was`);
  const tail = Buffer.from(`\n\n${line}\n`);
  let changed = false;
  let cut = false;
  let failure;
  try {
    // (another writer's change since the first read is left as it is, not cut: one written into this file, or a new
    // file renamed onto its name, which leaves the descriptor on the old one)
    const now = readAll(descriptor);
    // (as BigInts: two inodes can differ beyond a JavaScript number's precision, as OverlayFS's high bits do)
    const named = statSync(file, { throwIfNoEntry: false, bigint: true });
    const held = fstatSync(descriptor, { bigint: true });
    changed = !now.equals(bytes) || named?.dev !== held.dev || named?.ino !== held.ino;
    if (!changed) {
      ftruncateSync(descriptor, end);
      cut = true;
      for (let written = 0; written < tail.length;)
        written += writeSync(descriptor, tail, written, tail.length - written, end + written);
    }
  } catch (error) {
    failure = error;
  }
  // (closed once, even when it fails: a descriptor whose close reported an error is not closed again)
  try {
    closeSync(descriptor);
  } catch (error) {
    failure ??= error;
  }
  if (changed)
    cannotRun(`cannot write ${file}: it changed while it was checked, and is left so: run again`);
  if (failure === undefined) return;
  const cause = failure.code ?? failure.message;
  if (!cut) cannotRun(`cannot write ${file} (${cause}); it is as it was`);
  cannotRun(
    `cannot write ${file}'s last line (${cause}); its text is as it was, and all or part of the line may stand ` +
      "after it: remove a partial line by hand",
  );
}

/** A UUID, touched by no letter, digit or `_`. */
const UUID =
  /(?<![\p{L}\p{N}_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\p{N}_])/giu;

/** The unfilled placeholders a report can carry, case-insensitive. */
export const PLACEHOLDERS = [
  /<(?:full[ -])?(?:sha|commit|head|base)(?:[ -][a-z]+)?>/giu,
  /\bX{7,40}\b/giu,
];

const TOKEN = /(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])/gu;

/** A word character of any script: a letter, mark, number or connector (the Unicode categories L, M, N and Pc). */
const WORD = /^[\p{L}\p{M}\p{N}\p{Pc}]/u;

/** The code point that ends right before `at` in `text`, as a string, or `""` at the start. */
function charBefore(text, at) {
  if (at <= 0) return "";
  return at >= 2 && /[\udc00-\udfff]/u.test(text[at - 1]) && /[\ud800-\udbff]/u.test(text[at - 2])
    ? text.slice(at - 2, at)
    : text[at - 1];
}

/**
 * Whether the token at `index`, of `length` characters, is a float's digits standing alone: digits ending in `e` and
 * the exponent's digits (in the token, or after it behind a sign), right after an integer part (ASCII digits, an
 * optional sign) and a `.`, with no word character (`WORD`) touching the number on either side and no `.` before it.
 */
function floatDigits(text, index, length) {
  const token = text.slice(index, index + length);
  let end = index + length;
  if (/^\d+e$/u.test(token)) {
    const exponent = /^[+-]\d+/u.exec(text.slice(end, end + 32));
    if (exponent === null) return false;
    end += exponent[0].length;
    while (/\d/u.test(text[end] ?? "")) end += 1;
  } else if (!/^\d+e\d+$/u.test(token)) return false;
  let at = index - 1;
  if (text[at] !== ".") return false;
  const point = at;
  while (at > 0 && /\d/u.test(text[at - 1])) at -= 1;
  if (at === point) return false;
  if (/[+-]/u.test(text[at - 1] ?? "")) at -= 1;
  const left = charBefore(text, at);
  const right = String.fromCodePoint(text.codePointAt(end) ?? 32);
  return left !== "." && !WORD.test(left) && !WORD.test(right);
}

/** Why a token need not be a commit, or `null` when it must resolve. */
export function excuse(token, text, index) {
  if (/^\d+$/u.test(token)) return "only digits, an id";
  if (/^\d{10}[0-9a-f]{4}$/u.test(token)) return "a queue job id";
  if (/^[a-f]+$/u.test(token)) return "a word";
  // (a UUID that holds the token starts at most 24 before it, at its last group, and ends at most 36 after it, at its
  // first; the window also keeps the character on each side, two UTF-16 units for an astral one, for the boundaries)
  const from = Math.max(0, index - 26);
  for (const uuid of text.slice(from, index + 38).matchAll(UUID)) {
    const start = from + uuid.index;
    if (start <= index && index + token.length <= start + uuid[0].length) return "a UUID, an id";
  }
  if (floatDigits(text, index, token.length)) return "a float's digits";
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
 * The paths of `text` that name something inside a folder `agent-work`, as the scratch area `/tmp/agent-work/` is
 * named, wherever they stand, code included, each once with the line it first stands on. A path is a run of
 * characters other than white space, quotes, backticks, brackets and `|` (a compact table's cell separator), without
 * the sentence punctuation that ends it; it names the area's content when a slash-separated component is exactly
 * `agent-work` and is followed by one other than `.` or `..`. The area itself (`/tmp/agent-work/.`) or a folder named
 * by a placeholder (`/tmp/agent-work/<task>/`) is no such path. This is a count, not a guarantee: a path written
 * otherwise is not seen, such as one broken by white space, a JSON value with escaped slashes, a relative path assigned
 * to a shell variable (`NAME=agent-work/…`), or one reaching the area through another name (`$SCRATCH/report.out`).
 */
export function scratchPathsOf(text) {
  const found = new Map();
  let line = 1;
  let at = 0;
  for (const { 0: run, index } of text.matchAll(/[^\s`'"()[\]<>|]+/gu)) {
    if (!run.includes("agent-work")) continue;
    for (; at < index; at += 1) if (text[at] === "\n") line += 1;
    // (from the end, so that punctuation inside the path is read once)
    let end = run.length;
    while (end > 0 && ".,;:!?".includes(run[end - 1])) end -= 1;
    const path = run.slice(0, end);
    const parts = path.split("/");
    const inside = (from) => {
      while (parts[from] === "" || parts[from] === ".") from += 1;
      return from < parts.length && parts[from] !== "..";
    };
    if (!found.has(path) && parts.some((part, from) => part === "agent-work" && inside(from + 1)))
      found.set(path, line);
  }
  return [...found].map(([path, first]) => ({ path, line: first }));
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
 * The closing clauses of `text` that name several issues after one keyword, such as `Closes #1970, #1965`, each with
 * its first reference: used as GitHub's closing syntax, it closes only that one, as GitHub closes only an issue its own
 * keyword names. The separators are matched without overlapping white space, so the work stays linear. Every closing
 * keyword followed by more than one issue reference is found, wherever it stands in the text, code included; a quoted
 * example must be written so that it is not such a clause. A keyword is `close`, `closes`, `closed`, `fix`, `fixes`,
 * `fixed`, `resolve`, `resolves` or `resolved` in any case, with an optional `:`; a reference is `#N`, `owner/repo#N`
 * or `https://github.com/owner/repo/issues/N`, its number not running on into a word character; references are joined
 * by `,`, `and`, `, and` or `&`. A form GitHub closes on that these patterns do not match, such as a reference inside
 * emphasis or a link, is the way left to fail open. The text cannot tell an issue from a pull request, nor what the
 * author means to close: a second reference to a companion pull request or into the first issue's comments fails
 * too, and the refusal names the ways out.
 */
export function closingClausesOf(text) {
  // (a reference ends where its number ends: digits that run on into a word character, as a colour's, are none)
  const number = String.raw`\d+(?![\p{L}\p{M}\p{N}\p{Pc}])`;
  const issue = String.raw`(?:https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/${number}|(?:[\w.-]+\/[\w.-]+)?#${number})`;
  const clause = new RegExp(
    String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(${issue})(?:\s*(?:,\s*(?:and\b|&)|,|\band\b|&)\s*${issue})+`,
    "giu",
  );
  // (each clause's line, counted on from the one before, so the text is read once)
  let line = 1;
  let at = 0;
  return [...text.matchAll(clause)].map((m) => {
    for (; at < m.index; at += 1) if (text[at] === "\n") line += 1;
    return { clause: m[0], closes: m[1], line };
  });
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
    cannotRun(
      "usage: node tools/check-shas.mjs [--repo <path>]... [--append] [<file>] (with --append, no other process writes <file> while it runs)",
    );
  if (repositories.length === 0) repositories.push(".");
  for (const repository of repositories)
    if (
      spawnSync("git", ["-C", repository, "rev-parse", "--git-dir"], { stdio: "ignore" }).status !==
      0
    )
      cannotRun(`${repository} is no git repository`);
  if (files.length === 1 && !existsSync(files[0])) cannotRun(`no file ${files[0]}`);
  const held = append ? openForAppend(files[0]) : null;
  let bytes = held?.bytes;
  if (!held)
    try {
      bytes = readFileSync(files.length === 1 ? files[0] : 0);
    } catch (error) {
      cannotRun(`cannot read ${files[0] ?? "standard input"} (${error.code ?? error.message})`);
    }
  const read = bytes.toString("utf8");
  // (with `--append`, a last line of this tool's own, written by an earlier run, is no part of the text)
  const text = append ? withoutOwnLine(read) : read;

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
  const scratch = scratchPathsOf(text);
  for (const { path, line } of scratch)
    process.stdout.write(
      `scratch     line ${line}: ${path}  under /tmp/agent-work, deleted after inactivity: if a reader needs the file, move it to retained evidence and cite that copy\n`,
    );
  const placeholders = placeholdersOf(text);
  for (const placeholder of placeholders) {
    failed = true;
    process.stdout.write(`placeholder ${placeholder}  unfilled\n`);
  }
  const clauses = closingClausesOf(text);
  for (const { clause, closes, line } of clauses) {
    failed = true;
    process.stdout.write(
      `closing     line ${line}: "${clause}" names several issues after one keyword; as closing syntax it closes only ${closes}. ` +
        `Give each issue meant to close its own keyword (Closes #1, Closes #2); otherwise end the clause after the first ` +
        `reference (a new sentence for the rest), or split a quoted example so that no keyword stands before the list\n`,
    );
  }
  const tokens = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const line =
    `check-shas: ${tokens} tokens: ${counts.resolved} resolved, ${counts.trees} trees, ${counts.ambiguous} ambiguous, ` +
    `${counts.unresolved} unresolved, ${counts.local} local only, ${counts.skipped} skipped (ids, words, paths, sha256s); ` +
    `${placeholders.length} placeholders, ${clauses.length} multi-issue closing clauses, ${scratch.length} scratch paths`;
  if (append) appendLine(files[0], held.descriptor, bytes, text.trimEnd(), line);
  process.stdout.write(`${line}\n`);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) main();
