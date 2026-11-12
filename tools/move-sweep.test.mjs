import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "./fixture-git.mjs";

isolateGit();

const TOOL = fileURLToPath(new URL("./move-sweep.mjs", import.meta.url));

/** A temporary repository: `write` stages files, `commit` commits them, `run` runs the sweep there. */
function repository(t) {
  // The repository and its maps and declarations, in one folder the test removes.
  const fixture = mkdtempSync(join(tmpdir(), "move-sweep-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, "repository");
  mkdirSync(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  const write = (files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "c", "--allow-empty");
    return git("rev-parse", "HEAD");
  };
  const json = (name, value) => {
    writeFileSync(join(fixture, `${name}.json`), JSON.stringify(value));
    return join(fixture, `${name}.json`);
  };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: "utf8" });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  return { root, git, write, commit, json, run };
}

/** The hit lines of form `form` in a sweep's output. */
function section(out, form) {
  const lines = out.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`== ${form}. `));
  if (at === -1) return [];
  const end = lines.findIndex((line, i) => i > at && line.startsWith("== "));
  return lines
    .slice(at + 1, end === -1 ? undefined : end)
    .filter((line) => line !== "" && !line.startsWith("declared: "));
}

test("a split's stale old path is found, and its rewritten, extension-less and folder forms are not (witness-split 1)", (t) => {
  const r = repository(t);
  r.write({
    "src/big/a.ts": "export const a = 1;\n",
    "src/big/b.ts": "export const b = 1;\n",
    "src/big/c.ts": "export const c = 1;\n",
    "tools/refs.mjs":
      'const stale = "src/big.ts";\nconst rewritten = "src/big/b.ts";\nconst bare = "src/big/b";\nconst folder = "src/big";\n',
  });
  r.commit();
  const map = r.json("split", {
    renames: { "src/big.ts": ["src/big/a.ts", "src/big/b.ts", "src/big/c.ts"] },
  });
  const { status, out } = r.run("--renames", map);
  assert.equal(status, 1);
  assert.deepEqual(section(out, "1"), ['tools/refs.mjs:1: const stale = "src/big.ts";']);
  for (const form of ["4", "5"]) assert.deepEqual(section(out, form), []);
});

test("a split that keeps the original file: its old path is not stale, and its name is not renamed (witness-split 2)", (t) => {
  const r = repository(t);
  r.write({
    "src/big.ts": "export const big = 1;\n",
    "src/big/b.ts": "export const b = 1;\n",
    "tools/refs.mjs": 'const kept = "src/big.ts";\n',
  });
  r.commit();
  const { status, out } = r.run(
    "--renames",
    r.json("kept", { renames: { "src/big.ts": ["src/big.ts", "src/big/b.ts"] } }),
  );
  assert.equal(status, 0);
  assert.match(out, /^== 3\. renamed name \(classify\): 0$/mu);
});

test("a split that keeps the original file: its name after any folder is no hit of form 4 or 5, a leaving name's is (#2526)", (t) => {
  const r = repository(t);
  r.write({
    "src/core/big.ts": "export const big = 1;\n",
    "src/core/part.ts": "export const part = 1;\n",
    "src/core/gone.ts": "export const gone = 1;\n",
    // (a fixture's invented module paths, as a lint test's sources name them: no folder of the tree)
    "tools/refs.mjs": [
      'const kept = "./fixture/big.js";',
      "const keptGroup = /fixture\\/(big|other)\\.js/;",
      'const left = "./fixture/old.js";',
      "const leftGroup = /fixture\\/(old|other)\\.js/;",
      "",
    ].join("\n"),
  });
  r.commit();
  const kept = r.run(
    "--renames",
    r.json("kept", {
      renames: {
        "src/core/big.ts": ["src/core/big.ts", "src/core/part.ts"],
        "src/core/old.ts": ["src/core/gone.ts"],
      },
    }),
  );
  assert.equal(kept.status, 1);
  assert.deepEqual(section(kept.out, "4"), ['tools/refs.mjs:3: const left = "./fixture/old.js";']);
  assert.deepEqual(section(kept.out, "5"), [
    "tools/refs.mjs:4: const leftGroup = /fixture\\/(old|other)\\.js/;",
  ]);
  // (the same lines, `big.ts` now leaving: both its lines are hits)
  const leaving = r.run(
    "--renames",
    r.json("leaving", { renames: { "src/core/big.ts": ["src/core/part.ts"] } }),
  );
  assert.deepEqual(section(leaving.out, "4"), [
    'tools/refs.mjs:1: const kept = "./fixture/big.js";',
  ]);
  assert.deepEqual(section(leaving.out, "5"), [
    "tools/refs.mjs:2: const keptGroup = /fixture\\/(big|other)\\.js/;",
  ]);
});

test("a move referenced without its extension: form 1 and form 4 find it, 2b lists the bare name last (witness-split 3)", (t) => {
  const r = repository(t);
  r.write({
    "lib/core/util.ts": "export const util = 1;\n",
    "tools/bare.mjs":
      'const stale = "lib/util";\nconst rewritten = "lib/core/util";\nconst served = "/serve/util";\nconst name = "util";\n',
  });
  r.commit();
  const { status, out } = r.run(
    "--renames",
    r.json("bare", { renames: { "lib/util.ts": "lib/core/util.ts" } }),
  );
  assert.equal(status, 1);
  assert.deepEqual(section(out, "1"), ['tools/bare.mjs:1: const stale = "lib/util";']);
  // Form 4 reads the old path's last folder and name too, as the reference sweep does.
  assert.deepEqual(section(out, "4"), [
    'tools/bare.mjs:1: const stale = "lib/util";',
    'tools/bare.mjs:3: const served = "/serve/util";',
  ]);
  assert.deepEqual(section(out, "2b"), ['tools/bare.mjs:4: const name = "util";']);
  assert.deepEqual(section(out, "2"), []);
  const headings = out.split("\n").filter((line) => line.startsWith("== "));
  assert.match(headings.at(-1), /^== 2b\. /u, "form 2's bare names print last");
});

/** A repository where `src/a/util.ts` moved to `src/b/util.ts` and `src/tlock.ts` to `src/time-lock.ts`, with `refs`. */
function moved(t, refs) {
  const r = repository(t);
  r.write({
    "src/a/util.ts": "export const u = 1;\n",
    "src/tlock.ts": "export const l = 1;\n",
    "src/other.ts": "export const o = 1;\n",
  });
  const base = r.commit();
  r.git("mv", "src/a/util.ts", "src/b-util.tmp");
  mkdirSync(join(r.root, "src/b"), { recursive: true });
  r.git("mv", "src/b-util.tmp", "src/b/util.ts");
  r.git("mv", "src/tlock.ts", "src/time-lock.ts");
  r.write({ "tools/refs.mjs": refs.join("\n") + "\n" });
  r.commit();
  return { ...r, base };
}

test("each form finds its stale reference and not the rewritten one", (t) => {
  const r = moved(t, [
    'const one = "src/a/util.ts";', // 1
    'const oneNew = "src/b/util.ts";', // 2
    'const two = "util.ts";', // 3
    'const twoOther = "other.ts";', // 4
    "// see tlock.ts", // 5
    "// see time-lock.ts", // 6
    'const four = "/a/util.js";', // 7
    'const fourNew = "/b/util.js";', // 8
    String.raw`const five = /\/a\/(util|other)\.js/;`, // 9
    String.raw`const fiveNew = /\/b\/(util|other)\.js/;`, // 10
  ]);
  const { status, out } = r.run(r.base);
  assert.equal(status, 1);
  const lines = (form) => section(out, form).map((hit) => Number(hit.split(":")[1]));
  assert.deepEqual(lines("1"), [1]);
  assert.deepEqual(lines("2"), [3]);
  assert.deepEqual(lines("3"), [5]);
  assert.deepEqual(lines("4"), [1, 7], "form 4 also reads the root path's last folder and name");
  assert.deepEqual(lines("5"), [9]);
});

test("form 1 finds the old path's compiled forms, `.js` and under `dist/`", (t) => {
  const r = moved(t, [
    'const js = "src/a/util.js";',
    'const dist = "dist/src/a/util.js";',
    'const fresh = "dist/src/b/util.js";',
  ]);
  const { out } = r.run(r.base);
  assert.deepEqual(
    section(out, "1").map((hit) => Number(hit.split(":")[1])),
    [1, 2],
  );
});

test("an extension-less reference counts in forms 1, 4 and 5, and its bare name in 2b", (t) => {
  const r = moved(t, [
    'const one = "src/a/util";', // 1
    'const four = "/a/util";', // 2
    'const five = "/a/(util|other)";', // 3
    'const bare = "util";', // 4
    'const folder = "src/b";', // 5
  ]);
  const { out } = r.run(r.base);
  const lines = (form) => section(out, form).map((hit) => Number(hit.split(":")[1]));
  assert.deepEqual(lines("1"), [1]);
  assert.deepEqual(lines("4"), [1, 2], "form 4 also reads the root path's last folder and name");
  assert.deepEqual(lines("5"), [3]);
  assert.deepEqual(lines("2b"), [4]);
});

test("import and export specifiers are skipped in forms 4 and 5", (t) => {
  const r = moved(t, [
    'import { u } from "/a/util.js";', // 1
    'export { u } from "/a/util.js";', // 2
    'const loaded = await import("/a/util.js");', // 3
    'const four = "/a/util.js";', // 4
    'import { v } from "/a/(util|other).js";', // 5
    'export { v } from "/a/(util|other).js";', // 6
    'const five = "/a/(util|other).js";', // 7
  ]);
  const { out } = r.run(r.base);
  const lines = (form) => section(out, form).map((hit) => Number(hit.split(":")[1]));
  assert.deepEqual(lines("4"), [4]);
  assert.deepEqual(lines("5"), [7]);
});

test("the text semantics are Python's: its whitespace and strip, `.` across U+2028, a byte-order mark kept", (t) => {
  const r = moved(t, [
    '\uFEFFimport "/a/util.js";', // 1: U+FEFF is no whitespace to Python, so this is no specifier line: a hit
    '\u0085import "/a/util.js";', // 2: U+0085 is, so the line is a specifier, skipped
    '\u001Cimport "/a/util.js";', // 3: U+001C is too: skipped
    'export {x} /*\u2028*/ from "/a/util.js";', // 4: `.` crosses U+2028: a specifier, skipped
    '\u001C const four = "/a/util.js"; \u0085', // 5: a hit, printed stripped of U+001C and U+0085
    '\u00A0const four = "/a/util.js";\uFEFF', // 6: a hit; U+00A0 is stripped, U+FEFF kept
  ]);
  const { out } = r.run(r.base);
  assert.deepEqual(section(out, "4"), [
    'tools/refs.mjs:1: \uFEFFimport "/a/util.js";',
    'tools/refs.mjs:5: const four = "/a/util.js";',
    'tools/refs.mjs:6: const four = "/a/util.js";\uFEFF',
  ]);
});

test("a byte-order mark in a moved file's name stays in the derived map, as in a passed one", (t) => {
  const r = repository(t);
  r.write({ "\uFEFFold.ts": "export {};\n" });
  const base = r.commit();
  r.git("mv", "\uFEFFold.ts", "new.ts");
  r.write({ "refs.mjs": 'const name = "old.ts";\nconst marked = "\uFEFFold.ts";\n' });
  r.commit();
  const derived = r.run(base);
  const passed = r.run("--renames", r.json("bom", { renames: { "\uFEFFold.ts": "new.ts" } }));
  assert.equal(derived.out, passed.out);
  assert.equal(derived.status, passed.status);
  assert.deepEqual(section(derived.out, "1"), ['refs.mjs:2: const marked = "\uFEFFold.ts";']);
});

test("a path named `__proto__` is a key of the map like any other: derived, passed and split", (t) => {
  const r = repository(t);
  // A computed key: `{ __proto__: … }` would set the literal's prototype, not make a key.
  r.write({ ["__proto__"]: "x\n" });
  const base = r.commit();
  r.git("mv", "__proto__", "new");
  r.write({ "refs.mjs": 'const x = "__proto__";\n' });
  r.commit();
  const expected = ['refs.mjs:1: const x = "__proto__";'];
  const derived = r.run(base);
  assert.equal(derived.status, 1);
  assert.deepEqual(section(derived.out, "1"), expected);
  const passed = r.run("--renames", r.json("proto", { renames: { ["__proto__"]: "new" } }));
  assert.deepEqual(section(passed.out, "1"), expected);
  const split = r.run(
    "--renames",
    r.json("none", { renames: { "other.ts": "o/other.ts" } }),
    "--splits",
    r.json("split", JSON.parse('{"renames": {"__proto__": ["new", "new2"]}}')),
  );
  assert.deepEqual(section(split.out, "1"), expected);
});

test("on purpose unlike the Python sweep: an empty map applies no form, a quoted name is read, a link is not", (t) => {
  const r = repository(t);
  r.write({
    "refs.mjs": 'const x = "/.ts";\n',
    "caf\u00e9.mjs": 'const four = "/a/util.js";\n',
    // The link's target holds a stale reference, and so does the link's own blob, its target's path: reading the blob as
    // text or following the link would each add a hit.
    "y/target.js": 'const stale = "y/target.ts";\n',
  });
  symlinkSync("y/target.js", join(r.root, "link.mjs"));
  // A link to a file outside the repository, which Git does not track: its stale reference is not read either.
  writeFileSync(join(r.root, "..", "outside.txt"), 'const stale = "y/target.ts";\n');
  symlinkSync("../outside.txt", join(r.root, "linked-out.mjs"));
  r.commit();
  const empty = r.run("--renames", r.json("empty", { renames: {} }));
  assert.equal(empty.status, 0);
  for (const form of ["1", "2", "3", "4", "5", "2b"])
    assert.deepEqual(section(empty.out, form), []);
  // A move from `a/util.ts`: the non-ASCII-named file is read, as Git names it.
  const moved = r.run("--renames", r.json("util", { renames: { "a/util.ts": "b/util.ts" } }));
  assert.deepEqual(section(moved.out, "4"), ['caf\u00e9.mjs:1: const four = "/a/util.js";']);
  // The link's blob is its target's path; the target is read under its own name, once.
  const linked = r.run(
    "--renames",
    r.json("target", { renames: { "y/target.ts": "z/target.ts" } }),
  );
  assert.deepEqual(section(linked.out, "1"), ['y/target.js:1: const stale = "y/target.ts";']);
});

test("a map or declaration file that is not UTF-8 cannot be read: exit 2", (t) => {
  const r = moved(t, ['const fixture = "/a/util.js";']);
  // Latin-1 writes each character as one byte, so `\xff` is a lone 0xff byte, never UTF-8.
  const raw = (name, text) => {
    const file = r.json(name, null);
    writeFileSync(file, Buffer.from(text, "latin1"));
    return file;
  };
  const map = raw("map", '{"renames": {"src/a/\xff.ts": "src/b/new.ts"}}');
  for (const args of [
    ["--renames", map],
    [r.base, "--splits", map],
  ]) {
    const { status, err } = r.run(...args);
    assert.equal(status, 2, args.join(" "));
    assert.match(err, /cannot read the map/u);
  }
  const declared = raw(
    "declared",
    '[{"file": "tools/refs.mjs", "line": 1, "reason": "a \xff fixture"}]',
  );
  const refused = r.run(r.base, "--declare", declared);
  assert.equal(refused.status, 2);
  assert.match(refused.err, /cannot read the declarations/u);
});

test("a map of the wrong shape cannot run: no renames object, an empty list of new paths, a path that is no string", (t) => {
  const r = moved(t, ['const fixture = "/a/util.js";']);
  for (const [name, value, message] of [
    ["no-renames", { moves: {} }, /has no "renames" object/u],
    // A split to nothing: the Python swept such an old path; here the map is malformed.
    ["empty-list", { renames: { "src/a/util.ts": [] } }, /gives src\/a\/util\.ts no new path/u],
    [
      "not-a-string",
      { renames: { "src/a/util.ts": ["src/b/util.ts", 5] } },
      /gives src\/a\/util\.ts no new path/u,
    ],
  ]) {
    const { status, out, err } = r.run("--renames", r.json(name, value));
    assert.equal(status, 2, name);
    assert.match(err, message, name);
    assert.equal(out, "", name);
  }
});

test("a tracked file that is not UTF-8 is not read and is listed last, and the exit status stays the hits'", (t) => {
  const r = repository(t);
  r.write({
    "src/new.ts": "export const n = 1;\n",
    "tools/refs.mjs": 'const fresh = "src/new.ts";\n',
  });
  r.commit();
  const map = r.json("map", { renames: { "src/old.ts": "src/new.ts" } });
  const utf8 = r.run("--renames", map);
  assert.equal(utf8.status, 0);
  assert.ok(!utf8.out.includes("not read"), "no section when every file is UTF-8");
  // Latin-1 é: read as UTF-8, this line would be a form-1 hit.
  r.write({ "docs/legacy.md": Buffer.from('const stale = "src/old.ts"; caf\xe9\n', "latin1") });
  r.commit();
  const unread = r.run("--renames", map);
  assert.equal(unread.status, 0);
  assert.deepEqual(section(unread.out, "1"), []);
  assert.ok(unread.out.endsWith("== not read, not UTF-8: 1 files\ndocs/legacy.md\n"), unread.out);
  r.write({ "tools/refs.mjs": 'const stale = "src/old.ts";\n' });
  r.commit();
  const hit = r.run("--renames", map);
  assert.equal(hit.status, 1);
  assert.deepEqual(section(hit.out, "1"), ['tools/refs.mjs:1: const stale = "src/old.ts";']);
  assert.ok(hit.out.endsWith("== not read, not UTF-8: 1 files\ndocs/legacy.md\n"), hit.out);
});

test("a declared hit passes, an undeclared one fails, and a declaration that matches nothing cannot run", (t) => {
  const r = moved(t, ['const fixture = "/a/util.js";']);
  const declared = r.json("declared", [
    { file: "tools/refs.mjs", line: 1, reason: "a fixture's invented path" },
  ]);
  const passed = r.run(r.base, "--declare", declared);
  assert.equal(passed.status, 0, passed.err);
  assert.match(passed.out, /^declared: tools\/refs\.mjs:1: a fixture's invented path$/mu);
  assert.equal(r.run(r.base).status, 1);
  const stale = r.json("stale", [{ file: "tools/refs.mjs", line: 9, reason: "nothing there" }]);
  const refused = r.run(r.base, "--declare", stale);
  assert.equal(refused.status, 2);
  assert.match(refused.err, /matches no hit/u);
});

test("the map derived from the change is the map passed for the same move", (t) => {
  const r = moved(t, [
    'const one = "src/a/util.ts";',
    String.raw`const five = /\/a\/(util|other)\.js/;`,
    "// see tlock.ts",
  ]);
  const map = r.json("same", {
    renames: { "src/a/util.ts": "src/b/util.ts", "src/tlock.ts": "src/time-lock.ts" },
  });
  const derived = r.run(r.base);
  const passed = r.run("--renames", map);
  assert.equal(derived.status, passed.status);
  assert.equal(derived.out, passed.out);
});

test("--help, no BASE and no map, or an unknown option print the usage and cannot run", (t) => {
  const r = repository(t);
  r.write({ "a.ts": "export {};\n" });
  r.commit();
  for (const args of [["--help"], ["-h"], [], ["HEAD", "--nope", "x"]]) {
    const { status, err } = r.run(...args);
    assert.equal(status, 2, args.join(" "));
    assert.match(err, /usage: node tools\/move-sweep\.mjs/u, args.join(" "));
  }
});
