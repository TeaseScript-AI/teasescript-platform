#!/usr/bin/env node
// Compares how two builds of this repository compile the same sources, in one process: the evidence that a compiler
// change meant to keep behaviour, such as a refactor, keeps it. Each build is a dist/ that `npm run build:typescript`
// wrote inside its checkout, so the build finds its packages through that checkout. Every module a build loads is its
// own instance, also when --base and --head name the same dist/, so module state such as a counter cannot pass from
// one build to the other.
// The cases: --generated N alternates the head build's generated valid and near-valid sources (the property campaign's
// generator, tests/property/source-fuzz.ts) for index 0 to N-1, each as the main.tease of a single-file project.
// --cases takes a .tease file (a single-file project), a directory with a main.tease (one project of every .tease file
// in it), or any other directory, which it searches for both.
// Each build compiles each case from its source and the tool compares the diagnostics, as
// `path:line:column severity code message` by file and position, and the plan, as JSON with sorted keys. A plan value
// that JSON cannot hold, such as a Set, is converted and reported. With --run, a case with a plan in both builds also
// runs once in each (tests/helpers/flow-differential.ts, within its limits), and the tool compares what each run says,
// its status and its failure; the instructions a run executed are numbered by its own plan, so they are not compared.
// A case is identical or differs, first by error (one build threw), then diagnostics, plan, or runs.
// --time R measures instead: per case one warm-up compile per build, then R rounds of base and head in turn, and it
// prints each build's median compile time and their ratio; with --run it also compares.
// Usage: node tools/compiler-differential.mjs --base <dist> --head <dist> [--generated N --seed S]
//   [--cases <path>]... [--run] [--out <file.json>] [--limit N] [--time R] [--json]
// --limit (20 by default) caps the differing cases it prints, --out writes every case and both builds' forms of each
// difference, and --json prints the summary as JSON. Exit status: 0 all identical (or only timed), 1 any difference,
// 2 usage, a missing or failing build, or an unreadable case.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const usage = `Usage: node tools/compiler-differential.mjs --base <dist> --head <dist> [--generated N --seed S]
  [--cases <path>]... [--run] [--out <file.json>] [--limit N] [--time R] [--json]`;
const BUILD_PARAMETER = "differential-build";
const CLASSES = ["identical", "diagnostics", "plan", "runs", "error"];
// The order in which a case's first difference is chosen: when a build threw, nothing else of it can be compared.
const PRECEDENCE = ["error", "diagnostics", "plan", "runs"];
const SHOWN_LINES = 12;
const SHOWN_VALUE = 160;
// Where only one of two values has an element or a property.
const absent = Symbol("absent");

const options = parseArguments(process.argv.slice(2));

// A URL is one module instance. Each build's imports carry its name in their URL, also into packages, so that the two
// builds share no module, even when they are one dist/ or share a checkout's packages.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const build =
      context.parentURL === undefined
        ? null
        : new URL(context.parentURL).searchParams.get(BUILD_PARAMETER);
    if (build === null || !resolved.url.startsWith("file:")) return resolved;
    const url = new URL(resolved.url);
    url.searchParams.set(BUILD_PARAMETER, build);
    return { ...resolved, url: url.href };
  },
});
const builds = [await loadBuild("base", options.base), await loadBuild("head", options.head)];
if (builds[0].compileProject === builds[1].compileProject)
  failLoad("The two builds share one module instance.");
const [, head] = builds;

const cases = [];
for (let index = 0; index < options.generated; index += 1) {
  const generated =
    index % 2 === 0
      ? head.fuzz.createValidSourceCase(options.seed, index)
      : head.fuzz.createNearValidSourceCase(options.seed, index);
  cases.push({
    id: `generated:${generated.classification}:${options.seed}:${index}`,
    files: [{ path: "main.tease", source: generated.source }],
  });
}
for (const path of options.cases) addCases(resolve(path), cases);

const compare = options.time === 0 || options.run;
const started = performance.now();
const compared = compare ? cases.map(compareCase) : [];
const elapsedMs = performance.now() - started;
const timed = options.time === 0 ? [] : cases.map(timeCase);

const summary = {
  base: builds[0].root,
  head: builds[1].root,
  cases: cases.length,
  ...(compare ? comparisonSummary(compared, elapsedMs) : {}),
  ...(options.time === 0 ? {} : { timing: timingSummary(timed) }),
};
if (options.out !== null) {
  const report = { ...summary, cases: compared.length > 0 ? compared : timed };
  if (compared.length > 0 && timed.length > 0) report.timed = timed;
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
}
if (options.json) console.log(JSON.stringify(summary, null, 2));
else printSummary(summary, compared, timed);
const differs =
  compared.some((entry) => entry.class !== "identical") ||
  timed.some((entry) => entry.threw !== undefined);
// exitCode, not exit(): a forced exit can cut off output still being written to a pipe.
process.exitCode = differs ? 1 : 0;

function parseArguments(args) {
  const parsed = {
    base: null,
    head: null,
    generated: 0,
    seed: null,
    cases: [],
    run: false,
    out: null,
    limit: 20,
    time: 0,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      index += 1;
      if (index === args.length) fail(`${arg} needs a value.`);
      return args[index];
    };
    if (arg === "--base") parsed.base = value();
    else if (arg === "--head") parsed.head = value();
    else if (arg === "--generated") parsed.generated = integer(arg, value(), 0);
    else if (arg === "--seed") parsed.seed = integer(arg, value(), -Infinity);
    else if (arg === "--cases") parsed.cases.push(value());
    else if (arg === "--run") parsed.run = true;
    else if (arg === "--out") parsed.out = value();
    else if (arg === "--limit") parsed.limit = integer(arg, value(), 0);
    else if (arg === "--time") parsed.time = integer(arg, value(), 1);
    else if (arg === "--json") parsed.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    } else fail(`Unknown argument ${arg}.`);
  }
  if (parsed.base === null || parsed.head === null) fail("Both --base and --head are needed.");
  if (parsed.generated > 0 && parsed.seed === null) fail("--generated needs --seed.");
  if (parsed.generated === 0 && parsed.cases.length === 0)
    fail("No cases: give --generated N --seed S or --cases <path>.");
  return parsed;
}

function integer(option, text, minimum) {
  const value = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum)
    fail(`${option} needs an integer${minimum === -Infinity ? "" : ` of at least ${minimum}`}.`);
  return value;
}

async function loadBuild(name, dist) {
  const root = resolve(dist);
  const load = (file) => {
    const path = join(root, file);
    if (!existsSync(path))
      failLoad(`No ${file} in ${root}. Run npm run build:typescript in its checkout.`);
    const url = pathToFileURL(path);
    url.searchParams.set(BUILD_PARAMETER, name);
    return import(url.href);
  };
  try {
    const { compileProject } = await load("src/compiler.js");
    const { compileAndRunVariants } = await load("tests/helpers/flow-differential.js");
    const fuzz = await load("tests/property/source-fuzz.js");
    return { name, root, compileProject, compileAndRunVariants, fuzz };
  } catch (error) {
    failLoad(`Cannot load the ${name} build from ${root}: ${describeError(error)}`);
  }
}

function addCases(path, found) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    fail(`Cannot read ${path}: ${error.message}`);
  }
  if (stats.isDirectory()) {
    const before = found.length;
    searchDirectory(path, found);
    if (found.length === before) fail(`No .tease file in ${path}.`);
  } else if (path.endsWith(".tease"))
    found.push({ id: `file:${shown(path)}`, files: [{ path: "main.tease", source: read(path) }] });
  else fail(`${path} is neither a .tease file nor a directory.`);
}

function searchDirectory(directory, found) {
  if (existsSync(join(directory, "main.tease"))) {
    const paths = teaseFiles(directory).map((path) =>
      relative(directory, path).split(sep).join("/"),
    );
    const files = ["main.tease", ...paths.filter((path) => path !== "main.tease")].map((path) => ({
      path,
      source: read(join(directory, path)),
    }));
    found.push({ id: `project:${shown(directory)}`, files });
    return;
  }
  for (const entry of entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) searchDirectory(path, found);
    else if (entry.isFile() && entry.name.endsWith(".tease"))
      found.push({
        id: `file:${shown(path)}`,
        files: [{ path: "main.tease", source: read(path) }],
      });
  }
}

function teaseFiles(directory) {
  const files = [];
  for (const entry of entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...teaseFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".tease")) files.push(path);
  }
  return files;
}

// By UTF-16 code unit, which does not depend on the locale.
function entries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (error) {
    fail(`Cannot read ${directory}: ${error.message}`);
  }
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`Cannot read ${path}: ${error.message}`);
  }
}

// Relative to the working directory when inside it, so that an id names the same case from the same checkout.
function shown(path) {
  const inside = relative(process.cwd(), path);
  if (inside === "") return ".";
  return inside.startsWith("..") || isAbsolute(inside) ? path : inside.split(sep).join("/");
}

function compareCase(testCase) {
  const [base, head] = builds.map((build) => compileOutcome(build, testCase.files));
  const differences = [];
  let threwInBoth = null;
  const nonJson = [...base.nonJson, ...head.nonJson];
  if (base.threw !== undefined || head.threw !== undefined) {
    if (base.threw === head.threw) threwInBoth = base.threw;
    else differences.push("error");
  } else {
    if (JSON.stringify(base.diagnostics) !== JSON.stringify(head.diagnostics))
      differences.push("diagnostics");
    if (base.planText !== head.planText) differences.push("plan");
    if (options.run && base.plan !== null && head.plan !== null) {
      [base.run, head.run] = builds.map((build) => runOutcome(build, testCase.files));
      nonJson.push(...base.run.nonJson, ...head.run.nonJson);
      if (base.run.threw !== undefined || head.run.threw !== undefined) {
        if (base.run.threw === head.run.threw) threwInBoth = base.run.threw;
        else differences.push("error");
      } else if (base.run.runsText !== head.run.runsText) differences.push("runs");
    }
  }
  differences.sort((a, b) => PRECEDENCE.indexOf(a) - PRECEDENCE.indexOf(b));
  return {
    id: testCase.id,
    class: differences[0] ?? "identical",
    ...(differences.length > 1 ? { differences } : {}),
    ...(base.run === undefined ? {} : { ran: true }),
    ...(threwInBoth === null ? {} : { threwInBoth }),
    ...(nonJson.length === 0 ? {} : { nonJson }),
    ...(differences.length === 0 ? {} : { base: normalised(base), head: normalised(head) }),
  };
}

function compileOutcome(build, files) {
  try {
    const result = build.compileProject(copied(files));
    const nonJson = [];
    const plan = result.plan === null ? null : canonical(result.plan, "plan", nonJson);
    return {
      diagnostics: diagnosticLines(result.diagnostics, files),
      plan,
      planText: JSON.stringify(plan),
      nonJson: nonJson.map((value) => ({ build: build.name, ...value })),
    };
  } catch (error) {
    return { threw: describeError(error), nonJson: [] };
  }
}

function runOutcome(build, files) {
  try {
    const { runs } = build.compileAndRunVariants(copied(files), []);
    const nonJson = [];
    const observed = canonical(
      runs.map(({ present, status, failure, says }) => ({ present, status, failure, says })),
      "runs",
      nonJson,
    );
    return {
      runs: observed,
      runsText: JSON.stringify(observed),
      nonJson: nonJson.map((value) => ({ build: build.name, ...value })),
    };
  } catch (error) {
    return { threw: describeError(error), nonJson: [] };
  }
}

// Each compile gets its own file objects, so no build can see what another did to its input.
function copied(files) {
  return files.map(({ path, source }) => ({ path, source }));
}

function normalised(outcome) {
  if (outcome.threw !== undefined) return { threw: outcome.threw };
  return {
    diagnostics: outcome.diagnostics,
    plan: outcome.plan,
    ...(outcome.run === undefined
      ? {}
      : outcome.run.threw === undefined
        ? { runs: outcome.run.runs }
        : { runsThrew: outcome.run.threw }),
  };
}

// By the case's file order, then position; a sort is stable, so diagnostics at one position keep their order.
// Spans count lines and columns from 0; editors count from 1.
function diagnosticLines(diagnostics, files) {
  const order = (path) => {
    const index = files.findIndex((file) => file.path === path);
    return index === -1 ? files.length : index;
  };
  return [...diagnostics]
    .sort(
      (a, b) =>
        order(a.path) - order(b.path) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.span.start.line - b.span.start.line ||
        a.span.start.column - b.span.start.column,
    )
    .map(
      (d) =>
        `${d.path}:${d.span.start.line + 1}:${d.span.start.column + 1} ${d.severity} ${d.code} ${d.message}`,
    );
}

// The value with sorted object keys. What JSON cannot hold is converted, so it is still compared, and recorded with its
// path in `found`: a Set becomes {"$set": [...]}, a Map {"$map": [[key, value], ...]}, -0, NaN and the infinities
// {"$number": "..."}, and another value {"$<type>": "..."}. An object of a class keeps its own properties.
function canonical(value, path, found) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    const text = Object.is(value, -0) ? "-0" : String(value);
    found.push({ path, kind: text });
    return { $number: text };
  }
  if (Array.isArray(value))
    return value.map((item, index) => canonical(item, `${path}[${index}]`, found));
  if (value instanceof Set) {
    found.push({ path, kind: "Set" });
    return { $set: [...value].map((item, index) => canonical(item, `${path}[${index}]`, found)) };
  }
  if (value instanceof Map) {
    found.push({ path, kind: "Map" });
    return {
      $map: [...value].map(([key, item], index) => [
        canonical(key, `${path}[${index}].key`, found),
        canonical(item, `${path}[${index}].value`, found),
      ]),
    };
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      found.push({ path, kind: `${prototype.constructor?.name ?? "unnamed"} object` });
    if (Object.getOwnPropertySymbols(value).length > 0) found.push({ path, kind: "symbol key" });
    const result = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonical(value[key], `${path}${member(key)}`, found);
    return result;
  }
  found.push({ path, kind: typeof value });
  return { [`$${typeof value}`]: String(value) };
}

function member(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

// The first path at which two canonical values differ, with both values there.
function firstDifference(base, head, path) {
  if (Object.is(base, head)) return null;
  if (Array.isArray(base) && Array.isArray(head)) {
    for (let index = 0; index < Math.max(base.length, head.length); index += 1) {
      const difference = firstDifference(
        index < base.length ? base[index] : absent,
        index < head.length ? head[index] : absent,
        `${path}[${index}]`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  if (isObject(base) && isObject(head)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
    for (const key of keys) {
      const difference = firstDifference(
        Object.hasOwn(base, key) ? base[key] : absent,
        Object.hasOwn(head, key) ? head[key] : absent,
        `${path}${member(key)}`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  return { path, base, head };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeCase(testCase) {
  const rounds = { base: [], head: [] };
  for (const build of builds) {
    try {
      build.compileProject(copied(testCase.files));
    } catch (error) {
      return { id: testCase.id, threw: `${build.name}: ${describeError(error)}` };
    }
  }
  for (let pass = 0; pass < options.time; pass += 1)
    for (const build of builds) {
      const files = copied(testCase.files);
      const start = performance.now();
      build.compileProject(files);
      rounds[build.name].push(performance.now() - start);
    }
  const baseMs = median(rounds.base);
  const headMs = median(rounds.head);
  return { id: testCase.id, baseMs, headMs, ratio: headMs / baseMs, rounds };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function comparisonSummary(entries, milliseconds) {
  const counts = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  for (const entry of entries) counts[entry.class] += 1;
  const differing = entries.filter((entry) => entry.class !== "identical");
  return {
    runsCompared: options.run,
    casesRun: entries.filter((entry) => entry.ran === true).length,
    elapsedMs: round(milliseconds),
    classes: counts,
    threwInBoth: entries
      .filter((entry) => entry.threwInBoth !== undefined)
      .map(({ id, threwInBoth }) => ({ id, threw: threwInBoth })),
    nonJson: entries
      .filter((entry) => entry.nonJson !== undefined)
      .map(({ id, nonJson }) => ({ id, values: nonJson.slice(0, 5), count: nonJson.length })),
    firstDifferences: differing
      .slice(0, options.limit)
      .map((entry) => ({
        id: entry.id,
        class: entry.class,
        ...(entry.differences === undefined ? {} : { differences: entry.differences }),
        detail: detail(entry),
      })),
  };
}

function timingSummary(entries) {
  const measured = entries.filter((entry) => entry.threw === undefined);
  const baseMs = measured.reduce((total, entry) => total + entry.baseMs, 0);
  const headMs = measured.reduce((total, entry) => total + entry.headMs, 0);
  return {
    rounds: options.time,
    cases: entries.map((entry) =>
      entry.threw === undefined
        ? {
            id: entry.id,
            baseMs: round(entry.baseMs),
            headMs: round(entry.headMs),
            ratio: round(entry.ratio),
          }
        : { id: entry.id, threw: entry.threw },
    ),
    totalBaseMs: round(baseMs),
    totalHeadMs: round(headMs),
    ratio: round(headMs / baseMs),
  };
}

// A short account of a difference: the lines only one build has, or the first path at which the values differ.
function detail(entry) {
  const { base, head } = entry;
  if (entry.class === "error") {
    const outcome = (side) =>
      side.threw !== undefined
        ? `threw ${side.threw}`
        : side.runsThrew !== undefined
          ? `run threw ${side.runsThrew}`
          : side.runs !== undefined
            ? "compiled and ran"
            : "compiled";
    return [`- ${outcome(base)}`, `+ ${outcome(head)}`];
  }
  if (entry.class === "diagnostics") return lineDifference(base.diagnostics, head.diagnostics);
  const difference =
    entry.class === "plan"
      ? firstDifference(base.plan, head.plan, "plan")
      : firstDifference(base.runs, head.runs, "runs");
  return [`at ${difference.path}`, `- ${value(difference.base)}`, `+ ${value(difference.head)}`];
}

function lineDifference(baseLines, headLines) {
  const only = (lines, other) => {
    const left = new Map();
    for (const line of other) left.set(line, (left.get(line) ?? 0) + 1);
    return lines.filter((line) => {
      const count = left.get(line) ?? 0;
      left.set(line, count - 1);
      return count === 0;
    });
  };
  const lines = [
    ...only(baseLines, headLines).map((line) => `- ${line}`),
    ...only(headLines, baseLines).map((line) => `+ ${line}`),
  ];
  if (lines.length === 0) return ["the same diagnostics in another order"];
  return lines.length <= SHOWN_LINES
    ? lines
    : [...lines.slice(0, SHOWN_LINES), `… ${lines.length - SHOWN_LINES} more lines`];
}

function value(item) {
  if (item === absent) return "(absent)";
  const text = JSON.stringify(item);
  return text.length <= SHOWN_VALUE ? text : `${text.slice(0, SHOWN_VALUE)}…`;
}

function printSummary(result, entries, timedEntries) {
  console.log(`base ${result.base}\nhead ${result.head}`);
  if (entries.length > 0) {
    const perCase = result.cases === 0 ? 0 : result.elapsedMs / result.cases;
    console.log(
      `${result.cases} cases compared${result.runsCompared ? `, ${result.casesRun} also run,` : ""} in ` +
        `${(result.elapsedMs / 1000).toFixed(1)} s (${perCase.toFixed(1)} ms per case)`,
    );
    for (const name of CLASSES) console.log(`  ${name.padEnd(12)}${result.classes[name]}`);
    for (const { id, threw } of result.threwInBoth)
      console.log(`both builds threw on ${id}: ${threw}`);
    for (const { id, values, count } of result.nonJson)
      console.log(
        `not JSON in ${id}: ${values.map((found) => `${found.build} ${found.path} (${found.kind})`).join(", ")}` +
          `${count > values.length ? `, ${count - values.length} more` : ""}`,
      );
    for (const entry of result.firstDifferences) {
      const also =
        entry.differences === undefined ? "" : ` (also ${entry.differences.slice(1).join(", ")})`;
      console.log(`\n${entry.id}: ${entry.class}${also}`);
      for (const line of entry.detail) console.log(`  ${line}`);
    }
    const differing = entries.length - result.classes.identical;
    if (differing > result.firstDifferences.length)
      console.log(`\n${differing - result.firstDifferences.length} more differing cases not shown`);
  }
  if (timedEntries.length > 0) {
    const timing = result.timing;
    const width = Math.max(4, ...timing.cases.map((entry) => entry.id.length));
    console.log(`\nmedian compile time of ${timing.rounds} rounds`);
    console.log(
      `${"case".padEnd(width)}  ${"base ms".padStart(9)}  ${"head ms".padStart(9)}  ratio`,
    );
    for (const entry of timing.cases)
      console.log(
        entry.threw === undefined
          ? `${entry.id.padEnd(width)}  ${milliseconds(entry.baseMs)}  ${milliseconds(entry.headMs)}  ${entry.ratio.toFixed(2)}`
          : `${entry.id.padEnd(width)}  threw ${entry.threw}`,
      );
    console.log(
      `${"total".padEnd(width)}  ${milliseconds(timing.totalBaseMs)}  ${milliseconds(timing.totalHeadMs)}  ${timing.ratio.toFixed(2)}`,
    );
  }
}

function milliseconds(value) {
  return value.toFixed(2).padStart(9);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function fail(message) {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

function failLoad(message) {
  console.error(message);
  process.exit(2);
}
