import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "./fixture-git.mjs";

isolateGit();

const tool = fileURLToPath(new URL("./counters.mjs", import.meta.url));
const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

const run = (root, ...args) =>
  spawnSync(process.execPath, [tool, root, ...args], { encoding: "utf8" });
const git = (root, ...args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A Git checkout of `files` ({path: text}) with all but `untracked` added and committed. */
function checkout(files, untracked = []) {
  const root = mkdtempSync(path.join(tmpdir(), "counters-test-"));
  folders.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  git(root, "init", "-q");
  git(root, "add", ...Object.keys(files).filter((f) => !untracked.includes(f)));
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

// The directive family: each directive word in each carrier. A carrier is a comment (counted) or text that only looks
// like one (not counted). Its file holds one line per word, so each expected site follows from the two axes alone.
// `only` limits a carrier to one kind of word: TypeScript reads `///` and `/**` openers, the lint rule only `//`, `/*`.
const WORDS = {
  lintDisables: [
    "oxlint-disable",
    "oxlint-disable-line",
    "oxlint-disable-next-line",
    "eslint-disable",
    "eslint-disable-line",
    "eslint-disable-next-line",
  ],
  tsDirectives: ["@ts-expect-error", "@ts-ignore"],
};
const COUNTED = {
  "line comment": { file: "src/line.ts", line: (w) => `// ${w} -- reason` },
  "line comment without a space": { file: "src/tight.ts", line: (w) => `//${w}` },
  "block comment": { file: "src/block.mjs", line: (w) => `/* ${w} */` },
  "trailing comment": { file: "src/trailing.ts", line: (w) => `const x = 1; // ${w}` },
  "triple-slash comment": { file: "src/triple.ts", line: (w) => `/// ${w}`, only: "tsDirectives" },
  "doc comment": { file: "src/doc.ts", line: (w) => `/** ${w} */`, only: "tsDirectives" },
  "JSX expression comment": { file: "src/view.tsx", line: (w) => `const v = <p>{/* ${w} */}</p>;` },
  "Vue script comment": {
    file: "src/View.vue",
    line: (w) => `// ${w}`,
    wrap: (body) => `<template><p>x</p></template>\n<script setup lang="ts">\n${body}\n</script>\n`,
  },
  "Vue script in a component the parser reports an error for": {
    file: "player/Broken.vue",
    line: (w) => `// ${w}`,
    wrap: (body) => `<template><p></template>\n<script setup lang="ts">\n${body}\n</script>\n`,
  },
};
const NOT_COUNTED = {
  string: { file: "src/string.ts", line: (w) => `const s = "// ${w}";` },
  "template literal": { file: "src/template.mjs", line: (w) => `const t = \`\n// ${w}\n\`;` },
  "JSX text": { file: "src/text.tsx", line: (w) => `const p = <p>// ${w}</p>;` },
  "prose comment": { file: "src/prose.ts", line: (w) => `// a mention of \`${w}\`` },
  "longer word": { file: "src/longer.ts", line: (w) => `// ${w}d`, only: "lintDisables" },
  "triple-slash comment": {
    file: "src/triple-lint.ts",
    line: (w) => `/// ${w}`,
    only: "lintDisables",
  },
  "doc comment": { file: "src/doc-lint.ts", line: (w) => `/** ${w} */`, only: "lintDisables" },
  "Vue template comment": {
    file: "src/Template.vue",
    line: (w) => `<!-- ${w} -->`,
    wrap: (body) => `<template>\n${body}\n</template>\n`,
  },
  "block comment opened by a slash": { file: "src/slash.ts", line: (w) => `/*/ ${w} */` },
  // Inside a character class a regular expression can hold `//` and the word, as a text search would read them.
  "regular expression": { file: "src/regex.ts", line: (w) => `const r = /[//${w}]/;` },
  "Vue script setup with src, which Vue refuses": {
    file: "player/Refused.vue",
    line: (w) => `// ${w}`,
    wrap: (body) => `<script setup src="./plain.ts">\n${body}\n</script>\n`,
  },
  "Vue script inside an HTML comment": {
    file: "src/Commented.vue",
    line: (w) => `// ${w}`,
    wrap: (body) => `<template><p>x</p></template>\n<!--\n<script>\n${body}\n</script>\n-->\n`,
  },
  Markdown: { file: "docs/notes.md", line: (w) => `// ${w}` },
  "untracked file": { file: "src/untracked.ts", line: (w) => `// ${w}`, untracked: true },
};

function directiveFixture() {
  const files = {};
  const expected = { lintDisables: [], tsDirectives: [] };
  for (const [carriers, counted] of [
    [COUNTED, true],
    [NOT_COUNTED, false],
  ])
    for (const c of Object.values(carriers)) {
      const words = Object.entries(WORDS).flatMap(([kind, ws]) =>
        !c.only || c.only === kind ? ws.map((w) => [kind, w]) : [],
      );
      // The body's first line is the wrapper's line holding it.
      let line = c.wrap
        ? c
            .wrap("\0")
            .split("\n")
            .findIndex((l) => l.includes("\0")) + 1
        : 1;
      const lines = [];
      for (const [kind, w] of words) {
        if (counted) expected[kind].push(`${c.file}:${line}`);
        lines.push(c.line(w));
        line += c.line(w).split("\n").length;
      }
      files[c.file] = c.wrap ? c.wrap(lines.join("\n")) : `${lines.join("\n")}\n`;
    }
  const untracked = Object.values(NOT_COUNTED)
    .filter((c) => c.untracked)
    .map((c) => c.file);
  return { files, untracked, expected };
}

// Each test-site form, one per line: the counted ones name their kind, the others none; a skip is "off" (without a
// condition), "on condition" or "platform" (a platform guard, #2568).
const SITES = [
  ["skip", 'test.skip("a", () => {});', "off"],
  ["skip", 'it.skip("b", () => {});', "off"],
  ["skip", 'describe.skip("c", () => {});', "off"],
  ["skip", 'suite.skip("d", () => {});', "off"],
  ["skip", 'test("e", { skip: true }, () => {});', "off"],
  ["skip", 'test("f", { skip: process.platform === "win32" }, () => {});', "platform"],
  ["skip", 'test("pa", { skip: "darwin" !== process.platform }, () => {});', "platform"],
  ["skip", 'test("pb", { skip: (process.platform == `win32`) }, () => {});', "platform"],
  [
    "skip",
    'test("pc", { skip: process.platform === "win32" || process.platform === "aix" }, () => {});',
    "platform",
  ],
  [
    "skip",
    'test("pd", { skip: process.platform === "win32" || !tool }, () => {});',
    "on condition",
  ],
  ["skip", 'test("pe", { skip: process.platform.startsWith("win") }, () => {});', "on condition"],
  ["skip", 'test("pf", { skip: os.platform() === "win32" }, () => {});', "on condition"],
  ["skip", 'test("pg", { skip: process.platform === other }, () => {});', "on condition"],
  ["skip", 'test("ph", (t) => { if (process.platform === "win32") t.skip(); });', "on condition"],
  // a binding of the name `process` that is not Node's
  [
    "skip",
    '{ const process = { platform: "a" }; test("pi", { skip: process.platform === "a" }, () => {}); }',
    "on condition",
  ],
  [
    "skip",
    'function pj(process) { test("pj", { skip: process.platform === "a" }, () => {}); }',
    "on condition",
  ],
  [
    "skip",
    'try {} catch (process) { test("pk", { skip: process.platform === "a" }, () => {}); }',
    "on condition",
  ],
  ["skip", 'test.only("g", { "skip": "a reason" }, () => {});', "off"],
  ["skip", 'test("h", (t) => { t.skip("why"); });', "off"],
  ["skip", 'test("sa", { skip }, () => {});', "off"],
  ["skip", 'test("sb", { skip: flag }, () => {});', "off"],
  ["skip", 'test("sc", { skip: `reason` }, () => {});', "off"],
  ["skip", 'test("sd", { skip: !tool }, () => {});', "on condition"],
  ["skip", 'test("se", { skip: has("age") }, () => {});', "on condition"],
  ["skip", 'test("sf", { skip: env.X === "1" ? false : "opt in" }, () => {});', "on condition"],
  ["skip", 'test("sg", { skip: (a && b) }, () => {});', "on condition"],
  ["skip", 'test("sh", (t) => { if (!tool) { t.skip("none"); return; } });', "on condition"],
  ["skip", 'test("si", (t) => { if (tool) {} else t.skip(); });', "on condition"],
  ["skip", 'test("sj", (t) => { x ? t.skip() : 0; });', "on condition"],
  ["skip", 'test("sk", (t) => { missing && t.skip(); });', "on condition"],
  ["skip", 'test("sl", (t) => { if (t.skip()) {} });', "off"],
  ["skip", 'test("sm", (t) => { t.skip() || x; });', "off"],
  ["skip", 'test("sn", (t) => { if (x) [1].forEach(() => { t.skip(); }); });', "off"],
  ["skip", 'test("so", (t) => { [1].forEach(() => { if (x) t.skip(); }); });', "on condition"],
  ["todo", 'test.todo("i");'],
  ["todo", 'it("j", { todo: true });'],
  ["todo", 'test("k", (context) => { context.todo(); });'],
  [null, 'test("l", { skip: false }, () => {});'],
  [null, "walk.skip(value);"],
  [null, 'const s = "test.skip(";'],
  [null, 'test("m", (t) => { story.skip(); });'],
  [null, "function n(t) { t.skip(); }"],
  [null, "test(() => t.skip(), (t) => {});"],
  [null, 'test("r", (u, t) => { t.skip(); });'],
  [null, "test((t) => { t.skip(); }, () => {});"],
  [null, 'it.each([1])("s", (t) => { t.skip(); });'],
];

// The scope family: a context's use inside each binding form, where the form binds the context's own name `t` (it
// hides the context, unless the form evaluates the use in the enclosing scope) or another name `u` (the use is the
// context's). Each case is one line, named by its axis values alone; the expected sites follow from `hides`.
const FORMS = {
  parameter: { hides: true, line: (n, use) => `function f(${n}) { ${use}; }` },
  "destructured parameter": { hides: true, line: (n, use) => `function f({ ${n} }) { ${use}; }` },
  "arrow parameter": { hides: true, line: (n, use) => `const f = (${n}) => ${use};` },
  "block const": { hides: true, line: (n, use) => `{ const ${n} = stub; ${use}; }` },
  "destructured const": {
    hides: true,
    line: (n, use) => `{ const { ${n} } = { ${n}: stub }; ${use}; }`,
  },
  catch: { hides: true, line: (n, use) => `try { throw stub; } catch (${n}) { ${use}; }` },
  "for of": { hides: true, line: (n, use) => `for (const ${n} of [stub]) { ${use}; }` },
  "for let": { hides: true, line: (n, use) => `for (let ${n} = stub; ; ) { ${use}; break; }` },
  "switch let": {
    hides: true,
    line: (n, use) => `switch (0) { case 0: let ${n} = stub; ${use}; }`,
  },
  "named function expression": {
    hides: true,
    line: (n, use) => `const f = function ${n}() { ${use}; };`,
  },
  "named class expression": {
    hides: true,
    line: (n, use) => `const C = class ${n} { m() { ${use}; } };`,
  },
  subtest: { hides: true, line: (n, use) => `await t.test("sub", (${n}) => { ${use}; });` },
  "computed class member": { hides: false, line: (n, use) => `class C { [${use}](${n}) {} }` },
  "computed object member": { hides: false, line: (n, use) => `const o = { [${use}](${n}) {} };` },
};
// A file whose `process` is an import, and the list its skip on `process.platform` belongs in: Node's `process` makes
// it a platform guard, another module's an ordinary condition.
const PROCESS_IMPORTS = {
  "tests/process-default.test.ts": ['import process from "node:process";', "skippedTestsPlatform"],
  "tests/process-namespace.test.ts": [
    'import * as process from "process";',
    "skippedTestsPlatform",
  ],
  "tests/process-other.test.ts": [
    'import { process } from "./host.js";',
    "skippedTestsConditional",
  ],
  "tests/process-other-default.test.ts": [
    'import process from "./host.js";',
    "skippedTestsConditional",
  ],
};
const USES = { shadowed: "t", other: "u" };
const KINDS = ["skip", "todo"];
const SCOPES = Object.entries(FORMS).flatMap(([form, { hides, line }]) =>
  Object.entries(USES).flatMap(([use, name]) =>
    KINDS.map((kind) => ({
      name: `${form} ${use} ${kind}`,
      counted: !(hides && use === "shadowed"),
      kind,
      text: `test("${form} ${use} ${kind}", async (t) => { ${line(name, `t.${kind}()`)} });`,
    })),
  ),
);

let fixture;
let result;
let warnings;
before(() => {
  const { files, untracked, expected } = directiveFixture();
  const big = `export function big() {\n${"  void 0;\n".repeat(1100)}}\n`;
  Object.assign(files, {
    "tests/sites.test.ts": `${SITES.map(([, line]) => line).join("\n")}\n`,
    ...Object.fromEntries(
      Object.entries(PROCESS_IMPORTS).map(([file, [line]]) => [
        file,
        `${line}\ntest("x", { skip: process.platform === "win32" }, () => {});\n`,
      ]),
    ),
    "tests/scopes.test.ts": `const stub = { skip() {}, todo() {} };\n${SCOPES.map((c) => c.text).join("\n")}\n`,
    ".oxlintrc.json": JSON.stringify({
      overrides: [
        { files: ["a", "b"], rules: { "no-debugger": "off" } },
        { files: ["c"], rules: { eqeqeq: ["allow", {}], "no-debugger": 0 } },
        // a scope entry, which turns a rule on, and entries without rules: not waiting lists
        { files: ["d"], rules: { "no-debugger": "off", eqeqeq: "error" } },
        { files: ["e"] },
        { rules: {} },
      ],
    }),
    "tools/oxlint/comment-forecasts-allowed.json": JSON.stringify([{}, {}]),
    "tools/oxlint/comment-declarations-waiting.json": JSON.stringify([{}]),
    "tools/oxlint/comment-external-names.json": JSON.stringify([]),
    "tools/repository-checks/imports-waiting.json": JSON.stringify([{}, {}, {}, {}]),
    "tools/oxlint/comment-citations.json": JSON.stringify({
      "src/a.ts": { "#1": 2, "#2": 1 },
      "src/b.ts": { "#1": 4 },
    }),
    "src/big.ts": big,
    ...Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`player/many/f${i}.ts`, "export {};\n"]),
    ),
  });
  fixture = { root: checkout(files, untracked), expected };
  const r = run(fixture.root, "--json");
  assert.equal(r.status, 0, r.stderr);
  result = JSON.parse(r.stdout);
  warnings = r.stderr;
});

test("a directive counts only as a comment, in each carrier, at its line", () => {
  for (const kind of Object.keys(WORDS)) {
    assert.deepEqual(result.sites[kind].toSorted(), fixture.expected[kind].toSorted(), kind);
    assert.equal(result.counters[kind], fixture.expected[kind].length);
  }
});

test("a .vue file the parser reports errors for is named once on stderr, and still counts", () => {
  // Its counted blocks are checked with the directive family; here, the note and the exit status.
  assert.deepEqual(warnings.trim().split("\n").toSorted(), [
    "counters: player/Broken.vue: Element is missing end tag.; counted the script blocks Vue returned",
    'counters: player/Refused.vue: <script setup> cannot use the "src" attribute because its syntax will be ambiguous outside of the component.; counted the script blocks Vue returned',
  ]);
});

test("each node:test skip and todo form counts, and calls that only look like one do not", () => {
  const at = (kind) =>
    SITES.flatMap(([k], i) => (k === kind ? [`tests/sites.test.ts:${i + 1}`] : []));
  const of = (sites) => sites.filter((s) => s.startsWith("tests/sites.test.ts:"));
  assert.deepEqual(of(result.sites.skippedTests), at("skip"));
  assert.deepEqual(of(result.sites.todoTests), at("todo"));
});

test("a skip is a platform guard or on a condition only in the forms the header names, and without one otherwise", () => {
  const at = (when) =>
    SITES.flatMap(([, , w], i) => (w === when ? [`tests/sites.test.ts:${i + 1}`] : []));
  const of = (sites) => sites.filter((s) => s.startsWith("tests/sites.test.ts:"));
  assert.deepEqual(of(result.sites.skippedTestsConditional), at("on condition"));
  assert.deepEqual(of(result.sites.skippedTestsUnconditional), at("off"));
  assert.deepEqual(of(result.sites.skippedTestsPlatform), at("platform"));
  // every skip, also the scope family's, is in exactly one of the three
  const c = result.counters;
  assert.equal(
    c.skippedTestsConditional + c.skippedTestsUnconditional + c.skippedTestsPlatform,
    c.skippedTests,
  );
  assert.deepEqual(
    [
      ...result.sites.skippedTestsConditional,
      ...result.sites.skippedTestsUnconditional,
      ...result.sites.skippedTestsPlatform,
    ].toSorted(),
    result.sites.skippedTests.toSorted(),
  );
});

test("a skip on `process.platform` is a platform guard only where `process` is Node's, also when imported", () => {
  for (const [file, [, list]] of Object.entries(PROCESS_IMPORTS))
    for (const key of ["skippedTestsPlatform", "skippedTestsConditional"])
      assert.deepEqual(
        result.sites[key].filter((site) => site.startsWith(`${file}:`)),
        key === list ? [`${file}:2`] : [],
        `${file} ${key}`,
      );
});

test("a context's use counts only where the binder resolves its name to the test's context", () => {
  // Coverage: every form, use and kind, and every pair of them, is a case.
  const names = new Set(SCOPES.map((c) => c.name));
  for (const form of Object.keys(FORMS))
    for (const use of Object.keys(USES))
      for (const kind of KINDS)
        assert.ok(names.has(`${form} ${use} ${kind}`), `${form} ${use} ${kind}`);
  assert.equal(names.size, Object.keys(FORMS).length * Object.keys(USES).length * KINDS.length);
  for (const kind of KINDS) {
    const site = kind === "skip" ? "skippedTests" : "todoTests";
    const expected = SCOPES.flatMap((c, i) =>
      c.kind === kind && c.counted ? [`tests/scopes.test.ts:${i + 2}`] : [],
    );
    const found = result.sites[site].filter((s) => s.startsWith("tests/scopes.test.ts:"));
    assert.deepEqual(found, expected, kind);
  }
});

test("the lists count their entries, the structure signals come from structure-report, and HEAD is named", () => {
  const c = result.counters;
  assert.deepEqual(
    [
      c.oxlintOverrideFiles,
      c.forecastsAllowed,
      c.declarationsWaiting,
      c.externalNames,
      c.importsWaiting,
      c.citations,
    ],
    [3, 2, 1, 0, 4, 7],
  );
  assert.deepEqual([c.largeFiles, c.broadFolders, c.longFunctions], [1, 1, 1]);
  assert.deepEqual(
    [c.largeFilesExcessLines, c.broadFoldersExcessFiles, c.longFunctionsExcessLines],
    [102, 1, 952],
  );
  assert.deepEqual(c.largestFile, { file: "src/big.ts", lines: 1102 });
  assert.deepEqual(c.longestFunction, { file: "src/big.ts", name: "big", lines: 1102 });
  assert.equal(result.commit, git(fixture.root, "rev-parse", "HEAD"));
  const text = run(fixture.root);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Comment citations: 7$/mu);
});

test("a missing list is absent, and a list of another shape or a ROOT that is no checkout stops the tool", () => {
  const root = checkout({ "src/a.ts": "export {};\n" });
  const r = run(root, "--json");
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout).counters;
  for (const key of [
    "oxlintOverrideFiles",
    "forecastsAllowed",
    "declarationsWaiting",
    "externalNames",
    "importsWaiting",
    "citations",
  ])
    assert.equal(c[key], null, key);
  for (const key of [
    "largeFilesExcessLines",
    "broadFoldersExcessFiles",
    "longFunctionsExcessLines",
    "longFunctionsOutsideTestsExcessLines",
    "longFunctionsInTestsExcessLines",
  ])
    assert.equal(c[key], 0, key);
  assert.match(run(root).stdout, /^Comment external names \(may grow\): absent$/mu);

  for (const [file, text, message] of [
    [
      "tools/oxlint/comment-forecasts-allowed.json",
      "{}",
      /comment-forecasts-allowed\.json is not an array/u,
    ],
    [
      ".oxlintrc.json",
      '{"overrides": null}',
      /\.oxlintrc\.json is not an object whose `overrides`/u,
    ],
    [
      ".oxlintrc.json",
      '{"overrides": [{"files": null}]}',
      /\.oxlintrc\.json is not overrides with `files`/u,
    ],
  ]) {
    const m = run(checkout({ [file]: text }), "--json");
    assert.equal(m.status, 2, text);
    assert.match(m.stderr, message);
  }

  const notCheckout = mkdtempSync(path.join(tmpdir(), "counters-test-"));
  folders.push(notCheckout);
  assert.equal(run(notCheckout).status, 2);
  assert.equal(run(path.join(fixture.root, "src")).status, 2);
});

test("each structure sum adds the excess over its limit, so a shrinking file lowers it while its count stays", () => {
  const lines = (n) => "void 0;\n".repeat(n);
  // a function of `n` lines, Git's: its first and last line and the body between
  const fn = (name, n, body = lines(n - 2)) => `function ${name}() {\n${body}}\n`;
  const files = {
    "src/shrink.ts": lines(2000),
    // exactly at each limit: a file of 1000 lines holding a function of 150
    "src/edge.ts": fn("edge", 150) + lines(850),
    // a function of 160 lines holding one of 155: both are rows, as in the count
    "src/nest.ts": fn("outer", 160, fn("inner", 155) + lines(3)),
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`player/edge/f${i}.ts`, "export {};\n"]),
    ),
    ...Object.fromEntries(
      Array.from({ length: 22 }, (_, i) => [`player/wide/f${i}.ts`, "export {};\n"]),
    ),
  };
  const root = checkout(files);
  const measure = () => {
    const r = run(root, "--json");
    assert.equal(r.status, 0, r.stderr);
    const c = JSON.parse(r.stdout).counters;
    return {
      files: [c.largeFiles, c.largeFilesExcessLines],
      functions: [c.longFunctions, c.longFunctionsExcessLines],
      folders: [c.broadFolders, c.broadFoldersExcessFiles],
    };
  };
  assert.deepEqual(measure(), { files: [1, 1000], functions: [2, 15], folders: [1, 2] });
  const text = run(root);
  assert.equal(text.status, 0, text.stderr);
  assert.match(
    text.stdout,
    /^Files over 1000 lines: 1\nLines above 1000, summed over those files: 1000\nFolders over 20 files: 1\nFiles above 20, summed over those folders: 2\nFunctions over 150 lines: 2\nLines above 150, summed over those functions: 15$/mu,
  );

  writeFileSync(path.join(root, "src/shrink.ts"), lines(1500));
  git(root, "commit", "-q", "-am", "shrink");
  assert.deepEqual(measure(), { files: [1, 500], functions: [2, 15], folders: [1, 2] });
});

test("@ts- directives and long functions are counted in tests and outside, by the path", () => {
  // a function of `n` lines with a directive above it
  const fn = (n) => `// @ts-expect-error\nfunction f() {\n${"void 0;\n".repeat(n - 2)}}\n`;
  // each place, the excess of its function: a power of two, so each sum names its places
  const places = {
    "tests/a.ts": 1,
    "src/a.test.ts": 2,
    "tests/helpers/h.ts": 4,
    "src/a.ts": 8,
    "tools/t.mjs": 16,
    "src/tests/x.ts": 32,
    "src/a.testing.ts": 64,
  };
  const root = checkout(
    Object.fromEntries(Object.entries(places).map(([file, excess]) => [file, fn(150 + excess)])),
  );
  const r = run(root, "--json");
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout).counters;
  assert.deepEqual([c.tsDirectives, c.tsDirectivesInTests, c.tsDirectivesOutsideTests], [7, 3, 4]);
  assert.deepEqual([c.longFunctionsInTests, c.longFunctionsInTestsExcessLines], [3, 1 + 2 + 4]);
  assert.deepEqual(
    [c.longFunctionsOutsideTests, c.longFunctionsOutsideTestsExcessLines],
    [4, 8 + 16 + 32 + 64],
  );
  assert.equal(c.longFunctionsExcessLines, 127);
  const text = run(root);
  assert.equal(text.status, 0, text.stderr);
  assert.match(
    text.stdout,
    /^@ts-expect-error and @ts-ignore: 7\n@ts- directives outside tests: 4\n@ts- directives in tests: 3\nSkipped tests: 0\nSkipped tests without a condition: 0\nSkipped tests on a condition: 0\nSkipped tests on the platform: 0$/mu,
  );
  assert.match(
    text.stdout,
    /^Lines above 150, summed over those functions: 127\nFunctions over 150 lines outside tests: 4\nLines above 150, summed over those outside tests: 120\nFunctions over 150 lines in tests: 3\nLines above 150, summed over those in tests: 7$/mu,
  );
});

// What this checks: a SIGTERM while the tool holds its temporary folder ends the run with exit 143 and leaves no
// folder. It does not check that the signal reaches structure-report (pull request #2016 names that as the residual):
// a test that holds the report to observe it needs a mechanism of its own, whose lifecycle kept producing defects.
test("SIGTERM once the temporary folder exists ends the run with exit 143 and removes the folder", async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "counters-test-"));
  folders.push(temporary);
  const counting = spawn(process.execPath, [tool, fixture.root], {
    env: { ...process.env, TMPDIR: temporary },
    stdio: "ignore",
  });
  let exit = null;
  counting.on("exit", (code, signal) => (exit = code ?? signal));
  // Every step is one wait that fails after 30 s: a bound on waiting, not a claim about speed.
  const until = async (what, predicate) => {
    for (
      const end = Date.now() + 30000;
      Date.now() < end;
      await new Promise((r) => setTimeout(r, 10))
    ) {
      if (predicate()) return;
    }
    assert.fail(`waited 30 s for ${what}`);
  };
  try {
    // The tool creates its folder just before it starts structure-report.
    await until("the temporary folder", () => readdirSync(temporary).length > 0);
    counting.kill("SIGTERM");
    await until("the tool to exit", () => exit !== null);
    assert.equal(exit, 143);
    assert.deepEqual(readdirSync(temporary), []);
  } finally {
    counting.kill("SIGKILL");
  }
});
