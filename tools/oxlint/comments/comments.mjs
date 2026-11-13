import { ts } from "ts-morph";
import { parse as parseSfc } from "vue/compiler-sfc";

import { lintFiles } from "../files.mjs";

// How the comment checks read source: the files they read, each file's scripts (a `.vue` file's `<script>` blocks, as
// Vue's own parser finds them, any other file whole), and each script's comments, through the TypeScript scanner, so
// strings and code are never read as comments.

/** The files the comment checks read: the linted files, `.vue` included. */
export function checkedFiles() {
  return lintFiles();
}

/** Vue's parse errors in a `.vue` file's `text`, each a message; none for another file. */
export function sfcErrorsOf(fileName, text) {
  if (!fileName.endsWith(".vue")) return [];
  return parseSfc(text, { filename: fileName, sourceMap: false }).errors.map(
    (error) => error.message,
  );
}

/**
 * `text`'s scripts, each parsed, with where its text starts in the file: after `lineOffset` lines, and on that line
 * after `columnOffset` columns (both 0 for a whole file). Vue's parser finds a `.vue` file's blocks, so a `>` in an
 * attribute ends no tag and a `<script>` in a comment or a string is no block.
 */
export function scriptsOf(fileName, text) {
  const parse = (name, source) =>
    ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.getScriptKindFromFileName(name) || ts.ScriptKind.TS,
    );
  if (!fileName.endsWith(".vue"))
    return [{ source: parse(fileName, text), text, lineOffset: 0, columnOffset: 0 }];
  const { descriptor } = parseSfc(text, { filename: fileName, sourceMap: false });
  return [descriptor.script, descriptor.scriptSetup]
    .filter((block) => block !== null)
    .sort((one, other) => one.loc.start.offset - other.loc.start.offset)
    .map(({ content, loc }) => ({
      source: parse(`${fileName}.ts`, content),
      text: content,
      lineOffset: loc.start.line - 1,
      columnOffset: loc.start.column - 1,
    }));
}

/** A parsed script's comment ranges, in order, each once. */
export function commentRanges(source, text) {
  const ranges = new Map();
  for (const nodes = [source]; nodes.length > 0;) {
    const node = nodes.pop();
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ])
      ranges.set(range.pos, range);
    nodes.push(...node.getChildren(source));
  }
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}

/** A file's comments: each one's text and 1-based line in the file. */
export function fileComments(fileName, text) {
  return scriptsOf(fileName, text).flatMap(({ source, text: script, lineOffset }) =>
    commentRanges(source, script).map((range) => ({
      text: script.slice(range.pos, range.end),
      line: source.getLineAndCharacterOfPosition(range.pos).line + 1 + lineOffset,
    })),
  );
}
