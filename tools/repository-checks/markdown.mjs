import GithubSlugger from "github-slugger";
import { remark } from "remark";
import remarkGfm from "remark-gfm";

// How the repository's checks read Markdown: remark with GitHub's extensions (remark-gfm), the one configuration the
// doc-links check validates headings and links with and the citation lint reads the accepted record's entry headings
// with, a heading's text as the doc-links check's validator takes it for the anchor, and a page's anchors as that
// validator slugs them, so a heading or an anchor one resolves is one the other finds.

/** The plugins every Markdown reading of the checks uses, before any check's own. */
export const MARKDOWN_PLUGINS = [remarkGfm];

/** A remark processor with `MARKDOWN_PLUGINS`, whose `parse` gives a page's syntax tree. */
export function markdownProcessor() {
  return remark().use(MARKDOWN_PLUGINS);
}

/**
 * A heading's text as remark-validate-links reads it for the heading's anchor (`toString(node, {includeHtml: false,
 * includeImageAlt: false})`): every value below the node, HTML and images left out.
 */
export function headingText(node) {
  if (node.type === "html") return "";
  return node.value ?? (node.children ?? []).map(headingText).join("");
}

/**
 * A page's headings in document order, each with its anchor as remark-validate-links makes it (`lib/index.js`, its
 * heading ids): slugged by `github-slugger` from `headingText`, one slugger per page, so a repeated heading's anchor
 * takes `-1`, `-2`. `tree` is the page's syntax tree from `markdownProcessor().parse`.
 */
export function anchoredHeadings(tree) {
  const slugger = new GithubSlugger();
  const headings = [];
  const visit = (node) => {
    if (node.type === "heading") headings.push({ node, anchor: slugger.slug(headingText(node)) });
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return headings;
}

/** The anchors of a page's headings (`anchoredHeadings`). */
export function headingAnchors(tree) {
  return new Set(anchoredHeadings(tree).map(({ anchor }) => anchor));
}
