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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import {
  runner,
  baselines,
  stalls,
  contract,
  LEDGER,
  sha256,
  type Stored,
  storedRuns,
  storable,
  SRC,
  writeSrc,
  FILLABLE,
  unitsLibrary,
} from "./helpers/families-runner-stand-ins.js";

/**
 * The plan 2 baseline `dir` (`<folder>/<src tree>`) rewritten as one stored before #1647, a plan 1 one: each PLAN's
 * limits a time a source, its runs without units, a stall a time limit's without its cut run, no run named at the
 * safety net, and its MANIFEST's records and its shards' totals repaired, so that it counts as such a baseline did.
 */
const asPlanOne = (dir: string) => {
  let manifest = readFileSync(join(dir, "MANIFEST"), "utf8");
  for (const area of readdirSync(dir).filter((name) => existsSync(join(dir, name, "PLAN")))) {
    const was = readFileSync(join(dir, area, "PLAN"), "utf8");
    const plan = was
      .replace(/^plan 2$/m, "plan 1")
      .replace(/^limits .*$/m, "limits 180 s, 2048 MB");
    writeFileSync(join(dir, area, "PLAN"), plan);
    manifest = manifest.replace(sha256(was), sha256(plan));
    for (const name of readdirSync(join(dir, area)).filter((one) => one.endsWith(".runs.jsonl"))) {
      const lines = readFileSync(join(dir, area, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const { units: _units, uncharged: _uncharged, ...total } = lines.pop().total;
      const body = lines
        .map(
          ({ cut: _cut, uncharged: _named, runs, ...line }: Stored & Record<string, unknown>) => {
            // (each run's result without its units and allowance)
            const results = Object.entries(runs).map(
              ([run, { work: _work, allowance: _allowance, ...result }]) => [run, result],
            );
            // (its stall a time limit's, as a stall was then)
            const stall = line["stalled"] === undefined ? {} : { stalled: "timeout" };
            return `${JSON.stringify({ ...line, ...stall, runs: Object.fromEntries(results) })}\n`;
          },
        )
        .join("");
      const ended = { total: { ...total, plan: sha256(plan), lines: sha256(body) } };
      writeFileSync(join(dir, area, name), `${body}${JSON.stringify(ended)}\n`);
    }
  }
  writeFileSync(join(dir, "MANIFEST"), manifest);
};

test("a generator's id is its `id` export, else its file name: a renamed generator that keeps its old name as its id keeps its sources' stored lines and its area's plan, its records name its file, and two generators with one id are refused (B2)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "package-lock.json"), "{}\n");
    writeFileSync(join(tree, "dist", "tests", "helpers", "type-core-oracles.js"), storable(false));
    writeFileSync(join(tree, ".sha"), `${"1".repeat(40)}\n`);
    writeSrc(tree);
    const area = join(tree, "tests", "families", "area");
    mkdirSync(area, { recursive: true });
    const cases = 'export const cases = [["same", "same"], ["alike", "alike"]];\n';
    writeFileSync(join(area, "a.mjs"), cases);
    const root = join(directory, "baselines");
    const stored = join(root, SRC, "area");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [runner, area, tree, ...args], { encoding: "utf8" });
    const state = () =>
      spawnSync(process.execPath, [baselines, "state", tree, root, "--read-only"], {
        encoding: "utf8",
      })
        .stdout.trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((line) => line.area === "area")?.state;
    const lines = (file: string) =>
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    // a file without `id`: its id is its file name, `.mjs` included, as every runner before ids stored it
    assert.equal(
      run("--store", root, "--shard", "0/1").status,
      1,
      "the alike source is unanswered",
    );
    const shard = readdirSync(stored).find((name) => name.endsWith(".runs.jsonl"))!;
    assert.deepEqual(
      lines(join(stored, shard))
        .filter((line) => line.source !== undefined)
        .map(({ generator, source }) => [generator, source]),
      [
        ["a.mjs", "same"],
        ["a.mjs", "alike"],
      ],
    );
    assert.equal(state(), "complete");

    // renamed, keeping its old name as its id: the area's plan and every source's stored line stand, and its records
    // name its file beside its id; the stored lines never do
    rmSync(join(area, "a.mjs"));
    writeFileSync(
      join(area, "b.mjs"),
      `// id a.mjs: renamed from a.mjs\nexport const id = "a.mjs";\n${cases}`,
    );
    assert.equal(state(), "complete");
    const work = join(directory, "work.jsonl");
    const against = run("--baseline", stored, "--work", work);
    const total = JSON.parse(against.stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(
      [total.sources, total.uncompared, total.differences],
      [2, 0, 0],
      against.stderr,
    );
    assert.deepEqual(
      lines(work)
        .slice(1, -1)
        .map(({ generator, file, source }) => [generator, file, source]),
      [
        ["a.mjs", "b.mjs", "same"],
        ["a.mjs", "b.mjs", "alike"],
      ],
    );
    // a stall in its `--out`: the stall index finds its area by its file, and keeps its id in the place
    for (const tool of ["baselines.mjs", "run-contract.mjs", "sources.mjs", "stalls.mjs"])
      cpSync(join("tests", "families", tool), join(tree, "tests", "families", tool));
    writeFileSync(
      join(area, "b.mjs"),
      `// id a.mjs: renamed from a.mjs\nexport const id = "a.mjs";\nexport const cases = [["ends", "ends"]];\n`,
    );
    const out = join(directory, "out.jsonl");
    run(tree, "--out", out);
    assert.deepEqual(
      lines(out).map(({ generator, file, source }) => [generator, file, source]),
      [["a.mjs", "b.mjs", "ends"]],
    );
    const index = spawnSync(
      process.execPath,
      [join(tree, "tests", "families", "stalls.mjs"), out],
      { encoding: "utf8" },
    );
    assert.notEqual(index.status, 2, index.stderr);
    assert.match(index.stdout, /"generator":"a\.mjs"[^\n]*"source":"ends"/u);
    // (renamed without it, its sources are new ones: the stored plan is another)
    writeFileSync(join(area, "b.mjs"), cases);
    assert.equal(state(), "another plan");

    // two generators with one id are refused before any source runs
    writeFileSync(join(area, "b.mjs"), `export const id = "a.mjs";\n${cases}`);
    writeFileSync(join(area, "c.mjs"), `export const id = "a.mjs";\n${cases}`);
    const twice = run(tree);
    assert.equal(twice.status, 2, twice.stderr);
    assert.match(twice.stderr, /b\.mjs and c\.mjs have one id, a\.mjs/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a run stalls where its charged units pass the unit limit, the same on every machine, and the wall clock is only a safety net, whose trigger is uncharged work; a baseline stores each run's units, so the stall index judges a head stall from the records, and says so where an older baseline stores none (#1647)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, isHead: boolean, { ledger = true, between = false } = {}) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      mkdirSync(join(tree, "src"));
      writeFileSync(join(tree, "src", "a.ts"), `${name}\n`);
      writeFileSync(join(tree, ".sha"), `${(isHead ? "2" : "1").repeat(40)}\n`);
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      if (ledger)
        writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        unitsLibrary(isHead, between, ledger),
      );
      return tree;
    };
    const [base, head] = [built("base", false), built("head", true)];
    const areaOf = (name: string, names: string[]) => {
      const folder = join(directory, name);
      mkdirSync(folder);
      writeFileSync(
        join(folder, "g.mjs"),
        `export const cases = ${JSON.stringify(names.map((source) => [source, source]))};\n`,
      );
      return folder;
    };
    const names = ["fast", "over", "both", "budget", "ledgers", "noisy", "slowall", "hang"];
    const folder = areaOf("units", names);
    const run = (tool: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const sources = (file: string) =>
      new Map(
        lines(readFileSync(file, "utf8"))
          .slice(1, -1)
          .map((line) => [line.source, line]),
      );
    const charged = ({ runs }: { runs: Record<string, unknown>[] }) =>
      runs.map(({ work, allowance, running }) => ({ work, allowance, running }));
    const verdictsOf = (printed: Record<string, unknown>[]) =>
      printed.slice(1, -2).map(({ source, verdict, uncharged }) => [source, verdict ?? uncharged]);
    const MODES = ["src-on", "src-off", "rev-on", "rev-off"];

    // both trees in one process, a safety net of 3 s a run: `over` stalls in the head's first run at the charge that
    // passes 4 × 1,000 units, `both` in the base's (the head's not run), `noisy` too though its stderr is backed up;
    // `budget` ends past its allowance, `ledgers` within 4 times the largest allowance it charged; `slowall` ends, each
    // tree's run within the safety net, a run of both trees together past it; `hang` reaches it: uncharged work, no stall
    const paired = join(directory, "paired.work.jsonl");
    const ran = run(runner, folder, base, head, "--timeout", "3", "--work", paired);
    assert.equal(ran.status, 1, ran.stderr);
    const ended = lines(ran.stdout).at(-1);
    assert.deepEqual([ended.stalled, ended.uncharged, ended.units], [3, 1, 4]);
    assert.match(ran.stderr, /"source":"hang","uncharged":\{"head":"src-on publication"\}/);
    const record = sources(paired);
    // (judged from the record alone: the head's stalls on a run the base ended within the limit, `both` the base's)
    assert.deepEqual(verdictsOf(lines(run(stalls, paired).stdout)), [
      ["over", "candidate"],
      ["both", "inherited"],
      ["noisy", "candidate"],
      ["hang", { head: "src-on publication" }],
    ]);
    assert.deepEqual(
      ["over", "both", "noisy"].map((source) => [
        record.get(source).stalled,
        charged(record.get(source)),
      ]),
      [
        ["units", [{ work: [300, 5300], allowance: [1000, 1000], running: 1 }]],
        ["units", [{ work: [5300, null], allowance: [1000, null], running: 0 }]],
        ["units", [{ work: [300, 5300], allowance: [1000, 1000], running: 1 }]],
      ],
    );
    assert.deepEqual(
      ["budget", "ledgers"].map((source) => charged(record.get(source))),
      [
        MODES.map(() => ({ work: [1800, 1800], allowance: [1000, 1000], running: undefined })),
        MODES.map(() => ({ work: [7301, 7301], allowance: [2000, 2000], running: undefined })),
      ],
    );
    const slowest = record.get("slowall").runs.map(({ ms }: { ms: number[] }) => ms[0]! + ms[1]!);
    assert.ok(
      record.get("slowall").stalled === undefined && slowest.every((ms: number) => ms > 3000),
      String(slowest),
    );
    assert.deepEqual(
      [record.get("hang").stalled, record.get("hang").uncharged, record.get("hang").counts],
      [undefined, { head: "src-on publication" }, { uncharged: 1 }],
    );

    // a real analysis stopped by its budget (TSV076, at the nesting limit) ends, its finishing work counted in its units
    const realSource = `let k: integer = 1\n${"if hostValue == 1 {\n".repeat(257)}say "\${hostValue}"\n${"}\n".repeat(257)}exit`;
    const real = areaOf("real", ["nested"]);
    writeFileSync(
      join(real, "g.mjs"),
      `export const cases = ${JSON.stringify([["nested", realSource]])};\n`,
    );
    const stopped = join(directory, "real.work.jsonl");
    const checkout = process.cwd();
    assert.equal(run(runner, real, checkout, checkout, "--work", stopped).status, 0);
    const request = coreRequest([{ path: "main.tease", source: realSource }]);
    assert.ok(request !== null);
    const { budget } = analyseCore(request);
    const [first] = sources(stopped).get("nested").runs;
    assert.deepEqual([budget.exhausted, budget.finishing > 0], ["nesting", true]);
    assert.ok(
      first.work[1] >= budget.total + budget.finishing,
      JSON.stringify([first, budget.total]),
    );

    // the base stored (plan 2): each run with its units and allowance, a stall over the unit limit with the run it cut,
    // its certificate
    const store = join(directory, "store");
    mkdirSync(store);
    assert.equal(run(runner, folder, base, "--store", store).status, 1);
    const [src] = readdirSync(store);
    const area = join(store, src!, "units");
    assert.match(
      readFileSync(join(area, "PLAN"), "utf8"),
      /^plan 2\n(?:.*\n)*limits 4 x allowance units, \d+ s safety net, 2048 MB\n/,
    );
    const shard = lines(readFileSync(join(area, "0of1.runs.jsonl"), "utf8"));
    const storedOf = (source: string) => shard.find((line) => line.source === source);
    assert.deepEqual(
      [storedOf("both").stalled, storedOf("both").cut],
      ["units", { run: "src-on publication", work: 5300, allowance: 1000 }],
    );
    assert.deepEqual(
      storedRuns(storedOf("budget")).map(({ work, allowance }) => [work, allowance]),
      MODES.map(() => [1800, 1000]),
    );
    assert.deepEqual([shard.at(-1).total.units, shard.at(-1).total.uncharged], [4, 0]);

    // the head against it: the stall index judges each stall from the records, no rerun: a candidate where the base
    // ended the run within the limit, `both` inherited (the base stalled too), `hang` uncharged work, a defect
    const judged = (name: string, baseline: string) => {
      const file = join(directory, `${name}.work.jsonl`);
      const compared = run(
        runner,
        folder,
        head,
        "--baseline",
        baseline,
        "--timeout",
        "3",
        "--work",
        file,
      );
      assert.equal(compared.status, 1, compared.stderr);
      const verdicts = run(stalls, file);
      assert.equal(verdicts.status, 1, verdicts.stderr);
      return [lines(readFileSync(file, "utf8"))[0].work.stored, lines(verdicts.stdout)] as const;
    };
    const [stored, verdicts] = judged("against", area);
    assert.deepEqual(stored, { units: 4 });
    assert.deepEqual(verdictsOf(verdicts), [
      ["over", "candidate"],
      ["both", "inherited"],
      ["noisy", "candidate"],
      ["hang", { head: "src-on publication" }],
    ]);
    assert.equal(
      verdicts[1].why,
      "on src-on publication the head charged 5300 units, over 4 × its allowance 1000; the base 300 within it",
    );
    const unknown = (run: string) =>
      `the head stalled over the unit limit on ${run}, and no units of the base are recorded on it (a baseline before #1647, or a tree without a ledger)`;
    // (no units of the base on the cut run: a baseline before #1647, plan 1, its stalls at a time limit; a base tree
    // without a ledger: unknown, never a candidate)
    const old = join(directory, "old");
    cpSync(store, old, { recursive: true });
    asPlanOne(join(old, src!));
    const [none, before] = judged("before", join(old, src!, "units"));
    assert.deepEqual(none, { units: null });
    assert.deepEqual(
      before.slice(1, 3).map(({ source, verdict, why }) => [source, verdict, why]),
      [
        ["over", "unknown", unknown("src-on publication")],
        [
          "both",
          "unknown",
          "the head stalled (units), and the base at a time limit (a baseline before #1647)",
        ],
      ],
    );
    const bare = built("bare", false, { ledger: false });
    const unmeasured = join(directory, "unmeasured");
    mkdirSync(unmeasured);
    assert.equal(run(runner, folder, bare, "--store", unmeasured).status, 0);
    const [, bareVerdicts] = judged("bare", join(unmeasured, readdirSync(unmeasured)[0]!, "units"));
    assert.deepEqual(
      bareVerdicts.slice(1, 2).map(({ source, verdict, why }) => [source, verdict, why]),
      [["over", "unknown", unknown("src-on publication")]],
    );
    // (and beside it in one process: its run ended, its units none)
    const besideBare = join(directory, "beside-bare.work.jsonl");
    run(runner, areaOf("over", ["over"]), bare, head, "--work", besideBare);
    assert.deepEqual(
      lines(run(stalls, besideBare).stdout)
        .slice(1, 2)
        .map(({ source, verdict, why }) => [source, verdict, why]),
      [["over", "unknown", unknown("src-on publication")]],
    );

    // every reader of a plan 2 shard validates it alike (Codex r1): an ended run over the unit limit, its digest repaired,
    // is refused by the comparison, and a store does not skip it but stores the shard again
    const forged = join(directory, "forged");
    cpSync(store, forged, { recursive: true });
    const forgedShard = join(forged, src!, "units", "0of1.runs.jsonl");
    const [, ...rest] = readFileSync(forgedShard, "utf8").trim().split("\n");
    const forgedLines = readFileSync(forgedShard, "utf8")
      .trim()
      .split("\n")
      .slice(0, -1)
      .map((line) =>
        line.includes('"source":"budget"') ? line.replace('"work":1800', '"work":5000') : line,
      );
    const forgedEnd = JSON.parse(rest.at(-1)!);
    const forgedBody = forgedLines.map((line) => `${line}\n`).join("");
    forgedEnd.total.lines = sha256(forgedBody);
    writeFileSync(forgedShard, `${forgedBody}${JSON.stringify(forgedEnd)}\n`);
    const refusal = run(runner, folder, head, "--baseline", join(forged, src!, "units"));
    assert.equal(refusal.status, 2);
    assert.match(
      refusal.stderr,
      /g\.mjs budget: its run "src-on publication" is not one a store writes/,
    );
    // (and a MANIFEST holding one area's record twice, which status refuses, refused by the comparison too: Codex r4)
    const doubled = join(directory, "doubled");
    cpSync(store, doubled, { recursive: true });
    const doubledManifest = join(doubled, src!, "MANIFEST");
    const areaLine = readFileSync(doubledManifest, "utf8").match(/^area units .*\n/m)![0];
    writeFileSync(doubledManifest, `${readFileSync(doubledManifest, "utf8")}${areaLine}`);
    const twice = run(runner, folder, head, "--baseline", join(doubled, src!, "units"));
    assert.equal(twice.status, 2);
    assert.match(
      twice.stderr,
      /MANIFEST is not one this tool writes: its line \d+ is no line this tool writes/,
    );
    const restored = run(runner, folder, base, "--store", forged);
    assert.equal(lines(restored.stdout).at(-1).verified, true, restored.stdout);
    assert.equal(
      readFileSync(forgedShard, "utf8"),
      readFileSync(join(area, "0of1.runs.jsonl"), "utf8"),
    );

    // the safety net between a source's runs: one representation, which the store writes and every reader accepts
    const between = built("between", false, { between: true });
    const outsideStore = join(directory, "outside");
    mkdirSync(outsideStore);
    const quick = areaOf("quick", ["fast"]);
    const outsideRun = spawnSync(
      process.execPath,
      [runner, quick, between, "--store", outsideStore],
      { encoding: "utf8", env: { ...process.env, FAMILIES_TIMEOUT: "1" } },
    );
    assert.equal(outsideRun.status, 1, outsideRun.stderr);
    const outsideArea = join(outsideStore, readdirSync(outsideStore)[0]!, "quick");
    assert.equal(
      lines(readFileSync(join(outsideArea, "0of1.runs.jsonl"), "utf8"))[0].uncharged,
      "outside its runs",
    );
    const outsideRead = run(runner, quick, between, "--baseline", outsideArea, "--timeout", "1");
    assert.equal(outsideRead.status, 1, outsideRead.stderr);
    assert.match(
      outsideRead.stderr,
      /"uncharged":\{"base":"outside its runs","head":"outside its runs"\}/,
    );

    // a replay recorded before #1647 (its configuration without a unit limit, its stalls a time limit's) is rerun by
    // this runner and merged, the rerun's unit limit added, and judged by its own rule (the transition rule, Codex r1,
    // r2): `over` stalls again, a candidate; `grow`, whose head charged far more than the base before its old time
    // limit, ends in the rerun and stays a candidate, as that rule says a rerun that ends does not clear it
    const legacy = join(directory, "legacy.work.jsonl");
    run(runner, areaOf("legacy", ["fast", "over", "grow"]), base, head, "--work", legacy);
    const [header, ...body] = lines(readFileSync(legacy, "utf8"));
    delete header.work.units;
    delete header.work.configuration.units;
    const total = body.pop().total;
    const older = body.map(({ runs, stalled, counts, ...line }) => {
      const ran = runs.map(({ allowance: _allowance, ...one }: Record<string, unknown>) => one);
      // (`grow`'s first run cut at its old time limit, its units then the head's whole run's)
      return line.source === "grow"
        ? { ...line, runs: [{ ...ran[0], running: 1 }], counts: { stalled: 1 }, stalled: "timeout" }
        : { ...line, runs: ran, counts, ...(stalled === undefined ? {} : { stalled: "timeout" }) };
    });
    const { units: _units, uncharged: _uncharged, ...kept } = total;
    for (const key of ["runs", "stalled"])
      kept[key] = older.reduce((sum, { counts }) => sum + (counts[key] ?? 0), 0);
    writeFileSync(
      legacy,
      [header, ...older, { total: kept }].map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    const legacyIndex = join(directory, "legacy-index.json");
    assert.equal(run(stalls, legacy, "--index", legacyIndex).status, 1);
    const reran = join(directory, "legacy-rerun");
    assert.equal(run(stalls, "rerun", legacyIndex, base, head, reran).status, 1);
    const merged = run(stalls, legacy, "--rerun", join(reran, "legacy.work.jsonl"));
    assert.equal(merged.status, 1, merged.stderr);
    const after = lines(merged.stdout);
    assert.deepEqual(
      after
        .slice(1, 3)
        .map(({ source, verdict, rerun: { outcome, verdict: now } }) => [
          source,
          verdict,
          outcome,
          now,
        ]),
      [
        ["over", "candidate", "stalled", "candidate"],
        ["grow", "candidate", "agreed", "candidate"],
      ],
    );
    assert.deepEqual([after.at(-1).candidate, after.at(-1).closed], [2, false]);

    // and a plan 2 baseline is compared only at its own unit limit
    const elsewhere = run(runner, folder, head, "--baseline", area, "--units", "3");
    assert.equal(elsewhere.status, 2);
    assert.match(
      elsewhere.stderr,
      /is stored at 4 times the allowance: run the head there \(--units 4\)/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the corpus runner runs a pool's batch of sources by their places as its shards run them, and refuses a list it cannot run whole (#1826)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
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
    const folder = join(directory, "pooled");
    mkdirSync(folder);
    const names = ["a", "b", "dup", "c", "dup"];
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(names.map((name) => [name, name]))};\n`,
    );
    const run = (env: Record<string, string>, ...args: string[]) =>
      spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env } });
    const items = resolve("tests/families/items.mjs");
    const write = (name: string, lines: string[]) => {
      const file = join(directory, name);
      writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
      return file;
    };
    // the area's sources, a repeated one once
    const listed = run({}, items, "sources", folder);
    assert.equal(listed.status, 0, listed.stderr);
    const places = listed.stdout.trim().split("\n");
    assert.equal(places.length, 4);
    // two batches in no shard's order, the second as the queue gives it ($SX_ITEMS, the flag before the trees), judge
    // as the area's two shards do
    const [first, second] = [
      write("first", [places[3]!, places[0]!]),
      write("second", places.slice(1, 3)),
    ];
    const byItems = [join(directory, "i0.work.jsonl"), join(directory, "i1.work.jsonl")];
    const one = run({}, runner, folder, base, head, "--items", first, "--work", byItems[0]!);
    assert.equal(one.status, 0, one.stderr);
    const two = run(
      { SX_ITEMS: second },
      runner,
      folder,
      "--items-from-env",
      base,
      head,
      "--work",
      byItems[1]!,
    );
    assert.equal(two.status, 0, two.stderr);
    const byShards = [join(directory, "s0.work.jsonl"), join(directory, "s1.work.jsonl")];
    for (const [shard, file] of byShards.entries())
      assert.equal(
        run({}, runner, folder, base, head, "--shard", `${shard}/2`, "--work", file).status,
        0,
      );
    const judged = (files: string[]) => {
      const result = run({}, stalls, ...files);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split("\n").at(-1);
    };
    assert.equal(judged(byItems), judged(byShards));
    // (a pool's batches close only together: one alone holds two of the area's four sources)
    const part = run({}, stalls, byItems[0]!);
    assert.equal(part.status, 1, part.stdout);
    assert.match(part.stdout, /"shards":"1 batches, 2 of 4 sources","complete":false/);
    // (each record names its batch, never a shard another holds)
    const batch = (file: string) =>
      JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).work.shard;
    assert.match(batch(byItems[0]!), /^items [0-9a-f]{16}$/);
    assert.notEqual(batch(byItems[0]!), batch(byItems[1]!));
    // a list the runner cannot run whole is refused before any source runs
    const refusals: [string[], RegExp][] = [
      [["--items", first, "--shard", "0/2"], /drop --store, --shard and --only/],
      [["--items", first, "--items-from-env"], /give one/],
      [["--items", write("unknown", ['["g.mjs","z","0"]'])], /does not hold/],
      [["--items", write("twice", [places[0]!, places[0]!])], /twice/],
      [["--items", write("empty", [])], /lists no source/],
      [["--items", write("bad", ["g.mjs a"])], /no source's place/],
      [["--items-from-env"], /\$SX_ITEMS names no file/],
    ];
    for (const [more, why] of refusals) {
      const refused = run({ SX_ITEMS: "" }, runner, folder, base, head, ...more);
      assert.equal(refused.status, 2, `${more.join(" ")}: ${refused.stderr}`);
      assert.match(refused.stderr, why);
    }
    // `items.mjs check --area`: the area's every source once, no other
    assert.equal(run({}, items, "check", write("whole", places), "--area", folder).status, 0);
    assert.equal(run({}, items, "check", first, "--area", folder).status, 1);
    const extra = write("extra", [...places, '["g.mjs","z","0"]']);
    assert.equal(run({}, items, "check", extra, "--area", folder).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose analyses charge its ledger (allowance 1,000) 300 units a run and report 100 cells
 * returned by its questions (`questionWork`, where `reports`) at `QUESTION_UNITS_PER_CELL` 64, a grant of 6,400 beyond
 * 4 × 1,000: `granted` charges 9,000 more in its publication (within the grant), `past` 11,000 (past it), `stops` 9,000
 * more in its stop runs alone, which no grant reaches.
 */
const grantLibrary = (
  reports: boolean,
): string => `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
let cells = 0;
${reports ? "export const QUESTION_UNITS_PER_CELL = 64;\nexport const questionWork = () => ({ units: 0, cells });" : ""}
export function publicationHashes(files) {
  const source = files[0].source;
  cells = 0;
  const ledger = new WorkLedger(1000);
  ledger.charge("frames", 300);
  cells = 100;
  if (source === "granted") ledger.charge("frames", 9000);
  if (source === "past") ledger.charge("frames", 11000);
  return { parts: ["a", "b"], unanswered: 0 };
}
export function stopSet(files) {
  new WorkLedger(1000).charge("frames", files[0].source === "stops" ? 9300 : 300);
  return { stops: [] };
}
`;

test("a publication run's unit limit grants its oracle's units per cell its questions reported, and nothing where none are reported or in a stop run (#1837)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (name: string, reports: boolean) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        grantLibrary(reports),
      );
      return tree;
    };
    const folder = join(directory, "area");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(["granted", "past", "stops"].map((name) => [name, name]))};\n` +
        'export const checks = ["publication", "stops"];\n',
    );
    const stalled = (base: string, head = base) => {
      const work = join(directory, `${basename(base)}-${basename(head)}.work.jsonl`);
      const ran = spawnSync(
        process.execPath,
        [runner, folder, base, head, "--allowances", "natural", "--work", work],
        { encoding: "utf8" },
      );
      const lines = readFileSync(work, "utf8")
        .trim()
        .split("\n")
        .slice(1, -1)
        .map((line) => JSON.parse(line));
      return [
        ran.status,
        lines.filter((line) => line.stalled !== undefined).map((line) => line.source),
      ];
    };
    // (the grant: `granted` ends; `past` passes it, `stops` is no publication run)
    assert.deepEqual(stalled(built("reports", true)), [1, ["past", "stops"]]);
    // (no cells reported, no grant)
    const silent = built("silent", false);
    assert.deepEqual(stalled(silent), [1, ["granted", "past", "stops"]]);
    // (each tree's own report: the base's cells grant the head nothing)
    assert.deepEqual(stalled(join(directory, "reports"), silent), [
      1,
      ["granted", "past", "stops"],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A built tree's library whose publication answers every source alike, without the grant's exports where `bare`. Where
 * `heavy`: `heavy` in the source-order sharing-on mode leaves 82 % of its process's heap limit held after it returns,
 * which the run's end sample alone sees (it charges under one sampling step); `late` in the reversed sharing-on mode
 * holds as much while it charges 70,000 units (past one step), then lets go, as `both` does in the source-order
 * sharing-on mode. Where `aborting`, `late` in the source-order sharing-off mode ends the process as V8's heap abort
 * does; where `dying`, `both` in the source-order sharing-on mode does. Each call first lets go of what an earlier one
 * held and collects, so a run starts low.
 */
const peakLibrary = (
  heavy: boolean,
  bare: boolean,
  aborting: boolean,
  dying = false,
): string => `import { writeSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
${bare ? "" : "export const QUESTION_UNITS_PER_CELL = 64;\nexport const questionWork = () => ({ units: 0, cells: 0 });"}
const filled = () => {
  const held = [];
  while (getHeapStatistics().used_heap_size < 0.82 * getHeapStatistics().heap_size_limit)
    held.push(new Array(1 << 14).fill(1.5));
  return held;
};
export function publicationHashes(files, mode) {
  if (globalThis.heldByPeakLibrary !== undefined) {
    globalThis.heldByPeakLibrary = undefined;
    globalThis.gc();
  }
  const source = files[0].source;
  const ledger = new WorkLedger(1000000);
  if (
    (${aborting} && source === "late" && mode.unshared && !mode.reversed) ||
    (${dying} && source === "both" && !mode.unshared && !mode.reversed)
  ) {
    writeSync(2, "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\\n");
    process.exit(134);
  }
  if (${heavy} && source === "heavy" && !mode.reversed && !mode.unshared) {
    globalThis.heldByPeakLibrary = filled();
    ledger.charge("frames", 300);
  } else if (
    ${heavy} &&
    ((source === "late" && mode.reversed && !mode.unshared) ||
      (source === "both" && !mode.reversed && !mode.unshared))
  ) {
    let held = filled();
    ledger.charge("frames", 70000);
    held = null;
    globalThis.gc();
  } else ledger.charge("frames", 300);
  return { parts: [source], unanswered: 0 };
}
`;

test("a run's peak heap is near the cap past 80 % of V8's heap limit, a synthetic peak either side of it", async () => {
  const { isNearCap, NEAR_CAP } = await import(pathToFileURL(contract).href);
  assert.equal(NEAR_CAP, 0.8);
  // (2,144 MiB, the limit V8 gives a 2,048 MB process: 80 % is 1,715.2)
  assert.equal(isNearCap(1715, 2144), false);
  assert.equal(isNearCap(1716, 2144), true);
  // (a peak is judged as it was sampled, never rounded first: 80.01 % of 448 MiB is 358.4448)
  assert.equal(isNearCap(358.4, 448), false);
  assert.equal(isNearCap(0.8001 * 448, 448), true);
  // (never where either is unknown: a failed heap probe, a run with no peak)
  assert.equal(isNearCap(1716, undefined), false);
  assert.equal(isNearCap(null, 2144), false);
});

test("the runner records each run's peak heap, counts and names a source near the cap on its tree, its end sample's or its step's, the head's alone after a base crash and a base's before a head crash among them, without making it a stall or changing the exit status, and names what each tree's build lacks (the checks proposal's items 25 and 26)", () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const built = (
      name: string,
      heavy: boolean,
      bare: boolean,
      aborting: boolean,
      dying = false,
    ) => {
      const tree = join(directory, name);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
      writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        peakLibrary(heavy, bare, aborting, dying),
      );
      return tree;
    };
    const base = built("base", false, true, true);
    const head = built("head", true, false, false);
    const ran = (name: string, cases: string[], trees = [base, head]) => {
      const folder = join(directory, name);
      mkdirSync(folder);
      writeFileSync(
        join(folder, "g.mjs"),
        `export const cases = ${JSON.stringify(cases.map((source) => [source, source]))};\n`,
      );
      const out = join(directory, `${name}.out.jsonl`);
      const work = join(directory, `${name}.work.jsonl`);
      const result = spawnSync(
        process.execPath,
        [runner, folder, ...trees, "--memory", "512", "--out", out, "--work", work],
        { encoding: "utf8" },
      );
      const read = (file: string) =>
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      const [row, total] = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return {
        status: result.status,
        stderr: result.stderr,
        row,
        total,
        out: read(out),
        work: read(work),
      };
    };
    const runsOf = (named: { nearCap?: { mode: string; check: string; tree: string }[] }) =>
      (named.nearCap ?? []).map(({ mode, check, tree }) => [mode, check, tree]);

    // (the end sample's peak: nothing else to read, so near the cap leaves the exit status 0)
    const first = ran("first", ["light", "heavy"]);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.row.nearCap, { base: 0, head: 1 });
    assert.deepEqual(first.total.nearCap, { base: 0, head: 1 });
    assert.equal(first.total.stalled, 0);
    const limit = first.total.heapLimit;
    assert.ok(Number.isInteger(limit) && limit > 512, String(limit));
    assert.deepEqual(first.total.capabilities, {
      base: ["QUESTION_UNITS_PER_CELL", "questionWork"],
      head: [],
    });
    // (`--out` names the one run near the cap, the head's, with its peak and the limit)
    assert.deepEqual(
      first.out.map(({ source }) => source),
      ["heavy"],
    );
    assert.equal(first.out[0].heapLimit, limit);
    assert.deepEqual(runsOf(first.out[0]), [["src-on", "publication", "head"]]);
    assert.ok(first.out[0].nearCap[0].peak > 0.8 * limit, JSON.stringify(first.out[0]));
    // (the work record: the limit and the lacks first; each run's peak on each tree, the others far under it)
    assert.equal(first.work[0].work.heapLimit, limit);
    assert.deepEqual(first.work[0].work.capabilities, first.total.capabilities);
    const [light, heavy] = first.work.slice(1, -1);
    assert.equal(light.nearCap, undefined);
    for (const run of [...light.runs, ...heavy.runs.slice(1)])
      for (const peak of run.peak) assert.ok(peak < 0.8 * limit, String(peak));
    assert.ok(heavy.runs[0].peak[1] > 0.8 * limit && heavy.runs[0].peak[0] < 0.8 * limit);
    assert.deepEqual(runsOf(heavy), [["src-on", "publication", "head"]]);
    assert.deepEqual(first.work.at(-1).total, first.total);

    // (a step's peak, on the head's run alone after the base's abort: counted as the head's)
    const second = ran("second", ["late"]);
    assert.equal(second.status, 1, second.stderr);
    assert.deepEqual(second.total.crashed, { base: 1, head: 0 });
    assert.deepEqual(second.total.nearCap, { base: 0, head: 1 });
    const named = second.out.filter((line) => line.nearCap !== undefined);
    assert.deepEqual(named.map(runsOf), [[["rev-on", "publication", "head"]]]);
    const late = second.work[1];
    assert.deepEqual(
      late.afterBase.map(({ mode, peak }: { mode: string; peak: number }) => [
        mode,
        peak > 0.8 * limit,
      ]),
      [
        ["src-off", false],
        ["rev-on", true],
        ["rev-off", false],
      ],
    );

    // (a base's peak on a run whose head then aborted: kept from the head's start, counted as the base's; the head's
    // crash alone, so exit 3)
    const third = ran(
      "third",
      ["both"],
      [built("heavy-base", true, true, false), built("dying-head", false, false, false, true)],
    );
    assert.equal(third.status, 3, third.stderr);
    assert.deepEqual(third.total.crashed, { base: 0, head: 1 });
    assert.deepEqual(third.total.nearCap, { base: 1, head: 0 });
    assert.deepEqual(third.out.filter((line) => line.nearCap !== undefined).map(runsOf), [
      [["src-on", "publication", "base"]],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the built tree's oracle library and work ledger give the families runner all it reads (capabilitiesOf, the checks proposal's item 26)", async () => {
  const { capabilitiesOf } = await import(pathToFileURL(contract).href);
  const oracle = await import("./helpers/type-core-oracles.js");
  const { WorkLedger } = await import("../src/type-inference/core/budget.js");
  assert.deepEqual(capabilitiesOf({ oracle, ledger: WorkLedger }), []);
});
