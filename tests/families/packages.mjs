// node tests/families/packages.mjs <base tree> <head tree> --root <folder> [--root <folder>]... [--shard i/N]
//   [--out f.jsonl] [--timeout 3600] [--memory 6500]
// The converted packages on two built trees, through the core's research route (#2796): each folder below a `--root` is
// one package, every `.tease` file below it a file of its project (`main.tease` first, the rest by path). For each held
// mode (`HELD_MODES`, the base's paired with the head's of the same name), on each tree, the package runs twice:
//   - `analysis`: the core's own analysis of its request (`analyseCore`), past the candidate route's syntax gate: a hash
//     of every answer (`everyAnswer`), of its diagnostics, its checks and its checked result (`checkedResult`), its
//     diagnostics' codes with counts, its counters, the limit a ledger stopped at (`stopped`), an error it threw (its
//     class and place, `throwPlace`);
//   - `route`: the compile with `coreOutcome(request, "past")` as its analysis: hashes of the plan, the diagnostics, the
//     checked result and the settled facts (`facts()`), an error and, for a `CandidateOutsideSlice`, whether it was a
//     limit's (`outside`).
// Both runs also keep their charge trace (each `WorkLedger.charge`'s counter and units folded in order), the questions
// asked of the answers in order, their charged units and the largest allowance of a ledger they charged.
// A package runs in a process of its own with `--memory` MB of heap and a safety net of `--timeout` seconds; a process
// that ends otherwise is recorded as `incomplete` with why, never as agreement. A shard is the packages whose index in
// the sorted list of every root's folders is i modulo N. Each package's record is one JSON line to `--out`: its name,
// its root's index, its files' count, and per mode `same` with both trees' runs; `differing` counts the modes apart.
// Hashes, counts and names only: nothing of a package's text, plan or output leaves the process. The last stdout line
// is the shard's summary: `{ packages, sources, differing, incomplete }`. Exit 0 when every package was compared and
// none differs, else 1; 2 on a usage error.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { throwPlace } from "./thrown.mjs";

const DEFAULTS = { timeout: 3600, memory: 6500 };
const GLOBALS = ["hostValue", "hostOther", "hostInit"];
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The `.tease` files below `folder`, as a project's files: `main.tease` first, the others by path. */
export function filesOf(folder) {
  const walk = (at) =>
    readdirSync(at)
      .sort()
      .flatMap((name) => {
        const file = path.join(at, name);
        return statSync(file).isDirectory() ? walk(file) : [file];
      });
  return walk(folder)
    .filter((file) => file.endsWith(".tease"))
    .map((file) => ({
      path: path.relative(folder, file).split(path.sep).join("/"),
      source: readFileSync(file, "utf8"),
    }))
    .sort((a, b) =>
      a.path === b.path
        ? 0
        : a.path === "main.tease"
          ? -1
          : b.path === "main.tease"
            ? 1
            : a.path < b.path
              ? -1
              : 1,
    );
}

/** Every package below `roots`: each `{ name, root, folder }`, sorted by name, then by root's index. */
export function packagesOf(roots) {
  return roots
    .flatMap((root, index) =>
      readdirSync(root)
        .filter((name) => statSync(path.join(root, name)).isDirectory())
        .map((name) => ({ name, root: index, folder: path.join(root, name) })),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.root - b.root));
}

/**
 * A value as JSON, comparable across two trees: a syntax node as `kind@start-end`, a map's and a set's entries sorted
 * by their JSON, a function as `[fn]`, and an object reached again as the path it was first reached by.
 */
export function encode(value) {
  const seen = new Map();
  const sorted = (entries) =>
    entries
      .map((entry) => [JSON.stringify(entry), entry])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, entry]) => entry);
  const walk = (v, at) => {
    if (typeof v === "function") return "[fn]";
    if (typeof v === "bigint") return `${v}n`;
    if (v === null || typeof v !== "object") return v;
    if (typeof v.kind === "string" && v.span?.start?.offset !== undefined)
      return `${v.kind}@${v.span.start.offset}-${v.span.end.offset}`;
    if (seen.has(v)) return `[seen ${seen.get(v)}]`;
    seen.set(v, at);
    if (v instanceof Map)
      return [
        "Map",
        sorted([...v].map(([k, x], i) => [walk(k, `${at}.k${i}`), walk(x, `${at}.v${i}`)])),
      ];
    if (v instanceof Set) return ["Set", sorted([...v].map((x, i) => walk(x, `${at}.s${i}`)))];
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`));
    return Object.fromEntries(Object.keys(v).map((key) => [key, walk(v[key], `${at}.${key}`)]));
  };
  return JSON.stringify(walk(value, "$"));
}

/** A built tree's modules, its ledger's charges and stops and its answers' questions observed for the run going on. */
async function load(root) {
  const dist = path.basename(root) === "dist" ? root : path.join(root, "dist");
  const imp = (file) => import(pathToFileURL(path.join(dist, file)).href);
  const tree = {
    compiler: await imp("src/compiler.js"),
    backend: await imp("src/type-inference/core/backend.js"),
    budget: await imp("src/type-inference/core/budget.js"),
    held: await imp("tests/helpers/type-core-held-host.js"),
    analysis: await imp("tests/helpers/type-core-analysis.js"),
    answers: await imp("src/type-inference/core/answers.js"),
    oracles: await imp("tests/helpers/type-core-oracles-answers.js"),
    checkResult: await imp("src/type-inference/core/check-result/check-result.js"),
    run: null,
  };
  const fold = (t, text) => {
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      t.a = Math.imul(t.a ^ c, 16777619) >>> 0;
      t.b = Math.imul(t.b ^ c, 2246822519) >>> 0;
    }
    t.a = Math.imul(t.a ^ 0xff, 16777619) >>> 0;
  };
  // (every question asked of the answers, in order, as `plans.mjs` folds them)
  const probe = tree.analysis.coreRequest(
    [{ path: "main.tease", source: "let a = 1\nexit\n" }],
    ["hostValue"],
  );
  const answers = Object.getPrototypeOf(tree.answers.analyseCore(probe));
  const argText = (v) =>
    typeof v === "number" || typeof v === "string"
      ? String(v)
      : Array.isArray(v)
        ? v.join("\u0001")
        : v === null || v === undefined
          ? "~"
          : typeof v.id === "number"
            ? `#${v.id}`
            : typeof v.property === "string"
              ? `.${v.property}`
              : "?";
  for (const method of [
    "place",
    "placeProperties",
    "requirement",
    "at",
    "project",
    "properties",
    "targetName",
    "valueAt",
    "view",
    "stoppedAt",
  ]) {
    const asked = answers[method];
    if (typeof asked !== "function") continue;
    answers[method] = function (...args) {
      if (tree.run !== null) {
        tree.run.questions.n += 1;
        fold(tree.run.questions, `${method}(${args.map(argText).join(",")})`);
      }
      return asked.apply(this, args);
    };
  }
  const ledger = tree.budget.WorkLedger.prototype;
  const { charge, stop } = ledger;
  ledger.charge = function (counter, units = 1) {
    const r = tree.run;
    if (r !== null) {
      r.trace.n += 1;
      r.trace.units += units;
      fold(r.trace, `${counter}:${units}`);
      if (Number.isInteger(this.allowance) && this.allowance > r.allowance)
        r.allowance = this.allowance;
    }
    return charge.call(this, counter, units);
  };
  if (typeof stop === "function")
    ledger.stop = function (limit) {
      if (tree.run !== null) tree.run.stopped ??= limit;
      return stop.call(this, limit);
    };
  return tree;
}

/** `make()` on `tree` with its charges, stops and questions observed: its result, or the error it threw, and those. */
function observed(tree, make) {
  const run = {
    trace: { n: 0, units: 0, a: 2166136261, b: 3266489917 },
    questions: { n: 0, a: 2166136261, b: 3266489917 },
    allowance: 0,
    stopped: null,
  };
  tree.run = run;
  let error = null;
  let value;
  try {
    value = make();
  } catch (thrown) {
    error = thrown;
  } finally {
    tree.run = null;
  }
  const { trace: t, questions: q } = run;
  return {
    value,
    error,
    kept: {
      trace: `${t.n}/${t.units}/${t.a.toString(16)}${t.b.toString(16)}`,
      questions: `${q.n}/${q.a.toString(16)}${q.b.toString(16)}`,
      units: t.units,
      allowance: run.allowance,
      stopped: run.stopped,
    },
  };
}

/** An error by its class and the function and file it is thrown from (`throwPlace`): a message can quote the text. */
const errorText = (error) => (error === null ? null : throwPlace(error));

/** A part of a result as its hash, or as the error that kept it from being made. */
function part(make) {
  try {
    return sha(make());
  } catch (error) {
    return errorText(error);
  }
}

function codesOf(diagnostics) {
  const codes = {};
  for (const d of diagnostics ?? []) codes[d.code ?? "?"] = (codes[d.code ?? "?"] ?? 0) + 1;
  return codes;
}

/**
 * The core's own analysis of the package in `mode`, past the syntax gate, every digest made inside the mode as the
 * analysis was (an answer can be computed lazily, when it is first asked); `units` the analysis's own, before its
 * digests' questions, which its trace and questions do count.
 */
function analysed(tree, mode, files) {
  const request = tree.analysis.coreRequest(files, GLOBALS);
  const made = {};
  let units = 0;
  const { error, kept } = observed(tree, () =>
    mode.run(() => {
      const a = tree.answers.analyseCore(request);
      units = tree.run.trace.units;
      Object.assign(made, {
        answers: part(() => tree.oracles.everyAnswer(a)),
        diagnostics: part(() => encode(a.diagnostics)),
        codes: codesOf(a.diagnostics),
        checks: part(() => encode(a.checks)),
        counts: part(() => encode([...a.budget.counts].sort())),
        checked: part(() => encode(tree.checkResult.checkedResult(a, request))),
      });
    }),
  );
  return { error: errorText(error), ...made, ...kept, units: error === null ? units : kept.units };
}

/**
 * The package's compile in `mode` with the core's research route (`coreOutcome(request, "past")`) as its analysis, its
 * digests made inside the mode.
 */
function routed(tree, mode, files) {
  const made = { plan: null, diagnostics: null, codes: {}, checked: null, facts: null };
  const backend = {
    name: "core",
    analyze(request) {
      const outcome = tree.backend.coreOutcome(request, "past");
      made.checked = part(() => encode(outcome.checked));
      made.facts = part(() => encode(outcome.facts()));
      return outcome;
    },
  };
  const { error, kept } = observed(tree, () =>
    mode.run(() => {
      const result = tree.compiler.compileProjectWithBackend(files, { globals: GLOBALS }, backend);
      made.plan = result?.plan == null ? null : sha(JSON.stringify(result.plan));
      made.diagnostics = sha(JSON.stringify(result.diagnostics));
      made.codes = codesOf(result.diagnostics);
    }),
  );
  return {
    ...made,
    error: errorText(error),
    outside:
      error?.name === "CandidateOutsideSlice" ? (error.limit === true ? "limit" : "slice") : null,
    ...kept,
  };
}

/** One package's record on two trees (the child's work). */
async function compared(baseRoot, headRoot, pkg) {
  const files = filesOf(pkg.folder);
  const base = await load(baseRoot);
  const head = await load(headRoot);
  const record = { name: pkg.name, root: pkg.root, files: files.length, differing: 0, modes: [] };
  for (const mode of base.held.HELD_MODES) {
    const other = head.held.HELD_MODES.find((m) => m.name === mode.name);
    if (other === undefined) throw new Error(`the head has no held mode ${mode.name}`);
    const b = { analysis: analysed(base, mode, files), route: routed(base, mode, files) };
    const h = { analysis: analysed(head, other, files), route: routed(head, other, files) };
    const same = JSON.stringify(b) === JSON.stringify(h);
    if (!same) record.differing += 1;
    record.modes.push({ mode: mode.name, same, base: b, head: h });
  }
  return record;
}

function usage(message) {
  process.stderr.write(`packages: ${message}\n`);
  process.exit(2);
}

function parse(argv) {
  const positional = [];
  const options = { root: [], ...DEFAULTS, shard: "0/1" };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (!["root", "shard", "out", "timeout", "memory", "one"].includes(key))
      usage(`unknown option ${argument}`);
    if (i + 1 >= argv.length) usage(`${argument} needs a value`);
    const value = argv[(i += 1)];
    if (key === "root") options.root.push(value);
    else options[key] = value;
  }
  return { positional, options };
}

if (import.meta.main) {
  const { positional, options } = parse(process.argv.slice(2));
  const [baseRoot, headRoot] = positional;
  if (headRoot === undefined) usage("two trees are needed");
  if (options.one !== undefined) {
    // (the child: one package, by its folder and its root's index)
    const [root, folder] = JSON.parse(options.one);
    process.stdout.write(
      `${JSON.stringify(await compared(baseRoot, headRoot, { name: path.basename(folder), root, folder }))}\n`,
    );
  } else {
    if (options.root.length === 0) usage("no --root");
    const [i, n] = options.shard.split("/").map(Number);
    if (!(Number.isInteger(i) && Number.isInteger(n) && n > 0 && i >= 0 && i < n))
      usage(`--shard ${options.shard}`);
    const timeout = Number(options.timeout);
    const memory = Number(options.memory);
    if (!(timeout > 0 && memory > 0)) usage("--timeout and --memory take positive numbers");
    const mine = packagesOf(options.root).filter((_, index) => index % n === i);
    const summary = {
      packages: `${i}/${n}`,
      sources: mine.length,
      differing: 0,
      incomplete: 0,
      timeout,
      memory,
    };
    for (const pkg of mine) {
      const child = spawnSync(
        process.execPath,
        [
          `--max-old-space-size=${memory}`,
          fileURLToPath(import.meta.url),
          baseRoot,
          headRoot,
          "--one",
          JSON.stringify([pkg.root, pkg.folder]),
        ],
        {
          encoding: "utf8",
          timeout: timeout * 1000,
          maxBuffer: 1 << 28,
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      const line = child.stdout.split("\n").find((text) => text.startsWith("{"));
      let record;
      if (child.status === 0 && line !== undefined) record = JSON.parse(line);
      else {
        const why =
          child.error?.code === "ETIMEDOUT"
            ? `safety net ${timeout} s`
            : child.signal !== null
              ? `signal ${child.signal}`
              : `exit ${child.status}`;
        record = { name: pkg.name, root: pkg.root, incomplete: why };
        summary.incomplete += 1;
      }
      if ((record.differing ?? 0) > 0) summary.differing += 1;
      if (options.out !== undefined) appendFileSync(options.out, `${JSON.stringify(record)}\n`);
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = summary.differing + summary.incomplete === 0 ? 0 : 1;
  }
}
