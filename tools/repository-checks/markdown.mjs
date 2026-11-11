import { remark } from "remark";
import remarkGfm from "remark-gfm";

// How the repository's checks read Markdown: remark with GitHub's extensions (remark-gfm), the one configuration the
// doc-links check validates headings and links with and the citation lint reads the accepted record's entry headings
// with, so a heading one resolves is one the other finds.

/** The plugins every Markdown reading of the checks uses, before any check's own. */
export const MARKDOWN_PLUGINS = [remarkGfm];

/** A remark processor with `MARKDOWN_PLUGINS`, whose `parse` gives a page's syntax tree. */
export function markdownProcessor() {
  return remark().use(MARKDOWN_PLUGINS);
}
