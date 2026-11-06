// Runs the oracle's cases through one root's pipeline, in this process alone (docs/TESTING.md "Runtime pipeline
// oracle"). Usage: node tools/runtime-oracle/run.mjs --root DIR --files FILE [--replace REL=FILE ...] < cases
//
// FILE lists the root's built files (relative to DIR) that it may load; the cases arrive on standard input with their
// source text. Before the root's first import, a resolve hook admits only what `admission.mjs` admits, so this process
// shares no module with another root. The result goes to standard output as one JSON document. `--replace` (tests
// only) loads FILE in place of the root's REL, to check that a changed module is detected; such a run says so.

import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, eventsDigest, sha256, stateDigest } from "../benchmark-runtime.mjs";
import { admits, inventory } from "./admission.mjs";
import { builtPath } from "./closure.mjs";

const BUDGET = 2_000_000_000;
const MAXIMUM_CUTS = 10_000;

function parse(argv) {
  const options = { root: null, files: null, replace: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name === "--root") options.root = path.resolve(value);
    else if (name === "--files") options.files = value;
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
    if (!replacing.has(url) && !admits(admitted, url))
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

/** A diagnostic as compared: what it says and where, in the file it belongs to. */
const diagnostic = (item) => ({
  code: item.code,
  severity: item.severity,
  message: item.message,
  file: item.file ?? null,
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
 * A run of `plan` from fresh options to its end, a wait for input, or a failure: every cut with its digests, and at
 * every cut a restore from the checkpoint's text, which the run goes on with.
 */
function record(plan, fresh) {
  let session = api.createFreshRuntimeSession(plan, fresh);
  let instructions = 0;
  const cuts = [];
  const cut = (kind, result) => {
    instructions += result.instructionsExecuted;
    const snapshot = session.exportSnapshot();
    const checkpoint = api.serializeCheckpoint(session.exportCheckpoint());
    session = api.deserializeRuntimeSession(checkpoint);
    cuts.push({
      kind,
      instructions,
      status: snapshot.status,
      failure: snapshot.failure?.code ?? null,
      rng: snapshot.rng,
      events: result.events.length,
      eventsDigest: eventsDigest(result.events),
      stateDigest: stateDigest(snapshot),
      checkpointDigest: sha256(checkpoint),
      restored: stateDigest(session.exportSnapshot()) === stateDigest(snapshot),
    });
    return snapshot;
  };
  while (cuts.length < MAXIMUM_CUTS) {
    const result = session.stepToEvent({ instructionBudget: BUDGET });
    const snapshot = cut("step", result);
    if (snapshot.status === "running") {
      if (result.events.length === 0) return { cuts, end: "budget" };
      continue;
    }
    if (snapshot.status !== "waiting") return { cuts, end: snapshot.status };
    const deadline = snapshot.foregroundAction?.deadlineMs;
    if (typeof deadline !== "number") return { cuts, end: "input" };
    cut("observe", session.observeTime(deadline));
  }
  return { cuts, end: "cuts" };
}

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
      return { label, ...record(compiled.plan, fresh) };
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
  }),
);
