import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ts } from "ts-morph";

import { checkedFiles, commentRanges, scriptsOf } from "./comments.mjs";

// Two checks of what a comment says about the code (IMPLEMENTATION-AND-REVIEW.md "Code that does not mislead"):
//
// - References: a name a comment writes in backticks must be one the repository declares or reads somewhere. This
//   proves only that the name exists somewhere the repository declares or reads it, not that it names what the
//   comment's site means: a name that exists in another module passes (F10's `nullAt` would have). The repository's names are every declaration's name in the checked files (properties, parameters and
//   imports included), every property read (`process.env.X`), every word inside a string or template literal (kinds
//   such as `"executionPending"`, TeaseScript names in test sources, the language-facts tables), the names TypeScript's
//   `lib.*.d.ts` and `@types/node` declare, and `globalThis`'s own. A backticked text is checked only when it is one
//   identifier or a `.`/`#` chain of them, optionally with `()`: anything with a space, quote, operator, slash or
//   hyphen is code, and a file name, an issue (`#N`) or a SHA-shaped hex token is not a name.
//   `comment-external-names.json` declares the names no file can (shell tools, external APIs), each with its kind;
//   that list may grow.
// - Docblocks: a `/**` block stands directly on what it documents: only whitespace without a blank line follows it,
//   and no comment but a line directive (`oxlint-disable-next-line`, `eslint-disable-next-line`, `@ts-expect-error`).
//   Allowed: a file's opening header, before any code and followed by a blank line; and a block with code after it on
//   its own line (a JSDoc cast).
//   A block after a blank line, a block another block stacks on, and a block before a closing brace or the end of the
//   file document nothing.
//
// `comment-declarations-waiting.json` lists the findings that wait for another pull request or the compiler's own
// cleanup. It may only shrink: every entry must still be found.

const IDENTIFIER = /^#?[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*(?:\(\))?$/u;
const FILE_NAME = /\.(?:[cm]?[jt]sx?|json|jsonl|md|vue|jpg|png|xmp|tease|d|gz|tsv)$/u;
const DIRECTIVE =
  /^[ \t]*\/\/\s*(?:(?:oxlint|eslint)-disable-next-line\b|@ts-(?:expect-error|ignore)\b)[^\n]*$/gmu;

/** The names a backticked comment text cites, or none when it is code, a file name, an issue or a SHA. */
export function citedNames(backticked) {
  if (!IDENTIFIER.test(backticked) || FILE_NAME.test(backticked)) return [];
  if (/^[0-9a-f]{7,40}$/u.test(backticked) && /\d/u.test(backticked)) return [];
  return backticked.replace(/\(\)$/u, "").replace(/^#/u, "").split(/[.#]/u);
}

const DECLARATIONS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ExportSpecifier,
]);
const LITERALS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** The names a parsed script declares or reads, added to `names`. */
export function addNames(source, names) {
  for (const nodes = [source]; nodes.length > 0;) {
    const node = nodes.pop();
    const name = node.name;
    if (
      DECLARATIONS.has(node.kind) &&
      name &&
      (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))
    )
      names.add(name.text.replace(/^#/u, ""));
    if (
      ts.isPropertyAccessExpression(node) &&
      (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))
    )
      names.add(node.name.text.replace(/^#/u, ""));
    if (LITERALS.has(node.kind))
      for (const word of node.text.matchAll(/[A-Za-z_$][\w$]*/gu)) names.add(word[0]);
    nodes.push(...node.getChildren(source));
  }
}

/** The names TypeScript's libraries and Node's types declare, and `globalThis`'s own. */
function libraryNames(root) {
  const names = new Set(Object.getOwnPropertyNames(globalThis));
  for (const file of [
    ...globSync("node_modules/typescript/lib/lib.*.d.ts", { cwd: root }),
    ...globSync("node_modules/@types/node/**/*.d.ts", { cwd: root }),
  ])
    addNames(
      ts.createSourceFile(
        file,
        readFileSync(resolve(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ),
      names,
    );
  return names;
}

/** The docblocks of a parsed script that document nothing: each one's 1-based line and opening line. */
export function detachedDocblocks(source, text) {
  const found = [];
  const ranges = commentRanges(source, text);
  const firstCode = source.statements[0]?.getStart(source) ?? text.length;
  for (const [index, range] of ranges.entries()) {
    const block = text.slice(range.pos, range.end);
    if (!block.startsWith("/**") || block.startsWith("/***")) continue;
    const followed = nextCode(text, range.end, ranges);
    const between = text.slice(range.end, followed);
    // (a file's opening header, before any code and a blank line, documents the file)
    if (index === 0 && range.end <= firstCode && /^[ \t]*\n[ \t]*\n/u.test(text.slice(range.end)))
      continue;
    const documentsNothing =
      followed >= text.length ||
      text[followed] === "}" ||
      /\n[ \t]*\n/u.test(between) ||
      /\/[/*]/u.test(between.replace(DIRECTIVE, ""));
    if (documentsNothing)
      found.push({
        line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
        // (its first line of text, which names the block in a waiting entry)
        text:
          block
            .replace(/^\/\*\*|\*\/$/gu, "")
            .split("\n")
            .map((line) => line.replace(/^\s*\*?\s?/u, "").trim())
            .find((line) => line !== "") ?? "",
      });
  }
  return found;
}

/** The position of the first code after `position`, past whitespace and comments. */
function nextCode(text, position, ranges) {
  let at = position;
  for (;;) {
    at += /^\s*/u.exec(text.slice(at))[0].length;
    const comment = ranges.find((range) => range.pos === at);
    if (comment === undefined) return at;
    at = comment.end;
  }
}

/**
 * Every backticked name that names nothing the repository declares or reads, and every docblock that documents
 * nothing, unless `comment-external-names.json` declares the name or `comment-declarations-waiting.json` lists the
 * finding; and every waiting entry no longer found.
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function checkCommentDeclarations(root) {
  const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
  const external = new Set(read("./comment-external-names.json").map(({ name }) => name));
  const waiting = read("./comment-declarations-waiting.json");
  const files = checkedFiles().map((file) => {
    const text = readFileSync(resolve(root, file), "utf8");
    return { file, scripts: scriptsOf(file, text) };
  });
  const names = libraryNames(root);
  for (const { scripts } of files) for (const { source } of scripts) addNames(source, names);
  const diagnostics = [];
  const used = new Set();
  const report = (file, line, kind, text, message) => {
    const entry = waiting.findIndex(
      (item, index) =>
        !used.has(index) && item.file === file && item.kind === kind && item.text === text,
    );
    if (entry !== -1) used.add(entry);
    else diagnostics.push({ fileName: file, line, column: 1, message });
  };
  for (const { file, scripts } of files)
    for (const { source, text, lineOffset } of scripts) {
      for (const range of commentRanges(source, text)) {
        const comment = text.slice(range.pos, range.end);
        const line = source.getLineAndCharacterOfPosition(range.pos).line + 1 + lineOffset;
        for (const match of comment.matchAll(/`([^`\n]+)`/gu))
          if (citedNames(match[1]).some((name) => !names.has(name) && !external.has(name)))
            report(
              file,
              line,
              "reference",
              match[1],
              `\`${match[1]}\` names nothing the repository declares or reads`,
            );
      }
      for (const block of detachedDocblocks(source, text))
        report(
          file,
          block.line + lineOffset,
          "docblock",
          block.text,
          "this docblock documents nothing: put it directly on its declaration, without a blank line or another comment between",
        );
    }
  for (const [index, item] of waiting.entries())
    if (!used.has(index))
      diagnostics.push({
        fileName: "tools/oxlint/comments/comment-declarations-waiting.json",
        line: 1,
        column: 1,
        message: `${item.file}: the waiting ${item.kind} "${item.text}" is no longer found; remove its entry`,
      });
  return diagnostics;
}
