import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
    const store = (from: string, ...args: string[]) =>
      spawnSync(process.execPath, [runner, args[0]!, from, "--store", ...args.slice(1)], {
        encoding: "utf8",
      });
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
    // the defaults; a folder this tool did not make, whose contents `prune` leaves
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
    // the path, and `prune` keeps it, naming it, where it removes one whose trees are gone
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
    rmSync(gone, { recursive: true });
    rmSync(foreign, { recursive: true });
    // (and a folder with another tool's MANIFEST, which `prune` leaves as it is, no lock written into it)
    mkdirSync(join(elsewhere, "other"));
    writeFileSync(join(elsewhere, "other", "MANIFEST"), "sha 1\ntree /gone\n");
    const pruned = spawnSync(process.execPath, [baselines, "prune", elsewhere], {
      encoding: "utf8",
    });
    assert.match(pruned.stdout, /"pruned"/);
    assert.match(pruned.stdout, /"kept":.*"foreign":\["other-agent\/"\]/);
    assert.deepEqual(readdirSync(elsewhere).sort(), [SRC, held.split("/").at(-1), "other"].sort());
    assert.deepEqual(readdirSync(join(elsewhere, "other")), ["MANIFEST"]);
    assert.deepEqual(readdirSync(join(elsewhere, SRC)), ["data"]);
    assert.equal(readFileSync(join(held, "other-agent", "data"), "utf8"), "x\n");

    // `prune` decides under the baseline's lock (#1542 r2: prune-versus-joining-writer): paused right after it read the
    // MANIFEST whose only tree is gone, it retires the baseline, and an alias writer finds it retired and stores into a
    // new one, which names its commit alone. In two orders, neither left to timing: the writer's lock holder has opened
    // the folder, to wait for the lock, when prune goes on (the writer says so once the holder's descriptor is open); or
    // the writer starts its lock holder only once prune has ended (held right before it), when a holder that locked the
    // folder by its path made a file there
    const pause = (at: string) =>
      `import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const wait = () => {
  fs.writeFileSync(process.env.PAUSE_READY, "");
  while (!fs.existsSync(process.env.PAUSE_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
};
const [read, spawned] = [fs.readFileSync, childProcess.spawn];
let paused = false;
${
  at === "read"
    ? `fs.readFileSync = function (file, ...rest) {
  const result = read.call(this, file, ...rest);
  if (!paused && String(file) === process.env.PAUSE_MANIFEST) (paused = true), wait();
  return result;
};`
    : at === "opened"
      ? `childProcess.spawn = function (...args) {
  const child = spawned.apply(this, args);
  // (the holder has the folder open, or has ended)
  const open = () => {
    try {
      if (fs.readFileSync("/proc/" + child.pid + "/stat", "utf8").split(") ")[1].startsWith("Z")) return true;
      return fs
        .readdirSync("/proc/" + child.pid + "/fd")
        .some((fd) => fs.readlinkSync("/proc/" + child.pid + "/fd/" + fd) === process.env.PAUSE_FOLDER);
    } catch {
      return true;
    }
  };
  if (!paused) {
    paused = true;
    while (!open()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    fs.writeFileSync(process.env.PAUSE_READY, "");
  }
  return child;
};`
      : `childProcess.spawn = function (...args) {
  if (!paused) (paused = true), wait();
  return spawned.apply(this, args);
};`
}
syncBuiltinESMExports();
`;
    const background = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      return new Promise<{ status: number | null; stdout: string }>((done) =>
        child.on("close", (status) => done({ status, stdout })),
      );
    };
    const until = async (done: () => boolean) => {
      while (!done()) await new Promise((next) => setTimeout(next, 10));
    };
    for (const order of ["waiting", "late"]) {
      const racing = join(directory, `racing-${order}`);
      const retired = tree(`retired-${order}`, "7", "", "racing\n");
      const joining = tree(`joining-${order}`, "8", "", "racing\n");
      assert.equal(store(retired, area, racing, "--shard", "0/2").status, 1);
      rmSync(retired, { recursive: true });
      const raced = join(racing, readdirSync(racing)[0]!);
      const preloads = ["read", order === "waiting" ? "opened" : "spawn"].map((at) => {
        const file = join(directory, `pause-${order}-${at}.mjs`);
        writeFileSync(file, pause(at));
        return file;
      });
      const named = (name: string) => join(directory, `${order}-${name}`);
      const [ready, release, held, go] = [
        named("ready"),
        named("release"),
        named("held"),
        named("go"),
      ];
      const pruning = background(["--import", preloads[0]!, baselines, "prune", racing], {
        ...process.env,
        PAUSE_MANIFEST: join(raced, "MANIFEST"),
        PAUSE_READY: ready,
        PAUSE_RELEASE: release,
      });
      await until(() => existsSync(ready));
      const writing = background(
        ["--import", preloads[1]!, runner, area, joining, "--store", racing, "--shard", "1/2"],
        { ...process.env, PAUSE_READY: held, PAUSE_RELEASE: go, PAUSE_FOLDER: raced },
      );
      await until(() => existsSync(held));
      writeFileSync(release, "");
      const prunedRace = await pruning;
      writeFileSync(go, "");
      const wrote = await writing;
      assert.match(prunedRace.stdout, /"pruned"/);
      assert.equal(wrote.status, 1);
      assert.match(wrote.stdout, /"verified":true/);
      assert.deepEqual(readdirSync(racing), [raced.split("/").at(-1)]);
      assert.equal(statSync(raced).isDirectory(), true);
      assert.deepEqual(
        readFileSync(join(raced, "MANIFEST"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("commit ")),
        [`commit ${"8".repeat(40)} ${joining}`],
      );
      assert.deepEqual(states(state(joining, racing)), ["area partial 1"]);
    }

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

    // one stored hash altered and one source removed: a difference, and the removed source's runs uncompared
    const shards = ["0of2.runs.jsonl", "1of2.runs.jsonl"].map((file) => join(baseline, file));
    const lines = shards.flatMap((file) => readFileSync(file, "utf8").trim().split("\n"));
    for (const file of shards) {
      const entries = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(({ source }) => source !== "changed");
      const same = entries.find(({ source }) => source === "same");
      if (same !== undefined) same.runs["src-on publication"].value.hash = "0".repeat(64);
      writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    }
    const mutated = run(head, "--baseline", baseline);
    assert.equal(mutated.status, 1);
    assert.deepEqual(counts(mutated), [5, 1, 4, 4, 4, 16, 1]);
    assert.deepEqual(
      mutated.kept
        .filter(({ source }) => source === "same" || source === "changed")
        .map(({ source, mode, uncompared }) => [source, mode ?? uncompared]),
      [
        ["same", "src-on"],
        [
          "changed",
          ["src-on", "src-off", "rev-on", "rev-off"].map((mode) => `${mode} publication`),
        ],
      ],
    );

    // the unaltered result in a second file: a source stored twice with other results is no baseline
    const same = lines.find((line) => JSON.parse(line).source === "same");
    writeFileSync(join(baseline, "z.runs.jsonl"), `${same}\n`);
    const twice = spawnSync(process.execPath, [runner, area, head, "--baseline", baseline], {
      encoding: "utf8",
    });
    assert.equal(twice.status, 2);
    assert.match(twice.stderr, /"same".* is stored twice, with other results/);
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

test("the stored baselines' tools write into a baseline only through its gate, every write computed from their modules (#1542)", async () => {
  const { modules, sites, escapes, processes, loads } = await inventoryOf(process.cwd());
  assert.deepEqual(modules, [
    "tests/families/baselines.mjs",
    "tests/families/run.mjs",
    "tests/families/sources.mjs",
  ]);
  // each write is in the gate or proven to lie outside every baseline, and fs is used only by calls
  assert.deepEqual(
    sites.filter(({ kind }) => kind === "unproven"),
    [],
  );
  assert.deepEqual(escapes, []);
  assert.deepEqual(
    sites.filter(({ kind }) => kind === "creation").map((site) => site.function),
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
import { beside, outside } from "./baselines.mjs";
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
  const away = beside(outside(root, [], () => {}), ".x");
  everything.rmSync(path.join(away, "..", "y"));
  everything.rmSync(path.join(beside(root, ".y"), "z"));
  process.getBuiltinModule("node:fs").rmdirSync(root);
  const { promises: { rm } } = fs;
  eval("0");
  spawn("flock", [root, "-c", "true"]);
  spawn("bash", ["-c", 'touch "$0"', root], { stdio: "ignore" });
  execSync("touch notes");
  return [rm, Worker];
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
        "async function gate(dir, action) {\n",
        'async function gate(dir, action) {\n  rmSync(path.join(dir, "early"), { force: true });\n',
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
          "spawn",
          "spawn",
          "execSync",
        ].map((write) => `tests/families/sources.mjs ${write}`),
      ],
    );
    assert.deepEqual(
      copied.escapes.map(({ code }) => code),
      ['import { Worker } from "node:worker_threads";', "fs", "written", "fs", 'eval("0")'],
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

    // a join killed before its new baseline was renamed into place: the next one makes it; prune clears the leftover
    const second = join(directory, "second");
    await killedAt("^writeFileSync .*\\.creating-.*MANIFEST ", baselines, "state", base, second);
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
    // (#1542 r3: queued-job-foreign-contents) a job's decision in a baseline that holds a foreign path is refused,
    // nothing written
    writeFileSync(join(top, "foreign-late"), "x\n");
    const before = readdirSync(top).sort();
    assert.equal(run(baselines, "start", top, top.split("/").at(-1)!).status, 2);
    assert.deepEqual(readdirSync(top).sort(), before);

    // a prune killed between retiring a baseline and removing it: the next prune clears the retired folder, and the
    // join's leftover
    const third = join(directory, "third");
    const gone = tree("gone", "3", "gone\n");
    assert.equal(store(gone, third, "0/1").status, 0);
    rmSync(gone, { recursive: true });
    await killedAt("^renameSync .*\\.pruning-", baselines, "prune", third);
    assert.equal(readdirSync(third).filter((name) => name.startsWith(".pruning-")).length, 1);
    // (#1542 r3: foreign-retirement-prefix) a folder named as the tool names its own, but not by one of its writers, is
    // kept and named
    mkdirSync(join(third, ".pruning-independent-owner"));
    writeFileSync(join(third, ".pruning-independent-owner", "keep.txt"), "x\n");
    assert.match(
      run(baselines, "prune", third).stdout,
      /"kept":"[^"]*\.pruning-independent-owner"/,
    );
    run(baselines, "prune", second);
    assert.deepEqual(readdirSync(third), [".pruning-independent-owner"]);
    assert.deepEqual(readdirSync(second), [top.split("/").at(-1)]);

    // (#1542 r4: padded-temporary) names this tool never renders, a shard's or a temporary file's with a padded number,
    // are foreign as any other file is: status refuses the baseline naming each, prune keeps it, each file untouched
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
      assert.match(run(baselines, "prune", fourth).stdout, /"kept"/);
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
    rmSync(notes);
    // prune then removes the baseline, and keeps a folder beside it named as no writer of this tool names one, though
    // empty
    const padded = join(fourth, `.pruning-${"a".repeat(40)}-01-1`);
    mkdirSync(padded);
    const pruned = run(baselines, "prune", fourth).stdout;
    assert.match(pruned, /"pruned"/);
    assert.ok(pruned.includes(`"kept":"${padded}"`));
    assert.deepEqual(readdirSync(fourth), [padded.split("/").at(-1)]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
