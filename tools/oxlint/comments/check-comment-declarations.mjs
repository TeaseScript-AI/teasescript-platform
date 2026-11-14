import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ts } from "ts-morph";

import { checkedFiles, commentRanges, scriptsOf } from "./comments.mjs";

// A name a comment writes in backticks must be one the repository declares or reads somewhere
// (IMPLEMENTATION-AND-REVIEW.md "Code that does not mislead"). This proves only that the name exists somewhere the
// repository declares or reads it, not that it names what the comment's site means: a name that exists in another
// module passes (F10's `nullAt` would have). The repository's names are every declaration's name in the checked files
// (properties, parameters and imports included), every property read (`process.env.X`), every word inside a string or
// template literal (kinds such as `"executionPending"`, TeaseScript names in test sources, the language-facts tables),
// the names TypeScript's `lib.*.d.ts` and `@types/node` declare, and `globalThis`'s own. A backticked text is checked
// only when it is one identifier or a `.`/`#` chain of them, optionally with `()`: anything with a space, quote,
// operator, slash or hyphen is code, and a file name, an issue (`#N`) or a SHA-shaped hex token is not a name.
// `comment-external-names.json` declares the names no file can (shell tools, external APIs, example names), each with
// its kind; that list may grow.

const IDENTIFIER = /^#?[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*(?:\(\))?$/u;
const FILE_NAME = /\.(?:[cm]?[jt]sx?|json|jsonl|md|vue|jpg|png|xmp|tease|d|gz|tsv)$/u;
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

/**
 * Every backticked name that names nothing the repository declares or reads, unless `comment-external-names.json`
 * declares it.
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function checkCommentDeclarations(root) {
  const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
  const external = new Set(read("./comment-external-names.json").map(({ name }) => name));
  const files = checkedFiles().map((file) => {
    const text = readFileSync(resolve(root, file), "utf8");
    return { file, scripts: scriptsOf(file, text) };
  });
  const names = libraryNames(root);
  for (const { scripts } of files) for (const { source } of scripts) addNames(source, names);
  const diagnostics = [];
  for (const { file, scripts } of files)
    for (const { source, text, lineOffset } of scripts)
      for (const range of commentRanges(source, text)) {
        const comment = text.slice(range.pos, range.end);
        const line = source.getLineAndCharacterOfPosition(range.pos).line + 1 + lineOffset;
        for (const match of comment.matchAll(/`([^`\n]+)`/gu))
          if (citedNames(match[1]).some((name) => !names.has(name) && !external.has(name)))
            diagnostics.push({
              fileName: file,
              line,
              column: 1,
              message: `\`${match[1]}\` names nothing the repository declares or reads`,
            });
      }
  return diagnostics;
}
