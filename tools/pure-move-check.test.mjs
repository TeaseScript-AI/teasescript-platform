import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A repository at `before`, then committed at `after` (a file's text, `null` to remove it, or `{ executable: text }`);
 * `run(args)` runs the check there.
 */
function moveOf(before, after) {
  const root = mkdtempSync(join(tmpdir(), "pure-move-check-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      if (text === null) rmSync(join(root, path));
      else if (text.executable !== undefined) {
        writeFileSync(join(root, path), text.executable);
        chmodSync(join(root, path), 0o755);
      } else writeFileSync(join(root, path), text);
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
  // the move sweep's map, beside the declarations
  const renames = (map) => {
    const path = join(root, "renames.json");
    writeFileSync(path, JSON.stringify({ renames: map }));
    return path;
  };
  return {
    root,
    run,
    declare,
    renames,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const main = `${helper("sumOfSquares")}\n\n${helper("weighted")}\n\nexport const used = sumOfSquares([1]) + weighted([2]);\n`;
/** The split's family: `a.ts` keeps one function, `b.ts` takes the other. */
const splitFamily = { "a.ts": ["a.ts", "b.ts"] };
const split = {
  "a.ts": `import { weighted } from "./b.js";\n\n${helper("sumOfSquares")}\n\nexport const used = sumOfSquares([1]) + weighted([2]);\n`,
  "b.ts": `export ${helper("weighted")}\n`,
};

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
  "a pure move keeps every import's binding: an alias dropped or an export renamed fails",
  { timeout: 60_000 },
  () => {
    const server = (importLine) =>
      `${importLine}\nexport const makeServerWithLongIdentifier = createNetServer;\n`;
    const before = {
      "a.ts": `${server('import { createServer as createNetServer } from "node:net";')}\n${helper("kept")}\n`,
    };
    const moved = (importLine) => ({ "a.ts": `${helper("kept")}\n`, "b.ts": server(importLine) });
    const dropped = moveOf(before, moved('import { createNetServer } from "node:net";'));
    try {
      const { status, out } = dropped.run("--renames", dropped.renames(splitFamily));
      assert.equal(status, 1, out);
      assert.match(
        out,
        /binding only before: a\.ts:1 import from "node:net": createServer as createNetServer/u,
      );
      assert.match(out, /binding only after: b\.ts:1 import from "node:net": createNetServer/u);
    } finally {
      dropped.done();
    }
    const kept = moveOf(
      before,
      moved('import { createServer as createNetServer } from "node:net";'),
    );
    try {
      const passed = kept.run("--renames", kept.renames(splitFamily));
      assert.equal(passed.status, 0, passed.out);
      assert.match(passed.out, /bindings differing 0/u);
    } finally {
      kept.done();
    }
    // a split whose kept file imports its new sibling: without the family, that binding is new, and the flag is named
    const unnamed = moveOf({ "a.ts": main }, split);
    try {
      const { status, out } = unnamed.run();
      assert.equal(status, 1, out);
      assert.match(out, /binding only after: a\.ts:1 import from "\.\/b\.js": weighted/u);
      assert.match(out, /the move relocates or adds b\.ts: name its family with --renames FILE/u);
    } finally {
      unnamed.done();
    }
    const reexport = moveOf(
      {
        "a.ts": 'export { helperName } from "./c.js";\n',
        "c.ts": "export const helperName = 1;\n",
      },
      {
        "a.ts": 'export { helperName as renamed } from "./c.js";\n',
        "c.ts": "export const helperName = 1;\n",
      },
    );
    try {
      const { status, out } = reexport.run();
      assert.equal(status, 1, out);
      assert.match(
        out,
        /binding only after: a\.ts:1 re-export from "\.\/c\.js": helperName as renamed/u,
      );
    } finally {
      reexport.done();
    }
  },
);

test(
  "a binding's target is the file it resolves to, a bare module or a missing one, in every static form",
  { timeout: 60_000 },
  () => {
    const run = (before, after, map) => {
      const move = moveOf(before, after);
      try {
        return map === undefined ? move.run() : move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const exporter = "export const value = 1234567890;\n";
    // both files renamed, the import left pointing at the old, now missing, module
    const missing = run(
      { "src/a.js": importer("./old.js"), "src/old.js": exporter },
      {
        "src/a.js": null,
        "src/b.js": importer("./old.js"),
        "src/old.js": null,
        "src/new.js": exporter,
      },
      { "src/a.js": "src/b.js", "src/old.js": "src/new.js" },
    );
    assert.equal(missing.status, 1, missing.out);
    assert.match(
      missing.out,
      /refused: src\/b\.js:1 \(added\) "\.\/old\.js": resolves to no file under the committed configuration/u,
    );
    // a package's module and a repository file of the same path are different targets
    const bare = run(
      { "a.mjs": importer("pkg/x.js"), "pkg/x.js": exporter },
      { "a.mjs": importer("./pkg/x.js"), "pkg/x.js": exporter },
    );
    assert.equal(bare.status, 1, bare.out);
    assert.match(bare.out, /binding only before: a\.mjs:1 import from "pkg\/x\.js"/u);
    // `import x = require()` and an empty clause name their target too
    const required =
      'import dependencyWithLongIdentifier = require("./dep.js");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n';
    const equals = run(
      { "src/a.ts": required, "src/dep.ts": exporter, "src/nested/dep.ts": exporter },
      {
        "src/a.ts": null,
        "src/nested/a.ts": required,
        "src/dep.ts": exporter,
        "src/nested/dep.ts": exporter,
      },
      { "src/a.ts": "src/nested/a.ts" },
    );
    assert.equal(equals.status, 1, equals.out);
    assert.match(
      equals.out,
      /binding only after: src\/nested\/a\.ts:1 import from "\.\/dep\.js": = as dependencyWithLongIdentifier/u,
    );
    const empty = run(
      { "a.mjs": 'import {} from "./first.mjs";\n', "first.mjs": exporter, "second.mjs": exporter },
      {
        "a.mjs": 'import {} from "./second.mjs";\n',
        "first.mjs": exporter,
        "second.mjs": exporter,
      },
    );
    assert.equal(empty.status, 1, empty.out);
    assert.match(
      empty.out,
      /binding only after: a\.mjs:1 import from "\.\/second\.mjs": \(side effect\) as \{\}/u,
    );
    // a changed file with no changed line (its mode) keeps its bindings in the comparison
    const loader =
      'import { marker as selectedMarkerWithLongIdentifier } from "./dep.mjs";\nconsole.log(selectedMarkerWithLongIdentifier);\n';
    const modeOnly = run(
      { "src/loader.mjs": loader, "src/dep.mjs": exporter },
      { "src/loader.mjs": { executable: loader }, "src/dep.mjs": null, "src/moved.mjs": exporter },
      { "src/dep.mjs": "src/moved.mjs" },
    );
    assert.equal(modeOnly.status, 1, modeOnly.out);
    assert.match(
      modeOnly.out,
      /refused: src\/loader\.mjs:1 \(added\) "\.\/dep\.mjs": resolves to no file/u,
    );
    // a declaration file renamed with its map is a pure rename
    const declarations = "export interface SomeType {\n  readonly value: number;\n}\n";
    const typed = (from) =>
      `import type { SomeType } from "${from}";\nexport const typedWithLongIdentifier: SomeType = { value: 1 };\n`;
    const renamed = run(
      { "src/a.ts": typed("./old.js"), "src/old.d.ts": declarations },
      { "src/a.ts": typed("./new.js"), "src/old.d.ts": null, "src/new.d.ts": declarations },
      { "src/old.d.ts": "src/new.d.ts" },
    );
    assert.equal(renamed.status, 0, renamed.out);
    assert.match(renamed.out, /bindings differing 0/u);
  },
);

test(
  "a target resolves as TypeScript resolves it, and a correct import-equals update is an import line",
  { timeout: 60_000 },
  () => {
    const run = (before, after, map) => {
      const move = moveOf(before, after);
      try {
        return move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const [ts1, js1, js2] = [
      "export const value = 1234567890;\n",
      "export const value = 9876543210;\n",
      "export const value = 5555555555;\n",
    ];
    // `./old.js` is `old.ts` before; with `old.ts` renamed away it is `old.js` after: a changed binding
    const switched = run(
      { "src/a.ts": importer("./old.js"), "src/old.ts": ts1, "src/old.js": js1 },
      {
        "src/a.ts": null,
        "src/b.ts": importer("./old.js"),
        "src/old.ts": null,
        "src/new.ts": ts1,
        "src/old.js": js1,
      },
      { "src/a.ts": "src/b.ts", "src/old.ts": "src/new.ts" },
    );
    assert.equal(switched.status, 1, switched.out);
    assert.match(switched.out, /bindings differing 2/u);
    // the `.ts` renamed beside unrelated `.js` files of both names, its import updated: the same binding
    const beside = run(
      { "src/a.ts": importer("./old.js"), "src/old.ts": ts1, "src/old.js": js1, "src/new.js": js2 },
      {
        "src/a.ts": importer("./new.js"),
        "src/new.ts": ts1,
        "src/old.js": js1,
        "src/new.js": js2,
        "src/old.ts": null,
      },
      { "src/old.ts": "src/new.ts" },
    );
    assert.equal(beside.status, 0, beside.out);
    // an extensionless specifier resolves to its JavaScript file
    const bare = run(
      { "src/a.ts": importer("./old"), "src/old.js": js1 },
      { "src/a.ts": importer("./new"), "src/old.js": null, "src/new.js": js1 },
      { "src/old.js": "src/new.js" },
    );
    assert.equal(bare.status, 0, bare.out);
    // `import x = require()` and `export import x = require()`, their specifier updated with the rename: import lines
    for (const keyword of ["import", "export import"]) {
      const required = (from) =>
        `${keyword} dependencyWithLongIdentifier = require("${from}");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n`;
      const updated = run(
        { "src/a.ts": required("./old.js"), "src/old.ts": ts1 },
        { "src/a.ts": required("./new.js"), "src/old.ts": null, "src/new.ts": ts1 },
        { "src/old.ts": "src/new.ts" },
      );
      assert.equal(updated.status, 0, `${keyword}: ${updated.out}`);
      assert.match(updated.out, /admitted import 2,/u);
    }
  },
);

test(
  "resolution follows the importer's package context: an ESM import's extension, a folder's main",
  { timeout: 60_000 },
  () => {
    const run = (before, after, map) => {
      const move = moveOf(before, after);
      try {
        return move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const esm = '{ "type": "module" }\n';
    const [one, two] = ["export const value = 1234567890;\n", "export const value = 9876543210;\n"];
    // in an ESM package, `./new` names no file where `./old.js` named `old.ts`: resolved to missing
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const extensionless = run(
      { "package.json": esm, "src/a.ts": importer("./old.js"), "src/old.ts": one },
      { "package.json": esm, "src/a.ts": importer("./new"), "src/old.ts": null, "src/new.ts": one },
      { "src/old.ts": "src/new.ts" },
    );
    assert.equal(extensionless.status, 1, extensionless.out);
    assert.match(
      extensionless.out,
      /refused: src\/a\.ts:1 \(added\) "\.\/new": resolves to no file/u,
    );
    // a CommonJS require of a folder follows its package.json's main; with the entry moved away, it reaches index.ts
    const required =
      'import dependencyWithLongIdentifier = require("./dep");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n';
    const main = '{ "type": "commonjs", "main": "entry.js" }\n';
    const retarget = run(
      {
        "package.json": esm,
        "src/a.cts": required,
        "src/dep/package.json": main,
        "src/dep/entry.ts": one,
        "src/dep/index.ts": two,
      },
      {
        "package.json": esm,
        "src/a.cts": null,
        "src/b.cts": required,
        "src/dep/package.json": main,
        "src/dep/entry.ts": null,
        "src/moved.ts": one,
        "src/dep/index.ts": two,
      },
      { "src/a.cts": "src/b.cts", "src/dep/entry.ts": "src/moved.ts" },
    );
    assert.equal(retarget.status, 1, retarget.out);
    assert.match(retarget.out, /bindings differing 2/u);
    // the folder renamed whole, its require updated: its main reached on both sides, the same binding
    const folder = (from) =>
      `import dependencyWithLongIdentifier = require("${from}");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n`;
    const renamed = run(
      {
        "package.json": esm,
        "src/a.cts": folder("./old"),
        "src/old/package.json": main,
        "src/old/entry.ts": one,
      },
      {
        "package.json": esm,
        "src/a.cts": folder("./new"),
        "src/old/package.json": null,
        "src/old/entry.ts": null,
        "src/new/package.json": main,
        "src/new/entry.ts": one,
      },
      { "src/old/package.json": "src/new/package.json", "src/old/entry.ts": "src/new/entry.ts" },
    );
    assert.equal(renamed.status, 0, renamed.out);
    assert.match(renamed.out, /bindings differing 0/u);
  },
);

test(
  "each configuration the tree does not establish refuses by name; a file no config owns otherwise resolves as Node runs it",
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
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const value = "export const value = 1234567890;\n";
    const esm = '{ "type": "module" }\n';
    const nodeNext = (include) =>
      `{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" }, "include": ${JSON.stringify(include)} }\n`;
    // Codex r4's first case: a nearer config whose include leaves the importer out; the root's NodeNext applies, and
    // `./new` resolves to nothing
    const nearer = {
      "package.json": esm,
      "tsconfig.json": nodeNext(["src/**/*"]),
      "src/lib/tsconfig.json":
        '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["unrelated/**/*"] }\n',
    };
    const notOwned = run(
      { ...nearer, "src/lib/a.ts": importer("./old.js"), "src/lib/old.ts": value },
      {
        ...nearer,
        "src/lib/a.ts": importer("./new"),
        "src/lib/old.ts": null,
        "src/lib/new.ts": value,
      },
      "--renames",
      (move) => move.renames({ "src/lib/old.ts": "src/lib/new.ts" }),
    );
    assert.equal(notOwned.status, 1, notOwned.out);
    assert.match(
      notOwned.out,
      /refused: src\/lib\/a\.ts:1 \(added\) "\.\/new": resolves to no file/u,
    );
    // Codex r4's second case: an `extends` the committed tree does not hold; refused by name on both sides, passed only
    // when declared, each declaration printed with the refusal reason it covers
    const inherited = {
      "package.json": esm,
      "tsconfig.json": '{ "extends": "@fixture/config/base.json", "include": ["src/**/*.ts"] }\n',
    };
    const before = { ...inherited, "src/a.ts": importer("./old.js"), "src/old.ts": value };
    const after = {
      ...inherited,
      "src/a.ts": importer("./new"),
      "src/old.ts": null,
      "src/new.ts": value,
    };
    const map = (move) => move.renames({ "src/old.ts": "src/new.ts" });
    const unestablished = run(before, after, "--renames", map);
    assert.equal(unestablished.status, 1, unestablished.out);
    assert.match(
      unestablished.out,
      /refused: src\/a\.ts:1 \(removed\) "\.\/old\.js": tsconfig\.json: /u,
    );
    assert.match(unestablished.out, /refused: src\/a\.ts:1 \(added\) "\.\/new": tsconfig\.json: /u);
    const reason =
      "the configuration extends an installed package; the move's compiler run resolves it";
    const declared = run(before, after, "--renames", map, "--declare", (move) =>
      move.declare([
        { file: "src/a.ts", side: "removed", line: 1, reason },
        { file: "src/a.ts", side: "added", line: 1, reason },
      ]),
    );
    assert.equal(declared.status, 0, declared.out);
    assert.match(declared.out, /refused 0/u);
    assert.match(
      declared.out,
      /declared refusal: src\/a\.ts:1 \(removed\) "\.\/old\.js": tsconfig\.json: .*; declared: the configuration extends/u,
    );
    // a true rename of `tools/old.ts`, its import updated, under each place a file's configuration can come from
    const rename = (configs, ext, from, to) =>
      run(
        { ...configs, [`tools/a.${ext}`]: importer(from), [`tools/old.${ext}`]: value },
        {
          ...configs,
          [`tools/a.${ext}`]: importer(to),
          [`tools/old.${ext}`]: null,
          [`tools/new.${ext}`]: value,
        },
        "--renames",
        (move) => move.renames({ [`tools/old.${ext}`]: `tools/new.${ext}` }),
      );
    // a TypeScript file the nearest config's include leaves out, and no config above includes: refused by name
    const leftOut = rename(
      { "tsconfig.json": nodeNext(["src/**/*"]) },
      "ts",
      "./old.js",
      "./new.js",
    );
    assert.equal(leftOut.status, 1, leftOut.out);
    assert.match(
      leftOut.out,
      /refused: tools\/a\.ts:1 \(added\) "\.\/new\.js": no committed tsconfig\.json includes it \(the nearest, tsconfig\.json, leaves it out\)/u,
    );
    // a TypeScript file with no config above it, in a tree that has one: refused by name
    const none = rename({ "src/tsconfig.json": nodeNext(["**/*"]) }, "ts", "./old.js", "./new.js");
    assert.equal(none.status, 1, none.out);
    assert.match(
      none.out,
      /refused: tools\/a\.ts:1 \(added\) "\.\/new\.js": no committed tsconfig\.json is above it/u,
    );
    // a JavaScript file no config owns resolves as Node runs it: in an ESM package `./new` names no file, `./new.js` does
    const js = { "package.json": esm, "tsconfig.json": nodeNext(["src/**/*"]) };
    const jsExtensionless = rename(js, "js", "./old.js", "./new");
    assert.equal(jsExtensionless.status, 1, jsExtensionless.out);
    assert.match(
      jsExtensionless.out,
      /refused: tools\/a\.js:1 \(added\) "\.\/new": resolves to no file/u,
    );
    const jsRenamed = rename(js, "js", "./old.js", "./new.js");
    assert.equal(jsRenamed.status, 0, jsRenamed.out);
    assert.match(jsRenamed.out, /bindings differing 0; refused 0/u);
    // a tree with no tsconfig.json resolves a TypeScript file as Node runs it too (its ESM extensionless case is in the
    // package-context test)
    const unconfigured = rename({ "package.json": esm }, "ts", "./old.js", "./new.js");
    assert.equal(unconfigured.status, 0, unconfigured.out);
    assert.match(unconfigured.out, /bindings differing 0; refused 0/u);
  },
);

test(
  "every other module reference is refused by name, and a changed file the check does not parse is listed",
  { timeout: 60_000 },
  () => {
    // each file moved unchanged into `src/nested/`, its family named: only the module references can fail
    const run = (files) => {
      const before = { "package.json": '{ "type": "module" }\n' };
      const after = { ...before };
      const map = {};
      for (const [name, text] of Object.entries(files)) {
        before[`src/${name}`] = text;
        after[`src/${name}`] = null;
        after[`src/nested/${name}`] = text;
        map[`src/${name}`] = `src/nested/${name}`;
      }
      const move = moveOf(before, after);
      try {
        return move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const refusedAt = (out, file, line, what) =>
      assert.match(
        out,
        new RegExp(
          `refused: src/nested/${file.replaceAll(".", "\\.")}:${line} \\(added\\) ".*": ${what}, a module reference the binding rule does not compare`,
          "u",
        ),
      );
    // (a) an `import` keyword outside a compared statement: a type import and a dynamic one; `import.meta` is none
    const imports = run({
      "a.ts": [
        'export type Result = import("./dep.js").RecordType;',
        'export const load = async () => await import("./dep.js");',
        "export const here = import.meta.url;",
        "",
      ].join("\n"),
    });
    assert.equal(imports.status, 1, imports.out);
    refusedAt(imports.out, "a.ts", 1, "an `import`");
    refusedAt(imports.out, "a.ts", 2, "an `import`");
    assert.match(imports.out, /refused 4/u);
    // (b) a `require` identifier
    const required = run({
      "a.cjs": 'const selected = require("./dep.cjs");\nmodule.exports = selected;\n',
    });
    assert.equal(required.status, 1, required.out);
    refusedAt(required.out, "a.cjs", 1, "a `require`");
    // (c) the parser's triple-slash reference directives
    const directives = run({
      "a.ts":
        '/// <reference path="./dep.d.ts" />\n/// <reference types="./dep.d.ts" />\n/// <reference lib="es2024" />\nexport const value = 1;\n',
    });
    assert.equal(directives.status, 1, directives.out);
    refusedAt(directives.out, "a.ts", 1, "a `/// <reference path>`");
    refusedAt(directives.out, "a.ts", 2, "a `/// <reference types>`");
    refusedAt(directives.out, "a.ts", 3, "a `/// <reference lib>`");
    // (d) a comment, JSDoc included, holding `import(` or `@import`
    const comments = run({
      "a.js":
        '// loaded later through import("./dep.js")\nexport const value = null;\n/** @import { RecordType } from "./dep.js" */\n',
    });
    assert.equal(comments.status, 1, comments.out);
    refusedAt(comments.out, "a.js", 1, "a comment's `import\\(`");
    refusedAt(comments.out, "a.js", 3, "a comment's `@import`");
    // a JSDoc type's `import` keyword is (a)'s, however it is spaced, and on a compared statement too
    const spaced = run({
      "a.js": [
        '/** @type {import ("./dep.js").RecordType} */',
        "export const value = null;",
        "/**",
        " * @returns {typeof import",
        ' *   ("./dep.js")}',
        " */",
        "export const load = () => null;",
        '/** @type {import\t("./dep.js").RecordType} */',
        'export { other } from "./other.js";',
        "",
      ].join("\n"),
    });
    assert.equal(spaced.status, 1, spaced.out);
    refusedAt(spaced.out, "a.js", 1, "an `import`");
    refusedAt(spaced.out, "a.js", 4, "an `import`");
    refusedAt(spaced.out, "a.js", 8, "an `import`");
    // a `.jsx` file is parsed
    const jsx = run({
      "a.jsx": 'export const element = <div>{await import("./dep.cjs")}</div>;\n',
    });
    assert.equal(jsx.status, 1, jsx.out);
    refusedAt(jsx.out, "a.jsx", 1, "an `import`");
    // a file the check does not parse is outside the rule, and listed
    const unparsed = run({
      "view.vue": '<script setup>\nimport Dep from "./dep.vue";\n</script>\n',
    });
    assert.equal(unparsed.status, 0, unparsed.out);
    assert.match(
      unparsed.out,
      /not compared \(unparsed\): src\/view\.vue → src\/nested\/view\.vue/u,
    );
  },
);
