#!/usr/bin/env node
// Read-only report of code structure for the coordinator's check (docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md,
// "Code structure"). Signals, not limits: each line it prints asks for a seam or a reason.
//
//   node tools/structure-report.mjs [ROOT…] [--top N] [--json FILE] [--compare FILE]
//   node tools/structure-report.mjs [ROOT…] --diff BASE [--json FILE]
//
// ROOT defaults to src, player, tests, tools and playground; each is a component, whose top level is the code files
// directly in it, and no other folder counts as a top level. Only files Git tracks are read. Functions are measured in
// TypeScript and JavaScript files; the script blocks of .vue files are not parsed.
//
// Without --diff: the whole tree's signals, the top N of each (files over 1000 lines, folders over 20 files, top levels
// over 12, functions over 150 lines, names a letter apart). --json writes them all; --compare counts each against an
// earlier --json.
//
// With --diff BASE: only the signals the change since BASE (from its merge-base with HEAD) adds to, each against
// BASE's own tree: a file over 1000 lines that it adds lines to, a function over 150 lines whose lines include one it
// adds, a folder over 20 files or a top level over 12 that it adds a file to, a pair of names a letter apart that BASE
// did not have, and a file gaining over 300 lines. A change adds to a signal whether it crosses the line or the base
// was already over it. A file it only moves (Git's rename detection) adds no lines and no file. Only the changed files
// are parsed. --json writes those lines too, for a READY to quote.
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
const roots = args.length > 0 ? args : ["src", "player", "tests", "tools", "playground"];

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const lineCount = (text) => text.split("\n").length;

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

/** The signals the change since `base` adds to, each `{ signal, line }` with the line the report prints. */
function changeSignals(base) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const headFiles = listedAt();
  const baseFiles = listedAt(mergeBase);
  const status = git("diff", "-M", "--name-status", "-z", mergeBase, "--", ...roots).split("\0");
  // the files the change adds (not those it only renames), and each changed file's name at the base
  const addedFiles = [];
  const before = new Map();
  for (let i = 0; i < status.length - 1;) {
    const code = status[i];
    if (code.startsWith("R") || code.startsWith("C")) {
      before.set(status[i + 2], status[i + 1]);
      if (code.startsWith("C")) addedFiles.push(status[i + 2]);
      i += 3;
    } else {
      if (code === "A") addedFiles.push(status[i + 1]);
      if (code === "M") before.set(status[i + 1], status[i + 1]);
      i += 2;
    }
  }
  // each file's added line numbers, on its side in HEAD
  const addedLines = new Map();
  let current = null;
  for (const line of git("diff", "-M", "-U0", "--no-color", mergeBase, "--", ...roots).split(
    "\n",
  )) {
    if (line.startsWith("+++ ")) current = line === "+++ /dev/null" ? null : line.slice(6);
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current !== null) {
      const [start, count] = [Number(hunk[1]), Number(hunk[2] ?? 1)];
      if (!addedLines.has(current)) addedLines.set(current, []);
      for (let n = start; n < start + count; n++) addedLines.get(current).push(n);
    }
  }
  const changed = [...addedLines.keys()].filter(
    (file) => CODE.test(file) && headFiles.includes(file),
  );
  const baseLines = (file) => {
    const old = before.get(file);
    return old === undefined ? 0 : lineCount(git("show", `${mergeBase}:${old}`));
  };

  const found = [];
  for (const file of changed.sort()) {
    const text = readFileSync(file, "utf8");
    const lines = lineCount(text);
    const added = addedLines.get(file).length;
    if (lines > SIGNALS.fileLines)
      found.push({
        signal: "file",
        line: `file over ${SIGNALS.fileLines} lines that the change adds to: ${file} (${lines}, was ${baseLines(file)})`,
      });
    if (PARSED.test(file)) {
      const written = new Set(addedLines.get(file));
      for (const fn of longFunctionsOf(file, text))
        if ([...written].some((n) => n >= fn.line && n < fn.line + fn.lines))
          found.push({
            signal: "function",
            line: `function over ${SIGNALS.functionLines} lines that the change writes into: ${file}:${fn.line} ${fn.name} (${fn.lines} lines)`,
          });
    }
    if (added > SIGNALS.addedLines)
      found.push({
        signal: "added",
        line: `file gaining over ${SIGNALS.addedLines} lines: +${added} ${file}`,
      });
  }
  const [headFolders, baseFolders] = [folderCounts(headFiles), folderCounts(baseFiles)];
  const grownFolders = new Set(
    addedFiles.filter((file) => CODE.test(file)).map((file) => path.dirname(file)),
  );
  for (const dir of [...grownFolders].sort()) {
    const count = headFolders.get(dir) ?? 0;
    const was = baseFolders.get(dir) ?? 0;
    if (roots.includes(dir)) {
      if (count > SIGNALS.topLevelFiles)
        found.push({
          signal: "top level",
          line: `top level over ${SIGNALS.topLevelFiles} files that the change adds to: ${dir}/ (${count}, was ${was})`,
        });
    } else if (count > SIGNALS.folderFiles)
      found.push({
        signal: "folder",
        line: `folder over ${SIGNALS.folderFiles} files that the change adds to: ${dir}/ (${count}, was ${was})`,
      });
  }
  const key = ({ dir, names }) => `${dir}\n${names.join("\n")}`;
  const basePairs = new Set(nearNamesOf(baseFiles).map(key));
  for (const pair of nearNamesOf(headFiles))
    if (!basePairs.has(key(pair)))
      found.push({
        signal: "names",
        line: `names a letter apart: ${pair.dir}/: ${pair.names.join("  ")}`,
      });
  return found;
}

if (diffBase) {
  const found = changeSignals(diffBase);
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
      .filter(([dir]) => !roots.includes(dir))
      .map(([dir, count]) => ({ dir, files: count }))
      .filter((f) => f.files > SIGNALS.folderFiles)
      .sort((a, b) => b.files - a.files),
    broadTopLevels: roots
      .map((dir) => ({ dir, files: folders.get(dir) ?? 0 }))
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
