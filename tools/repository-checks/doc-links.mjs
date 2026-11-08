import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";

// Checks the relative links and heading anchors in the repository's Markdown, parsed as CommonMark by `markdown-it`,
// with GitHub's slugs (`github-slugger`); raw-HTML links and ids are refused. One line per broken link (`npm run
// check:doc-links`, part of `check:pretest`):
//
//   node tools/repository-checks/doc-links.mjs
//
// - Files: the repository's files as Git lists them (tracked, and untracked but not ignored); its Markdown files are
//   those ending `.md`, `.markdown`, `.mdown` or `.mkdn`, in any case.
// - Links: every link and image the parser makes, references resolved, outside code, HTML blocks and a leading YAML
//   front matter block (which GitHub renders as a table). A destination with a scheme (`https:`, `mailto:`) or `//` is
//   external and not checked, an absolute URL to this repository included; links in source comments are not read.
// - Paths: relative to the linking file, or to the root when they start with `/`. They must name a file or folder Git
//   lists, with exactly that case, inside the repository.
// - Anchors: in a Markdown file, one of its headings' slugs; in a folder, those of the Markdown README GitHub shows
//   there (a `readme` of a Markdown extension, any case); in any other file, or with `?plain=1` (GitHub's source view),
//   a line or line range it has (`#L12`, `#L12-L20`).
// - Raw HTML: of a raw tag's attributes GitHub keeps only some, and of those `REFUSED_ATTRIBUTES` can hold a link or an
//   anchor, which this check does not resolve; a tag with one is refused, its fix a Markdown link, image or heading.
//
// The parser is CommonMark, plus the tables and strikethrough `markdown-it` has by default; its known differences from
// GitHub's cmark-gfm are listed in #2015. Exit status: 1 when a link is broken, else 0.
//
// Dependencies (`AGENTS.md`): `markdown-it` (MIT, CommonMark; it adds mdurl, uc.micro, linkify-it, punycode.js,
// argparse and its own entities 8, beside the lockfile's 7) and `github-slugger` (ISC, no dependencies), dev-only
// and pinned exactly. They read the docs in checks and CI and reach no bundle. The alternatives were micromark with
// its GFM extension (exact GFM, about 25 packages) and a hand-written scanner (#2015's first version, which a review
// found right only for the forms the docs used: nine families of others failed open or closed). An upgrade reruns the
// test, whose expected anchors and links are GitHub's own rendering.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const MARKDOWN = /\.(?:md|markdown|mdown|mkdn)$/iu;
const README = /^readme\.(?:md|markdown|mdown|mkdn)$/iu;

/** The raw-HTML attributes GitHub keeps that hold a link (`href`, `src`, …) or an anchor (`id`, `name`). */
const REFUSED_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "longdesc",
  "cite",
  "poster",
  "id",
  "name",
]);

const markdownIt = new MarkdownIt({ html: true });

/** The text a heading's inline tokens render, as the browser's text content: tags and images add none. */
function renderedText(children) {
  return children
    .map((token) =>
      token.type === "text" || token.type === "code_inline"
        ? token.content
        : token.type === "softbreak" || token.type === "hardbreak"
          ? "\n"
          : "",
    )
    .join("");
}

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gu;
const START_TAG =
  /<([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/gu;

/** Each start tag in raw HTML outside its comments, with its attributes' names (lowercase); a quoted value is read whole. */
function startTags(html) {
  return [...html.replace(/<!--[\s\S]*?(?:-->|$)/gu, "").matchAll(START_TAG)].map((tag) => ({
    text: tag[0],
    attributes: [...tag[2].matchAll(ATTRIBUTE)].map((attribute) => attribute[1].toLowerCase()),
  }));
}

/**
 * `source` with a leading YAML front matter block (`---` on its first line, to the next `---` or `...` line) blanked,
 * its lines kept: GitHub renders that block as a table, with no headings or links.
 */
function withoutFrontMatter(source) {
  const lines = source.split("\n");
  if (lines[0] !== "---") return source;
  const end = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
  if (end === -1) return source;
  return lines.map((line, index) => (index <= end ? "" : line)).join("\n");
}

/**
 * A Markdown `source`'s links (`{ href, line }`, `href` as the parser normalised it), its headings' anchors, and its
 * refused raw-HTML tags (`{ line, message }`); lines from 1.
 */
export function parseMarkdown(source) {
  const tokens = markdownIt.parse(withoutFrontMatter(source), {});
  const slugger = new GithubSlugger();
  const links = [];
  const anchors = new Set();
  const refused = [];
  const refuse = (html, line) => {
    for (const { text, attributes } of startTags(html)) {
      const held = [...new Set(attributes.filter((name) => REFUSED_ATTRIBUTES.has(name)))];
      if (held.length > 0)
        refused.push({
          line,
          message: `the raw HTML '${text.length > 60 ? `${text.slice(0, 57)}…` : text}' holds ${held.map((name) => `'${name}'`).join(" and ")}, which this check does not resolve: write a Markdown link ('[text](path)'), image or heading instead`,
        });
    }
  };
  for (const [index, token] of tokens.entries()) {
    const start = (token.map?.[0] ?? 0) + 1;
    if (token.type === "html_block") refuse(token.content, start);
    if (token.type === "heading_open")
      anchors.add(slugger.slug(renderedText(tokens[index + 1].children)));
    if (token.type !== "inline") continue;
    let line = start;
    for (const child of token.children) {
      if (child.type === "link_open") links.push({ href: child.attrGet("href"), line });
      if (child.type === "image") links.push({ href: child.attrGet("src"), line });
      if (child.type === "html_inline") refuse(child.content, line);
      if (child.type === "softbreak" || child.type === "hardbreak") line += 1;
      else line += (child.content.match(/\n/gu) ?? []).length;
    }
  }
  return { links, anchors, refused };
}

const decoded = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** The files Git lists at `root` (tracked, and untracked but not ignored), relative and `/`-separated. */
function repositoryFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file !== "");
}

/** The anchor nearest to `wanted` by edit distance, when it is near enough to be a likely meaning. */
function nearest(wanted, candidates) {
  let best = null;
  let bound = Math.max(2, Math.floor(wanted.length / 4)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, candidate, bound);
    if (distance < bound) [best, bound] = [candidate, distance];
  }
  return best;
}

function editDistance(a, b, bound) {
  if (Math.abs(a.length - b.length) >= bound) return bound;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

/** The broken links and refused raw HTML of the repository at `root`, each `{ fileName, line, message }`. */
export function brokenLinks(root) {
  const files = repositoryFiles(root);
  const listed = new Set(files);
  const folders = new Set([""]);
  for (const file of files)
    for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1))
      folders.add(file.slice(0, at));
  const parsed = new Map();
  const read = (file) => readFileSync(`${root}/${file}`, "utf8");
  const parsedOf = (file) => {
    if (!parsed.has(file)) parsed.set(file, parseMarkdown(read(file)));
    return parsed.get(file);
  };

  const broken = [];
  for (const file of files.filter((path) => MARKDOWN.test(path)).sort()) {
    const { links, refused } = parsedOf(file);
    for (const { line, message } of refused) broken.push({ fileName: file, line, message });
    for (const { href, line } of links) {
      const report = (message) => broken.push({ fileName: file, line, message });
      const shown = decoded(href);
      if (href === "" || /^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("//")) continue;
      const hash = href.indexOf("#");
      const [pathPart, query = ""] = (hash === -1 ? href : href.slice(0, hash)).split("?");
      const fragment = hash === -1 ? "" : decoded(href.slice(hash + 1));
      const sourceView = /(?:^|&)plain=1(?:&|$)/u.test(query);
      let target = file;
      if (pathPart !== "") {
        const path = decoded(pathPart);
        const joined = posix.normalize(
          path.startsWith("/") ? `.${path}` : posix.join(posix.dirname(file), path),
        );
        const inside = joined === "." || joined === "./" ? "" : joined.replace(/\/$/u, "");
        if (inside === ".." || inside.startsWith("../")) {
          report(`the link '${shown}' leads outside the repository`);
          continue;
        }
        if (!listed.has(inside) && !folders.has(inside)) {
          report(
            `the link '${shown}' names '${inside}', which the repository does not hold: Git lists no such file or folder, in this case`,
          );
          continue;
        }
        target = inside;
      }
      if (fragment === "") continue;
      let shownFile = target;
      if (folders.has(target)) {
        const readme = files
          .filter(
            (path) =>
              posix.dirname(path) === (target === "" ? "." : target) &&
              README.test(posix.basename(path)),
          )
          .sort()[0];
        if (readme === undefined) {
          report(
            `the link '${shown}' names an anchor in the folder '${target || "."}', which has no Markdown README for GitHub to show`,
          );
          continue;
        }
        shownFile = readme;
      }
      if (MARKDOWN.test(shownFile) && !sourceView) {
        const { anchors } = parsedOf(shownFile);
        if (anchors.has(fragment)) continue;
        const near = nearest(fragment, anchors);
        report(
          `the link '${shown}' names the anchor '#${fragment}', which ${shownFile === file ? "this file" : `'${shownFile}'`} has no heading for` +
            (near === null ? "" : `: the nearest it has is '#${near}'`),
        );
        continue;
      }
      const lines = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/u.exec(fragment);
      if (lines === null) {
        report(
          `the link '${shown}' names the anchor '#${fragment}' in '${shownFile}', ${sourceView ? "a source view" : "which is no Markdown file"}: only a line ('#L12') or lines ('#L12-L20') resolve there`,
        );
        continue;
      }
      const text = read(shownFile);
      const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const outside = [lines[1], lines[2]].map(Number).find((n) => n < 1 || n > count);
      if (outside !== undefined)
        report(
          `the link '${shown}' names line ${outside} of '${shownFile}', which has ${count} lines`,
        );
    }
  }
  return broken;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const broken = brokenLinks(repositoryRoot);
  for (const { fileName, line, message } of broken)
    console.error(`${fileName}:${line}: ${message}`);
  if (broken.length > 0) {
    console.error(`check:doc-links: ${broken.length} findings`);
    process.exitCode = 1;
  }
}
