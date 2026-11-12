// Whether a move's new files are the old file's lines, by whole lines: the proof that a file split, or a block moved
// out of a file, carries every line once, unchanged and in its order. It is `pure-move-check.mjs`'s complement for one
// file: that one admits each added or removed line of a change by Git's moved-line detection (a heuristic that reads a
// short moved block, or a moved line break, as added and removed) and by the forms it names; this one rebuilds the old
// file's body from the new files and reports every line that does not fit.
//
//   node tools/reconstruct-move.mjs BASE OLD NEW… [--edit NEW:LINE=OLDLINE]…
//
// BASE is a commit; OLD the moved file's path in it, read from Git; each NEW a file of the working tree, read as it is
// (OLD may be one of them: a split that keeps the original file). Paths are relative to the current directory, which is
// inside the repository.
//
// The body of a file is its lines after its header: leading `//` comment lines (a new file's header), then its import
// statements (`import …` up to the line ending `"…";`), blank lines between them included. OLD's body starts after its
// imports. Then:
//   - every line of a NEW body that is not blank is a line of OLD's body, equal byte for byte, or that line with
//     `export ` put before it (a declaration a sibling now reads, listed);
//   - each OLD body line that is not blank is taken once, and within one NEW file in OLD's order;
//   - a run of lines is taken whole, longest first, never across a blank line followed by a line at the left margin
//     (one declaration's boundary), so a line repeated in OLD (a `}`) goes with its own block;
//   - blank lines are layout and not compared.
// What is left over is the residue: OLD lines no run took, and NEW lines no OLD line matched. It is admitted only as
// Prettier's rewrap of a declaration that gained `export `: each group of consecutive left-over NEW lines starts with
// `export `, breaks only after `(`, `,`, `=>` or `{`, or before `)` (where a break cannot end a statement: none after
// `return`), and equals one run of consecutive left-over OLD lines with `export` dropped, whitespace and a trailing
// comma before a closing bracket ignored. Anything else fails.
//
// --edit NEW:LINE=OLDLINE declares one changed line: NEW's line LINE is read as OLD's line OLDLINE (both 1-based, NEW's
// counted in the file), and both are printed, so a reviewer reads each edit. A declaration that names no such line
// cannot run.
//
// Output: a summary line (`old body lines: N, taken: N; runs: N; export added: N; residue: N old, N new; edits: N`),
// then each `export` added, each edit, the residue with its verdict, and each failure. Exit status: 0 when every line
// is accounted for; 1 when one is not (a line not in OLD, out of order, an OLD line not taken, a residue that is no
// rewrap); 2 when it cannot run (usage, an unreadable file or commit, a malformed or unmatched --edit).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node tools/reconstruct-move.mjs BASE OLD NEW… [--edit NEW:LINE=OLDLINE]…";

/** A file's lines, without the empty string after a final newline. */
function linesOf(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The index after the import statements from `start` on, blank lines between them included. */
function afterImports(lines, start) {
  let i = start;
  while (i < lines.length) {
    if (lines[i] === "") {
      i += 1;
      continue;
    }
    if (!lines[i].startsWith("import ")) break;
    while (i < lines.length && !/"[^"]+";$/u.test(lines[i])) i += 1;
    i += 1;
  }
  return i;
}

/** The text a residue compares: no whitespace, no trailing comma before a closing bracket. */
const normal = (text) => text.replace(/\s+/gu, "").replace(/,(?=[)\]}])/gu, "");

/** Whether a line break after `line` and before `next` cannot end a statement. */
const safeBreak = (line, next) =>
  /(?:\(|,|=>|\{)$/u.test(line.trimEnd()) || next.trimStart().startsWith(")");

/**
 * Reconstructs `old` (its lines) from `files` (each `{ file, lines }`), with `edits` (a map from `file:line` to the old
 * line, 1-based, it is read as). Returns the counts, the added exports, the residue and the failures.
 */
export function reconstruct(old, files, edits = new Map()) {
  const start = afterImports(old, 0);
  const taken = new Map();
  const failures = [];
  const exported = [];
  const unmatched = [];
  let runs = 0;
  for (const { file, lines: original } of files) {
    const lines = original.map((line, index) => {
      const edit = edits.get(`${file}:${index + 1}`);
      return edit === undefined ? line : old[edit - 1];
    });
    let i = 0;
    while (i < lines.length && lines[i].startsWith("//")) i += 1;
    const first = afterImports(lines, i);
    const fits = (o, k) => old[o] === lines[k] || `export ${old[o]}` === lines[k];
    let last = -1;
    for (let k = first; k < lines.length;) {
      if (lines[k] === "") {
        k += 1;
        continue;
      }
      let best = -1;
      let length = 0;
      for (let o = start; o < old.length; o += 1) {
        if (taken.has(o) || !fits(o, k)) continue;
        let n = 0;
        while (
          k + n < lines.length &&
          o + n < old.length &&
          !taken.has(o + n) &&
          fits(o + n, k + n) &&
          !(n > 0 && lines[k + n - 1] === "" && !/^(?:$|\s)/u.test(lines[k + n]))
        )
          n += 1;
        if (n > length) [best, length] = [o, n];
      }
      if (best === -1) {
        unmatched.push({ file, line: k + 1, text: lines[k] });
        k += 1;
        continue;
      }
      if (best <= last)
        failures.push(
          `${file}:${k + 1}: out of the old file's order (old ${best + 1} after ${last + 1})`,
        );
      for (let n = 0; n < length; n += 1) {
        taken.set(best + n, file);
        if (old[best + n] !== lines[k + n])
          exported.push(`${file}:${k + n + 1} <- old ${best + n + 1}`);
      }
      runs += 1;
      last = best + length - 1;
      k += length;
    }
  }
  const wanted = [];
  for (let o = start; o < old.length; o += 1) if (old[o] !== "") wanted.push(o);
  const missing = wanted.filter((o) => !taken.has(o));

  // The residue: groups of consecutive left-over new lines against runs of consecutive left-over old lines.
  const groups = [];
  for (const entry of unmatched) {
    const group = groups.at(-1);
    if (group && group.file === entry.file && group.lines.at(-1).line === entry.line - 1)
      group.lines.push(entry);
    else groups.push({ file: entry.file, lines: [entry] });
  }
  const oldRuns = [];
  for (const o of missing) {
    const run = oldRuns.at(-1);
    if (run && run.at(-1) === o - 1) run.push(o);
    else oldRuns.push([o]);
  }
  const residue = [];
  const used = new Set();
  for (const group of groups) {
    const texts = group.lines.map((entry) => entry.text);
    const rewrap =
      texts[0].startsWith("export ") &&
      texts.every((text, n) => n === 0 || safeBreak(texts[n - 1], text));
    const target = normal(texts.join("").replace(/^export\s+/u, ""));
    const match = rewrap
      ? oldRuns.findIndex(
          (run, index) => !used.has(index) && normal(run.map((o) => old[o]).join("")) === target,
        )
      : -1;
    if (match !== -1) used.add(match);
    residue.push({ group, run: match === -1 ? null : oldRuns[match] });
    if (match === -1)
      for (const entry of group.lines)
        failures.push(`${entry.file}:${entry.line}: not an old line: ${entry.text.slice(0, 100)}`);
  }
  oldRuns.forEach((run, index) => {
    if (!used.has(index))
      for (const o of run) failures.push(`old ${o + 1}: not taken: ${old[o].slice(0, 100)}`);
  });
  return {
    counts: { old: wanted.length, taken: wanted.length - missing.length, runs },
    exported,
    residue,
    failures,
  };
}

function cannotRun(message) {
  console.error(`reconstruct-move: ${message}`);
  return 2;
}

/** Runs the check with `argv` in `cwd`, printing with `print`; returns the exit status. */
export function main(argv, cwd = process.cwd(), print = console.log) {
  const positional = [];
  const edits = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--edit") {
      const parsed = /^(.+):(\d+)=(\d+)$/u.exec(argv[i + 1] ?? "");
      if (parsed === null) return cannotRun(`--edit takes NEW:LINE=OLDLINE\n${USAGE}`);
      edits.set(`${parsed[1]}:${Number(parsed[2])}`, Number(parsed[3]));
      i += 1;
    } else if (argv[i].startsWith("-")) return cannotRun(USAGE);
    else positional.push(argv[i]);
  }
  if (positional.length < 3) return cannotRun(USAGE);
  const [base, oldPath, ...newPaths] = positional;
  let old;
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const show = path.posix.normalize(`${prefix}${oldPath}`);
    old = linesOf(
      execFileSync("git", ["show", `${base}:${show}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return cannotRun(`cannot read ${oldPath} at ${base}`);
  }
  const files = [];
  for (const file of newPaths) {
    try {
      files.push({ file, lines: linesOf(readFileSync(path.resolve(cwd, file), "utf8")) });
    } catch {
      return cannotRun(`cannot read ${file}`);
    }
  }
  for (const [place, oldLine] of edits) {
    const [file, line] = [
      place.slice(0, place.lastIndexOf(":")),
      Number(place.slice(place.lastIndexOf(":") + 1)),
    ];
    const target = files.find((entry) => entry.file === file);
    if (
      target === undefined ||
      line < 1 ||
      line > target.lines.length ||
      oldLine < 1 ||
      oldLine > old.length
    )
      return cannotRun(`--edit ${place}=${oldLine} names no line of a NEW file and of OLD`);
    print(`edit: ${place}: ${target.lines[line - 1]}`);
    print(`  read as old ${oldLine}: ${old[oldLine - 1]}`);
  }
  const { counts, exported, residue, failures } = reconstruct(old, files, edits);
  const residueOld = residue.reduce((sum, { run }) => sum + (run?.length ?? 0), 0);
  const residueNew = residue.reduce((sum, { group }) => sum + group.lines.length, 0);
  print(
    `old body lines: ${counts.old}, taken: ${counts.taken}; runs: ${counts.runs}; export added: ${exported.length}; ` +
      `residue: ${residueOld} old, ${residueNew} new; edits: ${edits.size}`,
  );
  for (const line of exported) print(`export added: ${line}`);
  for (const { group, run } of residue) {
    print(`residue ${run === null ? "not a rewrap" : "rewrapped"}:`);
    for (const o of run ?? []) print(`  old ${o + 1}: ${old[o]}`);
    for (const entry of group.lines) print(`  new ${entry.file}:${entry.line}: ${entry.text}`);
  }
  for (const failure of failures) print(`failure: ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  process.exitCode = main(process.argv.slice(2));
