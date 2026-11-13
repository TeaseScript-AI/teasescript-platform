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
const RECONSTRUCT = fileURLToPath(new URL("./reconstruct-move.mjs", import.meta.url));
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
  const tool = (...args) => {
    const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: fixture, encoding: "utf8" });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  const read = (file) => readFileSync(join(fixture, file), "utf8");
  const changed = () => git("status", "--short", "--", "tests");
  return { fixture, base, run, tool, read, changed };
}

test("a split is written as assigned: lines verbatim in OLD's order, exports, imports by name, headers, the pin mark", (t) => {
  const r = repository(t);
  const result = r.run(ASSIGN);
  assert.equal(result.status, 0, result.err);
  // (the renames map beside the assignment; no relative path changes folder, an import's specifier being rewritten)
  assert.equal(
    r.read("renames.json"),
    `${JSON.stringify({ renames: { [OLD_PATH]: [A, B, SETUP].sort() } }, null, 2)}\n`,
  );
  assert.match(result.out, /^relative paths to read: 0$/mu);
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

test("a helper-module split: OLD keeps its tests, and ranges move its helpers into the setup module", (t) => {
  const r = repository(t);
  const result = r.run({
    old: OLD_PATH,
    setup: { path: SETUP, header: "The shared values.", lines: [[14, 17]] },
    files: { [OLD_PATH]: { header: null, tests: [1, 2], lines: [[1, 1]] } },
  });
  assert.equal(result.status, 0, result.err);
  assert.match(r.read(SETUP), /^export function twice\(/mu);
  assert.match(
    r.read(OLD_PATH),
    /^\/\/ pins: [^\n]*\n\nimport assert[^]*\nimport \{ type One, ONE, twice \} from "\.\.\/helpers\/split-setup\.js";\n\nconst PAIR/u,
  );
  const check = spawnSync(process.execPath, [RECONSTRUCT, r.base, OLD_PATH, SETUP, OLD_PATH], {
    cwd: r.fixture,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("--list OLD prints each statement, and the comments above the first, with no assignment (#2564)", (t) => {
  const r = repository(t);
  const listed = r.tool("--list", OLD_PATH);
  assert.equal(listed.status, 0, listed.err);
  assert.match(listed.out, /^7-7 comment above the first statement\n8-10 One reads: $/mu);
  assert.match(listed.out, /^15-17 twice reads: ONE$/mu);
  assert.match(listed.out, /^27-30 test 2: one$/mu);
  assert.equal(r.changed(), "");
  // (the old form, an assignment with --list, is refused by name with the new one)
  for (const old of [r.run(ASSIGN, "--list"), r.tool("--list", "assign.json")]) {
    assert.equal(old.status, 2);
    assert.match(old.err, /--list takes OLD, the file to split, not an assignment: --list OLD/u);
  }
});

test("a string that may be a path relative to the file is listed when its file changes folder, never an import (#2564)", (t) => {
  const old = [
    'import test from "node:test";',
    'import { a } from "./a.js";',
    "",
    'const DATA = "./data.json";',
    "",
    'test("deep", () => {',
    '  const url = new URL("../x.js", import.meta.url);',
    '  const template = `../${"y"}.js`;',
    "  return [DATA, url, template, a];",
    "});",
    "",
    'test("same", () => {',
    '  return "./same.txt";',
    "});",
    "",
  ].join("\n");
  const r = repository(t, old);
  const deep = "tests/split/deeper/deep.test.ts";
  const written = r.run({
    old: OLD_PATH,
    setup: { path: SETUP, header: "Shared." },
    files: { [deep]: { header: null, tests: [1] }, [B]: { header: "Same.", tests: [2] } },
  });
  assert.equal(written.status, 0, written.err);
  assert.ok(
    written.out.includes(
      [
        "relative paths to read: 3",
        `  ${deep} (old 4): const DATA = "./data.json";`,
        `  ${deep} (old 7): const url = new URL("../x.js", import.meta.url);`,
        `  ${deep} (old 8): const template = \`../\${"y"}.js\`;`,
        "",
      ].join("\n"),
    ),
    written.out,
  );
});

test("an assignment the split cannot follow is refused, and nothing is written", (t) => {
  const r = repository(t, OLD, { "tests/split/other.test.ts": "export {};\n" });
  const files = (a, b) => ({
    ...ASSIGN,
    files: { [A]: { ...ASSIGN.files[A], ...a }, [B]: { ...ASSIGN.files[B], ...b } },
  });
  // (each keyed by the refusal it must give, so that no later check stands in for it)
  const cases = {
    "test 2 is named by": files({ tests: [1, 2] }, {}),
    "test 2 is named by no file": files({}, { tests: [] }),
    "OLD has no test 3": files({ tests: [1, 3] }, {}),
    "OLD's leading line 1 is in no range": files({ lines: [] }, {}),
    "overlaps another at line 21": files(
      {
        lines: [
          [1, 1],
          [20, 22],
        ],
      },
      { lines: [[21, 21]] },
    ),
    "a range cuts the statement's lines 15-17": files(
      {
        lines: [
          [1, 1],
          [15, 16],
        ],
      },
      {},
    ),
    "the range 3-3 holds the import at line 3": files(
      {
        lines: [
          [1, 1],
          [3, 3],
        ],
      },
      {},
    ),
    "the range 1-6 crosses from OLD's leading // lines": files({ lines: [[1, 6]] }, {}),
    "the range 40-41 names no lines": files(
      {
        lines: [
          [1, 1],
          [40, 41],
        ],
      },
      {},
    ),
    "reads PAIR, placed in tests/split/b.test.ts": files({}, { lines: [[19, 19]] }),
    "a.test.ts: no header sentence": files({ header: undefined }, {}),
    "split-setup.ts: no header sentence": { ...ASSIGN, setup: { path: SETUP, header: null } },
    "is the setup and a file": {
      ...ASSIGN,
      files: { ...ASSIGN.files, [SETUP]: { header: null, tests: [] } },
    },
    "other.test.ts exists at HEAD and is not OLD": {
      ...ASSIGN,
      files: { [A]: ASSIGN.files[A], "tests/split/other.test.ts": ASSIGN.files[B] },
    },
    "../escaped.test.ts is not a path inside the repository": {
      ...ASSIGN,
      files: { ...ASSIGN.files, "../escaped.test.ts": { header: "Out.", tests: [] } },
    },
    "cannot read tests/split/missing.test.ts at HEAD": {
      ...ASSIGN,
      old: "tests/split/missing.test.ts",
    },
  };
  for (const [name, assign] of Object.entries(cases)) {
    const result = r.run(assign);
    assert.equal(result.status, 2, `${name}: ${result.out}${result.err}`);
    assert.ok(result.err.startsWith("split-write: ") && result.err.includes(name), result.err);
    assert.equal(r.changed(), "", name);
  }
  assert.equal(r.run(ASSIGN, "--other").status, 2);
  // (a refusal writes no renames map)
  assert.equal(existsSync(join(r.fixture, "renames.json")), false);
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

test("code between two imports is placed as any statement, and the later import is written in each file's imports (#2552 r1)", (t) => {
  const old = [
    'import test from "node:test";',
    "",
    "/** Read by both files. */",
    "const EARLY = 1;",
    'import assert from "node:assert/strict";',
    "",
    'test("one", () => {',
    "  assert.equal(EARLY, 1);",
    "});",
    "",
    'test("two", () => {',
    "  assert.equal(EARLY + 1, 2);",
    "});",
    "",
  ].join("\n");
  const assign = {
    old: OLD_PATH,
    setup: { path: SETUP, header: "Shared." },
    files: { [A]: { header: "One.", tests: [1] }, [B]: { header: "Two.", tests: [2] } },
  };
  const r = repository(t, old);
  const result = r.run(assign);
  assert.equal(result.status, 0, result.err);
  assert.equal(
    r.read(SETUP),
    "// Shared.\n\n/** Read by both files. */\nexport const EARLY = 1;\n",
  );
  assert.match(
    r.read(A),
    /^\/\/ One\.\n\nimport test from "node:test";\nimport assert from "node:assert\/strict";\nimport \{ EARLY \} from "\.\.\/helpers\/split-setup\.js";\n\ntest\("one"/u,
  );
  // (the same declaration given to the setup by a range)
  assert.equal(r.run({ ...assign, setup: { ...assign.setup, lines: [[3, 4]] } }).status, 0);
  // (a comment above the later import goes nowhere unless a range places it)
  const commented = repository(
    t,
    old.replace("const EARLY = 1;\n", "const EARLY = 1;\n// the assertions\n"),
  );
  const refused = commented.run(assign);
  assert.equal(refused.status, 2);
  assert.match(refused.err, /line 5: a comment above the import at line 6, in no range/u);
});

test("destructured names, overloads and a local export are read as declarations; two files on one line are refused (#2552 r1)", (t) => {
  const old = [
    'import test from "node:test";',
    "",
    "const { first, second } = { first: 1, second: 2 };",
    "",
    "function shape(value: number): number;",
    "function shape(value: string): string;",
    "function shape(value: number | string): number | string {",
    "  return value;",
    "}",
    "",
    "const local = 3;",
    "export { local };",
    "",
    'test("one", () => shape(first));',
    "",
    'test("two", () => shape(String(second)));',
    "",
  ].join("\n");
  const assign = {
    old: OLD_PATH,
    setup: { path: SETUP, header: "Shared.", lines: [[12, 12]] },
    files: { [A]: { header: "One.", tests: [1] }, [B]: { header: "Two.", tests: [2] } },
  };
  const r = repository(t, old);
  const result = r.run(assign);
  assert.equal(result.status, 0, result.err);
  assert.match(r.read(A), /^import \{ first, shape \} from "\.\.\/helpers\/split-setup\.js";$/mu);
  assert.match(r.read(SETUP), /^export function shape\(value: string\): string;$/mu);
  assert.match(r.read(SETUP), /^const local = 3;\nexport \{ local \};$/mu);
  const oneLine = repository(
    t,
    old.replace(
      'test("one", () => shape(first));\n\ntest(',
      'test("one", () => shape(first)); test(',
    ),
  );
  const refused = oneLine.run(assign);
  assert.equal(refused.status, 2);
  assert.match(refused.err, /line 14: statements of two files on one line/u);
});

test("a JavaScript OLD is read as TypeScript is: a property read on a call lists and writes, and each name its own (#2564 item 14)", (t) => {
  // (the file was no file of the program: the checker threw on these two reads, and every name read as the last declared)
  const old = [
    'import test from "node:test";',
    "",
    "const c = 1;",
    "const a = f({ b: 1 }).c;",
    "",
    'test("one", () => {',
    "  [1].filter((x) => x).length;",
    "  return a;",
    "});",
    "",
    'test("two", () => {',
    "  return c;",
    "});",
    "",
  ].join("\n");
  const r = repository(t, OLD, { "tools/probe.test.mjs": old });
  const assign = {
    old: "tools/probe.test.mjs",
    setup: { path: "tools/probe-setup.mjs", header: "Shared." },
    files: {
      "tools/probe-one.test.mjs": { header: null, tests: [1] },
      "tools/probe-two.test.mjs": { header: "Two.", tests: [2] },
    },
  };
  const listed = r.tool("--list", "tools/probe.test.mjs");
  assert.equal(listed.status, 0, listed.err);
  // (`.c` is a property name: `a` reads no `c`; and `c` reads nothing, not the last declared name)
  assert.match(listed.out, /^3-3 c reads: $/mu);
  assert.match(listed.out, /^4-4 a reads: $/mu);
  const written = r.run(assign);
  assert.equal(written.status, 0, written.err);
  assert.match(r.read("tools/probe-one.test.mjs"), /^const a = f\(\{ b: 1 \}\)\.c;$/mu);
  assert.match(r.read("tools/probe-two.test.mjs"), /^const c = 1;$/mu);
});

/** A helper module of four layers (line numbers matter): a base, two readers of it, and an aggregator of both. */
const LAYERED = [
  "// The layered helper.",
  'import { double } from "../lib/numbers.js";',
  "",
  "/** The base. */",
  "const BASE = 1;",
  "",
  "type Left = number;",
  "",
  "/** Reads the base. */",
  "const LEFT: Left = double(BASE);",
  "",
  "const RIGHT = BASE + 1;",
  "",
  "/** Reads both. */",
  "export function both(): number {",
  "  return LEFT + RIGHT;",
  "}",
  "",
].join("\n");
const LAYERS = {
  base: "tests/helpers/layers/base.ts",
  left: "tests/helpers/layers/left.ts",
  right: "tests/helpers/layers/right.ts",
  top: "tests/helpers/layers/top.ts",
};
const HELPER = "tests/helpers/layered.ts";

/** The layered split by names: the base as the setup module, `top` reading `left` and `right`. */
function layered(changes = {}) {
  const spec = (header, names, more = {}) => ({ header, tests: [], names, ...more });
  const files = {
    [LAYERS.left]: spec("Left.", ["Left", "LEFT"]),
    [LAYERS.right]: spec("Right.", ["RIGHT"]),
    [LAYERS.top]: spec(null, ["both"], { lines: [[1, 1]], reads: [LAYERS.left, LAYERS.right] }),
  };
  for (const [file, change] of Object.entries(changes)) files[file] = { ...files[file], ...change };
  return { old: HELPER, setup: { path: LAYERS.base, header: "The base.", names: ["BASE"] }, files };
}

test("a module reading several split-out files is written in one run, its reads named, each import by name (#2583)", (t) => {
  const r = repository(t, OLD, { [HELPER]: LAYERED });
  const result = r.run(layered());
  assert.equal(result.status, 0, result.err);
  assert.equal(r.read(LAYERS.base), "// The base.\n\n/** The base. */\nexport const BASE = 1;\n");
  assert.equal(
    r.read(LAYERS.left),
    [
      "// Left.",
      "",
      'import { double } from "../../lib/numbers.js";',
      'import { BASE } from "./base.js";',
      "",
      "type Left = number;",
      "",
      "/** Reads the base. */",
      "export const LEFT: Left = double(BASE);",
      "",
    ].join("\n"),
  );
  assert.equal(
    r.read(LAYERS.right),
    '// Right.\n\nimport { BASE } from "./base.js";\n\nexport const RIGHT = BASE + 1;\n',
  );
  assert.equal(
    r.read(LAYERS.top),
    [
      "// The layered helper.",
      "",
      'import { LEFT } from "./left.js";',
      'import { RIGHT } from "./right.js";',
      "",
      "/** Reads both. */",
      "export function both(): number {",
      "  return LEFT + RIGHT;",
      "}",
      "",
    ].join("\n"),
  );
  const check = spawnSync(
    process.execPath,
    [RECONSTRUCT, r.base, HELPER, LAYERS.base, LAYERS.left, LAYERS.right, LAYERS.top],
    { cwd: r.fixture, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("a chain of three layers is written in one run, each layer importing the one below (#2583)", (t) => {
  const r = repository(t, OLD, { [HELPER]: LAYERED });
  // (right and top go to one file, which reads left; left reads the base)
  const result = r.run({
    ...layered(),
    files: {
      [LAYERS.left]: { header: "Left.", tests: [], names: ["Left", "LEFT"] },
      [LAYERS.top]: {
        header: null,
        tests: [],
        names: ["RIGHT", "both"],
        lines: [[1, 1]],
        reads: [LAYERS.left],
      },
    },
  });
  assert.equal(result.status, 0, result.err);
  assert.match(
    r.read(LAYERS.top),
    /^\/\/ The layered helper\.\n\nimport \{ BASE \} from "\.\/base\.js";\nimport \{ LEFT \} from "\.\/left\.js";\n\nconst RIGHT = BASE \+ 1;\n/u,
  );
  assert.match(r.read(LAYERS.left), /^import \{ BASE \} from "\.\/base\.js";$/mu);
});

test("a read no reads entry names, a cycle of reads, a reads entry or a name the split lacks, and a name given twice are refused (#2583)", (t) => {
  const r = repository(t, OLD, { [HELPER]: LAYERED });
  // (each keyed by the refusal it must give, so that no later check stands in for it)
  const cases = {
    // the aggregator without its reads: the refusal a star split always gave
    [`${LAYERS.top} reads LEFT, placed in ${LAYERS.left}`]: layered({
      [LAYERS.top]: { reads: undefined },
    }),
    // (with reads that name another file, the refusal says so)
    [`${LAYERS.top} reads RIGHT, placed in ${LAYERS.right}, which its reads do not name`]: layered({
      [LAYERS.top]: { reads: [LAYERS.left] },
    }),
    // (left's both reads right's LEFT; right's LEFT reads left's type Left)
    [`a cycle of reads between the split's files: ${LAYERS.left} reads LEFT, ${LAYERS.right} reads Left`]:
      layered({
        [LAYERS.left]: { names: ["Left", "both"], reads: [LAYERS.right] },
        [LAYERS.right]: { names: ["LEFT", "RIGHT"], reads: [LAYERS.left] },
        [LAYERS.top]: { names: [], reads: [] },
      }),
    [`${LAYERS.top}: its reads name tests/helpers/layers/none.ts, which is not another file of the split`]:
      layered({
        [LAYERS.top]: { reads: [LAYERS.left, LAYERS.right, "tests/helpers/layers/none.ts"] },
      }),
    [`${LAYERS.top}: OLD declares no MISSING`]: layered({
      [LAYERS.top]: { names: ["both", "MISSING"] },
    }),
    [`RIGHT is named by ${LAYERS.right} and ${LAYERS.top}`]: layered({
      [LAYERS.top]: { names: ["both", "RIGHT"] },
    }),
    // a name's range and a range over the same statement
    "overlaps another at line 13": layered({ [LAYERS.right]: { lines: [[13, 13]] } }),
    // a declaration no name, range or test places is still refused
    "line 15: both: no test reaches it": layered({ [LAYERS.top]: { names: [] } }),
  };
  for (const [name, assign] of Object.entries(cases)) {
    const result = r.run(assign);
    assert.equal(result.status, 2, `${name}: ${result.out}${result.err}`);
    assert.ok(result.err.startsWith("split-write: ") && result.err.includes(name), result.err);
    assert.equal(r.changed(), "", name);
  }
});
