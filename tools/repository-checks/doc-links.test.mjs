import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { brokenLinks, parseMarkdown } from "./doc-links.mjs";

const decoded = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

// GitHub's own links and heading anchors for each case, read from its rendering of the case at the commit and path
// `rendered` names (the contents API's `application/vnd.github.html`: each `<a href>` but heading permalinks and
// image wrappers, each `<img src>`, each `id="user-content-…"`). Both commits are on `archive/2015-doc-links-probes`.
const GITHUB = JSON.parse(
  readFileSync(new URL("./doc-links-github.json", import.meta.url), "utf8"),
);

test("each case's links and heading anchors are GitHub's", () => {
  for (const [name, { source, links, anchors }] of Object.entries(GITHUB.cases)) {
    const parsed = parseMarkdown(source);
    assert.deepEqual(parsed.links.map(({ href }) => decoded(href)).sort(), links, name);
    assert.deepEqual([...parsed.anchors].sort(), anchors, name);
    assert.deepEqual(parsed.refused, [], name);
  }
});

test("raw HTML that holds a link or an anchor is refused, other raw HTML passes", () => {
  const refused = (source) =>
    parseMarkdown(source).refused.map(({ line, message }) => `${line}: ${message}`);
  assert.deepEqual(refused("# Page\n\nText <a href=missing.md>bad</a>.\n"), [
    "3: the raw HTML '<a href=missing.md>' holds 'href', which this check does not resolve: write a Markdown link ('[text](path)'), image or heading instead",
  ]);
  for (const [html, held] of [
    ['<video src="v.mp4" controls></video>', "'src'"],
    ['<a name="n" id="i"></a>', "'name' and 'id'"],
    ["<img srcset='a.png 2x' alt=''>", "'srcset'"],
    ['<blockquote cite="c.md">q</blockquote>', "'cite'"],
  ])
    assert.match(refused(`${html}\n`)[0], new RegExp(`^1: the raw HTML .* holds ${held},`), html);
  for (const html of [
    "<a title=\" href='missing.md'\">text</a>",
    "<details open><summary>More</summary></details>",
    "Text with <file of entry numbers> in it.",
    "<!-- <a href=missing.md>bad</a> -->",
    "`<a href=missing.md>`",
    "Text.\n\n    <a href=missing.md>bad</a>",
  ])
    assert.deepEqual(refused(`${html}\n`), [], html);
});

/** A Git repository at a new folder holding `files` (path to text), none committed; its path. */
function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
  execFileSync("git", ["init", "-q", root]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// Each way to write a link, as a block of Markdown for destination `d` and case key `i`; the link is on its first line.
const FORMS = {
  inline: (d) => `See [the target](${d}) here.`,
  "inline with a title": (d) => `See [the target](${d} "Title") here.`,
  "inline in angle brackets": (d) => `See [the target](<${d}>) here.`,
  image: (d) => `![a picture](${d})`,
  "linked image": (d) => `[![a picture](picture.png)](${d})`,
  reference: (d, i) => `See [the target][r${i}].\n\n[r${i}]: <${d}>`,
  "reference in a quote": (d, i) => `> See [the target][q${i}].\n>\n> [q${i}]: <${d}>`,
  "reference in a list item": (d, i) => `- See [the target][l${i}].\n\n  [l${i}]: <${d}>`,
};
const MISSING =
  "which the repository does not hold: Git lists no such file or folder, in this case";
// Each kind of target, from `docs/page.md`: its destination, and the message it is reported with, or `null`.
const TARGETS = {
  "a file": ["other.md", null],
  "a file from the root": ["/README.md", null],
  "a folder": ["sub/", null],
  "a heading of another file": ["other.md#second-part", null],
  "a heading of this file": ["#page", null],
  "a heading of a folder's README": ["sub/#sub-folder", null],
  "a heading of a lowercase readme": ["lower/#lower-folder", null],
  "a heading of a .markdown file": ["guide.markdown#guide", null],
  "a line of a code file": ["../src/code.ts#L2", null],
  "lines of a code file": ["../src/code.ts#L1-L3", null],
  "a line of a source view": ["other.md?plain=1#L3", null],
  "a file in a dot folder": ["../.github/notes.md", null],
  "a name with a space": ["with space.md", null],
  "an external page": ["https://example.com/missing#nothing", null],
  "a missing file": ["missing.md", `the link 'missing.md' names 'docs/missing.md', ${MISSING}`],
  "a missing file from the root": [
    "/missing.md",
    `the link '/missing.md' names 'missing.md', ${MISSING}`,
  ],
  "a file in another case": ["Other.md", `the link 'Other.md' names 'docs/Other.md', ${MISSING}`],
  "an ignored file": [
    "node_modules/pkg/README.md",
    `the link 'node_modules/pkg/README.md' names 'docs/node_modules/pkg/README.md', ${MISSING}`,
  ],
  "a path outside the repository": [
    "../../outside.md",
    "the link '../../outside.md' leads outside the repository",
  ],
  "a missing heading": [
    "other.md#second-parts",
    "the link 'other.md#second-parts' names the anchor '#second-parts', which 'docs/other.md' has no heading for: the nearest it has is '#second-part'",
  ],
  "a missing heading of this file": [
    "#nowhere",
    "the link '#nowhere' names the anchor '#nowhere', which this file has no heading for",
  ],
  "a heading of a folder without a README": [
    "empty/#x",
    "the link 'empty/#x' names an anchor in the folder 'docs/empty', which has no Markdown README for GitHub to show",
  ],
  "a heading in a source view": [
    "other.md?plain=1#second-part",
    "the link 'other.md?plain=1#second-part' names the anchor '#second-part' in 'docs/other.md', a source view: only a line ('#L12') or lines ('#L12-L20') resolve there",
  ],
  "a line past the end": [
    "../src/code.ts#L9",
    "the link '../src/code.ts#L9' names line 9 of 'src/code.ts', which has 3 lines",
  ],
  "a heading of a code file": [
    "../src/code.ts#top",
    "the link '../src/code.ts#top' names the anchor '#top' in 'src/code.ts', which is no Markdown file: only a line ('#L12') or lines ('#L12-L20') resolve there",
  ],
};

test("every form of link, to every kind of target, resolves or is reported, in every Markdown file Git lists", () => {
  const cases = Object.entries(FORMS).flatMap(([form, write], f) =>
    Object.entries(TARGETS).map(([target, [destination, message]], t) => ({
      name: `${form} to ${target}`,
      block: write(destination, `${f}x${t}`),
      message,
    })),
  );
  // each block starts after the page's heading and a blank line, and after a blank line past the previous block
  let line = 3;
  for (const each of cases) {
    each.line = line;
    line += each.block.split("\n").length + 1;
  }
  const broken = "[bad](missing.md)\n";
  const root = repository({
    ".gitignore": "node_modules/\n",
    "README.md": "# Root\n",
    "docs/page.md": `# Page\n\n${cases.map(({ block }) => block).join("\n\n")}\n`,
    "docs/other.md": "# Other\n\n## Second part\n",
    "docs/sub/README.md": "# Sub folder\n",
    "docs/lower/readme.md": "# Lower folder\n",
    "docs/guide.markdown": "# Guide\n",
    "docs/with space.md": "# Spaced\n",
    "docs/picture.png": "",
    "docs/empty/file.txt": "",
    "docs/node_modules/pkg/README.md": `# Installed\n\n${broken}`,
    ".github/notes.md": `# Notes\n\n${broken}`,
    "docs/UPPER.MD": `# Upper\n\n${broken}`,
    "src/code.ts": "a\nb\nc\n",
    "outside.md": "",
  });
  try {
    const found = brokenLinks(root);
    const reported = new Map(
      found
        .filter(({ fileName }) => fileName === "docs/page.md")
        .map(({ line: at, message }) => [at, message]),
    );
    for (const { name, line: at, message } of cases)
      assert.equal(reported.get(at) ?? null, message, name);
    assert.equal(reported.size, cases.filter(({ message }) => message !== null).length);
    // a Markdown file in a dot folder or of an uppercase extension is read; an ignored one is not
    assert.deepEqual(
      found
        .filter(({ fileName }) => fileName !== "docs/page.md")
        .map(({ fileName, line: at }) => `${fileName}:${at}`),
      [".github/notes.md:3", "docs/UPPER.MD:3"],
    );
    // the coverage: every form with every target, once
    assert.equal(
      new Set(cases.map(({ name }) => name)).size,
      Object.keys(FORMS).length * Object.keys(TARGETS).length,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
