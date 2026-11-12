// Whether a move's new files are the old file's lines, by whole lines: the proof that a file split, or a block moved
// out of a file, carries every line once, unchanged and in its order. It is `pure-move-check.mjs`'s complement for one
// file: that one admits each added or removed line of a change by Git's moved-line detection (a heuristic that reads a
// short moved block, or a moved line break, as added and removed) and by the forms it names; this one rebuilds the old
// file's body from the new files and reports every line that does not fit.
//
//   node tools/reconstruct-move.mjs BASE OLD NEW… [--edit NEW:A-B=OLD:C-D]…
//
// BASE is a commit; OLD the moved file's path in it, read from Git; each NEW a file of the working tree, read as it is
// (OLD may be one of them: a split that keeps the original file). Paths are relative to the current directory, which is
// inside the repository.
//
// The invariant: the check discards only what TypeScript's parse of the file shows to be layout, and compares all else
// as text; what it cannot show to be layout fails, or is declared with --edit.
//
// The body of a file is its lines after its header. The header is a closed list of lines: a NEW file's leading `//`
// lines, then blank lines and the import declarations that open the file as TypeScript parses them, each starting at
// the left margin with nothing after it on its last line but a `//` comment. The first other line (a shebang, a block
// comment, code) starts the body, OLD's and NEW's alike. A line break inside a token (a string, a template literal's
// part, a comment) is the token's content; a blank line is layout only when its line break lies outside every token.
// Then:
//   - every line of a NEW body that is not a layout blank is a line of OLD's body, equal byte for byte, or, for a line
//     outside tokens that declares at the left margin (`function`, `function*`, `async function`, `async function*`,
//     `const`, `let`, `var`, `class`, `abstract class`, `interface`, `type`, `enum`, `declare`), that line with
//     `export ` put before it (a declaration a sibling now reads, listed);
//   - each OLD body line that is not a layout blank is taken once;
//   - a run of lines is taken whole, longest first, never across a layout blank followed by a line at the left margin
//     (one declaration's boundary);
//   - a line whose line break lies inside a token goes with the line before it, on both sides: in one unit (a run, a
//     declared edit or an admitted group), or in two units that follow each other in its NEW file and in OLD alike.
// What is left over is the residue: OLD lines no run or edit took, and NEW lines no OLD line matched. It is admitted
// only as Prettier's rewrap of a declaration that gained `export `: each group of consecutive left-over NEW lines
// starts with `export ` before such a declaration, breaks only after `(`, `,`, `=>` or `{`, or before `)` (where a
// break cannot end a statement: none after `return`), and has the tokens of one run of consecutive left-over OLD lines,
// as TypeScript scans them: comments and literals by their exact text, whitespace between tokens dropped, and a
// trailing comma (with comments not counted, one before a closing bracket and after an element; never an elision,
// `tokensOf`) dropped. A group holding a template literal or a `/` is no rewrap (a scan without context cannot tell a
// regular expression from a division): such a move is declared with --edit. Last, within each NEW file its runs,
// declared edits and admitted groups follow OLD's order. Anything else fails.
//
// This check does not prove scope or brace ownership; compilation rejects malformed or ill-typed results, while
// behavior requires separate tests or review.
//
// A line ends at `\n` only: an input holding a carriage return or a line or paragraph separator (U+2028, U+2029, which
// end a line in JavaScript and could end a `//` header line early) cannot run, nor can a file TypeScript reports a
// syntax error in (where tokens span lines is read from its parse).
//
// --edit NEW:A-B=OLD:C-D declares one changed passage: NEW's body lines A to B are one unit that takes OLD's body lines
// C to D whole (1-based, counted in each file; the counts may differ). Nothing in it is compared or discarded: both
// sides are printed whole, so a reviewer reads each edit. The unit counts in the order check and in keeping a token's
// lines together as a run does: an edit may take part of a token's lines (one line of a doc comment) only where it
// follows the unit before it, and the unit after it follows it, in NEW and in OLD alike. `OLD:` may be left out (given,
// it is OLD's path as given), and `-B` or `-D` for a range of one line: `NEW:LINE=OLDLINE` is one line on each side. An
// edit that names no body line of a NEW file or of OLD, an empty range, or one that overlaps another edit on either
// side cannot run; a run never takes a declared line.
//
// Output: a summary line (`old body lines: N, taken: N; runs: N; export added: N; residue: N old, N new; edits: N`),
// then each `export` added, each edit, the residue with its verdict, and each failure. Exit status: 0 when every line
// is accounted for; 1 when one is not (a line not in OLD, out of order, an OLD line not taken, a residue that is no
// rewrap, a token's lines apart); 2 when it cannot run (usage, an unreadable file or commit, a line separator other
// than `\n`, a syntax error, a malformed, unmatched or overlapping --edit).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";

const USAGE = "usage: node tools/reconstruct-move.mjs BASE OLD NEW… [--edit NEW:A-B=OLD:C-D]…";

/** A file's lines, without the empty string after a final newline. */
function linesOf(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A file as the check reads it: its lines, its parse (`source`, with `parses` false where TypeScript reports a syntax
 * error), and per line whether the line break before it lies inside a token: a string, a template literal's part, a
 * comment or another token TypeScript's parse spans across lines. Such a break is the token's content, never layout.
 */
function structureOf(file, text) {
  const lines = linesOf(text);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const spans = [];
  // (the comments before a token, and those after it on its line)
  const comments = (node) => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ])
      spans.push([range.pos, range.end]);
  };
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      comments(node);
      spans.push([node.getStart(source), node.end]);
    }
    for (const child of children) visit(child);
  };
  visit(source);
  const inToken = Array.from({ length: lines.length }, () => false);
  for (const [start, end] of spans)
    for (let at = text.indexOf("\n", start); at !== -1 && at < end; at = text.indexOf("\n", at + 1))
      inToken[source.getLineAndCharacterOfPosition(at).line + 1] = true;
  return { lines, source, inToken, parses: source.parseDiagnostics.length === 0 };
}

/** Whether line `i` of a file is a blank line of layout: empty, and not inside a token. */
const layoutBlank = (structure, i) => structure.lines[i] === "" && !structure.inToken[i];

/**
 * The index of a file's first body line. The header is read line by line, and only these lines belong to it: a NEW
 * file's leading `//` lines (`header`), then blank lines and the import declarations that open the file as TypeScript
 * parses them, each starting at the left margin of its first line, with nothing after it on its last line but a `//`
 * comment. The first line that is none of these (a shebang, a block comment, code, an import that does not start or end
 * so) is body.
 */
function bodyStart({ lines, source }, header) {
  let at = 0;
  if (header) while (at < lines.length && lines[at].startsWith("//")) at += 1;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) break;
    const start = source.getLineAndCharacterOfPosition(statement.getStart(source));
    const end = source.getLineAndCharacterOfPosition(statement.end);
    while (at < start.line && lines[at] === "") at += 1;
    if (at !== start.line || start.character !== 0) break;
    const rest = lines[end.line].slice(end.character).trim();
    if (rest !== "" && !rest.startsWith("//")) break;
    at = end.line + 1;
  }
  return at;
}

/** The declarations a moved line may gain `export` on: one at the left margin that a module can export. */
const EXPORTABLE =
  /^(?:async function\*?|function\*?|const|let|var|class|abstract class|interface|type|enum|declare) /u;

/**
 * A text's tokens as TypeScript scans them, comments kept with their text, whitespace and line breaks between tokens
 * dropped, and a trailing comma dropped; `null` for a text with a template literal or a `/` (a regular expression's
 * text, or a division, which a scan without context cannot tell apart). A comma is trailing when, comments not counted,
 * the token after it closes a bracket and the token before it neither opens one nor is a comma: in a file that parses,
 * that comma ends a list after its last element (an array's, an object's, a call's, a parameter list's, an import's, a
 * type's), which it does not change; a comma after an opening bracket or another comma is an elision, an array's hole.
 */
function tokensOf(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens = [];
  const kinds = [];
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
    kinds.push(kind);
  }
  // (a comma's neighbours, comments not counted: a comment is no element)
  const comment = (i) =>
    kinds[i] === ts.SyntaxKind.SingleLineCommentTrivia ||
    kinds[i] === ts.SyntaxKind.MultiLineCommentTrivia;
  const neighbour = (i, step) => {
    let at = i + step;
    while (comment(at)) at += step;
    return tokens[at];
  };
  return tokens.filter(
    (token, i) =>
      !(
        token === "," &&
        [")", "]", "}"].includes(neighbour(i, 1)) &&
        !["(", "[", "{", ","].includes(neighbour(i, -1))
      ),
  );
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

/** An edit as written: `NEW:A-B=OLD:C-D`. */
const spelled = ({ file, from, to, oldFrom, oldTo }) => `${file}:${from}-${to}=${oldFrom}-${oldTo}`;

/**
 * Reconstructs OLD (`oldFile`: `{ file, text }`) from `files` (each `{ file, text }`), with `edits` (each `{ file,
 * from, to, oldFrom, oldTo }`: NEW file `file`'s lines `from` to `to` take OLD's lines `oldFrom` to `oldTo`, 1-based and
 * inclusive). Returns the counts, the added exports, the residue and the failures; or `{ refused }`, a message, when an
 * edit names no body lines or overlaps another.
 */
export function reconstruct(oldFile, files, edits = []) {
  const oldShape = structureOf(oldFile.file, oldFile.text);
  const old = oldShape.lines;
  const start = bodyStart(oldShape, false);
  /** Each OLD line taken: its NEW file, and the run, edit or admitted group (`unit`) that took it. */
  const taken = new Map();
  const failures = [];
  const exported = [];
  const unmatched = [];
  /** Per NEW file, the unit each body line belongs to. */
  const unitsOf = new Map();
  let runs = 0;
  /**
   * Each unit (a run, a declared edit or an admitted group) by its number: its NEW file, its first new line (`line`,
   * 1-based) and its last (`end`, 0-based), and its first and last old line (0-based).
   */
  const places = new Map();
  const place = (entry) => {
    places.set(places.size + 1, entry);
    return places.size;
  };
  for (const { file, text } of files) {
    const shape = structureOf(file, text);
    unitsOf.set(file, { shape, unit: new Map(), first: bodyStart(shape, true) });
  }
  // The declared edits first, each one unit: no run takes their lines on either side.
  for (const edit of edits) {
    const target = unitsOf.get(edit.file);
    if (
      target === undefined ||
      edit.from > edit.to ||
      edit.oldFrom > edit.oldTo ||
      edit.from <= target.first ||
      edit.to > target.shape.lines.length ||
      edit.oldFrom <= start ||
      edit.oldTo > old.length
    )
      return { refused: `--edit ${spelled(edit)} names no body lines of a NEW file and of OLD` };
    const id = place({
      file: edit.file,
      line: edit.from,
      end: edit.to - 1,
      first: edit.oldFrom - 1,
      last: edit.oldTo - 1,
    });
    for (let o = edit.oldFrom - 1; o < edit.oldTo; o += 1) {
      if (taken.has(o)) return { refused: `--edit ${spelled(edit)} overlaps another edit` };
      taken.set(o, { file: edit.file, unit: id });
    }
    for (let k = edit.from - 1; k < edit.to; k += 1) {
      if (target.unit.has(k)) return { refused: `--edit ${spelled(edit)} overlaps another edit` };
      target.unit.set(k, id);
    }
  }
  for (const { file } of files) {
    const { shape, unit } = unitsOf.get(file);
    const { lines } = shape;
    // (a layout blank only against a layout blank; `export ` only before a declaration line that starts outside tokens)
    const fits = (o, k) =>
      layoutBlank(oldShape, o) === layoutBlank(shape, k) &&
      (old[o] === lines[k] ||
        (!oldShape.inToken[o] &&
          !shape.inToken[k] &&
          EXPORTABLE.test(old[o]) &&
          `export ${old[o]}` === lines[k]));
    for (let k = unitsOf.get(file).first; k < lines.length;) {
      if (layoutBlank(shape, k) || unit.has(k)) {
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
          !unit.has(k + n) &&
          fits(o + n, k + n) &&
          !(n > 0 && layoutBlank(shape, k + n - 1) && !/^(?:$|\s)/u.test(lines[k + n]))
        )
          n += 1;
        if (n > length) [best, length] = [o, n];
      }
      if (best === -1) {
        unmatched.push({ file, line: k + 1, text: lines[k] });
        k += 1;
        continue;
      }
      const id = place({
        file,
        line: k + 1,
        end: k + length - 1,
        first: best,
        last: best + length - 1,
      });
      for (let n = 0; n < length; n += 1) {
        taken.set(best + n, { file, unit: id });
        unit.set(k + n, id);
        if (old[best + n] !== lines[k + n])
          exported.push(`${file}:${k + n + 1} <- old ${best + n + 1}`);
      }
      runs += 1;
      k += length;
    }
  }
  const wanted = [];
  for (let o = start; o < old.length; o += 1) if (!layoutBlank(oldShape, o)) wanted.push(o);
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
    const id = place({
      file: group.file,
      line: group.lines[0].line,
      end: group.lines.at(-1).line - 1,
      first: run[0],
      last: run.at(-1),
    });
    for (const o of run) taken.set(o, { file: group.file, unit: id });
    for (const entry of group.lines) unitsOf.get(group.file).unit.set(entry.line - 1, id);
  }
  oldRuns.forEach((run, index) => {
    if (!used.has(index))
      for (const o of run) failures.push(`old ${o + 1}: not taken: ${old[o].slice(0, 100)}`);
  });
  // A token's lines stay together: a line whose break lies inside a token goes with the line before it, in one unit
  // (run, edit or admitted group) or in two units that follow each other in its NEW file and in OLD alike.
  const together = (a, b) => {
    if (a === undefined || b === undefined) return false;
    const [before, after] = [places.get(a), places.get(b)];
    return (
      a === b ||
      (before.file === after.file &&
        before.end + 1 === after.line - 1 &&
        before.last + 1 === after.first)
    );
  };
  for (let o = start + 1; o < old.length; o += 1)
    if (oldShape.inToken[o] && taken.has(o) && !together(taken.get(o - 1)?.unit, taken.get(o).unit))
      failures.push(`old ${o + 1}: a token's line taken apart from the line before it`);
  for (const [file, { shape, unit, first }] of unitsOf)
    for (let k = first; k < shape.lines.length; k += 1)
      if (
        shape.inToken[k] &&
        unit.has(k) &&
        (k === first || !together(unit.get(k - 1), unit.get(k)))
      )
        failures.push(`${file}:${k + 1}: a token's line placed apart from the line before it`);
  // The old order within each NEW file, over its runs, its edits and its rewrapped declarations alike.
  for (const [file, entries] of Map.groupBy(places.values(), (entry) => entry.file)) {
    entries.sort((a, b) => a.line - b.line);
    for (let i = 1; i < entries.length; i += 1)
      if (entries[i].first <= entries[i - 1].last)
        failures.push(
          `${file}:${entries[i].line}: out of the old file's order (old ${entries[i].first + 1} after ${entries[i - 1].last + 1})`,
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
  const edits = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--edit") {
      const parsed = /^(.+):(\d+)(?:-(\d+))?=(?:(.+):)?(\d+)(?:-(\d+))?$/u.exec(argv[i + 1] ?? "");
      if (parsed === null) return cannotRun(`--edit takes NEW:A-B=OLD:C-D\n${USAGE}`);
      const [, file, from, to = from, oldName, oldFrom, oldTo = oldFrom] = parsed;
      edits.push({
        file,
        oldName,
        from: Number(from),
        to: Number(to),
        oldFrom: Number(oldFrom),
        oldTo: Number(oldTo),
      });
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
  // (the check reads where tokens span lines from the parse, so it reads only files that parse)
  for (const [name, text] of [[oldPath, oldText], ...files.map(({ file, text }) => [file, text])])
    if (!structureOf(name, text).parses) return cannotRun(`${name} does not parse`);
  for (const edit of edits)
    if (edit.oldName !== undefined && edit.oldName !== oldPath)
      return cannotRun(`--edit ${spelled(edit)} names ${edit.oldName}, not OLD (${oldPath})`);
  const result = reconstruct({ file: oldPath, text: oldText }, files, edits);
  if (result.refused !== undefined) return cannotRun(result.refused);
  const { counts, exported, residue, failures } = result;
  const old = linesOf(oldText);
  const residueOld = residue.reduce((sum, { run }) => sum + (run?.length ?? 0), 0);
  const residueNew = residue.reduce((sum, { group }) => sum + group.lines.length, 0);
  print(
    `old body lines: ${counts.old}, taken: ${counts.taken}; runs: ${counts.runs}; export added: ${exported.length}; ` +
      `residue: ${residueOld} old, ${residueNew} new; edits: ${edits.length}`,
  );
  for (const line of exported) print(`export added: ${line}`);
  for (const edit of edits) {
    const lines = linesOf(files.find(({ file }) => file === edit.file).text);
    print(`edit: ${spelled(edit)}`);
    for (let o = edit.oldFrom; o <= edit.oldTo; o += 1) print(`  old ${o}: ${old[o - 1]}`);
    for (let k = edit.from; k <= edit.to; k += 1) print(`  new ${edit.file}:${k}: ${lines[k - 1]}`);
  }
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
