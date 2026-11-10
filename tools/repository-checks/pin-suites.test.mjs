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
import { NOT_PINS, PIN_SUITES, builtOf, pinFormsOf, suitesFor, testFiles } from "./pin-suites.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Each declared suite once, in the list's order. */
const SUITES = [...new Set(PIN_SUITES.map((suite) => suite.file))];
const WORK_B = "tests/type-core/type-core-work-b.test.ts";
/** The folder whose families record `main`'s bounds (`WorkFamily.main`, `KnownProduct.measured`). */
const FAMILIES = "tests/helpers/type-core/families/";

/** The two property names a family records a bound under. */
const BOUND_NAMES = new Set(["main", "measured"]);

/**
 * The bounds a family module's `text` records, by line, and every other occurrence of `main` or `measured` as a property
 * name (`escapes`, each with its form). Every identifier, private name and string literal spelled so is classified by
 * its position, and an unknown position is an escape. Recorded: `main: <object literal>` and `measured: <numeric
 * literal>`. Admitted without a record: a type's property signature; a read (property or literal element access, a
 * destructuring without a rename or default); a variable so named where it is declared, imported, exported, a
 * parameter or called; a string elsewhere; and one forwarding shape (`forwardBroken`). Every object spread and every
 * computed name that is not a literal other than the two names is an escape too, since either can carry them unseen.
 */
function recordedBoundsOf(text) {
  const source = ts.createSourceFile("family.ts", text, ts.ScriptTarget.Latest, true);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const recorded = [];
  const escapes = [];
  const escape = (node, form) => escapes.push({ line: lineOf(node), form });
  const nameOf = (node) => (ts.isPrivateIdentifier(node) ? node.text.slice(1) : node.text);
  const isLiteralName = (node) => ts.isStringLiteralLike(node) || ts.isNumericLiteral(node);
  const classify = (node) => {
    const parent = node.parent;
    if (ts.isPropertyAssignment(parent) && parent.name === node) {
      const value = ts.skipParentheses(parent.initializer);
      if (
        nameOf(node) === "main" ? ts.isObjectLiteralExpression(value) : ts.isNumericLiteral(value)
      )
        recorded.push(lineOf(node));
      else escape(node, `a non-literal value (${ts.SyntaxKind[value.kind]})`);
    } else if (ts.isShorthandPropertyAssignment(parent)) {
      const broken = nameOf(node) === "measured" ? forwardBroken(parent) : "a shorthand of main";
      if (broken !== undefined) escape(node, broken);
    } else if (ts.isPropertySignature(parent) && parent.name === node) return;
    else if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
    ) {
      if (ts.isAssignmentTarget(parent)) escape(node, "an assignment");
      else if (ts.isDeleteExpression(ts.walkUpParenthesizedExpressions(parent.parent)))
        escape(node, "a delete");
    } else if (ts.isBindingElement(parent)) {
      if (parent.propertyName === node) escape(node, "a renaming destructuring");
      else if (parent.propertyName === undefined && parent.initializer !== undefined)
        escape(node, "a destructuring default");
    } else if (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent))
      escape(node, "a method");
    else if (ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent))
      escape(node, "an accessor");
    else if (ts.isPropertyDeclaration(parent)) escape(node, "a class member");
    else if (ts.isStringLiteralLike(node)) return;
    else if (
      ts.isVariableDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isParameter(parent) ||
      (ts.isCallExpression(parent) && parent.expression === node)
    )
      return;
    else escape(node, `an occurrence in a ${ts.SyntaxKind[parent.kind]}`);
  };
  /**
   * Why a shorthand `measured` is not passed on unchanged, or `undefined` when it is: an arrow returns its object
   * literal as its concise body, no parameter has an initializer, and `measured` occurs in the arrow only as one
   * element of a parameter's destructuring, without a rename, and this shorthand.
   */
  const forwardBroken = (shorthand) => {
    const literal = shorthand.parent;
    const arrow = ts.walkUpParenthesizedExpressions(literal.parent);
    const outside = "a shorthand outside the forwarding shape";
    if (!ts.isArrowFunction(arrow) || ts.skipParentheses(arrow.body) !== literal)
      return `${outside}: not an arrow's returned literal`;
    let initializer = false;
    const initialized = (node) => {
      if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer !== undefined)
        initializer = true;
      ts.forEachChild(node, initialized);
    };
    arrow.parameters.forEach(initialized);
    if (initializer) return `${outside}: a parameter initializer`;
    let elements = 0;
    let others = 0;
    const occurrences = (node) => {
      if (ts.isIdentifier(node) && node.text === "measured" && node !== shorthand.name) {
        const element = node.parent;
        if (
          ts.isBindingElement(element) &&
          element.name === node &&
          element.propertyName === undefined &&
          ts.isObjectBindingPattern(element.parent) &&
          ts.isParameter(element.parent.parent) &&
          element.parent.parent.parent === arrow
        )
          elements += 1;
        else others += 1;
      }
      ts.forEachChild(node, occurrences);
    };
    occurrences(arrow);
    if (elements !== 1 || others > 0)
      return `${outside}: measured elsewhere than one destructured parameter and the shorthand`;
    return undefined;
  };
  const visit = (node) => {
    if (ts.isSpreadAssignment(node)) escape(node, "an object spread");
    else if (
      ts.isComputedPropertyName(node) &&
      (!isLiteralName(node.expression) || BOUND_NAMES.has(node.expression.text))
    )
      escape(node, "a computed name");
    else if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) &&
      BOUND_NAMES.has(nameOf(node)) &&
      !ts.isComputedPropertyName(node.parent)
    )
      classify(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { recorded, escapes };
}

test("a core change lists every pinning suite; another change lists none, a suite's own change or its pins' file itself", () => {
  assert.deepEqual(
    suitesFor(["src/type-inference/core/admission/literals/join.ts"]).map((suite) => suite.file),
    SUITES,
  );
  // (the published answers' digests move with the core too: #2074 passed the local check and failed CI on
  // one, #2086)
  assert.ok(
    suitesFor(["src/type-inference/core/values.ts"]).some(
      (suite) => suite.file === "tests/type-core/type-core-contract.test.ts",
    ),
  );
  assert.deepEqual(suitesFor(["src/runtime/engine.ts", "docs/TESTING.md"]), []);
  assert.deepEqual(suitesFor(["src/type-inference/core-like.ts"]), []);
  assert.deepEqual(
    suitesFor(["tests/type-core/type-core-kept.test.ts"]).map((suite) => suite.file),
    ["tests/type-core/type-core-kept.test.ts"],
  );
  assert.deepEqual(
    suitesFor(["tests/helpers/type-core/families/output-bound.ts"]).map((suite) => suite.file),
    [WORK_B],
  );
  assert.deepEqual(
    suitesFor(["tests/helpers/type-core/families/admission-products.ts"]).map(
      (suite) => suite.file,
    ),
    ["tests/type-core/type-core-work-a.test.ts", "tests/type-core/type-core-work-c.test.ts"],
  );
  assert.deepEqual(
    suitesFor(["tests/helpers/type-core/families/property-names.ts"]).map((suite) => suite.file),
    ["tests/type-core/type-core-work-c.test.ts"],
  );
  // (work-b's pins are in two files: either lists it, and both list it once, with each declaration's pins)
  assert.deepEqual(
    suitesFor(["tests/helpers/type-core/families/w34-links.ts"]).map((suite) => suite.file),
    [WORK_B],
  );
  assert.deepEqual(
    suitesFor([
      "tests/helpers/type-core/families/w34-links.ts",
      "tests/helpers/type-core/families/output-bound.ts",
    ]),
    [
      {
        file: WORK_B,
        pins: PIN_SUITES.filter((suite) => suite.file === WORK_B)
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

test("the list is kept true: each file a pin form finds is declared, and each suite's pin is found", () => {
  const declared = new Set([...PIN_SUITES, ...NOT_PINS].map((entry) => entry.file));
  const unlisted = testFiles(ROOT).filter(
    (file) => !declared.has(file) && pinFormsOf(readFileSync(join(ROOT, file), "utf8")).length > 0,
  );
  assert.deepEqual(
    unlisted.map(
      (file) =>
        `${file} holds a pin form (${pinFormsOf(readFileSync(join(ROOT, file), "utf8")).join(", ")}) but is in neither PIN_SUITES nor NOT_PINS (tools/repository-checks/pin-suites.mjs)`,
    ),
    [],
  );
  for (const suite of PIN_SUITES) {
    const lines = readFileSync(join(ROOT, suite.in ?? suite.file), "utf8").split("\n");
    assert.ok(
      lines.some((line) => suite.pin.test(line)),
      `${suite.in ?? suite.file} holds no line ${suite.pin} finds (${suite.file})`,
    );
  }
  for (const { file } of NOT_PINS)
    assert.ok(
      pinFormsOf(readFileSync(join(ROOT, file), "utf8")).length > 0,
      `${file} holds no pin form: drop it from NOT_PINS`,
    );
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
      failures.push(`${file}:${line}: ${form}, not a bound the net can read`);
    for (const line of recorded) {
      const declarations = PIN_SUITES.filter(
        (suite) => suite.in === file && suite.pin.test(lines[line - 1]),
      );
      if (declarations.length === 0)
        failures.push(
          `${file}:${line} records a bound (${lines[line - 1].trim()}) no PIN_SUITES declaration with it as \`in\` finds (tools/repository-checks/pin-suites.mjs)`,
        );
      for (const suite of declarations) finding.add(suite);
    }
  }
  assert.deepEqual(failures, []);
  // (and each declaration of a family's file finds one of its recorded bounds)
  assert.deepEqual(
    PIN_SUITES.filter((suite) => suite.in?.startsWith(FAMILIES) && !finding.has(suite)).map(
      (suite) => `${suite.file} (${suite.in}): its pin ${suite.pin} finds no recorded bound`,
    ),
    [],
  );
});

test("a family's bounds are read from every occurrence of main or measured, and another form is an escape", () => {
  const text = [
    "const a = { main: {",
    "  16: [[1, 2, 3]],",
    "} };",
    "const b = { main: { total: 2.7, invSteps: 3.8 } };",
    "const c = { measured: 3.37 };",
    'const d = { "measured": 3.1 };',
    "const e = [{ n: 8, measured: 2.78 }].map(({ n, measured }) => ({ n, measured }));",
    "interface F { readonly main?: { total: number }; measured: number }",
    'const g = (f: F) => f.main?.total ?? f["measured"];',
    "// main: { total: 1 }, measured: 2",
    "export const main = (s: string) => [s];",
    'import { main as m } from "./builders.js";',
    "const h = main(`let r = {main: {f: 1}, measured: 2}`);",
    "const i = { measured: M, main: MAIN };",
    "const j = { measured: 2 * x };",
    "const k = { main() { return { total: 1, invSteps: 1 }; } };",
    "const l = { get main() { return { total: 3.9, invSteps: 4.1 }; } };",
    "const o = { ...p };",
    'const q = { [key]: 3, ["measured"]: 3 };',
    "p.measured = 4;",
    "delete p.main;",
    "const { measured: r } = p;",
    "const { measured = 2 } = p;",
    "class S { main = 1; #measured = 2 }",
    "const t = ({ name, measured }: K): K => ({ name: (measured = 9, name), measured });",
    "const u = ({ measured }) => { return { measured }; };",
    "const v = ({ n = 1, measured }) => ({ measured });",
    "const w = (measured) => ({ measured });",
    "const x = { main };",
  ].join("\n");
  const outside = "a shorthand outside the forwarding shape";
  assert.deepEqual(recordedBoundsOf(text), {
    recorded: [1, 4, 5, 6, 7],
    escapes: [
      { line: 14, form: "a non-literal value (Identifier)" },
      { line: 14, form: "a non-literal value (Identifier)" },
      { line: 15, form: "a non-literal value (BinaryExpression)" },
      { line: 16, form: "a method" },
      { line: 17, form: "an accessor" },
      { line: 18, form: "an object spread" },
      { line: 19, form: "a computed name" },
      { line: 19, form: "a computed name" },
      { line: 20, form: "an assignment" },
      { line: 21, form: "a delete" },
      { line: 22, form: "a renaming destructuring" },
      { line: 23, form: "a destructuring default" },
      { line: 24, form: "a class member" },
      { line: 24, form: "a class member" },
      { line: 25, form: "an occurrence in a BinaryExpression" },
      {
        line: 25,
        form: `${outside}: measured elsewhere than one destructured parameter and the shorthand`,
      },
      { line: 26, form: `${outside}: not an arrow's returned literal` },
      { line: 27, form: `${outside}: a parameter initializer` },
      {
        line: 28,
        form: `${outside}: measured elsewhere than one destructured parameter and the shorthand`,
      },
      { line: 29, form: "a shorthand of main" },
    ],
  });
});

test("the three pin forms are found by their text, and a pin written another way is not", () => {
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 22_962_573);"), ["total"]);
  assert.deepEqual(pinFormsOf("    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],"), [
    "table",
  ]);
  assert.deepEqual(pinFormsOf('  decide: [\n    6,\n    "a stopped decision\'s path"'), ["listed"]);
  // (the named limits: another assertion, a short total, a nested table)
  assert.deepEqual(pinFormsOf("  assert.strictEqual(budget.total, 22_962_573);"), []);
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 573);"), []);
  assert.deepEqual(pinFormsOf("    [7995, 60],\n    [7081, 60],"), []);
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
    ])
      copyFileSync(join(ROOT, file), join(directory, file));
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
