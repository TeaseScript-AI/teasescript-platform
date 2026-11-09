import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  areasOf,
  declarations,
  report,
  routeOnly,
  setAside,
  setDifference,
  submissions,
  verdict,
} from "./compiler-replay.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tool = fileURLToPath(new URL("./compiler-replay.mjs", import.meta.url));

test("submit queues the set and every area in 16 shards, the fixture by its folder, copies at 6,144 MB", () => {
  const areas = areasOf(ROOT);
  assert.ok(areas.some((a) => a.name === "fixture" && a.folder === "tools/corpus/fixture"));
  assert.ok(areas.some((a) => a.name === "copies" && a.folder === "tests/families/copies"));
  const [set, ...rest] = submissions("b".repeat(40), "h".repeat(40), { owner: "o", prefix: "p" });
  assert.equal(set[set.indexOf("--campaign") + 1], "p-set");
  assert.match(
    set.at(-1),
    /plans\.mjs" "\$SX_TREE_base" "\$SX_TREE_head" corpus --shard \{i\}\/\{n\}/u,
  );
  assert.equal(rest.length, areas.length);
  for (const args of [set, ...rest]) assert.equal(args[args.indexOf("--shards") + 1], "16");
  const command = (name) => rest.find((args) => args[1] === `${name}-{i}of{n}`);
  assert.match(
    command("fixture").at(-1),
    /run\.mjs "\$SX_TREE_head\/tools\/corpus\/fixture" "\$SX_TREE_base"/u,
  );
  assert.match(command("copies").at(-1), / --memory 6144 /u);
  assert.equal(command("copies")[command("copies").indexOf("--mem") + 1], "8G");
  assert.doesNotMatch(command("joins").at(-1), /--memory/u);
  // (against the base's stored runs: the baseline's heap, the head tree alone)
  const stored = submissions("b".repeat(40), "h".repeat(40), {
    owner: "o",
    prefix: "p",
    baseline: true,
    baseSrc: "s",
  });
  const copies = stored.find((args) => args[1] === "copies-{i}of{n}");
  assert.equal(copies[copies.indexOf("--needs-baseline") + 1], "b".repeat(40));
  assert.match(copies.at(-1), /"\$SX_TREE_head" --baseline "\$HOME\/work\/baselines\/s\/copies"/u);
  assert.doesNotMatch(copies.at(-1), /--memory|SX_TREE_base/u);
});

test("submit hands each submission to the queue and prints the ids it returns", () => {
  const bin = mkdtempSync(join(tmpdir(), "compiler-replay-bin-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(
    join(bin, "sx-job"),
    `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "${log}" "$@"\necho 11111111111111\n`,
  );
  chmodSync(join(bin, "sx-job"), 0o755);
  try {
    const run = spawnSync(
      process.execPath,
      [tool, "submit", "b".repeat(40), "h".repeat(40), "--owner", "o", "--campaign", "p"],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    assert.equal(run.status, 0, run.stderr);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1 + areasOf(ROOT).length);
    assert.ok(calls.every((args) => args[0] === "submit"));
    assert.equal(
      run.stdout.split("\n").filter((line) => line === "11111111111111").length,
      calls.length,
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

/** A results folder of `prefix`'s campaigns: one area's and the set's 16 shards, each as `shard(i)` makes it. */
function results(prefix, shard) {
  const root = mkdtempSync(join(tmpdir(), "compiler-replay-results-"));
  const write = (file, rows) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  };
  for (let i = 0; i < 16; i += 1) {
    const { area = {}, set = {} } = shard(i);
    const job = (campaign, name) => {
      const folder = join(root, `${prefix}-${campaign}`, `${campaign}${i}`);
      write(join(folder, "meta.json"), [{ name }]);
      return join(folder, "out");
    };
    const a = job("areas", `rings-${i}of16`);
    if (area.ran !== false)
      write(join(a, "rings.log"), [
        { area: "rings", sources: 2, runs: 8, differences: area.differences?.length ?? 0 },
      ]);
    write(join(a, "rings.differences.jsonl"), area.differences ?? []);
    const s = job("set", `set-${i}of16`);
    if (set.ran !== false)
      write(join(s, "plans.log"), [
        { set: "corpus", sources: 1, runs: 4, stalled: 0, uncharged: 0 },
      ]);
    write(join(s, "plans.jsonl"), set.records ?? []);
  }
  return root;
}

const same = { plan: "p", diagnostics: "d", error: null, trace: "t", questions: "q", units: 1 };
const mode = (index, head = same) => ({ mode: index, base: same, head, same: head === same });

test("collect: every shard ran and nothing differs is equal; a shard with no summary is not run, never equal", () => {
  const equal = results("p", () => ({}));
  const missing = results("p", (i) => (i === 5 ? { area: { ran: false } } : {}));
  try {
    assert.deepEqual(verdict(report("p", equal)), { status: 0, reasons: [] });
    const { status, reasons } = verdict(report("p", missing));
    assert.equal(status, 3);
    assert.deepEqual(reasons, ["not run: rings-5of16"]);
  } finally {
    rmSync(equal, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("collect: a route-only difference stands until aside agrees; an earlier part and a stall row are not route text", () => {
  const route = {
    generator: "g",
    source: "s",
    mode: "rev-on",
    check: "publication",
    part: 3,
    parts: [4, 4],
  };
  const earlier = { ...route, source: "t", part: 1 };
  const stall = { generator: "g", source: "u", stalled: "SIGKILL", at: { mode: "src-on" } };
  assert.ok(routeOnly(route) && !routeOnly(earlier) && !routeOnly({ ...route, parts: [4, 5] }));
  const root = results("p", (i) =>
    i === 0 ? { area: { differences: [route, earlier, stall] } } : {},
  );
  try {
    const r = report("p", root);
    assert.deepEqual(
      r.differences.map((d) => [d.source, d.routeOnly]),
      [
        ["s", true],
        ["t", false],
      ],
    );
    assert.equal(verdict(r).status, 1);
    const agreed = {
      ...r,
      aside: [
        { source: "s", mode: "rev-on", planEqual: true, asideEqual: true },
        { source: "t", mode: "rev-on", planEqual: true, asideEqual: true },
      ],
    };
    // (route text set aside agrees; a difference before the route is never set aside)
    assert.deepEqual(verdict(agreed).reasons, ["rings g t rev-on: part 1 of 4/4"]);
    assert.equal(
      verdict({ ...agreed, differences: r.differences.filter((d) => d.routeOnly) }).status,
      0,
    );
    const apart = {
      ...agreed,
      differences: r.differences.filter((d) => d.routeOnly),
      aside: [{ ...agreed.aside[0], asideEqual: false }],
    };
    assert.equal(verdict(apart).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect: a set mode differing in its diagnostics alone stands until aside agrees; a plan or work apart never does", () => {
  assert.equal(setDifference(mode(0)), null);
  assert.equal(setDifference(mode(1, { ...same, diagnostics: "e" })), "diagnostics only");
  assert.equal(
    setDifference(mode(1, { ...same, diagnostics: "e", trace: "u" })),
    "diagnostics and work",
  );
  assert.equal(setDifference(mode(1, { ...same, plan: "x" })), "plan");
  assert.equal(setDifference(mode(1, { ...same, trace: "u" })), "work");
  const records = [
    { set: "corpus", name: "n", modes: [mode(0), mode(1, { ...same, diagnostics: "e" })] },
  ];
  const root = results("p", (i) => (i === 0 ? { set: { records } } : {}));
  try {
    const r = report("p", root);
    assert.deepEqual(r.set.differences, [{ name: "n", mode: 1, what: "diagnostics only" }]);
    assert.equal(verdict(r).status, 1);
    // (the set's mode 1 is the reversed shared one, `HELD_MODES`' order)
    assert.equal(
      verdict({ ...r, aside: [{ source: "n", mode: "rev-on", planEqual: true, asideEqual: true }] })
        .status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aside: a declared pattern sets aside its own text only, and a declaration without a reason is refused", () => {
  const declared = declarations(
    JSON.stringify([{ pattern: " \\d+ checks? runs? while it plays instead\\.", reason: "#2081" }]),
  );
  const [base, head] = [
    "Too large. 60 checks run while it plays instead. Most",
    "Too large. 1 check runs while it plays instead. Most",
  ];
  assert.equal(setAside(base, declared), setAside(head, declared));
  assert.notEqual(setAside(`${base} x`, declared), setAside(`${head} y`, declared));
  for (const text of ["[]", '[{"pattern": "a"}]', '[{"pattern": "a", "reason": " "}]', "{}"])
    assert.throws(() => declarations(text), /declaration/u, text);
  const file = join(mkdtempSync(join(tmpdir(), "compiler-replay-declare-")), "declare.json");
  writeFileSync(file, '[{"pattern": "a"}]');
  const run = spawnSync(
    process.execPath,
    [tool, "aside", "p", "b", "h", "--owner", "o", "--declare", file],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /each declaration has a `pattern` and a `reason`/u);
  rmSync(dirname(file), { recursive: true, force: true });
});

test("a step the tool does not have, or one missing its arguments, is a usage error", () => {
  for (const args of [[], ["replay"], ["submit", "b"], ["collect", "p"]]) {
    const run = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    assert.equal(run.status, 2, args.join(" "));
  }
});
