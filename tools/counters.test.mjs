import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("./counters.mjs", import.meta.url));
const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

const run = (root, ...args) =>
  spawnSync(process.execPath, [tool, root, ...args], { encoding: "utf8" });
const git = (root, ...args) => {
  const r = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  });
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
  git(root, "commit", "-q", "--no-gpg-sign", "-m", "fixture");
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

// Each test-site form, one per line: the counted ones name their kind, the others none.
const SITES = [
  ["skip", 'test.skip("a", () => {});'],
  ["skip", 'it.skip("b", () => {});'],
  ["skip", 'describe.skip("c", () => {});'],
  ["skip", 'suite.skip("d", () => {});'],
  ["skip", 'test("e", { skip: true }, () => {});'],
  ["skip", 'test("f", { skip: process.platform === "win32" }, () => {});'],
  ["skip", 'test.only("g", { "skip": "a reason" }, () => {});'],
  ["skip", 'test("h", (t) => { t.skip("why"); });'],
  ["todo", 'test.todo("i");'],
  ["todo", 'it("j", { todo: true });'],
  ["todo", 'test("k", (context) => { context.todo(); });'],
  [null, 'test("l", { skip: false }, () => {});'],
  [null, "walk.skip(value);"],
  [null, 'const s = "test.skip(";'],
  [null, 'test("m", (t) => { story.skip(); });'],
  [null, "function n(t) { t.skip(); }"],
  ["skip", 'test("o", async (t) => { await t.test("sub", () => { t.skip(); }); });'],
  [null, 'test("p", (t) => { function helper(t) { t.skip(); } });'],
  [null, 'test("q", (t) => { { const t = story; t.todo(); } });'],
  [null, "test(() => t.skip(), (t) => {});"],
];

let fixture;
let result;
before(() => {
  const { files, untracked, expected } = directiveFixture();
  const big = `export function big() {\n${"  void 0;\n".repeat(1100)}}\n`;
  Object.assign(files, {
    "tests/sites.test.ts": `${SITES.map(([, line]) => line).join("\n")}\n`,
    ".oxlintrc.json": JSON.stringify({
      overrides: [{ files: ["a", "b"] }, { files: ["c"] }, { rules: {} }],
    }),
    "tools/oxlint/comment-forecasts-allowed.json": JSON.stringify([{}, {}]),
    "tools/oxlint/comment-declarations-waiting.json": JSON.stringify([{}]),
    "tools/oxlint/comment-external-names.json": JSON.stringify([]),
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
});

test("a directive counts only as a comment, in each carrier, at its line", () => {
  for (const kind of Object.keys(WORDS)) {
    assert.deepEqual(result.sites[kind].toSorted(), fixture.expected[kind].toSorted(), kind);
    assert.equal(result.counters[kind], fixture.expected[kind].length);
  }
});

test("each node:test skip and todo form counts, and calls that only look like one do not", () => {
  const at = (kind) =>
    SITES.flatMap(([k], i) => (k === kind ? [`tests/sites.test.ts:${i + 1}`] : []));
  assert.deepEqual(result.sites.skippedTests, at("skip"));
  assert.deepEqual(result.sites.todoTests, at("todo"));
});

test("the lists count their entries, the structure signals come from structure-report, and HEAD is named", () => {
  const c = result.counters;
  assert.deepEqual(
    [
      c.oxlintOverrideFiles,
      c.forecastsAllowed,
      c.declarationsWaiting,
      c.externalNames,
      c.citations,
    ],
    [3, 2, 1, 0, 7],
  );
  assert.deepEqual([c.largeFiles, c.broadFolders, c.longFunctions], [1, 1, 1]);
  assert.deepEqual(c.largestFile, { file: "src/big.ts", lines: 1103 });
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
    "citations",
  ])
    assert.equal(c[key], null, key);
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

test("SIGTERM stops structure-report, removes the temporary folder and exits 143", async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "counters-test-"));
  folders.push(temporary);
  const child = spawn(process.execPath, [tool, fixture.root], {
    env: { ...process.env, TMPDIR: temporary },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  // The tool creates its folder just before it starts structure-report, which takes a second to load its parser.
  while (readdirSync(temporary).length === 0) await new Promise((r) => setTimeout(r, 10));
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.deepEqual(readdirSync(temporary), []);
});
