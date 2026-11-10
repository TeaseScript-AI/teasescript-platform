import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  FILLABLE,
  LEDGER,
  runner,
  sha256,
  stalls,
} from "../helpers/families-runner/families-runner-stand-ins.js";

type Area = { rest: { count: number; ms: number }; sources: Record<string, number> };
type Split = {
  binsOf: (places: string[], area: Area, n: number) => Map<string, number>;
  countOf: (area: Area, target: number, trees: number) => { count: number; seconds: number[] };
  costsOf: (files: string[]) => string;
};
const split = async (): Promise<Split> => {
  const module: Split = await import(pathToFileURL(resolve("tests/families/split.mjs")).href);
  return module;
};

/** Each shard's places, by `bins`. */
const shardsOf = (bins: Map<string, number>, n: number) =>
  Array.from({ length: n }, (_, shard) =>
    [...bins].filter(([, bin]) => bin === shard).map(([place]) => place),
  );

test("a split puts every place in one shard, by the places' order and the costs alone, a source over the mean alone (#2272)", async () => {
  const { binsOf, countOf } = await split();
  // (places named against their cost order, so neither order stands in for the other; `dup` repeated)
  const places = ["p", "dup", "k", "z", "a", "dup", "m", "unrecorded"];
  const sources = { a: 1, k: 1, m: 1, p: 1, z: 40, dup: 1 };
  const area = { rest: { count: 3, ms: 1 }, sources };
  const bins = binsOf(places, area, 3);
  assert.deepEqual(
    [...bins.keys()].sort(),
    [...new Set(places)].sort(),
    "every place once, a repeat and an unrecorded one included",
  );
  // (`z`, 40 of 46 ms, alone; the others longest first, ties in the area's order, to the least-loaded, lowest first)
  assert.deepEqual(shardsOf(bins, 3), [["z"], ["p", "k", "m"], ["dup", "a", "unrecorded"]]);
  // the costs file's key order changes nothing; the places' order breaks the ties
  const reordered = { ...area, sources: Object.fromEntries(Object.entries(sources).reverse()) };
  assert.deepEqual(binsOf(places, reordered, 3), bins);
  assert.deepEqual(shardsOf(binsOf([...places].reverse(), area, 3), 3), [
    ["z"],
    ["unrecorded", "dup", "k"],
    ["m", "a", "p"],
  ]);
  // one shard a source at or over the target, the rest at the target; seconds per tree times the trees
  const seconds = { rest: { count: 10, ms: 50_000 }, sources: { big: 2_000_000, mid: 600_000 } };
  assert.deepEqual(countOf(seconds, 900, 1), { count: 3, seconds: [2000, 600, 500] });
  assert.deepEqual(countOf(seconds, 900, 2), { count: 4, seconds: [4000, 1200, 500, 500] });
  assert.equal(countOf({ rest: { count: 0, ms: 0 }, sources: {} }, 900, 2).count, 1);
  // the estimate fills the milliseconds `binsOf` fills, so a tie falls as there (review round 2: in fractional seconds
  // the last source went to the other shard)
  const tied: Area = {
    rest: { count: 0, ms: 0 },
    sources: { s0: 370_956, s1: 251_131, s2: 191_918, s3: 72_093, s4: 72_093 },
  };
  const filled = [0, 0];
  for (const [place, shard] of binsOf(Object.keys(tied.sources), tied, 2))
    filled[shard] = (filled[shard] ?? 0) + (tied.sources[place] ?? 0);
  assert.deepEqual(countOf(tied, 900, 1), { count: 2, seconds: filled.map((ms) => ms / 1000) });
  assert.deepEqual(filled, [515_142, 443_049]);
});

test("a costs file is a function of the records: per tree, the largest of a place's records, the short ones as their mean (#2272)", async () => {
  const { costsOf } = await split();
  const directory = mkdtempSync(join(tmpdir(), "families-split-"));
  try {
    const record = (name: string, area: string, sources: [string, (number | null)[][]][]) => {
      const file = join(directory, name);
      const lines = [
        { work: { area: `/trees/x/tests/families/${area}` } },
        ...sources.map(([source, runs]) => ({
          generator: "g.mjs",
          source,
          key: "k",
          runs: runs.map((ms) => ({ ms })),
        })),
        { total: true },
      ];
      writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      return file;
    };
    // (a stored base's `null` is no tree that ran; two trees count as their mean)
    const one = record("one.work.jsonl", "rings", [
      [
        "slow",
        [
          [null, 1500],
          [null, 700],
        ],
      ],
      ["fast", [[null, 10]]],
      ["quick", [[30, 50]]],
    ]);
    const two = record("two.work.jsonl", "rings", [
      ["slow", [[null, 900]]],
      ["fast", [[null, 2]]],
    ]);
    const other = record("other.work.jsonl", "joins", [["lone", [[5000, 7000]]]]);
    const text = costsOf([one, two, other]);
    assert.equal(costsOf([other, two, one]), text);
    assert.deepEqual(JSON.parse(text), {
      version: 1,
      areas: {
        joins: { rest: { count: 0, ms: 0 }, sources: { '["g.mjs","lone","k"]': 6000 } },
        rings: { rest: { count: 2, ms: 25 }, sources: { '["g.mjs","slow","k"]': 2200 } },
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a replay's split shards run each source of the area once, judge as unsplit, and stalls refuses shards split otherwise (#2272)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-split-"));
  try {
    const built = (name: string) => {
      const folder = join(directory, name);
      mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(folder, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(folder, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(join(folder, "dist", "tests", "helpers", "type-core-oracles.js"), FILLABLE);
      return folder;
    };
    const [base, head] = [built("base"), built("head")];
    const folder = join(directory, "split");
    mkdirSync(folder);
    const names = ["a", "b", "big", "c", "d", "e"];
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(names.map((name) => [name, name]))};\n`,
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, args, { encoding: "utf8", env: process.env });
    const listed = run(resolve("tests/families/items.mjs"), "sources", folder);
    assert.equal(listed.status, 0, listed.stderr);
    const places = listed.stdout.trim().split("\n");
    const costs = (big: number) => {
      const file = join(directory, `costs-${big}.json`);
      const text = `${JSON.stringify({
        version: 1,
        areas: { split: { rest: { count: 5, ms: 1 }, sources: { [places[2]!]: big } } },
      })}\n`;
      writeFileSync(file, text);
      return { file, hash: sha256(text) };
    };
    const [one, other] = [costs(100_000), costs(50_000)];
    const record = (file: string) =>
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const shard = (i: number, n: number, by?: string) => {
      const file = join(directory, `${i}of${n}-${by === undefined ? "index" : "split"}.work.jsonl`);
      const ran = run(
        runner,
        folder,
        base,
        head,
        "--shard",
        `${i}/${n}`,
        ...(by === undefined ? [] : ["--split", by]),
        "--work",
        file,
      );
      assert.equal(ran.status, 0, ran.stderr);
      return file;
    };
    const split = [0, 1, 2].map((i) => shard(i, 3, one.file));
    const held = split.map((file) =>
      record(file)
        .filter((line) => line.generator !== undefined)
        .map((line) => JSON.stringify([line.generator, line.source, line.key])),
    );
    // (each source once among the shards, the costly one alone, and each record naming its costs file)
    assert.deepEqual(held.flat().sort(), [...places].sort());
    assert.deepEqual(held[0], [places[2]]);
    for (const file of split) assert.equal(record(file)[0].work.split, one.hash);
    // (judged as the area run whole)
    const judged = (files: string[]) => {
      const result = run(stalls, ...files);
      assert.equal(result.status, 0, result.stderr);
      const { shards: _, ...total } = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      return total;
    };
    assert.deepEqual(judged(split), judged([shard(0, 1)]));
    // (shards split otherwise than each other may hold a source twice or never: refused, never closed)
    for (const files of [
      [split[0]!, shard(1, 3), shard(2, 3)],
      [shard(0, 3, other.file), split[1]!, split[2]!],
    ]) {
      const mixed = run(stalls, ...files);
      assert.equal(mixed.status, 2, mixed.stdout);
      assert.match(mixed.stderr, /shares out its area otherwise than its other shards/);
    }
    // (a split a replay's shard cannot run is refused before any source runs; a commit's tree to store, a store folder)
    const storable = built("storable");
    mkdirSync(join(storable, "src"));
    writeFileSync(join(storable, ".sha"), `${"0".repeat(40)}\n`);
    mkdirSync(join(directory, "store"));
    const malformed = join(directory, "malformed.json");
    writeFileSync(
      malformed,
      '{"version":1,"areas":{"split":{"rest":{"count":-1,"ms":1},"sources":{}}}}',
    );
    const elsewhere = join(directory, "elsewhere.json");
    writeFileSync(elsewhere, '{"version":1,"areas":{}}');
    const refusals: [string[], RegExp][] = [
      [
        ["--store", join(directory, "store"), "--shard", "0/3", "--split", one.file],
        /drop --store/,
      ],
      [["--split", one.file], /give --shard/],
      [
        ["--shard", "0/3", "--split", one.file, "--only", malformed],
        /drop --store, --items and --only/,
      ],
      [["--shard", "0/3", "--split", malformed], /malformed/],
      [["--shard", "0/3", "--split", elsewhere], /holds no costs of split/],
    ];
    for (const [args, problem] of refusals) {
      const trees = args[0] === "--store" ? [storable] : [base, head];
      const refused = run(runner, folder, ...trees, ...args);
      assert.equal(refused.status, 2, `${args}: ${refused.stdout}`);
      assert.match(refused.stderr, problem);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
