import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CITATION_FIXTURES,
  citationCounts,
  FORECASTS,
  forecastsIn,
  glossaryFindings,
  glossaryRows,
  labelsIn,
  tableCitationsIn,
  unresolvedPointers,
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
    citationCounts("a.ts", `/* TABLE r4.1, r4.2 and F19 (r4.3), TABLE B1, TABLE\n * § 3 */\n`),
    { "bare r4.N": 2, "other TABLE": 1 },
  );
});

test("a TABLE revision or section is found in any file's text, wrapped or not, with its line", () => {
  const found = (fileName, text) =>
    tableCitationsIn(fileName, text).map(({ line, text: citation }) => [line, citation]);
  // a document, wrapped in a paragraph and in a block quote
  assert.deepEqual(
    found(
      "docs/a.md",
      "# A\n\nAs ruled (TABLE r4.390).\nThe pins (TABLE\nr4.50 states)\n\n> TABLE\n> § 2\n",
    ),
    [
      [3, "TABLE r4"],
      [4, "TABLE\nr4"],
      [7, "TABLE\n> §"],
    ],
  );
  // a string, code and a comment over two lines, and data
  assert.deepEqual(
    found(
      "tests/a.test.ts",
      'test("a site (TABLE §3.4, r4.62)", () => {});\n/*\n * TABLE\n * r4.1\n */\n',
    ),
    [
      [1, "TABLE §"],
      [3, "TABLE\n * r4"],
    ],
  );
  assert.deepEqual(found("tests/a.json", '{"reason": "TABLE r4.2"}\n'), [[1, "TABLE r4"]]);
  // other ids, a longer revision number, and the form that describes the citation
  assert.deepEqual(
    found("docs/b.md", "TABLE B1, TABLE F18 and TABLE r40; `TABLE` followed by `r4` or `§`\n"),
    [],
  );
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
