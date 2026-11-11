import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { headingAnchors, headingText, markdownProcessor } from "../repository-checks/markdown.mjs";
import { checkedFiles, fileComments } from "./comments.mjs";

// A comment says what the code does now and never forecasts later work (IMPLEMENTATION-AND-REVIEW.md "Code that does
// not mislead", #1977). Its comment rules read comments only, never strings or code, in the linted files and in `.vue`
// files' `<script>` blocks. A citation of a repository record matches no form: a bare `#N`, a completed stage, `PR N`,
// "(as) before #N". The old design record is not in the repository (#1977), so a reference to it is no citation: a
// line of any file Git lists, documents, strings and code included, that names it and then a revision or a section, on
// it or the next line, is refused (`citingLines`, #2372); a revision number written as `r4.N` names the accepted
// record's entry `r4-N`, so outside the record's own pages one with no such entry is refused (#2393); a section number
// stands right after a document's name, outside the paths `outsideSectionRule` names (`unnamedSectionsIn`, #2404); and
// the forms of `COUNTED_CITATIONS` have each file's exact count in comments in `comment-citations.json`, which may only
// fall. A comment that points at the accepted record
// (`docs/specifications/type-inference-accepted-record/<page>.md#<anchor>`, #2089) names an anchor of a record page
// Git lists, read and slugged as the doc-links check reads them (#2422); that check reads Markdown only and never sees
// a comment. A label of the port plan or the research design (`S8c`,
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
  // (the revision rule's own token, so the lint has one reading of a revision number)
  "bare r4.N": (text) => text.match(REVISION_NUMBER)?.length ?? 0,
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
 * A port-plan or research label: a step, an id, a checkpoint, the plan or a plan document. A section number (`V30 §3`,
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

/**
 * Each record page's anchors by its path under the record's folder (`sharing.md`, `nested/entry.markdown`): `pages`
 * maps that path to the page's text, read as the doc-links check reads it (`headingAnchors`).
 */
export function recordAnchors(pages) {
  const markdown = markdownProcessor();
  return new Map([...pages].map(([page, text]) => [page, headingAnchors(markdown.parse(text))]));
}

/**
 * Each pointer at the accepted record in `text`'s comments whose anchor is none of the page it names, with its line;
 * `anchors` maps a page's path under the record's folder to its anchors (`recordAnchors`). A pointer names its page by
 * that path, nested folders and either extension included; a pointer at the record's old single page names none. A
 * mention of the record in another form (its folder, a page without an anchor) is not read.
 */
export function unresolvedPointers(fileName, text, anchors) {
  const pointer = new RegExp(
    `${RECORD.replaceAll(".", "\\.")}(?:/([\\w-]+(?:/[\\w-]+)*\\.(?:md|markdown))|\\.md)#([\\w-]+)`,
    "gu",
  );
  const found = [];
  for (const comment of fileComments(fileName, text))
    for (const [, page, anchor] of comment.text.matchAll(pointer))
      if (!anchors.get(page)?.has(anchor)) found.push({ line: comment.line, page, anchor });
  return found;
}

/** A revision number in text: `r4.` and its digits as a whole token, naming the accepted record's entry `r4-N`. */
const REVISION_NUMBER = /(?<![\p{L}\p{N}.])r4\.(\d+)(?!\p{N})/gu;

/** Whether `file` is one of the accepted record's pages: a Markdown file anywhere in its folder. */
const isRecordPage = (file) => file.startsWith(`${RECORD}/`) && /\.(?:md|markdown)$/u.test(file);

/**
 * The accepted record's entries by number: each level-3 heading whose text is `r4-N`, as the repository's Markdown
 * reading (`markdownProcessor` and `headingText`, the doc-links check's own) parses the pages, so a heading's trailing
 * spaces count as nothing, a line in a code block is none, and GitHub's inline marks and inline HTML around the text
 * are read through; `pages` holds the pages' texts.
 */
export function recordEntries(pages) {
  const numbers = new Set();
  const visit = (node) => {
    const entry =
      node.type === "heading" && node.depth === 3 && /^r4-(\d+)$/u.exec(headingText(node));
    if (entry) numbers.add(entry[1]);
    for (const child of node.children ?? []) visit(child);
  };
  const markdown = markdownProcessor();
  for (const page of pages) visit(markdown.parse(page));
  return numbers;
}

/**
 * A range's short second end right after a revision number (the `–66` after a number 63): a dash, then digits that
 * no letter, digit or `.` and digit follows. A spaced dash or `to` makes no range.
 */
const SHORT_END = /[–-](\d+)(?![\p{L}\p{N}]|\.\p{N})/uy;

/**
 * Each revision number in `text`, the whole of file `fileName`, that names no entry of `entries`, with its line. Each
 * end of a range is a number of its own, a short second end (`SHORT_END`) included. The record's own pages, which name revisions an entry superseded, and the
 * lint's test are outside the rule; it proves that the entry exists, not that it carries the claim.
 */
export function unresolvedRevisionsIn(fileName, text, entries) {
  if (fileName === CITATION_FIXTURES || isRecordPage(fileName)) return [];
  const found = [];
  let line = 1;
  let counted = 0;
  for (const match of text.matchAll(REVISION_NUMBER)) {
    // (read from the number's end in the whole text, so the end's digits and the edge after them are its own)
    SHORT_END.lastIndex = match.index + match[0].length;
    const short = SHORT_END.exec(text);
    const missing = [match[1], short?.[1]].filter(
      (number) => number !== undefined && !entries.has(number),
    );
    if (missing.length === 0) continue;
    for (
      let at = text.indexOf("\n", counted);
      at !== -1 && at < match.index;
      at = text.indexOf("\n", at + 1)
    )
      line += 1;
    counted = match.index;
    for (const number of missing) found.push({ line, number });
  }
  return found;
}

/**
 * A section number: `§` or `§§`, then spaces or tabs, then a digit; a `§` before anything else (a test source's
 * cursor mark) is none. The one reading of a section number, for `unnamedSectionsIn`, which any other count of them
 * calls. The old record's rule reads a wider set on purpose (`REVISION_OR_SECTION`: any `§` beside its name), so a
 * line that names the old record and then a section number gets a finding from each rule.
 */
const SECTION_NUMBER = /§§?[ \t]*[0-9]/gu;

/**
 * The section lists a section number may stand in, a closed set: a document's name, one space, `§` or `§§` and a
 * whole number (dotted parts, a letter, a range), then any further `, §N`, ` and §N`, `, and §N` or ` or §N`, on one
 * line.
 * `V30` and `ADR NNNN` are repository documents. `PLAN`, `S3` and `S6-CARRIERS` name the port plan's documents
 * outside the repository; they are allowed as labels, which #2423 decides, not as citations.
 */
const NAMED_SECTIONS = (() => {
  // (a number ends where no letter or digit follows, and no `.`, `–` or `-` before a digit)
  const number = String.raw`\d+(?:\.\d+)*[a-z]?(?:[–-]\d+(?:\.\d+)*[a-z]?)?(?![\p{L}\p{N}]|[.–-]\p{N})`;
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:V30|ADR \d{4}|PLAN|S3|S6-CARRIERS) §§?${number}(?:(?:, | and |, and | or )§${number})*`,
    "gu",
  );
})();

/**
 * The files outside the section rule: documents, whose bare section numbers name their own sections; `src/`, whose
 * comments #2209 rewrites; the expectation set's cell ids inside recorded data whose bytes `MANIFEST.md` fixes; the
 * waiting list, which quotes comments word for word and whose section numbers are all in quotes of `src/`; and this
 * lint's test.
 */
const outsideSectionRule = (file) =>
  file.startsWith("docs/") ||
  file.startsWith("src/") ||
  file === "tests/fixtures/type-core/cells.jsonl" ||
  file === "tools/oxlint/comment-declarations-waiting.json" ||
  file === CITATION_FIXTURES;

/**
 * Each section number in `text`, the whole of file `fileName`, that stands in no section list after a document's
 * name (`NAMED_SECTIONS`), with its line and the number as written. It proves the form, not that the section exists
 * or carries the sentence's claim.
 */
export function unnamedSectionsIn(fileName, text) {
  if (outsideSectionRule(fileName) || !text.includes("§")) return [];
  const named = new Set();
  for (const list of text.matchAll(NAMED_SECTIONS))
    for (const mark of list[0].matchAll(/§§?/gu)) named.add(list.index + mark.index);
  const found = [];
  let line = 1;
  let counted = 0;
  for (const match of text.matchAll(SECTION_NUMBER)) {
    if (named.has(match.index)) continue;
    for (
      let at = text.indexOf("\n", counted);
      at !== -1 && at < match.index;
      at = text.indexOf("\n", at + 1)
    )
      line += 1;
    counted = match.index;
    found.push({
      line,
      section: /§§?[ \t]*[\d.]*\d/uy.exec(text.slice(match.index))[0].replace(/[ \t]+/gu, " "),
    });
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
 * The files Git lists in `root` (tracked, and untracked but not ignored) that are regular files, as `doc-links.mjs`
 * reads them. A name is decoded whole, a leading byte order mark kept; a failed `git` throws, and so does a listed name
 * that is not UTF-8, which could not be read unchanged.
 */
export function listedFiles(root) {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { cwd: root, maxBuffer: 1 << 28 },
  );
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files = [];
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
    if (lstatSync(resolve(root, file), { throwIfNoEntry: false })?.isFile()) files.push(file);
  }
  return files;
}

/**
 * Each citation of the old design record, each revision number with no entry (`unresolvedRevisionsIn`, against the
 * entries of every record page Git lists) and each section number outside a section list (`unnamedSectionsIn`) in
 * `files`, by default `listedFiles(root)`, as diagnostics. A file with a NUL byte is binary: the revision rule reads
 * it too, the other two do not.
 */
export function listedTextFindings(root, files = listedFiles(root)) {
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const entries = recordEntries(files.filter(isRecordPage).map(read));
  const findings = [];
  for (const file of files) {
    const text = read(file);
    for (const { line, number } of unresolvedRevisionsIn(file, text, entries))
      findings.push({
        fileName: file,
        line,
        column: 1,
        message: `revision ${number} names no entry of the accepted record (${RECORD}, headings r4-N): state the fact, or point at an entry, an issue or a merged pull request`,
      });
    if (text.includes("\0")) continue;
    for (const { line, text: citation } of tableCitationsIn(file, text))
      findings.push({
        fileName: file,
        line,
        column: 1,
        message: `"${citation.length > 60 ? `${citation.slice(0, 60)}…` : citation}": a line that names the old design record and then a revision or a section of it cites a record that is not in the repository; state the fact, or point at the accepted record, an issue or a merged pull request, and in prose about the old record keep any revision or section off its line and the next`,
      });
    for (const { line, section } of unnamedSectionsIn(file, text))
      findings.push({
        fileName: file,
        line,
        column: 1,
        message: `"${section}": a section number without a repository document's name right before it (written "V30 §N" or "ADR NNNN §N") names a document outside the repository; state the fact, write the name before it, or point at the accepted record, an issue or a merged pull request`,
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
  const files = listedFiles(root);
  const pages = new Map(
    files
      .filter(isRecordPage)
      .map((file) => [file.slice(RECORD.length + 1), readFileSync(resolve(root, file), "utf8")]),
  );
  const anchors = recordAnchors(pages);
  const glossary = glossaryRows(pages.get("README.md") ?? "");
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
    for (const { line, page, anchor } of unresolvedPointers(file, text, anchors))
      diagnostics.push({
        fileName: file,
        line,
        column: 1,
        message: `a comment points at ${RECORD}${page ? `/${page}` : ".md"}#${anchor}, which is no anchor of an accepted-record page Git lists`,
      });
    if (file.startsWith(CORE))
      for (const found of labelsIn(file, text)) carried.push({ fileName: file, ...found });
    const counts = citationCounts(file, text);
    if (Object.keys(counts).length > 0) counted[file] = counts;
  }
  diagnostics.push(...glossaryFindings(carried, glossary));
  diagnostics.push(...listedTextFindings(root, files));
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
