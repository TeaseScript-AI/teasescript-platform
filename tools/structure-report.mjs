#!/usr/bin/env node
// Read-only report of code structure for the coordinator's check (docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md,
// "Code structure"). Signals, not limits: each line it prints asks for a seam or a reason.
//
//   node tools/structure-report.mjs [ROOT…] [--top N] [--json FILE] [--compare FILE]
//   node tools/structure-report.mjs [ROOT…] --diff BASE [--moved] [--json FILE] [--summary FILE]
//
// ROOT selects what is read, by default the five components: src, player, tests, tools and playground. A component's
// top level is the code files directly in it; no other folder counts as a top level, whichever ROOT selects it. Only
// files Git tracks are read. Lines are Git's, for files and functions alike: a newline (LF) alone ends one, and a final
// newline ends the last line.
// Functions are measured in TypeScript and JavaScript files; the script blocks of .vue files are not parsed.
//
// Without --diff: the whole tree's signals, the top N of each (files over 1000 lines, folders over 20 files, top levels
// over 12, functions over 150 lines, names a letter apart). --json writes them all; --compare counts each against an
// earlier --json.
//
// With --diff BASE: only the signals the change from the merge base (`git merge-base BASE HEAD`) to `HEAD` adds to,
// each against the merge base's tree: a file over 1000 lines that it adds lines to, a function over 150 lines whose
// lines include one it adds, a folder over 20 files or a top level over 12 that it adds a file to (one Git lists as
// added: a symlink or submodule turned into a regular file is not), a pair of names a letter apart that the merge base did not have, and a file gaining over 300 lines. A change adds to a signal whether
// it crosses the line or the base was already over it. Both sides are Git's committed trees, never the working tree:
// commit first. Only the changed files are parsed. --json writes those lines too, for a READY to quote.
//
// What the change is, is Git's. Its files, their modes and status, and their names at the merge base come from `git
// diff -z -M --raw` over the whole tree, so a file moved in from outside the roots is a move; only regular files (modes
// 100644 and 100755) are measured, so a symlink and a submodule are not; a name that is not UTF-8 stops the report
// (exit 2). The lines it adds, by file and position, are the `+` lines of each file's own `git diff -M -U0
// --inter-hunk-context=0`, each hunk's body read inside its header's counts, with `GIT_DIFF_OPTS` removed from Git's
// environment; their count per file is `git diff -M -U0 --inter-hunk-context=0 --numstat`'s, which the tool checks. The
// two run with the same context because Git enables a common-tail optimization at zero context only (it drops matching
// 1 KB blocks of the two files' common tail before it diffs), which can change where it matches a line it could place
// in either of two spots (a lone `}`). A file whose counts still differ, or whose patch ends inside a hunk, is reported
// as not measured, and the report goes on. A file's text is its blob (`git cat-file blob`). Every `git diff` runs with
// --no-ext-diff, --no-textconv, --no-color and --no-relative, whatever the user's configuration says.
//
// The residual, Git's own choices: its diff algorithm and indent heuristic place the added lines, and can change their
// count; rename detection's similarity threshold (50% by default) and its limit decide what a move is, so an edited
// move below them counts as a deletion and an addition; and attributes can make a file binary, which adds no lines.
//
// With --moved, the lines Git's moved-line detection marks as moved (`moved-lines.mjs`, read once over the whole change)
// are left out of the lines behind two signals, a file gaining over 300 lines and a function over 150 lines that the
// change writes into, and each signal this suppresses is printed with the moved lines it discounted; a file over 1,000
// lines whose added lines are all moved or admitted by `pure-move-check.mjs`'s forms 1-3 (an import or re-export line, a
// bare `export` on a moved declaration, whitespace: its classification, imported) is printed as suppressed with its
// admitted lines; every other signal is as without it. Git's detection is heuristic (a moved block below its threshold reads as added).
//
// With --summary FILE, the files behind two signals, a file over 1000 lines that the change adds to and a file gaining
// over 300 lines, are appended to FILE (CI passes its job summary file) and printed after the report: a heading, the
// command and the merge base's short sha, then a `text` block of one row per file, sorted by name,
// `<file> | <lines at the merge base> → <lines at HEAD> | <signals>`, the signals `over 1000` and `gaining N` (with
// `, M moved discounted` under --moved); `no file signalled` when there is none, and `structure report could not run:
// <reason>` on exit 2. The rows are read from the report's own signals; every other signal is in the report only.
//
// Options: each of --top, --json, --compare, --diff and --summary takes a value, as the next argument or after `=`
// (`--json=FILE`); --top's is a whole number; --moved takes none. Every other argument is a root; one that starts with
// `-` is refused as an unknown option, so a root of that name is written `./-name`.
//
// Exit status: 0 when the report is printed, a --diff report with files it could not measure included; 2, with the
// usage, before anything is read or written, when an option has no value (it is the last argument, the argument after
// it starts with `-`, or nothing follows its `=`), is given twice, or is unknown, or --top's value is not a whole
// number; 2 when --diff cannot read the change's names (a name that is not UTF-8) or its moved lines, or --summary has
// no --diff.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { movedLinesOf, MovedLinesUnreadable } from "./moved-lines.mjs";
import { verdictsOf } from "./pure-move-check.mjs";

const SIGNALS = {
  fileLines: 1000,
  addedLines: 300,
  functionLines: 150,
  folderFiles: 20,
  topLevelFiles: 12,
};
const COMPONENTS = ["src", "player", "tests", "tools", "playground"];
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/;
const PARSED = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

const USAGE = `usage: node tools/structure-report.mjs [ROOT…] [--top N] [--json FILE] [--compare FILE]
       node tools/structure-report.mjs [ROOT…] --diff BASE [--moved] [--json FILE] [--summary FILE]`;
/** Ends the run before anything is read or written (exit 2). */
const refuse = (message) => {
  console.error(`structure-report: ${message}\n${USAGE}`);
  process.exit(2);
};
/**
 * The command line, read once from left to right: each option but the flag --moved takes its value after `=` or as the
 * argument after it, which must be there and must not start with `-`; every option is given at most once; an argument
 * that starts with `-` and is no option is refused; every other argument is a root.
 */
const given = process.argv.slice(2);
const rootArgs = [];
const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("-")) {
    rootArgs.push(arg);
    continue;
  }
  if (arg === "--moved") {
    if (options.has(arg)) refuse(`${arg} is given twice`);
    options.set(arg, true);
    continue;
  }
  const equals = arg.indexOf("=");
  const name = equals < 0 ? arg : arg.slice(0, equals);
  if (!["--top", "--json", "--compare", "--diff", "--summary"].includes(name))
    refuse(`unknown option ${name}`);
  const value = equals < 0 ? process.argv[++i] : arg.slice(equals + 1);
  if (value === undefined || value === "" || (equals < 0 && value.startsWith("-")))
    refuse(`${name} takes a value`);
  if (options.has(name)) refuse(`${name} is given twice`);
  options.set(name, value);
}
if (options.has("--top") && !/^\d+$/u.test(options.get("--top")))
  refuse(`--top takes a whole number, not ${options.get("--top")}`);
const top = Number(options.get("--top") ?? 10);
const jsonOut = options.get("--json");
const compareWith = options.get("--compare");
const diffBase = options.get("--diff");
const summaryOut = options.get("--summary");
const discountMoved = options.has("--moved");
const roots =
  rootArgs.length > 0
    ? rootArgs.map((root) => path.posix.normalize(root).replace(/\/+$/u, "") || ".")
    : COMPONENTS;

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
/** Git's output as raw bytes, for NUL-separated names. */
const gitBytes = (...gitArgs) => execFileSync("git", gitArgs, { maxBuffer: 256 * 1024 * 1024 });
const lineCount = (text) =>
  (text.match(/\n/gu)?.length ?? 0) + (text === "" || text.endsWith("\n") ? 0 : 1);

/**
 * Each function of `text` (a `file` of a parsed language) over the signal's length: its name, first line and lines,
 * Git's lines. TypeScript also ends a line at a lone carriage return, U+2028 and U+2029, so its own line numbers are
 * not used.
 */
function longFunctionsOf(file, text) {
  const found = [];
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  /** The line of offset `at`: how many lines start at or before it. */
  const lineOf = (at) => {
    let [low, high] = [0, starts.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= at) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const visit = (node) => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const start = lineOf(node.getStart(source));
      const span = lineOf(node.getEnd()) - start + 1;
      if (span > SIGNALS.functionLines) {
        const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "(anonymous)";
        found.push({ file, name, line: start, lines: span });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The code files in each folder of `files`. */
function folderCounts(files) {
  const folders = new Map();
  for (const file of files) {
    const dir = path.dirname(file);
    folders.set(dir, (folders.get(dir) ?? 0) + 1);
  }
  return folders;
}

// Names a letter apart: siblings whose names, without extension, differ by one inserted, deleted or changed letter.
const stem = (name) => name.replace(/\..*$/, "");
// A numbered or lettered series (work-a, work-b; spike4, spike14) is deliberate, not a near miss.
const series = (c, name, i) => /[0-9]/.test(c) || (name[i - 1] === "-" && i === name.length - 1);
const oneApart = (a, b) => {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length)
    return a.slice(i + 1) === b.slice(i + 1) && !(series(a[i], a, i) && series(b[i], b, i));
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(i) === long.slice(i + 1) && !series(long[i], long, i);
};
/** The pairs of sibling names a letter apart among `files`, each `{ dir, names }`. */
function nearNamesOf(files) {
  const siblings = new Map();
  for (const file of files) {
    const parts = file.split("/");
    for (let d = 1; d <= parts.length; d++) {
      const dir = parts.slice(0, d - 1).join("/");
      const entry = d === parts.length ? stem(parts[d - 1]) : parts[d - 1];
      if (!siblings.has(dir)) siblings.set(dir, new Set());
      siblings.get(dir).add(entry);
    }
  }
  const pairs = [];
  for (const [dir, names] of siblings) {
    const list = [...names];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (oneApart(list[i], list[j]))
          pairs.push({ dir: dir || ".", names: [list[i], list[j]].sort() });
  }
  return pairs;
}

const listedAt = (ref) =>
  (ref === undefined
    ? git("ls-files", "-z", "--", ...roots)
    : git("ls-tree", "-r", "-z", "--name-only", ref, "--", ...roots)
  )
    .split("\0")
    .filter((f) => f && CODE.test(f));

/** Git's environment for the diffs: without `GIT_DIFF_OPTS`, which would change their context. */
const { GIT_DIFF_OPTS: _diffOptions, ...diffEnvironment } = process.env;

/** `git diff` between two commits, with its output pinned against the user's configuration, as raw bytes. */
const gitDiff = (...diffArgs) =>
  execFileSync(
    "git",
    [
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicPrefix=false",
      "-c",
      "diff.suppressBlankEmpty=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-relative",
      ...diffArgs,
    ],
    { maxBuffer: 256 * 1024 * 1024, env: diffEnvironment },
  );

/** Why the report cannot be trusted: exit 2. */
class CannotRun extends Error {}

/** Git's NUL-separated `bytes` as its fields, each still bytes. */
function fieldsOf(bytes) {
  const fields = [];
  let start = 0;
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
    fields.push(bytes.subarray(start, end));
    start = end + 1;
  }
  return fields;
}

// `ignoreBOM` keeps a name's leading U+FEFF, which the decoder drops otherwise
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** A name Git writes as `bytes`, decoded exactly, or refused: the report reads UTF-8 names only. */
function nameOf(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new CannotRun(
      `structure-report: Git names a file that is not UTF-8 (bytes ${bytes.toString("hex")}): the report reads UTF-8 names only`,
    );
  }
}

/** A name as the report prints it: as is, or quoted when it holds a control character such as a newline or tab. */
const shown = (file) =>
  [...file].some((character) => character < " " || character === "\u007f")
    ? JSON.stringify(file)
    : file;

/** Whether the sorted line numbers `lines` hold one from `from` to `to`, both included. */
function holdsLineIn(lines, from, to) {
  let [low, high] = [0, lines.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lines[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low < lines.length && lines[low] <= to;
}

/** The modes of a regular file's blob; a symlink (120000) and a gitlink (160000) are not measured. */
const REGULAR = new Set(["100644", "100755"]);

/**
 * The line numbers a patch's hunks add, in order: each hunk's body read inside its header's counts, its `+` lines the
 * added ones. `patch` is one file's `git diff` text.
 */
export function addedLinesOfPatch(patch) {
  const added = [];
  // the empty string after a patch's final newline is its end, not a line: a hunk still open there is cut short
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index]);
    if (hunk === null) continue;
    let [old, next, fresh] = [Number(hunk[1] ?? 1), Number(hunk[2]), Number(hunk[3] ?? 1)];
    while (old > 0 || fresh > 0) {
      index += 1;
      const line = lines[index];
      if (line === undefined)
        throw new CannotRun("structure-report: a hunk ends before its counts");
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        added.push(next);
        next += 1;
        fresh -= 1;
      } else if (line.startsWith("-")) old -= 1;
      else {
        next += 1;
        fresh -= 1;
        old -= 1;
      }
    }
  }
  return added;
}

/**
 * The regular code files of commit `ref` under the roots: a map from each name to its blob's mode. Names come from
 * Git's NUL-separated list.
 */
function regularFilesAt(ref) {
  const files = new Map();
  // `<mode> <type> <object>\t<name>`
  for (const entry of fieldsOf(gitBytes("ls-tree", "-r", "-z", ref, "--", ...roots))) {
    const tab = entry.indexOf(9);
    const [mode] = entry.subarray(0, tab).toString("latin1").split(" ");
    const name = nameOf(entry.subarray(tab + 1));
    if (REGULAR.has(mode) && CODE.test(name)) files.set(name, mode);
  }
  return files;
}

/**
 * Git's own count of each file's added lines (`-` for a binary file), the check on the hunks `changeSignals` reads, at
 * their context: `<added>\t<deleted>\t<name>`, or for a move `<added>\t<deleted>\t` and then its two names, each a field
 * of its own.
 */
function gitAddedLines(mergeBase) {
  const numstat = fieldsOf(
    gitDiff("-M", "-U0", "--inter-hunk-context=0", "--numstat", "-z", mergeBase, "HEAD"),
  );
  const gitAdded = new Map();
  for (let i = 0; i < numstat.length;) {
    const record = numstat[i];
    const firstTab = record.indexOf(9);
    const nameStart = record.indexOf(9, firstTab + 1) + 1;
    const added = record.subarray(0, firstTab).toString("latin1");
    if (nameStart === record.length) {
      gitAdded.set(nameOf(numstat[i + 2]), added);
      i += 3;
    } else {
      gitAdded.set(nameOf(record.subarray(nameStart)), added);
      i += 1;
    }
  }
  return gitAdded;
}

/**
 * The signals `file`'s added lines raise (its `HEAD` blob `text`, its added lines `added` in order): a function over
 * the signal's length that they write into, and the file gaining over the signal's lines. With --moved, the lines Git
 * marks as moved (`moved`) are left out, and each signal that leaves out is printed as suppressed with its count.
 */
function addedLinesSignals(file, text, added, moved) {
  const found = [];
  const counted = added.filter((line) => !moved.has(line));
  const discounted = (from, to) =>
    added.filter((line) => line >= from && line <= to && moved.has(line)).length;
  if (PARSED.test(file))
    for (const fn of longFunctionsOf(file, text)) {
      const end = fn.line + fn.lines - 1;
      const what = `function over ${SIGNALS.functionLines} lines that the change writes into: ${shown(file)}:${fn.line} ${fn.name} (${fn.lines} lines)`;
      if (holdsLineIn(counted, fn.line, end)) found.push({ signal: "function", line: what });
      else if (holdsLineIn(added, fn.line, end))
        found.push({
          signal: "suppressed",
          line: `suppressed (moved): ${what}, ${discounted(fn.line, end)} moved lines discounted`,
        });
    }
  const movedCount = added.length - counted.length;
  if (counted.length > SIGNALS.addedLines)
    found.push({
      signal: "added",
      file,
      counted: counted.length,
      moved: movedCount,
      line: `file gaining over ${SIGNALS.addedLines} lines: +${counted.length} ${shown(file)}${movedCount > 0 ? `, ${movedCount} moved discounted` : ""}`,
    });
  else if (added.length > SIGNALS.addedLines)
    found.push({
      signal: "suppressed",
      line: `suppressed (moved): file gaining over ${SIGNALS.addedLines} lines: +${added.length} ${shown(file)}, ${movedCount} moved discounted`,
    });
  return found;
}

/**
 * With --moved, each file's added lines Git marks as moved (`moved`), and those the pure-move check admits by its forms
 * 1-3 (an import or re-export line, a bare `export` on a moved declaration, whitespace: `admitted`), by their line in
 * `HEAD`'s blob.
 */
function movedAndAdmitted(mergeBase) {
  const [moved, admitted] = [new Map(), new Map()];
  const moves = movedLinesOf(mergeBase, "HEAD");
  for (const change of moves)
    if (change.file !== null)
      moved.set(
        change.file,
        new Set(change.addedLines.filter((row) => row.moved).map((row) => row.line)),
      );
  for (const [entry, form] of verdictsOf(mergeBase, "HEAD", moves).verdicts)
    if (entry.side === "added" && ["import", "export", "whitespace"].includes(form)) {
      if (!admitted.has(entry.file)) admitted.set(entry.file, new Set());
      admitted.get(entry.file).add(entry.row.line);
    }
  return { moved, admitted };
}

/**
 * The merge base and the signals the change from it to `HEAD` adds to, each `{ signal, line }` with the line it
 * prints; a `file` and an `added` signal also carry `file`, `before` and `after` (its lines at the merge base and at
 * `HEAD`), an `added` one also its `counted` and `moved` added lines.
 */
function changeSignals(base) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const [headFiles, baseFiles] = [regularFilesAt("HEAD"), regularFilesAt(mergeBase)];
  const selected = (file) =>
    roots.some((root) => root === "." || file === root || file.startsWith(`${root}/`));

  // Names, modes and status come only from Git's NUL-separated raw list, over the whole tree, so that a file moved in
  // from outside the roots is a move: `:<old mode> <new mode> <old blob> <new blob> <status>`, then one or two names.
  const raw = fieldsOf(gitDiff("-M", "--raw", "-z", mergeBase, "HEAD"));
  const changes = [];
  for (let i = 0; i < raw.length;) {
    const [oldMode, newMode, , , code] = raw[i].toString("latin1").slice(1).split(" ");
    if (code.startsWith("R")) {
      changes.push({
        code: "R",
        oldMode,
        newMode,
        old: nameOf(raw[i + 1]),
        file: nameOf(raw[i + 2]),
      });
      i += 3;
    } else {
      const file = nameOf(raw[i + 1]);
      changes.push({ code, oldMode, newMode, old: code === "A" ? null : file, file });
      i += 2;
    }
  }
  const gitAdded = gitAddedLines(mergeBase);
  /**
   * The line numbers `change` adds to its file, from its own patch, checked against `--numstat`: `{ lines }`, or
   * `{ unread }` with the reason when the two disagree or a hunk ends before its counts, so the file is reported as not
   * measured.
   */
  const addedLinesOf = (change) => {
    const paths = change.code === "R" ? [change.old, change.file] : [change.file];
    const patch = gitDiff(
      "-M",
      "-U0",
      "--inter-hunk-context=0",
      mergeBase,
      "HEAD",
      "--",
      ...paths.map((file) => `:(literal)${file}`),
    ).toString("utf8");
    let lines;
    try {
      lines = addedLinesOfPatch(patch);
    } catch (error) {
      if (!(error instanceof CannotRun)) throw error;
      return { unread: "a hunk ends before its counts" };
    }
    const counted = gitAdded.get(change.file);
    if (String(lines.length) !== (counted === "-" ? "0" : counted))
      return {
        unread: `its hunks add ${lines.length} lines, git diff --numstat counts ${counted}`,
      };
    return { lines };
  };
  const blob = (ref, file) => git("cat-file", "blob", `${ref}:${file}`);

  const { moved: movedAdded, admitted: admittedAdded } = discountMoved
    ? movedAndAdmitted(mergeBase)
    : { moved: new Map(), admitted: new Map() };

  const found = [];
  const relevant = changes
    .filter(({ code, file }) => code !== "D" && selected(file) && headFiles.has(file))
    .sort((one, other) => (one.file < other.file ? -1 : one.file > other.file ? 1 : 0));
  for (const change of relevant) {
    const { file } = change;
    const read = addedLinesOf(change);
    if (read.unread !== undefined) {
      found.push({
        signal: "unread",
        line: `file whose change the report could not read as Git wrote it, not measured: ${shown(file)} (${read.unread})`,
      });
      continue;
    }
    const added = read.lines;
    if (added.length === 0) continue;
    const text = blob("HEAD", file);
    const lines = lineCount(text);
    let was;
    const before = () =>
      (was ??=
        change.old === null || !REGULAR.has(change.oldMode)
          ? 0
          : lineCount(blob(mergeBase, change.old)));
    if (lines > SIGNALS.fileLines) {
      const what = `file over ${SIGNALS.fileLines} lines that the change adds to: ${shown(file)} (${lines}, was ${before()})`;
      // with --moved, a file whose added lines are all moved or admitted by the pure-move check's forms 1-3
      const [moved, admitted] = [movedAdded.get(file), admittedAdded.get(file)];
      const discounted = added.filter((line) => moved?.has(line) || admitted?.has(line)).length;
      if (discountMoved && discounted === added.length)
        found.push({
          signal: "suppressed",
          line: `suppressed (moved): ${what}, ${added.filter((line) => admitted?.has(line)).length} admitted lines`,
        });
      else found.push({ signal: "file", file, before: before(), after: lines, line: what });
    }
    for (const signal of addedLinesSignals(file, text, added, movedAdded.get(file) ?? new Set()))
      found.push(
        signal.signal === "added" ? { ...signal, before: before(), after: lines } : signal,
      );
  }
  // a file Git lists as added adds to its folder; a moved one, and an entry whose type changed, do not
  const [headFolders, baseFolders] = [
    folderCounts([...headFiles.keys()]),
    folderCounts([...baseFiles.keys()]),
  ];
  const grownFolders = new Set(
    changes
      .filter(({ code, file }) => code === "A" && selected(file) && headFiles.has(file))
      .map(({ file }) => path.dirname(file)),
  );
  for (const dir of [...grownFolders].sort()) {
    const count = headFolders.get(dir) ?? 0;
    const was = baseFolders.get(dir) ?? 0;
    if (COMPONENTS.includes(dir)) {
      if (count > SIGNALS.topLevelFiles)
        found.push({
          signal: "top level",
          line: `top level over ${SIGNALS.topLevelFiles} files that the change adds to: ${shown(dir)}/ (${count}, was ${was})`,
        });
    } else if (count > SIGNALS.folderFiles)
      found.push({
        signal: "folder",
        line: `folder over ${SIGNALS.folderFiles} files that the change adds to: ${shown(dir)}/ (${count}, was ${was})`,
      });
  }
  const key = ({ dir, names }) => JSON.stringify([dir, ...names]);
  const basePairs = new Set(nearNamesOf([...baseFiles.keys()]).map(key));
  for (const pair of nearNamesOf([...headFiles.keys()]))
    if (!basePairs.has(key(pair)))
      found.push({
        signal: "names",
        line: `names a letter apart: ${shown(pair.dir)}/: ${pair.names.map(shown).join("  ")}`,
      });
  return { mergeBase, found };
}

/**
 * What each kind of signal `changeSignals` returns writes in its file's summary row: its words, or `null` for a kind
 * the summary leaves to the report. A kind not listed stops the summary.
 */
export const SUMMARY_KINDS = {
  file: () => `over ${SIGNALS.fileLines}`,
  added: ({ counted, moved }) =>
    `gaining ${counted}${moved > 0 ? `, ${moved} moved discounted` : ""}`,
  function: null,
  suppressed: null,
  folder: null,
  "top level": null,
  names: null,
  unread: null,
};

/** The summary's block: a heading, `command` and the merge base's short sha `base`, then `rows` in a text block. */
const summaryBlock = (command, base, rows) =>
  [
    "### Structure signals: files",
    "",
    `\`${command}\`${base === undefined ? "" : `, merge base ${base}`}`,
    "",
    "```text",
    ...rows,
    "```",
    "",
  ].join("\n");

/** The summary's rows for `found`: one per file with a `file` or `added` signal, sorted by name. */
function summaryRows(found) {
  const files = new Map();
  for (const signal of found) {
    if (!Object.hasOwn(SUMMARY_KINDS, signal.signal))
      throw new Error(
        `structure-report: the summary does not know the signal kind ${signal.signal}`,
      );
    const words = SUMMARY_KINDS[signal.signal];
    if (words === null) continue;
    const row = files.get(signal.file) ?? { ...signal, words: [] };
    row.words.push(words(signal));
    files.set(signal.file, row);
  }
  const rows = [...files.values()]
    .sort((one, other) => (one.file < other.file ? -1 : one.file > other.file ? 1 : 0))
    .map(
      ({ file, before, after, words }) =>
        `${shown(file)} | ${before} → ${after} | ${words.join(", ")}`,
    );
  return rows.length > 0 ? rows : ["no file signalled"];
}

/** Appends the summary `block` to the --summary file and prints it after the report. */
function writeSummary(block) {
  appendFileSync(summaryOut, block);
  process.stdout.write(`\n${block}`);
}

/** The report the command line asks for. */
function main() {
  const command = [
    "node tools/structure-report.mjs",
    ...given.filter(
      (arg, i) =>
        arg !== "--summary" && !arg.startsWith("--summary=") && given[i - 1] !== "--summary",
    ),
  ].join(" ");
  if (summaryOut !== undefined && !diffBase) {
    const reason = "structure-report: --summary needs --diff";
    console.error(reason);
    writeSummary(summaryBlock(command, undefined, [`structure report could not run: ${reason}`]));
    process.exit(2);
  }
  if (diffBase) {
    let mergeBase, found;
    try {
      ({ mergeBase, found } = changeSignals(diffBase));
    } catch (error) {
      if (!(error instanceof CannotRun || error instanceof MovedLinesUnreadable)) throw error;
      console.error(error.message);
      if (summaryOut !== undefined)
        writeSummary(
          summaryBlock(command, undefined, [`structure report could not run: ${error.message}`]),
        );
      process.exit(2);
    }
    const header = `structure signals this change adds to against ${diffBase}`;
    if (found.length === 0) console.log(`${header}: none`);
    else {
      console.log(`${header} (advisory; each asks for the seam or the reason there is none):`);
      for (const { line } of found) console.log(`  ${line}`);
    }
    if (jsonOut)
      writeFileSync(
        jsonOut,
        `${JSON.stringify({ signals: SIGNALS, base: diffBase, change: found }, null, 2)}\n`,
      );
    if (summaryOut !== undefined)
      writeSummary(
        summaryBlock(command, git("rev-parse", "--short", mergeBase).trim(), summaryRows(found)),
      );
  } else {
    const files = listedAt();
    const fileLines = [];
    const longFunctions = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      fileLines.push({ file, lines: lineCount(text) });
      if (PARSED.test(file)) longFunctions.push(...longFunctionsOf(file, text));
    }
    const folders = folderCounts(files);
    const report = {
      signals: SIGNALS,
      files: files.length,
      largeFiles: fileLines
        .filter((f) => f.lines > SIGNALS.fileLines)
        .sort((a, b) => b.lines - a.lines),
      broadFolders: [...folders]
        .filter(([dir]) => !COMPONENTS.includes(dir))
        .map(([dir, count]) => ({ dir, files: count }))
        .filter((f) => f.files > SIGNALS.folderFiles)
        .sort((a, b) => b.files - a.files),
      broadTopLevels: COMPONENTS.map((dir) => ({ dir, files: folders.get(dir) ?? 0 }))
        .filter((f) => f.files > SIGNALS.topLevelFiles)
        .sort((a, b) => b.files - a.files),
      longFunctions: longFunctions.sort((a, b) => b.lines - a.lines),
      nearNames: nearNamesOf(files),
    };

    const show = (title, rows, line) => {
      console.log(`${title}: ${rows.length}`);
      for (const row of rows.slice(0, top)) console.log(`  ${line(row)}`);
    };
    console.log(`${report.files} code files under ${roots.join(", ")}`);
    show(
      `Files over ${SIGNALS.fileLines} lines`,
      report.largeFiles,
      (r) => `${r.lines}  ${r.file}`,
    );
    show(
      `Folders over ${SIGNALS.folderFiles} files`,
      report.broadFolders,
      (r) => `${r.files}  ${r.dir}/`,
    );
    show(
      `Top levels over ${SIGNALS.topLevelFiles} files`,
      report.broadTopLevels,
      (r) => `${r.files}  ${r.dir}/`,
    );
    show(
      `Functions over ${SIGNALS.functionLines} lines`,
      report.longFunctions,
      (r) => `${r.lines}  ${r.file}:${r.line} ${r.name}`,
    );
    show("Names a letter apart", report.nearNames, (r) => `${r.dir}/: ${r.names.join("  ")}`);

    if (compareWith) {
      const earlier = JSON.parse(readFileSync(compareWith, "utf8"));
      const keys = ["largeFiles", "broadFolders", "broadTopLevels", "longFunctions", "nearNames"];
      const delta = (key) =>
        `${key} ${earlier[key]?.length ?? "(absent)"} -> ${report[key].length}`;
      console.log(`Against ${compareWith}: ${keys.map(delta).join("; ")}`);
    }
    if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
}

// run as a command, not when a test imports `addedLinesOfPatch`
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
