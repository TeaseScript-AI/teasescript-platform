import { remark } from "remark";
import remarkGfm from "remark-gfm";

// How the repository's checks read Markdown: remark with GitHub's extensions (remark-gfm), the one configuration the
// doc-links check validates headings and links with and the citation lint reads the accepted record's entry headings
// with, and a heading's text as the doc-links check's validator takes it for the anchor, so a heading one resolves is
// one the other finds.

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
