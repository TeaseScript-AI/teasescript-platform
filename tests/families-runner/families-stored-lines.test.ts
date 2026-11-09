import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  runner,
  baselines,
  contract,
  LEDGER,
  sha256,
  unitsLibrary,
} from "../helpers/families-runner/families-runner-stand-ins.js";

test("every reader of a stored shard accepts or refuses one line alike, none throwing, and a writer stores again what it refuses: a family over the line's PLAN, end, cut and run (#1647, Codex r2)", async () => {
  // Its readers: status, import, the comparison and, for plan 2, the stalls' listing, `state` and the store. The
  // family's whole product (FAMILIES_FORMAT=full: 3 PLANs × 3 bindings × 9 ends × 5 cuts × 4 runs) is queue evidence,
  // under agents.home.arpa:~/work/evidence/1650/<head>/format-family/; CI runs one variant per class and boundary of
  // each axis (the test-cost rule).
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "a.ts"), "a\n");
    writeFileSync(join(tree, ".sha"), `${"1".repeat(40)}\n`);
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
    writeFileSync(
      join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
      unitsLibrary(false),
    );
    // (the area in the tree, where `state` finds it)
    const area = join(tree, "tests", "families", "units");
    mkdirSync(area, { recursive: true });
    writeFileSync(join(area, "g.mjs"), `export const cases = [["s", "s"]];\n`);
    const tool = (...args: string[]) =>
      spawnSync(process.execPath, [baselines, ...args], { encoding: "utf8" });
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    // the source stored once, its MANIFEST naming the tree's build (as a seed's does)
    const stored = join(directory, "stored");
    mkdirSync(stored);
    assert.equal(spawnSync(process.execPath, [runner, area, tree, "--store", stored]).status, 0);
    assert.equal(tool("compiled", tree, stored).status, 0);
    const [src] = readdirSync(stored);
    const { storedRuns: comparisonOf } = await import(pathToFileURL(baselines).href);

    type Variant = { plan: string; binding: string; end: string; cut: string; run: string };
    const PLANS = ["2", "1", "mismatched"];
    // (the PLAN as its MANIFEST records it, changed after it was recorded, or recorded with no shard: Codex r3)
    const BINDINGS = ["recorded", "other-hash", "zero-shards"];
    const ENDS = [
      "none",
      "units",
      "exit",
      "at-run",
      "at-ended",
      "outside",
      "thrown",
      "two",
      "stall-thrown",
    ];
    const CUTS = ["absent", "valid", "zero", "under", "ended"];
    const RUNS = ["valid", "null", "no-work", "over"];
    /** Whether a store writes the variant (the rule apart from the tools: #1647's format, plan 1 as before it). */
    const accepted = ({ plan, binding, end, cut, run }: Variant) => {
      if (plan === "mismatched" || binding !== "recorded" || run === "null") return false;
      if (["two", "at-ended", "stall-thrown"].includes(end)) return false;
      if (plan === "1") return cut === "absent" && !["at-run", "outside", "units"].includes(end);
      if (run !== "valid") return false;
      return end === "units" ? cut === "valid" : cut === "absent";
    };
    /** The variant's baseline: the stored line made so, its totals and digests repaired, and its stalls' listing. */
    const made = (name: string, { plan, binding, end, cut, run }: Variant) => {
      const root = join(directory, "variants", name);
      cpSync(stored, root, { recursive: true });
      const dir = join(root, src!);
      const file = join(dir, "units", "0of1.runs.jsonl");
      const [line, { total }] = lines(readFileSync(file, "utf8"));
      const names: string[] = Object.keys(line.runs);
      const [first, second] = [names[0]!, names[1]!];
      const result = (ran: Record<string, unknown>): Record<string, unknown> => {
        const { work: _work, allowance: _allowance, ...value } = ran;
        return plan === "2" ? ran : value;
      };
      const ended = result(line.runs[first]);
      // (a run's units, which only plan 2 stores, missing or over the limit)
      const firstRun =
        run === "null"
          ? null
          : run === "no-work" && plan === "2"
            ? Object.fromEntries(Object.entries(ended).filter(([name]) => name !== "work"))
            : run === "over" && plan === "2"
              ? { ...ended, work: 5000 }
              : ended;
      const runs =
        end === "none"
          ? {
              ...Object.fromEntries(names.map((at) => [at, result(line.runs[at])])),
              [first]: firstRun,
            }
          : { [first]: firstRun };
      const cutOf = (kind: string) =>
        kind === "valid"
          ? { run: second, work: 4001, allowance: 1000 }
          : kind === "zero"
            ? { run: second, work: 1, allowance: 0 }
            : kind === "under"
              ? { run: second, work: 4000, allowance: 1000 }
              : { run: first, work: 4001, allowance: 1000 };
      const { generator, source, key } = line;
      const stall =
        end === "units"
          ? "units"
          : ["exit", "two", "stall-thrown"].includes(end)
            ? "exit 3"
            : undefined;
      const written = {
        generator,
        source,
        key,
        ...(stall === undefined ? {} : { stalled: stall }),
        ...(end === "thrown" || end === "stall-thrown"
          ? { thrown: { runner: "Error: thrown" } }
          : {}),
        ...(end === "at-run" || end === "two" ? { uncharged: second } : {}),
        ...(end === "at-ended" ? { uncharged: first } : {}),
        ...(end === "outside" ? { uncharged: "outside its runs" } : {}),
        ...(cut === "absent" ? {} : { cut: cutOf(cut) }),
        runs,
      };
      const body = `${JSON.stringify(written)}\n`;
      let text = readFileSync(join(dir, "units", "PLAN"), "utf8");
      const was = sha256(text);
      if (plan === "1") text = text.replace(/^plan 2$/m, "plan 1");
      if (plan !== "2") text = text.replace(/^limits .*$/m, "limits 180 s, 2048 MB");
      // (the PLAN its MANIFEST and the shard's total name: another PLAN in its place, or one of no shard)
      let recorded = `area units 1 ${sha256(text)}`;
      if (binding === "zero-shards") {
        text = text.replace(/^shards 1$/m, "shards 0").replace(/^shard 0 .*\n/m, "");
        recorded = `area units 0 ${sha256(text)}`;
      }
      const named = sha256(text);
      if (binding === "other-hash")
        text = text.replace(/^limits 4 x/m, "limits 8 x").replace(/^limits 180 s/m, "limits 360 s");
      writeFileSync(join(dir, "units", "PLAN"), text);
      const manifest = join(dir, "MANIFEST");
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8").replace(`area units 1 ${was}`, recorded),
      );
      const { units: _units, uncharged: _uncharged, ...kept } = total;
      const counted = {
        ...kept,
        stalled: stall === undefined ? 0 : 1,
        ...(plan === "2"
          ? { units: binding === "other-hash" ? 8 : 4, uncharged: "uncharged" in written ? 1 : 0 }
          : {}),
        plan: named,
        lines: sha256(body),
      };
      writeFileSync(file, `${body}${JSON.stringify({ total: counted })}\n`);
      // (an area recorded with no shard holds none)
      if (binding === "zero-shards") rmSync(file);
      const entry = { area: "units", shard: "0/1", generator, source, key, stalled: stall };
      const listed =
        stall === undefined
          ? []
          : [
              plan === "1"
                ? { ...entry, alone: { generator, source, key, stalled: stall, runs: {} } }
                : { ...entry, ...(cut === "absent" ? {} : { cut: cutOf(cut) }) },
            ];
      writeFileSync(
        join(root, "stalls.json"),
        JSON.stringify({ area: "units", shard: "0/1", stalls: listed }),
      );
      return { root, dir, file };
    };
    /** Each reader's answer on the variant: accepted (true), refused (false); a throw fails the test. */
    const readers = (name: string, variant: Variant) => {
      const { root, dir, file } = made(name, variant);
      const answers: Record<string, boolean> = {};
      const status = tool("status", root, src!);
      assert.ok(
        [0, 1, 2].includes(status.status!),
        `${name} status: ${status.stdout}${status.stderr}`,
      );
      answers["status"] = status.status === 0;
      const central = join(directory, "central", name);
      const seed = tool("import", central, root);
      const shard = seed.status === 0 ? tool("import", central, root, "units", "0/1") : seed;
      assert.ok([0, 2].includes(shard.status!), `${name} import: ${shard.stdout}${shard.stderr}`);
      answers["import"] = shard.status === 0;
      const compared = comparisonOf(join(dir, "units"));
      answers["comparison"] = compared.lines !== undefined;
      if (variant.plan === "2") {
        // (the plan 2 writers: the stalls' listing, and a store, which skips only what it accepts and stores the rest
        // again; a plan 2 writer refuses a plan 1 area as another plan, and one recorded with no shard, and replaces
        // a PLAN that is not the recorded one, so that the area then reads complete)
        const listing = tool(
          "stalls",
          file,
          "units",
          "0/1",
          join(directory, `${name}.stalls.json`),
        );
        assert.ok([0, 2].includes(listing.status!), `${name} stalls: ${listing.stderr}`);
        answers["stalls"] = listing.status === 0;
        // (`state`, the hook's and `baseline.sh status`'s reader, of the tree whose area this is)
        const state = tool("state", tree, root, "--read-only");
        assert.ok(
          [0, 1, 2].includes(state.status!),
          `${name} state: ${state.stdout}${state.stderr}`,
        );
        answers["state"] = state.status === 0;
        const store = spawnSync(process.execPath, [runner, area, tree, "--store", root], {
          encoding: "utf8",
        });
        if (variant.binding === "zero-shards")
          assert.equal(store.status, 2, `${name} store: ${store.stdout}${store.stderr}`);
        else if (variant.binding === "other-hash")
          assert.equal(tool("status", root, src!).status, 0, `${name} repaired: ${store.stdout}`);
        else {
          const ended = lines(store.stdout).at(-1);
          answers["store"] = ended.skipped === "stored";
          if (!answers["store"])
            assert.equal(ended.verified, true, `${name} stored again: ${store.stdout}`);
        }
      }
      return answers;
    };
    const base: Variant = {
      plan: "2",
      binding: "recorded",
      end: "none",
      cut: "absent",
      run: "valid",
    };
    const variants: Variant[] =
      process.env.FAMILIES_FORMAT === "full"
        ? PLANS.flatMap((plan) =>
            BINDINGS.flatMap((binding) =>
              ENDS.flatMap((end) =>
                CUTS.flatMap((cut) => RUNS.map((run) => ({ plan, binding, end, cut, run }))),
              ),
            ),
          )
        : [
            base,
            ...PLANS.slice(1).map((plan) => ({ ...base, plan })),
            ...BINDINGS.slice(1).map((binding) => ({ ...base, binding })),
            { ...base, plan: "1", end: "units" },
            { ...base, plan: "1", end: "stall-thrown" },
            ...ENDS.slice(1).map((end) => ({
              ...base,
              end,
              cut: end === "units" ? "valid" : "absent",
            })),
            ...CUTS.filter((cut) => cut !== "valid").map((cut) => ({ ...base, end: "units", cut })),
            { ...base, cut: "valid" },
            ...RUNS.slice(1).map((run) => ({ ...base, run })),
            { ...base, plan: "1", end: "exit" },
          ];
    const disagreements = variants.flatMap((variant) => {
      const name = Object.values(variant).join("-");
      const answers = readers(name, variant);
      const expected = accepted(variant);
      return Object.entries(answers)
        .filter(([, answer]) => answer !== expected)
        .map(([reader, answer]) => `${name}: ${reader} ${answer ? "accepts" : "refuses"}`);
    });
    assert.deepEqual(disagreements, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one list of stop reasons: every reason has its stall group, and a stored line holds every reason in every recorded form (#1837, the families' fourth hand-kept copy)", async () => {
  const { STOP_REASONS, UNKNOWN_REASON, REASON_GROUPS, groupOf } = await import(
    pathToFileURL(contract).href
  );
  const { sourceFault, DEFAULTS } = await import(pathToFileURL(baselines).href);
  assert.deepEqual(REASON_GROUPS, [...STOP_REASONS, UNKNOWN_REASON].map(groupOf));
  // (a stored line with one run left unanswered `by`)
  const key = "a".repeat(64);
  /** A recorded reason, as a stored run holds it or as a malformed one does. */
  type RecordedBy = {
    readonly reason: string;
    readonly node?: number | null;
    readonly binding?: number | null;
  };
  const stored = (by: RecordedBy) => ({
    generator: "g.mjs",
    source: "s",
    key,
    runs: {
      "src-on publication": {
        value: {
          hash: key,
          parts: ["0123456789abcdef"],
          unanswered: 2,
          unparsed: false,
          unansweredBy: by,
        },
        work: 10,
        allowance: 30_000_000,
      },
    },
  });
  const accepted: RecordedBy[] = [
    // (the four lines that a store refused before this list: the forms #1837's oracle records)
    { reason: "questions", node: 7 },
    { reason: "memory", node: 7 },
    { reason: "read-depth", node: 7 },
    { reason: "questions", binding: 5 },
    // (every reason in every recorded form, and the unknown one)
    ...STOP_REASONS.flatMap((reason: string) => [
      { reason, node: 7 },
      { reason, node: null },
      { reason, binding: 5 },
    ]),
    { reason: UNKNOWN_REASON, node: null },
  ];
  for (const by of accepted)
    assert.equal(sourceFault(stored(by), DEFAULTS.units), undefined, JSON.stringify(by));
  const refused: RecordedBy[] = [
    { reason: "elsewhere", node: 7 },
    { reason: UNKNOWN_REASON, node: 7 },
    { reason: UNKNOWN_REASON, binding: 5 },
    { reason: "questions", binding: null },
    { reason: "questions", node: 7, binding: 5 },
    { reason: "questions" },
  ];
  for (const by of refused)
    assert.notEqual(sourceFault(stored(by), DEFAULTS.units), undefined, JSON.stringify(by));
});

/**
 * A built tree's library whose publication charges its ledger (allowance 1,000) 300 units, its oracle then reporting 10
 * cells at 64 units each (a grant of 640 beyond 4 × 1,000), and then: `admitted` 4,339 more (4,639, one under the limit
 * with the grant), `over` 4,341 (one over it), `ungranted` 3,701 with no cells reported (one over the plain limit).
 */
const storedGrantLibrary = `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
export const QUESTION_UNITS_PER_CELL = 64;
let cells = 0;
export const questionWork = () => ({ units: 0, cells });
export function publicationHashes(files) {
  const source = files[0].source;
  cells = 0;
  const ledger = new WorkLedger(1000);
  ledger.charge("frames", 300);
  cells = source === "ungranted" ? 0 : 10;
  ledger.charge("frames", { admitted: 4339, over: 4341, ungranted: 3701 }[source] ?? 0);
  return { parts: ["a", "b"], unanswered: 0 };
}
`;

test("a store writes and reads a publication run by the runner's own limit, its grant from the cells its oracle reported included, and still refuses a run over it (#1837, the final review's R1)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "families-runner-"));
  try {
    const tree = join(directory, "tree");
    mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
    mkdirSync(join(tree, "dist", "src", "type-inference", "core"), { recursive: true });
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "a.ts"), "tree\n");
    writeFileSync(join(tree, ".sha"), `${"1".repeat(40)}\n`);
    writeFileSync(join(tree, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(tree, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
    writeFileSync(
      join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
      storedGrantLibrary,
    );
    // (the area inside the tree, where `state` finds its areas)
    const folder = join(tree, "tests", "families", "grants");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "g.mjs"),
      `export const cases = ${JSON.stringify(["admitted", "over", "ungranted"].map((name) => [name, name]))};\n`,
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [runner, folder, ...args], {
        encoding: "utf8",
        env: { ...process.env, FAMILIES_UNITS: "4" },
      });
    // (the runner admits `admitted` and stalls the other two; the store writes all three, its lines checked as written)
    const store = join(directory, "store");
    mkdirSync(store);
    const stored = run(tree, "--store", store);
    assert.equal(stored.status, 1, stored.stderr);
    assert.doesNotMatch(stored.stderr, /would be stored as/);
    const [src] = readdirSync(store);
    const area = join(store, src!, "grants");
    const shard = readFileSync(join(area, "0of1.runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const line = (source: string) => shard.find((entry) => entry.source === source);
    const questions = { perCell: 64, cells: 10 };
    /** A stored run, as far as its limit reads it. */
    type StoredRun = {
      readonly value?: unknown;
      readonly work: number;
      readonly allowance: number;
      readonly questions?: { readonly perCell: number; readonly cells: number };
    };
    const runsOf = (source: string): StoredRun[] => Object.values(line(source).runs);
    assert.deepEqual(
      runsOf("admitted").map(({ work, allowance, questions: reported }) => [
        work,
        allowance,
        reported,
      ]),
      Array.from({ length: 4 }, () => [4639, 1000, questions]),
    );
    assert.deepEqual(
      [line("over").stalled, line("over").cut],
      ["units", { run: "src-on publication", work: 4641, allowance: 1000, questions }],
    );
    assert.deepEqual(
      [line("ungranted").stalled, line("ungranted").cut],
      ["units", { run: "src-on publication", work: 4001, allowance: 1000 }],
    );
    // (a head as the tree but lighter on `over` and `ungranted`, and one whose process ends before any run, Codex r1)
    const variant = (name: string, library: string) => {
      const other = join(directory, name);
      mkdirSync(join(other, "dist", "tests", "helpers"), { recursive: true });
      mkdirSync(join(other, "dist", "src", "type-inference", "core"), { recursive: true });
      mkdirSync(join(other, "src"));
      writeFileSync(join(other, "src", "a.ts"), `${name}\n`);
      writeFileSync(join(other, ".sha"), `${"2".repeat(40)}\n`);
      writeFileSync(join(other, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(other, "dist", "src", "type-inference", "core", "budget.js"), LEDGER);
      writeFileSync(join(other, "dist", "tests", "helpers", "type-core-oracles.js"), library);
      mkdirSync(join(other, "tests", "families", "grants"), { recursive: true });
      return other;
    };
    const lighter = variant(
      "lighter",
      storedGrantLibrary.replace("over: 4341, ungranted: 3701", "over: 0, ungranted: 0"),
    );
    const crashing = variant(
      "crashing",
      storedGrantLibrary.replace(
        /export const MODES = [^;]*;/,
        "export const MODES = { *[Symbol.iterator]() { process.exit(5); } };",
      ),
    );
    const records = (args: string[], name: string) => {
      const work = join(directory, `${name}.work.jsonl`);
      const ran = run(...args, "--work", work);
      return {
        status: ran.status,
        stderr: ran.stderr,
        lines: readFileSync(work, "utf8")
          .trim()
          .split("\n")
          .map((text) => JSON.parse(text)),
      };
    };
    // (the stored base alone stalled: its stall's record names its tree and cut run, #1965)
    const light = records([lighter, "--baseline", area], "lighter");
    assert.equal(light.status, 1, light.stderr);
    const lightOf = (source: string) => light.lines.find((entry) => entry.source === source);
    assert.deepEqual(
      ["over", "ungranted"].map((source) => lightOf(source).at),
      Array.from({ length: 2 }, () => ({ tree: "base", mode: "src-on", check: "publication" })),
    );
    // (the stored base's cut run is no run it ended, beside the head's that did)
    const [cutRun] = lightOf("over").runs;
    assert.deepEqual(
      [cutRun.mode, cutRun.work, cutRun.allowance, cutRun.baseCut],
      ["src-on", [4641, 300], [1000, 1000], true],
    );
    // (a head whose process ends before any run: its tree known though its run is not, counted, exit 3; stored, a
    // base's crash, counted so, exit 1)
    const crashed = records([crashing, "--baseline", area], "crashing");
    assert.equal(crashed.status, 3, crashed.stderr);
    assert.deepEqual(crashed.lines.at(-1).total.crashed, { base: 0, head: 3 });
    assert.deepEqual(crashed.lines.find((entry) => entry.source === "admitted").at, {
      tree: "head",
      mode: null,
      check: null,
    });
    const crashStore = join(directory, "crash-store");
    mkdirSync(crashStore);
    const storedCrash = records([crashing, "--store", crashStore], "stored-crash");
    assert.equal(storedCrash.status, 1, storedCrash.stderr);
    assert.deepEqual(storedCrash.lines.at(-1).total.crashed, { base: 3, head: 0 });
    // (read back: the comparison against the stored shard reads every line through the same check, refusing none)
    const against = run(tree, "--baseline", area);
    assert.equal(against.status, 1, against.stderr);
    assert.doesNotMatch(against.stderr, /refused|is not one a store writes/);
    // (state reports what the verified shard stores: its runs, none left unanswered, four within their grant, and the
    // two stalls over the limit)
    const stated = spawnSync(process.execPath, [baselines, "state", tree, store, "--read-only"], {
      encoding: "utf8",
    });
    const grantsLine = stated.stdout
      .trim()
      .split("\n")
      .map((text) => JSON.parse(text))
      .find((entry) => entry.area === "grants");
    assert.deepEqual(
      grantsLine?.runs,
      { count: 4, reasons: {}, granted: 4, overLimit: 2 },
      stated.stdout,
    );
    // (the same check, row by row: one unit over the limit with its grant, a run with no cells reported over the plain
    // limit, a grant on a run that is no publication, and a cut within its limit are all refused)
    const { sourceFault } = await import(pathToFileURL(baselines).href);
    const admitted = line("admitted");
    const withRun = (run: StoredRun) => ({ ...admitted, runs: { "src-on publication": run } });
    const value = admitted.runs["src-on publication"].value;
    assert.equal(sourceFault(admitted, 4), undefined);
    assert.equal(sourceFault(line("over"), 4), undefined);
    assert.equal(sourceFault(line("ungranted"), 4), undefined);
    for (const [refused, why] of [
      [withRun({ value, work: 4641, allowance: 1000, questions }), "one unit over the limit"],
      [withRun({ value, work: 4001, allowance: 1000 }), "no cells reported, over the plain limit"],
      [
        {
          ...admitted,
          runs: { "src-on stops 16": { value, work: 300, allowance: 1000, questions } },
        },
        "a grant on a stop run",
      ],
      [
        withRun({ value, work: 4639, allowance: 1000, questions: { perCell: 0, cells: 10 } }),
        "no units per cell",
      ],
      [{ ...line("over"), cut: { ...line("over").cut, work: 4640 } }, "a cut within its limit"],
    ] as const)
      assert.notEqual(sourceFault(refused, 4), undefined, why);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
