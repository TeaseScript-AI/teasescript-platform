import assert from "node:assert/strict";
import { test } from "node:test";

import { helper, main, moveOf, split, splitFamily } from "./pure-move-check-fixture.mjs";
import { RESIDUAL } from "./pure-move-check.mjs";

test("a true pure split passes, and its shape is printed", { timeout: 60_000 }, () => {
  const move = moveOf({ "a.ts": main }, split);
  try {
    const { status, out } = move.run("--renames", move.renames(splitFamily));
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
      const declared = move.run(
        "--declare",
        move.declare(entries),
        "--renames",
        move.renames(splitFamily),
      );
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
      const { status, out } = header.run("--renames", header.renames(splitFamily));
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
        "--renames",
        elsewhere.renames(splitFamily),
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
      {
        "src/space name.ts": 'import { a } from "./x.js";\nexport const b = a;\n',
        "src/x.ts": "export const a = 1;\n",
      },
      {
        "src/space name.ts": 'import { a } from "./y.js";\nexport const b = a;\n',
        "src/x.ts": null,
        "src/y.ts": "export const a = 1;\n",
      },
    );
    try {
      const { status, out } = spaced.run("--renames", spaced.renames({ "src/x.ts": "src/y.ts" }));
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

test(
  "a real comment beside code is a comment: a side comment on an import, a block continued below",
  { timeout: 60_000 },
  () => {
    const side = moveOf(
      {
        "a.ts": "import { a } from './old.js'; /* side comment */\nexport const result = a;\n",
        "old.ts": "export const a = 1;\n",
      },
      {
        "a.ts": "import { a } from './new.js'; /* side comment */\nexport const result = a;\n",
        "old.ts": null,
        "new.ts": "export const a = 1;\n",
      },
    );
    try {
      const { status, out } = side.run("--renames", side.renames({ "old.ts": "new.ts" }));
      assert.equal(status, 0, out);
      assert.match(out, /admitted import 2,/u);
    } finally {
      side.done();
    }
    // in an added file, above its first export: the comment's own lines are header comments; the line with code is not
    const continued = moveOf(
      { "a.ts": `${helper("kept")}\n` },
      {
        "a.ts": `${helper("kept")}\n`,
        "b.ts":
          "const answer = 42; /* begins beside the code\ncontinues on its own line\nends here */\nexport { answer };\n",
      },
    );
    try {
      const { status, out } = continued.run();
      assert.equal(status, 1, out);
      assert.match(out, /unadmitted: b\.ts:1 \(added\): const answer = 42;/u);
      assert.doesNotMatch(out, /unadmitted: b\.ts:[23] /u);
      assert.match(out, /header comment 2;/u);
    } finally {
      continued.done();
    }
  },
);

test(
  "a side that is no regular file is never read: a gitlink or a symbolic link is listed, its lines judged without it",
  { timeout: 60_000 },
  () => {
    const run = (before, after, ...args) => {
      const move = moveOf(before, after);
      try {
        return move.run(...args.map((arg) => (typeof arg === "function" ? arg(move) : arg)));
      } finally {
        move.done();
      }
    };
    const [one, two] = ["1".repeat(40), "2".repeat(40)];
    const kept = { "src/a.ts": "export const kept = 1;\n" };
    const file = "export const value = 1;\n";
    // a gitlink replaced by a regular file: the gitlink's line is unadmitted, never read as a blob
    const toFile = run({ ...kept, "src/sub": { gitlink: one } }, { ...kept, "src/sub": file });
    assert.equal(toFile.status, 1, toFile.out);
    assert.match(toFile.out, /unadmitted: src\/sub:1 \(removed\): Subproject commit 1{40}/u);
    assert.match(toFile.out, /unadmitted: src\/sub:1 \(added\): export const value = 1;/u);
    assert.match(toFile.out, /not compared \(not a regular file\): src\/sub \(160000\)/u);
    // (Git splits a type change into a deletion and an addition: each listing names the path once)
    assert.equal(toFile.out.split("not compared (unparsed): src/sub\n").length, 2, toFile.out);
    const reason = "the submodule becomes the file it held";
    const declared = run(
      { ...kept, "src/sub": { gitlink: one } },
      { ...kept, "src/sub": file },
      "--declare",
      (move) =>
        move.declare([
          { file: "src/sub", side: "removed", line: 1, reason },
          { file: "src/sub", side: "added", line: 1, reason },
        ]),
    );
    assert.equal(declared.status, 0, declared.out);
    // a regular file replaced by a gitlink, and a gitlink's new commit: each listed, its lines unadmitted
    const toGitlink = run({ ...kept, "src/sub": file }, { ...kept, "src/sub": { gitlink: one } });
    assert.equal(toGitlink.status, 1, toGitlink.out);
    assert.match(toGitlink.out, /unadmitted: src\/sub:1 \(added\): Subproject commit 1{40}/u);
    assert.match(toGitlink.out, /not compared \(not a regular file\): src\/sub \(160000\)/u);
    const pointer = run(
      { ...kept, "src/sub": { gitlink: one } },
      { ...kept, "src/sub": { gitlink: two } },
    );
    assert.equal(pointer.status, 1, pointer.out);
    assert.match(pointer.out, /unadmitted: src\/sub:1 \(added\): Subproject commit 2{40}/u);
    assert.match(pointer.out, /not compared \(not a regular file\): src\/sub \(160000\)/u);
    // a symbolic link named as code, retargeted: its blob, a path, is never parsed for bindings
    const link = run(
      { ...kept, "src/b.ts": file, "src/link.ts": { symlink: "a.ts" } },
      { ...kept, "src/b.ts": file, "src/link.ts": { symlink: "b.ts" } },
    );
    assert.equal(link.status, 1, link.out);
    assert.match(link.out, /unadmitted: src\/link\.ts:1 \(added\): b\.ts/u);
    assert.match(link.out, /not compared \(not a regular file\): src\/link\.ts \(120000\)/u);
    assert.match(link.out, /bindings differing 0; refused 0/u);
  },
);
