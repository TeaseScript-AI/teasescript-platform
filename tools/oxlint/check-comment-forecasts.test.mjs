import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  recordEntries,
  tableCitationsIn,
  unresolvedPointers,
  unresolvedRevisionsIn,
} from "./check-comment-forecasts.mjs";
import { repositoryRoot } from "./files.mjs";

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
  const entries = recordEntries(
    new Map([
      ["sharing", "# Sharing\n\n### r4-38\n\n### section-2-f12\n"],
      ["oracles", "# Oracles\n\n### r4-165\n\nnot a heading: ### r4-7\n"],
    ]),
  );
  assert.deepEqual([...entries].sort(), ["165", "38"]);
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
  // other spellings and longer tokens are no revision numbers; an anchor is the doc-links check's
  assert.deepEqual(missing("docs/b.md", "R4.1, xr4.1, r4-9999, x.r4.2, r4.1a\n"), [[1, "1"]]);
  // the record's own pages and this test are outside the rule
  assert.deepEqual(
    missing("docs/specifications/type-inference-accepted-record/admission.md", "built as r4.167\n"),
    [],
  );
  assert.deepEqual(missing(CITATION_FIXTURES, "r4.9999\n"), []);
  assert.deepEqual(missing("docs/specifications/other.md", "r4.9999\n"), [[1, "9999"]]);
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
    write("tools/oxlint/comment-forecasts-allowed.json", "[]\n");
    write("tools/oxlint/comment-citations.json", "{}\n");
    write(
      "docs/specifications/type-inference-accepted-record/README.md",
      "# Record\n\n## Labels\n",
    );
    write(
      "docs/specifications/type-inference-accepted-record/sharing.md",
      "# S\n\n### r4-38\n\nas r4.167\n",
    );
    write("docs/rev.md", "Kept r4.38.\n\nGone r4.9999.\n");
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
    // each TABLE fixture's revision has no entry here, so it is a revision finding too (`src/a.ts` cites a section)
    const revisions = [
      ...expected.filter((found) => found !== "src/a.ts:1"),
      "docs/rev.md:3",
      "src/rev.ts:1",
    ].sort();
    const at = (findings, kind) =>
      findings
        .filter(({ message }) => message.includes(kind))
        .map(({ fileName, line }) => `${fileName}:${line}`)
        .sort();
    const record = "docs/specifications/type-inference-accepted-record";
    const pages = new Map(
      ["README", "sharing"].map((name) => [
        name,
        readFileSync(join(root, record, `${name}.md`), "utf8"),
      ]),
    );
    const listed = listedTextFindings(root, pages);
    assert.deepEqual(at(listed, "cites a record that is not in the repository"), expected);
    assert.deepEqual(at(listed, "names no entry of the accepted record"), revisions);
    const entry = await import(
      pathToFileURL(join(root, "tools/oxlint/check-comment-forecasts.mjs")).href
    );
    const entryFindings = entry.checkCommentForecasts(root);
    assert.deepEqual(at(entryFindings, "cites a record that is not in the repository"), expected);
    assert.deepEqual(at(entryFindings, "names no entry of the accepted record"), revisions);
    writeFileSync(
      Buffer.concat([Buffer.from(`${root}/name-`), Buffer.from([0xff]), Buffer.from(".md")]),
      "TABLE r4.9\n",
    );
    assert.throws(() => listedTextFindings(root, pages), /whose name is not UTF-8/u);
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

test("a comment's pointer at the accepted record names a heading of the page it names", () => {
  const pages = new Map([
    ["sharing", "# Sharing\n\n### r4-15\n\n### section-2-f12\n"],
    ["oracles", "# Oracles\n\n### r4-16\n"],
  ]);
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
        "",
      ].join("\n"),
      pages,
    ),
    [
      { line: 2, page: "sharing", anchor: "r4-16" },
      { line: 3, page: undefined, anchor: "r4-15" },
      { line: 4, page: "stops", anchor: "r4-15" },
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
