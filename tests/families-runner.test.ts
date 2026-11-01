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
  // site); the modules loaded by a computed name are a tree's oracle library and an area's generators, which are no
  // tool's
  assert.deepEqual(
    processes.map((process) => process.allowed),
    ["the gate's lock holder", "the runner's own child"],
  );
  assert.deepEqual(
    loads.map((load) => load.function),
    ["oracles", "generatorsOf"],
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
    // (#1567) a fill that STARTED and stored a shard is SUPERSEDED once another src/ tree is current, so that its other
    // jobs end; its stored shard is still read, the area partial; `queue` undoes SUPERSEDED when the tree is current again;
    // STARTED keeps the time the fill began throughout
    assert.equal(store(alias, second, "0/2").status, 0);
    const began = readFileSync(join(top, "STARTED"), "utf8");
    const newer = "f".repeat(40);
    assert.deepEqual(last(run(baselines, "start", top, newer)), {
      decision: "superseded",
      by: newer,
    });
    assert.equal(readFileSync(join(top, "SUPERSEDED"), "utf8"), `${newer}\n`);
    assert.equal(readFileSync(join(top, "STARTED"), "utf8"), began);
    const superseded = run(baselines, "state", base, second, "--read-only");
    assert.equal(superseded.status, 1, superseded.stdout);
    const partial = JSON.parse(superseded.stdout.split("\n")[0]!);
    assert.deepEqual([partial.state, partial.verified, partial.store], ["partial", 1, [1]]);
    assert.equal(last(run(baselines, "queue", top, hook)).queued, top);
    assert.deepEqual(readdirSync(top).sort(), ["MANIFEST", "STARTED", "area", "baseline.sh"]);
    assert.equal(readFileSync(join(top, "STARTED"), "utf8"), began);
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
