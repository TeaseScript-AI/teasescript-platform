import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { runner, stalls, LEDGER } from "./helpers/families-runner-stand-ins.js";

/**
 * A built tree's library whose analyses charge its ledger (allowance 30,000,000, so the runner's limit is 120,000,000
 * units a run) 3,000 units a run: `throws` throws on both trees, `ends` ends the process there, as each `once…` does
 * where `FIXTURE_ENDS` is set; `busy` waits 200 ms on the base; `lagging` waits 3 s on the head's first run; `slow`
 * charges a billion units more on the head at once and waits 150 ms there; `burst` charges 10,000 times 65,536 units on
 * the head, then waits; `changed` publishes its second part otherwise on the head. Its stop sets differ on the head at
 * demand allowance 1 and charge a billion units there at 2. Where `FIXTURE_TRACE` names a file, the head appends a
 * source's name to it in the source's first mode: once each time the source runs.
 */
const charging = (head: boolean): string => `import { appendFileSync } from "node:fs";
import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function publicationHashes(files, mode) {
  const source = files[0].source;
  const ledger = new WorkLedger();
  for (let unit = 0; unit < 1000; unit += 1) ledger.charge("frames", 3);
  if (source === "throws") throw new Error("independent exception witness");
  if (source === "ends" || (source.startsWith("once") && process.env.FIXTURE_ENDS)) process.exit(3);
  if (${head} && mode === MODES[0] && process.env.FIXTURE_TRACE)
    appendFileSync(process.env.FIXTURE_TRACE, source + "\\n");
  if (!${head} && source === "busy") wait(200);
  if (${head} && source === "lagging" && mode === MODES[0]) wait(3000);
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
  if (${head} && allowance === 2) new WorkLedger().charge("frames", 1e9);
  return { stops: [] };
}
`;

test("the corpus runner records each source's units, allowance and time, a cut run's to the stall, and a rerun of the stall index on both trees, whole or in shards that rerun it once, closes a stall that ends but never a stall over the unit limit, a candidate or a difference (#1564, #1598, #1647)", () => {
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
    const withEnv = (env: Record<string, string>, tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
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

    // charges far faster than the runner reads them, then a wait past the safety net: the run stalls at the charge that
    // passes the unit limit, 3,000 + 1,832 × 65,536 units, and the record holds it exactly, as the child wrote it over
    // there (#1564 r1's saturation witness, #1647)
    const burst = join(directory, "burst.work.jsonl");
    run(runner, area("burst", ["burst"]), base, head, "--timeout", "1.5", "--work", burst);
    const [, flooding] = lines(readFileSync(burst, "utf8"));
    const flooded = flooding.runs.at(-1);
    assert.deepEqual(
      [flooding.stalled, flooded.work, flooded.allowance, flooded.running],
      ["units", [3000, 3000 + 1832 * 65_536], [30_000_000, 30_000_000], 1],
    );

    // a replay at a two-second safety net: `slow` stalls in the head's first run over the unit limit, before its wait;
    // `busy` ends, its base's runs each within the safety net; `lagging` (3 s) reaches it in the head's first run,
    // uncharged work and no stall (#1842: a margin of seconds either way, which a loaded worker keeps, where a half-second
    // net and a 600 ms wait left 100-300 ms); each source's record holds each run's units, allowance and milliseconds on each tree, a cut
    // run's those it had when the runner ended it
    const replay = area("replay", ["fast", "slow", "busy", "lagging"]);
    const work = join(directory, "replay.work.jsonl");
    const ran = run(runner, replay, base, head, "--timeout", "2", "--work", work);
    assert.equal(ran.status, 1, ran.stderr);
    const [header, fast, slow, busy, lagging, total] = lines(readFileSync(work, "utf8"));
    assert.deepEqual(
      [
        header.work.area,
        header.work.shard,
        header.work.roots,
        header.work.configuration.allowances,
        header.work.configuration.units,
      ],
      [replay, "0/1", [base, head], [null, 16, 256], 4],
    );
    assert.deepEqual(total.total, JSON.parse(ran.stdout.trim().split("\n").at(-1)!));
    assert.deepEqual(
      fast.runs.map(({ mode, work: units }: { mode: string; work: number[] }) => [mode, ...units]),
      MODES.map((mode) => [mode, 3000, 3000]),
    );
    assert.deepEqual([fast.counts, fast.stalled], [{ runs: 4 }, undefined]);
    assert.deepEqual(
      [slow.stalled, busy.stalled, lagging.stalled, lagging.uncharged],
      ["units", undefined, undefined, { head: "src-on publication" }],
    );
    const cut = slow.runs.at(-1);
    assert.deepEqual([cut.work, cut.running], [[3000, 1e9 + 3000], 1]);
    assert.deepEqual([busy.counts, busy.runs.at(-1).running], [{ runs: 4 }, undefined]);
    assert.deepEqual([lagging.counts, lagging.runs.at(-1).running], [{ uncharged: 1 }, 1]);

    // the index: `slow` a candidate (the head alone over the unit limit, on a run the base ended within it), `lagging`
    // named as uncharged work; neither agreement
    const index = join(directory, "index.json");
    const indexed = run(stalls, work, "--index", index);
    assert.equal(indexed.status, 1, indexed.stderr);
    const printed = lines(indexed.stdout);
    assert.match(printed[0].rule, /^A run stalls where its charged units pass the unit limit/);
    assert.deepEqual(
      printed.slice(1, 3).map(({ source, verdict, uncharged }) => [source, verdict ?? uncharged]),
      [
        ["slow", "candidate"],
        ["lagging", { head: "src-on publication" }],
      ],
    );
    const counted = (row: Record<string, unknown>) =>
      [
        "sources",
        "agreed",
        "unavailable",
        "uncharged",
        "candidate",
        "inherited",
        "unknown",
        "rerun",
        "closed",
      ].map((key) => row[key]);
    assert.deepEqual(counted(printed[4]), [4, 2, 1, 1, 1, 0, 0, 0, false]);
    assert.deepEqual(
      JSON.parse(readFileSync(index, "utf8")).entries.map(
        ({ source }: { source: string }) => source,
      ),
      ["slow"],
    );

    // an index naming a source its area does not hold is refused before any runs
    mkdirSync(join(directory, "elsewhere"));
    const fewer = area(join("elsewhere", "replay"), ["fast"]);
    assert.match(run(runner, fewer, base, head, "--only", index).stderr, /does not hold/);

    // the rerun: each source alone, both trees in one process; `slow` stalls again, at the same units, as it does on
    // every machine, so the replay stays open
    const again = join(directory, "again");
    const rerun = run(stalls, "rerun", index, base, head, again, "--timeout", "5");
    assert.equal(rerun.status, 1, rerun.stderr);
    const merged = run(stalls, work, "--rerun", join(again, "replay.work.jsonl"));
    assert.equal(merged.status, 1, merged.stderr);
    const after = lines(merged.stdout);
    assert.deepEqual(
      after
        .slice(1, 2)
        .map(({ source, rerun: { outcome, verdict } }) => [source, outcome, verdict]),
      [["slow", "stalled", "candidate"]],
    );
    assert.deepEqual(counted(after.at(-1)), [4, 2, 1, 1, 1, 0, 0, 1, false]);

    // `rerun --shard i/N` (#1598): an index over two areas, one of them replayed at two paths in two shards (a replay
    // sharded across workers), its entry k rerun by shard k mod N alone, one runner per area whatever paths its entries
    // name, each shard's records beside its part of the index and none for an area that part does not hold; the
    // shards' records merge as the whole rerun's do
    const replayed = (folder: string, shard: string, name: string) => {
      const file = join(directory, `${name}.work.jsonl`);
      withEnv({ FIXTURE_ENDS: "1" }, runner, folder, base, head, "--shard", shard, "--work", file);
      return file;
    };
    const aliased = (at: number) => {
      mkdirSync(join(directory, `alias-${at}`));
      return area(join(`alias-${at}`, "sharded"), ["once-a", "once-b", "once-c"]);
    };
    const partedWork = [
      replayed(aliased(0), "0/2", "alias-0"),
      replayed(aliased(1), "1/2", "alias-1"),
      replayed(area("beside", ["once-d"]), "0/1", "beside"),
    ];
    const partedIndex = join(directory, "parted.json");
    assert.equal(run(stalls, ...partedWork, "--index", partedIndex).status, 1);
    const { entries } = JSON.parse(readFileSync(partedIndex, "utf8"));
    const named = entries.map(({ area: of, source }: { area: string; source: string }) => [
      basename(of),
      source,
    ]);
    assert.deepEqual(named, [
      ["sharded", "once-a"],
      ["sharded", "once-c"],
      ["sharded", "once-b"],
      ["beside", "once-d"],
    ]);
    assert.equal(new Set(entries.map(({ area: of }: { area: string }) => of)).size, 3);
    // each entry runs once, counted as it runs: an entry run twice, by two shards or by two runners of one area, is
    // caught here, not by the files left (a second runner of an area replaces the first's) nor by the merged summary,
    // which takes two ended records that say the same as one source by design (#1587)
    const traced = (folder: string, ...shard: string[]) => {
      const trace = `${folder}.trace`;
      const ran = withEnv(
        { FIXTURE_TRACE: trace },
        stalls,
        "rerun",
        partedIndex,
        base,
        head,
        folder,
        ...shard,
      );
      assert.equal(ran.status, 0, ran.stderr);
      return readFileSync(trace, "utf8").trim().split("\n").sort();
    };
    const whole = join(directory, "whole");
    assert.deepEqual(traced(whole), ["once-a", "once-b", "once-c", "once-d"]);
    const parts = [0, 1].map((shard) => join(directory, `part-${shard}`));
    parts.forEach((folder, shard) =>
      assert.deepEqual(
        traced(folder, "--shard", `${shard}/2`),
        named
          .filter((_: unknown, entry: number) => entry % 2 === shard)
          .map(([, source]: string[]) => source)
          .sort(),
      ),
    );
    assert.deepEqual(
      parts.map((folder) => readdirSync(folder).sort()),
      [
        ["index.0of2.json", "sharded.0of2.jsonl", "sharded.0of2.work.jsonl"],
        [
          "beside.1of2.jsonl",
          "beside.1of2.work.jsonl",
          "index.1of2.json",
          "sharded.1of2.jsonl",
          "sharded.1of2.work.jsonl",
        ],
      ],
    );
    const records = (folder: string) =>
      readdirSync(folder)
        .filter((file) => file.endsWith(".work.jsonl"))
        .map((file) => join(folder, file));
    const judged = (files: string[]) => {
      const { status, stdout, stderr } = run(stalls, ...partedWork, "--rerun", ...files);
      return { status, stdout, stderr };
    };
    const unsharded = judged(records(whole));
    assert.deepEqual(
      [unsharded.status, lines(unsharded.stdout).at(-1).rerun],
      [0, 4],
      unsharded.stderr,
    );
    assert.deepEqual(judged(parts.flatMap(records)), unsharded);
    // a shard that is none of 0/N to N-1/N is refused before any folder is made
    const refused = join(directory, "refused");
    for (const sharding of ["0/0", "2/2", "1.5/2", "/2"]) {
      const refusal = run(stalls, "rerun", partedIndex, base, head, refused, "--shard", sharding);
      assert.equal(refusal.status, 2, sharding);
      assert.match(refusal.stderr, /is no shard i\/N with 0 <= i < N/);
    }
    assert.equal(existsSync(refused), false);
    // `rerun --items` (#1612, the owner's job-size rule): an item pool's batches, each naming entries by number (one in
    // a file given, one in the file `$SX_ITEMS` names, as the central queue sets it, #1644), rerun the index once, each
    // batch's records beside its part of the index, named by its hash, and merge as the whole rerun's do; an entry named
    // twice, one out of range, a missing items file, or `--shard` beside it refused
    const batches = [join(directory, "items-0"), join(directory, "items-1")];
    const itemFile = join(directory, "items-0.txt");
    writeFileSync(itemFile, "2\n0\n");
    assert.deepEqual(traced(batches[0]!, "--items", itemFile), ["once-a", "once-b"]);
    const envFile = join(directory, "items-1.txt");
    writeFileSync(envFile, "1\n3\n");
    const fromEnv = withEnv(
      { SX_ITEMS: envFile },
      stalls,
      "rerun",
      partedIndex,
      base,
      head,
      batches[1]!,
      "--items-from-env",
    );
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.deepEqual(
      batches.map(
        (folder) => readdirSync(folder).filter((file) => file.startsWith("index.items-")).length,
      ),
      [1, 1],
    );
    assert.deepEqual(judged(batches.flatMap(records)), unsharded);
    for (const [items, why] of [
      ["0\n0\n", /names an entry twice/],
      ["4\n", /names no entry of .* \(4 entries\): 4/],
      ["a\n", /names no entry of/],
    ] as const) {
      writeFileSync(itemFile, items);
      const refusal = run(stalls, "rerun", partedIndex, base, head, refused, "--items", itemFile);
      assert.equal(refusal.status, 2, items);
      assert.match(refusal.stderr, why);
    }
    const missing = join(directory, "no-items.txt");
    const unread = withEnv(
      { SX_ITEMS: missing },
      stalls,
      "rerun",
      partedIndex,
      base,
      head,
      refused,
      "--items-from-env",
    );
    assert.equal(unread.status, 2, unread.stderr);
    assert.ok(unread.stderr.includes(`the items file ${missing}: ENOENT`), unread.stderr);
    const shardAndItems = run(
      stalls,
      "rerun",
      partedIndex,
      base,
      head,
      refused,
      "--items",
      itemFile,
      "--shard",
      "0/2",
    );
    assert.match(shardAndItems.stderr, /--shard and --items each choose the entries/);
    assert.equal(existsSync(refused), false);

    // a replay of other stop allowances (#1564 r1's false-closure witness): its index keeps them, so its rerun runs
    // them again, keeps the difference at allowance 1 and stalls again at 2; a rerun record of other allowances is not
    // merged. The stall at 2 is by units (the head's `stopSet` charges 1e9 there), the same on every machine; the wall
    // clock is only the safety net, wide enough that no loaded worker reaches it (#1842: at 0.5 s and 1 s one did)
    const checks = area("checks", ["checked"], ["publication", "stops"]);
    const checked = join(directory, "checks.work.jsonl");
    run(runner, checks, base, head, "--allowances", "1,2", "--timeout", "30", "--work", checked);
    const checkIndex = join(directory, "checks-index.json");
    assert.equal(run(stalls, checked, "--index", checkIndex).status, 1);
    assert.match(
      run(stalls, "rerun", checkIndex, base, head, join(directory, "x"), "--allowances", "1")
        .stderr,
      /drop --allowances/,
    );
    const rechecked = join(directory, "rechecked");
    assert.equal(
      run(stalls, "rerun", checkIndex, base, head, rechecked, "--timeout", "30").status,
      1,
    );
    const reran = run(stalls, checked, "--rerun", join(rechecked, "checks.work.jsonl"));
    assert.equal(reran.status, 1, reran.stderr);
    assert.deepEqual(
      [lines(reran.stdout).at(-1).differences, lines(reran.stdout).at(-1).unavailable],
      [1, 1],
    );
    const defaults = join(directory, "defaults.work.jsonl");
    run(runner, checks, base, head, "--only", checkIndex, "--timeout", "30", "--work", defaults);
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
     * its sources' counts, cut before its total where `cut`; `unansweredAlike` only where a source counts one, as a runner
     * before #1592 wrote the others.
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
        ...(sum("unansweredAlike") > 0 ? { unansweredAlike: sum("unansweredAlike") } : {}),
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
      `${JSON.stringify({ generator: "s8-stores.mjs", source: "x", stalled: { head: "timeout" }, files, globals: [] })}\n` +
        // (#1647, Codex r2: a source at the safety net, which the `--out` file names too)
        `${JSON.stringify({ generator: "s8-stores.mjs", source: "y", uncharged: { head: "src-on publication" }, files, globals: [] })}\n`,
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
    // (the source at the safety net named as a defect and counted so, never agreement)
    assert.deepEqual(
      printed
        .filter(({ defect }) => defect !== undefined)
        .map(({ source, uncharged }) => [source, uncharged]),
      [["y", { head: "src-on publication" }]],
    );
    assert.equal(
      printed.find(({ area, complete }) => area === "property" && complete !== undefined).uncharged,
      1,
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
    // (a rerun that ends with a run left unanswered alike, #1592: that outcome, counted and named apart, and listed in
    // the index apart from the sources still unavailable)
    const alikeIndex = join(directory, "late-alike.index.json");
    const lateAlike = late("late-alike", true, { runs: 1, unansweredAlike: 1 });
    const ended = run(lateReplay, "--rerun", lateStall, lateAlike, "--index", alikeIndex);
    assert.equal(ended.status, 0, ended.stderr);
    const endedLines = lines(ended.stdout);
    const named = { generator: "g.mjs", source: "slow", unansweredAlike: 1 };
    assert.deepEqual(
      [
        endedLines.find(({ stalled }) => stalled !== undefined).rerun.outcome,
        ...["agreed", "unansweredAlike", "closed"].map((key) => endedLines.at(-1)[key]),
      ],
      ["unansweredAlike", 0, 1, true],
    );
    assert.deepEqual(
      endedLines.filter(({ source, stalled }) => source !== undefined && stalled === undefined),
      [{ area: "late", ...named }],
    );
    const indexed = JSON.parse(readFileSync(alikeIndex, "utf8"));
    assert.deepEqual(
      [indexed.entries, indexed.unansweredAlike],
      [[], [{ area: "late", ...named, key: "k" }]],
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
    // (and its sources' runs unanswered alike against a total that counts none, #1592)
    const unevenAlike = shard("uneven-alike", 2, [
      { source: "a", runs: [], counts: { runs: 4, unansweredAlike: 4 } },
    ]);
    writeFileSync(
      unevenAlike,
      readFileSync(unevenAlike, "utf8").replace(
        /"unansweredAlike":4\}\}\n$/,
        '"unansweredAlike":0}}\n',
      ),
    );
    const refusedAlike = run(unevenAlike);
    assert.equal(refusedAlike.status, 2);
    assert.match(refusedAlike.stderr, /do not add up to its total \(unansweredAlike\)/);
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

/**
 * A built tree's library whose publication of `<shape> <size>` charges its ledger 100 units a size on the base; on the
 * head, `rises` 100 a size at 4 and 110 at 8 and 16, `flat` 100, `stops` 100 but leaving a node unanswered at 8,
 * and `differs` the same with another answer at 8 too.
 */
const growthLibrary = (
  head: boolean,
): string => `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export function publicationHashes(files) {
  const [shape, size] = files[0].source.split(" ");
  const n = Number(size);
  const each = ${head} && shape === "rises" && n > 4 ? 110 : 100;
  new WorkLedger(1000).charge("frames", each * n);
  if (${head} && shape === "differs" && n === 8)
    return { parts: ["b"], unanswered: 1, unansweredBy: { reason: "memory", node: 3 } };
  return ${head} && shape === "stops" && n === 8
    ? { parts: ["a"], unanswered: 1, unansweredBy: { reason: "memory", node: 3 } }
    : { parts: ["a"], unanswered: 0 };
}
`;

test("the stall index prints a growth line per area: a series whose head-over-base units rise 1 % or more a doubling flagged, a series with a stopped run left out as the residual; and a NODE_OPTIONS heap other than --memory is named beside it in the total (#1837's F22, #1956)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, head: boolean, ledger = true) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      // (without a ledger the runner reads: a `charge` of its own, on no prototype)
      writeFileSync(
        join(tree, "dist", "src", "type-inference", "core", "budget.js"),
        ledger
          ? LEDGER
          : "export class WorkLedger {\n  constructor() {\n    this.charge = () => {};\n  }\n}\n",
      );
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        growthLibrary(head),
      );
      return tree;
    };
    const folder = join(directory, "sized");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "g.mjs"),
      'export const sizes = [4, 8, 16];\nexport const shapes = Object.fromEntries(["rises", "flat", "stops", "differs"].map((shape) => [shape, (n) => `${shape} ${n}`]));\n',
    );
    const work = join(directory, "sized.work.jsonl");
    const ran = spawnSync(
      process.execPath,
      [runner, folder, built("base", false), built("head", true), "--work", work],
      // (Node takes the last of two heaps, its options split as Node splits them, the quotes removed)
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: '--max-old-space-size=2048 --max_old_space_size="3000"',
        },
      },
    );
    assert.equal(ran.status, 1, ran.stderr);
    const ended = JSON.parse(ran.stdout.trim().split("\n").at(-1)!);
    // (V8's own heap limit for each NODE_OPTIONS, as Node reads it: the runner reads none of it itself)
    const limitOf = (options: string, ...args: string[]) =>
      Number(
        spawnSync(
          process.execPath,
          [
            ...args,
            "-p",
            "Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 2 ** 20)",
          ],
          { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: options } },
        ).stdout.trim(),
      );
    const two = '--max-old-space-size=2048 --max_old_space_size="3000"';
    assert.deepEqual([ended.memory, ended.nodeOptions], [2048, { heapLimit: limitOf(two) }]);
    assert.ok(limitOf(two) > limitOf(two, "--max-old-space-size=2048"));
    // (each form Node takes: a quoted value, a signed one, one after quoted spaces, a quoted option; a tab is no
    // separator, so the heap after it is part of the title and the limit is 2,048's: none named)
    for (const [options, named] of [
      ["--max-old-space-size=2048 --max-old-space-size=+3000", true],
      ['--max-old-space-size=2048 --max-old-space-size=" 3000"', true],
      ['--max-old-space-size=2048 "--max-old-space-size=3000"', true],
      ["--max-old-space-size=2048 --title=x\t--max-old-space-size=3000", false],
      // (quotes inside the option's name, which Node drops, and a title that names the option but sets no heap)
      ['--max-old-""space-size=3000', true],
      ["--title=old-space-size", false],
      ["--max-old-space-size=2048", false],
    ] as const) {
      const said = spawnSync(
        process.execPath,
        [runner, folder, built("b1", false), built("h1", true)],
        { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: options } },
      );
      const total = JSON.parse(said.stdout.trim().split("\n").at(-1)!);
      assert.deepEqual(
        total.nodeOptions,
        named ? { heapLimit: limitOf(options) } : undefined,
        options,
      );
    }
    // (the work record's last line the same total, and nothing of it on stderr, whose lines are JSON records)
    assert.deepEqual(
      JSON.parse(readFileSync(work, "utf8").trim().split("\n").at(-1)!).total,
      ended,
    );
    assert.doesNotMatch(ran.stderr, /NODE_OPTIONS|nodeOptions/);
    const judged = spawnSync(process.execPath, [stalls, work], { encoding: "utf8" });
    const growth = judged.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.growth !== undefined);
    // (four modes: `rises` and `flat` measured in each, `rises` flagged at its 10 % step; `stops` and `differs` the
    // residual)
    assert.deepEqual([growth.measured, growth.flagged], [8, 4]);
    assert.deepEqual(
      growth.worst[0].ratios.map((ratio: number) => Math.round(ratio * 100) / 100),
      [1, 1.1, 1.1],
    );
    assert.match(growth.worst[0].series, /^g\.mjs rises /);
    // (`differs` answered otherwise at 8 as well as leaving a node there: a difference, and its series in the residual)
    const named = (shape: string) =>
      ["rev-off", "rev-on", "src-off", "src-on"].map(
        (mode) => `g.mjs ${shape} ${mode} publication`,
      );
    assert.deepEqual(growth.residual, {
      series: 8,
      named: [...named("differs"), ...named("stops")],
    });
    assert.deepEqual(growth.unmeasured, { series: 0, named: [] });
    const total = judged.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.deepEqual([total.differences, total.unanswered], [4, 4]);
    // (a base without a work ledger: no series measured, each named as unmeasured)
    const bare = join(directory, "bare.work.jsonl");
    spawnSync(
      process.execPath,
      [runner, folder, built("bare", false, false), built("head2", true), "--work", bare],
      { encoding: "utf8" },
    );
    const unmeasured = spawnSync(process.execPath, [stalls, bare], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.growth !== undefined);
    assert.deepEqual([unmeasured.measured, unmeasured.unmeasured.series], [0, 16]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
