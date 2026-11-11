import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CITATION_FIXTURES,
  citationCounts,
  FORECASTS,
  forecastsIn,
  glossaryFindings,
  glossaryRows,
  labelsIn,
  listedTextFindings,
  recordAnchors,
  recordEntries,
  tableCitationsIn,
  unnamedSectionsIn,
  unresolvedPointers,
  unresolvedRevisionsIn,
} from "./check-comment-forecasts.mjs";
import { repositoryRoot } from "./files.mjs";
import { isolateGit } from "../fixture-git.mjs";

isolateGit();

// A forecast of each form; the citations #1977 allows; and prose and counted references, which are no forecasts.
const FORECAST_TEXTS = {
  "until #N": "the cache stays until #1234 replaces it",
  "until a package or stage": "the preload stays in the composable until L5i.7",
  "once #N": "it moves once #42 merges",
  "when or after #N lands or merges": "it goes when #1216 lands",
  "will be replaced": "this path will be replaced",
  "which replaces this": "decided before L5g, which replaces this",
  TODO: "TODO(#7): read the clock",
};
const CITATIONS = [
  "as #1234 decided",
  "stage 3 joins the narrowing",
  "PR 1900 moved it",
  "as before #1216",
  "after #1216 the order holds",
  // (counted in comment-citations.json, not citations)
  "r4.93's witnesses",
  "TABLE § 3",
  "Replaces this runner's next reply",
  "loops until the queue is empty",
  "runs once each page load",
];
// Where a comment can be: each wraps its text into a file of its kind.
const PLACES = {
  "line comment, .ts": ["a.ts", (text) => `const a = 1; // ${text}\n`],
  "block comment, .ts": ["a.ts", (text) => `/** ${text} */\nconst a = 1;\n`],
  // (broken at the space nearest the middle, so a form may span the two lines)
  "block comment over two lines, .ts": [
    "a.ts",
    (text) => {
      const at = text.lastIndexOf(" ", text.length >> 1) + 1 || text.length;
      return `/*\n * ${text.slice(0, at)}\n * ${text.slice(at)}\n */\nconst a = 1;\n`;
    },
  ],
  "line comment, .mjs": ["a.mjs", (text) => `export const a = 1; // ${text}\n`],
  ".vue <script>": [
    "a.vue",
    (text) =>
      `<template><p /></template>\n<script setup lang="ts">\n// ${text}\nconst a = 1;\n</script>\n`,
  ],
};

test("each forecast form is found in every kind of comment, and no citation is", () => {
  assert.deepEqual(Object.keys(FORECAST_TEXTS).sort(), FORECASTS.map(({ form }) => form).sort());
  for (const [place, [file, wrap]] of Object.entries(PLACES)) {
    for (const [form, text] of Object.entries(FORECAST_TEXTS)) {
      const found = forecastsIn(file, wrap(text)).map((forecast) => forecast.form);
      assert.ok(found.includes(form), `${form} in a ${place}: ${JSON.stringify(found)}`);
    }
    for (const text of CITATIONS)
      assert.deepEqual(forecastsIn(file, wrap(text)), [], `"${text}" in a ${place}`);
  }
});

test("a forecast in a string or in code is no comment", () => {
  for (const text of Object.values(FORECAST_TEXTS))
    assert.deepEqual(
      forecastsIn(
        "a.ts",
        `export const note = ${JSON.stringify(text)};\nconst re = /until #1/u;\n`,
      ),
      [],
    );
});

test("a vue file's forecast keeps its line in the file", () => {
  const [forecast] = forecastsIn(
    "a.vue",
    `<template>\n  <p />\n</template>\n<script setup>\n\n// TODO: x\n</script>\n`,
  );
  assert.equal(forecast?.line, 6);
});

test("the counted citations are counted in comments only", () => {
  assert.deepEqual(
    citationCounts(
      "a.ts",
      `// r4.1 and TABLE B2, TABLE F3\nconst s = "r4.9 TABLE q1";\n/* r4.4 */\n`,
    ),
    { "bare r4.N": 2, "other TABLE": 2 },
  );
  // the revision rule's token: after `_` it is one, after `.` or a letter none
  assert.deepEqual(citationCounts("a.ts", "// _r4.1\n"), { "bare r4.N": 1 });
  assert.deepEqual(citationCounts("a.ts", "// x.r4.2, xr4.3\n"), {});
});

test("a TABLE revision or section, wrapped or not, is no counted form: the text check finds it", () => {
  assert.deepEqual(
    citationCounts(
      "a.ts",
      `/* TABLE B1 here\n * and more\n * TABLE r4.1, TABLE B1, TABLE\n * § 3 */\n`,
    ),
    { "bare r4.N": 1, "other TABLE": 1 },
  );
  // a name whose citation is on the next line only
  assert.deepEqual(citationCounts("a.ts", "/* TABLE B1\n * words before r4.5 */\n"), {
    "bare r4.N": 1,
  });
});

test("a line naming TABLE and then r4 or § is found in any file's text, wrapped or not, with its line", () => {
  const found = (fileName, text) =>
    tableCitationsIn(fileName, text).map(({ line, text: citation }) => [line, citation]);
  // a document, wrapped in a paragraph and in a block quote
  assert.deepEqual(
    found(
      "docs/a.md",
      "# A\n\nAs ruled (TABLE r4.390).\nThe pins (TABLE\nr4.50 states)\n\n> TABLE\n> § 2\n",
    ),
    [
      [3, "TABLE r4.390)."],
      [4, "TABLE"],
      [7, "TABLE"],
    ],
  );
  // a string, code and a comment over two lines, and data
  assert.deepEqual(
    found(
      "tests/a.test.ts",
      'test("a site (TABLE §3.4, r4.62)", () => {});\n/*\n * TABLE\n * r4.1\n */\n',
    ),
    [
      [1, 'TABLE §3.4, r4.62)", () => {});'],
      [3, "TABLE"],
    ],
  );
  assert.deepEqual(found("tests/a.json", '{"reason": "TABLE r4.2"}\r\n'), [[1, 'TABLE r4.2"}']]);
  // one finding per line, from its first name; a wrapped one after another name on its line
  assert.deepEqual(
    found("docs/d.md", "TABLE B1 and TABLE r4.1, TABLE §2\nTABLE B1, see TABLE\n§ 3\n"),
    [
      [1, "TABLE B1 and TABLE r4.1, TABLE §2"],
      [2, "TABLE B1, see TABLE"],
    ],
  );
  // the second final's escapes: markup around a name at a line's end, an entity before the revision on the next
  assert.deepEqual(
    found(
      "docs/e.md",
      "<strong>TABLE</strong>\n<strong>r4.5</strong>\nSee TABLE\n&nbsp;r4.5 and TABLE (see\nr4.1)\n",
    ),
    [
      [1, "TABLE</strong>"],
      [3, "TABLE"],
      [4, "TABLE (see"],
    ],
  );
  // outside the rule: other ids, a longer revision number or word, another letter case, a revision before the name,
  // a revision two lines on
  assert.deepEqual(
    found(
      "docs/b.md",
      "TABLE B1, TABLE F18 and TABLE r40 or xr4.1\n\nTABLEr4.1, TABLES r4.1, TABLE² r4.1\n\ntable r4.1, Table §2, TABLE R4.1\n\nr4.1 before TABLE\n\nTABLE (see\nthe row\nr4.1)\n",
    ),
    [],
  );
  // a letter or digit beyond ASCII on either edge
  assert.deepEqual(found("docs/f.md", "éTABLE r4.5\n\nTABLE r4² and TABLE r4٣\n"), []);
  // a citing last line without a line break
  assert.deepEqual(found("docs/g.md", "TABLE r4.5"), [[1, "TABLE r4.5"]]);
});

test("every ASCII character that is no letter or digit may stand between TABLE and r4 or §, once or twice", () => {
  const between = [];
  for (let code = 0; code < 128; code++) {
    const character = String.fromCharCode(code);
    if (!/[\p{L}\p{N}]/u.test(character)) between.push(character, character + character);
  }
  assert.equal(between.length, 2 * (128 - 62));
  for (const text of between)
    for (const cited of ["r4.1", "§3"])
      assert.equal(
        tableCitationsIn("docs/a.md", `See TABLE${text}${cited}.\n`).length,
        // (two line breaks leave a blank line between: no longer one line or a wrapped one)
        text === "\n\n" ? 0 : 1,
        JSON.stringify(`TABLE${text}${cited}`),
      );
  // emphasis around the whole citation
  assert.equal(tableCitationsIn("docs/a.md", "_TABLE r4.1_ and\n__TABLE §2__\n").length, 2);
});

test("whatever stands between TABLE and r4 or § on its line, markup or words, the line is found", () => {
  // review round 3's eight misses, by name
  for (const text of [
    "TABLE<!-- a < b -->r4.1",
    "TABLE<!-- a < b -->§3",
    "TABLE<!-- a > b -->r4.1",
    "TABLE<!-- a > b -->§3",
    'TABLE<span title="a>b">r4.1',
    'TABLE<span title="a>b">§3',
    'TABLE<span title="a<b">r4.1',
    'TABLE<span title="a<b">§3',
  ])
    assert.equal(tableCitationsIn("docs/a.md", `${text}\n`).length, 1, text);
  const fillers = [
    "<br>",
    "&nbsp;",
    "<!-- revision -->",
    "<!-- <b> -->",
    '<span title="r4">',
    '<a href="x.md">',
    "](TABLE.md) ",
    " _",
    " **",
    " | record | ",
    " revision ",
    " see the row ",
    " é ٣ ",
    " (B1, F18) and ",
    " TABLE ",
    " –​",
  ];
  for (const filler of fillers)
    for (const cited of ["r4.1", "§3"])
      assert.equal(
        tableCitationsIn("docs/a.md", `TABLE${filler}${cited}\n`).length,
        1,
        JSON.stringify(`TABLE${filler}${cited}`),
      );
});

test("a revision number names an entry of the accepted record, each end of a range too, outside the record's pages", () => {
  // an entry is a level-3 heading as Markdown reads it: trailing spaces count as nothing, a fenced line is no heading
  const entries = recordEntries([
    "# Sharing\n\n### r4-38\n\n### section-2-f12\n",
    "# Oracles\n\n### r4-165  \n\n### r4-72\t\n\nnot a heading: ### r4-7\n\n```\n### r4-8\n```\n\n~~~\n### r4-9\n~~~\n",
    "#### r4-10\n\n### r4-11-other\n\n### R4-12\n",
  ]);
  assert.deepEqual([...entries].sort(), ["165", "38", "72"]);
  const missing = (fileName, text) =>
    unresolvedRevisionsIn(fileName, text, entries).map(({ line, number }) => [line, number]);
  // a document, a link's text, a string, data and a range
  assert.deepEqual(
    missing(
      "docs/a.md",
      "# A\n\nAs [r4.38](x.md#r4-38) and r4.165 hold, r4.9999 names none.\n\nRange r4.38–r4.9998, r4.12–r4.165.\n",
    ),
    [
      [3, "9999"],
      [5, "9998"],
      [5, "12"],
    ],
  );
  assert.deepEqual(missing("tests/a.test.ts", 'test("a rule (C9 r4.9997)", () => {});\n'), [
    [1, "9997"],
  ]);
  assert.deepEqual(missing("tests/a.json", '{"closes": "r4.9996 until #1"}\r\n'), [[1, "9996"]]);
  // a range's short second end is a number of its own; a spaced dash, a longer token or a full end is none
  assert.deepEqual(
    missing(
      "tests/b.ts",
      "r4.38–72, r4.38-9995, r4.9994–38\nr4.38 – 9993, r4.38–9992a, r4.38-9991.5, r4.38–9990٢, r4.38-r4.72\n",
    ),
    [
      [1, "9995"],
      [1, "9994"],
    ],
  );
  // other spellings and longer tokens are no revision numbers; an anchor is the doc-links check's
  // a number is its digits as written, leading zeros included, so 038 names no entry 38
  assert.deepEqual(
    missing("docs/b.md", "R4.1, xr4.1, ér4.9999, r4.9999٢, r4-9999, x.r4.2, r4.1a, r4.038\n"),
    [
      [1, "1"],
      [1, "038"],
    ],
  );
  // the record's own pages and this test are outside the rule
  assert.deepEqual(
    missing("docs/specifications/type-inference-accepted-record/admission.md", "built as r4.167\n"),
    [],
  );
  assert.deepEqual(missing(CITATION_FIXTURES, "r4.9999\n"), []);
  assert.deepEqual(missing("docs/specifications/other.md", "r4.9999\n"), [[1, "9999"]]);
});

test("a heading the doc-links check resolves is an entry exactly when its level and text are the rule's, form by form", () => {
  // [form, heading with N for its number, doc-links resolves its anchor, the revision rule takes it as an entry]
  const forms = [
    ["plain", "### r4-N", true, true],
    ["strikethrough", "### ~~r4-N~~", true, true],
    ["emphasis", "### *r4-N*", true, true],
    ["strong", "### **r4-N**", true, true],
    ["inline code", "### `r4-N`", true, true],
    ["escaped hyphen", "### r4\\-N", true, true],
    ["character reference", "### r4&#45;N", true, true],
    ["link", "### [r4-N](#r4-N)", true, true],
    ["reference link", "### [r4-N][eN]\n\n[eN]: #r4-N", true, true],
    ["trailing hashes", "### r4-N ###", true, true],
    ["inline HTML", "### <em>r4-N</em>", true, true],
    ["inline HTML comment", "### r4<!-- c -->-N", true, true],
    ["inline HTML span", "### <span>r4-N</span>", true, true],
    ["image beside the text", "### r4-N![alt](i.png)", true, true],
    // (outside the rule: another level, other text; and no Markdown heading at all)
    ["setext, level 2", "r4-N\n---", true, false],
    ["scheme autolink, text `r4-N:`", "### <r4-N:>", true, false],
    ["HTML in angle brackets", "### <r4-N>", false, false],
    ["HTML heading", "<h3>r4-N</h3>", false, false],
  ].map(([form, heading, links, entry], index) => {
    const number = String(9901 + index);
    return { form, heading: heading.replaceAll("N", number), number, links, entry };
  });
  const root = mkdtempSync(join(tmpdir(), "record-headings-"));
  try {
    const record = "docs/specifications/type-inference-accepted-record";
    const write = (file, text) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(".gitignore", "node_modules\n");
    symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
    write(`${record}/page.md`, `# Page\n\n${forms.map(({ heading }) => heading).join("\n\n")}\n`);
    write(
      "docs/refs.md",
      forms
        .map(({ number }) => `[r4.${number}](${record.slice(5)}/page.md#r4-${number})`)
        .join("\n\n") + "\n",
    );
    const links = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../repository-checks/doc-links.mjs", import.meta.url))],
      { cwd: root, encoding: "utf8" },
    );
    const unresolved = new Set(
      [...links.stderr.matchAll(/#r4-(\d+)/gu)].map(([, number]) => number),
    );
    const refused = new Set(
      listedTextFindings(root)
        .filter(({ fileName }) => fileName === "docs/refs.md")
        .map(({ message }) => /^revision (\d+)/u.exec(message)?.[1]),
    );
    assert.deepEqual(
      forms.map(({ form, number }) => [form, !unresolved.has(number), !refused.has(number)]),
      forms.map(({ form, links: resolves, entry }) => [form, resolves, entry]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record page's anchors are exactly those the doc-links check resolves, heading form by heading form", () => {
  // #2405's heading forms, a heading in a code block, a repeated heading and a heading with punctuation, on one page
  const headings = [
    "### r4-9901",
    "### ~~r4-9902~~",
    "### *r4-9903*",
    "### **r4-9904**",
    "### `r4-9905`",
    "### r4\\-9906",
    "### r4&#45;9907",
    "### [r4-9908](#r4-9908)",
    "### [r4-9909][e9909]\n\n[e9909]: #r4-9909",
    "### r4-9910 ###",
    "### <em>r4-9911</em>",
    "### r4<!-- c -->-9912",
    "### <span>r4-9913</span>",
    "### r4-9914![alt](i.png)",
    "r4-9915\n---",
    "### <r4-9916:>",
    "### <r4-9917>",
    "<h3>r4-9918</h3>",
    "```\n### r4-9919\n```",
    "### Twice",
    "### Twice",
    "### R4-9920: The Rule (a), `x` & y!",
  ];
  const root = mkdtempSync(join(tmpdir(), "record-anchors-"));
  try {
    const record = "docs/specifications/type-inference-accepted-record";
    const write = (file, text) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(".gitignore", "node_modules\n");
    symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
    const page = `# Page\n\n${headings.join("\n\n")}\n`;
    write(`${record}/page.md`, page);
    const anchors = recordAnchors(new Map([["page.md", page]])).get("page.md");
    // every anchor the rule reads, and the anchors a reader might expect that it does not
    const candidates = [
      ...new Set([
        ...anchors,
        ...Array.from({ length: 20 }, (_, index) => `r4-${9901 + index}`),
        "twice-2",
        "r4-9920-the-rule-a-x--y",
        "r4-9920-the-rule-a-x-y",
      ]),
    ];
    write(
      "docs/refs.md",
      candidates.map((anchor) => `[${anchor}](${record.slice(5)}/page.md#${anchor})`).join("\n\n") +
        "\n",
    );
    const links = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../repository-checks/doc-links.mjs", import.meta.url))],
      { cwd: root, encoding: "utf8" },
    );
    const unresolved = new Set(
      [...links.stderr.matchAll(/Cannot find heading for `#([\w-]+)`/gu)].map(([, anchor]) => anchor),
    );
    assert.ok(unresolved.size > 0, links.stderr);
    assert.deepEqual(
      candidates.map((anchor) => [anchor, anchors.has(anchor)]),
      candidates.map((anchor) => [anchor, !unresolved.has(anchor)]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the TABLE citation check reads every file Git lists, by its exact path, and refuses a name it cannot read", async () => {
  const root = mkdtempSync(join(tmpdir(), "table-citations-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    const write = (file, text) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    git("init", "-q");
    write(".gitignore", "ignored/\nnode_modules\n");
    // the lint runner's entry, `checkCommentForecasts`, run on this repository: its module and the files it reads
    for (const file of ["check-comment-forecasts.mjs", "comments.mjs", "files.mjs"])
      write(`tools/oxlint/${file}`, readFileSync(new URL(file, import.meta.url)));
    write(
      "tools/repository-checks/markdown.mjs",
      readFileSync(new URL("../repository-checks/markdown.mjs", import.meta.url)),
    );
    write("tools/oxlint/comment-forecasts-allowed.json", "[]\n");
    write("tools/oxlint/comment-citations.json", "{}\n");
    // entries on every record page Git lists: the README, a nested page and another Markdown extension too
    const record = "docs/specifications/type-inference-accepted-record";
    write(
      `${record}/README.md`,
      "# Record\n\n## Labels\n\n| label | meaning |\n| --- | --- |\n| `C9` | a rule |\n\n### r4-40\n",
    );
    // a core comment's label with its glossary row: no finding, so the glossary is the README Git lists
    write("src/type-inference/core/labelled.ts", "// C9 holds here\nexport const x = 1;\n");
    // (a struck-through heading, GitHub's mark, and one with inline HTML, read as the doc-links check reads them)
    write(
      `${record}/sharing.md`,
      "# S\n\n### r4-38\n\n### ~~r4-9997~~\n\n### <em>r4-9996</em>\n\nas r4.167\n\n```\n### r4-9\n```\n\n### Twice\n\n### Twice\n",
    );
    // files in the record's folder that are no pages are under the rule
    write(`${record}/notes.json`, '{"why": "r4.9994"}\n');
    write(`${record}/nested/notes.txt`, "r4.9993\n");
    write(`${record}/nested/entry.md`, "# N\n\n### r4-41\n");
    write(`${record}/other.markdown`, "# O\n\n### r4-42\n");
    write(
      "docs/rev.md",
      `Kept r4.38, r4.40, r4.41 and r4.42.\n\nGone r4.9999.\n\nStruck [r4.9997](${record.slice(5)}/sharing.md#r4-9997)` +
        ` and marked [r4.9996](${record.slice(5)}/sharing.md#r4-9996)[^n].\n\n` +
        // (a footnote, GitHub's: without its extension this line is a definition naming a missing file)
        `[^n]: [page](${record.slice(5)}/sharing.md)\n`,
    );
    write("data/rev.json", '{"why": "r4.9995"}\n');
    // a range's short second end names an entry too
    write("tests/ranges.ts", 'const s = "r4.38–40 and r4.38-9992";\n');
    // comments' pointers: at a fenced heading, a third repeat and a missing page refused; nested and `.markdown` found
    write(
      "src/pointers.ts",
      [
        `// (${record}/sharing.md#r4-38, ${record}/sharing.md#twice-1)`,
        `// (${record}/nested/entry.md#r4-41, ${record}/other.markdown#r4-42)`,
        `// (${record}/sharing.md#r4-9)`,
        `// (${record}/sharing.md#twice-2, ${record}/entry.md#r4-41)`,
        "",
      ].join("\n"),
    );
    // section numbers: refused in a test and in data, not in the exempt paths or a binary file, and admitted after V30
    write("tests/sections.ts", '// V30 §13\nconst title = "a rule (§3.2)";\n');
    write("data/sections.json", '{"why": "§4"}\n');
    write("docs/sections.md", "See §5.\n");
    write("src/sections.ts", "// §6\n");
    write("tests/fixtures/type-core/cells.jsonl", '{"cells": ["§7"]}\n');
    write("tools/oxlint/comment-declarations-waiting.json", '[{"text": "§8"}]\n');
    write("sections.bin", "x\0§9\n");
    write("src/rev.ts", 'const reason = "r4.9998 and r4.38";\n');
    symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
    write("docs/a.md", "# A\n\nAs ruled (TABLE r4.1).\n");
    write("src/a.ts", 'const reason = "a site (TABLE §2)";\n');
    write(CITATION_FIXTURES, 'const fixture = "TABLE r4.3";\n');
    write(`other/${CITATION_FIXTURES}`, 'const fixture = "TABLE r4.4";\n');
    write("gone.md", "TABLE r4.5\n");
    write("data.bin", "x\0TABLE r4.6\n");
    write("\uFEFFmarked.md", "TABLE r4.10\n");
    git("add", "-A");
    rmSync(join(root, "gone.md"));
    write("untracked.txt", "TABLE r4.7\n");
    write("ignored/a.md", "TABLE r4.8\n");
    const expected = [
      "\uFEFFmarked.md:1",
      "docs/a.md:3",
      `other/${CITATION_FIXTURES}:1`,
      "src/a.ts:1",
      "untracked.txt:1",
    ].sort();
    // each citation fixture's revision has no entry here, so it is a revision finding too (`src/a.ts` cites a section)
    const revisions = [
      ...expected.filter((found) => found !== "src/a.ts:1"),
      "docs/rev.md:3",
      "src/rev.ts:1",
      "data/rev.json:1",
      `${record}/notes.json:1`,
      `${record}/nested/notes.txt:1`,
      // (a binary file is read for revision numbers, not for the record's name)
      "data.bin:1",
      "tests/ranges.ts:1",
    ].sort();
    const at = (findings, kind) =>
      findings
        .filter(({ message }) => message.includes(kind))
        .map(({ fileName, line }) => `${fileName}:${line}`)
        .sort();
    const listed = listedTextFindings(root);
    // the doc-links check resolves the struck-through heading the revision rule takes as an entry
    const links = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../repository-checks/doc-links.mjs", import.meta.url))],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(links.status, 0, links.stderr);
    assert.deepEqual(at(listed, "cites a record that is not in the repository"), expected);
    assert.deepEqual(at(listed, "names no entry of the accepted record"), revisions);
    const sections = ["data/sections.json:1", "tests/sections.ts:2"];
    assert.deepEqual(at(listed, "a section number without"), sections);
    const entry = await import(
      pathToFileURL(join(root, "tools/oxlint/check-comment-forecasts.mjs")).href
    );
    const entryFindings = entry.checkCommentForecasts(root);
    assert.deepEqual(at(entryFindings, "cites a record that is not in the repository"), expected);
    assert.deepEqual(at(entryFindings, "names no entry of the accepted record"), revisions);
    assert.deepEqual(at(entryFindings, "a section number without"), sections);
    assert.deepEqual(
      entryFindings
        .filter(({ message }) => message.startsWith("a comment points at"))
        .map(
          ({ fileName, line, message }) => `${fileName}:${line} ${/#([\w-]+)/u.exec(message)[1]}`,
        ),
      ["src/pointers.ts:3 r4-9", "src/pointers.ts:4 twice-2", "src/pointers.ts:4 r4-41"],
    );
    assert.deepEqual(
      entryFindings.filter(({ message }) => message.includes("glossary")),
      [],
    );
    writeFileSync(
      Buffer.concat([Buffer.from(`${root}/name-`), Buffer.from([0xff]), Buffer.from(".md")]),
      "TABLE r4.9\n",
    );
    assert.throws(() => listedTextFindings(root), /whose name is not UTF-8/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only this test's own text is exempt from the TABLE citation check, by its path", () => {
  const path = fileURLToPath(import.meta.url);
  assert.equal(relative(repositoryRoot, path), CITATION_FIXTURES);
  const own = readFileSync(path, "utf8");
  assert.deepEqual(tableCitationsIn(CITATION_FIXTURES, own), []);
  assert.ok(tableCitationsIn("tools/oxlint/other.test.mjs", own).length > 0);
  const check = new URL("./check-comment-forecasts.mjs", import.meta.url);
  assert.deepEqual(
    tableCitationsIn("tools/oxlint/check-comment-forecasts.mjs", readFileSync(check, "utf8")),
    [],
  );
});

// The document names a section list may follow, and the list's separators after its first number.
const SECTION_NAMES = ["V30", "ADR 0021", "PLAN", "S3", "S6-CARRIERS"];
const SECTION_SEPARATORS = [", ", " and ", ", and ", " or "];
const sectionsIn = (text) =>
  unnamedSectionsIn("tests/a.ts", text).map(({ line, section }) => `${line} ${section}`);

test("a section list right after a document's name is admitted, in every form the rule names", () => {
  for (const name of SECTION_NAMES) {
    for (const first of ["§1", "§§12–15", "§3.2", "§4.1.2", "§6b", "§2-3"])
      assert.deepEqual(sectionsIn(`see ${name} ${first}.`), [], `${name} ${first}`);
    for (const separator of SECTION_SEPARATORS)
      assert.deepEqual(
        sectionsIn(`(${name} §8${separator}§13${separator}§35)`),
        [],
        `${name}${separator}`,
      );
  }
  // a whole number before sentence punctuation, a possessive or a dash that starts no number
  for (const text of [
    "ADR 0021 §6.2.",
    "V30 §13's rule",
    "V30 §13a, §2",
    "V30 §1 – see",
    "V30 §1.x",
    "V30 §1.2.3x",
    "V30 §1–2x.",
    "V30 §1-2.5",
  ])
    assert.deepEqual(sectionsIn(text), [], text);
  // a range, then the list goes on
  for (const name of SECTION_NAMES)
    assert.deepEqual(sectionsIn(`(${name} §1–2, §5)`), [], `${name} range`);
  // at the start of a line and of the text, and after a character that is no letter or digit
  assert.deepEqual(sectionsIn("V30 §1\n(ADR 0021 §6.2)\n`S3 §5`, _V30 §2"), []);
});

test("every other section number is found, with its line and as written", () => {
  for (const text of [
    "§1",
    "a rule (§3.2)",
    "§ 3",
    "§§2",
    "§\t4",
    "v30 §1",
    "Adr 0021 §1",
    "ADR 21 §1",
    "ADR 00211 §1",
    "xV30 §1",
    "S30 §1",
    "S6 §1",
    "S6-CARRIERS-X §1",
    "2V30 §1",
    "V30's §11",
    "V30 (Explicit types) §13",
    "V30 §13; §14",
    "V30 §13, ADR §14",
    "V30 §13 , §14",
    "TABLE §3",
    // a number is whole: no letter or digit after it, and no `.` or dash before a digit
    "V30 §13a1",
    "V30 §13ab",
    "V30 §1.2.3xy",
    "V30 §1–2a3",
    "V30 §1–2–3",
    "V30 §1-2.5-6",
    // a list goes on by its separators and one mark only
    "V30 §1,§2",
    "V30 §1, §§2",
  ])
    assert.equal(sectionsIn(text).length, 1, text);
  assert.deepEqual(sectionsIn("V30 §13ab, §2"), ["1 §13", "1 §2"]);
  assert.deepEqual(sectionsIn(`§${" ".repeat(25)}1`), ["1 § 1"]);
  // each ASCII character but the one space, once and twice, between a name and its section
  for (const name of SECTION_NAMES)
    for (let code = 0; code < 128; code += 1) {
      const between = String.fromCharCode(code);
      if (between === " ") continue;
      for (const text of [
        `${name}${between}§1`,
        `${name}${between}${between}§1`,
        `${name} ${between}§1`,
      ])
        assert.equal(sectionsIn(text).length, 1, JSON.stringify(text));
    }
  for (const name of SECTION_NAMES) {
    assert.equal(sectionsIn(`${name}  §1`).length, 1, `${name}, two spaces`);
    assert.equal(sectionsIn(`${name}\n§1`).length, 1, `${name}, a line break`);
  }
  assert.deepEqual(sectionsIn("a\nV30 §1, §2; §3 and §4\n\n(§5.1's rows, §§6)\n"), [
    "2 §3",
    "2 §4",
    "4 §5.1",
    "4 §§6",
  ]);
});

test("a section mark before anything but a digit is no section number", () => {
  assert.deepEqual(
    sectionsIn('"§say bubble(color: toString(@))"\nif (character === "§") {}\n`§` §x §.1'),
    [],
  );
});

test("a line naming the old record with a section number gets one finding from each rule", () => {
  assert.equal(tableCitationsIn("tests/a.ts", "TABLE §3\n").length, 1);
  assert.equal(unnamedSectionsIn("tests/a.ts", "TABLE §3\n").length, 1);
});

test("the section rule's exemptions are exact paths and two folders", () => {
  for (const file of [
    "docs/a.md",
    "docs/specifications/b.md",
    "src/a.ts",
    "src/type-inference/core/b.ts",
    "tests/fixtures/type-core/cells.jsonl",
    "tools/oxlint/comment-declarations-waiting.json",
    CITATION_FIXTURES,
  ])
    assert.deepEqual(unnamedSectionsIn(file, "§1\n"), [], file);
  for (const file of [
    "docsx/a.md",
    "tests/docs/a.md",
    "srcs/a.ts",
    "other/tests/fixtures/type-core/cells.jsonl",
    "tests/fixtures/type-core/cells-deferred.jsonl",
    "tests/fixtures/type-core/MANIFEST.md",
    "tools/oxlint/comment-declarations-waiting.json.bak",
    "tools/oxlint/comment-citations.json",
    `other/${CITATION_FIXTURES}`,
  ])
    assert.equal(unnamedSectionsIn(file, "§1\n").length, 1, file);
});

test("a comment's pointer at the accepted record names an anchor of the page it names, nested pages included", () => {
  const anchors = recordAnchors(
    new Map([
      // (a heading in a code block is none; a repeated heading's second anchor takes `-1`)
      [
        "sharing.md",
        "# Sharing\n\n### r4-15\n\n### section-2-f12\n\n```\n### r4-9\n```\n\n### Twice\n\n### Twice\n",
      ],
      // (each page slugs on its own: a heading repeated on another page takes no `-1` there)
      ["oracles.md", "# Oracles\n\n### r4-16\n\n### Twice\n"],
      ["nested/entry.md", "# Nested\n\n### r4-41\n"],
      ["other.markdown", "# Other\n\n### r4-42: The rule (a), `x`!\n"],
    ]),
  );
  const record = "docs/specifications/type-inference-accepted-record";
  assert.deepEqual(
    unresolvedPointers(
      "a.ts",
      [
        `// as ruled (${record}/sharing.md#r4-15)`,
        `/* see ${record}/sharing.md#r4-16, on another page */`,
        `// the old single page (${record}.md#r4-15)`,
        `// no such page (${record}/stops.md#r4-15)`,
        `const s = "${record}/sharing.md#r4-17";`,
        `// fenced (${record}/sharing.md#r4-9), repeated (${record}/sharing.md#twice, ${record}/sharing.md#twice-1)`,
        `// a third (${record}/sharing.md#twice-2), nested (${record}/nested/entry.md#r4-41, ${record}/entry.md#r4-41)`,
        `// another extension (${record}/other.markdown#r4-42-the-rule-a-x, ${record}/other.md#r4-42-the-rule-a-x)`,
        `// missing anchors (${record}/nested/entry.md#r4-9999, ${record}/other.markdown#r4-42) and (${record}/oracles.md#twice)`,
        "",
      ].join("\n"),
      anchors,
    ),
    [
      { line: 2, page: "sharing.md", anchor: "r4-16" },
      { line: 3, page: undefined, anchor: "r4-15" },
      { line: 4, page: "stops.md", anchor: "r4-15" },
      { line: 6, page: "sharing.md", anchor: "r4-9" },
      { line: 7, page: "sharing.md", anchor: "twice-2" },
      { line: 7, page: "entry.md", anchor: "r4-41" },
      { line: 8, page: "other.md", anchor: "r4-42-the-rule-a-x" },
      { line: 9, page: "nested/entry.md", anchor: "r4-9999" },
      { line: 9, page: "other.markdown", anchor: "r4-42" },
    ],
  );
});

test("a comment's port-plan or research label is found; a review reference, a document name and a string are not", () => {
  assert.deepEqual(
    labelsIn(
      "a.ts",
      [
        "// S8c's stop marks, by C9 (AD-1) and PLAN §6b (S6-CARRIERS §4.1), TABLE's §3.2",
        "/* Codex r2's B1 and Astra r1 F2, r1's and r2's B3, the owner's reviewer's F1, S6's B2, B4 of Astra's review */",
        "// (#1027's B1, F12), the owner's D4; Codex confirms X9 at ingress",
        "/* Codex r21",
        " * N1, Astra r1's",
        " * A1, Sol's final F7, Astra's reviews B5 and B6, Astra's recheck r3 F8, N9, Astra B7-r2, Codex r3 R3-F6 */",
        "// V30 §19",
        'const s = "C13";',
        "",
      ].join("\n"),
    ),
    [
      { line: 1, label: "S8c" },
      { line: 1, label: "C9" },
      { line: 1, label: "AD-1" },
      { line: 1, label: "PLAN" },
      { line: 1, label: "S6-CARRIERS" },
      { line: 2, label: "S6" },
      { line: 3, label: "F12" },
      { line: 3, label: "D4" },
      { line: 3, label: "X9" },
    ],
  );
});

test("the glossary's rows are the labels of the README's Labels table", () => {
  const readme = [
    "# Record",
    "",
    "## Labels",
    "",
    "| label | meaning |",
    "| --- | --- |",
    "| `C9` | the boundary check |",
    "| `S8c` | historical |",
    "",
    "## Index",
    "",
    "| `X1` | not a glossary row |",
  ].join("\n");
  assert.deepEqual(
    [...glossaryRows(readme)],
    [
      ["C9", 7],
      ["S8c", 8],
    ],
  );
});

test("a label without a glossary row, and a row no comment carries, are findings; the bare §N row is not", () => {
  const glossary = new Map([
    ["C9", 7],
    ["S8c", 8],
    ["§N", 9],
  ]);
  const findings = glossaryFindings(
    [
      { fileName: "src/type-inference/core/a.ts", line: 3, label: "C9" },
      { fileName: "src/type-inference/core/a.ts", line: 4, label: "Q77" },
    ],
    glossary,
  );
  assert.deepEqual(
    findings.map(({ fileName, line, message }) => [fileName, line, message.split(",")[0]]),
    [
      ["src/type-inference/core/a.ts", 4, "a comment carries the label Q77"],
      [
        "docs/specifications/type-inference-accepted-record/README.md",
        8,
        "the glossary defines S8c",
      ],
    ],
  );
});
