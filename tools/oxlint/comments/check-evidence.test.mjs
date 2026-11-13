import assert from "node:assert/strict";
import test from "node:test";

import { checkEvidenceComments } from "./check-evidence.mjs";

function rejectedLocations(sourceText) {
  const diagnostics = checkEvidenceComments("fixture.ts", sourceText);
  for (const { message } of diagnostics) {
    assert.ok(message.trim().length > 0);
  }
  return diagnostics.map(({ line, column }) => ({ line, column }));
}

test("allows rule-specific line exceptions with evidence", () => {
  const sourceText = `
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: deliberately malformed input
const first = value;
const second = value; // oxlint-disable-line no-console -- EVIDENCE: Node CLI output is the intended behavior
// oxlint-disable-next-line anti-slop/first-rule, @scope/plugin/second-rule -- EVIDENCE: both rules apply to this fixture
const third = value;
// oxlint-disable-next-line anti-slop/no-reflect-get -- EVIDENCE: \`Reflect.get\` forwards unchanged proxy keys
const fourth = value;
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

  assert.deepEqual(rejectedLocations(sourceText), [
    { line: 2, column: 1 },
    { line: 4, column: 1 },
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

  assert.deepEqual(rejectedLocations(sourceText), [
    { line: 2, column: 1 },
    { line: 3, column: 1 },
    { line: 5, column: 1 },
    { line: 7, column: 1 },
    { line: 9, column: 1 },
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

  assert.deepEqual(rejectedLocations(sourceText), [
    { line: 2, column: 1 },
    { line: 4, column: 23 },
    { line: 5, column: 1 },
    { line: 6, column: 1 },
    { line: 7, column: 1 },
    { line: 11, column: 1 },
  ]);
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

  assert.deepEqual(rejectedLocations(sourceText), [
    { line: 2, column: 1 },
    { line: 7, column: 3 },
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

test("reads a .vue file's script blocks only, at their lines in the file", () => {
  const sourceText = `<template>
  <!-- // eslint-disable-next-line no-console -->
  <p>// oxlint-disable-next-line anti-slop/example</p>
</template>
<script setup lang="ts">
// oxlint-disable-next-line anti-slop/example
const first = value;
</script>
<script lang="ts">
/* eslint-disable */
</script>
`;

  assert.deepEqual(
    checkEvidenceComments("Fixture.vue", sourceText).map(({ line, column }) => ({ line, column })),
    [
      { line: 6, column: 1 },
      { line: 10, column: 1 },
    ],
  );
});

test("finds a .vue file's script blocks as Vue does, and reports at the file's line and column", () => {
  const at = (sourceText) =>
    checkEvidenceComments("Fixture.vue", sourceText).map(({ line, column }) => ({ line, column }));
  // a `>` inside a quoted attribute ends no tag
  assert.deepEqual(
    at(
      '<script setup lang="ts" generic="T extends Array<string>">// oxlint-disable-next-line no-debugger\ndebugger;\n</script>',
    ),
    [{ line: 1, column: 59 }],
  );
  // a `<script>` inside a template comment is no block
  assert.deepEqual(
    at(
      '<template>\n<!-- <script>\n/* eslint-disable */\n</script> -->\n<p>ok</p>\n</template>\n<script setup lang="ts">const a = 1;</script>',
    ),
    [],
  );
  // a comment on the tag's own line, and an attribute that holds the block's own text
  assert.deepEqual(at('<script lang="ts">/* eslint-disable */\nexport default {};\n</script>'), [
    { line: 1, column: 19 },
  ]);
  assert.deepEqual(
    at('<script\n data-note="/* eslint-disable */"\n lang="ts">/* eslint-disable */</script>'),
    [{ line: 3, column: 12 }],
  );
});

test("refuses a lint directive in a .vue file that Vue cannot parse, whose blocks it cannot all read", () => {
  const at = (sourceText) =>
    checkEvidenceComments("Fixture.vue", sourceText).map(({ line, column }) => ({ line, column }));
  // Vue keeps one `<script>` of two, but oxlint lints both: the second's exception is refused all the same
  assert.deepEqual(
    at(
      "<script>export default {};</script>\n<script>// oxlint-disable-next-line no-debugger -- EVIDENCE: a fixture\ndebugger;</script>",
    ),
    [{ line: 2, column: 12 }],
  );
  // a file Vue cannot parse that holds no directive, as a deliberately refused fixture
  assert.deepEqual(at('<script setup src="./setup.ts"></script>\n'), []);
});
