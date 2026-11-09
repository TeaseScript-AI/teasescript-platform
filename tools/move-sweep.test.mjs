import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./move-sweep.mjs", import.meta.url));

/** A temporary repository: `write` stages files, `commit` commits them, `run` runs the sweep there. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "move-sweep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
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
    writeFileSync(join(root, `../${name}-${root.split("/").at(-1)}.json`), JSON.stringify(value));
    return join(root, `../${name}-${root.split("/").at(-1)}.json`);
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
    'import { u } from "/a/util.js";',
    'export { u } from "/a/util.js";',
    'const loaded = await import("/a/util.js");',
    'const four = "/a/util.js";',
  ]);
  const { out } = r.run(r.base);
  assert.deepEqual(
    section(out, "4").map((hit) => Number(hit.split(":")[1])),
    [4],
  );
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

test("a run with no BASE and no map, or an unknown option, cannot run", (t) => {
  const r = repository(t);
  r.write({ "a.ts": "export {};\n" });
  r.commit();
  assert.equal(r.run().status, 2);
  assert.equal(r.run("HEAD", "--nope", "x").status, 2);
});
