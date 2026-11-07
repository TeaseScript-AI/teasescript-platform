#!/usr/bin/env node
// Read-only report of code structure for the coordinator's check (docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md,
// "Code structure"): the largest files, the broadest folders, the longest functions, names a letter apart, and with
// --diff the lines a change adds per file. Signals, not limits: each line it prints asks for a seam or a reason.
//
//   node tools/structure-report.mjs [ROOT…] [--top N] [--json FILE] [--compare FILE] [--diff BASE]
//
// ROOT defaults to src, player, tests, tools and playground. Only files Git tracks are read. Functions are measured
// in TypeScript and JavaScript files; the script blocks of .vue files are not parsed.
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

const files = execFileSync("git", ["ls-files", "-z", "--", ...roots], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && CODE.test(f));

const fileLines = [];
const longFunctions = [];
const folders = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n").length;
  fileLines.push({ file, lines });
  const dir = path.dirname(file);
  folders.set(dir, (folders.get(dir) ?? 0) + 1);
  if (!PARSED.test(file)) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const visit = (node) => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
      const span = end - start + 1;
      if (span > SIGNALS.functionLines) {
        const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "(anonymous)";
        longFunctions.push({ file, name, line: start + 1, lines: span });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
const nearNames = [];
for (const [dir, names] of siblings) {
  const list = [...names];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (oneApart(list[i], list[j]))
        nearNames.push({ dir: dir || ".", names: [list[i], list[j]].sort() });
}

let added = [];
if (diffBase) {
  added = execFileSync("git", ["diff", "--numstat", `${diffBase}...HEAD`, "--", ...roots], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter(([a, , f]) => a !== "-" && CODE.test(f))
    .map(([a, , file]) => ({ file, added: Number(a) }));
}

const report = {
  signals: SIGNALS,
  files: files.length,
  largeFiles: fileLines
    .filter((f) => f.lines > SIGNALS.fileLines)
    .sort((a, b) => b.lines - a.lines),
  broadFolders: [...folders]
    .map(([dir, count]) => ({ dir, files: count }))
    .filter((f) => f.files > SIGNALS.folderFiles)
    .sort((a, b) => b.files - a.files),
  longFunctions: longFunctions.sort((a, b) => b.lines - a.lines),
  nearNames,
  added: added.filter((a) => a.added > SIGNALS.addedLines).sort((a, b) => b.added - a.added),
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
  `Functions over ${SIGNALS.functionLines} lines`,
  report.longFunctions,
  (r) => `${r.lines}  ${r.file}:${r.line} ${r.name}`,
);
show("Names a letter apart", report.nearNames, (r) => `${r.dir}/: ${r.names.join("  ")}`);
if (diffBase)
  show(
    `Files gaining over ${SIGNALS.addedLines} lines since ${diffBase}`,
    report.added,
    (r) => `+${r.added}  ${r.file}`,
  );

if (compareWith) {
  const before = JSON.parse(readFileSync(compareWith, "utf8"));
  const delta = (key) => `${key} ${before[key].length} -> ${report[key].length}`;
  console.log(
    `Against ${compareWith}: ${["largeFiles", "broadFolders", "longFunctions", "nearNames"].map(delta).join("; ")}`,
  );
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
