// Runs the oracle's cases through one root's pipeline, in this process alone (docs/TESTING.md "Runtime pipeline
// oracle"). Usage: node tools/runtime-oracle/run.mjs --root DIR --files FILE [--timed N] [--replace REL=FILE ...] < cases
//
// FILE lists the root's built files (relative to DIR) that it may load; the cases arrive on standard input with their
// source text. Before the root's first import, a resolve hook admits only what `admission.mjs` admits, so this process
// shares no module with another root. The result goes to standard output as one JSON document. `--replace` (tests
// only) loads FILE in place of the root's REL, to check that a changed module is detected; such a run says so.
// `--timed N` also runs each uninterrupted transcript N more times and reports their CPU beside the results, each
// sample's transcript checked against the untimed one; CPU only describes, it decides nothing.

import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, eventsDigest, sha256, stateDigest } from "../benchmark-runtime.mjs";
import { admitsUrl, inventory } from "./admission.mjs";
import { builtPath } from "./closure.mjs";

const BUDGET = 2_000_000_000;
const MAXIMUM_CUTS = 10_000;

function parse(argv) {
  const options = { root: null, files: null, replace: new Map(), timed: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name === "--root") options.root = path.resolve(value);
    else if (name === "--files") options.files = value;
    else if (name === "--timed") options.timed = Number(value);
    else if (name === "--replace") {
      const [relative, file] = value.split("=");
      options.replace.set(relative, path.resolve(file));
    } else throw new Error(`unknown option ${name}`);
    index += 1;
  }
  if (options.root === null || options.files === null)
    throw new Error("usage: run.mjs --root DIR --files FILE [--replace REL=FILE ...] < cases");
  return options;
}

const options = parse(process.argv.slice(2));
const builtFiles = JSON.parse(fs.readFileSync(options.files, "utf8"));
const admitted = inventory(options.root, builtFiles);
const replacements = new Map(
  [...options.replace].map(([relative, file]) => [
    pathToFileURL(fs.realpathSync(path.join(options.root, relative))).href,
    pathToFileURL(file).href,
  ]),
);
const replacing = new Set(replacements.values());
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url = replacements.get(resolved.url) ?? resolved.url;
    if (!replacing.has(url) && !admitsUrl(admitted, url))
      throw new Error(
        `runtime oracle: '${specifier}' resolves outside the root's inventory (${url})`,
      );
    return { ...resolved, url };
  },
});

const load = (source) => import(pathToFileURL(path.join(options.root, builtPath(source))).href);
const api = await load("src/index.ts");
const compiler = await load("src/compiler.ts");
const core = await load("src/type-inference/core/backend.ts");
const budget = await load("src/type-inference/core/budget.ts");
const json = await load("src/runtime/snapshot/checkpoint-json.ts");

/** A diagnostic as compared: what it says and where, in the project file it belongs to. */
const diagnostic = (item) => ({
  code: item.code,
  severity: item.severity,
  message: item.message,
  path: item.path ?? null,
  span: [item.span.start.offset, item.span.end.offset],
});

function compile(testCase, route) {
  const sources = testCase.sources;
  const compileOptions = testCase.options ?? {};
  const run = () => {
    if (route === "legacy")
      return testCase.project
        ? api.compileProject(sources, compileOptions)
        : api.compileSource(sources[0].source, compileOptions);
    return testCase.project
      ? compiler.compileProjectWithBackend(sources, compileOptions, core.CORE_BACKEND)
      : compiler.compileSourceWithBackend(sources[0].source, compileOptions, core.CORE_BACKEND);
  };
  return testCase.allowance === undefined
    ? run()
    : budget.withTestAllowance(testCase.allowance, run);
}

/**
 * A transcript of `plan` from fresh options to its end, a wait for input, or a failure: every cut with its digests.
 * `restoring` replaces the session at every cut by one restored from its checkpoint's text, which the run goes on with;
 * otherwise the same session runs uninterrupted.
 */
function transcript(plan, fresh, restoring) {
  let session = api.createFreshRuntimeSession(plan, fresh);
  let instructions = 0;
  const cuts = [];
  const checkpoints = [];
  const cut = (kind, result) => {
    instructions += result.instructionsExecuted;
    const snapshot = session.exportSnapshot();
    const record = {
      kind,
      instructions,
      status: snapshot.status,
      failure: snapshot.failure?.code ?? null,
      rng: snapshot.rng,
      events: result.events.length,
      eventsDigest: eventsDigest(result.events),
      stateDigest: stateDigest(snapshot),
    };
    cuts.push(record);
    if (restoring) {
      const checkpoint = api.serializeCheckpoint(session.exportCheckpoint());
      checkpoints.push(sha256(checkpoint));
      session = api.deserializeRuntimeSession(checkpoint);
      // The restored state itself, observed at once, also at the last cut, where nothing runs after it. A restore that
      // changed it records what it restored, which the uninterrupted transcript never has.
      const restored = stateDigest(session.exportSnapshot());
      if (restored !== record.stateDigest) record.restoredStateDigest = restored;
    }
    return snapshot;
  };
  const done = (end) => (restoring ? { cuts, end, checkpoints } : { cuts, end });
  while (cuts.length < MAXIMUM_CUTS) {
    const result = session.stepToEvent({ instructionBudget: BUDGET });
    const snapshot = cut("step", result);
    if (snapshot.status === "running") {
      if (result.events.length === 0) return done("budget");
      continue;
    }
    if (snapshot.status !== "waiting") return done(snapshot.status);
    const deadline = snapshot.foregroundAction?.deadlineMs;
    if (typeof deadline !== "number") return done("input");
    cut("observe", session.observeTime(deadline));
  }
  return done("cuts");
}

/**
 * A run of `plan`: its uninterrupted transcript, and the transcript of the same run restored at every cut, which must
 * agree with it (`compare.mjs` checks that within each build first).
 */
function record(plan, fresh) {
  const { cuts, end } = transcript(plan, fresh, false);
  // A restored run that throws is recorded as such, so the within-build check fails it as its own class.
  let restored;
  try {
    restored = transcript(plan, fresh, true);
  } catch (error) {
    restored = { threw: String(error?.message ?? error) };
  }
  return { cuts, end, restored };
}

/** `options.timed` CPU samples of `plan`'s uninterrupted transcript, each checked against `untimed`. */
function timedSamples(plan, fresh, untimed) {
  const expected = canonicalJson(untimed);
  const samples = [];
  for (let sample = 0; sample < options.timed; sample += 1) {
    const start = process.cpuUsage();
    const timed = transcript(plan, fresh, false);
    const used = process.cpuUsage(start);
    samples.push({
      cpuUs: used.user + used.system,
      matched: canonicalJson({ cuts: timed.cuts, end: timed.end }) === expected,
    });
  }
  return samples;
}

const timing = {};

function result(testCase, route) {
  let compiled;
  try {
    compiled = compile(testCase, route);
  } catch (error) {
    if (error instanceof core.CandidateOutsideSlice)
      return { classification: "unsupported-core", reason: error.message };
    return { classification: "compiler-threw", reason: String(error?.message ?? error) };
  }
  const diagnostics = compiled.diagnostics.map(diagnostic);
  if (compiled.plan === null || compiled.plan === undefined)
    return { classification: "not-compiled", diagnostics };
  const planJson = json.serializeValidatedRuntimeJson(compiled.plan);
  const runs = (testCase.runs ?? [{ label: "run", fresh: {} }]).map(({ label, fresh }) => {
    try {
      const run = record(compiled.plan, fresh);
      if (options.timed > 0)
        (timing[`${testCase.name}/${route}`] ??= []).push({
          label,
          samples: timedSamples(compiled.plan, fresh, { cuts: run.cuts, end: run.end }),
        });
      return { label, ...run };
    } catch (error) {
      return { label, threw: String(error?.message ?? error) };
    }
  });
  return {
    classification: "compiled",
    diagnostics,
    plan: { sha256: sha256(planJson), bytes: planJson.length },
    runs,
  };
}

const cases = JSON.parse(fs.readFileSync(0, "utf8"));
const results = {};
for (const testCase of cases)
  for (const route of testCase.routes)
    results[`${testCase.name}/${route}`] = result(testCase, route);
process.stdout.write(
  canonicalJson({
    replaced: replacing.size > 0,
    formats: {
      plan: api.INSTRUCTION_PLAN_VERSION,
      snapshot: api.RUNTIME_SNAPSHOT_VERSION,
      checkpoint: api.CHECKPOINT_VERSION,
    },
    results,
    ...(options.timed > 0 ? { timing } : {}),
  }),
);
