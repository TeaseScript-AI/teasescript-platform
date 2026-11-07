import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ts } from "ts-morph";

import { lintFiles } from "./files.mjs";

// A comment says what the code does now and never forecasts later work (IMPLEMENTATION-AND-REVIEW.md "Code that does
// not mislead", #1977). This check reads comments only, never strings or code, in the linted files and in `.vue`
// files' `<script>` blocks. A citation of a repository record (a bare `#N`, `r4.N`, `TABLE §`, `stage N`, `PR N`,
// "before #N") matches no form. `comment-forecasts-allowed.json` lists the forecasts that stay for now, and every
// entry must still be found; `comment-citations.json` holds each file's exact counts of `TABLE r4` and `TABLE §`.

/** The forms of a forecast, #1977's list, each one pattern over a comment's text. */
export const FORECASTS = [
  { form: "until #N", pattern: /\buntil #\d+/iu },
  {
    form: "until a package or stage",
    pattern: /\buntil (?:L\d[a-z]?(?:\.\d+)?|activation|stage \S+)/iu,
  },
  { form: "once #N", pattern: /\bonce #\d+/iu },
  { form: "will be replaced", pattern: /\bwill be replaced\b/iu },
  { form: "which replaces this", pattern: /\bwhich replaces this\b/iu },
  { form: "TODO", pattern: /\bTODO\b/u },
];

/** The citations whose count per file may only shrink. */
export const COUNTED_CITATIONS = ["TABLE r4", "TABLE §"];

/** Each comment of a JavaScript or TypeScript text: its text and 1-based line. */
function comments(fileName, text) {
  const kind = ts.getScriptKindFromFileName(fileName) || ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
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
  return [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((range) => ({
      text: text.slice(range.pos, range.end),
      line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
    }));
}

/** The comments of a file: a `.vue` file's `<script>` blocks, each at its line; any other file whole. */
export function fileComments(fileName, text) {
  if (!fileName.endsWith(".vue")) return comments(fileName, text);
  const found = [];
  for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)) {
    const offset = text.slice(0, match.index + match[0].indexOf(match[1])).split("\n").length - 1;
    for (const comment of comments(`${fileName}.ts`, match[1]))
      found.push({ text: comment.text, line: comment.line + offset });
  }
  return found;
}

/** The forecasts in `text`'s comments: each comment line's form and text. */
export function forecastsIn(fileName, text) {
  const found = [];
  for (const comment of fileComments(fileName, text)) {
    // A forecast can span the lines of a block comment, so each comment is read whole, joined by spaces.
    const whole = comment.text
      .replace(/^\/\/|^\/\*+|\*+\/$/gu, "")
      .replace(/\s*\n\s*\*?\s*/gu, " ");
    for (const { form, pattern } of FORECASTS) {
      const match = pattern.exec(whole);
      if (match) found.push({ line: comment.line, form, text: match[0] });
    }
  }
  return found;
}

/** Each counted citation's number of occurrences in `text`'s comments. */
export function citationCounts(fileName, text) {
  const counts = {};
  for (const comment of fileComments(fileName, text))
    for (const citation of COUNTED_CITATIONS) {
      const n = comment.text.split(citation).length - 1;
      if (n > 0) counts[citation] = (counts[citation] ?? 0) + n;
    }
  return counts;
}

/** The files this check reads: the linted files and the `.vue` files. */
function checkedFiles(root) {
  return [
    ...lintFiles(),
    ...globSync("**/*.vue", { cwd: root, exclude: ["node_modules/**", "dist/**"] }),
  ].sort();
}

/**
 * Every forecast not in the allowlist, every allowlist entry no longer found, and every file whose citation counts
 * differ from `comment-citations.json`'s, as diagnostics.
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function checkCommentForecasts(root) {
  const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
  const allowed = read("./comment-forecasts-allowed.json");
  const recorded = read("./comment-citations.json");
  const diagnostics = [];
  const used = new Set();
  const counted = {};
  for (const file of checkedFiles(root)) {
    const text = readFileSync(resolve(root, file), "utf8");
    for (const forecast of forecastsIn(file, text)) {
      const entry = allowed.findIndex(
        (item, index) =>
          !used.has(index) &&
          item.file === file &&
          item.form === forecast.form &&
          item.text === forecast.text,
      );
      if (entry !== -1) used.add(entry);
      else
        diagnostics.push({
          fileName: file,
          line: forecast.line,
          column: 1,
          message: `a comment forecasts later work ("${forecast.text}", form "${forecast.form}"): say what holds now, and keep the plan in its issue`,
        });
    }
    const counts = citationCounts(file, text);
    if (Object.keys(counts).length > 0) counted[file] = counts;
  }
  for (const [index, item] of allowed.entries())
    if (!used.has(index))
      diagnostics.push({
        fileName: "tools/oxlint/comment-forecasts-allowed.json",
        line: 1,
        column: 1,
        message: `${item.file}: the allowed forecast "${item.text}" is no longer found; remove its entry`,
      });
  for (const file of new Set([...Object.keys(recorded), ...Object.keys(counted)]))
    for (const citation of COUNTED_CITATIONS) {
      const [was, now] = [recorded[file]?.[citation] ?? 0, counted[file]?.[citation] ?? 0];
      if (now > was)
        diagnostics.push({
          fileName: file,
          line: 1,
          column: 1,
          message: `"${citation}" occurs ${now} times in comments, more than the ${was} that comment-citations.json allows`,
        });
      else if (now < was)
        diagnostics.push({
          fileName: "tools/oxlint/comment-citations.json",
          line: 1,
          column: 1,
          message: `${file}: "${citation}" now occurs ${now} times; lower its count from ${was}`,
        });
    }
  return diagnostics;
}
