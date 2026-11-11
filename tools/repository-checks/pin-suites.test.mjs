import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { NOT_PINS, builtOf, pinFormsOf, readMarks, suitesFor, testFiles } from "./pin-suites.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The repository's marks (`readMarks`). */
const MARKS = readMarks(ROOT);
const MARKED = MARKS.suites;
/** Each marked suite once, in path order. */
const SUITES = [...new Set(MARKED.map((suite) => suite.file))];
const WORK_B = "tests/type-core/type-core-work-b.test.ts";
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
 * The bounds a family module's `text` records, by line, and every occurrence of `main` or `measured` outside the
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
      else if (admitted.records) recorded.push(lineOf(node));
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
      (suite) => suite.file === "tests/type-core/type-core-contract.test.ts",
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
    ["tests/type-core/type-core-work-a.test.ts", "tests/type-core/type-core-work-c.test.ts"],
  );
  assert.deepEqual(
    suitesFor(MARKED, ["tests/helpers/type-core/families/property-names.ts"]).map(
      (suite) => suite.file,
    ),
    ["tests/type-core/type-core-work-c.test.ts"],
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
 * The net's findings under `root`: each test file a pin form finds that no mark names and `notPins` does not declare,
 * and each `notPins` file that is marked or holds no pin form.
 */
function netOf(root, suites, notPins) {
  const marked = new Set(suites.map((suite) => suite.file));
  const declared = new Set(notPins.map((entry) => entry.file));
  const formsOf = (file) => pinFormsOf(readFileSync(join(root, file), "utf8"));
  return [
    ...testFiles(root)
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
  assert.deepEqual(netOf(ROOT, MARKED, NOT_PINS), []);
});

test("the net names an unmarked pin, a marked file declared no pin, and a declaration with no pin form", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pin-suites-net-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "tests/digest.test.ts": '  upToOrder: "8ec84600facd682a",\n',
    "tests/marked.test.ts": "// pins: a total | line /total/u\n  assert.equal(r.total, 1234);\n",
    "tests/plain.test.ts": "const n = 12;\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const { suites } = readMarks(root);
  assert.deepEqual(netOf(root, suites, []), [
    "tests/digest.test.ts holds a pin form (digest) but carries no mark and is not in NOT_PINS (tools/repository-checks/pin-suites.mjs)",
  ]);
  assert.deepEqual(
    netOf(root, suites, [
      { file: "tests/digest.test.ts" },
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
      "// pins for tests/b.test.ts, tests/a.test.ts: shared bounds | line /^\\s*measured: \\d/u\n  measured: 3,\n",
    "tests/helpers/late.ts": "// a header\n  // pins: moved below it | line /x/u\nx\n",
    "tests/c.test.ts": "// pins a total, no line\nconst C = 1;\n",
    "tests/d.test.ts": "// pins: a bad line | line /(/u\n(\n",
    "tests/e.test.ts": "// pins: only itself | line /only itself/u\nconst E = 1;\n",
    "tests/helpers/f.ts": "// pins for tests/none.test.ts: nothing | line /^y/u\ny\n",
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
    ],
  );
  assert.deepEqual(faults, [
    "tests/c.test.ts:1: no mark: use // pins[ for <suite>, ...]: <what> | line /<regex>/",
    "tests/d.test.ts:1: the mark's line is no regex: Invalid regular expression: /(/u: Unterminated group",
    "tests/e.test.ts:1: no line of the file but the mark's own is a line /only itself/u finds",
    "tests/helpers/f.ts:1: tests/none.test.ts is no test file",
    "tests/helpers/late.ts:2: a mark is a file's first line",
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
    const lines = text.split("\n");
    const { recorded, escapes } = recordedBoundsOf(text);
    for (const { line, form } of escapes)
      failures.push(`${file}:${line}: ${form}, not a position a family may name it at`);
    for (const line of recorded) {
      const declarations = MARKED.filter(
        (suite) => suite.in === file && suite.pin.test(lines[line - 1]),
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
    recorded: [1, 4, 5, 6, 19],
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
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 22_962_573);"), ["total"]);
  assert.deepEqual(pinFormsOf("    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],"), [
    "table",
  ]);
  assert.deepEqual(pinFormsOf('  decide: [\n    6,\n    "a stopped decision\'s path"'), ["listed"]);
  assert.deepEqual(pinFormsOf('      upToOrder: "8ec84600facd682a",'), ["digest"]);
  // (the named limits: another assertion, a short total, a nested table)
  assert.deepEqual(pinFormsOf("  assert.strictEqual(budget.total, 22_962_573);"), []);
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 573);"), []);
  assert.deepEqual(pinFormsOf("    [7995, 60],\n    [7081, 60],"), []);
  // (a digest's limits: under 16 digits, in an array, in a comment)
  assert.deepEqual(pinFormsOf('  upToOrder: "8ec84600facd682",'), []);
  assert.deepEqual(pinFormsOf('  parts: ["0123456789abcdef"],'), []);
  assert.deepEqual(pinFormsOf(" * the set's records (set `486ac8093b597b45`)"), []);
});

test("the test files are the suite as the runner finds it: one folder down too, none in helpers/", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pin-suites-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["a.test.ts", "player/b.test.ts", "helpers/c.test.ts"]) {
    mkdirSync(join(root, "tests", file, ".."), { recursive: true });
    writeFileSync(join(root, "tests", file), "");
  }
  assert.deepEqual(testFiles(root), ["tests/a.test.ts", "tests/player/b.test.ts"]);
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
      "tools/test-shards.mjs",
      "tools/costly-test-files.mjs",
      // (and the marked files, the suites among them)
      ...new Set(MARKED.flatMap((suite) => [suite.file, suite.in ?? suite.file])),
    ]) {
      mkdirSync(join(directory, file, ".."), { recursive: true });
      copyFileSync(join(ROOT, file), join(directory, file));
    }
    mkdirSync(join(directory, "src/type-inference/core"), { recursive: true });
    writeFileSync(
      join(directory, "src/type-inference/core/answers.ts"),
      "export const answers = 1;\n",
    );
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
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
