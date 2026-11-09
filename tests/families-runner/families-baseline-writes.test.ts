import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { runner, baselines, sha256, storable, CRASH } from "../helpers/families-runner/families-runner-stand-ins.js";

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
    "tests/families/run-contract.mjs",
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
    // (the heap probe thrice: with a source's heap, with NODE_OPTIONS alone, and without it, #1956)
    [
      "the gate's lock holder",
      "a checkout's HEAD read",
      "the heap probe",
      "the heap probe",
      "the heap probe",
      "the runner's own child",
    ],
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
      "tests/families/run-contract.mjs",
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
import { execSync, fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  fs.writeSync(3, "x");
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
  fork("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  fork("bash", ["-c", 'exec 9< "$0" && flock 9 && echo held && exec cat > /dev/null', root], { stdio: "ignore" });
  fork(process.execPath, ["-p", "Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 2 ** 20)"], {
    encoding: "utf8",
  });
  spawn(fileURLToPath(import.meta.url), ["--child"], { stdio: "ignore" });
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
          // (#1647: a write to a descriptor other than standard error's)
          "writeSync",
          "readFileSync",
          "rmSync",
          "rmSync",
          "rmdirSync",
          "eval",
          "spawn",
          "spawn",
          // (each allowed form's arguments with another function: `fork` runs a module named git or bash, or the Node
          // binary as one; the runner's own module by `spawn`, not `fork`)
          "fork",
          "fork",
          "fork",
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
      () => state.beginShard(raw, "area", 0),
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
    // (#1647, Codex r4) a writer stores by its area as the gate rereads it: an issued area cannot be changed, an object
    // made otherwise (other places, another multiple) only names the area, whose stored shard still counts and is
    // skipped, and one of another PLAN is refused
    assert.throws(() => {
      plannedAgain.area.places[0] = sha256("");
    }, TypeError);
    for (const forged of [
      { ...plannedAgain.area, places: [sha256("")] },
      { ...plannedAgain.area, units: 8 },
    ])
      assert.equal((await state.beginShard(joined.baseline, forged, 0)).skipped, "stored");
    const otherPlan = { ...plannedAgain.area, text: `${planText}x\n` };
    assert.match(
      (await state.beginShard(joined.baseline, otherPlan, 0)).refused,
      /is not the area this writer planned/,
    );
    rmSync(join(held, "area", "0of1.runs.jsonl"));
    const begun = await state.beginShard(joined.baseline, plannedAgain.area, 0);
    assert.notEqual(begun.claim, undefined);
    await state.endShard(begun.claim, [], {});
    await assert.rejects(
      async () => state.endShard(begun.claim, [], {}),
      /is no claim this tool gave/,
    );
    renameSync(held, `${held}-moved`);
    cpSync(`${held}-moved`, held, { recursive: true });
    assert.match((await state.planned(joined.baseline, "area", planText)).refused, /was replaced/);
    // (and an area issued before its baseline was replaced, given with a new handle on the replacement: the writer
    // stores by the replacement's area as the gate reads it, and says what its readers say, Codex r4)
    const rejoined = await state.owned(
      state.outside(fourth, [], fail),
      state.identityOf(keeper),
      null,
    );
    const again = await state.beginShard(rejoined.baseline, plannedAgain.area, 0);
    const published = await state.endShard(again.claim, [], {});
    assert.equal(published.verified, state.storedRuns(join(held, "area")).lines !== undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
