// check-comment-forecasts's tests of printed text and the glossary: which text a test prints, that each label printed
// text carries has a glossary row, and that the glossary's rows are the README's labels. They quote none
// of what the check refuses outside its own test (CITATION_FIXTURES): an old-record citation, a revision number with
// no entry, or a section number outside a section list. They run no git.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  glossaryFindings,
  glossaryRows,
  printedLabelsIn,
  printedTexts,
} from "./check-comment-forecasts.mjs";

test("printed text is a test's title and a measures or authority value, in every form the rule names, and nothing else", () => {
  const source = [
    'test("A1 one", f);',
    "it.skip(`A2 ${x} A3`, f);",
    'describe.only(("A4" + " A5"), g);',
    'suite.todo("A6");',
    't.test("A7", f);',
    'node.describe("A8", f);',
    "export const families = [",
    '  { measures: "A9", authority: `A10 ${y}`, "measures": (k) => `A11 ${k}` },',
    "];",
    // a bracketed name, a class's property, escapes in a callee, a name and a part
    'const c = { ["measures"]: "A12", [`authority`]: "A13" };',
    'class G { measures = "A14"; static authority = "A15"; }',
    'te\\u0073t("A16", f); const e = { "measu\\u0072es": "\\x4117" };',
    // not printed: another argument, another property, a block body, a variable, an expected value, a comment
    'test(title, "B1");',
    'const r = { rule: "B2", reason: "B3", name: "B4", measures: (k) => { return "B5"; } };',
    'assert.equal(x, "B6"); // B7',
    'const n = { measure: "B9", authority: "ordinary", [name]: "B10" };',
    "check(`B8`);",
    "",
  ].join("\n");
  assert.equal(
    printedLabelsIn("tests/a.test.ts", source)
      .map(({ line, label }) => `${line} ${label}`)
      .join(", "),
    "1 A1, 2 A2, 2 A3, 3 A4, 3 A5, 4 A6, 5 A7, 6 A8, 8 A9, 8 A10, 8 A11, 10 A12, 10 A13, 11 A14, 11 A15, 12 A16, 12 A17",
  );
  // a file with none of the callee or property names, and no backslash, is not parsed; one with a backslash is
  assert.deepEqual(printedTexts("tests/b.ts", 'const s = "A1";\n'), []);
  assert.deepEqual(
    printedLabelsIn("tests/b.ts", 'const s = { "measur\\u0065s": "A1" };\n').map(
      ({ label }) => label,
    ),
    ["A1"],
  );
  // a part with an escape reports its first line
  assert.deepEqual(printedLabelsIn("tests/b.ts", "test(`A1\\n\nA2`, f);\n"), [
    { line: 1, label: "A1" },
    { line: 1, label: "A2" },
  ]);
  // a file with a property alone, and none with a callee alone, is read
  assert.deepEqual(
    ["measures", "authority"].map((name) =>
      printedLabelsIn("tests/f.ts", `export const f = { ${name}: "A1" };\n`).map(
        ({ label }) => label,
      ),
    ),
    [["A1"], ["A1"]],
  );
  // the label reading is the comments' own: review references and names that are no labels are none
  assert.deepEqual(
    printedLabelsIn(
      "tests/c.test.ts",
      "test(\"past V8 and RE2 (Codex r2's B1, #1027's F12) at C9\", f);\n",
    ),
    [{ line: 1, label: "C9" }],
  );
});

test("a printed label without a row is refused, and one with a row is not", () => {
  const glossary = new Map([
    ["C9", 7],
    ["W5", 8],
  ]);
  assert.deepEqual(
    glossaryFindings(
      [
        { fileName: "src/type-inference/core/a.ts", line: 3, label: "C9" },
        { fileName: "tests/a.test.ts", line: 2, label: "W5", printed: true },
        { fileName: "tests/a.test.ts", line: 4, label: "W99", printed: true },
      ],
      glossary,
    ).map(({ fileName, line, message }) => [fileName, line, message.split(",")[0]]),
    [
      [
        "tests/a.test.ts",
        4,
        "a test's title or a measures or authority string carries the label W99",
      ],
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

test("a comment's label without a glossary row is a finding, and one with a row is not", () => {
  const glossary = new Map([
    ["C9", 7],
    ["S8c", 8],
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
    [["src/type-inference/core/a.ts", 4, "a comment carries the label Q77"]],
  );
});
