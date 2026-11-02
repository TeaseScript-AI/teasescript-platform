import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const runner = resolve(process.cwd(), "tests/families/run.mjs");
const baselines = resolve(process.cwd(), "tests/families/baselines.mjs");
const stalls = resolve(process.cwd(), "tests/families/stalls.mjs");

/** A built tree's oracle library that throws in every mode where a source says `throw`, as #1439's stale caller did. */
const library = `export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publication(files) {
  if (files[0].source.includes("throw"))
    throw new TypeError("Cannot read properties of undefined (reading 'map')");
  // (the four elements a publication's whole text has, as a library before \`publicationParts\` writes it)
  return '["published","",[],""]';
}
`;

test("the corpus runner fails four identical exceptions instead of counting them as agreement (#1439)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "dist", "tests", "helpers", "type-core-oracles.js"), library);
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "canary.mjs"),
      'export const cases = [["throws", "throw"], ["publishes", "exit"]];\n',
    );
    const out = join(directory, "out.jsonl");

    // the same tree as base and head: every run of `throws` throws the same exception on both
    const result = spawnSync(process.execPath, [runner, area, tree, tree, "--out", out], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr);
    const total = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(
      [total.sources, total.stalled, total.exceptions, total.runs, total.differences],
      [2, 0, 4, 8, 0],
    );
    const modes = ["src-on", "src-off", "rev-on", "rev-off"].map(
      (mode) => `throws ${mode} publication`,
    );
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    // each named on stderr with its source and mode, and kept with both trees' exceptions
    assert.deepEqual(
      lines(result.stderr).map(({ source, mode, check }) => `${source} ${mode} ${check}`),
      modes,
    );
    const kept = lines(readFileSync(out, "utf8"));
    assert.deepEqual(
      kept.map(({ source, mode, check }) => `${source} ${mode} ${check}`),
      modes,
    );
    for (const { thrown } of kept)
      for (const stack of [thrown.base, thrown.head])
        assert.match(
          stack,
          /^TypeError: Cannot read properties of undefined \(reading 'map'\)\n {4}at /,
        );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library that publishes as one whole (`whole`) or only by its parts' hashes, where the whole throws:
 * the source `same` publishes the same on both, `changed` changes the second occurrence on the parts tree, `longer`
 * adds one.
 */
const publishing = (whole: boolean): string => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const occurrences = (source) =>
  ${whole} || source === "same"
    ? [[1, "x"], [2, "y"]]
    : source === "changed"
      ? [[1, "x"], [2, "z"]]
      : [[1, "x"], [2, "y"], [3, "w"]];
export function publication(files) {
  if (!${whole}) throw new Error("a tree with parts is compared by its parts, never joined");
  return JSON.stringify(["A", "R", occurrences(files[0].source), "T"]);
}
${
  whole
    ? ""
    : `export const publicationHashes = (files) =>
  ['"A"', '"R"', ...occurrences(files[0].source).map((occurrence) => JSON.stringify(occurrence)), '"T"'].map(
    (text) => createHash("sha256").update(text).digest("hex"),
  );`
}
`;

test("the corpus runner compares a publication by its parts, also against a library before them (#1503)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const trees = [true, false].map((whole) => {
      const tree = join(directory, whole ? "whole" : "parts");
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        publishing(whole),
      );
      return tree;
    });
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "parts.mjs"),
      'export const cases = [["same", "same"], ["changed", "changed"], ["longer", "longer"]];\n',
    );
    // each direction: the first part that differs (answers 0, record 1, occurrences from 2, the route last) and each
    // tree's count of parts, in all four modes
    for (const [base, head, longer] of [
      [trees[0]!, trees[1]!, [5, 6]],
      [trees[1]!, trees[0]!, [6, 5]],
    ] as const) {
      const out = join(directory, "out.jsonl");
      const result = spawnSync(process.execPath, [runner, area, base, head, "--out", out], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr);
      const total = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      assert.deepEqual([total.exceptions, total.runs, total.differences], [0, 12, 8]);
      const found = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map(({ source, part, parts }) => `${source} ${part} ${parts.join("/")}`);
      assert.deepEqual(new Set(found), new Set(["changed 3 5/5", `longer 4 ${longer.join("/")}`]));
      assert.equal(found.length, 8);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose oracle stops its own questions on the source `stopped`, leaving two nodes unanswered:
 * counted apart from its parts' hashes (`counted`), in its joined publication's fifth element (`whole`), or a library
 * before that count (`before`), which hashes the same parts and has none.
 */
const stopping = (
  form: "before" | "counted" | "whole",
): string => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
${
  form === "whole"
    ? `export const publication = (files) =>
  \`["A","R",[[1,"x"]],"T"\${files[0].source === "stopped" ? ',{"unanswered":2}' : ""}]\`;`
    : `export const publicationHashes = (files) => {
  const parts = ['"A"', '"R"', '[1,"x"]', '"T"'].map((text) => createHash("sha256").update(text).digest("hex"));
  return ${form === "counted"} ? { parts, unanswered: files[0].source === "stopped" ? 2 : 0 } : parts;
};`
}
`;

test("the corpus runner counts a publication its oracle left unanswered apart, never as agreement (#1499)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const [before, counted, whole] = (["before", "counted", "whole"] as const).map((form) => {
      const tree = join(directory, form);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(tree, "dist", "tests", "helpers", "type-core-oracles.js"), stopping(form));
      return tree;
    });
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "stops.mjs"),
      'export const cases = [["stopped", "stopped"], ["answered", "answered"]];\n',
    );
    // the same stop on both trees, and a joined publication's against a library before the count and a counted one:
    // `answered` agrees in each
    for (const [base, head, counts] of [
      [counted!, counted!, [2, 2]],
      [before!, whole!, [0, 2]],
      [whole!, counted!, [2, 2]],
    ] as const) {
      const out = join(directory, "out.jsonl");
      const result = spawnSync(process.execPath, [runner, area, base, head, "--out", out], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr);
      const total = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      assert.deepEqual(
        [total.exceptions, total.unanswered, total.runs, total.differences],
        [0, 4, 8, 0],
      );
      const kept = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        kept.map(({ source, unanswered }) => [source, unanswered.base, unanswered.head]),
        Array.from({ length: 4 }, () => ["stopped", ...counts]),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library where the source `changed` publishes its fourth part differently on the head, `throws` throws
 * and `stopped` leaves two nodes unanswered on the base, and `ends` ends the process on both.
 */
const storable = (head: boolean): string => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publicationHashes(files) {
  const source = files[0].source;
  if (!${head} && source === "throws") throw new TypeError("no publication");
  if (source === "ends") process.exit(3);
  const changed = ${head} && source === "changed";
  const parts = ['"A"', '"R"', '[1,"x"]', changed ? '[2,"z"]' : '[2,"y"]', '"T"'].map((text) =>
    createHash("sha256").update(text).digest("hex"),
  );
  return { parts, unanswered: !${head} && source === "stopped" ? 2 : 0 };
}
`;

/**
 * A tree's `src/` whose git tree id is `SRC` (`git write-tree` of the same files, then `<tree>:src`): a folder sorting
 * after a file its name begins, an executable, a link, and an empty folder, which git leaves out.
 */
const SRC = "da445cc8e80d8e4082809c34579aaed8451b7efc";
function writeSrc(tree: string, extra = ""): void {
  mkdirSync(join(tree, "src", "a"), { recursive: true });
  mkdirSync(join(tree, "src", "empty"));
  writeFileSync(join(tree, "src", "a.ts"), `a\n${extra}`);
  writeFileSync(join(tree, "src", "a", "b.ts"), "b\n");
  writeFileSync(join(tree, "src", "run.sh"), "x\n", { mode: 0o755 });
  symlinkSync("a.ts", join(tree, "src", "link.ts"));
}

test("the corpus runner stores a tree in the baseline of its src/ tree, verified shard by shard, which judges a head as the base tree beside it does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    // the base as two commits with one `src/` tree and built oracle library, one with another library, and the head
    const tree = (name: string, sha: string, library = "", extra = "") => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "package-lock.json"), "{}\n");
      writeFileSync(
        join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
        storable(name === "head") + library,
      );
      writeFileSync(join(folder, ".sha"), `${sha.repeat(40)}\n`);
      writeSrc(folder, extra);
      mkdirSync(join(folder, "tests", "families", "area"), { recursive: true });
      writeFileSync(join(folder, "tests", "families", "area", "stored.mjs"), generator(names));
      return folder;
    };
    const names = ["same", "changed", "throws", "stopped", "ends"];
    const generator = (order: string[]) =>
      `export const cases = ${JSON.stringify(order.map((name) => [name, name]))};\n`;
    const base = tree("base", "1");
    const alias = tree("alias", "2");
    const other = tree("other", "3", "// another oracle library\n");
    const head = tree("head", "4");
    const area = join(base, "tests", "families", "area");
    const root = join(directory, "baselines");
    const baseline = join(root, SRC, "area");
    // a store runs as the hook's jobs run it where `sx-sandbox` is found (#1542): only its tree's baseline and its
    // scratch writable, every write elsewhere failing (EROFS); else as is
    const scratch = join(directory, "scratch");
    const sandboxed =
      spawnSync("sx-sandbox", ["--write", scratch, "--", "true"], { stdio: "ignore" }).status === 0;
    const { identityOf } = await import(pathToFileURL(baselines).href);
    const store = (from: string, ...args: string[]) => {
      const command = [runner, args[0]!, from, "--store", ...args.slice(1)];
      const writable = join(args[1]!, identityOf(from).src);
      return sandboxed
        ? spawnSync(
            "sx-sandbox",
            ["--write", writable, "--write", scratch, "--", process.execPath, ...command],
            { encoding: "utf8", env: { ...process.env, TMPDIR: scratch } },
          )
        : spawnSync(process.execPath, command, { encoding: "utf8" });
    };
    const into = (from: string, shard: string, ...more: string[]) =>
      store(from, area, root, "--shard", shard, ...more);
    const state = (from: string, folder = root) =>
      spawnSync(process.execPath, [baselines, "state", from, folder, "--read-only"], {
        encoding: "utf8",
      });
    const states = (result: { stdout: string }) =>
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(({ area: name }) => name !== undefined)
        .map(({ area: name, state: what, verified: count }) => `${name} ${what} ${count}`);
    const out = join(directory, "out.jsonl");
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [runner, area, ...args, "--out", out], {
        encoding: "utf8",
      });
      const total = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      const kept = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map(({ files, globals, ...line }) => line);
      return { status: result.status, total, kept };
    };
    const counts = ({ total }: { total: Record<string, number> }) =>
      ["sources", "stalled", "exceptions", "unanswered", "uncompared", "runs", "differences"].map(
        (key) => total[key],
      );

    // one shard from one commit, the other from the other: while a running writer claims it, the second is left to
    // it; a writer that ended (another start time) claims it no longer, and its temporary file goes
    assert.equal(into(base, "0/2").status, 1);
    assert.deepEqual(readdirSync(baseline).sort(), ["0of2.runs.jsonl", "PLAN"]);
    const stat = readFileSync("/proc/self/stat", "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    writeFileSync(join(baseline, ".1of2.claim"), `${process.pid}-${started}\n`);
    assert.match(into(alias, "1/2").stdout, /"skipped":"being stored by another writer"/);
    writeFileSync(join(baseline, ".1of2.claim"), `${process.pid}-1\n`);
    writeFileSync(join(baseline, `1of2.runs.jsonl.${process.pid}-1.tmp`), "partial\n");
    assert.equal(into(alias, "1/2").status, 1);
    const files = ["0of2.runs.jsonl", "1of2.runs.jsonl", "PLAN"];
    assert.deepEqual(readdirSync(baseline).sort(), files);
    // one baseline, named by the `src/` tree, with what its runs depend on, both commits and the area's PLAN
    const again = into(alias, "0/2");
    assert.equal(again.status, 0);
    assert.match(again.stdout, /"skipped":"stored"/);
    assert.deepEqual(readdirSync(root), [SRC]);
    const manifest = readFileSync(join(root, SRC, "MANIFEST"), "utf8").split("\n");
    assert.deepEqual(manifest.slice(0, 2), ["baseline 3", `src ${SRC}`]);
    assert.match(
      manifest.slice(2, 5).join("\n"),
      /^oracles [0-9a-f]{64}\nlock [0-9a-f]{40}\nnode v/,
    );
    assert.deepEqual(manifest.slice(5), [
      `commit ${"1".repeat(40)} ${base}`,
      `area area 2 ${createHash("sha256")
        .update(readFileSync(join(baseline, "PLAN")))
        .digest("hex")}`,
      `commit ${"2".repeat(40)} ${alias}`,
      "",
    ]);
    const complete = state(alias);
    assert.equal(complete.status, 0);
    assert.deepEqual(states(complete), ["area complete 2"]);

    // refused, nothing written: another count of shards; the same sources in another order (#1542 r1: the second
    // writer's shard would hold the first's sources again) or with other checks; another oracle library; other than
    // the defaults; a folder this tool did not make
    assert.match(into(base, "0/3").stderr, /is planned otherwise/);
    const reordered = join(directory, "reordered", "area");
    mkdirSync(reordered, { recursive: true });
    writeFileSync(join(reordered, "stored.mjs"), generator([...names].reverse()));
    assert.equal(store(alias, reordered, root, "--shard", "1/2").status, 2);
    const checked = join(directory, "checked", "area");
    mkdirSync(checked, { recursive: true });
    writeFileSync(
      join(checked, "stored.mjs"),
      `${generator(names)}export const checks = ["stops"];\n`,
    );
    assert.match(store(alias, checked, root, "--shard", "1/2").stderr, /is planned otherwise/);
    assert.match(into(other, "0/2").stderr, /holds runs of another oracles than this tree's/);
    assert.equal(into(base, "0/2", "--timeout", "5").status, 2);
    assert.deepEqual(readdirSync(baseline).sort(), files);
    const elsewhere = join(directory, "elsewhere");
    mkdirSync(join(elsewhere, SRC, "data"), { recursive: true });
    writeFileSync(join(elsewhere, SRC, "data", "kept"), "x\n");
    assert.match(store(base, area, elsewhere).stderr, /is not this tool's/);
    // a baseline of this tool that holds a foreign path (#1542 r2: foreign-child): writers and `state` refuse it, naming
    // the path
    const gone = tree("gone", "5", "", "gone\n");
    const foreign = tree("foreign", "6", "", "foreign\n");
    assert.equal(store(gone, area, elsewhere).status, 1);
    assert.equal(store(foreign, area, elsewhere, "--shard", "0/2").status, 1);
    const last = (result: { stdout: string }) =>
      JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const held = join(
      elsewhere,
      readdirSync(elsewhere).find((name) =>
        existsSync(join(elsewhere, name, "area", "0of2.runs.jsonl")),
      )!,
    );
    mkdirSync(join(held, "other-agent"));
    writeFileSync(join(held, "other-agent", "data"), "x\n");
    assert.match(
      store(foreign, area, elsewhere, "--shard", "1/2").stderr,
      /foreign contents, which this tool did not write: other-agent\//,
    );
    const seen = state(foreign, elsewhere);
    assert.equal(seen.status, 2);
    assert.match(last(seen).refused, /foreign contents/);

    // a shard cut short (#1542 r1) no longer verifies, and any writer replaces it
    const second = join(baseline, "1of2.runs.jsonl");
    writeFileSync(second, readFileSync(second, "utf8").split("\n").slice(0, -2).join("\n"));
    const damaged = state(base);
    assert.equal(damaged.status, 1);
    assert.deepEqual(states(damaged), ["area damaged 1"]);
    assert.equal(into(base, "1/2").status, 1);
    assert.deepEqual(states(state(base)), ["area complete 2"]);

    // the head against the stored base and against the base tree run beside it
    const beside = run(base, head);
    const against = run(head, "--baseline", baseline);
    assert.deepEqual(counts(beside), [5, 1, 4, 4, 0, 16, 4]);
    assert.deepEqual(counts(against), counts(beside));
    assert.equal(against.status, 1);
    // its record (#1564): one tree, whose work these trees without a ledger record as `null`, and each stall's trees,
    // a stall of both trees for a reason other than time unknown without the base's work
    const record = join(directory, "against.work.jsonl");
    assert.equal(run(head, "--baseline", baseline, "--work", record).status, 1);
    const recorded = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .slice(1, -1);
    assert.deepEqual(
      recorded.map(({ source }) => source),
      names,
    );
    for (const { runs: ran } of recorded)
      for (const { work, ms } of ran) assert.deepEqual([work, ms.length], [[null], 1]);
    assert.deepEqual(recorded.find(({ source }) => source === "ends").stalled, {
      base: "exit 3",
      head: "exit 3",
    });
    assert.match(
      spawnSync(process.execPath, [stalls, record], { encoding: "utf8" }).stdout,
      /"source":"ends".*"verdict":"unknown"/,
    );
    // its index rerun on both trees: a base of the MANIFEST's identity is the stored base, one of another oracle
    // library is not (#1564 r4)
    const index = join(directory, "index.json");
    spawnSync(process.execPath, [stalls, record, "--index", index]);
    const rerun = (from: string, folder: string) =>
      spawnSync(process.execPath, [stalls, "rerun", index, from, head, join(directory, folder)], {
        encoding: "utf8",
      });
    assert.match(rerun(other, "rerun-other").stderr, /is not the tree/);
    assert.equal(rerun(alias, "rerun-alias").status, 1);
    const merged = spawnSync(
      process.execPath,
      [stalls, record, "--rerun", join(directory, "rerun-alias", "area.work.jsonl")],
      { encoding: "utf8" },
    );
    assert.equal(merged.status, 1, merged.stderr);
    const runs = ({ kept }: { kept: Record<string, unknown>[] }) =>
      kept.filter(({ mode }) => mode !== undefined).map(({ thrown, ...line }) => line);
    assert.deepEqual(runs(against), runs(beside));
    assert.deepEqual(
      against.kept.filter(({ stalled }) => stalled !== undefined),
      [{ generator: "stored.mjs", source: "ends", stalled: { base: "exit 3", head: "exit 3" } }],
    );

    // a source the baseline does not hold (one more of the head's): its runs uncompared, never agreement
    const more = join(directory, "more", "area");
    mkdirSync(more, { recursive: true });
    writeFileSync(join(more, "stored.mjs"), generator([...names, "added"]));
    const added = spawnSync(
      process.execPath,
      [runner, more, head, "--baseline", baseline, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(added.status, 1);
    assert.deepEqual(
      readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(({ uncompared }) => uncompared !== undefined)
        .map(({ source, uncompared }) => [source, uncompared]),
      [["added", ["src-on", "src-off", "rev-on", "rev-off"].map((mode) => `${mode} publication`)]],
    );

    // the comparison reads a baseline only through the rule status shares (#1542, the owner's reviewer): a copy of the
    // complete baseline, damaged, or given a complete shard another tree stored, is refused by the comparison as by
    // status (exit 1: not complete; 2: not this tool's, or holding runs of other inputs or a foreign path), so that
    // no comparison ever judges against runs that are not this baseline's
    const another = tree("another", "7", "", "another\n");
    const anotherOracles = tree("another-oracles", "8", "// another oracle library\n", "oracles\n");
    const strangers = join(directory, "strangers");
    for (const stranger of [another, anotherOracles])
      for (const shard of ["0/2", "1/2"])
        assert.equal(store(stranger, area, strangers, "--shard", shard).status, 1);
    const strange = (from: string) =>
      join(strangers, identityOf(from).src, "area", "0of2.runs.jsonl");
    const shard = (dir: string) => join(dir, "area", "0of2.runs.jsonl");
    const witnesses: [string, number, (dir: string) => void][] = [
      [
        "a shard's footer removed",
        1,
        (dir) =>
          writeFileSync(
            shard(dir),
            readFileSync(shard(dir), "utf8").split("\n").slice(0, -2).join("\n") + "\n",
          ),
      ],
      [
        "a field its hash covers altered",
        1,
        (dir) =>
          writeFileSync(
            shard(dir),
            readFileSync(shard(dir), "utf8")
              .replace('"T"', '"U"')
              .replace(/"[0-9a-f]{64}"/, `"${"0".repeat(64)}"`),
          ),
      ],
      ["its PLAN removed", 1, (dir) => rmSync(join(dir, "area", "PLAN"))],
      ["its MANIFEST removed", 2, (dir) => rmSync(join(dir, "MANIFEST"))],
      [
        "its MANIFEST's header changed",
        2,
        (dir) =>
          writeFileSync(
            join(dir, "MANIFEST"),
            readFileSync(join(dir, "MANIFEST"), "utf8").replace(
              /^oracles \w+$/m,
              `oracles ${"0".repeat(64)}`,
            ),
          ),
      ],
      // (#1542 r6: a header accepted only as this tool writes one, by status and by the comparison alike)
      [
        "a token added to its MANIFEST's header",
        2,
        (dir) =>
          writeFileSync(
            join(dir, "MANIFEST"),
            readFileSync(join(dir, "MANIFEST"), "utf8").replace(/^(oracles \w+)$/m, "$1 extra"),
          ),
      ],
      [
        "its MANIFEST's header lines reordered",
        2,
        (dir) =>
          writeFileSync(
            join(dir, "MANIFEST"),
            readFileSync(join(dir, "MANIFEST"), "utf8").replace(
              /^(src \w+)\n(oracles \w+)$/m,
              "$2\n$1",
            ),
          ),
      ],
      ["a complete shard of another src/ tree", 2, (dir) => cpSync(strange(another), shard(dir))],
      [
        "a complete shard of another src/ tree and oracle library",
        2,
        (dir) => cpSync(strange(anotherOracles), shard(dir)),
      ],
      ["a foreign file", 2, (dir) => writeFileSync(join(dir, "area", "z.runs.jsonl"), "{}\n")],
    ];
    for (const [witness, expected, damage] of witnesses) {
      const copy = join(directory, "copies", witness.replaceAll(" ", "-"));
      cpSync(join(root, SRC), join(copy, SRC), { recursive: true });
      damage(join(copy, SRC));
      const status = state(base, copy).status;
      const compared = spawnSync(
        process.execPath,
        [runner, area, head, "--baseline", join(copy, SRC, "area")],
        { encoding: "utf8" },
      );
      assert.deepEqual([witness, status, compared.status], [witness, expected, expected]);
      assert.doesNotMatch(compared.stdout, /"differences"/, witness);
    }
    assert.equal(state(base).status, 0);
    // (and the next writer of the area replaces a PLAN that is not the recorded one, as it replaces a shard)
    writeFileSync(join(baseline, "PLAN"), "plan 1\n");
    assert.equal(state(base).status, 1);
    assert.match(into(alias, "0/2").stdout, /"skipped":"stored"/);
    assert.equal(state(base).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

type Site = {
  site: string;
  function: string;
  call?: string;
  code?: string;
  write?: string;
  kind?: string;
  allowed?: string;
};
type Inventory = {
  modules: string[];
  sites: Site[];
  escapes: Site[];
  processes: Site[];
  loads: Site[];
};

/** Every write of the stored baselines' tools in `checkout`, computed from their modules (`tests/families/writes.mjs`). */
const inventoryOf = async (checkout: string): Promise<Inventory> =>
  (await import(pathToFileURL(resolve(process.cwd(), "tests/families/writes.mjs")).href)).inventory(
    checkout,
  );

test("the stored baselines' tools show no plain write outside the gate in their source, an advisory check computed from their modules (#1542)", async () => {
  const { modules, sites, escapes, processes, loads } = await inventoryOf(process.cwd());
  assert.deepEqual(modules, [
    "tests/families/baselines.mjs",
    "tests/families/run.mjs",
    "tests/families/sources.mjs",
  ]);
  // (advisory: the sandbox each store runs in enforces where it writes; this catches the plain forms of a write outside
  // the gate) each write is in the gate, makes a baseline's MANIFEST, or is of a path checked to lie outside every
  // baseline, and fs is used only by calls
  assert.deepEqual(
    sites.filter(({ kind }) => kind === "unproven"),
    [],
  );
  assert.deepEqual(escapes, []);
  assert.deepEqual(
    [...new Set(sites.filter(({ kind }) => kind === "creation").map((site) => site.function))],
    ["owned"],
  );
  // the child processes, each of a form the inventory proves creates and changes no path (any other is an unproven
  // site); the modules loaded by a computed name are a tree's oracle library and work ledger and an area's generators,
  // which are no tool's
  assert.deepEqual(
    processes.map((process) => process.allowed),
    ["the gate's lock holder", "the runner's own child"],
  );
  assert.deepEqual(
    loads.map((load) => load.function),
    ["oracles", "ledgerOf", "generatorsOf"],
  );
  // the hook writes nothing: no file command, no redirection (after a space, as the script writes them) but to /dev/null
  // or stderr, once its comments and then its single-quoted programs are set aside
  const hook = readFileSync(join("tools", "corpus", "baseline.sh"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/'[^']*'/g, "''");
  assert.deepEqual(
    [
      ...hook.matchAll(
        /(?:^|[;&|({]\s*|\b(?:then|do|else)\s+)(mkdir|mv|cp|rm|rmdir|ln|touch|truncate|install)\s/gm,
      ),
    ].map(([command]) => command),
    [],
  );
  assert.deepEqual(
    [...hook.matchAll(/(?:^|\s)\d*>>?\s*([^\s;&|)]+)/gm)]
      .map(([, target]) => target)
      .filter((target) => !["/dev/null", "/dev/stderr", "&1", "&2"].includes(target!)),
    [],
  );
  assert.deepEqual(
    [...hook.matchAll(/\btee\s+(\S+)/g)]
      .map(([, target]) => target)
      .filter((target) => target !== "/dev/stderr"),
    [],
  );

  // over a copy of the tools: a write added to an imported helper (#1542 r4: imported-helper-write) and writes
  // through each kind of binding are found, unproven, as are one that climbs out of a folder beside the baselines and
  // child processes of no allowed form (`flock` on a path, which creates it where it is absent); an fs binding passed
  // on, exported or destructured otherwise, a module loader and code from text are escapes
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    for (const file of [
      "tools/corpus/baseline.sh",
      "tests/families/baselines.mjs",
      "tests/families/run.mjs",
      "tests/families/sources.mjs",
    ]) {
      mkdirSync(join(directory, file, ".."), { recursive: true });
      writeFileSync(join(directory, file), readFileSync(file, "utf8"));
    }
    const append = (file: string, text: string) =>
      writeFileSync(join(directory, file), readFileSync(join(directory, file), "utf8") + text);
    append(
      "tests/families/sources.mjs",
      `import * as everything from "node:fs";
import fs, { writeFileSync as written, promises } from "node:fs";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { execSync, spawn } from "node:child_process";
import { outside, pathOf } from "./baselines.mjs";
const { appendFileSync } = everything;
const renamed = promisify(fs.rename);
const truncated = fs.truncateSync;
export async function scribble(file, flag) {
  if (flag) written(file, "");
  everything.rmSync(file);
  fs["linkSync"](file, file);
  appendFileSync(file, "");
  await promises.mkdir(file);
  await unlink(file);
  await renamed(file, file);
  truncated(file);
  const { cpSync } = await import("node:fs");
  cpSync(file, file);
  fs.openSync(file, "w");
  fs.readFileSync(file, { flag: "w" });
  fs.readFileSync(file);
  return [fs];
}
export { written };
export function climb(root) {
  const away = pathOf(outside(root, [], () => {}), "outside");
  everything.rmSync(path.join(away, "..", "y"));
  everything.rmSync(path.join(pathOf(root, "baseline"), "z"));
  process.getBuiltinModule("node:fs").rmdirSync(root);
  const { promises: { rm } } = fs;
  eval("0");
  spawn("flock", [root, "-c", "true"]);
  spawn("bash", ["-c", 'touch "$0"', root], { stdio: "ignore" });
  execSync("touch notes");
  return [rm, Worker];
}
export function owned(root) {
  everything.rmSync(path.join(pathOf(root, "baseline"), ".."));
}
const { "writeFileSync": quoted } = everything;
const options = { flag: "w" };
const load = process.getBuiltinModule;
export function r5(file = "notes") {
  quoted(file, "");
  fs.readFileSync(file, options);
  load("node:child_process").spawnSync("touch", [file]);
  written(file, "");
}
`,
    );
    append(
      "tests/families/run.mjs",
      `import nodeFs from "node:fs";
if (process.env.NEVER) nodeFs.writeFileSync(process.env.NEVER, "");
`,
    );
    // (and a write in the gate before it holds the lock)
    const state = join(directory, "tests/families/baselines.mjs");
    writeFileSync(
      state,
      readFileSync(state, "utf8").replace(
        '  const dir = pathOf(baseline, "baseline");\n',
        '  const dir = pathOf(baseline, "baseline");\n  rmSync(path.join(dir, "early"), { force: true });\n',
      ),
    );
    const copied = await inventoryOf(directory);
    assert.deepEqual(
      copied.sites
        .filter(({ kind }) => kind === "unproven")
        .map(({ site, write }) => `${site.split(":")[0]} ${write}`),
      [
        "tests/families/baselines.mjs rmSync",
        "tests/families/run.mjs writeFileSync",
        ...[
          "import node:worker_threads",
          "writeFileSync",
          "rmSync",
          "linkSync",
          "appendFileSync",
          "mkdir",
          "unlink",
          "rename",
          "truncateSync",
          "cpSync",
          "openSync",
          "readFileSync",
          "rmSync",
          "rmSync",
          "rmdirSync",
          "eval",
          "spawn",
          "spawn",
          "execSync",
          // (a creation that climbs out of its baseline)
          "rmSync",
          // (#1542 r5: an aliased loader, options in a variable, a default parameter)
          "process.getBuiltinModule",
          "readFileSync",
          "writeFileSync",
        ].map((write) => `tests/families/sources.mjs ${write}`),
      ],
    );
    assert.deepEqual(
      copied.escapes.map(({ code }) => code),
      // (#1542 r5: a quoted key)
      ["fs", "written", "{ promises: { rm } } = fs", '{ "writeFileSync": quoted } = everything'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A preload that stops the process right after its first write (`<function> <path> <data or second path>`) on a path
 * under CRASH_ROOT that CRASH_AT matches, telling CRASH_READY, so that the test kills it there (#1542).
 */
const CRASH = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const at = new RegExp(process.env.CRASH_AT);
const tell = fs.writeFileSync;
let stopped = false;
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "linkSync", "rmSync", "rmdirSync", "copyFileSync"]) {
  const original = fs[name];
  fs[name] = function (...args) {
    const result = original.apply(this, args);
    const done = name + " " + args.slice(0, 2).map(String).join(" ");
    if (!stopped && args.slice(0, 2).some((arg) => String(arg).startsWith(process.env.CRASH_ROOT)) && at.test(done)) {
      stopped = true;
      tell(process.env.CRASH_READY, done);
      for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    return result;
  };
}
syncBuiltinESMExports();
`;

test("the stored baselines finish or clear what a writer killed at a write left, one write per entry point (#1542)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = (name: string, sha: string, src = "a\n") => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(folder, "src"));
      mkdirSync(join(folder, "tests", "families", "area"), { recursive: true });
      writeFileSync(join(folder, "src", "a.ts"), src);
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "package-lock.json"), "{}\n");
      writeFileSync(
        join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
        storable(false),
      );
      writeFileSync(join(folder, ".sha"), `${sha.repeat(40)}\n`);
      writeFileSync(
        join(folder, "tests", "families", "area", "stored.mjs"),
        'export const cases = [["same", "same"], ["changed", "changed"]];\n',
      );
      return folder;
    };
    const base = tree("base", "1");
    const alias = tree("alias", "2");
    const crash = join(directory, "crash.mjs");
    writeFileSync(crash, CRASH);
    let count = 0;
    const killedAt = async (at: string, ...args: string[]) => {
      const ready = join(directory, `ready-${(count += 1)}`);
      const env = { ...process.env, CRASH_ROOT: directory, CRASH_AT: at, CRASH_READY: ready };
      const child = spawn(process.execPath, ["--import", crash, ...args], { env, stdio: "ignore" });
      const closed = new Promise((done) => child.on("close", done));
      while (!existsSync(ready) && child.exitCode === null)
        await new Promise((done) => setTimeout(done, 5));
      assert.ok(existsSync(ready), `${args.join(" ")} ended before a write ${at}`);
      child.kill("SIGKILL");
      await closed;
    };
    const run = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
    const last = (result: { stdout: string }) =>
      JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const store = (from: string, root: string, shard: string) =>
      run(runner, join(from, "tests", "families", "area"), from, "--store", root, "--shard", shard);

    // a store killed right after it made its area's folder (#1542 r3: interrupted-area-creation; the area is recorded
    // before), then one killed before it published its shard: the next writer finishes the area and publishes, the dead
    // writer's temporary file cleared
    const first = join(directory, "first");
    await killedAt(
      "^mkdirSync .*/area ",
      runner,
      join(base, "tests", "families", "area"),
      base,
      "--store",
      first,
      "--shard",
      "0/2",
    );
    assert.equal(last(store(alias, first, "0/2")).verified, true);
    await killedAt(
      "^writeFileSync .*runs\\.jsonl\\.\\d+-\\d+\\.tmp ",
      runner,
      join(base, "tests", "families", "area"),
      base,
      "--store",
      first,
      "--shard",
      "1/2",
    );
    assert.equal(last(store(alias, first, "1/2")).verified, true);
    const stored = run(baselines, "state", base, first, "--read-only");
    assert.equal(stored.status, 0, stored.stdout);
    const made = last(stored).baseline;
    assert.deepEqual(readdirSync(join(made, "area")).sort(), [
      "0of2.runs.jsonl",
      "1of2.runs.jsonl",
      "PLAN",
    ]);

    // a join killed right after it wrote its MANIFEST's temporary file into the new baseline's folder: the next one makes
    // the baseline, and its gate clears the leftover
    const second = join(directory, "second");
    await killedAt(
      "^writeFileSync .*/MANIFEST\\.\\d+-\\d+\\.tmp ",
      baselines,
      "state",
      base,
      second,
    );
    assert.equal(run(baselines, "state", base, second).status, 1);
    // `start` killed before its marker's rename, `queue` before its copy's: the next call decides and copies
    const top = last(run(baselines, "state", base, second, "--read-only")).baseline;
    await killedAt(
      "^writeFileSync .*STARTED\\.\\d+-\\d+\\.tmp ",
      baselines,
      "start",
      top,
      top.split("/").at(-1)!,
    );
    assert.equal(last(run(baselines, "start", top, top.split("/").at(-1)!)).decision, "started");
    const hook = resolve(process.cwd(), "tools", "corpus", "baseline.sh");
    await killedAt("^copyFileSync ", baselines, "queue", top, hook);
    assert.equal(last(run(baselines, "queue", top, hook)).queued, top);
    assert.deepEqual(readdirSync(top).sort(), ["MANIFEST", "STARTED", "baseline.sh"]);
    // (#1590, reversing #1567) a fill that STARTED and stored a shard runs to its end once another src/ tree is current:
    // its jobs decide `started` and write nothing, its stored shard read as before, STARTED keeping the time it began;
    // a fill none of whose jobs started is SUPERSEDED (#1513), which `queue` undoes when its tree is current again
    assert.equal(store(alias, second, "0/2").status, 0);
    const began = readFileSync(join(top, "STARTED"), "utf8");
    const newer = "f".repeat(40);
    assert.deepEqual(last(run(baselines, "start", top, newer)), { decision: "started" });
    assert.deepEqual(readdirSync(top).sort(), ["MANIFEST", "STARTED", "area", "baseline.sh"]);
    assert.equal(readFileSync(join(top, "STARTED"), "utf8"), began);
    const started = run(baselines, "state", base, second, "--read-only");
    assert.equal(started.status, 1, started.stdout);
    const partial = JSON.parse(started.stdout.split("\n")[0]!);
    assert.deepEqual([partial.state, partial.verified, partial.store], ["partial", 1, [1]]);
    assert.deepEqual(last(run(baselines, "start", made, newer)), {
      decision: "superseded",
      by: newer,
    });
    assert.equal(readFileSync(join(made, "SUPERSEDED"), "utf8"), `${newer}\n`);
    assert.equal(run(baselines, "state", base, first, "--read-only").status, 0);
    assert.equal(last(run(baselines, "queue", made, hook)).queued, made);
    assert.deepEqual(readdirSync(made).sort(), ["MANIFEST", "area", "baseline.sh"]);
    // (#1542 r3: queued-job-foreign-contents) a job's decision in a baseline that holds a foreign path is refused,
    // nothing written
    writeFileSync(join(top, "foreign-late"), "x\n");
    const before = readdirSync(top).sort();
    assert.equal(run(baselines, "start", top, top.split("/").at(-1)!).status, 2);
    assert.deepEqual(readdirSync(top).sort(), before);

    // (#1542 r4: padded-temporary) names this tool never renders, a shard's or a temporary file's with a padded number,
    // are foreign as any other file is: status refuses the baseline naming each, each file untouched
    const fourth = join(directory, "fourth");
    const kept = tree("kept", "4", "kept\n");
    const keeper = tree("keeper", "5", "kept\n");
    assert.equal(store(kept, fourth, "0/1").status, 0);
    rmSync(kept, { recursive: true });
    const held = last(run(baselines, "state", keeper, fourth, "--read-only")).baseline;
    for (const name of [
      "00of1.runs.jsonl.999999999-1.tmp",
      "0of1.runs.jsonl.0999999999-1.tmp",
      "00of1.runs.jsonl",
      "notes.txt",
    ]) {
      writeFileSync(join(held, "area", name), "another agent's\n");
      const status = run(baselines, "state", keeper, fourth, "--read-only");
      assert.equal(status.status, 2);
      assert.ok(
        status.stdout.includes(`foreign contents, which this tool did not write: area/${name}`),
      );
      assert.equal(readFileSync(join(held, "area", name), "utf8"), "another agent's\n");
      rmSync(join(held, "area", name));
    }
    // (#1542 r4: out-in-baseline) the runner's `--out` in a baseline (also through a link) or beside the baselines,
    // and a folder of baselines in a baseline, are refused before anything is opened
    const notes = join(held, "private-notes.txt");
    writeFileSync(notes, "another agent's\n");
    const link = join(directory, "notes-link");
    symlinkSync(notes, link);
    // (a `..` after a link climbs from the link's target, as the system resolves it)
    symlinkSync(join(held, "area"), join(directory, "area-link"));
    const climbing = `${join(directory, "area-link")}/../private-notes.txt`;
    const outTo = (file: string) =>
      run(
        runner,
        join(keeper, "tests", "families", "area"),
        keeper,
        "--store",
        fourth,
        "--out",
        file,
      );
    for (const file of [notes, link, climbing]) {
      const inBaseline = outTo(file);
      assert.equal(inBaseline.status, 2);
      assert.match(inBaseline.stderr, /(private-notes\.txt|notes-link) lies in the baseline /);
    }
    assert.equal(readFileSync(notes, "utf8"), "another agent's\n");
    const nested = store(keeper, join(held, "nested"), "0/1");
    assert.equal(nested.status, 2);
    assert.match(nested.stderr, /nested lies in the baseline /);
    const inRoot = outTo(join(fourth, "differences.jsonl"));
    assert.equal(inRoot.status, 2);
    assert.match(inRoot.stderr, /differences\.jsonl lies in the baselines folder /);
    // (#1542 r5) `--out`, a hard link to a file in a baseline, is a new file, never that file truncated
    const hard = join(directory, "notes-hard.jsonl");
    linkSync(notes, hard);
    assert.equal(outTo(hard).status, 2);
    assert.equal(readFileSync(notes, "utf8"), "another agent's\n");
    rmSync(notes);
    const plan = join(held, "area", "PLAN");
    const planned = readFileSync(plan, "utf8");
    linkSync(plan, join(directory, "plan-hard.jsonl"));
    assert.equal(outTo(join(directory, "plan-hard.jsonl")).status, 0);
    assert.equal(readFileSync(plan, "utf8"), planned);
    // (#1542 r5) `--baseline` through a link is resolved before its folder of baselines is derived
    symlinkSync(join(held, "area"), join(directory, "area-alias"));
    const aliased = run(
      runner,
      join(keeper, "tests", "families", "area"),
      keeper,
      "--baseline",
      join(directory, "area-alias"),
      "--out",
      join(fourth, "notes.jsonl"),
    );
    assert.equal(aliased.status, 2);
    assert.match(aliased.stderr, /notes\.jsonl lies in the baselines folder /);
    assert.equal(existsSync(join(fourth, "notes.jsonl")), false);
    // (#1542 r5) a folder of baselines spelled through a link and `..` is written where the system resolves it, never
    // where its spelling collapses to: here into the baseline's own area
    mkdirSync(join(directory, "elsewhere", "child"), { recursive: true });
    symlinkSync(join(directory, "elsewhere", "child"), join(held, "escape"));
    const spelled = `${join(held, "escape")}/../area`;
    assert.equal(store(keeper, spelled, "0/1").status, 0);
    assert.equal(run(baselines, "state", keeper, `${join(held, "escape")}/../folder`).status, 1);
    assert.deepEqual(readdirSync(join(held, "area")).sort(), ["0of1.runs.jsonl", "PLAN"]);
    assert.equal(existsSync(join(held, "folder")), false);
    assert.deepEqual(readdirSync(join(directory, "elsewhere")).sort(), ["area", "child", "folder"]);
    rmSync(join(held, "escape"));
    // (and a writer given a path this tool did not check refuses it before any filesystem call)
    const state = await import(pathToFileURL(baselines).href);
    const fail = (why: string) => {
      throw new Error(why);
    };
    const raw = join(directory, "raw");
    for (const write of [
      () => state.owned(raw, { src: "1".repeat(40) }, "commit x y"),
      () => state.planned(raw, "area", "plan 1\n"),
      () => state.beginShard(raw, "area", 0, 1, "", ""),
      // (and a checked path of another kind: a folder of baselines given as a baseline)
      () => state.planned(state.outside(join(directory, "kinds"), [], fail), "area", "plan 1\n"),
    ])
      await assert.rejects(async () => write(), /is no \w+ path this tool checked/);
    assert.equal(existsSync(raw), false);
    assert.equal(existsSync(join(directory, "kinds")), false);
    // a shard's paths come from the claim the gate gave, never from the caller, and a claim publishes once; a baseline
    // path stands for the folder it was issued for: another one found at its path later is refused
    await assert.rejects(
      async () => state.endShard({ baseline: raw, file: notes }, [], {}),
      /is no claim this tool gave/,
    );
    const joined = await state.owned(
      state.outside(fourth, [], fail),
      state.identityOf(keeper),
      null,
    );
    const planText = readFileSync(join(held, "area", "PLAN"), "utf8");
    const plannedAgain = await state.planned(joined.baseline, "area", planText);
    rmSync(join(held, "area", "0of1.runs.jsonl"));
    const begun = await state.beginShard(
      joined.baseline,
      "area",
      0,
      1,
      plannedAgain.plan,
      plannedAgain.places[0],
    );
    assert.notEqual(begun.claim, undefined);
    await state.endShard(begun.claim, [], {});
    await assert.rejects(
      async () => state.endShard(begun.claim, [], {}),
      /is no claim this tool gave/,
    );
    renameSync(held, `${held}-moved`);
    cpSync(`${held}-moved`, held, { recursive: true });
    assert.match((await state.planned(joined.baseline, "area", planText)).refused, /was replaced/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library where `ends` ends the process on every run, a stall of its own, and `flaky` ends it on the runs
 * FLAKY's characters say (`x`, one each, counted in TMPDIR, which a fill's stores share), a stall of the machine's load.
 */
const FILLABLE = `import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publicationHashes(files) {
  const source = files[0].source;
  if (source === "ends") process.exit(3);
  if (source === "flaky" && process.env.FLAKY !== undefined) {
    const count = join(process.env.TMPDIR, "flaky");
    const left = existsSync(count) ? readFileSync(count, "utf8") : process.env.FLAKY;
    writeFileSync(count, left.slice(1));
    if (left[0] === "x") process.exit(4);
  }
  return { parts: [createHash("sha256").update(source).digest("hex")], unanswered: 0 };
}
`;

test("a fill on any worker: a seed, its shards computed and imported into a central store, which refuses or compares what differs, and its status without a tree (#1590)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    // built trees with the tools: `alias` the same build at another path and commit, `rebuilt` another build of the
    // compiler (its dist/src/) from the same src/
    const tree = (name: string, sha: string, compiled = "compiled\n") => {
      const folder = join(directory, name);
      for (const part of ["dist/src", "dist/tests/helpers", "src", "tests/families/area"])
        mkdirSync(join(folder, part), { recursive: true });
      writeFileSync(join(folder, "src", "a.ts"), "a\n");
      writeFileSync(join(folder, "dist", "src", "a.js"), compiled);
      writeFileSync(join(folder, "dist", "tests", "helpers", "type-core-oracles.js"), FILLABLE);
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "package-lock.json"), "{}\n");
      writeFileSync(join(folder, ".sha"), `${sha.repeat(40)}\n`);
      for (const tool of ["baselines.mjs", "run.mjs", "sources.mjs"])
        cpSync(join("tests", "families", tool), join(folder, "tests", "families", tool));
      writeFileSync(
        join(folder, "tests", "families", "area", "stored.mjs"),
        'export const cases = [["same", "same"], ["ends", "ends"], ["flaky", "flaky"]];\n',
      );
      return folder;
    };
    const built = tree("built", "1");
    const alias = tree("alias", "2");
    const rebuilt = tree("rebuilt", "1", "compiled otherwise\n");
    const sha = "1".repeat(40);
    const { identityOf, comparedOf } = await import(pathToFileURL(baselines).href);
    const src: string = identityOf(built).src;
    const script = resolve("tools", "corpus", "baseline.sh");
    const scratch = join(directory, "scratch");
    mkdirSync(scratch);
    const env = { ...process.env, TMPDIR: scratch, SX_SCRATCH: "" };
    const sh = (more: Record<string, string>, ...args: string[]) =>
      spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...env, ...more } });
    const tool = (...args: string[]) =>
      spawnSync(process.execPath, [baselines, ...args], { encoding: "utf8" });
    const said = (result: { stdout: string }) =>
      JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const at = (...parts: string[]) => join(directory, ...parts);
    const shard = (root: string, index: number) => at(root, src, "area", `${index}of16.runs.jsonl`);
    const listed = (root: string) =>
      JSON.parse(readFileSync(at(root, "stalls.json"), "utf8")).stalls;

    // the seed: a baseline with what its runs depend on, the commit, the build and the area's PLAN, no shard, and the
    // shards to store as the hook queues them; the fill's jobs as #1590 submits them (each command inside `bash -c`,
    // which sx-job runs without a shell)
    assert.equal(sh({}, "seed", built, sha, at("seed")).status, 0);
    const manifest = readFileSync(at("seed", src, "MANIFEST"), "utf8").split("\n");
    assert.equal(manifest[5], `commit ${sha} ${built}`);
    assert.match(manifest[6]!, /^area area 16 [0-9a-f]{64}$/);
    assert.deepEqual(manifest.slice(7), [`compiled ${comparedOf(built).compiled}`, ""]);
    assert.deepEqual(readdirSync(at("seed", src, "area")), ["PLAN"]);
    const shards = [...Array(16).keys()].map((index) => `area\t${index}\t16\n`).join("");
    assert.equal(readFileSync(at("seed", "shards.tsv"), "utf8"), shards);
    const fill = `fill-${src.slice(0, 9)}`;
    assert.equal(
      sh({}, "submit", sha, src, "--dry").stdout,
      `sx-job submit --owner baseline --name ${fill}-seed --priority background --commit ${sha} -- bash -c 'bash "$SX_TREE/tools/corpus/baseline.sh" seed "$SX_TREE" ${sha} "$SX_OUT"'\n`,
    );
    const lines = sh({}, "submit", sha, src, "11020125", at("seed", "shards.tsv"), "--dry").stdout;
    assert.deepEqual(lines.split("\n").slice(1, 2), [
      `sx-job submit --owner baseline --name ${fill}-area-1 --priority background --campaign ${fill} --commit ${sha} --in-result seed=11020125 -- bash -c 'bash "$SX_TREE/tools/corpus/baseline.sh" compute "$SX_TREE" "$SX_IN/seed/out/${src}" area 1/16 "$SX_OUT"'`,
    ]);
    assert.equal(lines.split("\n").length, 17);

    // shards computed from the seed: a stall of its own (`ends`, on every run alone too) stays, listed with its run
    // alone in stalls.json; a stall under the machine's load (`flaky`, which ends alone) makes the shard be stored once
    // more, and fails where the source stalls again
    const compute = (out: string, index: number, more = {}, from = built) =>
      sh(more, "compute", from, at("seed", src), "area", `${index}/16`, at(out));
    for (const [out, index, flaky] of [
      ["zero", 0, ""],
      ["one", 1, ""],
      ["two", 2, "x...."],
    ] as const) {
      const computed = compute(out, index, { FLAKY: flaky });
      assert.equal(computed.status, 0, computed.stderr);
    }
    assert.deepEqual(listed("zero"), []);
    assert.deepEqual(
      listed("one").map(
        (entry: { source: string; stalled: string; alone: { stalled: string } }) => [
          entry.source,
          entry.stalled,
          entry.alone.stalled,
        ],
      ),
      [["ends", "exit 3", "exit 3"]],
    );
    assert.deepEqual(listed("two"), []);
    assert.equal(
      JSON.parse(readFileSync(shard("two", 2), "utf8").split("\n")[0]!).stalled,
      undefined,
    );
    const twice = compute("twice", 2, { FLAKY: "x....x" });
    assert.equal(twice.status, 1);
    assert.match(twice.stderr, /"source":"flaky".*"alone":"ended"/);
    assert.equal(existsSync(at("twice", src)), false);

    // the central store: the seed adopted, then equal; status reads the tree's own folder without a tree, another
    // tree's absent
    const central = at("central");
    assert.deepEqual(said(tool("import", central, at("seed"))).seed, "adopted");
    assert.deepEqual(said(tool("import", central, at("seed"))).seed, "equal");
    const status = (of = src) => tool("status", central, of);
    assert.deepEqual(
      [status().status, status().stdout],
      [1, `baseline ${src}: ${join(central, src)}: incomplete: area partial 0/16\n`],
    );
    const other = "e".repeat(40);
    assert.deepEqual(
      [status(other).status, status(other).stdout],
      [1, `baseline ${other}: ${join(central, other)}: absent\n`],
    );
    // each shard imported, the empty ones from one copy of the seed; then complete
    const imported = (root: string, index: number) =>
      tool("import", central, at(root), "area", `${index}/16`);
    for (const [root, index] of [
      ["zero", 0],
      ["one", 1],
      ["two", 2],
    ] as const)
      assert.equal(said(imported(root, index)).verified, true);
    assert.equal(tool("import", at("rest"), at("seed")).status, 0);
    for (let index = 3; index < 16; index += 1) {
      const run = spawnSync(process.execPath, [
        runner,
        join(built, "tests", "families", "area"),
        built,
        "--store",
        at("rest"),
        "--shard",
        `${index}/16`,
      ]);
      assert.equal(run.status, 0);
      assert.equal(imported("rest", index).status, 0);
    }
    assert.deepEqual(
      [status().status, status().stdout],
      [0, `baseline ${src}: ${join(central, src)}: complete: area\n`],
    );

    // refused (exit 2) and nothing written: another build of the compiler (computed from `rebuilt`), another MANIFEST
    // line (a commit and tree), another PLAN, another Node, a stall stalls.json does not show alone, no baseline
    const contents = () =>
      readdirSync(join(central, src, "area"))
        .sort()
        .map((name) => [name, readFileSync(join(central, src, "area", name), "utf8")]);
    const before = contents();
    const recomputed = compute("rebuilt", 0, {}, rebuilt);
    assert.equal(recomputed.status, 0, recomputed.stderr);
    const copied = (from: string, name: string, change: (dir: string) => void) => {
      cpSync(at(from), at(name), { recursive: true });
      change(at(name, src));
      return name;
    };
    const edit = (file: string, from: RegExp | string, to: string) =>
      writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
    const plan = (dir: string) => {
      const text = `${readFileSync(join(dir, "area", "PLAN"), "utf8")}checks other.mjs publication\n`;
      writeFileSync(join(dir, "area", "PLAN"), text);
      edit(
        join(dir, "MANIFEST"),
        /^area area 16 \w+$/m,
        `area area 16 ${createHash("sha256").update(text).digest("hex")}`,
      );
    };
    for (const [root, index, refusal] of [
      ["rebuilt", 0, /names "compiled \w+" \(a build of the compiler, dist\/src\/\)/],
      [
        copied("zero", "commit", (dir) =>
          edit(join(dir, "MANIFEST"), /$/, `commit ${"2".repeat(40)} ${alias}\n`),
        ),
        0,
        /names "commit 2{40} .*alias" \(a commit and tree/,
      ],
      [copied("zero", "plan", plan), 0, /names "area area 16 \w+" \(an area's PLAN\)/],
      [
        copied("zero", "node", (dir) => edit(join(dir, "MANIFEST"), /^node v.*$/m, "node v0.0.0")),
        0,
        /names "node v0\.0\.0" \(what its runs depend on\)/,
      ],
      [
        copied("one", "unlisted", () => rmSync(at("unlisted", "stalls.json"))),
        1,
        /stored\.mjs ends stalled \(exit 3\), and stalls\.json does not show it stalling alone/,
      ],
      [
        copied("zero", "damaged", (dir) =>
          edit(join(dir, "area", "0of16.runs.jsonl"), /\{"total".*\n$/, ""),
        ),
        0,
        /0of16\.runs\.jsonl is no shard that counts/,
      ],
      [
        copied("one", "alone", () =>
          edit(at("alone", "stalls.json"), /"alone":\{.*\}\}\]\}/, '"alone":{}}]}'),
        ),
        1,
        /stored\.mjs ends stalled \(exit 3\), and stalls\.json does not show it stalling alone/,
      ],
      [
        copied("one", "twice-listed", () =>
          edit(at("twice-listed", "stalls.json"), /\[(.*)\]/, "[$1,$1]"),
        ),
        1,
        /stalls\.json lists 2 stalled sources of .*, which has 1/,
      ],
      [
        copied("one", "forged", (dir) =>
          edit(join(dir, "area", "1of16.runs.jsonl"), '"stalled":1,', '"stalled":0,'),
        ),
        1,
        /total counts 0 stalled sources, its lines 1/,
      ],
      ["empty", 0, /holds no baseline of this tool/],
    ] as const) {
      const refused = imported(root, index);
      assert.deepEqual([root, refused.status], [root, 2]);
      assert.match(said(refused).refused, refusal);
    }
    // (and a seed that names no build of the compiler, and a central baseline whose PLAN its seed's adoption did not
    // make yet)
    copied("seed", "unnamed", (dir) => edit(join(dir, "MANIFEST"), /^compiled \w+\n/m, ""));
    assert.match(
      said(tool("import", at("unnamed-central"), at("unnamed"))).refused,
      /names no build of the compiler/,
    );
    // (its areas known only with its tree, such a baseline is never complete without one)
    const unseeded = tool("status", at("unnamed"), src);
    assert.equal(unseeded.status, 1);
    assert.match(unseeded.stdout, /incomplete: no seed recorded its areas/);
    cpSync(central, at("unplanned"), { recursive: true });
    rmSync(at("unplanned", src, "area", "PLAN"));
    assert.match(
      said(tool("import", at("unplanned"), at("zero"), "area", "0/16")).refused,
      /holds no PLAN or another one: import its seed first/,
    );
    // an import killed after it wrote its shard's temporary file: the next one clears it and publishes
    assert.equal(tool("import", at("crashed"), at("seed")).status, 0);
    const crash = at("crash.mjs");
    writeFileSync(crash, CRASH);
    const ready = at("ready");
    const killed = spawn(
      process.execPath,
      ["--import", crash, baselines, "import", at("crashed"), at("zero"), "area", "0/16"],
      {
        env: {
          ...process.env,
          CRASH_ROOT: at("crashed"),
          CRASH_AT: "^writeFileSync .*runs\\.jsonl\\.\\d+-\\d+\\.tmp ",
          CRASH_READY: ready,
        },
        stdio: "ignore",
      },
    );
    const closed = new Promise((done) => killed.on("close", done));
    while (!existsSync(ready) && killed.exitCode === null)
      await new Promise((done) => setTimeout(done, 5));
    assert.ok(existsSync(ready), "the import ended before its temporary file");
    killed.kill("SIGKILL");
    await closed;
    assert.equal(readdirSync(at("crashed", src, "area")).length, 2);
    assert.equal(said(tool("import", at("crashed"), at("zero"), "area", "0/16")).verified, true);
    assert.deepEqual(readdirSync(at("crashed", src, "area")).sort(), ["0of16.runs.jsonl", "PLAN"]);
    // compared, never replaced: a shard imported again says the same (exit 0), one that says otherwise differs (exit 3)
    assert.deepEqual(Object.keys(said(imported("zero", 0))), ["equal"]);
    const differs = copied("zero", "differs", (dir) => {
      const file = join(dir, "area", "0of16.runs.jsonl");
      const [line, total] = readFileSync(file, "utf8").trim().split("\n");
      const changed = `${line!.replace(/"hash":"\w/, '"hash":"_')}\n`;
      const ended = JSON.parse(total!);
      ended.total.lines = createHash("sha256").update(changed).digest("hex");
      writeFileSync(file, `${changed}${JSON.stringify(ended)}\n`);
    });
    const compared = imported(differs, 0);
    assert.equal(compared.status, 3);
    assert.match(said(compared).differs, /says otherwise than .* of stored\.mjs same/);
    // a seed into the complete baseline: equal, nothing written; one from another commit's tree differs (exit 3)
    assert.equal(sh({}, "seed", alias, "2".repeat(40), at("alias-seed")).status, 0);
    const reseeded = tool("import", central, at("alias-seed"));
    assert.equal(reseeded.status, 3);
    assert.match(said(reseeded).differs, /names "commit 2{40} .*alias"/);
    assert.equal(said(tool("import", central, at("seed"))).seed, "equal");
    assert.deepEqual(contents(), before);
    assert.deepEqual(readdirSync(central), [src]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A built tree's work ledger, which every unit of its analyses' work passes (`--work` counts its charges). */
const LEDGER = `export class WorkLedger {
  #total = 0;
  charge(counter, units = 1) {
    this.#total += units;
  }
}
`;

/**
 * A built tree's library whose analyses charge its ledger 3,000 units a run: `throws` throws on both trees, `ends` ends
 * the process there, as `twin` does where `FIXTURE_ENDS` is set; else the head's clock (its process's
 * `performance.now`) moves 3,000 ms on through each of `twin`'s runs in its first repeat or its second
 * (`FIXTURE_SKEW`), no time passing; `busy` waits 200 ms on the base; `lagging` waits 600 ms on the head's first run; `slow` charges a billion units more on the head and
 * waits 150 ms there; `burst` charges 10,000 times 65,536 units at once on the head, then waits; `changed` publishes its
 * second part otherwise on the head. Its stop sets differ on the head at demand allowance 1 and wait there at 2.
 */
const charging = (
  head: boolean,
): string => `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const clock = performance.now.bind(performance);
let skew = 0;
let twins = 0;
performance.now = () => clock() + skew;
export function publicationHashes(files, mode) {
  const source = files[0].source;
  const ledger = new WorkLedger();
  for (let unit = 0; unit < 1000; unit += 1) ledger.charge("frames", 3);
  if (source === "throws") throw new Error("independent exception witness");
  if (source === "ends" || (source === "twin" && process.env.FIXTURE_ENDS)) process.exit(3);
  if (${head} && source === "twin" && (twins++ < 4) === (process.env.FIXTURE_SKEW === "first"))
    skew += 3000;
  if (!${head} && source === "busy") wait(200);
  if (${head} && source === "lagging" && mode === MODES[0]) wait(600);
  if (${head} && source === "slow") {
    ledger.charge("frames", 1e9);
    wait(150);
  }
  if (${head} && source === "burst") {
    for (let unit = 0; unit < 10000; unit += 1) ledger.charge("frames", 65536);
    wait(10000);
  }
  return { parts: ["a", ${head} && source === "changed" ? "c" : "b"], unanswered: 0 };
}
export function stopSet(files, mode, globals, allowance) {
  if (${head} && allowance === 1) return { stops: [[1, "x", "y", 1]] };
  if (${head} && allowance === 2) wait(10000);
  return { stops: [] };
}
`;

test("the corpus runner records each source's work and time, a stalled run's to the stall, and a rerun of the stall index on both trees closes a timeout but never a stall, a candidate or a difference (#1564)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (isHead: boolean) => {
      const tree = join(directory, isHead ? "head" : "base");
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        charging(isHead),
      );
      return tree;
    };
    const [base, head] = [built(false), built(true)];
    const area = (name: string, names: string[], checks = ["publication"]) => {
      const folder = join(directory, name);
      mkdirSync(folder);
      const cases = JSON.stringify(names.map((source) => [source, source]));
      writeFileSync(
        join(folder, "g.mjs"),
        `export const cases = ${cases};\nexport const checks = ${JSON.stringify(checks)};\n`,
      );
      return folder;
    };
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const run = (tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    const MODES = ["src-on", "src-off", "rev-on", "rev-off"];

    // sources that end or throw: the runner's output and `--out`, exceptions' stacks included, as without the record
    const ending = area("ending", ["fast", "changed", "throws"]);
    const plain = run(runner, ending, base, head, "--out", join(directory, "plain.jsonl"));
    const recorded = run(
      runner,
      ending,
      base,
      head,
      "--out",
      join(directory, "recorded.jsonl"),
      "--work",
      join(directory, "ending.work.jsonl"),
    );
    assert.equal(recorded.status, 1, recorded.stderr);
    assert.equal(recorded.stdout, plain.stdout);
    const kept = readFileSync(join(directory, "recorded.jsonl"), "utf8");
    assert.equal(kept, readFileSync(join(directory, "plain.jsonl"), "utf8"));
    assert.match(kept, /independent exception witness\\n {4}at /);
    // one tree given twice: one ledger, whose units go to the tree running; no shard but 0/N to N-1/N
    const twice = join(directory, "twice.work.jsonl");
    run(runner, ending, base, base, "--work", twice);
    assert.deepEqual(
      lines(readFileSync(twice, "utf8"))[1].runs.map(
        ({ work: units }: { work: number[] }) => units,
      ),
      MODES.map(() => [3000, 3000]),
    );
    assert.match(run(runner, ending, base, head, "--shard", "2/2").stderr, /no shard i\/N/);
    // `--out`, `--work` and its progress record name three files, as the system resolves them, or nothing is touched
    // (#1564 r2: a progress record that is `--out` or a link to `--work`)
    const collided = join(directory, "collided.work.jsonl");
    writeFileSync(`${collided}.progress`, "kept\n");
    const colliding = run(
      runner,
      ending,
      base,
      head,
      "--work",
      collided,
      "--out",
      `${collided}.progress`,
    );
    assert.equal(colliding.status, 2, colliding.stderr);
    assert.deepEqual(
      [readFileSync(`${collided}.progress`, "utf8"), existsSync(collided)],
      ["kept\n", false],
    );
    const linked = join(directory, "linked.work.jsonl");
    writeFileSync(linked, "kept\n");
    symlinkSync(linked, `${linked}.progress`);
    assert.equal(run(runner, ending, base, head, "--work", linked).status, 2);
    assert.equal(readFileSync(linked, "utf8"), "kept\n");
    // one plan (#1564 r2's mismatched-plan witness): shard 0/2 of an area of four sources and shard 1/2 of a copy of
    // three, each area named `planned`, compare otherwise and are refused together, never closed
    const planned = (copy: string, names: string[]) => {
      mkdirSync(join(directory, copy));
      return area(join(copy, "planned"), names);
    };
    const [four, three] = [join(directory, "four.work.jsonl"), join(directory, "three.work.jsonl")];
    run(
      runner,
      planned("four", ["a", "b", "c", "bad"]),
      base,
      head,
      "--shard",
      "0/2",
      "--work",
      four,
    );
    run(runner, planned("three", ["a", "b", "c"]), base, head, "--shard", "1/2", "--work", three);
    const mixed = run(stalls, four, three);
    assert.equal(mixed.status, 2, mixed.stdout);
    assert.match(mixed.stderr, /compares otherwise than the area's other shards \(plan\)/);
    // a source the plan lists twice (#1582): its repeats, run and counted in two shards, are one source
    const repeated = area("repeated", ["dup", "fast", "lone", "dup"]);
    const [half, other] = [join(directory, "half.work.jsonl"), join(directory, "other.work.jsonl")];
    run(runner, repeated, base, head, "--shard", "0/2", "--work", half);
    run(runner, repeated, base, head, "--shard", "1/2", "--work", other);
    const once = run(stalls, half, other);
    assert.equal(once.status, 0, once.stderr);
    const { sources, repeats, agreed, closed } = lines(once.stdout).at(-1);
    assert.deepEqual([sources, repeats, agreed, closed], [3, 1, 3, true]);
    // a source the plan lists twice whose repeats end alike in a rerun, one of them in times the time clause judges a
    // candidate, first or second, as the head's clock says (#1583 r1): the candidate stands, so the replay stays open
    const clocked = area("clocked", ["twin", "twin"]);
    const withEnv = (env: Record<string, string>, tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    for (const skew of ["first", "second"]) {
      const clockedWork = join(directory, `clocked-${skew}.work.jsonl`);
      const clockedIndex = join(directory, `clocked-${skew}.json`);
      withEnv({ FIXTURE_ENDS: "1" }, runner, clocked, base, head, "--work", clockedWork);
      run(stalls, clockedWork, "--index", clockedIndex);
      const reran = join(directory, `clocked-${skew}`);
      withEnv({ FIXTURE_SKEW: skew }, stalls, "rerun", clockedIndex, base, head, reran);
      const ms = lines(readFileSync(join(reran, "clocked.work.jsonl"), "utf8"))
        .slice(1, -1)
        .map(({ runs: ran }) =>
          ran.reduce((sum: number, { ms: [, of] }: { ms: number[] }) => sum + (of ?? 0), 0),
        );
      assert.ok(
        skew === "first" ? ms[0] >= 12000 && ms[1] < 1000 : ms[1] >= 12000 && ms[0] < 1000,
        String(ms),
      );
      const merged = lines(
        run(stalls, clockedWork, "--rerun", join(reran, "clocked.work.jsonl")).stdout,
      );
      const [twin] = merged.filter(({ source }) => source === "twin");
      assert.deepEqual([twin.rerun.outcome, twin.rerun.verdict], ["agreed", "candidate"]);
      assert.deepEqual(
        [merged.at(-1).repeats, merged.at(-1).candidate, merged.at(-1).closed],
        [1, 1, false],
      );
    }
    // one library (#1564 r3's mixed-dist witness): two heads given as their `dist/`, one compiled `src/` and two oracle
    // libraries, compare otherwise and are refused together; one head's `dist/` in both shards closes
    const twin = join(directory, "twin");
    cpSync(head, twin, { recursive: true });
    writeFileSync(
      join(twin, "dist", "tests", "helpers", "type-core-oracles.js"),
      `${charging(true)}// another library\n`,
    );
    const pair = area("pair", ["a", "b"]);
    const own = join(directory, "own.work.jsonl");
    const twinned = join(directory, "twinned.work.jsonl");
    const both = join(directory, "both.work.jsonl");
    run(runner, pair, base, join(head, "dist"), "--shard", "0/2", "--work", own);
    run(runner, pair, base, join(twin, "dist"), "--shard", "1/2", "--work", twinned);
    run(runner, pair, base, join(head, "dist"), "--shard", "1/2", "--work", both);
    const libraries = run(stalls, own, twinned);
    assert.equal(libraries.status, 2, libraries.stdout);
    assert.match(libraries.stderr, /compares otherwise than the area's other shards \(trees\)/);
    assert.equal(run(stalls, own, both).status, 0);
    // one compiler (#1564 r4's witnesses): two checkouts of one TypeScript `src/` and oracle library whose compiled
    // compilers differ compare otherwise, as shards and as a replay and its rerun; the same checkout merges and reruns
    const checkout = (name: string, compiler: string) => {
      const copy = join(directory, name);
      cpSync(head, copy, { recursive: true });
      mkdirSync(join(copy, "src"));
      writeFileSync(join(copy, "src", "a.ts"), "a\n");
      writeFileSync(join(copy, "dist", "src", "type-inference", "core", "budget.js"), compiler);
      return copy;
    };
    const [one, another] = [checkout("one", LEDGER), checkout("another", `${LEDGER}// another\n`)];
    const compiled = area("compiled", ["a", "ends"]);
    const [first, second, same] = [0, 1, 2].map((index) =>
      join(directory, `compiled-${index}.work.jsonl`),
    );
    run(runner, compiled, base, one, "--shard", "0/2", "--work", first!);
    run(runner, compiled, base, another, "--shard", "1/2", "--work", second!);
    run(runner, compiled, base, one, "--shard", "1/2", "--work", same!);
    const compilers = run(stalls, first!, second!);
    assert.equal(compilers.status, 2, compilers.stdout);
    assert.match(compilers.stderr, /compares otherwise than the area's other shards \(trees\)/);
    assert.equal(run(stalls, first!, same!).status, 1);
    const ended = join(directory, "ended.work.jsonl");
    const endedIndex = join(directory, "ended-index.json");
    run(runner, compiled, base, one, "--work", ended);
    run(stalls, ended, "--index", endedIndex);
    const wrong = run(stalls, "rerun", endedIndex, base, another, join(directory, "wrong"));
    assert.match(wrong.stderr, /is not the tree compiled's replay compared/);
    assert.equal(existsSync(join(directory, "wrong")), false);
    assert.equal(run(stalls, "rerun", endedIndex, base, one, join(directory, "right")).status, 1);
    assert.equal(
      run(stalls, ended, "--rerun", join(directory, "right", "compiled.work.jsonl")).status,
      1,
    );

    // charges far faster than the runner reads them, then a wait past the limit: the record holds them all, as the
    // child wrote it over at the last charge (#1564 r1's saturation witness)
    const burst = join(directory, "burst.work.jsonl");
    run(runner, area("burst", ["burst"]), base, head, "--timeout", "1.5", "--work", burst);
    const flooded = lines(readFileSync(burst, "utf8"))[1].runs.at(-1);
    assert.deepEqual([flooded.work, flooded.running], [[3000, 3000 + 10_000 * 65_536], 1]);

    // a replay at a half-second limit: `slow` stalls in the head's long runs, `busy` in the base's turn, `lagging` in the
    // head's first run; each source's record holds each run's units and milliseconds on each tree, a stalled run's
    // those it had when the runner ended it
    const replay = area("replay", ["fast", "slow", "busy", "lagging"]);
    const work = join(directory, "replay.work.jsonl");
    const ran = run(runner, replay, base, head, "--timeout", "0.5", "--work", work);
    assert.equal(ran.status, 1, ran.stderr);
    const [header, fast, slow, busy, lagging, total] = lines(readFileSync(work, "utf8"));
    assert.deepEqual(
      [
        header.work.area,
        header.work.shard,
        header.work.roots,
        header.work.configuration.allowances,
      ],
      [replay, "0/1", [base, head], [null, 16, 256]],
    );
    assert.deepEqual(total.total, JSON.parse(ran.stdout.trim().split("\n").at(-1)!));
    assert.deepEqual(
      fast.runs.map(({ mode, work: units }: { mode: string; work: number[] }) => [mode, ...units]),
      MODES.map((mode) => [mode, 3000, 3000]),
    );
    assert.deepEqual([fast.counts, fast.stalled], [{ runs: 4 }, undefined]);
    assert.deepEqual(
      [slow.stalled, busy.stalled, lagging.stalled],
      ["timeout", "timeout", "timeout"],
    );
    const cut = slow.runs.at(-1);
    assert.deepEqual([cut.work, cut.running], [[3000, 1e9 + 3000], 1]);
    assert.ok(cut.ms[1] > 0 && cut.ms[1] <= 200, String(cut.ms));
    assert.equal(busy.runs.at(-1).running, 0);
    assert.deepEqual(lagging.runs.at(-1).running, 1);

    // the index: `slow` a candidate (the head charged more than the base on a run), `busy` load (the base's turn ran
    // out), `lagging` unknown (the head's run cut short of the base's work); none agreement
    const index = join(directory, "index.json");
    const indexed = run(stalls, work, "--index", index);
    assert.equal(indexed.status, 1, indexed.stderr);
    const printed = lines(indexed.stdout);
    assert.match(printed[0].rule, /^A stalled source is a candidate stall/);
    assert.deepEqual(
      printed.slice(1, 4).map(({ source, verdict }) => [source, verdict]),
      [
        ["slow", "candidate"],
        ["busy", "load"],
        ["lagging", "unknown"],
      ],
    );
    const counted = (row: Record<string, unknown>) =>
      ["sources", "agreed", "unavailable", "load", "candidate", "unknown", "rerun", "closed"].map(
        (key) => row[key],
      );
    assert.deepEqual(counted(printed[5]), [4, 1, 3, 1, 1, 1, 0, false]);
    assert.deepEqual(
      JSON.parse(readFileSync(index, "utf8")).entries.map(
        ({ source }: { source: string }) => source,
      ),
      ["slow", "busy", "lagging"],
    );

    // an index naming a source its area does not hold is refused before any runs
    mkdirSync(join(directory, "elsewhere"));
    const fewer = area(join("elsewhere", "replay"), ["fast"]);
    assert.match(run(runner, fewer, base, head, "--only", index).stderr, /does not hold/);

    // the rerun: each source alone, both trees in one process; all three end and agree, but `slow` charged the head
    // more, so the replay stays open
    const again = join(directory, "again");
    const rerun = run(stalls, "rerun", index, base, head, again, "--timeout", "5");
    assert.equal(rerun.status, 0, rerun.stderr);
    const merged = run(stalls, work, "--rerun", join(again, "replay.work.jsonl"));
    assert.equal(merged.status, 1, merged.stderr);
    const after = lines(merged.stdout);
    assert.deepEqual(
      after
        .slice(1, 4)
        .map(({ source, rerun: { outcome, verdict } }) => [source, outcome, verdict]),
      [
        ["slow", "agreed", "candidate"],
        ["busy", "agreed", undefined],
        ["lagging", "agreed", undefined],
      ],
    );
    assert.deepEqual(counted(after.at(-1)), [4, 4, 0, 0, 1, 0, 3, false]);

    // a replay of other stop allowances (#1564 r1's false-closure witness): its index keeps them, so its rerun runs
    // them again, keeps the difference at allowance 1 and stalls again at 2; a rerun record of other allowances is not
    // merged
    const checks = area("checks", ["checked"], ["publication", "stops"]);
    const checked = join(directory, "checks.work.jsonl");
    run(runner, checks, base, head, "--allowances", "1,2", "--timeout", "0.5", "--work", checked);
    const checkIndex = join(directory, "checks-index.json");
    assert.equal(run(stalls, checked, "--index", checkIndex).status, 1);
    assert.match(
      run(stalls, "rerun", checkIndex, base, head, join(directory, "x"), "--allowances", "1")
        .stderr,
      /drop --allowances/,
    );
    const rechecked = join(directory, "rechecked");
    assert.equal(
      run(stalls, "rerun", checkIndex, base, head, rechecked, "--timeout", "1").status,
      1,
    );
    const reran = run(stalls, checked, "--rerun", join(rechecked, "checks.work.jsonl"));
    assert.equal(reran.status, 1, reran.stderr);
    assert.deepEqual(
      [lines(reran.stdout).at(-1).differences, lines(reran.stdout).at(-1).unavailable],
      [1, 1],
    );
    const defaults = join(directory, "defaults.work.jsonl");
    run(runner, checks, base, head, "--only", checkIndex, "--timeout", "1", "--work", defaults);
    const refusedMerge = run(stalls, checked, "--rerun", defaults);
    assert.equal(refusedMerge.status, 2);
    assert.match(refusedMerge.stderr, /compares otherwise than its replay \(allowances\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the stall index decides each stalled source from its record by one rule: the head's work on each run, its time where both trees ran in one process, and which tree stalled and why (#1564)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const KEYS = [
      "unparsed",
      "stalled",
      "exceptions",
      "unanswered",
      "uncompared",
      "runs",
      "differences",
    ];
    type Entry = { source: string; counts: Record<string, number> } & Record<string, unknown>;
    const CONFIGURATION = {
      sizes: null,
      allowances: [null, 16, 256],
      checks: { "g.mjs": ["publication"] },
      trees: [{ src: null }, { src: null }],
    };
    /**
     * A shard's `--work` record (shard `at` of the area `name`, in the file `file`) of `trees` trees, its total the sum of
     * its sources' counts, cut before its total where `cut`.
     */
    const shard = (
      name: string,
      trees: number,
      entries: Entry[],
      { cut = false, at = "0/1", file: called = name, configuration = CONFIGURATION } = {},
    ) => {
      const sum = (key: string) =>
        entries.reduce((total, { counts }) => total + (counts[key] ?? 0), 0);
      const total = {
        area: name,
        sources: entries.length,
        ...Object.fromEntries(KEYS.map((key) => [key, sum(key)])),
      };
      const file = join(directory, `${called}.work.jsonl`);
      const roots = Array.from({ length: trees }, () => "tree");
      const header = { work: { area: name, shard: at, roots, configuration } };
      const lines = [
        header,
        ...entries.map((entry) => ({ generator: "g.mjs", key: "k", ...entry })),
      ];
      writeFileSync(
        file,
        [...lines, ...(cut ? [] : [{ total }])].map((line) => `${JSON.stringify(line)}\n`).join(""),
      );
      return file;
    };
    const publication = (work: (number | null)[], ms: (number | null)[], running?: number) => ({
      mode: "src-on",
      check: "publication",
      work,
      ms,
      ...(running === undefined ? {} : { running }),
    });
    const stalled = (source: string, why: unknown, runs: Record<string, unknown>[]): Entry => ({
      source,
      stalled: why,
      runs,
      counts: { stalled: 1 },
    });
    const heap =
      "SIGABRT: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
    // both trees in one process: the tree that stalled is the one still running
    const paired = shard("paired", 2, [
      stalled("memory", heap, [publication([10, 5], [5, 3], 1)]),
      stalled("charged", "timeout", [
        publication([100, 100], [10, 10]),
        publication([100, 150], [10, 500], 1),
      ]),
      stalled("slower", "timeout", [
        publication([1000, 1000], [100, 100]),
        publication([1000, 500], [100, 10201], 1),
      ]),
      stalled("boundary", "timeout", [
        publication([1000, 1000], [100, 100]),
        publication([1000, 500], [100, 10200], 1),
      ]),
      stalled("based", "timeout", [
        publication([100, 100], [10, 10]),
        publication([50, null], [180000, null], 0),
      ]),
      stalled("unmeasured", "timeout", [publication([null, null], [10, 180000], 1)]),
      stalled("between", "exit 3", [publication([5, 5], [1, 1])]),
      { source: "agreed", runs: [publication([5, 5], [1, 1])], counts: { runs: 1 } },
      // a source that ended in the replay is judged by agreement alone: its work is the growth gates'
      { source: "costlier", runs: [publication([5, 9], [1, 30000])], counts: { runs: 1 } },
    ]);
    // the head against a stored base, which records no work
    const stored = shard("stored", 1, [
      stalled("timedout", { head: "timeout" }, [publication([500], [180000], 0)]),
      stalled("crashed", { head: heap }, [publication([500], [100], 0)]),
      stalled("inherited", { base: "timeout", head: "timeout" }, [publication([500], [180000], 0)]),
    ]);
    // a replay's `--out` file for a shard run without `--work`: its stalls alone
    const out = join(directory, "property-0of1.jsonl");
    const files = [{ path: "main.tease", source: "x" }];
    writeFileSync(
      out,
      `${JSON.stringify({ generator: "s8-stores.mjs", source: "x", stalled: { head: "timeout" }, files, globals: [] })}\n`,
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [stalls, ...args], { encoding: "utf8" });
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const result = run(paired, stored, out);
    assert.equal(result.status, 1, result.stderr);
    const printed = lines(result.stdout);
    assert.deepEqual(
      printed
        .filter(({ verdict }) => verdict !== undefined)
        .map(({ source, verdict }) => `${source} ${verdict}`),
      [
        "memory candidate",
        "charged candidate",
        "slower candidate",
        "boundary unknown",
        "based load",
        "unmeasured unknown",
        "between unknown",
        "timedout unknown",
        "crashed candidate",
        "inherited unknown",
        "x unknown",
      ],
    );
    assert.match(
      printed.find(({ source }) => source === "based").why,
      /^the base alone stalled \(timeout\)/,
    );
    assert.deepEqual(
      printed
        .filter(({ area, complete }) => area !== undefined && complete !== undefined)
        .map(({ area, complete, agreed, unavailable, candidate }) => [
          area,
          complete,
          agreed,
          unavailable,
          candidate,
        ]),
      [
        ["paired", true, 2, 7, 3],
        ["property", false, 0, 1, 0],
        ["stored", true, 0, 3, 1],
      ],
    );
    // closed where every source agrees; refused, a record cut short, one whose sources do not add up to its total, and
    // a rerun of a source the replay does not hold
    const agreed = shard("agreed", 2, [
      { source: "agreed", runs: [publication([5, 5], [1, 1])], counts: { runs: 1 } },
    ]);
    const closed = run(agreed);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(lines(closed.stdout).at(-1).closed, true);
    // an area complete only with its shards 0/N to N-1/N, one N (#1564 r1's coverage witness), of one configuration
    const half = (at: string, file: string, configuration = CONFIGURATION) =>
      shard(
        "halves",
        2,
        [{ source: `s${at}`, runs: [publication([5, 5], [1, 1])], counts: { runs: 1 } }],
        { at, file, configuration },
      );
    const second = half("1/2", "second");
    const alone = lines(run(second).stdout);
    assert.deepEqual(
      [alone.at(-2).complete, alone.at(-2).missing, alone.at(-1).closed],
      [false, ["0/2"], false],
    );
    const beyond = lines(run(second, half("2/2", "beyond")).stdout);
    assert.deepEqual([beyond.at(-2).complete, beyond.at(-2).missing], [false, ["0/2"]]);
    const both = run(half("0/2", "first"), second);
    assert.equal(both.status, 0, both.stderr);
    assert.equal(lines(both.stdout).at(-2).shards, "2/2");
    // a source the plan lists twice (#1582): one source where its repeats record the same, milliseconds apart; refused,
    // naming the place, where they differ, in a replay and in a rerun
    const twice = (name: string, counts: Record<string, number>[], why?: string) =>
      shard(
        name,
        2,
        counts.map((second, index) => ({
          source: "dup",
          stalled: why,
          runs: [publication([5, 5], [1, index + 1])],
          counts: second,
        })),
      );
    const alike = lines(run(twice("alike", [{ runs: 1 }, { runs: 1 }])).stdout).at(-1);
    assert.deepEqual([alike.sources, alike.repeats, alike.closed], [1, 1, true]);
    const unlike = run(twice("unlike", [{ runs: 1 }, { runs: 1, differences: 1 }]));
    assert.equal(unlike.status, 2);
    assert.match(
      unlike.stderr,
      /holds a source another record holds otherwise: \["unlike","g.mjs","dup","k"\]/,
    );
    const stalledTwice = twice("rerunning", [{ stalled: 1 }, { stalled: 1 }], "timeout");
    const rerunTwice = join(directory, "rerun-twice.work.jsonl");
    writeFileSync(
      rerunTwice,
      readFileSync(
        twice("rerunning-again", [{ runs: 1 }, { runs: 1, differences: 1 }]),
        "utf8",
      ).replaceAll('"area":"rerunning-again"', '"area":"rerunning"'),
    );
    assert.equal(run(stalledTwice).status, 1);
    assert.match(
      run(stalledTwice, "--rerun", rerunTwice).stderr,
      /holds a source another record holds otherwise: \["rerunning","g.mjs","dup","k"\]/,
    );
    // rerun records are judgement attempts, in the order given (#1587): a later round's end replaces an earlier stall
    // (and a later stall an earlier end); two ends that differ are refused, naming the place; a replay's records are
    // never replaced, so a replay that records a source otherwise is refused whatever its order
    const late = (file: string, ended: boolean, counts: Record<string, number> = { runs: 1 }) =>
      shard(
        "late",
        2,
        [
          ended
            ? { source: "slow", runs: [publication([100, 100], [10, 10])], counts }
            : stalled("slow", "timeout", [publication([100, 50], [10, 180000], 1)]),
        ],
        { file },
      );
    const [lateReplay, lateStall, lateEnd] = [
      late("late", false),
      late("late-stall", false),
      late("late-end", true),
    ];
    const latest = run(lateReplay, "--rerun", lateStall, lateEnd);
    assert.equal(latest.status, 0, latest.stderr);
    assert.deepEqual(
      [lines(latest.stdout).at(-1).agreed, lines(latest.stdout).at(-1).closed],
      [1, true],
    );
    assert.equal(
      lines(run(lateReplay, "--rerun", lateEnd, lateStall).stdout).at(-1).unavailable,
      1,
    );
    const differing = run(
      lateReplay,
      "--rerun",
      lateEnd,
      late("late-other", true, { differences: 1 }),
    );
    assert.equal(differing.status, 2);
    assert.match(
      differing.stderr,
      /holds a source another record holds otherwise: \["late","g.mjs","slow","k"\]/,
    );
    const halves = (at: string, ended: boolean) => {
      const file = late(`kept-${at[0]}`, ended);
      writeFileSync(file, readFileSync(file, "utf8").replace('"shard":"0/1"', `"shard":"${at}"`));
      return file;
    };
    const kept = run(halves("0/2", false), halves("1/2", true));
    assert.equal(kept.status, 2);
    assert.match(
      kept.stderr,
      /holds a source another record holds otherwise: \["late","g.mjs","slow","k"\]/,
    );
    // repeats whose times differ (#1583 r1): the one the time clause judges a candidate stands for them, in either
    // order, in one record or across shards, in a replay, its index and its rerun
    const timed = (ms: number, stall = true) => ({
      source: "dup",
      ...(stall ? { stalled: "timeout" } : {}),
      runs: [publication([100, 100], [1, ms])],
      counts: stall ? { stalled: 1 } : { runs: 1 },
    });
    for (const order of [
      [1, 30000],
      [30000, 1],
    ]) {
      const name = `timed-${order[0]}`;
      const index = join(directory, `${name}.json`);
      const together = lines(
        run(
          shard(
            name,
            2,
            order.map((ms) => timed(ms)),
          ),
          "--index",
          index,
        ).stdout,
      );
      assert.equal(together.at(-1).candidate, 1);
      const [entry] = JSON.parse(readFileSync(index, "utf8")).entries;
      assert.deepEqual([entry.verdict, entry.runs[0].head.ms], ["candidate", 30000]);
      const split = order.map((ms, at) =>
        shard(`${name}-split`, 2, [timed(ms)], { at: `${at}/2`, file: `${name}-${at}` }),
      );
      assert.equal(lines(run(...split).stdout).at(-1).candidate, 1);
      const replayed = shard(`${name}-rerun`, 2, [timed(1), timed(1)]);
      const reran = join(directory, `${name}-again.work.jsonl`);
      writeFileSync(
        reran,
        readFileSync(
          shard(
            `${name}-again`,
            2,
            order.map((ms) => timed(ms, false)),
          ),
          "utf8",
        ).replaceAll(`"area":"${name}-again"`, `"area":"${name}-rerun"`),
      );
      const closing = lines(run(replayed, "--rerun", reran).stdout).at(-1);
      assert.deepEqual([closing.agreed, closing.candidate, closing.closed], [1, 1, false]);
    }
    const otherwise = half("0/2", "otherwise", { ...CONFIGURATION, allowances: [1, 2] });
    assert.match(
      run(otherwise, second).stderr,
      /compares otherwise than the area's other shards \(allowances\)/,
    );
    assert.equal(run(shard("cut", 2, [], { cut: true })).status, 2);
    const uneven = shard("uneven", 2, [{ source: "a", runs: [], counts: { runs: 2 } }]);
    writeFileSync(uneven, readFileSync(uneven, "utf8").replace('"runs":2}}', '"runs":1}}'));
    assert.equal(run(uneven).status, 2);
    const other = join(directory, "other.work.jsonl");
    writeFileSync(
      other,
      readFileSync(agreed, "utf8")
        .replace('"shard":"0/1"', '"shard":"0/1","only":"index"')
        .replace('"source":"agreed"', '"source":"another"'),
    );
    assert.equal(run(agreed, "--rerun", other).status, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
