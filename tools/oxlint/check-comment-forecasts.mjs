import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkedFiles, fileComments } from "./comments.mjs";

// A comment says what the code does now and never forecasts later work (IMPLEMENTATION-AND-REVIEW.md "Code that does
// not mislead", #1977). Its comment rules read comments only, never strings or code, in the linted files and in `.vue`
// files' `<script>` blocks. A citation of a repository record matches no form: a bare `#N`, a completed stage, `PR N`,
// "(as) before #N". The old design record is not in the repository (#1977), so a reference to it is no citation: a
// line of any file Git lists, documents, strings and code included, that names it and then a revision or a section, on
// it or the next line, is refused (`citingLines`, #2372); a revision number written as `r4.N` names the accepted
// record's entry `r4-N`, so outside the record's own pages one with no such entry is refused (#2393); and the forms of `COUNTED_CITATIONS` have each file's exact count in comments in
// `comment-citations.json`, which may only fall. A comment that points at the accepted record
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

/** The old design record's name, as a whole word: no letter or digit on either side. */
const RECORD_NAME = /(?<![\p{L}\p{N}])TABLE(?![\p{L}\p{N}])/gu;

/** A revision or a section of that record: the whole word `r4`, or a section mark. */
const REVISION_OR_SECTION = /(?<![\p{L}\p{N}])r4(?![\p{L}\p{N}])|§/u;

/**
 * The lines of `text` that cite the old design record, each as its 0-based index and where its first name stands: a
 * line that holds the record's name and later a revision or a section, or whose next line holds one anywhere, a
 * citation wrapped over a line break. What stands between does not count, markup and words alike, so no spelling
 * between the two escapes. Its cost: a line that names the old record together with a revision or a section on it or
 * the next line is refused, in prose too. A citation over three or more lines, in another letter case, or inside a
 * longer word is outside this rule. One pass over the lines.
 */
function citingLines(text) {
  const lines = text.split("\n");
  const found = [];
  for (const [index, line] of lines.entries()) {
    const at = line.search(RECORD_NAME);
    // (from the name's second letter: a revision as a whole word cannot start inside it)
    if (
      at !== -1 &&
      (REVISION_OR_SECTION.test(line.slice(at + 1)) ||
        (index + 1 < lines.length && REVISION_OR_SECTION.test(lines[index + 1])))
    )
      found.push({ index, at, line });
  }
  return found;
}

/** The one file whose text holds such citations on purpose: this check's own test, whose fixtures must be ones. */
export const CITATION_FIXTURES = "tools/oxlint/check-comment-forecasts.test.mjs";

/** The citations whose count per file in comments may only shrink, each counted in a comment's text. */
const COUNTED_CITATIONS = {
  "bare r4.N": (text) => text.match(/\br4\.\d+/gu)?.length ?? 0,
  // (each occurrence of the record's name on a line that cites nothing; a citing line the text check refuses)
  "other TABLE": (text) => {
    const citing = new Set(citingLines(text).map(({ index }) => index));
    return text
      .split("\n")
      .reduce(
        (n, line, index) => (citing.has(index) ? n : n + (line.match(RECORD_NAME)?.length ?? 0)),
        0,
      );
  },
};

/** The accepted record's folder of pages, which a comment may point at by a page and a heading's anchor. */
const RECORD = "docs/specifications/type-inference-accepted-record";

/** The type core's modules, whose comments' labels the record's glossary defines. */
const CORE = "src/type-inference/core/";

/**
 * A port-plan or research label: a step, an id, a checkpoint, the plan or a plan document. A section number (`§3.2`,
 * `S3 §5`) is not a label; the glossary's one row for a bare `§N` is not checked against comments.
 */
const LABEL =
  /\b(?:S\d-[A-Z]+(?:-[A-Z]+)*|S\d{1,2}[a-z]?|[A-Z]{1,2}\d{1,3}[a-z]?|AD-\d|PLAN|checkpoint \d+)\b/gu;

/**
 * A reviewer, a round (`r2's`, `round 10`), a pull request (`#1422`), the owner's review or a step's review right
 * before an id makes it a review reference ("Codex r2's B1", "r1's and r2's B1", "#1027's B1", "the owner's reviewer's
 * F1", "the merged S6's B1"), not a label; an id further on ("#1027's B1, F12") or a decision ("the owner's D4") is one.
 */
const REVIEWED =
  /(?:(?:\b(?:Codex|Astra|Sol|Fable|Opus)(?:'s)?(?:\s+(?:recheck\s+)?(?:r\d+(?:[–-]r\d+)?|round \d+|reviews?|final))?(?:'s)?|\br\d+(?:'s)?|\bround \d+)\s+(?:[A-Z]{1,2}\d{1,3}[a-z]?(?:\/|, | and ))*|(?:#\d+(?:'s)?|\bowner's (?:reviewer's|review)|\bS\d{1,2}[a-z]?'s)\s+(?:[A-Z]{1,2}\d{1,3}[a-z]?(?:\/| and ))*|\b[A-Z]{1,2}\d{1,3}[a-z]?-)$/u;

/** A reviewer's review just after an id ("B1 of Astra's review") makes it a review reference too. */
const REVIEWED_AFTER = /^(?: of (?:Codex|Astra|Sol|Fable|Opus)'s review|-r\d)/u;

/** Labels that name a repository document, not the plan or the research. */
const DOCUMENTS = new Set(["V30"]);

/** Each label in `text`'s comments, with its line; review references and document names are not labels. */
export function labelsIn(fileName, text) {
  const found = [];
  for (const comment of fileComments(fileName, text))
    for (const match of comment.text.matchAll(LABEL)) {
      // a block comment's line breaks and leading `*` or `//` read as one space
      const before = comment.text
        .slice(Math.max(0, match.index - 60), match.index)
        .replace(/\s*\n\s*(?:\*(?!\/)|\/\/)?\s*/gu, " ");
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
    for (const [citation, count] of Object.entries(COUNTED_CITATIONS)) {
      const n = count(comment.text);
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

/** A revision number written in text: `r4.` and its digits as a whole token, naming the accepted record's entry `r4-N`. */
const REVISION_NUMBER = /(?<![\p{L}\p{N}.])r4\.(\d+)(?!\p{N})/gu;

/** The accepted record's entries by number: each page's `### r4-N` heading; `pages` maps a page's name to its text. */
export function recordEntries(pages) {
  const numbers = new Set();
  for (const page of pages.values())
    for (const [, number] of page.matchAll(/^### r4-(\d+)$/gmu)) numbers.add(number);
  return numbers;
}

/**
 * Each revision number in `text`, the whole of file `fileName`, that names no entry of `entries`, with its line. Each
 * end of a range is a number of its own. The record's own pages, which name revisions an entry superseded, and the
 * lint's test are outside the rule; it proves that the entry exists, not that it carries the claim.
 */
export function unresolvedRevisionsIn(fileName, text, entries) {
  if (fileName === CITATION_FIXTURES || fileName.startsWith(`${RECORD}/`)) return [];
  const found = [];
  let line = 1;
  let counted = 0;
  for (const match of text.matchAll(REVISION_NUMBER)) {
    if (entries.has(match[1])) continue;
    for (
      let at = text.indexOf("\n", counted);
      at !== -1 && at < match.index;
      at = text.indexOf("\n", at + 1)
    )
      line += 1;
    counted = match.index;
    found.push({ line, number: match[1] });
  }
  return found;
}

/**
 * Each line of `text`, the whole of file `fileName`, that cites the old design record (`citingLines`), with its
 * 1-based line and its text from the record's name.
 */
export function tableCitationsIn(fileName, text) {
  if (fileName === CITATION_FIXTURES || !text.includes("TABLE")) return [];
  return citingLines(text).map(({ index, at, line }) => ({
    line: index + 1,
    text: line.slice(at).trim(),
  }));
}

/**
 * Each citation of the old design record and each revision number with no entry (`unresolvedRevisionsIn`, against
 * `pages`, the accepted record's pages by name) in the files Git lists in `root` (tracked, and untracked but not
 * ignored) that are regular files, as `doc-links.mjs` reads them, as diagnostics; a file with a NUL byte is binary and is not
 * read as text. A name is decoded whole, a leading byte order mark kept; a failed `git` throws, and so does a listed
 * name that is not UTF-8, which could not be read unchanged.
 */
export function listedTextFindings(root, pages) {
  const entries = recordEntries(pages);
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { cwd: root, maxBuffer: 1 << 28 },
  );
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const findings = [];
  for (let start = 0, end; (end = listing.indexOf(0, start)) !== -1; start = end + 1) {
    const bytes = listing.subarray(start, end);
    let file;
    try {
      file = utf8.decode(bytes);
    } catch {
      throw new Error(
        `git lists a file whose name is not UTF-8 (${JSON.stringify(bytes.toString("latin1"))}): rename it, so the citation checks can read it`,
      );
    }
    if (!lstatSync(resolve(root, file), { throwIfNoEntry: false })?.isFile()) continue;
    const text = readFileSync(resolve(root, file), "utf8");
    if (text.includes("\0")) continue;
    for (const { line, text: citation } of tableCitationsIn(file, text))
      findings.push({
        fileName: file,
        line,
        column: 1,
        message: `"${citation.length > 60 ? `${citation.slice(0, 60)}…` : citation}": a line that names the old design record and then a revision or a section of it cites a record that is not in the repository; state the fact, or point at the accepted record, an issue or a merged pull request, and in prose about the old record keep any revision or section off its line and the next`,
      });
    for (const { line, number } of unresolvedRevisionsIn(file, text, entries))
      findings.push({
        fileName: file,
        line,
        column: 1,
        message: `revision ${number} names no entry of the accepted record (${RECORD}, headings r4-N): state the fact, or point at an entry, an issue or a merged pull request`,
      });
  }
  return findings;
}

/**
 * Every forecast not in the allowlist, every allowlist entry no longer found, every file whose citation counts
 * differ from `comment-citations.json`'s, and every citation of the old design record or revision number with no
 * entry in a file Git lists, as diagnostics.
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
  diagnostics.push(...listedTextFindings(root, pages));
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
