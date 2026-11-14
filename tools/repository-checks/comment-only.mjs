import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { ts } from "ts-morph";

// Whether two commits differ only in comments, file by file. It runs by hand, in no check:
//
//   node tools/repository-checks/comment-only.mjs FROM TO [PATH…]
//
// FROM is the reviewed commit, TO the new one; PATHs limit the change, as Git's literal pathspecs. It prints one line
// per changed file, in Git's order:
//   only comments: PATH: comments deleted | comments added or rewritten | whitespace only
//   differs in more: PATH: what differs first, with its place at TO and at FROM
//   not proven: PATH: why the file was not compared
// It exits 0 when every changed file differs only in comments, 1 otherwise, and 2 when it cannot run (a commit that
// does not resolve, or no changed file).
//
// It compares only a file modified in place, a regular file at both commits with the same mode, of the kinds in KINDS,
// UTF-8 at both commits, that TypeScript's parser reads without a syntax error at both. Any other kind of file, or one
// that fails those, is not proven; a file added, deleted, renamed, or changed in mode or type differs in more.
//
// Two versions of a file differ only in comments when, as the parser reads them:
//   1. their tokens are the same, in kind and text;
//   2. they parse to the same tree, so no line break the grammar reads was added or removed (a comment holding a line
//      break counts as one, as ECMAScript reads it);
//   3. their comments a tool reads (READ_BY_TOOLS) are the same, in text and order; the comments and whitespace between
//      the two tokens around each are the same; and the line of the token before each and the line of the token after
//      it hold the same tokens at both, which keeps the reach of a directive over its own line or the next (not of
//      one over the next N lines, such as `c8 ignore next 3`).
// Comments and whitespace may otherwise differ. The parser, not a scan of the text, places the tokens, so a regular
// expression's or a template's text is never read as a comment.

/** The file kinds compared, by extension: how TypeScript parses each, and whether it is read as a module. */
const KINDS = {
  ".ts": { script: ts.ScriptKind.TS, module: true },
  ".mts": { script: ts.ScriptKind.TS, module: true },
  ".cts": { script: ts.ScriptKind.TS, module: false },
  ".mjs": { script: ts.ScriptKind.JS, module: true },
  ".cjs": { script: ts.ScriptKind.JS, module: false },
};

/**
 * The comments a tool reads, each with its name and a test of the comment's whole text (its delimiters included) and
 * of whether the file is JavaScript. A comment one of these matches counts as code. Its tests match more than the
 * tools need, so that a comment no tool reads may count as code, never the other way.
 */
export const READ_BY_TOOLS = [
  ["a shebang", (text) => text.startsWith("#!")],
  [
    "a lint directive",
    (text) =>
      /\b(?:eslint|oxlint)-(?:disable|enable)/u.test(text) ||
      /^\/\*\s*(?:eslint|oxlint|global|globals|exported)\b/u.test(text),
  ],
  ["a TypeScript directive", (text) => /@ts-\w/u.test(text) || /^\/\/\/\s*</u.test(text)],
  ["an `EVIDENCE:` reason", (text) => text.includes("EVIDENCE:")],
  ["a `// pins` mark", (text) => /^\/\/\s*pins\b/u.test(text)],
  [
    "a doc comment with a tag, in JavaScript",
    (text, javaScript) => javaScript && /^\/\*\*[\s\S]*@\w/u.test(text),
  ],
  ["a deprecation", (text) => text.includes("@deprecated")],
  [
    "a build directive",
    (text) =>
      /[@#]__(?:PURE|NO_SIDE_EFFECTS)__|@vite-ignore|@jsx|@license|@preserve/u.test(text) ||
      /^\/\*!|^\/\/[#@]\s*source(?:Mapping)?URL=/u.test(text),
  ],
  [
    "a formatter or coverage directive",
    (text) => /prettier-ignore|\b(?:c8|istanbul|v8) ignore\b/u.test(text),
  ],
];

const LINE_BREAK = /[\n\r\u2028\u2029]/u;

/** The name of the first entry of READ_BY_TOOLS that `text` matches, or undefined. */
function readByTool(text, javaScript) {
  return READ_BY_TOOLS.find(([, matches]) => matches(text, javaScript))?.[0];
}

/** Line and column, both from 1, of `position` in `file`. */
function placeOf(file, position) {
  const { line, character } = file.getLineAndCharacterOfPosition(position);
  return `${line + 1}:${character + 1}`;
}

/**
 * The tokens of `file`, each with the gap before it read into the comments a tool reads (`tools`) and the others
 * (`comments`), or `{ unexpected }` for anything else between two tokens. `shape` is the tree, each node in preorder
 * with its number of children.
 */
function readTokens(file, javaScript) {
  const tokens = [];
  const shape = [];
  const walk = (node) => {
    const children = node.getChildren(file);
    if (children.length === 0 && node.kind !== ts.SyntaxKind.SyntaxList) tokens.push(node);
    else {
      shape.push({ key: `${node.kind}/${children.length}`, at: node.getStart(file) });
      for (const child of children) walk(child);
    }
  };
  walk(file);
  const { text } = file;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  let gapStart = 0;
  const read = [];
  for (const token of tokens) {
    const start = token.getStart(file);
    const comments = [];
    const tools = [];
    scanner.resetTokenState(gapStart);
    for (let trivia = scanner.scan(); scanner.getTokenStart() < start; trivia = scanner.scan()) {
      if (trivia === ts.SyntaxKind.WhitespaceTrivia || trivia === ts.SyntaxKind.NewLineTrivia)
        continue;
      const comment = scanner.getTokenText();
      if (
        trivia !== ts.SyntaxKind.SingleLineCommentTrivia &&
        trivia !== ts.SyntaxKind.MultiLineCommentTrivia &&
        trivia !== ts.SyntaxKind.ShebangTrivia
      ) {
        return {
          unexpected: `${placeOf(file, scanner.getTokenStart())}: ${ts.SyntaxKind[trivia]} between tokens`,
        };
      }
      const tool = readByTool(comment, javaScript);
      if (tool === undefined) comments.push(comment);
      else tools.push(tool);
    }
    const tokenText = text.slice(start, token.end);
    read.push({
      key: `${token.kind} ${tokenText}`,
      shown: `\`${tokenText.length > 40 ? `${tokenText.slice(0, 40)}…` : tokenText}\``,
      start,
      gap: text.slice(gapStart, start),
      gapStart,
      comments,
      tools,
    });
    gapStart = token.end;
  }
  return { tokens: read, shape };
}

/** Rule 3's lines, as indexes of `tokens`: of the token before and the token after each comment a tool reads. */
function linesBesideToolComments(tokens, lineBreakBefore) {
  const lined = new Set();
  tokens.forEach(({ tools }, index) => {
    if (tools.length === 0) return;
    let first = index - 1;
    while (first > 0 && !lineBreakBefore(first)) first -= 1;
    let last = index;
    while (last + 1 < tokens.length && !lineBreakBefore(last + 1)) last += 1;
    // The first token of the next line too, whose line break ends the line.
    for (let line = Math.max(first, 0); line <= Math.min(last + 1, tokens.length - 1); line += 1)
      lined.add(line);
  });
  return lined;
}

/**
 * `text` as the parser reads it: `{ error }`, the place and reason it does not parse, or
 * `{ file, entries, shape, plain }`. `entries` is the sequence rules 1 and 3 compare: per token, the gap before it when
 * that holds a comment a tool reads, the token, and whether a line break precedes it where rule 3 reads that. `plain`
 * holds, per token, the comments in the gap before it that no tool reads.
 */
function readSource(name, text, kind) {
  const file = ts.createSourceFile(
    name,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
      ...(kind.module
        ? { setExternalModuleIndicator: (source) => (source.externalModuleIndicator = true) }
        : {}),
    },
    true,
    kind.script,
  );
  const [error] = file.parseDiagnostics;
  if (error !== undefined) {
    return {
      error: `${placeOf(file, error.start)}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
    };
  }
  const { tokens, shape, unexpected } = readTokens(file, kind.script === ts.ScriptKind.JS);
  if (unexpected !== undefined) return { error: unexpected };
  const lineBreakBefore = (index) => index > 0 && LINE_BREAK.test(tokens[index].gap);
  const lined = linesBesideToolComments(tokens, lineBreakBefore);
  const entries = tokens.flatMap((token, index) => [
    ...(token.tools.length > 0
      ? [
          {
            type: "tool",
            key: token.gap,
            at: token.gapStart,
            what: `a comment a tool reads (${token.tools.join(", ")})`,
          },
        ]
      : []),
    { type: "token", key: token.key, at: token.start, what: token.shown },
    ...(lined.has(index)
      ? [{ type: "line", key: lineBreakBefore(index), at: token.start, what: token.shown }]
      : []),
  ]);
  return { file, entries, shape, plain: tokens.map(({ comments }) => comments) };
}

/** Whether `part`'s characters appear in `whole` in the same order: `whole` with some characters deleted is `part`. */
function isSubsequence(part, whole) {
  let at = 0;
  for (const character of part) {
    at = whole.indexOf(character, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/** What the first differing entries of `from` and `to`, at `index`, show, with their places at TO and at FROM. */
function describeDifference(from, to, index) {
  const before = from.entries[index];
  const after = to.entries[index];
  const placeAt = (side, entry) => (entry === undefined ? "the end" : placeOf(side.file, entry.at));
  const place = `at ${placeAt(to, after)} (${placeAt(from, before)} at FROM)`;
  if (before?.type === "line" && after?.type === "line") {
    const change = before.key ? "removed" : "added";
    return `a line break before ${before.what}, beside a comment a tool reads, ${change} ${place}`;
  }
  if (before?.type === "line" || after?.type === "line") {
    return `the lines beside a comment a tool reads changed ${place}`;
  }
  if (before?.type === "token" && after?.type === "token")
    return `${before.what} became ${after.what} ${place}`;
  if (before?.type === "tool" && after?.type === "tool") {
    return `the comments and whitespace beside ${before.what} changed ${place}`;
  }
  if (before?.type === "tool") return `${before.what} removed ${place}`;
  return `${after?.what ?? "nothing"} added ${place}`;
}

/** The first node of `from.shape` and `to.shape` that differs, with its place at TO and at FROM, or undefined. */
function shapeDifference(from, to) {
  const differing = from.shape.findIndex((node, at) => node.key !== to.shape[at]?.key);
  if (differing === -1 && from.shape.length === to.shape.length) return undefined;
  const index = differing === -1 ? from.shape.length : differing;
  const placeAt = (side) =>
    side.shape[index] === undefined ? "the end" : placeOf(side.file, side.shape[index].at);
  return `the code parses differently, by a line break the grammar reads, at ${placeAt(to)} (${placeAt(from)} at FROM)`;
}

/** The kind of the file at `path`, by its extension, or undefined. */
function kindOf(path) {
  return KINDS[path.slice(path.lastIndexOf("."))];
}

/**
 * The verdict on one file's two texts, `fromText` and `toText`, as the file at `path`:
 * `{ verdict, detail }`, the verdict one of "only comments", "differs in more" and "not proven".
 */
export function compareTexts(path, fromText, toText) {
  const kind = kindOf(path);
  if (kind === undefined)
    return { verdict: "not proven", detail: "no parser for this kind of file" };
  const from = readSource(path, fromText, kind);
  const to = readSource(path, toText, kind);
  if (from.error !== undefined)
    return { verdict: "not proven", detail: `FROM does not parse: ${from.error}` };
  if (to.error !== undefined)
    return { verdict: "not proven", detail: `TO does not parse: ${to.error}` };
  const length = Math.max(from.entries.length, to.entries.length);
  for (let index = 0; index < length; index += 1) {
    const before = from.entries[index];
    const after = to.entries[index];
    if (before?.type !== after?.type || before?.key !== after?.key) {
      return { verdict: "differs in more", detail: describeDifference(from, to, index) };
    }
  }
  const parse = shapeDifference(from, to);
  if (parse !== undefined) return { verdict: "differs in more", detail: parse };
  const gaps = from.plain.map((comments, index) => [
    comments.join("\n"),
    to.plain[index].join("\n"),
  ]);
  if (gaps.every(([before, after]) => before === after))
    return { verdict: "only comments", detail: "whitespace only" };
  const deleted = gaps.every(([before, after]) => isSubsequence(after, before));
  return {
    verdict: "only comments",
    detail: deleted ? "comments deleted" : "comments added or rewritten",
  };
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

/** The verdict on one changed file, from a record of `git diff --raw`. */
function compareChange({ status, fromMode, toMode, fromBlob, toBlob, path, fromPath }) {
  if (status === "A") return { verdict: "differs in more", detail: "added" };
  if (status === "D") return { verdict: "differs in more", detail: "deleted" };
  if (status.startsWith("R"))
    return { verdict: "differs in more", detail: `renamed from ${fromPath}` };
  if (status !== "M") return { verdict: "differs in more", detail: `changed in type (${status})` };
  if (fromMode !== toMode)
    return { verdict: "differs in more", detail: `mode ${fromMode} became ${toMode}` };
  if (!/^100(?:644|755)$/u.test(fromMode))
    return { verdict: "differs in more", detail: `not a regular file (${fromMode})` };
  if (kindOf(path) === undefined)
    return { verdict: "not proven", detail: "no parser for this kind of file" };
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
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({
        status,
        fromMode,
        toMode,
        fromBlob,
        toBlob,
        fromPath: fields[at + 1],
        path: fields[at + 2],
      });
      at += 3;
    } else {
      changes.push({ status, fromMode, toMode, fromBlob, toBlob, path: fields[at + 1] });
      at += 2;
    }
  }
  return changes;
}

function main(argv) {
  if (argv.length < 2 || argv.some((argument) => argument.startsWith("-"))) {
    process.stderr.write("usage: node tools/repository-checks/comment-only.mjs FROM TO [PATH…]\n");
    return 2;
  }
  const [fromRef, toRef, ...paths] = argv;
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
    process.stderr.write(
      `comment-only: no file differs between ${from} and ${to}${paths.length ? " under the paths" : ""}\n`,
    );
    return 2;
  }
  let allOnlyComments = true;
  for (const change of changes) {
    const { verdict, detail } = compareChange(change);
    if (verdict !== "only comments") allOnlyComments = false;
    process.stdout.write(`${verdict}: ${change.path}: ${detail}\n`);
  }
  return allOnlyComments ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
