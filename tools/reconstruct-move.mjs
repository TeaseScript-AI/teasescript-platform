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
// The body of a file is its lines after its header: a NEW file's leading `//` lines, then the import declarations that
// open the file as TypeScript parses them (the line an import ends on is header only when no code follows it there).
// OLD's body starts after its imports. Then:
//   - every line of a NEW body that is not blank is a line of OLD's body, equal byte for byte, or, for a declaration at
//     the left margin (`function`, `async function`, `const`, `let`, `var`, `class`, `abstract class`, `interface`,
//     `type`, `enum`, `declare`), that line with `export ` put before it (a declaration a sibling now reads, listed);
//   - each OLD body line that is not blank is taken once;
//   - a run of lines is taken whole, longest first, never across a blank line followed by a line at the left margin
//     (one declaration's boundary), so a line repeated in OLD (a `}`) goes with its own block;
//   - blank lines are layout and not compared.
// What is left over is the residue: OLD lines no run took, and NEW lines no OLD line matched. It is admitted only as
// Prettier's rewrap of a declaration that gained `export `: each group of consecutive left-over NEW lines starts with
// `export ` before such a declaration, breaks only after `(`, `,`, `=>` or `{`, or before `)` (where a break cannot end
// a statement: none after `return`), and has the tokens of one run of consecutive left-over OLD lines, as TypeScript
// scans them: comments and literals by their exact text, whitespace dropped, and a comma before a closing bracket
// dropped. A group holding a template literal or a `/` is no rewrap (a scan without context cannot tell a regular
// expression from a division). Last, within each NEW file its runs and admitted groups follow OLD's order. Anything
// else fails. The rules are the closed set above: a line or a group they do not admit fails.
//
// A line ends at `\n` only: an input holding a carriage return or a line or paragraph separator (U+2028, U+2029, which
// end a line in JavaScript and could end a `//` header line early) cannot run.
//
// --edit NEW:LINE=OLDLINE declares one changed line: NEW's line LINE is read as OLD's line OLDLINE (both 1-based, NEW's
// counted in the file), and both are printed, so a reviewer reads each edit. A declaration that names no such line
// cannot run.
//
// Output: a summary line (`old body lines: N, taken: N; runs: N; export added: N; residue: N old, N new; edits: N`),
// then each `export` added, each edit, the residue with its verdict, and each failure. Exit status: 0 when every line
// is accounted for; 1 when one is not (a line not in OLD, out of order, an OLD line not taken, a residue that is no
// rewrap); 2 when it cannot run (usage, an unreadable file or commit, a line separator other than `\n`, a malformed or
// unmatched --edit).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";

const USAGE = "usage: node tools/reconstruct-move.mjs BASE OLD NEW… [--edit NEW:LINE=OLDLINE]…";

/** A file's lines, without the empty string after a final newline. */
function linesOf(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The index of a file's first body line: after its leading `//` lines when `header` (a NEW file), then after the
 * import declarations that open it, as TypeScript parses them. The line an import ends on is header only when nothing
 * but a comment follows the import on it.
 */
function bodyStart(text, lines, header) {
  let first = 0;
  if (header) while (first < lines.length && lines[first].startsWith("//")) first += 1;
  const source = ts.createSourceFile("file.ts", text, ts.ScriptTarget.Latest, true);
  let end = -1;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) break;
    end = statement.end;
  }
  if (end === -1) return first;
  const line = source.getLineAndCharacterOfPosition(end).line;
  const rest = lines[line].slice(source.getLineAndCharacterOfPosition(end).character).trim();
  return Math.max(first, rest === "" || rest.startsWith("//") ? line + 1 : line);
}

/** The declarations a moved line may gain `export` on: one at the left margin that a module can export. */
const EXPORTABLE =
  /^(?:async function|function|const|let|var|class|abstract class|interface|type|enum|declare) /u;

/**
 * A text's tokens as TypeScript scans them, comments kept with their text, whitespace and line breaks dropped, and a
 * comma before a closing bracket dropped (the trailing comma Prettier adds); `null` for a text with a template literal
 * or a `/` (a regular expression's text, or a division, which a scan without context cannot tell apart).
 */
function tokensOf(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia) continue;
    if (
      kind === ts.SyntaxKind.SlashToken ||
      kind === ts.SyntaxKind.SlashEqualsToken ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      kind === ts.SyntaxKind.TemplateHead ||
      kind === ts.SyntaxKind.BacktickToken
    )
      return null;
    tokens.push(scanner.getTokenText());
  }
  return tokens.filter((token, i) => !(token === "," && [")", "]", "}"].includes(tokens[i + 1])));
}

/** Whether a line break after `line` and before `next` cannot end a statement. */
const safeBreak = (line, next) =>
  /(?:\(|,|=>|\{)$/u.test(line.trimEnd()) || next.trimStart().startsWith(")");

/** Whether `group` (new lines) is Prettier's rewrap of `run` (old lines) after the declaration gained `export`. */
function rewraps(group, run) {
  if (!group[0].startsWith("export ") || !EXPORTABLE.test(run[0])) return false;
  if (!group.every((text, n) => n === 0 || safeBreak(group[n - 1], text))) return false;
  const before = tokensOf(run.join("\n"));
  const after = tokensOf(group.join("\n").slice("export ".length));
  return before !== null && after !== null && before.join("\0") === after.join("\0");
}

/**
 * Reconstructs OLD (`old`: its text) from `files` (each `{ file, text }`), with `edits` (a map from `file:line` to the
 * old line, 1-based, it is read as). Returns the counts, the added exports, the residue and the failures.
 */
export function reconstruct(oldText, files, edits = new Map()) {
  const old = linesOf(oldText);
  const start = bodyStart(oldText, old, false);
  const taken = new Map();
  const failures = [];
  const exported = [];
  const unmatched = [];
  /** Per NEW file, each run's or residue group's place: its first new line, and its first and last old line. */
  const placed = new Map();
  let runs = 0;
  for (const { file, text } of files) {
    const lines = linesOf(text).map((line, index) => {
      const edit = edits.get(`${file}:${index + 1}`);
      return edit === undefined ? line : old[edit - 1];
    });
    placed.set(file, []);
    const fits = (o, k) =>
      old[o] === lines[k] || (EXPORTABLE.test(old[o]) && `export ${old[o]}` === lines[k]);
    for (let k = bodyStart(text, linesOf(text), true); k < lines.length;) {
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
      for (let n = 0; n < length; n += 1) {
        taken.set(best + n, file);
        if (old[best + n] !== lines[k + n])
          exported.push(`${file}:${k + n + 1} <- old ${best + n + 1}`);
      }
      placed.get(file).push({ line: k + 1, first: best, last: best + length - 1 });
      runs += 1;
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
    const match = oldRuns.findIndex(
      (run, index) =>
        !used.has(index) &&
        rewraps(
          texts,
          run.map((o) => old[o]),
        ),
    );
    residue.push({ group, run: match === -1 ? null : oldRuns[match] });
    if (match === -1) {
      for (const entry of group.lines)
        failures.push(`${entry.file}:${entry.line}: not an old line: ${entry.text.slice(0, 100)}`);
      continue;
    }
    used.add(match);
    const run = oldRuns[match];
    placed.get(group.file).push({ line: group.lines[0].line, first: run[0], last: run.at(-1) });
  }
  oldRuns.forEach((run, index) => {
    if (!used.has(index))
      for (const o of run) failures.push(`old ${o + 1}: not taken: ${old[o].slice(0, 100)}`);
  });
  // The old order within each NEW file, over its runs and its rewrapped declarations alike.
  for (const [file, places] of placed) {
    places.sort((a, b) => a.line - b.line);
    for (let i = 1; i < places.length; i += 1)
      if (places[i].first <= places[i - 1].last)
        failures.push(
          `${file}:${places[i].line}: out of the old file's order (old ${places[i].first + 1} after ${places[i - 1].last + 1})`,
        );
  }
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
  let oldText;
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const show = path.posix.normalize(`${prefix}${oldPath}`);
    oldText = execFileSync("git", ["show", `${base}:${show}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return cannotRun(`cannot read ${oldPath} at ${base}`);
  }
  const files = [];
  for (const file of newPaths) {
    try {
      files.push({ file, text: readFileSync(path.resolve(cwd, file), "utf8") });
    } catch {
      return cannotRun(`cannot read ${file}`);
    }
  }
  // (a line ends only at `\n`: a carriage return or a JavaScript line separator would end a line the check reads as one)
  for (const [name, text] of [[oldPath, oldText], ...files.map(({ file, text }) => [file, text])])
    if (/[\r\u2028\u2029]/u.test(text))
      return cannotRun(`${name} holds a carriage return or a line or paragraph separator`);
  const old = linesOf(oldText);
  for (const [place, oldLine] of edits) {
    const [file, line] = [
      place.slice(0, place.lastIndexOf(":")),
      Number(place.slice(place.lastIndexOf(":") + 1)),
    ];
    const target = files.find((entry) => entry.file === file);
    const lines = target === undefined ? [] : linesOf(target.text);
    if (line < 1 || line > lines.length || oldLine < 1 || oldLine > old.length)
      return cannotRun(`--edit ${place}=${oldLine} names no line of a NEW file and of OLD`);
    print(`edit: ${place}: ${lines[line - 1]}`);
    print(`  read as old ${oldLine}: ${old[oldLine - 1]}`);
  }
  const { counts, exported, residue, failures } = reconstruct(oldText, files, edits);
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
