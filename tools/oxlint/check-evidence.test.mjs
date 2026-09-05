import assert from "node:assert/strict";
import test from "node:test";

import { checkEvidenceComments } from "./check-evidence.mjs";

function messages(sourceText) {
  return checkEvidenceComments("fixture.ts", sourceText).map((diagnostic) => diagnostic.message);
}

test("allows rule-specific line exceptions with evidence", () => {
  const sourceText = `
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: deliberately malformed input
const first = value;
const second = value; // oxlint-disable-line no-console -- EVIDENCE: Node CLI output is the intended behavior
// oxlint-disable-next-line anti-slop/first-rule, @scope/plugin/second-rule -- EVIDENCE: both rules apply to this fixture
const third = value;
`;

  assert.deepEqual(checkEvidenceComments("fixture.ts", sourceText), []);
});

test("requires a nonempty EVIDENCE explanation", () => {
  const sourceText = `
// oxlint-disable-next-line anti-slop/example
const first = value;
// oxlint-disable-next-line anti-slop/example -- EVIDENCE:
const second = value;
`;

  assert.deepEqual(messages(sourceText), [
    "Oxlint exceptions must include `-- EVIDENCE: <factual explanation>`.",
    "Oxlint exceptions must include `-- EVIDENCE: <factual explanation>`.",
  ]);
});

test("rejects blanket and non-rule Oxlint suppressions", () => {
  const sourceText = `
/* oxlint-disable anti-slop/example */
// oxlint-disable-next-line -- EVIDENCE: no named rule
const first = value;
// oxlint-disable-line all -- EVIDENCE: blanket suppression
const second = value;
// oxlint-disable-next-line correctness -- EVIDENCE: category suppression
const third = value;
// oxlint-enable anti-slop/example
`;

  assert.deepEqual(messages(sourceText), [
    "Block, file-wide, and enable-style Oxlint directives are not allowed.",
    "Oxlint exceptions must name one or more explicit rules.",
    "Oxlint exceptions must name one or more explicit rules.",
    "Oxlint exceptions must name one or more explicit rules.",
    "Block, file-wide, and enable-style Oxlint directives are not allowed.",
  ]);
});

test("rejects ESLint aliases and inline rule configuration", () => {
  const sourceText = `
// eslint-disable-next-line anti-slop/example
const first = value;
const second = value; // eslint-disable-line anti-slop/example
/* eslint-disable anti-slop/example */
/* eslint anti-slop/example: "off" */
/*
 * eslint
 * anti-slop/another-example: 0
 */
// eslint-enable anti-slop/example
`;

  const foundMessages = messages(sourceText);
  assert.equal(foundMessages.length, 6);
  assert.ok(
    foundMessages.every(
      (message) =>
        message === "ESLint suppression and inline rule configuration comments are not allowed.",
    ),
  );
});

test("rejects multiline and empty-block suppression comments", () => {
  const sourceText = `
/*
 * oxlint-disable-next-line anti-slop/example -- EVIDENCE: block directive
 */
const first = value;
{
  /* oxlint-disable-line anti-slop/example -- EVIDENCE: empty block */
}
`;

  assert.deepEqual(messages(sourceText), [
    "Oxlint exceptions must use single-line comments.",
    "Oxlint exceptions must use single-line comments.",
  ]);
});

test("ignores directive text in strings, templates, and regular expressions", () => {
  const sourceText = [
    'const stringValue = "// oxlint-disable-line all -- EVIDENCE: string";',
    "const templateValue = `/* eslint-disable */`;",
    String.raw`const pattern = /\/\/ oxlint-disable-next-line all -- EVIDENCE: regex/;`,
    String.raw`const blockPattern = /\/\* eslint anti-slop\/example: "off" \*\//;`,
  ].join("\n");

  assert.deepEqual(checkEvidenceComments("fixture.ts", sourceText), []);
});

test("checks leading, trailing, and end-of-file comments while allowing assertion evidence", () => {
  const sourceText = `// oxlint-disable anti-slop/example
const value = 1; // eslint-disable-line anti-slop/example
// EVIDENCE: the assertion describes the verified invariant
// oxlint-enable anti-slop/example`;
  const diagnostics = checkEvidenceComments("fixture.ts", sourceText);

  assert.deepEqual(
    diagnostics.map(({ line, column }) => ({ line, column })),
    [
      { line: 1, column: 1 },
      { line: 2, column: 18 },
      { line: 4, column: 1 },
    ],
  );
});
