import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  runner,
  baselines,
  stalls,
  LEDGER,
  storable,
  SRC,
  writeSrc,
  FILLABLE,
} from "../helpers/families-runner/families-runner-stand-ins.js";

test("`baselines.mjs state` takes a tree's commit from its `.sha`, else from the HEAD of the checkout it is the top of, and a written state of a tree with neither is refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    // a plain checkout's tree: built, but without `sx-tree`'s `.sha`
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "package-lock.json"), "{}\n");
    writeFileSync(join(tree, "dist", "tests", "helpers", "type-core-oracles.js"), storable(false));
    writeSrc(tree);
    mkdirSync(join(tree, "tests", "families", "area"), { recursive: true });
    writeFileSync(
      join(tree, "tests", "families", "area", "a.mjs"),
      'export const cases = [["same", "same"]];\n',
    );
    const root = join(directory, "baselines");
    const manifest = join(root, SRC, "MANIFEST");
    const state = (...more: string[]) =>
      spawnSync(process.execPath, [baselines, "state", tree, root, ...more], { encoding: "utf8" });
    const commits = () =>
      readFileSync(manifest, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("commit "));
    const git = (folder: string, ...args: string[]) =>
      spawnSync("git", ["-C", folder, ...args], { encoding: "utf8" });
    const commit = (folder: string) => {
      assert.equal(git(folder, "init", "-q").status, 0);
      const committed = git(
        folder,
        "-c",
        "user.name=families",
        "-c",
        "user.email=families@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "tree",
      );
      assert.equal(committed.status, 0, committed.stderr);
      return git(folder, "rev-parse", "HEAD").stdout.trim();
    };
    // (the tree inside another checkout, whose HEAD is not the tree's commit)
    commit(directory);

    // read only, the commit is not read (a `.sha` that is no file is never opened); written, a tree with no commit is
    // refused before its baseline is made
    mkdirSync(join(tree, ".sha"));
    const read = state("--read-only");
    assert.notEqual(read.status, 2, read.stderr);
    assert.match(read.stdout, /"area":"area"[^\n]*"state":"absent"/u);
    assert.equal(existsSync(root), false);
    rmSync(join(tree, ".sha"), { recursive: true });
    const refused = state();
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /has no \.sha and is no checkout's top/u);
    assert.equal(existsSync(root), false);

    // the HEAD of the checkout the tree is the top of, then a `.sha` before it
    const head = commit(tree);
    const fromHead = state();
    assert.notEqual(fromHead.status, 2, fromHead.stderr);
    assert.deepEqual(commits(), [`commit ${head} ${tree}`]);
    writeFileSync(join(tree, ".sha"), `${"1".repeat(40)}\n`);
    assert.notEqual(state().status, 2);
    assert.deepEqual(commits(), [`commit ${head} ${tree}`, `commit ${"1".repeat(40)} ${tree}`]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    const names = ["same", "changed", "throws", "stopped", "ends", "alike"];
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
      [
        "sources",
        "stalled",
        "exceptions",
        "unanswered",
        "unansweredAlike",
        "uncompared",
        "runs",
        "differences",
      ].map((key) => total[key]);

    // one shard from one commit, the other from the other: while a running writer claims it, the second is left to
    // it; a writer that ended (another start time) claims it no longer, and its temporary file goes
    assert.equal(into(base, "0/2").status, 1);
    assert.deepEqual(readdirSync(baseline).sort(), ["0of2.runs.jsonl", "PLAN"]);
    // (a stored shard's total line holds no peak, nor the heap limit or what the runner read of the tree, #2068)
    const storedTotal = JSON.parse(
      readFileSync(join(baseline, "0of2.runs.jsonl"), "utf8").trim().split("\n").at(-1)!,
    ).total;
    for (const advisory of ["nearCap", "heapLimit", "capabilities"])
      assert.equal(advisory in storedTotal, false, advisory);
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

    // the head against the stored base and against the base tree run beside it, `alike` unanswered alike on both
    const beside = run(base, head);
    const against = run(head, "--baseline", baseline);
    assert.deepEqual(counts(beside), [6, 1, 4, 4, 4, 0, 20, 4]);
    assert.deepEqual(counts(against), counts(beside));
    assert.equal(against.status, 1);
    // its record (#1564, #1647): the stored base's units first, then the head's, which these trees without a ledger
    // record as `null`, and each stall's trees, a stall of both trees inherited
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
      for (const { work, ms } of ran)
        assert.deepEqual(
          [work, ms],
          [
            [null, null],
            [null, ms[1]],
          ],
        );
    assert.deepEqual(recorded.find(({ source }) => source === "ends").stalled, {
      base: "exit 3",
      head: "exit 3",
    });
    assert.match(
      spawnSync(process.execPath, [stalls, record], { encoding: "utf8" }).stdout,
      /"source":"ends".*"verdict":"inherited"/,
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
      [
        {
          generator: "stored.mjs",
          source: "ends",
          stalled: { base: "exit 3", head: "exit 3" },
          // (the run the head's stall cut, #1965)
          at: { tree: "head", mode: "src-on", check: "publication" },
        },
      ],
    );
    // a stored base result without its parts or its count (#1592), its shard's digest repaired: no store writes it, so
    // the comparison refuses it as every reader of a shard does (#1647, Codex r1), naming the line
    for (const [witness, dropped] of [
      ["no parts", "parts"],
      ["no count", "unanswered"],
    ] as const) {
      const copy = join(directory, "stripped", witness.replace(" ", "-"));
      cpSync(join(root, SRC), join(copy, SRC), { recursive: true });
      const file = join(copy, SRC, "area", "1of2.runs.jsonl");
      const [ended, ...sources] = readFileSync(file, "utf8").trim().split("\n").reverse();
      const body = sources
        .reverse()
        .map((line) => {
          const kept = JSON.parse(line);
          if (kept.source === "alike")
            for (const result of Object.values<{ value: Record<string, unknown> }>(kept.runs))
              delete result.value[dropped];
          return `${JSON.stringify(kept)}\n`;
        })
        .join("");
      const total = JSON.parse(ended!);
      total.total.lines = createHash("sha256").update(body).digest("hex");
      writeFileSync(file, `${body}${JSON.stringify(total)}\n`);
      const stripped = spawnSync(
        process.execPath,
        [runner, area, head, "--baseline", join(copy, SRC, "area")],
        { encoding: "utf8" },
      );
      assert.equal(stripped.status, 2, witness);
      assert.match(
        stripped.stderr,
        /stored\.mjs alike: its run "src-on publication" is not one a store writes/,
      );
    }

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

test("a baseline plans copies in 64 shards where it first plans it, keeps a count it recorded, and a head of any shard count compares with it (#1826)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = join(directory, "built");
    for (const part of [
      "dist/src",
      "dist/tests/helpers",
      "src",
      "tests/families/area",
      "tests/families/copies",
    ])
      mkdirSync(join(built, part), { recursive: true });
    writeFileSync(join(built, "src", "a.ts"), "a\n");
    writeFileSync(join(built, "dist", "src", "a.js"), "compiled\n");
    mkdirSync(join(built, "dist", "src", "type-inference", "core"), { recursive: true });
    writeFileSync(join(built, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
    writeFileSync(join(built, "dist", "tests", "helpers", "type-core-oracles.js"), FILLABLE);
    writeFileSync(join(built, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(built, "package-lock.json"), "{}\n");
    writeFileSync(join(built, ".sha"), `${"1".repeat(40)}\n`);
    for (const tool of ["baselines.mjs", "run-contract.mjs", "run.mjs", "sources.mjs", "split.mjs"])
      cpSync(join("tests", "families", tool), join(built, "tests", "families", tool));
    const cases = (names: string[]) =>
      `export const cases = ${JSON.stringify(names.map((name) => [name, name]))};\n`;
    writeFileSync(
      join(built, "tests", "families", "area", "g.mjs"),
      cases(["p", "q", "r", "s", "t"]),
    );
    writeFileSync(join(built, "tests", "families", "copies", "g.mjs"), cases(["x", "y"]));
    const { identityOf, planOf } = await import(pathToFileURL(baselines).href);
    const { generatorsOf } = await import(
      pathToFileURL(resolve("tests/families/sources.mjs")).href
    );
    const src: string = identityOf(built).src;
    const at = (...parts: string[]) => join(directory, ...parts);
    const tool = (...args: string[]) =>
      spawnSync(process.execPath, [baselines, ...args], { encoding: "utf8" });
    const run = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
    const store = (root: string, area: string, shard: string) =>
      run(runner, join(built, "tests", "families", area), built, "--store", root, "--shard", shard);
    const listed = (root: string) =>
      readFileSync(at(root, "shards.tsv"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t"));

    // a seed plans copies in 64 shards, every other area in 16, and lists each shard to store
    assert.equal(tool("seed", built, at("seed")).status, 0);
    const manifest = readFileSync(at("seed", src, "MANIFEST"), "utf8");
    assert.match(manifest, /^area copies 64 [0-9a-f]{64}$/m);
    assert.match(manifest, /^area area 16 [0-9a-f]{64}$/m);
    const counts = (root: string) =>
      Object.fromEntries(
        ["area", "copies"].map((area) => {
          const lines = listed(root).filter(([name]) => name === area);
          return [area, [lines.length, new Set(lines.map(([, , n]) => n))]];
        }),
      );
    assert.deepEqual(counts("seed"), {
      area: [16, new Set(["16"])],
      copies: [64, new Set(["64"])],
    });
    // a first store of copies in another count is refused; any other area keeps the first writer's count
    mkdirSync(at("fresh"));
    const fresh = store(at("fresh"), "copies", "0/16");
    assert.equal(fresh.status, 2, fresh.stderr);
    assert.match(fresh.stderr, /planned in 64 shards where a baseline first plans it/);
    // a baseline that recorded copies in 16 shards (before #1826) keeps them: its seed lists 16, a store in 64 is
    // refused, one in 16 stores
    cpSync(at("seed"), at("old"), { recursive: true });
    const copies = await generatorsOf(join(built, "tests", "families", "copies"));
    const old = planOf("copies", copies, 16);
    const id = createHash("sha256").update(old).digest("hex");
    writeFileSync(at("old", src, "copies", "PLAN"), old);
    writeFileSync(
      at("old", src, "MANIFEST"),
      manifest.replace(/^area copies 64 [0-9a-f]{64}$/m, `area copies 16 ${id}`),
    );
    rmSync(at("old", "shards.tsv"));
    assert.equal(tool("seed", built, at("old")).status, 0);
    assert.deepEqual(counts("old"), { area: [16, new Set(["16"])], copies: [16, new Set(["16"])] });
    assert.match(store(at("old"), "copies", "0/64").stderr, /is planned otherwise/);
    assert.equal(store(at("old"), "copies", "0/16").status, 0);
    // a head compares with a baseline whatever the counts: `area` stored in 4 shards, run in 3 and by its sources
    mkdirSync(at("four"));
    for (const shard of [0, 1, 2, 3])
      assert.equal(store(at("four"), "area", `${shard}/4`).status, 0);
    const against = (...more: string[]) => {
      const result = run(
        runner,
        join(built, "tests", "families", "area"),
        built,
        "--baseline",
        at("four", src, "area"),
        ...more,
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    };
    const totals = [0, 1, 2].map((shard) => against("--shard", `${shard}/3`));
    assert.deepEqual(
      [
        totals.reduce((sum, t) => sum + t.sources, 0),
        totals.reduce((sum, t) => sum + t.uncompared, 0),
      ],
      [5, 0],
    );
    const places = run(
      resolve("tests/families/items.mjs"),
      "sources",
      join(built, "tests", "families", "area"),
    );
    writeFileSync(at("area.items"), places.stdout);
    const byItems = against("--items", at("area.items"));
    assert.deepEqual([byItems.sources, byItems.uncompared, byItems.differences], [5, 0, 0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the check and the baselines take one set of areas: each folder of tests/families that holds a generator, never one of data only, and the baselines the corpus fixture beside them (#1865)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-areas-"));
  try {
    const tree = join(directory, "tree");
    const families = join(tree, "tests", "families");
    const write = (file: string, text: string) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    };
    const generator = 'export const cases = [["one", "say 1"]];\n';
    write(join(tree, "src", "index.js"), "export {};\n");
    write(join(tree, ".sha"), `${"0".repeat(40)}\n`);
    write(join(families, "area", "one.mjs"), generator);
    write(join(families, "data", "table.json"), "{}\n");
    write(join(families, "loose.mjs"), "export {};\n");
    mkdirSync(join(families, "empty"));
    write(join(tree, "tools", "corpus", "fixture", "cells.mjs"), generator);
    const sources = resolve("tests/families/sources.mjs");
    const { generatorFolders, holdsGenerators } = await import(pathToFileURL(sources).href);
    assert.deepEqual(generatorFolders(families), [join(families, "area")]);
    assert.deepEqual(
      ["area", "data", "empty"].map((name) => holdsGenerators(join(families, name))),
      [true, false, false],
    );
    assert.deepEqual(generatorFolders(join(tree, "absent")), []);
    // (the check, copied beside those folders, lists the area's generator alone)
    cpSync(resolve("tests/families/check.mjs"), join(families, "check.mjs"));
    cpSync(sources, join(families, "sources.mjs"));
    const listed = spawnSync(process.execPath, [join(families, "check.mjs"), "--list"], {
      encoding: "utf8",
    });
    assert.equal(listed.stderr, "");
    const generators = listed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).generator)
      .filter((name) => name !== undefined);
    assert.deepEqual(generators, ["area/one.mjs"]);
    // (the baselines' state of that tree: the same area, then the corpus fixture)
    const root = join(directory, "baselines");
    mkdirSync(root);
    const state = spawnSync(process.execPath, [baselines, "state", tree, root, "--read-only"], {
      encoding: "utf8",
    });
    assert.notEqual(state.stdout.trim(), "", state.stderr);
    const areas = state.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).area)
      .filter((name) => name !== undefined);
    assert.deepEqual(areas, ["area", "fixture"], state.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// (each source's stops on each tree: a place that stops at another pass, one the head alone stops, one the base
// alone stops, and stops alike where the stop set differs in another field; names in no order of the property; and a
// tree whose run holds no stop list, `undefined` here: an oracle without them, or the head's unparsed run)
const stopsOf = (head: boolean) => ({
  moved: [[head ? 2 : 1, "r", "x", 2]],
  added: head
    ? [
        [1, "r", "x", 1],
        [1, "q", "y", 3],
      ]
    : [[1, "r", "x", 1]],
  removed: head
    ? [[1, "r", "x", 1]]
    : [
        [1, "r", "x", 1],
        [1, "q", "y", 3],
      ],
  fields: [[1, "r", "x", 1]],
  // (a place that stops in passes 1 and 2 on the base and in pass 2 alone on the head: the pass-1 stop removed, the
  // identical pass-2 stops paired first, never one moved and one removed)
  restarted: head
    ? [[2, "p", "z", 1]]
    : [
        [1, "p", "z", 1],
        [2, "p", "z", 1],
      ],
  "head without": head ? undefined : [[1, "r", "x", 1]],
  "base without": head ? [[1, "r", "x", 1]] : undefined,
  "head unparsed": head ? undefined : [[1, "r", "x", 1]],
});
const stopsLibrary = (head: boolean) => `
export function stopSet(files) {
  const source = files[0].source;
  if (${head} && source === "head unparsed") return null;
  const stops = ${JSON.stringify(stopsOf(head))}[source];
  return { ...(stops === undefined ? {} : { stops }), passes: 1, restarts: 0, outcome: "complete",
exhausted: null, record: ${head} && source === "fields" ? "other" : "same" };
}
`;

test("a stops run's decision stops are classified where both trees ran, never stored, and against a store unavailable, naming the base, each read by compiler-replay's verdict (#2355)", async () => {
  // (the replay's reader of an area's records, which the runner's records below must pass, every form)
  const { areaRecordForm, apartText } = await import(
    pathToFileURL(resolve(process.cwd(), "tools/compiler-replay.mjs")).href
  );
  const readBack = (kept: Record<string, unknown>[]): Record<string, string> =>
    Object.fromEntries(
      kept.map((record) => [record.source, `${areaRecordForm(record)}: ${apartText(record)}`]),
    );
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const names = [
      "moved",
      "head without",
      "added",
      "base without",
      "removed",
      "fields",
      "head unparsed",
      "restarted",
    ];
    const tree = (name: string, sha: string, head: boolean) => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "package-lock.json"), "{}\n");
      writeFileSync(
        join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
        storable(head) + stopsLibrary(head),
      );
      writeFileSync(join(folder, ".sha"), `${sha.repeat(40)}\n`);
      writeSrc(folder, head ? "head\n" : "");
      return folder;
    };
    const [base, head] = [tree("base", "1", false), tree("head", "2", true)];
    const area = join(directory, "area");
    mkdirSync(area);
    writeFileSync(
      join(area, "stopping.mjs"),
      `export const cases = ${JSON.stringify(names.map((name) => [name, name]))};\nexport const checks = ["stops"];\n`,
    );
    const out = join(directory, "out.jsonl");
    const run = (...args: string[]) => {
      rmSync(out, { force: true });
      const result = spawnSync(process.execPath, [runner, area, ...args, "--out", out], {
        encoding: "utf8",
      });
      const kept = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line): Record<string, unknown> => JSON.parse(line))
        .filter(({ mode, check }) => mode === "src-on" && check === "stops natural");
      return { status: result.status, stderr: result.stderr, kept };
    };
    const stopsBy = (kept: Record<string, unknown>[]) =>
      Object.fromEntries(kept.map(({ source, stops }) => [source, stops]));

    // (why the stops are unavailable, as run.mjs says it, for each side that holds no list)
    const baseNone =
      "the base's run holds no stop list (a stored run never does): a run of the differing sources on two trees whose oracles list stops gives it";
    const headNone = "the head's run holds no stop list";
    // both trees run: each stop by its place, on the tree that has it; a side without a list named, never equal
    const beside = run(base, head);
    assert.equal(beside.status, 1, beside.stderr);
    assert.deepEqual(stopsBy(beside.kept), {
      moved: {
        added: [],
        removed: [],
        moved: [{ label: "r", path: "x", base: [1, 2], head: [2, 2] }],
      },
      added: {
        added: [{ label: "q", path: "y", base: null, head: [1, 3] }],
        removed: [],
        moved: [],
      },
      removed: {
        added: [],
        removed: [{ label: "q", path: "y", base: [1, 3], head: null }],
        moved: [],
      },
      fields: { listsEqual: true },
      restarted: {
        added: [],
        removed: [{ label: "p", path: "z", base: [1, 1], head: null }],
        moved: [],
      },
      "head without": { unavailable: headNone },
      "base without": { unavailable: baseNone },
      "head unparsed": { unavailable: headNone },
    });
    const apart = "difference: stops natural apart;";
    assert.deepEqual(readBack(beside.kept), {
      moved: `${apart} stops added 0; removed 0; moved 1: r:x (base pass 1 ordinal 2, head pass 2 ordinal 2)`,
      added: `${apart} stops added 1: q:y (base none, head pass 1 ordinal 3); removed 0; moved 0`,
      removed: `${apart} stops added 0; removed 1: q:y (base pass 1 ordinal 3, head none); moved 0`,
      fields: `${apart} its stop lists equal, the stop set's other fields apart`,
      restarted: `${apart} stops added 0; removed 1: p:z (base pass 1 ordinal 1, head none); moved 0`,
      "head without": `${apart} which stops: unavailable (${headNone})`,
      "base without": `${apart} which stops: unavailable (${baseNone})`,
      "head unparsed": `${apart} which stops: unavailable (${headNone})`,
    });

    // stored: no stops in any stored run (the writer checks each line as every reader does, and the head's run below
    // reads it through `storedRuns`)
    const root = join(directory, "baselines");
    const stored = spawnSync(
      process.execPath,
      [runner, area, base, "--store", root, "--shard", "0/1"],
      { encoding: "utf8" },
    );
    assert.equal(stored.status, 0, stored.stderr);
    const [src] = readdirSync(root);
    const lines = readFileSync(join(root, src!, "area", "0of1.runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line): { runs?: Record<string, { value: Record<string, unknown> }> } =>
        JSON.parse(line),
      );
    const values = lines.flatMap(({ runs }) => Object.values(runs ?? {}).map(({ value }) => value));
    assert.equal(values.length, names.length * 4 * 3);
    assert.ok(values.every((value) => !Object.hasOwn(value, "stops")));
    // the head against the store: a difference whose stops say the base holds no list, and the head too where it holds
    // none, never equal
    const against = run(head, "--baseline", join(root, src!, "area"));
    assert.equal(against.status, 1, against.stderr);
    const why = (name: string) =>
      name.startsWith("head ") ? `${baseNone}; ${headNone}` : baseNone;
    assert.deepEqual(
      stopsBy(against.kept),
      Object.fromEntries(names.map((name) => [name, { unavailable: why(name) }])),
    );
    assert.deepEqual(
      readBack(against.kept),
      Object.fromEntries(
        names.map((name) => [name, `${apart} which stops: unavailable (${why(name)})`]),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
