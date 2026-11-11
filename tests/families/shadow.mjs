// node tests/families/shadow.mjs <tree> <set> [--shard i/N] [--out f.jsonl] [--decisions f.jsonl] [--units 4]
//   [--timeout 1800] [--memory 2048] [--only names.json] [--limit n] [--demands 16] [--manifest]
// The shadow comparison (S9b's interim and S11's final shadow suite; #1704 landed it from the S11 readiness research's
// copy): each source of a set compiled through both public routes of one built tree, the legacy backend
// (`compileProjectWithBackend` with the production default) and the core (`decisionRecords`, its receiving completion
// included), in the four modes (`MODES`), and one JSON line per source to `--out` with each route's outcome per mode and
// where both have one, what differs. It classifies nothing: `shadow-classify.mjs` does (README "Shadow").
//   <set>: corpus (CASES_JSON=<cases.json>), fixture (the tree's tools/corpus/fixture), or an area of tests/families by
//   its name or folder (its generators' sources at their own sizes, `sources.mjs`).
// Each route runs in a process of its own (#1738) with `--memory` MB of old generation, which takes its runs (one route
// in one mode) in turn until one fails, so a heap abort or any other end of that process ends that run only. A route's
// process starts without the caller's NODE_OPTIONS, whose heap flags would set its limit beside `--memory` (#2329), and
// gets no other Node option from the caller either. A run fails where its heap is exhausted, where its charged units pass
// `--units` times the largest allowance of a ledger it charged (#1647's rule; the legacy route charges none), where it
// passes the safety net of `--timeout` seconds, or where its worker ends. A failed run is recorded with its route, mode,
// the phase it was in (`phase`: `parse and names`, `analysis`, `analysis pass k`, `completion`, `lowering`, the core's
// with its route's text, `record`), its failure and its worker's heap limit as V8 measured it (`heapMiB`); the source's
// other runs go on, and a fresh worker takes the route's next run. A worker that ran anything before carries its memory
// along, so its heap failure or safety net is ambiguous: that run is retried once in a fresh worker, whose result is the
// run's (`retried` names the first failure), and `runsBeforeFailure` tells a fresh worker's failure (0) from a reused
// one's. A worker that ends or throws after a run's outcome keeps that outcome and is replaced (`replaced`), also where
// its end reaches the next run before that run's first phase. A source with a failed run is `incomplete`, never
// agreement. Resumes: a source already in `--out` is not run again, its record counted as it stands. Prints one JSON
// summary line (`differing` counts sources); exit 0 when every run has an outcome, else 1. `--demands 16` (the S11
// gate's completion control: nothing stops at the natural allowance on current main, so no natural run reaches a
// receiving completion) also runs the core route of each source in the four modes at each of these demand
// allowances, and records each run's outcome and decision counts under `demands` (`{ demand, rows }`), a failure as
// the natural runs' are; the legacy route has no demand allowance.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";

/** The exit of a worker whose run passed the unit limit, after it posted the run's units (`over`). */
const OVER_EXIT = 86;
/** The start of a line a route's process writes on its stderr to say where it is, read whatever way it ends. */
const MARK = "\u0001shadow ";
/** A route's process: its settings in this variable (JSON), set only for it. */
const CHILD = "SHADOW_ROUTE";
const isMainThread = process.env[CHILD] === undefined;

/**
 * A route's worker: a process of its own (#1738: a worker thread's heap abort could end the whole runner), with the
 * worker thread's events. Its stderr marks (`MARK`, written synchronously, so they outlive an abort) give its heap
 * limit, each run's phases and the units of a run past the limit; an end whose stderr has V8's heap message is an
 * `error` with ERR_WORKER_OUT_OF_MEMORY, any other end an `exit` with its code or signal. Outcomes come over IPC.
 */
class RouteProcess extends EventEmitter {
  constructor(file, settings, memory) {
    super();
    this.tail = "";
    this.line = "";
    const { NODE_OPTIONS: _, ...env } = process.env;
    this.child = fork(file, [], {
      execArgv: [`--max-old-space-size=${memory}`],
      env: { ...env, [CHILD]: JSON.stringify(settings) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    this.child.stderr.setEncoding("utf8").on("data", (chunk) => {
      const lines = (this.line + chunk).split("\n");
      this.line = lines.pop();
      for (const line of lines)
        if (line.startsWith(MARK)) this.emit("message", JSON.parse(line.slice(MARK.length)));
        else this.tail = `${this.tail}${line}\n`.slice(-4096);
    });
    this.child.on("message", (message) => this.emit("message", message));
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("close", (code, signal) => {
      if (/JavaScript heap out of memory/.test(this.tail + this.line))
        this.emit("error", { code: "ERR_WORKER_OUT_OF_MEMORY" });
      else this.emit("exit", code ?? signal);
    });
  }
  postMessage(message) {
    this.child.send(message);
  }
  async terminate() {
    this.child.kill("SIGKILL");
    await this.closed;
  }
}
const ROUTES = ["legacy", "core"];

const distOf = (root) => (existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root);
const setOf = (set, root) =>
  ["corpus", "fixture"].includes(set) || set.includes("/")
    ? set
    : path.join(root, "tests", "families", set);
const hash = (text) => createHash("sha256").update(text).digest("hex");

/** The set's sources, each `{ name, files, globals }`, the same list in every worker. */
async function sourcesOfSet(set, root) {
  if (set === "corpus")
    return JSON.parse(readFileSync(process.env.CASES_JSON, "utf8")).map(({ name, files }) => ({
      name,
      files,
      globals: ["hostValue", "hostOther", "hostInit"],
    }));
  if (set === "fixture") {
    const fixture = await import(
      pathToFileURL(path.join(root, "tools", "corpus", "fixture", "fixture.mjs")).href
    );
    return fixture.cases.map(([name, files]) => ({ name, files, globals: fixture.globals }));
  }
  const { generatorsOf } = await import(
    pathToFileURL(path.join(root, "tests", "families", "sources.mjs")).href
  );
  return (await generatorsOf(set)).flatMap((generator) =>
    generator.sources.map((source) => ({
      name: `${generator.name}/${source.name}`,
      files: source.files,
      globals: source.globals,
    })),
  );
}

/** The first `limit` paths at which two plans differ, with both values, and how many more (`more`). */
function delta(a, b, limit = 80) {
  const diffs = [];
  const stack = [["", a, b]];
  let more = 0;
  while (stack.length > 0) {
    const [at, x, y] = stack.pop();
    if (x === y) continue;
    if (diffs.length === limit) {
      more += stack.length + 1;
      break;
    }
    if (
      x &&
      y &&
      typeof x === "object" &&
      typeof y === "object" &&
      Array.isArray(x) === Array.isArray(y)
    ) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().reverse();
      for (const key of keys) stack.push([`${at}/${key}`, x[key], y[key]]);
    } else diffs.push({ path: at, legacy: x, core: y });
  }
  return { diffs, more };
}

if (isMainThread) {
  const [root, given, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(name);
    return at < 0 ? undefined : rest[at + 1];
  };
  const refused = (why) => {
    process.stderr.write(`shadow.mjs: ${why}\n`);
    process.exit(2);
  };
  if (given === undefined) refused("usage: shadow.mjs <tree> <set> [options]");
  const set = setOf(given, root);
  const [shard, shards] = (option("--shard") ?? "0/1").split("/").map(Number);
  const out = option("--out");
  const decisionsOut = option("--decisions");
  const limit = option("--limit") === undefined ? Infinity : Number(option("--limit"));
  const units = option("--units") === "none" ? null : Number(option("--units") ?? 4);
  if (units !== null && !(Number.isInteger(units) && units > 0))
    refused(`--units ${option("--units")} is no positive whole multiple of the allowance, or none`);
  const seconds = Number(option("--timeout") ?? 1800);
  const memory = Number(option("--memory") ?? 2048);
  const demands = (option("--demands") ?? "").split(",").filter(Boolean).map(Number);
  if (!demands.every((d) => Number.isInteger(d) && d > 0))
    refused(`--demands ${option("--demands")} is no list of positive whole demand allowances`);
  const sources = await sourcesOfSet(set, root);
  const only =
    option("--only") === undefined
      ? null
      : new Set(JSON.parse(readFileSync(option("--only"), "utf8")));
  const indices = sources
    .map((_, index) => index)
    .filter((index) => (only === null ? index % shards === shard : only.has(sources[index].name)))
    .slice(0, limit);
  const { sourceKey } = await import(
    pathToFileURL(path.join(root, "tests", "families", "sources.mjs")).href
  );
  // (--manifest: the sources these options owe, one `{ key, name }` line each, for shadow-classify.mjs's --expect)
  if (rest.includes("--manifest")) {
    for (const index of indices)
      console.log(JSON.stringify({ key: sourceKey(sources[index]), name: sources[index].name }));
    process.exit(0);
  }
  // (a source already in --out is not run again, its record counted as it stands: a failure stays a failure)
  const done = new Map();
  if (out !== undefined && existsSync(out))
    for (const line of readFileSync(out, "utf8").split("\n"))
      if (line.startsWith("{")) {
        const record = JSON.parse(line);
        done.set(record.name, record);
      }
  const summary = {
    set: path.basename(set),
    shard: `${shard}/${shards}`,
    sources: indices.length,
    resumed: 0,
    runs: 0,
    failed: 0,
    retried: 0,
    replaced: 0,
    incomplete: 0,
    differing: 0,
    units,
    timeout: seconds,
    memory,
    demands,
    node: process.version,
  };

  /** A source's record into the summary, as it ran or as `--out` kept it. */
  function count(record) {
    for (const row of record.rows)
      for (const route of ROUTES) {
        summary.runs += 1;
        if (row[route].outcome === "failed") summary.failed += 1;
        if (row[route].retried !== undefined) summary.retried += 1;
      }
    for (const { rows } of record.demands ?? [])
      for (const row of rows) {
        summary.runs += 1;
        if (row.core.outcome === "failed") summary.failed += 1;
        if (row.core.retried !== undefined) summary.retried += 1;
      }
    if (
      record.rows.some((row) => row.delta !== undefined && Object.values(row.delta).some(Boolean))
    )
      summary.differing += 1;
    if (record.incomplete) summary.incomplete += 1;
  }

  /**
   * Each route's worker, the runs it took since it was fresh, its heap limit as it measured it (`limitMiB`), and whether
   * it ended or threw between runs (`ended`): its listeners live as long as it does, so nothing it throws ends the batch.
   */
  const workers = new Map(
    ROUTES.map((route) => [route, { worker: null, runs: 0, limitMiB: null, ended: false }]),
  );
  const fresh = (route) => {
    const slot = workers.get(route);
    const worker = new RouteProcess(
      fileURLToPath(import.meta.url),
      { root, set, units, route },
      memory,
    );
    Object.assign(slot, { worker, runs: 0, limitMiB: null, ended: false });
    worker
      .on("message", (message) => {
        if (message.limitMiB !== undefined && slot.worker === worker)
          slot.limitMiB = message.limitMiB;
      })
      // (a retired worker's late events are its own, not its successor's)
      .on("error", () => {
        if (slot.worker === worker) slot.ended = true;
      })
      .on("exit", () => {
        if (slot.worker === worker) slot.ended = true;
      });
    return slot;
  };
  const retire = async (route) => {
    const slot = workers.get(route);
    await slot.worker?.terminate().catch(() => {});
    Object.assign(slot, { worker: null, ended: false });
  };

  /** One run in the route's worker: its outcome (`done`), or its failure with the phase it was in. */
  let sequence = 0;
  async function attempt(route, index, mode, demand = null) {
    const seq = (sequence += 1);
    // (a worker that ended or threw after its last run's outcome is replaced; that outcome stands)
    if (workers.get(route).ended) {
      summary.replaced += 1;
      await retire(route);
    }
    const slot = workers.get(route).worker === null ? fresh(route) : workers.get(route);
    const { worker } = slot;
    const runsBeforeFailure = slot.runs;
    return new Promise((resolve) => {
      let phase = null;
      let over = null;
      const failed = (failure, extra = {}) =>
        finish({
          failed: {
            route,
            mode,
            phase,
            failure,
            runsBeforeFailure,
            heapMiB: slot.limitMiB,
            ...(demand === null ? {} : { demand }),
            ...extra,
          },
        });
      const timer = setTimeout(() => failed("safety net"), seconds * 1000);
      const onMessage = (message) => {
        if (message.limitMiB !== undefined) return;
        // (a mark of an earlier run, read late, is that run's)
        if (message.seq !== seq) return;
        if (message.phase !== undefined) phase = message.phase;
        else if (message.over !== undefined) over = message.over;
        else finish(message);
      };
      const onError = (error) =>
        error?.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? failed("heap")
          : failed(`worker error: ${error?.name}: ${error?.message}`.slice(0, 300));
      const onExit = (code) =>
        code === OVER_EXIT ? failed("units", over ?? {}) : failed(`worker exit ${code}`);
      function finish(value) {
        clearTimeout(timer);
        worker.off("message", onMessage).off("error", onError).off("exit", onExit);
        if (value.failed === undefined) slot.runs += 1;
        resolve(value);
      }
      worker.on("message", onMessage).on("error", onError).on("exit", onExit);
      worker.postMessage({ seq, index, mode, demand });
    });
  }

  /** A run, retried once in a fresh worker where a reused one exhausted its heap or reached the safety net. */
  async function run(route, index, mode, demand = null) {
    let first = await attempt(route, index, mode, demand);
    if (first.failed === undefined) return first;
    await retire(route);
    // (a reused worker that failed before the run reached its first phase ended after its last run: the run starts again
    // in a fresh worker, as if the worker had been replaced before it)
    if (first.failed.phase === null && first.failed.runsBeforeFailure > 0) {
      summary.replaced += 1;
      first = await attempt(route, index, mode, demand);
      if (first.failed === undefined) return first;
      await retire(route);
    }
    const { failure, runsBeforeFailure } = first.failed;
    if (runsBeforeFailure === 0 || (failure !== "heap" && failure !== "safety net")) return first;
    const again = await attempt(route, index, mode, demand);
    if (again.failed !== undefined) await retire(route);
    return { ...again, retried: first.failed };
  }

  for (const index of indices) {
    const source = sources[index];
    if (done.has(source.name)) {
      summary.resumed += 1;
      count(done.get(source.name));
      continue;
    }
    const record = {
      key: sourceKey(source),
      set: summary.set,
      name: source.name,
      index,
      origins: [{ set: summary.set, name: source.name }],
      rows: [],
    };
    const failures = [];
    const decisions = [];
    for (let mode = 0; mode < 4; mode += 1) {
      const row = { mode: null };
      const results = {};
      for (const route of ROUTES) {
        const result = await run(route, index, mode);
        results[route] = result;
        if (result.failed !== undefined) {
          failures.push(result.failed);
          row[route] = {
            outcome: "failed",
            ...result.failed,
            route: undefined,
            mode: undefined,
            retried: result.retried,
          };
        } else {
          row.mode = result.mode;
          row[route] =
            result.retried === undefined
              ? result.summary
              : { ...result.summary, retried: result.retried };
          if (result.decisions !== undefined)
            decisions.push({ mode: result.mode, ...result.decisions });
        }
      }
      row.mode ??= { reversed: mode >= 2, unshared: mode % 2 === 1 };
      const [l, c] = [results.legacy, results.core];
      if (
        l.failed === undefined &&
        c.failed === undefined &&
        l.compared !== undefined &&
        c.compared !== undefined
      ) {
        row.delta = {
          diagnosticIdentity: l.compared.identity !== c.compared.identity,
          diagnosticText: l.compared.diagnostics !== c.compared.diagnostics,
          checks: l.compared.checks !== c.compared.checks,
          plan: l.summary.planHash !== c.summary.planHash,
        };
        if (row.delta.plan)
          row.planDelta = delta(JSON.parse(l.compared.plan), JSON.parse(c.compared.plan));
      }
      record.rows.push(row);
    }
    // (the demand control: the core alone at each demand allowance, its outcome and decision counts kept)
    for (const demand of demands) {
      const rows = [];
      for (let mode = 0; mode < 4; mode += 1) {
        const result = await run("core", index, mode, demand);
        const at = { reversed: mode >= 2, unshared: mode % 2 === 1 };
        if (result.failed !== undefined) {
          failures.push(result.failed);
          rows.push({
            mode: at,
            core: {
              outcome: "failed",
              ...result.failed,
              route: undefined,
              mode: undefined,
              demand: undefined,
              retried: result.retried,
            },
          });
        } else {
          const { outcome, outside, decisionCounts, units, allowance } = result.summary;
          rows.push({
            mode: result.mode,
            core: { outcome, outside, decisionCounts, units, allowance, retried: result.retried },
          });
        }
      }
      (record.demands ??= []).push({ demand, rows });
    }
    if (failures.length > 0) {
      record.incomplete = true;
      record.failed = failures;
      // (the first failure, as the research's records grouped an absent record by its reason)
      const [first] = failures;
      record.reason = `${first.route}${first.demand === undefined ? "" : ` at demand ${first.demand}`} mode ${first.mode}: ${first.failure} in ${first.phase}`;
    }
    count(record);
    if (out !== undefined) appendFileSync(out, `${JSON.stringify(record)}\n`);
    if (decisionsOut !== undefined && decisions.length > 0)
      appendFileSync(decisionsOut, `${JSON.stringify({ key: record.key, decisions })}\n`);
  }
  for (const route of ROUTES) await retire(route);
  console.log(JSON.stringify(summary));
  process.exitCode = summary.failed === 0 ? 0 : 1;
} else {
  // (each route has processes of its own: the parent asks each for its route's runs; a mark goes to stderr at once, so
  // the parent reads it however this process ends)
  const { root, set, units, route } = JSON.parse(process.env[CHILD]);
  let seq = null;
  // (a mark starts a line of its own, whatever the compile wrote on stderr before it without a newline)
  const mark = (message) => writeSync(2, `\n${MARK}${JSON.stringify({ seq, ...message })}\n`);
  process.on("disconnect", () => process.exit(0));
  // (this process ends when its parent does, also while a compile blocks its event loop: a thread of its own watches)
  new Worker(
    `const { workerData } = require("node:worker_threads");
     setInterval(() => { if (process.ppid !== workerData) process.kill(process.pid, "SIGKILL"); }, 250).unref();
     setInterval(() => {}, 1 << 30);`,
    { eval: true, workerData: process.ppid },
  ).unref();
  // (an outcome being sent is delivered before an error thrown after it ends this process: the parent keeps it)
  let sending = 0;
  let failure = null;
  process.on("uncaughtException", (error) => {
    writeSync(2, `\n${error?.stack ?? error}\n`);
    failure = error;
    if (sending === 0) process.exit(1);
  });
  // (requests that arrive while this process still loads the tree wait for it)
  let take = null;
  const waiting = [];
  process.on("message", (request) => (take === null ? waiting.push(request) : take(request)));
  // (the heap limit this worker has, the one a failure is recorded with)
  mark({ limitMiB: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576) });
  const dist = distOf(root);
  const imp = (file) => import(pathToFileURL(path.join(dist, file)).href);
  const { compileProjectWithBackend } = await imp("src/compiler.js");
  const { CORE_BACKEND } = await imp("src/type-inference/core/backend.js");
  const { LEGACY_BACKEND } = await imp("src/type-inference/legacy-rounds.js");
  const { WorkLedger } = await imp("src/type-inference/core/budget.js");
  const { Consumers } = await imp("src/type-inference/core/consumers.js");
  const O = await imp("tests/helpers/type-core-oracles.js");
  const text = (value) => O.jsonText(value);
  const phase = (name) => mark({ phase: name });

  // (a run's charged units, and the largest allowance of a ledger it charged: past `units` times that, it stops here)
  const meter = { spent: 0, allowance: 0 };
  const { charge } = WorkLedger.prototype;
  WorkLedger.prototype.charge = function (counter, n = 1) {
    meter.spent += n;
    if (Number.isInteger(this.allowance) && this.allowance > meter.allowance)
      meter.allowance = this.allowance;
    if (units !== null && meter.allowance > 0 && meter.spent > units * meter.allowance) {
      mark({ over: { units: meter.spent, allowance: meter.allowance } });
      process.exit(OVER_EXIT);
    }
    return charge.call(this, counter, n);
  };
  // (the phases a run reaches: each pass's walk of the consumers, the receiving completion, the analysis's end)
  let pass = 0;
  const { check, receive } = Consumers.prototype;
  Consumers.prototype.check = function (...args) {
    pass += 1;
    phase(`analysis pass ${pass}`);
    return check.apply(this, args);
  };
  Consumers.prototype.receive = function (...args) {
    phase("completion");
    return receive.apply(this, args);
  };
  /** The run's analysis request and checked result, as `analyze` saw them, or the construct the core rejected. */
  let seen = null;
  for (const backend of [CORE_BACKEND, LEGACY_BACKEND]) {
    const { analyze } = backend;
    backend.analyze = function (request) {
      phase("analysis");
      try {
        const result = analyze.call(this, request);
        seen.checks = projectChecks(request, result.checked);
        phase("lowering");
        return result;
      } catch (error) {
        if (error?.name === "CandidateOutsideSlice")
          seen.excluded = { what: error.what, path: error.path, site: error.site };
        throw error;
      }
    };
  }

  /** The checks a lowering reads, each by its site (file, node kind, offsets), sorted by that. */
  function projectChecks(request, checked) {
    const locations = new WeakMap();
    for (const file of request.files) {
      const stack = [file.program];
      while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || locations.has(value)) continue;
        locations.set(value, file.path);
        for (const [key, member] of Object.entries(value)) {
          if (key === "span" || !member || typeof member !== "object") continue;
          if (Array.isArray(member)) member.forEach((each) => stack.push(each));
          else stack.push(member);
        }
      }
    }
    const site = (node) => ({
      file: locations.get(node) ?? null,
      kind: node.kind,
      start: node.span?.start.offset,
      end: node.span?.end.offset,
    });
    const byText = (a, b) => text(a).localeCompare(text(b));
    const entries = (map) =>
      [...map.entries()].map(([k, v]) => [site(k), v]).sort((a, b) => byText(a[0], b[0]));
    const sites = (list) => [...list].map(site).sort(byText);
    const core = checked.coreChecks;
    return {
      runtimeChecks: entries(checked.runtimeChecks),
      formShapes: entries(checked.formShapes),
      storageTypes: checked.storageTypes,
      coreChecks: core
        ? Object.fromEntries(
            Object.entries(core)
              .filter(([, v]) => v.size > 0)
              .map(([k, v]) => [k, v instanceof Map ? entries(v) : sites(v)]),
          )
        : {},
    };
  }

  const sources = await sourcesOfSet(set, root);
  take = ({ seq: run, index, mode: modeIndex, demand }) => {
    seq = run;
    const source = sources[index];
    const mode = O.MODES[modeIndex];
    Object.assign(meter, { spent: 0, allowance: 0 });
    pass = 0;
    seen = { checks: null, excluded: null };
    sending += 1;
    process.send({ ...runRoute(source, mode, demand), mode, seq: run }, () => {
      sending -= 1;
      if (failure !== null && sending === 0) process.exit(1);
    });
  };
  for (const request of waiting.splice(0)) take(request);

  /** One route's outcome in `mode`: compare.mjs's summary, and the texts the parent compares with the other route's. */
  function runRoute(source, mode, demand) {
    phase("parse and names");
    try {
      let plan;
      let diagnostics;
      let extra = {};
      let decisions;
      if (route === "core") {
        const records = O.decisionRecords(
          source.files,
          source.globals,
          demand === null ? { mode } : { mode, demand },
        );
        phase("record");
        const parsed = JSON.parse(records.text);
        // (the decisions a compile read are kept also where its program leaves the slice, as compare.mjs kept them)
        decisions = { ordinary: records.ordinary, completion: records.completion };
        extra = {
          excluded: seen.excluded,
          decisionCounts: {
            ordinary: records.ordinary.map((x) => x.length),
            completion: records.completion.map((x) => x.length),
          },
          decisionsHash: hash(text([records.ordinary, records.completion])),
        };
        if (parsed.outside !== undefined)
          return {
            summary: { outcome: "outside", outside: parsed.outside, ...work(), ...extra },
            decisions,
          };
        ({ plan, diagnostics } = parsed);
      } else {
        const result = O.inMode(mode, () =>
          compileProjectWithBackend(source.files, { globals: source.globals }, undefined),
        );
        phase("record");
        ({ plan, diagnostics } = result);
      }
      const planText = text(plan);
      const identity = diagnostics.map((d) => [
        d.path,
        d.code,
        d.severity,
        d.span.start.offset,
        d.span.end.offset,
      ]);
      return {
        summary: {
          outcome: plan === null ? "rejected" : "plan",
          diagnostics,
          checks: seen.checks,
          planHash: hash(planText),
          planBytes: planText.length,
          ...work(),
          ...extra,
        },
        compared: {
          identity: text(identity),
          diagnostics: text(diagnostics),
          checks: text(seen.checks),
          plan: planText,
        },
        decisions,
      };
    } catch (error) {
      return {
        summary: {
          outcome: "exception",
          name: error?.name,
          message: error?.message,
          stack: error?.stack,
          excluded: seen.excluded,
          ...work(),
        },
      };
    }
  }
  function work() {
    return { units: meter.spent, allowance: meter.allowance };
  }
}
