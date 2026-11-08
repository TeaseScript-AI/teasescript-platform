import { ts } from "ts-morph";

import { lintFiles } from "./files.mjs";

// How the comment checks read source: the files they read, each file's scripts (a `.vue` file's `<script>` blocks, any
// other file whole), and each script's comments, through the TypeScript scanner, so strings and code are never read
// as comments.

/** The files the comment checks read: the linted files, `.vue` included. */
export function checkedFiles() {
  return lintFiles();
}

/** `text`'s scripts, each parsed, with the line of the file it starts on (0 for a whole file). */
export function scriptsOf(fileName, text) {
  const parse = (name, source) =>
    ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.getScriptKindFromFileName(name) || ts.ScriptKind.TS,
    );
  if (!fileName.endsWith(".vue")) return [{ source: parse(fileName, text), text, lineOffset: 0 }];
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map((match) => ({
    source: parse(`${fileName}.ts`, match[1]),
    text: match[1],
    lineOffset: text.slice(0, match.index + match[0].indexOf(match[1])).split("\n").length - 1,
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
