import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { anchors, brokenLinks, links } from "./doc-links.mjs";

/** A repository folder holding `files` (path to text); its path. */
function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// GitHub's anchors for these headings, read from its rendering of this text at commit 3dcc8844f (the contents API's
// `application/vnd.github.html`, each `id="user-content-…"`)
const HEADINGS = `# Slug probe

## A – B

## Don't stop: \`npm run check:pretest\`

## snake_case and _emphasis_ **bold** *it*

## [Link](x.md) &amp; Ünïcode

## Same

## Same

## Same 1

Setext two
----------

Setext one
==========

# Trailing ###

## Ends with emoji 🎉

## Under\\_score esc

## \`code_with_under\` and \`a  b\`

## <code>html</code> tag & more

## 1. Numbered (part) [x] {y} ~z~ ^w^ "q" a/b a.b a,b a;b a=b a?b a!b a@b a$b a%b a+b

## __double__ and ***triple*** and ~~strike~~

> ## Quoted heading

## Tab\tinside

##    Spaced   out

   ## Indented three

## Ünicode – Stripe — ‘curly’ “quotes” … ©®

<a id="custom-id"></a>
<a name="named"></a>
`;
const GITHUB_ANCHORS = [
  "slug-probe",
  "a--b",
  "dont-stop-npm-run-checkpretest",
  "snake_case-and-emphasis-bold-it",
  "link--ünïcode",
  "same",
  "same-1",
  "same-1-1",
  "setext-two",
  "setext-one",
  "trailing",
  "ends-with-emoji-",
  "under_score-esc",
  "code_with_under-and-a--b",
  "html-tag--more",
  "1-numbered-part-x-y-z-w-q-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab",
  "double-and-triple-and-strike",
  "quoted-heading",
  "tabinside",
  "spaced---out",
  "indented-three",
  "ünicode--stripe--curly-quotes--",
  "custom-id",
  "named",
];

test("a file's anchors are GitHub's: heading slugs, repeats numbered, HTML ids and names", () => {
  assert.deepEqual([...anchors(HEADINGS)].sort(), [...GITHUB_ANCHORS].sort());
});

test("a heading, link or id inside code or an HTML comment is none, and a footnote is no link", () => {
  const source = [
    "```md",
    "## Fenced",
    "[a](missing.md)",
    "```",
    "~~~",
    '<a id="tilde"></a> [b](missing.md)',
    "~~~",
    "Text `[c](missing.md)` and ``[d](missing.md) ` `` and <!-- [e](missing.md)",
    "## Commented -->",
    "",
    "[^1]: A footnote, whose text is no destination.",
    "",
  ].join("\n");
  assert.deepEqual([...anchors(source)], []);
  assert.deepEqual(links(source), []);
});

// Each way to write a link; `{}` is where its destination goes.
const FORMS = {
  inline: "See [the target]({}) here.",
  "inline with a title": 'See [the target]({} "Title") here.',
  "inline in angle brackets": "See [the target](<{}>) here.",
  image: "![a picture]({})",
  "linked image": "[![a picture](picture.png)]({})",
  "reference definition": "[target]: {}",
  "HTML href": '<a href="{}">the target</a>',
  "HTML src": '<img src="{}" alt="">',
};
// Each kind of target, from `docs/page.md`: its destination, and the start of the message it is reported with, or
// `null` when it resolves.
const TARGETS = {
  "a file": ["other.md", null],
  "a file from the root": ["/README.md", null],
  "a folder": ["sub/", null],
  "a heading of another file": ["other.md#second-part", null],
  "a heading of this file": ["#page", null],
  "a heading of a folder's README": ["sub/#sub-folder", null],
  "a line of a code file": ["../src/code.ts#L2", null],
  "lines of a code file": ["../src/code.ts#L1-L3", null],
  "an external page": ["https://example.com/missing#nothing", null],
  "a missing file": [
    "missing.md",
    "the link 'missing.md' names 'docs/missing.md', which does not exist",
  ],
  "a file in another case": [
    "Other.md",
    "the link 'Other.md' names 'docs/Other.md', which does not exist",
  ],
  "a path outside the repository": [
    "../../outside.md",
    "the link '../../outside.md' leads outside the repository",
  ],
  "a generated folder": [
    "../dist/page.html",
    "the link '../dist/page.html' names 'dist/page.html', which the repository does not hold",
  ],
  "a missing heading": [
    "other.md#second-parts",
    "the link 'other.md#second-parts' names the anchor '#second-parts', which 'docs/other.md' does not have: the nearest it has is '#second-part'",
  ],
  "a missing heading of this file": [
    "#nowhere",
    "the link '#nowhere' names the anchor '#nowhere', which this file does not have",
  ],
  "a heading of a folder without a README": [
    "empty/#x",
    "the link 'empty/#x' names an anchor in 'docs/empty', a folder without a README.md",
  ],
  "a line past the end": [
    "../src/code.ts#L9",
    "the link '../src/code.ts#L9' names line 9 of 'src/code.ts', which has 3 lines",
  ],
  "a heading of a code file": [
    "../src/code.ts#top",
    "the link '../src/code.ts#top' names the anchor '#top' in 'src/code.ts', which is no Markdown file",
  ],
};

test("every form of link, to every kind of target, resolves or is reported", () => {
  const cases = Object.entries(FORMS).flatMap(([form, template]) =>
    Object.entries(TARGETS).map(([target, [destination, message]]) => ({
      name: `${form} to ${target}`,
      line: template.replace("{}", destination),
      message,
    })),
  );
  const root = repository({
    "README.md": "# Root\n",
    "docs/page.md": `# Page\n\n${cases.map(({ line }) => line).join("\n\n")}\n`,
    "docs/other.md": "# Other\n\n## Second part\n",
    "docs/sub/README.md": "# Sub folder\n",
    "docs/picture.png": "",
    "docs/empty/file.txt": "",
    "src/code.ts": "a\nb\nc\n",
    "outside.md": "",
  });
  try {
    const broken = brokenLinks(root, ["docs/page.md"]);
    // a case's line: the heading and a blank line, then each case followed by a blank line
    const reported = new Map(broken.map(({ line, message }) => [line, message]));
    for (const [index, { name, message }] of cases.entries()) {
      const got = reported.get(3 + 2 * index) ?? null;
      if (message === null) assert.equal(got, null, name);
      else assert.ok(got?.startsWith(message), `${name}: ${got}`);
    }
    assert.equal(broken.length, cases.filter(({ message }) => message !== null).length);
    // the coverage: every form with every target
    assert.deepEqual(
      new Set(cases.map(({ name }) => name)).size,
      Object.keys(FORMS).length * Object.keys(TARGETS).length,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
