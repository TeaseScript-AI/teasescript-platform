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

/**
 * The bounds a family module's `text` records, by line: each object literal's `main:` property whose value is an object
 * literal and `measured:` property whose value is a number. Every other value of those two properties is an escape,
 * named by its form, except a `measured` shorthand that an arrow returns as its object literal from its parameter's
 * destructured `measured` (whose records the walk reads where they are written).
 */
function recordedBoundsOf(text) {
  const source = ts.createSourceFile("family.ts", text, ts.ScriptTarget.Latest, true);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const recorded = [];
  const escapes = [];
  const forwarded = (property) => {
    let arrow = property.parent;
    while (arrow !== undefined && !ts.isFunctionLike(arrow)) arrow = arrow.parent;
    return (
      arrow !== undefined &&
      ts.isArrowFunction(arrow) &&
      ts.skipParentheses(arrow.body) === property.parent &&
      arrow.parameters.some(
        ({ name }) =>
          ts.isObjectBindingPattern(name) &&
          name.elements.some(
            (element) =>
              element.propertyName === undefined &&
              element.initializer === undefined &&
              element.dotDotDotToken === undefined &&
              ts.isIdentifier(element.name) &&
              element.name.text === "measured",
          ),
      )
    );
  };
  const visit = (node) => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      const computed = ts.isComputedPropertyName(node.name);
      const name = computed ? node.name.expression : node.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
      if (key === "main" || key === "measured") {
        const value = ts.isPropertyAssignment(node)
          ? ts.skipParentheses(node.initializer)
          : undefined;
        if (computed) escapes.push({ line: lineOf(node), form: "computed name" });
        else if (value === undefined) {
          if (key !== "measured" || !forwarded(node))
            escapes.push({ line: lineOf(node), form: "shorthand" });
        } else if (
          key === "main" ? ts.isObjectLiteralExpression(value) : ts.isNumericLiteral(value)
        )
          recorded.push(lineOf(node));
        else escapes.push({ line: lineOf(node), form: ts.SyntaxKind[value.kind] });
      }
    }
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
      failures.push(
        `${file}:${line}: main or measured with a ${form} value, not a bound the net can read`,
      );
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

test("a family's bounds are read from its syntax, and another value of main or measured is an escape", () => {
  const text = [
    "const a = { main: {",
    "  16: [[1, 2, 3]],",
    "} };",
    "const b = { main: { total: 2.7, invSteps: 3.8 } };",
    "const c = { measured: 3.37 };",
    "const d = [{ n: 8, measured: 2.78 }].map(({ n, measured }) => ({ n, measured }));",
    "// main: { total: 1 }, measured: 2",
    "const e = main(`let r = {main: {f: 1}, measured: 2}`);",
    'const f = { "measured": 3.1 };',
    "const g = { measured: M, main: MAIN };",
    "const h = { measured: 2 * x };",
    "const i = (measured) => ({ measured });",
    'const j = { ["measured"]: 3 };',
  ].join("\n");
  assert.deepEqual(recordedBoundsOf(text), {
    recorded: [1, 4, 5, 6, 9],
    escapes: [
      { line: 10, form: "Identifier" },
      { line: 10, form: "Identifier" },
      { line: 11, form: "BinaryExpression" },
      { line: 12, form: "shorthand" },
      { line: 13, form: "computed name" },
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
