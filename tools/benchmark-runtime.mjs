#!/usr/bin/env node
// The runtime benchmark (#827, #1693): the sources of `benchmarks/runtime/` run through the public runtime API.
//
//   node tools/benchmark-runtime.mjs --count-only [--dist DIR] [--all] [--cases A,B] [--update] [--json FILE]
//   node tools/benchmark-runtime.mjs --cpu --base DIR --candidate DIR --out DIR [--all] [--cases A,B]
//                                    [--rounds N] [--warmups N] [--batch N]
//
// A DIR is a `dist/` of `npm run build:typescript`. `--count-only` checks the build (default: this checkout's `dist/`)
// against `benchmarks/runtime/baseline.json`: at every cut (each `stepToEvent` or `observeTime` return, so at every
// event, wait and the end) the instructions so far, the status, the RNG state, a digest of the snapshot without its
// `format` and `version`, and a digest of the events; also each source's hash and the texts its manifest entry states.
// A probe also runs restored from checkpoint JSON at every cut, where it must give the same cuts. `--update` rewrites
// the baseline entries of the cases it ran.
// `--cpu` loads both builds in one process, requires the candidate to equal the base at every cut (instruction counts
// may differ), then times them interleaved, checking every timed run the same way, and writes raw samples and a
// summary under `--out`. CPU never decides the exit status. Exit 0: equal; 1: a difference; 2: a usage or run failure.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const benchmarkDirectory = path.join(root, "benchmarks", "runtime");
const budget = 2_000_000_000;
const maximumCuts = 10_000;

export class UsageError extends Error {}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** A JSON text of `value` with every object's keys sorted, so a digest does not depend on property order. */
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** The digest of a snapshot without its `format` and `version`, which a format revision alone moves. */
export function stateDigest(snapshot) {
  const { format: _format, version: _version, ...content } = snapshot;
  return sha256(canonicalJson(content));
}

export const eventsDigest = (events) => sha256(canonicalJson(events));

/** The names of every case in the manifest, on-demand ones included. */
export const manifestNames = (directory = benchmarkDirectory) =>
  JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")).cases.map(
    (entry) => entry.name,
  );

/** The manifest's cases, each with its source text and hash; `select` picks by name, `all` adds the on-demand ones. */
export function loadCases(directory = benchmarkDirectory, { all = false, select = null } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const known = new Set(manifest.cases.map((entry) => entry.name));
  for (const name of select ?? [])
    if (!known.has(name)) throw new UsageError(`no case '${name}' in ${directory}/manifest.json`);
  return manifest.cases
    .filter((entry) => (select ? select.includes(entry.name) : all || !entry.onDemand))
    .map((entry) => {
      const source = fs.readFileSync(path.join(directory, entry.file), "utf8");
      return {
        ...entry,
        source,
        sourceSha256: sha256(source),
        fresh: {
          seed: entry.seed ?? manifest.seed,
          wallClockMs: manifest.wallClockMs,
          baseDelayMs: 0,
          delayPerWordMs: 0,
          delayPerCharacterMs: 0,
        },
      };
    });
}

/** The runtime API of a `dist/` directory. */
export async function loadRuntime(dist) {
  const entry = path.resolve(dist, "src", "index.js");
  if (!fs.existsSync(entry))
    throw new UsageError(`${entry} does not exist: build with npm run build:typescript`);
  return import(pathToFileURL(entry).href);
}

/** The plan of a case's source; a source that does not compile is a run failure. */
export function compileCase(api, testCase) {
  const compiled = api.compileSource(testCase.source);
  const errors = compiled.diagnostics.filter((item) => item.severity === "error");
  if (!compiled.plan || errors.length > 0)
    throw new Error(`${testCase.name} does not compile: ${JSON.stringify(errors.slice(0, 3))}`);
  return compiled.plan;
}

const cpuUs = (start) => {
  const used = process.cpuUsage(start);
  return used.user + used.system;
};

/**
 * Runs a case to its end and records every cut. With `restore`, the session is replaced at every cut by one restored
 * from its checkpoint's JSON text, which must export the same snapshot. With `timed`, the record also has `cpuUs`,
 * the CPU of the `stepToEvent` and `observeTime` calls alone, and `setupCpuUs`, that of the session's creation; the
 * cut records are made outside those segments, so a timed run is checked like any other.
 */
export function recordCase(
  api,
  testCase,
  { plan = compileCase(api, testCase), restore = false, timed = false } = {},
) {
  let cpu = 0;
  const time = timed
    ? (operation) => {
        const start = process.cpuUsage();
        const result = operation();
        cpu += cpuUs(start);
        return result;
      }
    : (operation) => operation();
  let session = time(() => api.createFreshRuntimeSession(plan, testCase.fresh));
  const setupCpuUs = cpu;
  cpu = 0;
  let instructions = 0;
  const cuts = [];
  const said = [];
  const restoreProblems = [];
  const cut = (kind, result) => {
    instructions += result.instructionsExecuted;
    for (const event of result.events) if (event.kind === "say") said.push(event.text);
    const snapshot = session.exportSnapshot();
    const record = {
      kind,
      instructions,
      status: snapshot.status,
      rng: snapshot.rng,
      events: result.events.length,
      eventsDigest: eventsDigest(result.events),
      stateDigest: stateDigest(snapshot),
    };
    cuts.push(record);
    if (restore) {
      session = api.deserializeRuntimeSession(JSON.stringify(session.exportCheckpoint()));
      const restored = stateDigest(session.exportSnapshot());
      if (restored !== record.stateDigest)
        restoreProblems.push(
          `${testCase.name}: the session restored at cut ${cuts.length} exports another snapshot (${restored})`,
        );
    }
    return snapshot;
  };
  while (cuts.length < maximumCuts) {
    const result = time(() => session.stepToEvent({ instructionBudget: budget }));
    const snapshot = cut("step", result);
    if (snapshot.status === "running") {
      if (result.events.length === 0)
        throw new Error(
          `${testCase.name}: ${budget} instructions did not reach an event, a wait or the end`,
        );
      continue;
    }
    if (snapshot.status !== "waiting") {
      const record = {
        name: testCase.name,
        sourceSha256: testCase.sourceSha256,
        instructions,
        said,
        cuts,
      };
      return {
        ...record,
        ...(restore ? { restoreProblems } : {}),
        ...(timed ? { cpuUs: cpu, setupCpuUs } : {}),
      };
    }
    const deadline = snapshot.foregroundAction?.deadlineMs;
    if (typeof deadline !== "number")
      throw new Error(
        `${testCase.name}: waits for something other than time at cut ${cuts.length}`,
      );
    cut(
      "observe",
      time(() => session.observeTime(deadline)),
    );
  }
  throw new Error(`${testCase.name}: more than ${maximumCuts} cuts`);
}

const cutFields = [
  "kind",
  "instructions",
  "status",
  "rng",
  "events",
  "eventsDigest",
  "stateDigest",
];
const show = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/** Every difference between two records of one case, as text; `fields` limits which cut fields count. */
export function compareRecords(expected, actual, { fields = cutFields, label = actual.name } = {}) {
  const problems = [];
  if (expected.sourceSha256 !== undefined && expected.sourceSha256 !== actual.sourceSha256)
    problems.push(`${label}: source sha256 ${expected.sourceSha256} became ${actual.sourceSha256}`);
  if (fields.includes("instructions") && expected.instructions !== actual.instructions)
    problems.push(`${label}: ${expected.instructions} instructions became ${actual.instructions}`);
  if (canonicalJson(expected.said) !== canonicalJson(actual.said))
    problems.push(`${label}: said ${show(expected.said)}, now ${show(actual.said)}`);
  const length = Math.max(expected.cuts.length, actual.cuts.length);
  for (let index = 0; index < length; index++) {
    const before = expected.cuts[index];
    const after = actual.cuts[index];
    if (before === undefined || after === undefined) {
      problems.push(
        `${label}: ${expected.cuts.length} cuts became ${actual.cuts.length}` +
          ` (cut ${index + 1} is ${before === undefined ? "new" : "gone"})`,
      );
      break;
    }
    for (const field of fields)
      if (canonicalJson(before[field]) !== canonicalJson(after[field]))
        problems.push(
          `${label}: cut ${index + 1} (${before.kind}) ${field} ${show(before[field])} became ${show(after[field])}`,
        );
  }
  return problems;
}

/** The differences of a case's record from what its manifest entry states. */
export function checkStated(testCase, record) {
  if (testCase.said === undefined || canonicalJson(testCase.said) === canonicalJson(record.said))
    return [];
  return [
    `${testCase.name}: says ${show(record.said)}, the manifest states ${show(testCase.said)}`,
  ];
}

/**
 * Records every case and compares it with the baseline (`problems`), and with what holds whatever the baseline says
 * (`invariants`): the manifest's stated texts and, for a probe, its run restored from JSON at every cut.
 */
export function checkCounts(api, cases, baseline) {
  const records = [];
  const problems = [];
  const invariants = [];
  for (const testCase of cases) {
    const plan = compileCase(api, testCase);
    const record = recordCase(api, testCase, { plan });
    records.push(record);
    invariants.push(...checkStated(testCase, record));
    if (testCase.probe) {
      const restored = recordCase(api, testCase, { plan, restore: true });
      invariants.push(
        ...restored.restoreProblems,
        ...compareRecords(record, restored, { label: `${testCase.name} restored at every cut` }),
      );
    }
    const expected = baseline.cases[testCase.name];
    if (expected === undefined) problems.push(`${testCase.name}: not in the baseline`);
    else problems.push(...compareRecords(expected, record));
  }
  return { records, problems, invariants };
}

/** The baseline with the given records' entries replaced, cases outside the manifest dropped, in manifest order. */
export function updatedBaseline(baseline, records, manifestNames) {
  const byName = { ...baseline.cases };
  for (const record of records) {
    const { name, ...entry } = record;
    byName[name] = entry;
  }
  return {
    cases: Object.fromEntries(
      manifestNames.filter((name) => byName[name]).map((name) => [name, byName[name]]),
    ),
  };
}

/** The baseline as JSON text with one line per cut, so an update reads as a small diff. */
export function formatBaseline(baseline) {
  const entries = Object.entries(baseline.cases).map(([name, entry]) => {
    const fields = Object.entries(entry)
      .filter(([key]) => key !== "cuts")
      .map(([key, value]) => `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    const cuts = entry.cuts.map((item) => `        ${JSON.stringify(item)}`).join(",\n");
    return `    ${JSON.stringify(name)}: {\n${fields.join(",\n")},\n      "cuts": [\n${cuts}\n      ]\n    }`;
  });
  return `{\n  "cases": {\n${entries.join(",\n")}\n  }\n}\n`;
}

/**
 * The base and candidate builds on every case: first equal results at every cut (instruction counts may differ),
 * then `warmups` tagged rounds (negative) and `rounds` measured ones, the builds' order alternating per round, each
 * sample `batch` executions (one for a case whose manifest entry has `cpuBatch`). Every timed execution is recorded
 * too and must equal its build's untimed record. Returns the samples, or the differences: when the builds disagree
 * nothing is timed; when a timed execution differs, the measurement stops there.
 */
export function measureCpu(
  builds,
  cases,
  { rounds = 9, warmups = 3, batch = 7, onSample = () => {} } = {},
) {
  const names = Object.keys(builds);
  const plans = {};
  const expected = {};
  const problems = [];
  for (const testCase of cases) {
    const records = {};
    for (const name of names) {
      plans[`${testCase.name}\0${name}`] = compileCase(builds[name], testCase);
      records[name] = recordCase(builds[name], testCase, {
        plan: plans[`${testCase.name}\0${name}`],
      });
      expected[`${testCase.name}\0${name}`] = records[name];
    }
    for (const name of names.slice(1))
      problems.push(
        ...compareRecords(records[names[0]], records[name], {
          fields: cutFields.filter((field) => field !== "instructions"),
          label: `${testCase.name} (${name} against ${names[0]})`,
        }),
      );
  }
  if (problems.length > 0) return { problems, samples: [] };
  const samples = [];
  for (const testCase of cases) {
    const executions = testCase.cpuBatch ?? batch;
    for (let round = -warmups; round < rounds; round++) {
      const shift = (round + warmups) % names.length;
      const order = [...names.slice(shift), ...names.slice(0, shift)];
      for (const name of order) {
        const plan = plans[`${testCase.name}\0${name}`];
        const sample = {
          name: testCase.name,
          build: name,
          round,
          order,
          executions,
          units: testCase.units ?? null,
        };
        let instructions = 0;
        let timed = 0;
        let setupCpuUs = 0;
        for (let repeat = 0; repeat < executions; repeat++) {
          const one = recordCase(builds[name], testCase, { plan, timed: true });
          const differences = compareRecords(expected[`${testCase.name}\0${name}`], one, {
            label: `${testCase.name} (${name}, timed round ${round})`,
          });
          if (differences.length) return { problems: differences, samples };
          instructions += one.instructions;
          timed += one.cpuUs;
          setupCpuUs += one.setupCpuUs;
        }
        Object.assign(sample, {
          instructions,
          cpuUs: timed,
          setupCpuUs,
          suite: Boolean(testCase.suite),
        });
        samples.push(sample);
        onSample(sample);
      }
    }
  }
  return { problems, samples };
}

/** The median, minimum, maximum and count of `values`. */
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted.at(-1), n: sorted.length };
}

/**
 * The report of measured samples (round >= 0): per case and build the instructions per execution and per unit, CPU per
 * unit and per instruction; per case the paired speed `base / candidate` of CPU per execution in matching rounds; and
 * the geometric mean over the suite cases of those paired medians. Report arithmetic only, never a threshold.
 */
export function summarizeCpu(samples, base = "base", candidate = "candidate") {
  const measured = samples.filter((sample) => sample.round >= 0);
  const cases = {};
  for (const name of new Set(measured.map((sample) => sample.name))) {
    const mine = measured.filter((sample) => sample.name === name);
    const builds = {};
    for (const build of new Set(mine.map((sample) => sample.build))) {
      const rows = mine.filter((sample) => sample.build === build);
      const perExecution = rows[0].instructions / rows[0].executions;
      builds[build] = {
        instructionsPerExecution: perExecution,
        ...(rows[0].units ? { instructionsPerUnit: perExecution / rows[0].units } : {}),
        cpuUsPerExecution: distribution(rows.map((row) => row.cpuUs / row.executions)),
        ...(rows[0].units
          ? {
              cpuUsPerUnit: distribution(rows.map((row) => row.cpuUs / row.executions / row.units)),
            }
          : {}),
        cpuNsPerInstruction: distribution(rows.map((row) => (1000 * row.cpuUs) / row.instructions)),
      };
    }
    const byRound = (build) =>
      new Map(mine.filter((row) => row.build === build).map((row) => [row.round, row]));
    const baseRows = byRound(base);
    const candidateRows = byRound(candidate);
    const ratios = [...baseRows.keys()]
      .filter((round) => candidateRows.has(round))
      .map((round) => {
        const a = baseRows.get(round);
        const b = candidateRows.get(round);
        return a.cpuUs / a.executions / (b.cpuUs / b.executions);
      });
    cases[name] = {
      suite: mine[0].suite,
      builds,
      ...(ratios.length ? { pairedSpeed: distribution(ratios) } : {}),
    };
  }
  const suite = Object.values(cases).filter((entry) => entry.suite && entry.pairedSpeed);
  return {
    cpu: "process.cpuUsage() user + system over the run and observeTime calls; session creation and checks excluded",
    pairedSpeed: `${base} CPU / ${candidate} CPU per execution in the same round; above 1 means ${candidate} is faster`,
    suiteGeometricMeanOfPairedMedians: suite.length
      ? Math.exp(
          suite.reduce((sum, entry) => sum + Math.log(entry.pairedSpeed.median), 0) / suite.length,
        )
      : null,
    suiteCases: suite.length,
    cases,
  };
}

function parseArguments(argv) {
  const options = { all: false, update: false };
  const value = (index) => {
    if (index >= argv.length || argv[index].startsWith("--"))
      throw new UsageError(`${argv[index - 1]} needs a value`);
    return argv[index];
  };
  const count = (text, name) => {
    if (!/^\d+$/.test(text)) throw new UsageError(`${name} needs a whole number, not '${text}'`);
    return Number(text);
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--count-only" || argument === "--cpu") {
      if (options.mode) throw new UsageError("give --count-only or --cpu, not both");
      options.mode = argument.slice(2);
    } else if (argument === "--all") options.all = true;
    else if (argument === "--update") options.update = true;
    else if (["--dist", "--base", "--candidate", "--out", "--json"].includes(argument))
      options[argument.slice(2)] = value(++index);
    else if (argument === "--cases") options.cases = value(++index).split(",");
    else if (["--rounds", "--warmups", "--batch"].includes(argument))
      options[argument.slice(2)] = count(value(++index), argument);
    else throw new UsageError(`unknown argument '${argument}'`);
  }
  if (!options.mode) throw new UsageError("give --count-only or --cpu");
  if (options.mode === "cpu" && !(options.base && options.candidate && options.out))
    throw new UsageError("--cpu needs --base, --candidate and --out");
  if (options.mode === "cpu" && options.update)
    throw new UsageError("--update belongs to --count-only");
  if (options.batch === 0) throw new UsageError("--batch needs at least 1");
  return options;
}

const formatCount = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

export async function main(argv, { directory = benchmarkDirectory, log = console.log } = {}) {
  const options = parseArguments(argv);
  const cases = loadCases(directory, { all: options.all, select: options.cases ?? null });
  if (options.mode === "count-only") {
    const api = await loadRuntime(options.dist ?? path.join(root, "dist"));
    const baselineFile = path.join(directory, "baseline.json");
    const baseline = fs.existsSync(baselineFile)
      ? JSON.parse(fs.readFileSync(baselineFile, "utf8"))
      : { cases: {} };
    const { records, problems, invariants } = checkCounts(api, cases, baseline);
    const names = manifestNames(directory);
    for (const name of Object.keys(baseline.cases))
      if (!names.includes(name))
        problems.push(`${name}: in the baseline but not in the manifest (--update removes it)`);
    for (const record of records) {
      const testCase = cases.find((entry) => entry.name === record.name);
      const last = record.cuts.at(-1);
      log(
        `${record.name}: ${record.instructions} instructions` +
          (testCase.units
            ? `, ${formatCount(record.instructions / testCase.units)} per ${testCase.unit}`
            : "") +
          `, ${last.status}, rng ${show(last.rng)}, state ${last.stateDigest.slice(0, 12)},` +
          ` events ${last.eventsDigest.slice(0, 12)}, ${record.cuts.length} cuts`,
      );
    }
    if (options.json) fs.writeFileSync(options.json, `${JSON.stringify(records, null, 1)}\n`);
    for (const problem of invariants) log(`DIFFERENCE ${problem}`);
    if (options.update) {
      if (invariants.length) {
        log("baseline not updated: the differences above hold whatever the baseline says");
        return 1;
      }
      fs.writeFileSync(baselineFile, formatBaseline(updatedBaseline(baseline, records, names)));
      log(`updated ${records.length} cases in ${baselineFile}`);
      return 0;
    }
    for (const problem of problems) log(`DIFFERENCE ${problem}`);
    if (problems.length)
      log(
        "A change of counts or results fails until the baseline is updated on purpose: " +
          "npm run benchmark:runtime -- --count-only --update (add --all for the on-demand cases), and review its diff.",
      );
    else if (!invariants.length) log(`${records.length} cases equal to the baseline`);
    return problems.length || invariants.length ? 1 : 0;
  }
  const builds = {
    base: await loadRuntime(options.base),
    candidate: await loadRuntime(options.candidate),
  };
  const timedCases = options.cases ? cases : cases.filter((entry) => !entry.probe);
  fs.mkdirSync(options.out, { recursive: true });
  const samplesFile = path.join(options.out, "samples.jsonl");
  fs.rmSync(path.join(options.out, "summary.json"), { force: true });
  fs.writeFileSync(samplesFile, "");
  const { problems, samples } = measureCpu(builds, timedCases, {
    rounds: options.rounds,
    warmups: options.warmups,
    batch: options.batch,
    onSample: (sample) => fs.appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`),
  });
  for (const problem of problems) log(`DIFFERENCE ${problem}`);
  if (problems.length) return 1;
  const summary = {
    node: process.version,
    base: path.resolve(options.base),
    candidate: path.resolve(options.candidate),
    samplesSha256: sha256(fs.readFileSync(samplesFile)),
    ...summarizeCpu(samples),
  };
  fs.writeFileSync(path.join(options.out, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  for (const [name, entry] of Object.entries(summary.cases)) {
    const speed = entry.pairedSpeed;
    log(
      `${name}: base/candidate CPU ${speed.median.toFixed(3)} [${speed.min.toFixed(3)}–${speed.max.toFixed(3)}],` +
        ` ${Object.entries(entry.builds)
          .map(
            ([build, figures]) =>
              `${build} ${figures.cpuNsPerInstruction.median.toFixed(1)} ns/instruction`,
          )
          .join(", ")}`,
    );
  }
  if (summary.suiteGeometricMeanOfPairedMedians !== null)
    log(
      `suite (${summary.suiteCases} cases): geometric mean of paired medians ${summary.suiteGeometricMeanOfPairedMedians.toFixed(3)}`,
    );
  log(`samples and summary in ${options.out}; CPU is reported, never checked`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(error instanceof UsageError ? `benchmark-runtime: ${error.message}` : error);
      process.exitCode = 2;
    },
  );
}
