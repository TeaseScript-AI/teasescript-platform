// The pure-move check's line verdicts: a blob's shape as TypeScript parses it, and each added or removed line Git does
// not mark moved with the form that admits it (`pure-move-check.mjs` states the forms).

import { execFileSync } from "node:child_process";
import { ts } from "ts-morph";

export const PARSED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

/** Whether a change's side is a regular file (mode 100644 or 100755), whose blob is a file's text. */
export const regular = (file, mode) => file !== null && (mode === "100644" || mode === "100755");

/**
 * `text`'s line starts by Git's lines (an LF alone ends one; TypeScript also ends one at a CR or U+2028), and `lineOf`,
 * the line of an offset, found among them by binary search: made once per blob.
 */
export function gitLines(text) {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  const lineOf = (offset) => {
    let [low, high] = [0, starts.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return { starts, lineOf };
}

/**
 * A blob's shape by Git's lines (a newline alone ends one), each line's whole content classified: its import and
 * re-export lines, holding nothing else but whitespace and comments; the lines of comments and whitespace alone above
 * its first import or export statement; its lines of whitespace alone whose line break before them lies outside every
 * token's text, in a parse without a syntax error (`layoutBlanks`); and the lines where a top-level declaration starts, each with whether it starts with
 * its `export` modifier. A file the check does not parse has none of them.
 */
function shapeOf(file, text) {
  const importLines = new Set();
  const headerComments = new Set();
  const layoutBlanks = new Set();
  const declarationStarts = new Map();
  if (!PARSED.test(file)) return { importLines, headerComments, layoutBlanks, declarationStarts };
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const { starts, lineOf } = gitLines(text);
  // the lines whose line break before them lies inside a token's text, which makes it the token's content
  const inToken = new Set();
  // each character's kind: 0 code or a token's text (a string's, a template's, JSX text), 1 a comment, 2 an import or
  // re-export statement. A comment is one wholly inside a token's trivia, between the token's full start and its start:
  // every comment is some token's (the end of the file's included), and no token's own text is trivia. JSDoc nodes are
  // not descended: their text is the trivia of the token they precede.
  const kind = new Uint8Array(text.length);
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    // both scans at the token's full start: a comment before the next newline is a trailing one to the scanner
    const [from, to] = [node.getFullStart(), node.getStart(source)];
    // each line whose LF lies inside the token's text makes the line after it the token's
    for (let line = lineOf(to); line < starts.length && starts[line] - 1 < node.getEnd(); line += 1)
      inToken.add(line + 1);
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, from) ?? []),
      ...(ts.getTrailingCommentRanges(text, from) ?? []),
    ])
      if (range.pos >= from && range.end <= to) kind.fill(1, range.pos, range.end);
  };
  visit(source);
  // where TypeScript reports a syntax error, its recovered parse places no token; a clean parse places them as
  // TypeScript reads the file, not always as Node does (form 3's two readings, `pure-move-check.mjs`'s header)
  const parses = source.parseDiagnostics.length === 0;
  let first = null;
  for (const statement of source.statements) {
    const start = statement.getStart(source);
    const isImport =
      ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) ||
      (ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference));
    if (isImport) kind.fill(2, start, statement.getEnd());
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exportFirst =
      modifiers.length > 0 &&
      modifiers[0].kind === ts.SyntaxKind.ExportKeyword &&
      modifiers[0].getStart(source) === start;
    // a line's declaration start is the statement that starts the line (its first non-whitespace character), no later one
    const startsLine = text.slice(starts[lineOf(start) - 1], start).trim() === "";
    if (
      startsLine &&
      !declarationStarts.has(lineOf(start)) &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isVariableStatement(statement) ||
        ts.isModuleDeclaration(statement))
    )
      declarationStarts.set(lineOf(start), { exported: exportFirst });
    // the header's boundary: the first statement that imports or exports, a decorated export's decorators included
    const exported =
      isImport ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (first === null && exported) first = lineOf(start);
  }
  for (let line = 1; line <= starts.length; line += 1) {
    const [from, to] = [starts[line - 1], line < starts.length ? starts[line] - 1 : text.length];
    let [code, comment, statement] = [false, false, false];
    for (let at = from; at < to; at += 1) {
      if (kind[at] === 1) comment = true;
      else if (kind[at] === 2) statement = true;
      else if (!/\s/u.test(text[at])) code = true;
    }
    if (statement && !code) importLines.add(line);
    if (parses && /^\s*$/u.test(text.slice(from, to)) && !inToken.has(line)) layoutBlanks.add(line);
    if (first !== null && line < first && comment && !code && !statement) headerComments.add(line);
  }
  return { importLines, headerComments, layoutBlanks, declarationStarts };
}

/**
 * Each added or removed line of `files` (the changes `movedLinesOf` reads for `mergeBase`..`head`) that Git does not
 * mark moved, and each line of a side that is no regular file whether Git marks it moved or not, with the form that
 * admits it or `null` (only a declaration admits the latter): `[entry, form, reason]`, `entry` `{ side, file, row,
 * shape, added, irregular }`. `declaredFor(entry)` gives a declared line's reason, asked only of a line no form admits, in
 * diff order. Also the moved lines'
 * counts. Shared with `structure-report.mjs --moved`, so the forms have one home.
 */
export function verdictsOf(
  mergeBase,
  head,
  files,
  { cwd = process.cwd(), declaredFor = () => null } = {},
) {
  const blob = (ref, file) =>
    execFileSync("git", ["cat-file", "blob", `${ref}:${file}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const moved = { added: 0, removed: 0 };
  // removed lines Git does not mark moved where a declaration starts without `export`, by their text without
  // indentation, for form 2's pairing
  const unpairedRemoved = new Map();
  const rows = [];
  for (const change of files) {
    if (change.binary) continue;
    const before = regular(change.old, change.oldMode)
      ? shapeOf(change.old, blob(mergeBase, change.old))
      : null;
    const after = regular(change.file, change.newMode)
      ? shapeOf(change.file, blob(head, change.file))
      : null;
    // a side that is no regular file: each of its lines is judged, moved or not, and only a declaration admits it
    const irregular = {
      removed: change.old !== null && !regular(change.old, change.oldMode),
      added: change.file !== null && !regular(change.file, change.newMode),
    };
    for (const row of change.removedLines) {
      if (irregular.removed)
        rows.push({ side: "removed", file: change.old, row, shape: null, irregular: true });
      else if (row.moved) moved.removed += 1;
      else {
        rows.push({ side: "removed", file: change.old, row, shape: before, added: false });
        if (before?.declarationStarts.get(row.line)?.exported === false) {
          const key = row.text.trimStart();
          unpairedRemoved.set(key, (unpairedRemoved.get(key) ?? 0) + 1);
        }
      }
    }
    for (const row of change.addedLines) {
      if (irregular.added)
        rows.push({ side: "added", file: change.file, row, shape: null, irregular: true });
      else if (row.moved) moved.added += 1;
      else rows.push({ side: "added", file: change.file, row, shape: after, added: change.added });
    }
  }
  // form 2 pairs each `export` line with one removed line; the paired removed lines are admitted with it
  const pairedRemoved = new Map();
  const exportOf = (entry) => {
    const { row } = entry;
    if (entry.shape?.declarationStarts.get(row.line)?.exported !== true) return false;
    const text = row.text.trimStart();
    if (!text.startsWith("export ")) return false;
    const rest = text.slice("export ".length);
    const left = unpairedRemoved.get(rest) ?? 0;
    if (left === 0) return false;
    unpairedRemoved.set(rest, left - 1);
    pairedRemoved.set(rest, (pairedRemoved.get(rest) ?? 0) + 1);
    return true;
  };
  const verdicts = [];
  for (const entry of rows) {
    if (entry.irregular) verdicts.push([entry, null]);
    else if (entry.shape?.importLines.has(entry.row.line)) verdicts.push([entry, "import"]);
    else if (entry.shape?.layoutBlanks.has(entry.row.line)) verdicts.push([entry, "whitespace"]);
    else if (
      entry.side === "added" &&
      entry.added &&
      entry.shape?.headerComments.has(entry.row.line)
    )
      verdicts.push([entry, "header comment"]);
    else if (entry.side === "added" && exportOf(entry)) verdicts.push([entry, "export"]);
    else verdicts.push([entry, null]);
  }
  for (const verdict of verdicts) {
    const [entry, form] = verdict;
    if (form !== null || entry.side !== "removed") continue;
    if (entry.shape?.declarationStarts.get(entry.row.line)?.exported !== false) continue;
    const key = entry.row.text.trimStart();
    const paired = pairedRemoved.get(key) ?? 0;
    if (paired > 0) {
      pairedRemoved.set(key, paired - 1);
      verdict[1] = "export";
    }
  }
  // a declaration is taken only by a line no form admits, in diff order
  for (const verdict of verdicts) {
    if (verdict[1] !== null) continue;
    const reason = declaredFor(verdict[0]);
    if (reason === null) continue;
    verdict[1] = "declared";
    verdict.push(reason);
  }
  return { verdicts, moved };
}
