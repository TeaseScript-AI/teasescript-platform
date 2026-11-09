import assert from "node:assert/strict";
import { test } from "node:test";

import {
  citationCounts,
  FORECASTS,
  forecastsIn,
  glossaryRows,
  labelsIn,
  unresolvedPointers,
} from "./check-comment-forecasts.mjs";

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
      `// TABLE r4.1 and TABLE r4.2, TABLE § 3\nconst s = "TABLE r4.9";\n/* TABLE § 4 */\n`,
    ),
    { "TABLE r4": 2, "TABLE §": 2 },
  );
});

test("a bare revision and TABLE with another id are counted too, a TABLE revision once", () => {
  assert.deepEqual(
    citationCounts(
      "a.ts",
      `// TABLE r4.1, r4.2 and F19 (r4.3), TABLE B1\nconst s = "r4.9, TABLE q1";\n`,
    ),
    { "TABLE r4": 1, "bare r4.N": 2, "other TABLE": 1 },
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
        "/* Codex r2's B1 and Astra r1 F2 */",
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
