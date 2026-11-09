import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkedFiles, fileComments } from "./comments.mjs";

// A comment says what the code does now and never forecasts later work (IMPLEMENTATION-AND-REVIEW.md "Code that does
// not mislead", #1977). This check reads comments only, never strings or code, in the linted files and in `.vue`
// files' `<script>` blocks. A citation of a repository record matches no form: a bare `#N`, a completed stage, `PR N`,
// "(as) before #N". The forms of `COUNTED_CITATIONS` cite the old design record, which is not in the repository
// (#1977), so they are no citations: each file's exact count of them in comments is in `comment-citations.json`, which
// may only fall. A comment that points at the accepted record
// (`docs/specifications/type-inference-accepted-record/<page>.md#<anchor>`, #2089) names a heading of that page; the
// doc-links check reads Markdown only and never sees a comment. A label of the port plan or the research design (`S8c`,
// `C9`, `AD-1`) in a comment of the type core's modules has a row in the record's glossary, and every row is still
// carried by such a comment; an id after a reviewer's round ("Codex r2's B1") is a review reference, not a label.
// `comment-forecasts-allowed.json` lists the forecasts this check accepts, and every entry must still be found.

/** The forms of a forecast, #1977's list, each one pattern over a comment's text. */
export const FORECASTS = [
  { form: "until #N", pattern: /\buntil #\d+/iu },
  {
    form: "until a package or stage",
    pattern: /\buntil (?:L\d[a-z]?(?:\.\d+)?|activation|stage \S+)/iu,
  },
  { form: "once #N", pattern: /\bonce #\d+/iu },
  {
    form: "when or after #N lands or merges",
    pattern: /\b(?:when|after) #\d+ (?:lands|merges|is merged)\b/iu,
  },
  { form: "will be replaced", pattern: /\bwill be replaced\b/iu },
  { form: "which replaces this", pattern: /\bwhich replaces this\b/iu },
  { form: "TODO", pattern: /\bTODO\b/u },
];

/** The citations whose count per file may only shrink, each by its pattern over a comment's text. */
const COUNTED_CITATIONS = {
  "TABLE r4": /TABLE r4/gu,
  "TABLE §": /TABLE §/gu,
  "bare r4.N": /(?<!TABLE )\br4\.\d+/gu,
  "other TABLE": /\bTABLE\b(?!\s*(?:r4|§))/gu,
};

/** The accepted record's folder of pages, which a comment may point at by a page and a heading's anchor. */
const RECORD = "docs/specifications/type-inference-accepted-record";

/** The type core's modules, whose comments' labels the record's glossary defines. */
const CORE = "src/type-inference/core/";

/**
 * A port-plan or research label: a step, an id, a checkpoint, the plan or a plan document. A section number (`§3.2`,
 * `S3 §5`) is not a label; the glossary's one row for a bare `§N` is not checked against comments.
 */
export const LABEL =
  /\b(?:S\d-[A-Z]+(?:-[A-Z]+)*|S\d{1,2}[a-z]?|[A-Z]{1,2}\d{1,3}[a-z]?|AD-\d|PLAN|checkpoint \d+)\b/gu;

/**
 * A reviewer, a round (`r2's`, `round 10`) or a pull request (`#1422`) just before an id makes it a review
 * reference ("Codex r2's B1", "r1's and r2's B1", "#1422 B1", "the owner's F1", "the merged S6's B1"),
 * not a label.
 */
const REVIEWED =
  /(?:\b(?:Codex|Astra|Sol|Fable|Opus)\b[^.;]{0,30}|(?:\br\d+(?:'s)?|\bround \d+|#\d+(?:'s)?|\bowner's(?: reviewer's)?(?: review)?|\bS\d{1,2}[a-z]?'s)(?:\s+(?:and\s+)?[A-Z]{1,2}\d{1,3}[a-z]?,?)*\s+)$/u;

/** A reviewer's review just after an id ("B1 of Astra's review") makes it a review reference too. */
const REVIEWED_AFTER = /^ of (?:Codex|Astra|Sol|Fable|Opus)'s review/u;

/** Labels that name a repository document, not the plan or the research. */
const DOCUMENTS = new Set(["V30"]);

/** Each label in `text`'s comments, with its line; review references and document names are not labels. */
export function labelsIn(fileName, text) {
  const found = [];
  for (const comment of fileComments(fileName, text))
    for (const match of comment.text.matchAll(LABEL)) {
      const before = comment.text.slice(Math.max(0, match.index - 40), match.index);
      const after = comment.text.slice(
        match.index + match[0].length,
        match.index + match[0].length + 30,
      );
      if (REVIEWED.test(before) || REVIEWED_AFTER.test(after) || DOCUMENTS.has(match[0])) continue;
      found.push({
        line: comment.line + comment.text.slice(0, match.index).split("\n").length - 1,
        label: match[0],
      });
    }
  return found;
}

/** The glossary's rows in the record's `README.md`: each label of its `## Labels` table, with its line. */
export function glossaryRows(readme) {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => line === "## Labels");
  const rows = new Map();
  if (start === -1) return rows;
  for (let index = start + 1; index < lines.length && !lines[index].startsWith("## "); index++) {
    const row = /^\| `([^`]+)` \|/u.exec(lines[index]);
    if (row) rows.set(row[1], index + 1);
  }
  return rows;
}

/**
 * Each label the core's comments carry (`carried`, with its file and line) that the glossary has no row for, and each
 * row whose label no comment carries; the bare `§N` row is not checked against comments.
 */
export function glossaryFindings(carried, glossary) {
  const findings = [];
  for (const { fileName, line, label } of carried)
    if (!glossary.has(label))
      findings.push({
        fileName,
        line,
        column: 1,
        message: `a comment carries the label ${label}, which the accepted record's glossary does not define (${RECORD}/README.md, Labels)`,
      });
  const labels = new Set(carried.map(({ label }) => label));
  for (const [label, line] of glossary)
    if (!labels.has(label) && !label.startsWith("§"))
      findings.push({
        fileName: `${RECORD}/README.md`,
        line,
        column: 1,
        message: `the glossary defines ${label}, which no comment of the type core carries any more; remove its row`,
      });
  return findings;
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
    for (const [citation, pattern] of Object.entries(COUNTED_CITATIONS)) {
      const n = comment.text.match(pattern)?.length ?? 0;
      if (n > 0) counts[citation] = (counts[citation] ?? 0) + n;
    }
  return counts;
}

/** The anchors of `page`'s headings, as Markdown renderers make them: lower case, punctuation dropped, spaces as `-`. */
function recordAnchors(page) {
  return new Set(
    [...page.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map(([, heading]) =>
      heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/gu, "-"),
    ),
  );
}

/**
 * Each pointer at the accepted record in `text`'s comments whose anchor is no heading of the page it names, with its
 * line; `pages` maps a page's name to its text, and a pointer at the record's old single page names none.
 */
export function unresolvedPointers(fileName, text, pages) {
  const pointer = new RegExp(
    `${RECORD.replaceAll(".", "\\.")}(?:/([\\w-]+))?\\.md#([\\w-]+)`,
    "gu",
  );
  const found = [];
  for (const comment of fileComments(fileName, text))
    for (const [, page, anchor] of comment.text.matchAll(pointer))
      if (!(pages.has(page) && recordAnchors(pages.get(page)).has(anchor)))
        found.push({ line: comment.line, page, anchor });
  return found;
}

/**", "dist/**"] }),
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
  const pages = new Map(
    readdirSync(resolve(root, RECORD))
      .filter((name) => name.endsWith(".md"))
      .map((name) => [name.slice(0, -3), readFileSync(resolve(root, RECORD, name), "utf8")]),
  );
  const glossary = glossaryRows(pages.get("README") ?? "");
  const carried = [];
  const diagnostics = [];
  const used = new Set();
  const counted = {};
  for (const file of checkedFiles()) {
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
    for (const { line, page, anchor } of unresolvedPointers(file, text, pages))
      diagnostics.push({
        fileName: file,
        line,
        column: 1,
        message: `a comment points at ${RECORD}${page ? `/${page}` : ""}.md#${anchor}, which is no heading of that accepted-record page`,
      });
    if (file.startsWith(CORE))
      for (const found of labelsIn(file, text)) carried.push({ fileName: file, ...found });
    const counts = citationCounts(file, text);
    if (Object.keys(counts).length > 0) counted[file] = counts;
  }
  diagnostics.push(...glossaryFindings(carried, glossary));
  for (const [index, item] of allowed.entries())
    if (!used.has(index))
      diagnostics.push({
        fileName: "tools/oxlint/comment-forecasts-allowed.json",
        line: 1,
        column: 1,
        message: `${item.file}: the allowed forecast "${item.text}" is no longer found; remove its entry`,
      });
  for (const file of new Set([...Object.keys(recorded), ...Object.keys(counted)]))
    for (const citation of Object.keys(COUNTED_CITATIONS)) {
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
