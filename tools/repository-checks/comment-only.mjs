import { execFileSync } from "node:child_process";

import { ts } from "ts-morph";

// Whether two commits differ only in comments, file by file. It runs by hand, in no check:
//
//   node tools/repository-checks/comment-only.mjs FROM TO [PATH…]
//
// FROM is the reviewed commit, TO the new one; PATHs limit the change, as Git's literal pathspecs. It prints one line
// per changed file, in Git's order, the path quoted as a JSON string when it holds a control character, `"` or `\`:
//   only comments: PATH: comments deleted | comments changed | whitespace only
//   differs in more: PATH: what differs first, with its place at TO and at FROM
//   not proven: PATH: why the file was not compared
// "comments deleted" means whole comments were removed and every other comment is unchanged. It exits 0 when every
// changed file differs only in comments, 1 otherwise, and 2 when it cannot run (a commit that does not resolve, or no
// changed file).
//
// It compares only a file modified in place, a regular file at both commits with the same mode, of the kinds in KINDS,
// UTF-8 at both commits, that TypeScript's parser reads without a syntax error at both. Any other kind of file, or one
// that fails those, is not proven; a file added, deleted, renamed, or changed in mode or type differs in more.
//
// Two versions of a file differ only in comments when, as the parser reads them:
//   1. their tokens are the same, in kind and text;
//   2. each token but the first has a line break before it at both or at neither (a comment holding a line break
//      counts as one, as ECMAScript reads it). Tokens and these line breaks are all the grammar reads, so the program
//      is the same, whatever grammar rule reads a line break (TypeScript checks some, such as no line break before an
//      arrow's `=>`, outside its parser);
//   3. their comments a tool reads (READ_BY_TOOLS) are the same, in text and order, and so are the comments and
//      whitespace between the two tokens around each.
// Comments and whitespace may otherwise differ. A line break that only layout adds or removes, as Prettier does when
// it joins a statement, therefore counts as a difference. The parser, not a scan of the text, places the tokens, so a
// regular expression's or a template's text is never read as a comment. A file holding a directive that reaches more
// lines than the next (`c8 ignore next 3`) is not proven: deleting a comment line could move a line into its reach.

/**
 * The kinds compared, by extension, each read as an ES module, as Node and `tsc` read them here. A script would admit
 * HTML-like comments, which TypeScript reads as tokens and Node as comments.
 */
const KINDS = { ".ts": ts.ScriptKind.TS, ".mts": ts.ScriptKind.TS, ".mjs": ts.ScriptKind.JS };

/**
 * The comments a tool reads, by family, each with its name and a test of the comment's whole text (its delimiters
 * included); a comment one of them matches counts as code. Their consumers, found by a search of the repository's
 * tools and configuration at b6b8a32504f9ab00339721777dc589690c1dc65f: TypeScript, oxlint, ESLint, Prettier, Knip,
 * Vite and Rolldown, Node, `tools/oxlint/anti-slop/` (`EVIDENCE:`), `tools/repository-checks/pin-suites.mjs`
 * (`// pins`) and `tools/oxlint/type-core/check-retained-state.mjs` (`#1072 R26:`). A check that judges only a
 * comment's own text, as the comment checks in `tools/oxlint/comments/` do, does not make it code: deleting the
 * comment deletes what it judges. A tool that starts reading another form of comment needs its row here.
 */
export const READ_BY_TOOLS = [
  ["a tag", (text) => /@[A-Za-z_]/u.test(text)],
  ["a marked comment", (text) => /^(?:#|\/\/[/!#@]|\/\*[!#])/u.test(text)],
  [
    "a directive",
    (text) =>
      /\b(?:eslint|oxlint)-(?:disable|enable)|prettier-ignore|\bignore (?:next|start|stop|file|if|else)\b/u.test(
        text,
      ) || /^\/[/*]\s*(?:eslint|oxlint|globals?|exported)\b/u.test(text),
  ],
  ["an `EVIDENCE:` reason", (text) => text.includes("EVIDENCE:")],
  ["a `// pins` mark", (text) => /^\/\/\s*pins\b/u.test(text)],
  ["a retained capture note", (text) => text.includes("#1072 R26:")],
];

const LINE_BREAK = /[\n\r\u2028\u2029]/u;

function readByTool(text) {
  return READ_BY_TOOLS.find(([, matches]) => matches(text))?.[0];
}

function placeOf(file, position) {
  const { line, character } = file.getLineAndCharacterOfPosition(position);
  return `${line + 1}:${character + 1}`;
}

/** The parse's leaves in source order, without recursion, so that deeply nested code cannot exhaust the stack. */
function leavesOf(file) {
  const leaves = [];
  const pending = [file];
  while (pending.length > 0) {
    const node = pending.pop();
    const children = node.getChildren(file);
    if (children.length === 0 && node.kind !== ts.SyntaxKind.SyntaxList) leaves.push(node);
    else
      for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return leaves;
}

/**
 * `text` as the parser reads it: `{ error }`, why it is not compared, or `{ file, entries, plain }`. `entries` is what
 * rules 1 to 3 compare, per token: the gap before it when that holds a comment a tool reads, the token, and whether a
 * line break precedes it. `plain` holds, per token, the other comments in the gap before it.
 */
function readSource(path, text, scriptKind) {
  const file = ts.createSourceFile(
    path,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
      setExternalModuleIndicator: (source) => (source.externalModuleIndicator = true),
    },
    true,
    scriptKind,
  );
  const [error] = file.parseDiagnostics;
  if (error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
    return { error: `does not parse: ${placeOf(file, error.start)}: ${message}` };
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const entries = [];
  const plain = [];
  let gapStart = 0;
  for (const token of leavesOf(file)) {
    const start = token.getStart(file);
    const gap = text.slice(gapStart, start);
    const comments = [];
    const tools = [];
    scanner.resetTokenState(gapStart);
    for (let trivia = scanner.scan(); scanner.getTokenStart() < start; trivia = scanner.scan()) {
      if (trivia === ts.SyntaxKind.WhitespaceTrivia || trivia === ts.SyntaxKind.NewLineTrivia)
        continue;
      const at = placeOf(file, scanner.getTokenStart());
      if (
        trivia !== ts.SyntaxKind.SingleLineCommentTrivia &&
        trivia !== ts.SyntaxKind.MultiLineCommentTrivia &&
        trivia !== ts.SyntaxKind.ShebangTrivia
      ) {
        return { error: `holds ${ts.SyntaxKind[trivia]} between tokens at ${at}` };
      }
      const comment = scanner.getTokenText();
      const tool = readByTool(comment);
      if (tool === undefined) comments.push(comment);
      else if (/\bignore next\s+(?:[2-9]|\d{2,})/u.test(comment)) {
        return { error: `holds a directive that reaches more than the next line at ${at}` };
      } else tools.push(tool);
    }
    const tokenText = text.slice(start, token.end);
    const shown = `\`${tokenText.length > 40 ? `${tokenText.slice(0, 40)}…` : tokenText}\``;
    if (tools.length > 0) {
      const what = `a comment a tool reads (${tools.join(", ")})`;
      entries.push({ type: "tool", key: gap, at: gapStart, what });
    }
    entries.push({ type: "token", key: `${token.kind} ${tokenText}`, at: start, what: shown });
    if (plain.length > 0)
      entries.push({ type: "line", key: LINE_BREAK.test(gap), at: start, what: shown });
    plain.push(comments);
    gapStart = token.end;
  }
  return { file, entries, plain };
}

function describeDifference(from, to, index) {
  const before = from.entries[index];
  const after = to.entries[index];
  const placeAt = (side, entry) => (entry === undefined ? "the end" : placeOf(side.file, entry.at));
  const place = `at ${placeAt(to, after)} (${placeAt(from, before)} at FROM)`;
  if (before?.type === "line") {
    return `a line break before ${before.what} ${before.key ? "removed" : "added"} ${place}`;
  }
  if (before?.type === "token" && after?.type === "token")
    return `${before.what} became ${after.what} ${place}`;
  if (before?.type === "tool" && after?.type === "tool") {
    return `the comments and whitespace beside ${before.what} changed ${place}`;
  }
  if (before?.type === "tool") return `${before.what} removed ${place}`;
  return `${after?.what ?? "nothing"} added ${place}`;
}

/** Whether `kept` is `all` with some of its items removed, the others unchanged and in order. */
function isSublist(kept, all) {
  let at = 0;
  for (const item of kept) {
    at = all.indexOf(item, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/**
 * The verdict on one file's two texts, `fromText` and `toText`, as the file at `path`: `{ verdict, detail }`, the
 * verdict one of "only comments", "differs in more" and "not proven".
 */
export function compareTexts(path, fromText, toText) {
  const scriptKind = KINDS[path.slice(path.lastIndexOf("."))];
  if (scriptKind === undefined)
    return { verdict: "not proven", detail: "no parser for this kind of file" };
  const from = readSource(path, fromText, scriptKind);
  if (from.error !== undefined) return { verdict: "not proven", detail: `FROM ${from.error}` };
  const to = readSource(path, toText, scriptKind);
  if (to.error !== undefined) return { verdict: "not proven", detail: `TO ${to.error}` };
  const length = Math.max(from.entries.length, to.entries.length);
  for (let index = 0; index < length; index += 1) {
    const before = from.entries[index];
    const after = to.entries[index];
    if (before?.type !== after?.type || before?.key !== after?.key) {
      return { verdict: "differs in more", detail: describeDifference(from, to, index) };
    }
  }
  const gaps = from.plain.map((comments, index) => [comments, to.plain[index]]);
  if (gaps.every(([before, after]) => before.join("\n") === after.join("\n"))) {
    return { verdict: "only comments", detail: "whitespace only" };
  }
  const deleted = gaps.every(([before, after]) => isSublist(after, before));
  return { verdict: "only comments", detail: deleted ? "comments deleted" : "comments changed" };
}

function git(args) {
  return execFileSync("git", ["--literal-pathspecs", ...args], { maxBuffer: 1 << 30 });
}

/** The blob `id` as text, or undefined when it is not UTF-8. */
function blobText(id) {
  const bytes = git(["cat-file", "blob", id]);
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

function shownPath(path) {
  const plain = [...path].every(
    (character) =>
      character >= " " && character !== "\u007f" && character !== '"' && character !== "\\",
  );
  return plain ? path : JSON.stringify(path);
}

/** The verdict on one changed file, a record of `git diff --raw`. */
function compareChange({ status, fromMode, toMode, fromBlob, toBlob, path, fromPath }) {
  const differs = (detail) => ({ verdict: "differs in more", detail });
  if (status === "A") return differs("added");
  if (status === "D") return differs("deleted");
  if (status.startsWith("R")) return differs(`renamed from ${shownPath(fromPath)}`);
  if (status !== "M") return differs(`changed in type (${status})`);
  if (fromMode !== toMode) return differs(`mode ${fromMode} became ${toMode}`);
  if (!/^100(?:644|755)$/u.test(fromMode)) return differs(`not a regular file (${fromMode})`);
  if (KINDS[path.slice(path.lastIndexOf("."))] === undefined) {
    return { verdict: "not proven", detail: "no parser for this kind of file" };
  }
  const fromText = blobText(fromBlob);
  const toText = blobText(toBlob);
  if (fromText === undefined || toText === undefined)
    return { verdict: "not proven", detail: "not UTF-8" };
  return compareTexts(path, fromText, toText);
}

/** The changed files between the commits `from` and `to`, limited to `paths`, as records of `git diff --raw`. */
function changesBetween(from, to, paths) {
  const fields = git(["diff", "--raw", "-z", "-M", "--no-abbrev", from, to, "--", ...paths])
    .toString("utf8")
    .split("\0");
  const changes = [];
  for (let at = 0; at < fields.length - 1;) {
    const [fromMode, toMode, fromBlob, toBlob, status] = fields[at].slice(1).split(" ");
    const record = { status, fromMode, toMode, fromBlob, toBlob };
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({ ...record, fromPath: fields[at + 1], path: fields[at + 2] });
      at += 3;
    } else {
      changes.push({ ...record, path: fields[at + 1] });
      at += 2;
    }
  }
  return changes;
}

function main(argv) {
  const [fromRef, toRef, ...paths] = argv;
  if (toRef === undefined || fromRef.startsWith("-") || toRef.startsWith("-")) {
    process.stderr.write("usage: node tools/repository-checks/comment-only.mjs FROM TO [PATH…]\n");
    return 2;
  }
  let from;
  let to;
  try {
    from = git(["rev-parse", "--verify", "--quiet", `${fromRef}^{commit}`])
      .toString()
      .trim();
    to = git(["rev-parse", "--verify", "--quiet", `${toRef}^{commit}`])
      .toString()
      .trim();
  } catch {
    process.stderr.write(`comment-only: ${fromRef} or ${toRef} is no commit\n`);
    return 2;
  }
  const changes = changesBetween(from, to, paths);
  if (changes.length === 0) {
    const under = paths.length > 0 ? " under the paths" : "";
    process.stderr.write(`comment-only: no file differs between ${from} and ${to}${under}\n`);
    return 2;
  }
  let allOnlyComments = true;
  for (const change of changes) {
    const { verdict, detail } = compareChange(change);
    if (verdict !== "only comments") allOnlyComments = false;
    process.stdout.write(`${verdict}: ${shownPath(change.path)}: ${detail}\n`);
  }
  return allOnlyComments ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
