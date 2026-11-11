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
// A function is named by its own name when that is an identifier or a private name; else, when it is an arrow function
// or function expression that directly initializes a variable or a property with such a name, by that name; else
// `(anonymous)`. A function over 150 lines that holds other functions, at any depth, also names the longest of them,
// with its lines and first line (the first in source order on a tie), at the end of its line; the whole-tree --json
// gives it as the row's `longestNested`.
//
// Without --diff: the whole tree's signals, the top N of each (files over 1000 lines, folders over 20 files, top levels
// over 12, functions over 150 lines, names a letter apart). --json writes them all; --compare counts each against an
// earlier --json.
//
// With --diff BASE: only the signals the change from the merge base (`git merge-base BASE HEAD`) to `HEAD` adds to,
// each against the merge base's tree: a file over 1000 lines that it grows, a function over 150 lines whose lines
// include one it adds, a folder over 20 files or a top level over 12 that it adds a file to (one Git lists as added: a
// symlink or submodule turned into a regular file is not), a pair of names a letter apart that the merge base did not
// have, and a file gaining over 300 lines. A change adds to a signal whether it crosses the line or the base was
// already over it. Without --moved, a file's growth is its added lines minus its removed lines, whatever those are.
// With --moved, it is its added lines less those Git marks as moved and those `pure-move-check.mjs` admits, minus its
// removed lines less those it admits, and at most its lines at HEAD minus its lines at the merge base, so that a file
// that did not grow never fires. A file over 1000 lines fires when its growth is above 0. A file gaining over 300 lines
// fires when its growth is above 300. Both sides are Git's committed trees, never the working tree: commit first. Only
// the changed files are parsed. --json writes those lines too, for a READY to quote.
//
// What the change is, is Git's. Its files, their modes and status, and their names at the merge base come from `git
// diff -z -M --raw` over the whole tree, so a file moved in from outside the roots is a move; only regular files (modes
// 100644 and 100755) are measured, so a symlink and a submodule are not; a name that is not UTF-8 stops the report
// (exit 2). The lines it adds, by file and position, are the `+` lines of each file's own `git diff -M -U0
// --inter-hunk-context=0`, each hunk's body read inside its header's counts, with `GIT_DIFF_OPTS` removed from Git's
// environment; their count per file is `git diff --numstat`'s, which the tool checks (exit 2 when they differ). A
// file's text is its blob (`git cat-file blob`). Every `git diff` runs with --no-ext-diff, --no-textconv, --no-color
// and --no-relative, whatever the user's configuration says.
//
// The residual, Git's own choices: its diff algorithm and indent heuristic place the added lines, and can change their
// count; rename detection's similarity threshold (50% by default) and its limit decide what a move is, so an edited
// move below them counts as a deletion and an addition; and attributes can make a file binary, which adds no lines.
//
// With --moved, the lines Git's moved-line detection marks as moved (`moved-lines.mjs`, read once over the whole
// change) are left out of a function over 150 lines that the change writes into, and out of a file's growth, with the
// added and removed lines `pure-move-check.mjs`'s forms 1-3 admit (an import or re-export line, a bare `export` on a
// moved declaration, whitespace: its classification, imported). Each file signal this suppresses is printed with its
// growth and its moved, admitted and removed lines, and the function signal with its moved lines; every other signal
// is as without it. Git's detection is heuristic (a moved block below its threshold reads as added).
//
// With --summary FILE, the files behind two signals, a file over 1000 lines that the change grows and a file gaining
// over 300 lines, are appended to FILE (CI passes its job summary file) and printed after the report: a heading, the
// command and the merge base's short sha, then a `text` block of one row per file, sorted by name,
// `<file> | <lines at the merge base> → <lines at HEAD> | <signals>`, the signals `over 1000` and `gaining N`, N the
// growth (with `, M moved discounted` under --moved); `no file signalled` when there is none, `structure report
// could not run: <reason>` on exit 2, and `structure report failed: <error>` when the report throws, which it then
// rethrows. The rows are read from the report's own signals; every other signal is in the report only.
//
// Exit status: 0 when the report is printed, 2 when an option has no value (the next argument missing or another
// option), --diff cannot read the change as Git wrote it, or --summary has no --diff.
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
const given = process.argv.slice(2);
// Each option's value is the argument right after it on the command line as given, read in order, so that each option
// is checked against its own next argument; of an option given twice, the first counts. An option whose next argument
// is missing or is another option (`--…`) has no value, which `main` refuses for the first such option.
const VALUED = ["--top", "--json", "--compare", "--diff", "--summary"];
const values = {};
let valueless;
const args = [];
for (let i = 0; i < given.length; i++) {
  if (!VALUED.includes(given[i])) {
    args.push(given[i]);
    continue;
  }
  const value = given[i + 1];
  if (value === undefined || value.startsWith("--")) valueless ??= given[i];
  else {
    values[given[i]] ??= value;
    i++;
  }
}
const top = Number(values["--top"] ?? 10);
const jsonOut = values["--json"];
const compareWith = values["--compare"];
const diffBase = values["--diff"];
const summaryOut = values["--summary"];
const movedAt = args.indexOf("--moved");
const discountMoved = movedAt !== -1;
if (discountMoved) args.splice(movedAt, 1);
const roots =
  args.length > 0
    ? args.map((root) => path.posix.normalize(root).replace(/\/+$/u, "") || ".")
    : COMPONENTS;

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
/** Git's output as raw bytes, for NUL-separated names. */
const gitBytes = (...gitArgs) => execFileSync("git", gitArgs, { maxBuffer: 256 * 1024 * 1024 });
const lineCount = (text) =>
  (text.match(/\n/gu)?.length ?? 0) + (text === "" || text.endsWith("\n") ? 0 : 1);

/**
 * The name the report gives the function `node` (whose parent is `parent`): its own name, an identifier or a private
 * name; else, for an arrow function or function expression that directly initializes a variable or a property with
 * such a name, that name; else `(anonymous)`.
 */
function functionName(node, parent) {
  if (node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)))
    return node.name.text;
  const initializes =
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node &&
    (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name));
  return initializes ? parent.name.text : "(anonymous)";
}

/** How a function row's line ends: its longest nested function, or nothing when it has none. */
const nestedOf = ({ longestNested: nested }) =>
  nested === undefined
    ? ""
    : `, longest nested function: ${nested.name} (${nested.lines} lines, line ${nested.line})`;

/**
 * Each function of `text` (a `file` of a parsed language) over the signal's length: its name (`functionName`), first
 * line and lines, Git's lines, and when it holds other functions, at any depth, the longest of them as
 * `longestNested`, by the same measures (the first in source order on a tie). TypeScript also ends a line at a lone
 * carriage return, U+2028 and U+2029, so its own line numbers are not used.
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
  /** Walks `node`, whose parent is `parent`: the longest function at or below it, the first on a tie, or `null`. */
  const visit = (node, parent) => {
    let self = null;
    let row = null;
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const line = lineOf(node.getStart(source));
      self = { name: functionName(node, parent), line, lines: lineOf(node.getEnd()) - line + 1 };
      if (self.lines > SIGNALS.functionLines) {
        row = { file, ...self };
        found.push(row);
      }
    }
    let nested = null;
    ts.forEachChild(node, (child) => {
      const longest = visit(child, node);
      if (longest !== null && (nested === null || longest.lines > nested.lines)) nested = longest;
    });
    if (row !== null && nested !== null) row.longestNested = nested;
    // a function holds only functions no longer than itself, and it comes first
    return self ?? nested;
  };
  visit(source, undefined);
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
  const lines = patch.split("\n");
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
 * The signals `file`'s added lines raise (its `HEAD` blob `text`, its added lines `added` in order): a function over
 * the signal's length that they write into, and the file gaining over the signal's lines, by its `growth` (`growthOf`).
 * With --moved, the lines Git marks as moved (`moved`) are left out, and each signal that leaves out is printed as
 * suppressed with its counts.
 */
function addedLinesSignals(file, text, added, moved, growth) {
  const found = [];
  const counted = added.filter((line) => !moved.has(line));
  const discounted = (from, to) =>
    added.filter((line) => line >= from && line <= to && moved.has(line)).length;
  if (PARSED.test(file))
    for (const fn of longFunctionsOf(file, text)) {
      const end = fn.line + fn.lines - 1;
      const what = `function over ${SIGNALS.functionLines} lines that the change writes into: ${shown(file)}:${fn.line} ${fn.name} (${fn.lines} lines)`;
      if (holdsLineIn(counted, fn.line, end))
        found.push({ signal: "function", line: `${what}${nestedOf(fn)}` });
      else if (holdsLineIn(added, fn.line, end))
        found.push({
          signal: "suppressed",
          line: `suppressed (moved): ${what}, ${discounted(fn.line, end)} moved lines discounted${nestedOf(fn)}`,
        });
    }
  if (growth.growth > SIGNALS.addedLines)
    found.push({
      signal: "added",
      file,
      counted: growth.growth,
      moved: growth.moved,
      line: `file gaining over ${SIGNALS.addedLines} lines: +${growth.growth} ${shown(file)}${growth.moved > 0 ? `, ${growth.moved} moved discounted` : ""}`,
    });
  else if (discountMoved && added.length > SIGNALS.addedLines)
    found.push({
      signal: "suppressed",
      line: `suppressed (moved): file gaining over ${SIGNALS.addedLines} lines: +${added.length} ${shown(file)}, ${countsOf(growth)}`,
    });
  return found;
}

/**
 * A file's growth, which both file signals decide by: its added lines (`added`, their line numbers) less those Git
 * marks as moved (`moved`) and those the pure-move check admits (`admitted`), minus the number of lines it removes
 * (`removed`) less the admitted ones among them (`admittedRemoved`), at most its line delta (`delta`, its lines at
 * `HEAD` minus at the merge base). The sets and `admittedRemoved` are empty without --moved. A line both moved and
 * admitted counts once, as moved.
 */
function growthOf(added, removed, moved, admitted, admittedRemoved, delta) {
  const movedCount = added.filter((line) => moved.has(line)).length;
  const admittedCount = added.filter((line) => !moved.has(line) && admitted.has(line)).length;
  const counted = added.length - movedCount - admittedCount - (removed - admittedRemoved);
  return {
    moved: movedCount,
    admitted: admittedCount,
    removed,
    admittedRemoved,
    // the cap: a file whose lines did not grow never grows, whatever its admitted removals
    growth: Math.min(counted, delta),
  };
}
/** The counts behind a growth, as a suppressed signal prints them. */
const countsOf = ({ growth, moved, admitted, removed, admittedRemoved }) =>
  `growth ${growth}: ${moved} moved, ${admitted} admitted, ${removed} removed (${admittedRemoved} admitted)`;

/**
 * With --moved, each file's added lines Git marks as moved (`moved`), and those the pure-move check admits by its forms
 * 1-3 (an import or re-export line, a bare `export` on a moved declaration, whitespace: `admitted`), by their line in
 * `HEAD`'s blob; and the number of its removed lines the check admits by the same forms (`admittedRemoved`), by the
 * file's name at `HEAD`.
 */
function movedAndAdmitted(mergeBase) {
  const [moved, admitted, admittedRemoved] = [new Map(), new Map(), new Map()];
  const moves = movedLinesOf(mergeBase, "HEAD");
  // a removed line's verdict names its file at the merge base
  const headName = new Map();
  for (const change of moves)
    if (change.file !== null) {
      moved.set(
        change.file,
        new Set(change.addedLines.filter((row) => row.moved).map((row) => row.line)),
      );
      if (change.old !== null) headName.set(change.old, change.file);
    }
  for (const [entry, form] of verdictsOf(mergeBase, "HEAD", moves).verdicts) {
    if (!["import", "export", "whitespace"].includes(form)) continue;
    if (entry.side === "added") {
      if (!admitted.has(entry.file)) admitted.set(entry.file, new Set());
      admitted.get(entry.file).add(entry.row.line);
    } else if (headName.has(entry.file)) {
      const file = headName.get(entry.file);
      admittedRemoved.set(file, (admittedRemoved.get(file) ?? 0) + 1);
    }
  }
  return { moved, admitted, admittedRemoved };
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
  // Git's own count of each file's added lines (`-` for a binary file), the check on the hunks read below, and of its
  // removed lines, which count against its growth: `<added>\t<deleted>\t<name>`, or for a move `<added>\t<deleted>\t`
  // and then its two names, each a field of its own.
  const numstat = fieldsOf(gitDiff("-M", "--numstat", "-z", mergeBase, "HEAD"));
  const [gitAdded, gitRemoved] = [new Map(), new Map()];
  for (let i = 0; i < numstat.length;) {
    const record = numstat[i];
    const firstTab = record.indexOf(9);
    const secondTab = record.indexOf(9, firstTab + 1);
    const nameStart = secondTab + 1;
    const added = record.subarray(0, firstTab).toString("latin1");
    const removed = record.subarray(firstTab + 1, secondTab).toString("latin1");
    let file;
    if (nameStart === record.length) {
      file = nameOf(numstat[i + 2]);
      i += 3;
    } else {
      file = nameOf(record.subarray(nameStart));
      i += 1;
    }
    gitAdded.set(file, added);
    gitRemoved.set(file, removed === "-" ? 0 : Number(removed));
  }
  /** The line numbers `change` adds to its file, from its own patch, checked against `--numstat`. */
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
    const lines = addedLinesOfPatch(patch);
    const counted = gitAdded.get(change.file);
    if (String(lines.length) !== (counted === "-" ? "0" : counted))
      throw new CannotRun(
        `structure-report: the hunks of ${shown(change.file)} add ${lines.length} lines, but git diff --numstat counts ${counted}: the patch was not read as Git wrote it`,
      );
    return lines;
  };
  const blob = (ref, file) => git("cat-file", "blob", `${ref}:${file}`);

  const {
    moved: movedAdded,
    admitted: admittedAdded,
    admittedRemoved,
  } = discountMoved
    ? movedAndAdmitted(mergeBase)
    : { moved: new Map(), admitted: new Map(), admittedRemoved: new Map() };

  const found = [];
  const relevant = changes
    .filter(({ code, file }) => code !== "D" && selected(file) && headFiles.has(file))
    .sort((one, other) => (one.file < other.file ? -1 : one.file > other.file ? 1 : 0));
  for (const change of relevant) {
    const { file } = change;
    const added = addedLinesOf(change);
    if (added.length === 0) continue;
    const text = blob("HEAD", file);
    const lines = lineCount(text);
    let was;
    const before = () =>
      (was ??=
        change.old === null || !REGULAR.has(change.oldMode)
          ? 0
          : lineCount(blob(mergeBase, change.old)));
    const moved = movedAdded.get(file) ?? new Set();
    const growth = growthOf(
      added,
      gitRemoved.get(file),
      moved,
      admittedAdded.get(file) ?? new Set(),
      admittedRemoved.get(file) ?? 0,
      lines - before(),
    );
    if (lines > SIGNALS.fileLines) {
      const what = `file over ${SIGNALS.fileLines} lines that the change adds to: ${shown(file)} (${lines}, was ${before()})`;
      if (growth.growth > 0)
        found.push({ signal: "file", file, before: before(), after: lines, line: what });
      else if (discountMoved)
        found.push({
          signal: "suppressed",
          line: `suppressed (moved): ${what}, ${countsOf(growth)}`,
        });
    }
    for (const signal of addedLinesSignals(file, text, added, moved, growth))
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

// whether the summary has its block, so that a throw after it adds none
let summaryWritten = false;
/** Appends the summary `block` to the --summary file and prints it after the report. */
function writeSummary(block) {
  appendFileSync(summaryOut, block);
  summaryWritten = true;
  process.stdout.write(`\n${block}`);
}

/** The command line the summary names, without --summary and its file. */
const command = [
  "node tools/structure-report.mjs",
  ...given.filter((_, i) => given[i] !== "--summary" && given[i - 1] !== "--summary"),
].join(" ");

/** The report the command line asks for. */
function main() {
  if (valueless !== undefined) {
    console.error(`structure-report: ${valueless} needs a value\n${USAGE}`);
    process.exit(2);
  }
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
      (r) => `${r.lines}  ${r.file}:${r.line} ${r.name}${nestedOf(r)}`,
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
) {
  try {
    main();
  } catch (error) {
    // A throw is the tool's own failure: the summary says so, since a missing block reads as no signals. The error
    // itself is what the run reports, also when the summary cannot be written (a summary file that is a folder).
    if (summaryOut !== undefined && !summaryWritten) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        writeSummary(
          summaryBlock(command, undefined, [`structure report failed: ${reason.trimEnd()}`]),
        );
      } catch (unwritten) {
        console.error(`structure-report: the summary could not be written: ${unwritten.message}`);
      }
    }
    throw error;
  }
}
