import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RESIDUAL } from "./pure-move-check.mjs";

const tool = fileURLToPath(new URL("./pure-move-check.mjs", import.meta.url));

/** A function long enough that Git marks it moved: each body line well over its 20-character block threshold. */
const helper = (name, change = "") =>
  [
    `function ${name}(values: readonly number[]): number {`,
    "  let total = 0;",
    "  for (const value of values) total += value * value;",
    `  return total + values.length${change};`,
    "}",
  ].join("\n");

/** A repository at `before`, then committed at `after`; `run(args)` runs the check there. */
function moveOf(before, after) {
  const root = mkdtempSync(join(tmpdir(), "pure-move-check-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      if (text === null) rmSync(join(root, path));
      else writeFileSync(join(root, path), text);
    }
  };
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write(before);
  git("add", "-A");
  git("commit", "-qm", "before");
  const base = git("rev-parse", "HEAD");
  write(after);
  git("add", "-A");
  git("commit", "-qm", "after");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [tool, base, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: result.status, out: result.stdout + result.stderr };
  };
  // (inside the fixture, so `done` removes it; untracked, so the check, which reads committed trees, never sees it)
  const declare = (entries) => {
    const path = join(root, "declare.json");
    writeFileSync(path, JSON.stringify(entries));
    return path;
  };
  return { root, run, declare, done: () => rmSync(root, { recursive: true, force: true }) };
}

const main = `${helper("sumOfSquares")}\n\n${helper("weighted")}\n\nexport const used = sumOfSquares([1]) + weighted([2]);\n`;
const split = {
  "a.ts": `import { weighted } from "./b.js";\n\n${helper("sumOfSquares")}\n\nexport const used = sumOfSquares([1]) + weighted([2]);\n`,
  "b.ts": `export ${helper("weighted")}\n`,
};

test("a true pure split passes, and its shape is printed", { timeout: 60_000 }, () => {
  const move = moveOf({ "a.ts": main }, split);
  try {
    const { status, out } = move.run();
    assert.equal(status, 0, out);
    assert.match(
      out,
      /shape: moved \+\d+ -\d+; admitted import 1, export 2, whitespace \d+, header comment 0; declared 0; unadmitted 0/u,
    );
  } finally {
    move.done();
  }
});

test("a split with one changed statement fails and names the line", { timeout: 60_000 }, () => {
  const changed = { ...split, "b.ts": `export ${helper("weighted", " + 1")}\n` };
  const move = moveOf({ "a.ts": main }, changed);
  try {
    const { status, out } = move.run();
    assert.equal(status, 1, out);
    assert.match(out, /unadmitted: b\.ts:4 \(added\):   return total \+ values\.length \+ 1;/u);
    assert.match(out, /unadmitted: a\.ts:\d+ \(removed\):   return total \+ values\.length;/u);
  } finally {
    move.done();
  }
});

test("a rename with an added export passes", { timeout: 60_000 }, () => {
  const before = { "old.ts": `${helper("weighted")}\n\nexport const one = 1;\n` };
  const after = {
    "old.ts": null,
    "renamed.ts": `export ${helper("weighted")}\n\nexport const one = 1;\n`,
  };
  const move = moveOf(before, after);
  try {
    const { status, out } = move.run();
    assert.equal(status, 0, out);
    assert.match(out, /admitted import 0, export 2,/u);
  } finally {
    move.done();
  }
});

test(
  "an undeclared path-keyed entry fails; declared, it passes with its reason; a stale declaration fails",
  { timeout: 60_000 },
  () => {
    const before = { "a.ts": main, "allow.json": '{\n  "a.ts": 2\n}\n' };
    const after = { ...split, "allow.json": '{\n  "b.ts": 2\n}\n' };
    const move = moveOf(before, after);
    try {
      const bare = move.run();
      assert.equal(bare.status, 1, bare.out);
      assert.match(bare.out, /unadmitted: allow\.json:2 \(added\):   "b\.ts": 2/u);
      const entries = [
        {
          file: "allow.json",
          side: "removed",
          line: 2,
          reason: "the allowance follows the moved function",
        },
        {
          file: "allow.json",
          side: "added",
          line: 2,
          reason: "the allowance follows the moved function",
        },
      ];
      const declared = move.run("--declare", move.declare(entries));
      assert.equal(declared.status, 0, declared.out);
      assert.match(
        declared.out,
        /declared: allow\.json:2 \(added\): the allowance follows the moved function/u,
      );
      assert.match(declared.out, /declared 2; unadmitted 0/u);
      const stale = move.run(
        "--declare",
        move.declare([
          ...entries,
          { file: "allow.json", side: "added", line: 9, reason: "no such line" },
        ]),
      );
      assert.equal(stale.status, 1, stale.out);
      assert.match(
        stale.out,
        /declaration matching no unmoved line: allow\.json:9 \(added\): no such line/u,
      );
    } finally {
      move.done();
    }
  },
);

test(
  "a block under Git's move threshold fails, with the residual's wording",
  { timeout: 60_000 },
  () => {
    const before = { "a.ts": "const k = 1;\nexport const one = k;\n" };
    const after = { "a.ts": "export const one = 1;\n", "b.ts": "const k = 1;\n" };
    const move = moveOf(before, after);
    try {
      const { status, out } = move.run();
      assert.equal(status, 1, out);
      assert.match(out, /unadmitted: b\.ts:1 \(added\): const k = 1;/u);
      assert.ok(out.includes(RESIDUAL), out);
    } finally {
      move.done();
    }
  },
);

test(
  "an added file's header comment passes; a comment added elsewhere fails unless declared",
  { timeout: 60_000 },
  () => {
    const headed = {
      ...split,
      "b.ts": `// The weighted sum, apart.\n\nexport ${helper("weighted")}\n`,
    };
    const header = moveOf({ "a.ts": main }, headed);
    try {
      const { status, out } = header.run();
      assert.equal(status, 0, out);
      assert.match(out, /header comment 1;/u);
    } finally {
      header.done();
    }
    const stray = {
      ...split,
      "a.ts": split["a.ts"].replace("export const used", "// used below\nexport const used"),
    };
    const elsewhere = moveOf({ "a.ts": main }, stray);
    try {
      const bare = elsewhere.run();
      assert.equal(bare.status, 1, bare.out);
      assert.match(bare.out, /unadmitted: a\.ts:\d+ \(added\): \/\/ used below/u);
      const line = Number(/unadmitted: a\.ts:(\d+) \(added\): \/\/ used below/u.exec(bare.out)[1]);
      const declared = elsewhere.run(
        "--declare",
        elsewhere.declare([{ file: "a.ts", side: "added", line, reason: "a note the move needs" }]),
      );
      assert.equal(declared.status, 0, declared.out);
    } finally {
      elsewhere.done();
    }
  },
);

test(
  "an admitted line holds only its form: code beside an import, or a comment beside code, fails",
  { timeout: 60_000 },
  () => {
    const importThen = moveOf(
      { "a.ts": 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n' },
      {
        "a.ts":
          'import { readFileSync } from "node:fs"; process.exit(42);\nexport const read = readFileSync;\n',
      },
    );
    try {
      const { status, out } = importThen.run();
      assert.equal(status, 1, out);
      assert.match(
        out,
        /unadmitted: a\.ts:1 \(added\): import \{ readFileSync \} from "node:fs"; process\.exit\(42\);/u,
      );
    } finally {
      importThen.done();
    }
    const commentThen = moveOf(
      { "a.ts": main },
      { ...split, "c.ts": "/* header */ export const added = 42;\n" },
    );
    try {
      const { status, out } = commentThen.run();
      assert.equal(status, 1, out);
      assert.match(
        out,
        /unadmitted: c\.ts:1 \(added\): \/\* header \*\/ export const added = 42;/u,
      );
    } finally {
      commentThen.done();
    }
  },
);

test(
  "a string's or a template's text is never a declaration's export or a comment",
  { timeout: 60_000 },
  () => {
    const template = (line) =>
      `export const page = \`\n${line}\nsecond line of the page, long enough to be moved\n\`;\n`;
    const exported = moveOf(
      { "a.ts": template("ordinary text is not a declaration") },
      { "a.ts": template("export ordinary text is not a declaration") },
    );
    try {
      const { status, out } = exported.run();
      assert.equal(status, 1, out);
      assert.match(
        out,
        /unadmitted: a\.ts:2 \(added\): export ordinary text is not a declaration/u,
      );
    } finally {
      exported.done();
    }
    // the template stands above the file's first export, where a real comment would be a header comment
    const raw = (inner) =>
      `const view = \`first line of the view \${1}\n${inner}last line of the view, long enough\n\`;\nexport { view };\n`;
    const commented = moveOf(
      { "a.ts": raw("") },
      { "a.ts": null, "b.ts": raw("// replacement text\n") },
    );
    try {
      const { status, out } = commented.run();
      assert.equal(status, 1, out);
      assert.match(out, /unadmitted: b\.ts:2 \(added\): \/\/ replacement text/u);
    } finally {
      commented.done();
    }
  },
);

test(
  "an escape sequence in a string is the line's own text, not a colour",
  { timeout: 60_000 },
  () => {
    const move = moveOf(
      { "a.ts": 'const ordinaryLongIdentifier = "message";\n' },
      {
        "a.ts": `export const ordinaryLongIdentifier = "${String.fromCharCode(27)}[31mmessage";\n`,
      },
    );
    try {
      const { status, out } = move.run();
      assert.equal(status, 1, out);
      assert.match(out, /unadmitted: a\.ts:1 \(added\)/u);
    } finally {
      move.done();
    }
  },
);

test(
  "a file name with spaces is read; a binary change and a quoted name stop the check",
  { timeout: 60_000 },
  () => {
    const spaced = moveOf(
      { "src/space name.ts": 'import { a } from "./x.js";\nexport const b = a;\n' },
      { "src/space name.ts": 'import { a } from "./y.js";\nexport const b = a;\n' },
    );
    try {
      const { status, out } = spaced.run();
      assert.equal(status, 0, out);
      assert.match(out, /admitted import 2,/u);
    } finally {
      spaced.done();
    }
    const binary = moveOf(
      { "data.bin": Buffer.from([0, 1, 2, 3]) },
      { "data.bin": Buffer.from([0, 9, 2, 3]) },
    );
    try {
      const { status, out } = binary.run();
      assert.equal(status, 2, out);
      assert.match(out, /a binary change cannot be inspected/u);
    } finally {
      binary.done();
    }
    const quoted = moveOf(
      { 'src/quote"name.ts': "export const quoted = 1;\n" },
      { 'src/quote"name.ts': null, 'src/new"quote.ts': "export const quoted = 1;\n" },
    );
    try {
      const { status, out } = quoted.run();
      assert.equal(status, 2, out);
      assert.match(out, /a quoted file name Git wrote is not read/u);
    } finally {
      quoted.done();
    }
  },
);

test(
  "a comment is only trivia: JSX text that looks like one never admits code",
  { timeout: 60_000 },
  () => {
    const view = (importLine) =>
      [
        "const renderedViewWithLongIdentifier = <section>",
        "/*",
        "</section>;",
        importLine,
        "const commentEndMarker = '*/';",
        "export {renderedViewWithLongIdentifier};",
        "",
      ].join("\n");
    const neighbor = moveOf(
      { "a.tsx": view("import { a } from './old.js'; doSomething();") },
      { "a.tsx": view("import { a } from './new.js'; doSomethingElse();") },
    );
    try {
      const { status, out } = neighbor.run();
      assert.equal(status, 1, out);
      assert.match(
        out,
        /unadmitted: a\.tsx:4 \(added\): import \{ a \} from '\.\/new\.js'; doSomethingElse\(\);/u,
      );
    } finally {
      neighbor.done();
    }
    const element = (inner) =>
      `const sectionWithLongIdentifier = <section>\n${inner}first paragraph of the moved section text\n</section>;\nexport { sectionWithLongIdentifier };\n`;
    const inserted = moveOf(
      { "a.tsx": `${element("")}${helper("kept")}\n` },
      { "a.tsx": `${helper("kept")}\n`, "b.tsx": element("/* visible text, not a comment */\n") },
    );
    try {
      const { status, out } = inserted.run();
      assert.equal(status, 1, out);
      assert.match(out, /unadmitted: b\.tsx:2 \(added\): \/\* visible text, not a comment \*\//u);
    } finally {
      inserted.done();
    }
  },
);

test(
  "a decorated export bounds the header; a line's first declaration is its start",
  { timeout: 60_000 },
  () => {
    const decorated = (between) =>
      [
        "function sealed(value: Function) { return value; }",
        "@sealed",
        "export class LongDecoratedClassIdentifier {",
        "  answer() { return 12345678901234567890; }",
        "}",
        ...between,
        "export const trailingLongIdentifier = 123456789;",
        "",
      ].join("\n");
    const boundary = moveOf(
      { "a.ts": `${decorated([])}${helper("kept")}\n` },
      { "a.ts": `${helper("kept")}\n`, "b.ts": decorated(["// inserted below the first export"]) },
    );
    try {
      const { status, out } = boundary.run();
      assert.equal(status, 1, out);
      assert.match(out, /unadmitted: b\.ts:6 \(added\): \/\/ inserted below the first export/u);
    } finally {
      boundary.done();
    }
    const line = "const firstLongIdentifier = 123456789; const secondLongIdentifier = 987654321;";
    const twoOnOne = moveOf({ "a.ts": `${line}\n` }, { "a.ts": `export ${line}\n` });
    try {
      const { status, out } = twoOnOne.run();
      assert.equal(status, 0, out);
      assert.match(out, /admitted import 0, export 2,/u);
    } finally {
      twoOnOne.done();
    }
  },
);
