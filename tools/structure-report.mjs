#!/usr/bin/env node
// Read-only report of code structure for the coordinator's check (docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md,
// "Code structure"). Signals, not limits: each line it prints asks for a seam or a reason.
//
//   node tools/structure-report.mjs [ROOT…] [--top N] [--json FILE] [--compare FILE]
//   node tools/structure-report.mjs [ROOT…] --diff BASE [--json FILE]
//
// ROOT selects what is read, by default the five components: src, player, tests, tools and playground. A component's
// top level is the code files directly in it; no other folder counts as a top level, whichever ROOT selects it. Only
// files Git tracks are read. A file's lines are counted as an editor shows them: a final newline ends the last line.
// Functions are measured in TypeScript and JavaScript files; the script blocks of .vue files are not parsed.
//
// Without --diff: the whole tree's signals, the top N of each (files over 1000 lines, folders over 20 files, top levels
// over 12, functions over 150 lines, names a letter apart). --json writes them all; --compare counts each against an
// earlier --json.
//
// With --diff BASE: only the signals the change since the merge base (`git merge-base BASE HEAD`) adds to, each against
// the merge base's tree: a file over 1000 lines that it adds lines to, a function over 150 lines whose lines include
// one it adds, a folder over 20 files or a top level over 12 that it adds a file to, a pair of names a letter apart
// that the merge base did not have, and a file gaining over 300 lines. A change adds to a signal whether it crosses the
// line or the base was already over it. Only the changed files are parsed. --json writes those lines too, for a READY
// to quote.
//
// What the change is, is Git's: its files, their status and their names at the merge base come from `git diff -z -M
// --name-status` over the whole tree, so a file moved in from outside the roots is a move; the lines it adds, by file
// and position, are those the hunk headers of each file's own `git diff -M -U0` report, and their count per file is
// `git diff --numstat`'s, which the tool checks (exit 2 when they differ). Every `git diff` runs with --no-ext-diff,
// --no-textconv, --no-color, --no-relative and the standard a/ and b/ prefixes, whatever the user's Git configuration
// says. Git's rename detection decides what a move is: a file it only moves adds no lines and no file, and an edited
// move below its similarity threshold (50% by default) counts as a deletion and an addition.
//
// Exit status: 0 when the report is printed, 2 when --diff's hunks and --numstat disagree.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";

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

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const top = Number(option("--top") ?? 10);
const jsonOut = option("--json");
const compareWith = option("--compare");
const diffBase = option("--diff");
const roots =
  args.length > 0
    ? args.map((root) => path.posix.normalize(root).replace(/\/+$/u, "") || ".")
    : COMPONENTS;

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const lineCount = (text) =>
  (text.match(/\n/gu)?.length ?? 0) + (text === "" || text.endsWith("\n") ? 0 : 1);

/** Each function of `text` (a `file` of a parsed language) over the signal's length: its name, first line and lines. */
function longFunctionsOf(file, text) {
  const found = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const visit = (node) => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
      const span = end - start + 1;
      if (span > SIGNALS.functionLines) {
        const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "(anonymous)";
        found.push({ file, name, line: start + 1, lines: span });
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

/** `git diff` with its output pinned against the user's configuration: no external diff or textconv driver, no colour,
 * the standard prefixes, paths from the top folder. */
const gitDiff = (...diffArgs) =>
  git(
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-relative",
    ...diffArgs,
  );

/** Why the report cannot be trusted: exit 2. */
class CannotRun extends Error {}

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

/** The signals the change since `base` adds to, each `{ signal, line }` with the line the report prints. */
function changeSignals(base) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const headFiles = listedAt();
  const baseFiles = listedAt(mergeBase);
  const headSet = new Set(headFiles);
  const selected = (file) =>
    roots.some((root) => root === "." || file === root || file.startsWith(`${root}/`));

  // Names and status come only from Git's NUL-separated list, over the whole tree, so that a file moved in from outside
  // the roots is a move: each changed file's status and its name at the merge base.
  const status = gitDiff("-M", "--name-status", "-z", mergeBase).split("\0");
  const changes = [];
  for (let i = 0; i < status.length - 1;) {
    const code = status[i];
    if (code.startsWith("R")) {
      changes.push({ code: "R", file: status[i + 2], old: status[i + 1] });
      i += 3;
    } else {
      changes.push({ code, file: status[i + 1], old: code === "A" ? null : status[i + 1] });
      i += 2;
    }
  }
  // Git's own count of each file's added lines (`-` for a binary file), the check on the hunks read below.
  const numstat = gitDiff("-M", "--numstat", "-z", mergeBase).split("\0");
  const gitAdded = new Map();
  for (let i = 0; i < numstat.length - 1;) {
    const [added, , ...name] = numstat[i].split("\t");
    const file = name.join("\t");
    if (file === "") {
      gitAdded.set(numstat[i + 2], added);
      i += 3;
    } else {
      gitAdded.set(file, added);
      i += 1;
    }
  }
  /** The line numbers `change` adds to its file, from the hunk headers of the file's own patch, in order. */
  const addedLinesOf = (change) => {
    const paths = change.code === "R" ? [change.old, change.file] : [change.file];
    const patch = gitDiff(
      "-M",
      "-U0",
      mergeBase,
      "--",
      ...paths.map((file) => `:(literal)${file}`),
    );
    const lines = [];
    // a payload line starts with `+`, `-`, ` ` or `\`, so a line starting `@@ ` is a hunk header
    for (const line of patch.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (hunk === null) continue;
      const [start, count] = [Number(hunk[1]), Number(hunk[2] ?? 1)];
      for (let n = start; n < start + count; n++) lines.push(n);
    }
    const counted = gitAdded.get(change.file);
    if (String(lines.length) !== (counted === "-" ? "0" : counted))
      throw new CannotRun(
        `structure-report: the hunks of ${shown(change.file)} add ${lines.length} lines, but git diff --numstat counts ${counted}: the patch was not read as Git wrote it`,
      );
    return lines;
  };

  const found = [];
  const relevant = changes
    .filter(
      ({ code, file }) => code !== "D" && selected(file) && CODE.test(file) && headSet.has(file),
    )
    .sort((one, other) => (one.file < other.file ? -1 : one.file > other.file ? 1 : 0));
  for (const change of relevant) {
    const { file } = change;
    const added = addedLinesOf(change);
    if (added.length === 0) continue;
    const text = readFileSync(file, "utf8");
    const lines = lineCount(text);
    if (lines > SIGNALS.fileLines) {
      const was =
        change.old === null ? 0 : lineCount(git("cat-file", "blob", `${mergeBase}:${change.old}`));
      found.push({
        signal: "file",
        line: `file over ${SIGNALS.fileLines} lines that the change adds to: ${shown(file)} (${lines}, was ${was})`,
      });
    }
    if (PARSED.test(file))
      for (const fn of longFunctionsOf(file, text))
        if (holdsLineIn(added, fn.line, fn.line + fn.lines - 1))
          found.push({
            signal: "function",
            line: `function over ${SIGNALS.functionLines} lines that the change writes into: ${shown(file)}:${fn.line} ${fn.name} (${fn.lines} lines)`,
          });
    if (added.length > SIGNALS.addedLines)
      found.push({
        signal: "added",
        line: `file gaining over ${SIGNALS.addedLines} lines: +${added.length} ${shown(file)}`,
      });
  }
  // a new file adds to its folder; a moved one does not
  const [headFolders, baseFolders] = [folderCounts(headFiles), folderCounts(baseFiles)];
  const grownFolders = new Set(
    changes
      .filter(({ code, file }) => code === "A" && selected(file) && CODE.test(file))
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
  const basePairs = new Set(nearNamesOf(baseFiles).map(key));
  for (const pair of nearNamesOf(headFiles))
    if (!basePairs.has(key(pair)))
      found.push({
        signal: "names",
        line: `names a letter apart: ${shown(pair.dir)}/: ${pair.names.map(shown).join("  ")}`,
      });
  return found;
}

if (diffBase) {
  let found;
  try {
    found = changeSignals(diffBase);
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    console.error(error.message);
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
  show(`Files over ${SIGNALS.fileLines} lines`, report.largeFiles, (r) => `${r.lines}  ${r.file}`);
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
    const delta = (key) => `${key} ${earlier[key]?.length ?? "(absent)"} -> ${report[key].length}`;
    console.log(`Against ${compareWith}: ${keys.map(delta).join("; ")}`);
  }
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
}
