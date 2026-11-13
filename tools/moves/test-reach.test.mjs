import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "../fixture-git.mjs";
import { stringsOf } from "./test-reach.mjs";

isolateGit();

const TOOL = fileURLToPath(new URL("./test-reach.mjs", import.meta.url));

/** A Git checkout committing `files`; `run` runs the tool there. */
function checkout(t, files) {
  const root = mkdtempSync(join(tmpdir(), "test-reach-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: "utf8" });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  return { root, run };
}

/** A repository with a helper `tests/helpers/moved.ts` and each way a test file reaches it, or does not. */
const REACHING = {
  "tests/helpers/moved.ts": "export const moved = 1;\n",
  "tests/helpers/middle.ts": 'export { moved } from "./moved.js";\n',
  "tests/helpers/other.ts": "export const other = 1;\n",
  // reaching: an import, an import of a module that imports it, a reader of every test file, a built path, a string in
  // a template's code, a file name joined to its folder
  "tests/a/direct.test.ts": 'import { moved } from "../helpers/moved.js";\n',
  "tests/a/through.test.ts": 'import { moved } from "../helpers/middle.js";\n',
  "tools/reader.mjs":
    'import { readdirSync } from "node:fs";\nimport { join } from "node:path";\nexport const all = (root) => readdirSync(join(root, "tests"), { recursive: true });\n',
  "tools/reader.test.mjs": 'import { all } from "./reader.mjs";\n',
  "tools/built.mjs": 'export const load = () => import("../dist/tests/helpers/moved.js");\n',
  "tools/built.test.mjs": 'import { load } from "./built.mjs";\n',
  "tests/a/spawned.test.ts":
    'const url = (file: string) => JSON.stringify(file);\nexport const source = `import { moved } from ${url("../helpers/moved.js")};`;\n',
  "tests/a/joined.test.ts":
    'import { join } from "node:path";\nexport const helper = join(import.meta.dirname, "..", "helpers", "moved.js");\n',
  // not reaching: a path in comments only, another helper, a folder listed with no folder named
  "tests/a/comment.test.ts":
    '// moved to "../helpers/moved.js"\n/* see "../helpers/moved.js" */\nexport const nothing = 1;\n',
  "tests/a/other.test.ts": 'import { other } from "../helpers/other.js";\n',
  "tools/lister.mjs":
    'import { readdirSync } from "node:fs";\nexport const list = (folder) => readdirSync(folder);\n',
  "tools/lister.test.mjs": 'import { list } from "./lister.mjs";\n',
};

test("the test files reaching a module: by import, through another module, a reader of every test file, a built path, a joined path's file name and a template's code (#2583)", (t) => {
  const r = checkout(t, REACHING);
  const result = r.run("tests/helpers/moved.ts");
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(result.out.split("\n"), [
    "test files reaching: 6",
    "  tests/a/direct.test.ts -> tests/helpers/moved.ts",
    "  tests/a/joined.test.ts -> tests/helpers/moved.ts",
    "  tests/a/spawned.test.ts -> tests/helpers/moved.ts",
    "  tests/a/through.test.ts -> tests/helpers/middle.ts -> tests/helpers/moved.ts",
    "  tools/built.test.mjs -> tools/built.mjs -> tests/helpers/moved.ts",
    "  tools/reader.test.mjs -> tools/reader.mjs -> tests/helpers/moved.ts",
    "",
  ]);
  // (a moved test file reaches itself)
  assert.match(r.run("tests/a/other.test.ts").out, /^ {2}tests\/a\/other\.test\.ts$/mu);
  // (usage, and a module the tree does not track)
  assert.equal(r.run().status, 2);
  const untracked = r.run("tests/helpers/none.ts");
  assert.equal(untracked.status, 2);
  assert.match(untracked.err, /does not track tests\/helpers\/none\.ts/u);
});

test("strings are read outside comments, a template's code included, and to the line's end when unclosed (#2583)", () => {
  assert.deepEqual(
    stringsOf(
      [
        '// "in a line comment"',
        '/* "in a block comment" */ const a = "one";',
        "const b = `two ${f('three', { k: `four` })} five`;",
        "const c = 'it\\'s';",
        'const d = "unclosed',
        "const e = 'six'; // 'seven'",
      ].join("\n"),
    ),
    ["one", "three", "four", "two ${ five", "it's", "unclosed", "six"],
  );
});
