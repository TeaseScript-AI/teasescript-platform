import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
before(() => {
  const { files, untracked, expected } = directiveFixture();
  const big = `export function big() {\n${"  void 0;\n".repeat(1100)}}\n`;
  Object.assign(files, {
    "tests/sites.test.ts": `${SITES.map(([, line]) => line).join("\n")}\n`,
    "tests/scopes.test.ts": `const stub = { skip() {}, todo() {} };\n${SCOPES.map((c) => c.text).join("\n")}\n`,
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
  const of = (sites) => sites.filter((s) => s.startsWith("tests/sites.test.ts:"));
  assert.deepEqual(of(result.sites.skippedTests), at("skip"));
  assert.deepEqual(of(result.sites.todoTests), at("todo"));
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

// This test needs Linux's /proc (the report child from /proc/<pid>/task/<pid>/children, its threads' states and its
// pending signals from /proc/<pid>/status) and job-control signals (SIGSTOP, SIGCONT). Where that file does not exist
// the test cannot observe the child, and says so instead of failing.
const CHILDREN = `/proc/${process.pid}/task/${process.pid}/children`;
test(
  "SIGTERM is passed on to structure-report, and the tool removes its temporary folder and exits 143",
  {
    skip: existsSync(CHILDREN)
      ? false
      : `needs ${CHILDREN.replace(/\d+/gu, "<pid>")} to find the report child`,
  },
  async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "counters-test-"));
    folders.push(temporary);
    const counting = spawn(process.execPath, [tool, fixture.root], {
      env: { ...process.env, TMPDIR: temporary },
      stdio: "ignore",
    });
    const exited = new Promise((resolve) =>
      counting.on("exit", (code, signal) => resolve(code ?? signal)),
    );
    // A wait, not a bound on speed: poll until the predicate holds, failing only after 30 s.
    const until = async (what, predicate) => {
      for (
        const end = Date.now() + 30000;
        Date.now() < end;
        await new Promise((r) => setTimeout(r, 10))
      ) {
        const value = predicate();
        if (value) return value;
      }
      assert.fail(`waited 30 s for ${what}`);
    };
    const read = (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    let report = null;
    try {
      // The report child: started just after the temporary folder, and stopped before it can finish.
      report = await until("the structure-report child", () =>
        read(`/proc/${counting.pid}/task/${counting.pid}/children`)
          .split(" ")
          .filter(Boolean)
          .map(Number)
          .find((pid) => read(`/proc/${pid}/cmdline`).includes("structure-report.mjs")),
      );
      process.kill(report, "SIGSTOP");
      // Every thread stopped: a signal sent to a process whose stop is still in progress can be handled by a thread
      // that has not stopped yet, so it would not wait as pending.
      await until("the report to stop", () =>
        readdirSync(`/proc/${report}/task`).every((tid) =>
          /^State:\s*T/mu.test(read(`/proc/${report}/task/${tid}/status`)),
        ),
      );
      counting.kill("SIGTERM");
      // The tool passes the signal on: it waits as pending on the stopped report (signal 15, bit 14 of ShdPnd).
      await until("SIGTERM pending on the report", () => {
        const pending = /^ShdPnd:\s*([0-9a-f]+)$/mu.exec(read(`/proc/${report}/status`));
        return pending && (BigInt(`0x${pending[1]}`) & (1n << 14n)) !== 0n;
      });
      process.kill(report, "SIGCONT");
      assert.equal(await exited, 143);
      assert.deepEqual(readdirSync(temporary), []);
    } finally {
      counting.kill("SIGKILL");
      if (report) {
        try {
          process.kill(report, "SIGKILL");
        } catch {
          // already ended
        }
      }
    }
  },
);
