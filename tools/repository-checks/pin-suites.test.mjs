import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { NOT_PINS, builtOf, pinFormsOf, readMarks, suitesFor, testFiles } from "./pin-suites.mjs";
import { isolateGit } from "../fixture-git.mjs";

isolateGit();

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The repository's marks (`readMarks`). */
const MARKS = readMarks(ROOT);
const MARKED = MARKS.suites;
/** Each marked suite once, in path order. */
const SUITES = [...new Set(MARKED.map((suite) => suite.file))];
const WORK_B = "tests/type-core/work/type-core-work-b.test.ts";
/** The folder whose families record `main`'s bounds (`WorkFamily.main`, `KnownProduct.measured`). */
const FAMILIES = "tests/helpers/type-core/families/";

/** The two property names a family records a bound under. */
const BOUND_NAMES = new Set(["main", "measured"]);

/**
 * The syntactic positions `main` or `measured` may take in a family module, each by name; `records` marks the two that
 * record a bound. Any other position is an escape.
 */
const ADMITTED = [
  {
    position: "a record of main",
    records: true,
    test: (node, parent, name) =>
      name === "main" &&
      ts.isPropertyAssignment(parent) &&
      parent.name === node &&
      ts.isObjectLiteralExpression(parent.initializer),
  },
  {
    position: "a record of measured",
    records: true,
    test: (node, parent, name) =>
      name === "measured" &&
      ts.isPropertyAssignment(parent) &&
      parent.name === node &&
      ts.isNumericLiteral(parent.initializer),
  },
  {
    position: "a property signature",
    test: (node, parent) => ts.isPropertySignature(parent) && parent.name === node,
  },
  {
    position: "the main builder's declared, imported or exported binding",
    test: (node, parent, name) =>
      name === "main" &&
      ts.isIdentifier(node) &&
      ((ts.isVariableDeclaration(parent) && parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent)),
  },
  {
    position: "a call of the main builder",
    test: (node, parent, name) =>
      name === "main" &&
      ts.isIdentifier(node) &&
      ts.isCallExpression(parent) &&
      parent.expression === node,
  },
];

/**
 * The bounds a family module's `text` records, each by its record's first and last line, and every occurrence of `main` or `measured` outside the
 * `ADMITTED` positions (`escapes`, each with its name and syntactic role). Every identifier, private name, string and
 * template without substitutions spelled so in the code (each node `forEachChild` reaches; comments are not read) is
 * classified; every object spread and every computed name that is not a literal is an escape.
 */
function recordedBoundsOf(text) {
  const source = ts.createSourceFile("family.ts", text, ts.ScriptTarget.Latest, true);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const recorded = [];
  const escapes = [];
  const escape = (node, form) => escapes.push({ line: lineOf(node), form });
  const nameOf = (node) => (ts.isPrivateIdentifier(node) ? node.text.slice(1) : node.text);
  const roleOf = (node, parent) => {
    const what = ts.isIdentifier(node)
      ? "an identifier"
      : ts.isPrivateIdentifier(node)
        ? "a private name"
        : "a string";
    return ts.isPropertyAssignment(parent) && parent.name === node
      ? `${what} naming a property, value ${ts.SyntaxKind[parent.initializer.kind]}`
      : `${what} in ${ts.SyntaxKind[parent.kind]}`;
  };
  const visit = (node) => {
    if (ts.isSpreadAssignment(node)) escape(node, "an object spread");
    else if (
      ts.isComputedPropertyName(node) &&
      !ts.isStringLiteralLike(node.expression) &&
      !ts.isNumericLiteral(node.expression)
    )
      escape(node, "a computed name");
    else if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) &&
      BOUND_NAMES.has(nameOf(node))
    ) {
      const name = nameOf(node);
      const admitted = ADMITTED.find((entry) => entry.test(node, node.parent, name));
      if (admitted === undefined) escape(node, `${name}: ${roleOf(node, node.parent)}`);
      else if (admitted.records)
        recorded.push([
          lineOf(node),
          source.getLineAndCharacterOfPosition(node.parent.getEnd()).line + 1,
        ]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { recorded, escapes };
}

test("a core change lists every pinning suite; another change lists none, a suite's own change or its pins' file itself", () => {
  assert.deepEqual(
    suitesFor(MARKED, ["src/type-inference/core/admission/literals/join.ts"]).map(
      (suite) => suite.file,
    ),
    SUITES,
  );
  // (the published answers' digests move with the core too: #2074 passed the local check and failed CI on
  // one, #2086)
  assert.ok(
    suitesFor(MARKED, ["src/type-inference/core/values.ts"]).some(
      (suite) => suite.file === "tests/type-core/contract/type-core-contract.test.ts",
    ),
  );
  assert.deepEqual(suitesFor(MARKED, ["src/runtime/engine.ts", "docs/TESTING.md"]), []);
  assert.deepEqual(suitesFor(MARKED, ["src/type-inference/core-like.ts"]), []);
  assert.deepEqual(
    suitesFor(MARKED, ["tests/type-core/type-core-kept.test.ts"]).map((suite) => suite.file),
    ["tests/type-core/type-core-kept.test.ts"],
  );
  assert.deepEqual(
    suitesFor(MARKED, ["tests/helpers/type-core/families/output-bound.ts"]).map(
      (suite) => suite.file,
    ),
    [WORK_B],
  );
  assert.deepEqual(
    suitesFor(MARKED, ["tests/helpers/type-core/families/admission-products.ts"]).map(
      (suite) => suite.file,
    ),
    [
      "tests/type-core/work/type-core-work-c.test.ts",
      "tests/type-core/work/type-core-work-families.test.ts",
    ],
  );
  assert.deepEqual(
    suitesFor(MARKED, ["tests/helpers/type-core/families/property-names.ts"]).map(
      (suite) => suite.file,
    ),
    ["tests/type-core/work/type-core-work-c.test.ts"],
  );
  // (work-b's pins are in two files: either lists it, and both list it once, with each declaration's pins)
  assert.deepEqual(
    suitesFor(MARKED, ["tests/helpers/type-core/families/w34-links.ts"]).map((suite) => suite.file),
    [WORK_B],
  );
  assert.deepEqual(
    suitesFor(MARKED, [
      "tests/helpers/type-core/families/w34-links.ts",
      "tests/helpers/type-core/families/output-bound.ts",
    ]),
    [
      {
        file: WORK_B,
        pins: MARKED.filter((suite) => suite.file === WORK_B)
          .map((suite) => suite.pins)
          .join("; "),
      },
    ],
  );
  assert.equal(
    builtOf("tests/type-core/type-core-closure.test.ts"),
    "dist/tests/type-core/type-core-closure.test.js",
  );
});

/**
 * The net's findings under `root`: each `.ts` file of `readMarks`'s that a pin form finds, no mark names or holds and
 * `notPins` does not declare,
 * and each `notPins` file that is marked or holds no pin form.
 */
function netOf(root, { suites, files }, notPins) {
  const marked = new Set(suites.flatMap((suite) => [suite.file, suite.in ?? suite.file]));
  const declared = new Set(notPins.map((entry) => entry.file));
  const formsOf = (file) => pinFormsOf(readFileSync(join(root, file), "utf8"), file);
  return [
    ...files
      .filter((file) => !marked.has(file) && !declared.has(file) && formsOf(file).length > 0)
      .map(
        (file) =>
          `${file} holds a pin form (${formsOf(file).join(", ")}) but carries no mark and is not in NOT_PINS (tools/repository-checks/pin-suites.mjs)`,
      ),
    ...[...declared].flatMap((file) => [
      ...(marked.has(file) ? [`${file} is marked: drop it from NOT_PINS`] : []),
      ...(formsOf(file).length === 0 ? [`${file} holds no pin form: drop it from NOT_PINS`] : []),
    ]),
  ];
}

test("the marks are kept true: each reads, and each test file a pin form finds is marked or declared no pin", () => {
  assert.deepEqual(MARKS.faults, []);
  assert.deepEqual(netOf(ROOT, MARKS, NOT_PINS), []);
});

/** A mark's `{file, in}` pair: the suite, and the file holding its pins when that is another. */
function pairOf({ file, in: holder }) {
  return holder === undefined ? file : `${file} in ${holder}`;
}

// The selection (`suitesFor`) is a function of the `{file, in}` pairs returned by `readMarks`, the reader the CLI calls.
// The test below reads them with it over the repository and compares them with PAIRS as a set, so no change alters
// the selection while it passes except an edit to PAIRS, which is the acknowledgement (the net misses formless pins).
const PAIRS = [
  "tests/type-core/candidate/type-core-candidate-operands.test.ts",
  "tests/type-core/type-core-closure.test.ts",
  "tests/type-core/type-core-contract-capture.test.ts",
  "tests/type-core/contract/type-core-contract.test.ts",
  "tests/type-core/type-core-declared-escapes.test.ts in tests/helpers/type-core/type-core-declared-escapes-main.ts",
  "tests/type-core/discharge/type-core-f18.test.ts",
  "tests/type-core/type-core-identity.test.ts",
  "tests/type-core/type-core-kept.test.ts",
  "tests/type-core/type-core-key-ids.test.ts",
  "tests/type-core/work/type-core-work-b.test.ts in tests/helpers/type-core/families/output-bound.ts",
  "tests/type-core/work/type-core-work-b.test.ts in tests/helpers/type-core/families/w34-links.ts",
  "tests/type-core/work/type-core-work-c.test.ts",
  "tests/type-core/work/type-core-work-c.test.ts in tests/helpers/type-core/families/admission-products.ts",
  "tests/type-core/work/type-core-work-c.test.ts in tests/helpers/type-core/families/narrowing.ts",
  "tests/type-core/work/type-core-work-c.test.ts in tests/helpers/type-core/families/property-names.ts",
  "tests/type-core/written/type-core-written-default.test.ts",
  "tests/type-core/work/type-core-work-families.test.ts in tests/helpers/type-core/families/admission-products.ts",
  "tests/type-core/work/type-core-work-store-checks.test.ts",
];

test("the marks name exactly the expected suites and the files holding their pins (#2094)", () => {
  const read = MARKED.map(pairOf);
  assert.deepEqual(
    {
      gained: read.filter((pair) => !PAIRS.includes(pair)),
      lost: PAIRS.filter((pair) => !read.includes(pair)),
    },
    { gained: [], lost: [] },
    "the marks' suites changed; if that is meant, change the list here (PAIRS)",
  );
});

test("the net names an unmarked pin, a marked file declared no pin, and a declaration with no pin form", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pin-suites-net-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "tests/type-core/digest.test.ts": '  upToOrder: "8ec84600facd682a",\n',
    "tests/marked.test.ts": "// pins: a total | line /total/u\n  assert.equal(r.total, 1234);\n",
    "tests/plain.test.ts": "const n = 12;\n",
    // (a helper's digest under a mark wrapped in a block comment, and under none: each is a pin with no mark)
    "tests/helpers/type-core/type-core-wrapped.ts":
      '/* // pins for tests/marked.test.ts: a digest | line /^\\s*natural: "[0-9a-f]{16}",/u */\n  natural: "8ec84600facd682a",\n',
    "tests/helpers/type-core/type-core-unmarked.ts": '  natural: "8ec84600facd682a",\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const marks = readMarks(root);
  assert.deepEqual(marks.faults, []);
  assert.deepEqual(
    netOf(root, marks, []),
    [
      "tests/helpers/type-core/type-core-unmarked.ts",
      "tests/helpers/type-core/type-core-wrapped.ts",
      "tests/type-core/digest.test.ts",
    ].map(
      (file) =>
        `${file} holds a pin form (digest) but carries no mark and is not in NOT_PINS (tools/repository-checks/pin-suites.mjs)`,
    ),
  );
  assert.deepEqual(
    netOf(root, marks, [
      { file: "tests/helpers/type-core/type-core-unmarked.ts" },
      { file: "tests/helpers/type-core/type-core-wrapped.ts" },
      { file: "tests/type-core/digest.test.ts" },
      { file: "tests/marked.test.ts" },
      { file: "tests/plain.test.ts" },
    ]),
    [
      "tests/marked.test.ts is marked: drop it from NOT_PINS",
      "tests/plain.test.ts holds no pin form: drop it from NOT_PINS",
    ],
  );
});

test("a mark is read from a file's first line only, whole, naming test files, and finding a line besides itself", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pin-suites-marks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "tests/b.test.ts": "// pins: b's total | line /^const B\\b/u\nconst B = 1;\n",
    "tests/a.test.ts": "import x from 'x';\n",
    // (a helper's mark names the suites its pins run in, each once, in path order)
    "tests/helpers/h.ts":
      "// pins for tests/b.test.ts, tests/a.test.ts: shared bounds | line /^\\s*measured: \\d/u\nconst h = {\n  measured: 3,\n};\n",
    "tests/helpers/late.ts": "// a header\n  // pins: moved below it | line /x/u\nx\n",
    "tests/c.test.ts": "// pins a total, no line\nconst C = 1;\n",
    "tests/d.test.ts": "// pins: a bad line | line /(/u\n(\n",
    "tests/e.test.ts": "// pins: only itself | line /only itself/u\nconst E = 1;\n",
    "tests/helpers/f.ts": "// pins for tests/none.test.ts: nothing | line /^y/u\ny = 1\n",
    // (a regex that also finds a declaration, which outlives the values below it)
    "tests/decl.test.ts":
      "// pins: a table | line /^const T\\b|^\\s+\\d+,$/u\nconst T = [\n  1,\n];\n",
    // (digits that are no literal value: in a comment, a type's name, a name, a text that is no digest)
    "tests/v1.test.ts": "// pins: a comment | line /^const C\\b/u\nconst C = []; // 64\n",
    "tests/v2.test.ts": "// pins: a type | line /^type T2\\b/u\ntype T2 = Array<number>;\n",
    "tests/v3.test.ts": "// pins: a name | line /^const T/u\nconst Tα2 = x;\n",
    "tests/v4.test.ts": '// pins: a text | line /^const S\\b/u\nconst S = "version 64";\n',
    "tests/v5.test.ts": "// pins: a literal type | line /^type W\\b/u\ntype W = 1234;\n",
    // (a marked file that does not parse, whose values cannot be read)
    "tests/v6.test.ts": "// pins: a broken file | line /^const B\\b/u\nconst B = ;\n",
    // (a file with CRLF line ends reads as one with LF, its mark and its pin line alike)
    "tests/crlf.test.ts": "// pins: a crlf total | line /^const A=1;$/u\r\nconst A=1;\r\n",
    "tests/g.test.ts": "// pins: a stateful line | line /x/gu\nx\n",
    // (only `.ts` files hold marks: a generator's source text is not read)
    "tests/families/area/gen.mjs": "export const s = `\n// pins: in a source | line /x/u\nx`;\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const { suites, faults } = readMarks(root);
  assert.deepEqual(
    suites.map(({ file, pins, pin, in: holder }) => ({ file, pins, pin: String(pin), in: holder })),
    [
      {
        file: "tests/a.test.ts",
        pins: "shared bounds",
        pin: "/^\\s*measured: \\d/u",
        in: "tests/helpers/h.ts",
      },
      { file: "tests/b.test.ts", pins: "b's total", pin: "/^const B\\b/u", in: undefined },
      {
        file: "tests/b.test.ts",
        pins: "shared bounds",
        pin: "/^\\s*measured: \\d/u",
        in: "tests/helpers/h.ts",
      },
      { file: "tests/crlf.test.ts", pins: "a crlf total", pin: "/^const A=1;$/u", in: undefined },
    ],
  );
  assert.deepEqual(faults, [
    "tests/c.test.ts:1: no mark: use // pins[ for <suite>, ...]: <what> | line /<regex>/",
    "tests/d.test.ts:1: the mark's line is no regex: Invalid regular expression: /(/u: Unterminated group",
    "tests/decl.test.ts:1: /^const T\\b|^\\s+\\d+,$/u finds line 2, which holds no numeric or hex digest literal",
    "tests/e.test.ts:1: no line of the file but the mark's own is a line /only itself/u finds",
    "tests/g.test.ts:1: the mark's line takes no g or y flag",
    "tests/helpers/f.ts:1: tests/none.test.ts is no test file",
    "tests/helpers/late.ts:2: a mark is a file's first line",
    "tests/v1.test.ts:1: /^const C\\b/u finds line 2, which holds no numeric or hex digest literal",
    "tests/v2.test.ts:1: /^type T2\\b/u finds line 2, which holds no numeric or hex digest literal",
    "tests/v3.test.ts:1: /^const T/u finds line 2, which holds no numeric or hex digest literal",
    "tests/v4.test.ts:1: /^const S\\b/u finds line 2, which holds no numeric or hex digest literal",
    "tests/v5.test.ts:1: /^type W\\b/u finds line 2, which holds no numeric or hex digest literal",
    "tests/v6.test.ts:1: the file does not parse, so its values cannot be read",
  ]);
});

test("every bound a family records is a line some declaration's pin finds in that file", () => {
  const files = readdirSync(join(ROOT, FAMILIES), { recursive: true })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${FAMILIES}${name}`);
  assert.ok(files.includes(`${FAMILIES}w34-links.ts`), `${FAMILIES} is read`);
  const failures = [];
  const finding = new Set();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const lines = text.split(/\r?\n/u);
    const { recorded, escapes } = recordedBoundsOf(text);
    for (const { line, form } of escapes)
      failures.push(`${file}:${line}: ${form}, not a position a family may name it at`);
    // (a mark finds a record where it finds one of its lines: a record's values may sit below its name)
    for (const [line, end] of recorded) {
      const declarations = MARKED.filter(
        (suite) =>
          suite.in === file && lines.slice(line - 1, end).some((each) => suite.pin.test(each)),
      );
      if (declarations.length === 0)
        failures.push(
          `${file}:${line} records a bound (${lines[line - 1].trim()}) no mark of that file finds (its first line)`,
        );
      for (const suite of declarations) finding.add(suite);
    }
  }
  assert.deepEqual(failures, []);
  // (and each mark of a family's file finds one of its recorded bounds)
  assert.deepEqual(
    MARKED.filter((suite) => suite.in?.startsWith(FAMILIES) && !finding.has(suite)).map(
      (suite) => `${suite.file} (${suite.in}): its pin ${suite.pin} finds no recorded bound`,
    ),
    [],
  );
});

test("main and measured occur in a family only at an admitted position; any other is an escape", () => {
  const text = [
    "const a = { main: {",
    "  16: [[1, 2, 3]],",
    "} };",
    "const b = { main: { total: 2.7, invSteps: 3.8 } };",
    "const c = { measured: 3.37 };",
    'const d = { "measured": 3.1 };',
    "interface F { readonly main?: { total: number }; measured: number }",
    "export const main = (s: string) => [s];",
    'import { main as m } from "./builders.js";',
    "export { m as main };",
    "const e = main(`let r = {main: {f: 1}, measured: 2}`);",
    "// main: { total: 1 }, measured: 2",
    'Object.defineProperty(f, "main", { value: { total: 3.9, invSteps: 4.1 } });',
    "(f.measured as number) = 9;",
    "const g = ({ ...measured }: any): any => ({ measured });",
    "const h = { get main() { return { total: 3.9, invSteps: 4.1 }; } };",
    "const t = ({ name, measured }: K): K => ({ name: (measured = 9, name), measured });",
    "const v = ({ n = 1, measured }) => ({ measured });",
    "const w = [{ n: 8, measured: 2.78 }].map(({ n, measured }) => ({ n, measured }));",
    "const i = { measured: M, main: MAIN };",
    "const j = { main() { return 1; } };",
    "const o = { ...p };",
    'const q = { [key]: 3, ["measured"]: 3 };',
    "delete p.main;",
    'const r = p["measured"];',
    'const s = "measured";',
    "const u = (measured: number) => measured;",
    "const { measured: x } = p;",
    "class S { main = 1; #measured = 2 }",
    "const y = { main };",
    "const measured = 1;",
    'import { measured } from "./x.js";',
    "measured();",
    "f(main);",
    "const x = main;",
  ].join("\n");
  assert.deepEqual(recordedBoundsOf(text), {
    recorded: [
      [1, 3],
      [4, 4],
      [5, 5],
      [6, 6],
      [19, 19],
    ],
    escapes: [
      // (#2252's Sol r2: a literal key passed as a string, a write through `as`, an object rest forwarded)
      { line: 13, form: "main: a string in CallExpression" },
      { line: 14, form: "measured: an identifier in PropertyAccessExpression" },
      { line: 15, form: "measured: an identifier in BindingElement" },
      { line: 15, form: "measured: an identifier in ShorthandPropertyAssignment" },
      // (Sol r1: an accessor, a forward reassigned in its literal or by a sibling default, the forward itself)
      { line: 16, form: "main: an identifier in GetAccessor" },
      { line: 17, form: "measured: an identifier in BindingElement" },
      { line: 17, form: "measured: an identifier in BinaryExpression" },
      { line: 17, form: "measured: an identifier in ShorthandPropertyAssignment" },
      { line: 18, form: "measured: an identifier in BindingElement" },
      { line: 18, form: "measured: an identifier in ShorthandPropertyAssignment" },
      { line: 19, form: "measured: an identifier in BindingElement" },
      { line: 19, form: "measured: an identifier in ShorthandPropertyAssignment" },
      { line: 20, form: "measured: an identifier naming a property, value Identifier" },
      { line: 20, form: "main: an identifier naming a property, value Identifier" },
      { line: 21, form: "main: an identifier in MethodDeclaration" },
      { line: 22, form: "an object spread" },
      { line: 23, form: "a computed name" },
      { line: 23, form: "measured: a string in ComputedPropertyName" },
      { line: 24, form: "main: an identifier in PropertyAccessExpression" },
      { line: 25, form: "measured: a string in ElementAccessExpression" },
      { line: 26, form: "measured: a string in VariableDeclaration" },
      { line: 27, form: "measured: an identifier in Parameter" },
      { line: 27, form: "measured: an identifier in ArrowFunction" },
      { line: 28, form: "measured: an identifier in BindingElement" },
      { line: 29, form: "main: an identifier in PropertyDeclaration" },
      { line: 29, form: "measured: a private name in PropertyDeclaration" },
      { line: 30, form: "main: an identifier in ShorthandPropertyAssignment" },
      // (the binding and callee positions are main's, by name and role: not measured's, not an argument or a value)
      { line: 31, form: "measured: an identifier in VariableDeclaration" },
      { line: 32, form: "measured: an identifier in ImportSpecifier" },
      { line: 33, form: "measured: an identifier in CallExpression" },
      { line: 34, form: "main: an identifier in CallExpression" },
      { line: 35, form: "main: an identifier in VariableDeclaration" },
    ],
  });
});

test("the four pin forms are found by their text, and a pin written another way is not", () => {
  const CONTRACT = "tests/type-core/contract/type-core-contract.test.ts";
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 22_962_573);", CONTRACT), ["total"]);
  assert.deepEqual(
    pinFormsOf("    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],", CONTRACT),
    ["table"],
  );
  assert.deepEqual(pinFormsOf('  decide: [\n    6,\n    "a stopped decision\'s path"', CONTRACT), [
    "listed",
  ]);
  assert.deepEqual(pinFormsOf('      upToOrder: "8ec84600facd682a",', CONTRACT), ["digest"]);
  // (the named limits: another assertion, a short total, a nested table)
  assert.deepEqual(pinFormsOf("  assert.strictEqual(budget.total, 22_962_573);", CONTRACT), []);
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 573);", CONTRACT), []);
  assert.deepEqual(pinFormsOf("    [7995, 60],\n    [7081, 60],", CONTRACT), []);
  // (a digest's limits: under 16 digits, in an array, in a comment)
  assert.deepEqual(pinFormsOf('  upToOrder: "8ec84600facd682",', CONTRACT), []);
  assert.deepEqual(pinFormsOf('  parts: ["0123456789abcdef"],', CONTRACT), []);
  assert.deepEqual(pinFormsOf(" * the set's records (set `486ac8093b597b45`)", CONTRACT), []);
  // (and only in the type core's tests: there, by folder or by the name they had before it, not in the Player's)
  const digest =
    '  randomness: "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a",';
  assert.deepEqual(pinFormsOf(digest, "tests/type-core-contract.test.ts"), ["digest"]);
  assert.deepEqual(
    pinFormsOf(digest, "tests/type-core/enforcement/type-enforcement-variables.test.ts"),
    ["digest"],
  );
  assert.deepEqual(pinFormsOf(digest, "tests/player/player-encryption.test.ts"), []);
});

test("the test files are the suite as the runner finds it: two folders down too, none in helpers/", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pin-suites-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["a.test.ts", "player/b.test.ts", "player/d/e.test.ts", "helpers/c.test.ts"]) {
    mkdirSync(join(root, "tests", file, ".."), { recursive: true });
    writeFileSync(join(root, "tests", file), "");
  }
  assert.deepEqual(testFiles(root), [
    "tests/a.test.ts",
    "tests/player/b.test.ts",
    "tests/player/d/e.test.ts",
  ]);
});

test("an option the tool does not take is refused, not ignored", () => {
  const tool = join(ROOT, "tools/repository-checks/pin-suites.mjs");
  for (const args of [["--check-grounds"], ["--base"], ["--run", "extra"]]) {
    const run = spawnSync(process.execPath, [tool, ...args], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /use \[--base <ref>\] \[--run\]/u);
  }
});

test("a file moved out of the core lists every pinning suite (#2049)", { timeout: 30_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "pin-suites-"));
  const git = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  try {
    mkdirSync(join(directory, "tools/repository-checks"), { recursive: true });
    // (the tool, and the modules it reads the suite's test files through)
    for (const file of [
      "tools/repository-checks/pin-suites.mjs",
      "tools/test-runner/test-shards.mjs",
      "tools/test-runner/costly-test-files.mjs",
      // (and the marked files, the suites among them)
      ...new Set(MARKED.flatMap((suite) => [suite.file, suite.in ?? suite.file])),
    ]) {
      mkdirSync(join(directory, file, ".."), { recursive: true });
      copyFileSync(join(ROOT, file), join(directory, file));
    }
    // (the tool reads its marks with ts-morph, from the repository's own dependencies)
    symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"));
    mkdirSync(join(directory, "src/type-inference/core"), { recursive: true });
    writeFileSync(
      join(directory, "src/type-inference/core/answers.ts"),
      "export const answers = 1;\n",
    );
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("mv", "src/type-inference/core/answers.ts", "src/type-inference/answers.ts");
    const run = spawnSync(
      process.execPath,
      ["tools/repository-checks/pin-suites.mjs", "--base", "HEAD"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(`1 core file changed .*; ${SUITES.length} pinning suites:`, "u"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
