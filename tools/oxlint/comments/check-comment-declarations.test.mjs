import assert from "node:assert/strict";
import { test } from "node:test";

import { addNames, citedNames } from "./check-comment-declarations.mjs";
import { scriptsOf } from "./comments.mjs";

/** The names `code` declares or reads, as the check collects them. */
function namesOf(code, file = "a.ts") {
  const names = new Set();
  for (const { source } of scriptsOf(file, code)) addNames(source, names);
  return names;
}

// Each way the repository can name `target`, as a source that does and nothing else.
const NAMINGS = {
  function: "function target() {}",
  class: "class target {}",
  interface: "interface target {}",
  "type alias": "type target = number;",
  "enum member": "enum E { target }",
  variable: "const target = 1;",
  parameter: "function f(target: number) { return target; }",
  property: "interface I { target: number }",
  method: "class C { target() {} }",
  "object property": "const o = { target: 1 };",
  import: 'import { target } from "./x.js";',
  "property read": "const v = process.env.target;",
  "string literal": 'const kind = "target";',
  "template literal": "const line = `say ${x} target`;",
};
// How a comment cites a name: each shape, with the names it must resolve.
const SHAPES = {
  identifier: ["target", ["target"]],
  call: ["target()", ["target"]],
  "property chain": ["outer.target", ["outer", "target"]],
  "private member": ["#target", ["target"]],
  "class member": ["Outer#target", ["Outer", "target"]],
};

test("every shape of a cited name resolves through every kind of naming, and fails without it", () => {
  const cases = new Set();
  for (const [shape, [cited, parts]] of Object.entries(SHAPES)) {
    assert.deepEqual(citedNames(cited), parts, shape);
    for (const [naming, code] of Object.entries(NAMINGS)) {
      const names = namesOf(`${code}\nconst outer = 1; class Outer {}`);
      assert.ok(
        citedNames(cited).every((name) => names.has(name)),
        `${shape} through ${naming}`,
      );
      cases.add(`${shape} × ${naming}`);
    }
    assert.ok(
      !citedNames(cited).every((name) => namesOf("const other = 1;").has(name)),
      `${shape} unresolved`,
    );
  }
  // Every shape met every naming.
  assert.equal(cases.size, Object.keys(SHAPES).length * Object.keys(NAMINGS).length);
});

test("code, file names, issues and SHAs in backticks cite no name", () => {
  for (const text of [
    "npm run check",
    '"text"',
    "a/b",
    ".foo-bar",
    'say "hi"',
    "42",
    "stagePhotos.ts",
    "bindings.jsonl.gz",
    "#123",
    "bf9b655a9",
    "x + 1",
  ])
    assert.deepEqual(citedNames(text), [], text);
  // A hex word without a digit is a name, and must resolve.
  assert.deepEqual(citedNames("defaced"), ["defaced"]);
});

test("a .vue file's scripts are the blocks Vue's parser finds, each with where it starts", () => {
  const text =
    '<template>\n<!-- <script>const hidden = 1;</script> -->\n</template>\n<script setup lang="ts" generic="T extends Array<string>">const a = 1;\n</script>\n<script\n data-x="const b = 2;"\n lang="ts">const b = 2;</script>\n';
  assert.deepEqual(
    scriptsOf("a.vue", text).map(({ text: script, lineOffset, columnOffset }) => ({
      script,
      lineOffset,
      columnOffset,
    })),
    [
      { script: "const a = 1;\n", lineOffset: 3, columnOffset: 58 },
      { script: "const b = 2;", lineOffset: 7, columnOffset: 11 },
    ],
  );
});
