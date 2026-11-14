import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runner } from "../helpers/families-runner/families-runner-stand-ins.js";

// What the evidence command (`tools/compiler-replay/evidence.mjs`, #2796) reads a source's class from: each runner's
// record of the limit a ledger stopped at, the largest allowance a run charged, and a candidate-route refusal's kind;
// and the converted packages' runner through the research route (`tests/families/packages.mjs`).

const plansTool = resolve("tests/families/plans.mjs");
const packagesTool = resolve("tests/families/packages.mjs");
const NAMES = ["forward", "reversed", "forward, unshared", "reversed, unshared"];

/** A ledger whose `stop` records the limit, as the core's `WorkLedger` does, its allowance 1,000 unless given. */
const LEDGER = `export class WorkLedger {
  #stopped = null;
  constructor(allowance = 1000) {
    this.allowance = allowance;
  }
  charge() {}
  stop(limit) {
    this.#stopped ??= limit;
  }
  get stopped() {
    return this.#stopped;
  }
}
export const ledger = () => new WorkLedger();
export const withTestAllowance = (_allowance, run) => run();
export const withTestDemandAllowance = (_demand, run) => run();
`;
const HELD = `export const HELD_MODES = ${JSON.stringify(NAMES)}.map((name) => ({ name, run: (f) => f() }));\n`;
/** A refusal of the candidate route, named and flagged as the core's `CandidateOutsideSlice` is. */
const OUTSIDE = `class Outside extends Error {
  constructor(limit) {
    super("outside");
    this.name = "CandidateOutsideSlice";
    this.limit = limit;
  }
}
`;

function tree(folder: string, modules: Record<string, string>): string {
  for (const [file, text] of Object.entries(modules)) {
    mkdirSync(join(folder, "dist", file, ".."), { recursive: true });
    writeFileSync(join(folder, "dist", file), text);
  }
  writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
  return folder;
}

/** The fields of a compile record the evidence command reads its class from. */
interface Classed {
  readonly allowance: number;
  readonly stopped: string | null;
  readonly outside: string | null;
  readonly thrown: string | null;
  readonly analysed: boolean;
}
interface AreaRecord {
  readonly source: string;
  readonly runs: readonly {
    readonly stopped: readonly (string | null)[];
    readonly unparsed: readonly boolean[];
  }[];
}
interface PlansRecord {
  readonly name: string;
  readonly modes: { base: Classed; head: Classed }[];
}
interface PackageRun {
  readonly analysis: {
    readonly error: string | null;
    readonly codes: Readonly<Record<string, number>>;
    readonly stopped: string | null;
    readonly units: number;
    readonly allowance: number;
  };
  readonly route: { readonly outside: string | null; readonly error: string | null };
}
interface PackageRecord {
  readonly name: string;
  readonly root: number;
  readonly files?: number;
  readonly differing?: number;
  readonly incomplete?: string;
  readonly modes: readonly {
    readonly mode: string;
    readonly same: boolean;
    readonly base: PackageRun;
  }[];
}

/** Each JSON line of a runner's output, as the record `T` that runner writes. */
const jsonLines = <T>(text: string): T[] =>
  text
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line): T => JSON.parse(line));

test("an area run records the limit each tree's ledger stopped at, null where none stopped (#2796)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-evidence-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // (the head alone has no request for `unparsed`)
  const library = (
    head: boolean,
  ) => `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) => [false, true].map((unshared) => ({ reversed, unshared })));
export function publicationHashes(files) {
  if (${head} && files[0].source === "unparsed") return null;
  const ledger = new WorkLedger(1000);
  ledger.charge("frames", 300);
  if (files[0].source === "stops") ledger.stop("work");
  return { parts: ["a"], unanswered: 0 };
}
`;
  const trees = ["base", "head"].map((name) =>
    tree(join(folder, name), {
      "src/type-inference/core/budget.js": LEDGER,
      "tests/helpers/type-core-oracles.js": library(name === "head"),
    }),
  );
  const area = join(folder, "area");
  mkdirSync(area);
  writeFileSync(
    join(area, "g.mjs"),
    `export const cases = [["fine", "fine"], ["stops", "stops"], ["unparsed", "unparsed"]];\n`,
  );
  const work = join(folder, "area.work.jsonl");
  const ran = spawnSync(process.execPath, [runner, area, ...trees, "--work", work], {
    encoding: "utf8",
  });
  // (the unparsed source differs between the trees)
  assert.equal(ran.status, 1, ran.stderr);
  const records = new Map(
    jsonLines<AreaRecord>(readFileSync(work, "utf8"))
      .slice(1, -1)
      .map((r) => [r.source, r]),
  );
  assert.deepEqual(
    ["fine", "stops"].map((name) => records.get(name)!.runs.map((run) => run.stopped)),
    [Array(4).fill([null, null]), Array(4).fill(["work", "work"])],
  );
  // (each tree's own: whether its oracle had no request)
  assert.deepEqual(
    ["fine", "unparsed"].map((name) => records.get(name)!.runs.map((run) => run.unparsed)),
    [Array(4).fill([false, false]), Array(4).fill([false, true])],
  );
});

test("the plans comparison records each compile's allowance, the limit a ledger stopped at and a refusal's kind, which its summary reads (#2796)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-evidence-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const modules = {
    "src/type-inference/core/budget.js": LEDGER,
    "src/compiler.js": `import { ledger } from "./type-inference/core/budget.js";
${OUTSIDE}
export function compileProjectWithBackend(files, options, backend) {
  const source = files[0].source;
  if (source === "unparsed") return { plan: null, diagnostics: [{ code: "TSV001" }] };
  backend.analyze({ files });
  const work = ledger();
  work.charge("frames", 300);
  if (source === "stops") work.stop("work");
  if (source === "limit" || source === "slice") throw new Outside(source === "limit");
  if (source === "throws") throw new Error("thrown");
  return { plan: { instructions: [] }, diagnostics: [] };
}
export const compileSourceWithBackend = (source, options, backend) =>
  compileProjectWithBackend([{ source }], options, backend);
`,
    "src/type-inference/core/backend.js":
      'export const CORE_BACKEND = { name: "core", analyze: () => ({}) };\n',
    "src/type-inference/core/answers.js":
      "class Answers {}\nexport const analyseCore = () => new Answers();\n",
    "tests/helpers/type-core-analysis.js": "export const coreRequest = (files) => ({ files });\n",
    "tests/helpers/type-core-held-host.js": HELD,
  };
  const trees = ["base", "head"].map((name) => {
    const root = tree(join(folder, name), modules);
    mkdirSync(join(root, "tests", "families", "area"), { recursive: true });
    cpSync(resolve("tests/families/sources.mjs"), join(root, "tests/families/sources.mjs"));
    writeFileSync(
      join(root, "tests/families/area/cases.mjs"),
      `export const cases = ${JSON.stringify(["fine", "stops", "limit", "slice", "throws", "unparsed"].map((s) => [s, s]))};\n`,
    );
    return root;
  });
  const out = join(folder, "plans.jsonl");
  const ran = spawnSync(process.execPath, [plansTool, ...trees, "area", "--out", out], {
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  const records = new Map(
    jsonLines<PlansRecord>(readFileSync(out, "utf8")).map((r) => [
      r.name.replace("cases.mjs/", ""),
      r,
    ]),
  );
  const fields = (name: string) =>
    records
      .get(name)!
      .modes.map(({ base, head }) =>
        [base, head].map(({ allowance, stopped, outside }) => ({ allowance, stopped, outside })),
      );
  const each = (one: Omit<Classed, "thrown" | "analysed">) => Array(4).fill([one, one]);
  assert.deepEqual(fields("fine"), each({ allowance: 1000, stopped: null, outside: null }));
  assert.deepEqual(fields("stops"), each({ allowance: 1000, stopped: "work", outside: null }));
  assert.deepEqual(fields("limit"), each({ allowance: 1000, stopped: null, outside: "limit" }));
  assert.deepEqual(fields("slice"), each({ allowance: 1000, stopped: null, outside: "slice" }));
  assert.deepEqual(fields("throws"), each({ allowance: 1000, stopped: null, outside: null }));
  // (whether the checker saw the compile: not where errors before it gave the core no request)
  const analysed = (name: string) =>
    records.get(name)!.modes.flatMap(({ base, head }) => [base.analysed, head.analysed]);
  assert.deepEqual(
    [analysed("fine"), analysed("unparsed")],
    [Array(8).fill(true), Array(8).fill(false)],
  );
  // (a throw by its class and the function and file it is thrown from, no message; a refusal is no throw)
  const thrown = (name: string) => records.get(name)!.modes[0]!.base.thrown;
  assert.deepEqual(
    [thrown("throws"), thrown("limit"), thrown("fine")],
    ["Error at compileProjectWithBackend (src/compiler.js)", null, null],
  );
  // (the summary proves each line's form, the three fields among them)
  const summary = spawnSync(process.execPath, [plansTool, "summary", out], { encoding: "utf8" });
  assert.equal(summary.status, 0, summary.stderr);
  const forged = join(folder, "forged.jsonl");
  const [first] = jsonLines<PlansRecord>(readFileSync(out, "utf8"));
  const forgedMode = {
    ...first!.modes[0]!,
    base: { ...first!.modes[0]!.base, outside: "elsewhere" },
  };
  writeFileSync(
    forged,
    `${JSON.stringify({ ...first, modes: [forgedMode, ...first!.modes.slice(1)] })}\n`,
  );
  const refused = spawnSync(process.execPath, [plansTool, "summary", forged], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr + refused.stdout, /refusal neither limit, slice nor null/);
});

/**
 * A built tree for the packages' runner: its analysis stops for a package whose main file says `stops`, never ends for
 * `hang`; its files give no request for `unparsed`; an answer throws when it is first asked for `lazy`; its route refuses at a limit for `refused`; the head's answers
 * differ for `apart`. Each answer names the
 * mode it ran in, so modes paired by position would differ.
 */
const packageModules = (head: boolean): Record<string, string> => ({
  "src/type-inference/core/budget.js": LEDGER,
  "src/compiler.js": `export function compileProjectWithBackend(files, options, backend) {
  const outcome = backend.analyze({ files });
  return { plan: { instructions: [] }, diagnostics: outcome.checked.diagnostics };
}
`,
  "src/type-inference/core/backend.js": `${OUTSIDE}
export function coreOutcome(request, answers) {
  if (answers !== "past") throw new Error("not the research route");
  if (request.files[0].source.includes("refused")) throw new Outside(true);
  return { checked: { diagnostics: [] }, facts: () => ({ types: new Map([["a", 1]]) }) };
}
`,
  "src/type-inference/core/answers.js": `import { WorkLedger } from "./budget.js";
class Answers {
  constructor(request, budget) {
    this.request = request;
    this.budget = budget;
    this.diagnostics = [{ code: "TSV043" }];
    this.checks = [];
  }
  place() {
    if (this.request.files[0].source.includes("lazy")) throw new TypeError("asked late");
    return globalThis.mode;
  }
}
export function analyseCore(request) {
  const budget = new WorkLedger(2000);
  budget.charge("frames", 500);
  budget.counts = new Map([["frames", 500]]);
  const source = request.files[0]?.source ?? "";
  if (source.includes("stops")) budget.stop("work");
  if (source.includes("hang")) for (;;);
  return new Answers(request, budget);
}
`,
  "tests/helpers/type-core-analysis.js":
    'export const coreRequest = (files) => (files[0].source.includes("unparsed") ? null : { files });\n',
  "tests/helpers/type-core-held-host.js": `export const HELD_MODES = ${JSON.stringify(head ? [...NAMES].reverse() : NAMES)}.map((name) => ({
  name,
  run: (f) => { globalThis.mode = name; try { return f(); } finally { globalThis.mode = undefined; } },
}));
`,
  "tests/helpers/type-core-oracles-answers.js": `export const everyAnswer = (answers) =>
  answers.place() + (${head} && answers.request.files[0].source.includes("apart") ? " apart" : "");
`,
  "src/type-inference/core/check-result/check-result.js":
    "export const checkedResult = () => ({ checks: [] });\n",
});

test("the packages' runner compares each package's analysis and route per mode by name, one process a package, and records hashes, counts and names alone (#2796)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-evidence-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [base, head] = [false, true].map((isHead) =>
    tree(join(folder, isHead ? "head" : "base"), packageModules(isHead)),
  );
  const root = join(folder, "packages");
  const pack = (name: string, main: string) => {
    mkdirSync(join(root, name, "sub"), { recursive: true });
    writeFileSync(join(root, name, "main.tease"), `${main}\n`);
    writeFileSync(join(root, name, "sub", "a.tease"), "say secret text\n");
    writeFileSync(join(root, name, "notes.txt"), "not a file of the project\n");
  };
  pack("fine one", "plain");
  pack("stops", "stops");
  pack("refused", "refused");
  pack("apart", "apart");
  pack("hang", "hang");
  pack("unparsed", "unparsed");
  pack("lazy", "lazy");
  const out = join(folder, "packages.jsonl");
  const ran = spawnSync(
    process.execPath,
    [packagesTool, base!, head!, "--root", root, "--out", out, "--timeout", "5", "--memory", "256"],
    { encoding: "utf8" },
  );
  assert.equal(ran.status, 1, ran.stderr);
  assert.deepEqual(jsonLines<Readonly<Record<string, string | number>>>(ran.stdout).at(-1), {
    packages: "0/1",
    sources: 7,
    differing: 1,
    incomplete: 1,
    timeout: 5,
    memory: 256,
  });
  const text = readFileSync(out, "utf8");
  // (nothing of a package's text leaves its process)
  assert.doesNotMatch(text, /secret|plain/);
  const records = new Map(jsonLines<PackageRecord>(text).map((r) => [r.name, r]));
  assert.deepEqual(records.get("hang"), { name: "hang", root: 0, incomplete: "safety net 5 s" });
  const fine = records.get("fine one")!;
  assert.deepEqual([fine.files, fine.differing], [2, 0]);
  // (each base mode paired with the head's of its name, though their orders differ)
  assert.deepEqual(
    fine.modes.map((m) => [m.mode, m.same]),
    NAMES.map((name) => [name, true]),
  );
  const { analysis, route } = fine.modes[0]!.base;
  assert.deepEqual(
    [
      analysis.error,
      analysis.codes,
      analysis.stopped,
      analysis.units,
      analysis.allowance,
      route.outside,
      route.error,
    ],
    [null, { TSV043: 1 }, null, 500, 2000, null, null],
  );
  assert.equal(records.get("stops")!.modes[0]!.base.analysis.stopped, "work");
  assert.deepEqual(
    [
      records.get("refused")!.modes[0]!.base.route.outside,
      records.get("refused")!.modes[0]!.base.route.error,
    ],
    ["limit", "CandidateOutsideSlice at coreOutcome (src/type-inference/core/backend.js)"],
  );
  // (no request: nothing analysed, the compile still compared)
  const unparsed = records.get("unparsed")!.modes[0]!.base;
  assert.deepEqual(
    [unparsed.analysis, unparsed.route.error],
    [{ analysed: false, error: null, stopped: null, units: 0, allowance: 0 }, null],
  );
  // (an answer that throws when its digest asks it is the analysis's throw, never a digest)
  assert.equal(
    records.get("lazy")!.modes[0]!.base.analysis.error,
    "TypeError at Answers.place (src/type-inference/core/answers.js)",
  );
  const apart = records.get("apart")!;
  assert.deepEqual([apart.differing, apart.modes.every((m) => !m.same)], [4, true]);
});
