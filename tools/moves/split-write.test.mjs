import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "../fixture-git.mjs";

isolateGit();

const TOOL = fileURLToPath(new URL("./split-write.mjs", import.meta.url));
const RECONSTRUCT = fileURLToPath(new URL("../reconstruct-move.mjs", import.meta.url));
const OLD_PATH = "tests/split/old.test.ts";
const A = "tests/split/a.test.ts";
const B = "tests/split/b.test.ts";
const SETUP = "tests/helpers/split-setup.ts";

/** The old file: a pin mark, four kinds of import, a type, three declarations and two tests (line numbers matter). */
const OLD = [
  '// pins: the pair | line /^test\\("a pair"/u',
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import "./setup-effect.js";',
  'import { double, type Unit } from "../lib/numbers.js";',
  "",
  "/** A unit of one. */",
  "interface One {",
  "  readonly unit: Unit;",
  "}",
  "",
  "const ONE: One = { unit: 1 };",
  "",
  "/** The shared twice. */",
  "function twice(value: number): number {",
  "  return double(value) + ONE.unit - 1;",
  "}",
  "",
  "const PAIR = [1, 2];",
  "",
  "/* The first file's tests. */",
  "",
  'test("a pair", () => {',
  "  assert.deepEqual(PAIR.map(twice), [2, 4]);",
  "});",
  "",
  'test("one", () => {',
  "  const one: One = ONE;",
  "  assert.equal(twice(one.unit), 2);",
  "});",
  "",
].join("\n");

/** The assignment: test 1 and the pin mark to A, test 2 to B (no header: it keeps OLD's docblock). */
const ASSIGN = {
  old: OLD_PATH,
  setup: { path: SETUP, header: "The shared values." },
  files: {
    [A]: { header: "The pair.", tests: [1], lines: [[1, 1]] },
    [B]: { header: null, tests: [2] },
  },
};

/** A repository whose one commit holds OLD (and `extra` files); `run` writes `assign` and runs the tool. */
function repository(t, old = OLD, extra = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "split-write-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
  git("init", "-q");
  for (const [file, text] of Object.entries({ [OLD_PATH]: old, ...extra })) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    writeFileSync(join(fixture, file), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const run = (assign, ...args) => {
    writeFileSync(join(fixture, "assign.json"), JSON.stringify(assign));
    const result = spawnSync(process.execPath, [TOOL, "assign.json", ...args], {
      cwd: fixture,
      encoding: "utf8",
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  const read = (file) => readFileSync(join(fixture, file), "utf8");
  const changed = () => git("status", "--short", "--", "tests");
  return { fixture, base, run, read, changed };
}

test("a split is written as assigned: lines verbatim in OLD's order, exports, imports by name, headers, the pin mark", (t) => {
  const r = repository(t);
  const result = r.run(ASSIGN);
  assert.equal(result.status, 0, result.err);
  assert.equal(
    r.read(SETUP),
    [
      "// The shared values.",
      "",
      'import "../split/setup-effect.js";',
      'import { double, type Unit } from "../lib/numbers.js";',
      "",
      "/** A unit of one. */",
      "export interface One {",
      "  readonly unit: Unit;",
      "}",
      "",
      "export const ONE: One = { unit: 1 };",
      "",
      "/** The shared twice. */",
      "export function twice(value: number): number {",
      "  return double(value) + ONE.unit - 1;",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(
    r.read(A),
    [
      '// pins: the pair | line /^test\\("a pair"/u',
      "// The pair.",
      "",
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import "./setup-effect.js";',
      'import { twice } from "../helpers/split-setup.js";',
      "",
      "const PAIR = [1, 2];",
      "",
      "/* The first file's tests. */",
      "",
      'test("a pair", () => {',
      "  assert.deepEqual(PAIR.map(twice), [2, 4]);",
      "});",
      "",
    ].join("\n"),
  );
  assert.match(
    r.read(B),
    /^import assert from "node:assert\/strict";\nimport test from "node:test";\nimport "\.\/setup-effect\.js";\nimport \{ type One, ONE, twice \} from "\.\.\/helpers\/split-setup\.js";\n\ntest\("one"/u,
  );
  assert.equal(existsSync(join(r.fixture, OLD_PATH)), false);
  // (the result is a whole-line move, the pin mark carried)
  const check = spawnSync(process.execPath, [RECONSTRUCT, r.base, OLD_PATH, SETUP, A, B], {
    cwd: r.fixture,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /^header carried: tests\/split\/a\.test\.ts:1 <- old 1$/mu);
  // (written again from the base after a change of assignment: a range puts PAIR in the setup, which exports it)
  const again = r.run({ ...ASSIGN, setup: { ...ASSIGN.setup, lines: [[19, 19]] } });
  assert.equal(again.status, 0, again.err);
  assert.match(r.read(SETUP), /^export const PAIR = \[1, 2\];$/mu);
  assert.match(r.read(A), /^import \{ twice, PAIR \} from "\.\.\/helpers\/split-setup\.js";$/mu);
});

test("--list prints each statement: a test's number and title, a declaration's names and what it reads", (t) => {
  const r = repository(t);
  const listed = r.run(ASSIGN, "--list");
  assert.equal(listed.status, 0, listed.err);
  assert.match(listed.out, /^15-17 twice reads: ONE$/mu);
  assert.match(listed.out, /^27-30 test 2: one$/mu);
  assert.equal(r.changed(), "");
});

test("an assignment the split cannot follow is refused, and nothing is written", (t) => {
  const r = repository(t, OLD, { "tests/split/other.test.ts": "export {};\n" });
  const files = (a, b) => ({
    ...ASSIGN,
    files: { [A]: { ...ASSIGN.files[A], ...a }, [B]: { ...ASSIGN.files[B], ...b } },
  });
  const cases = {
    "a test named twice": files({ tests: [1, 2] }, {}),
    "a test named by no file": files({}, { tests: [] }),
    "a test OLD does not have": files({ tests: [1, 3] }, {}),
    "overlapping ranges": files({ lines: [[20, 22]] }, { lines: [[21, 21]] }),
    "a range that cuts a statement": files({ lines: [[15, 16]] }, {}),
    "a range in the imports": files({ lines: [[3, 3]] }, {}),
    "a range from the header into the body": files({ lines: [[1, 6]] }, {}),
    "a range past the file": files({ lines: [[40, 41]] }, {}),
    "a declaration read from a file it is not in": files({}, { lines: [[19, 19]] }),
    "a missing header": files({ header: undefined }, {}),
    "a setup without a header": { ...ASSIGN, setup: { path: SETUP, header: null } },
    "the setup as a file": {
      ...ASSIGN,
      files: { ...ASSIGN.files, [SETUP]: { header: null, tests: [] } },
    },
    "a target that exists at the base": {
      ...ASSIGN,
      files: { [A]: ASSIGN.files[A], "tests/split/other.test.ts": ASSIGN.files[B] },
    },
    "another OLD": { ...ASSIGN, old: "tests/split/missing.test.ts" },
  };
  for (const [name, assign] of Object.entries(cases)) {
    const result = r.run(assign);
    assert.equal(result.status, 2, `${name}: ${result.out}${result.err}`);
    assert.match(result.err, /^split-write: /u, name);
    assert.equal(r.changed(), "", name);
  }
  assert.equal(r.run(ASSIGN, "--other").status, 2);
});

test("a statement that is neither a test nor a declaration, or a declaration no test reaches, is refused unless a range places it", (t) => {
  const stray = repository(t, `${OLD}\nPAIR.sort();\n`);
  const refused = stray.run(ASSIGN);
  assert.equal(refused.status, 2);
  assert.match(refused.err, /line 32: a statement that is neither a test nor a declaration/u);
  const placed = stray.run({
    ...ASSIGN,
    files: {
      ...ASSIGN.files,
      [A]: {
        ...ASSIGN.files[A],
        lines: [
          [1, 1],
          [32, 32],
        ],
      },
    },
  });
  assert.equal(placed.status, 0, placed.err);
  assert.match(stray.read(A), /\nPAIR\.sort\(\);\n$/u);
  const unused = repository(t, `${OLD}\nconst UNUSED = 3;\n`).run(ASSIGN);
  assert.equal(unused.status, 2);
  assert.match(unused.err, /line 32: UNUSED: no test reaches it/u);
});
