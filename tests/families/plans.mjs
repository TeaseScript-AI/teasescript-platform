// node tests/families/plans.mjs <base tree> <head tree> <set> [--shard i/N] [--out f.jsonl] [--stops] [--demands 16,64]
//   [--limit n] [--units 4] [--timeout 1800] [--memory 2048] [--only names.json]
// node tests/families/plans.mjs summary <records>... [--list 40]
// The plans comparison (#1526 phase A's kit, landed from #1678's copy): the plan each source compiles to through the core
// backend, in the four modes (`HELD_MODES`, each tree's own, the base's paired with the head's of the same `name`, which
// names the mode in a record and a run, #2342), on two built trees in one worker, compared as the exact serialized JSON
// (sha256 of `JSON.stringify(plan)`, none where the compile has no plan, and of the diagnostics) together with the trace of every work unit the compile
// charges (each `WorkLedger.charge` call's counter and units folded into a 64-bit hash, with their count and sum) and the
// sequence of questions the compile asks its answers (each call of an `Answers` method, with its place, path or node, in
// order, folded likewise), so a lowering that asks the analysis anything more, less or in another order shows.
// `--demands`: the same at each of these demand allowances. `--stops` (the held family): every settled stop of each mode
// (`heldStops`, step 1) and the questions phase (allowances from the analysis's own total to the compile's: all of them
// up to 64, else 32 spread and both ends), each compiled on both trees and compared the same way.
//   <set>: corpus (CASES_JSON=<cases.json>), fixture (the base tree's tools/corpus/fixture), held (the base tree's
//   `heldFamily()`), or an area of tests/families by its name (the head tree's) or folder (its generators' sources at
//   their own sizes, by the head tree's `sources.mjs`).
// A run is one compile of a source in a mode on one tree, one analysis of the held family's (each of its stop search's,
// `heldStops`, through the mode's `run`, apart), or the search's own work between them. It stalls where its charged
// units (every `WorkLedger.charge` of its tree while it runs) pass `--units` times its program's allowance, as in
// `run.mjs` (#1647): the largest allowance of a ledger it charged, max(30 M, 256 × syntax nodes), and for a run at a
// test allowance (a stop, the questions phase, the stop search) the allowance of the same source's natural compile on
// that tree, so the limit is the same on every machine; a source past `--memory` MB of heap, or whose worker ends,
// stalls too. The wall clock is only a safety net, `--timeout` seconds a run: a run that reaches it does work no ledger
// charges, and its source is recorded as `uncharged` with that run, never as a stall. Either way a fresh worker takes
// the next source. A stalled or uncharged source is never agreement. Resumes: a source already in `--out` is not run
// again, its record counted as it stands. Prints one JSON summary line; exit 0 when every compared run is equal and
// nothing stalled or reached the safety net, else 1;
// 2 on a usage error, where the trees' modes are not the same names once each, where a worker does not load and check
// both trees within the safety net (no source is handed to a worker before that), or where a worker compiling a source
// posts anything but a run, a run past the limit or that source's record; none of these is recorded. The gate holds
// against a tree that fails to load, throws, ends, is slow or has a wrong table, not against tree code that posts on
// the worker's port.
// `summary` classifies the records per set, source and mode (`modes`, each with its demand, stop and questions runs):
// identical; work only (the plan, the diagnostics, the error and the questions equal, the charge trace not); a question
// sequence apart; a publication difference; at a demand allowance apart, each row in the same one class and named by
// every part apart, with which tree's output the allowance stops against that tree's own unstopped compile (#2341); for
// the held family, a stop set apart phase by phase (#2340: from both trees' stop lists, which a record keeps where the
// sets differ, a phase on the head alone is added, on the base alone removed, on both at other allowances, compared
// ascending, moved; a stop that changes phase over an overlapping range reads as one removed and one added, and a
// record without the lists, or whose lists differ in no phase, is unavailable, never equal), a stopped compile apart by
// its parts, and the analysis's units apart; and lists each with the stalled and uncharged sources. Before any output
// it checks every line's keys, types and value formats against those the runner writes (`recordFault`), a gate against
// malformed, foreign and truncated lines, not a proof of the invariants between one record's fields: a line it refuses
// ends the summary, exit 2, naming its file, line and fault. A record from before #2342 names its mode by a number, its
// index in `HELD_MODES` at the commit that wrote it: printed as that number, never translated, with one line that says
// so.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { summarize } from "./plans-summary.mjs";
import { unitsOf } from "./units.mjs";

/** The exit of a worker whose run passed the unit limit, after it posted the run (`over`). */
const OVER_EXIT = 86;

const distOf = (root) => (existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root);

/** `set` as a path where it names an area of the head tree's `tests/families`, else as given. */
const setOf = (set, headRoot) => {
  if (["corpus", "fixture", "held"].includes(set) || set.includes("/")) return set;
  return path.join(headRoot, "tests", "families", set);
};

if (isMainThread && process.argv[2] === "summary") {
  const rest = process.argv.slice(3);
  const at = rest.indexOf("--list");
  summarize(
    rest.filter((_, i) => at < 0 || (i !== at && i !== at + 1)),
    at < 0 ? 40 : Number(rest[at + 1]),
  );
} else if (isMainThread) {
  const [baseRoot, headRoot, given, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(name);
    return at < 0 ? undefined : rest[at + 1];
  };
  const refused = (why) => {
    process.stderr.write(`plans.mjs: ${why}\n`);
    process.exit(2);
  };
  if (given === undefined) refused("usage: plans.mjs <base tree> <head tree> <set> [options]");
  // (one build loaded twice is one module: its ledger's and its answers' charges would count twice)
  if (realpathSync(distOf(baseRoot)) === realpathSync(distOf(headRoot)))
    refused("the base and the head are one build: compare two");
  const set = setOf(given, headRoot);
  const [shard, shards] = (option("--shard") ?? "0/1").split("/").map(Number);
  // (shards 0/N to N-1/N together hold the set once, as run.mjs's do: another index would run none, #1072 R48)
  if (!(
    Number.isInteger(shards) &&
    shards > 0 &&
    Number.isInteger(shard) &&
    shard >= 0 &&
    shard < shards
  ))
    refused(`--shard ${option("--shard")} is no shard i/N with 0 <= i < N`);
  const out = option("--out");
  const limit = option("--limit") === undefined ? Infinity : Number(option("--limit"));
  const units = option("--units") === "none" ? null : Number(option("--units") ?? 4);
  if (units !== null && !(Number.isInteger(units) && units > 0))
    refused(`--units ${option("--units")} is no positive whole multiple of the allowance, or none`);
  const seconds = Number(option("--timeout") ?? 1800);
  const memory = Number(option("--memory") ?? 2048);
  const demands = (option("--demands") ?? "").split(",").filter(Boolean).map(Number);
  const stops = rest.includes("--stops");
  const sources = await unitsOf(set, baseRoot, headRoot);
  // (--only <file>: a JSON list of source names, run whatever the shard, as a rerun of stalled sources)
  const only =
    option("--only") === undefined
      ? null
      : new Set(JSON.parse(readFileSync(option("--only"), "utf8")));
  const indices = sources
    .map((_, index) => index)
    .filter((index) => (only === null ? index % shards === shard : only.has(sources[index].name)))
    .slice(0, limit);
  if (indices.length === 0) refused(`the selection holds no source of ${path.basename(set)}`);
  // (a source already in --out is not run again, its record counted as it stands: a stall stays a stall; by its name and
  // key, as two sources may share a name, #2254: a record without a key matches no source and its source runs again)
  const placed = (unit) => JSON.stringify([unit.name, unit.key]);
  const done = new Map();
  if (out !== undefined && existsSync(out))
    for (const line of readFileSync(out, "utf8").split("\n"))
      if (line.startsWith("{")) {
        const record = JSON.parse(line);
        done.set(placed(record), record);
      }
  const summary = {
    set: path.basename(set),
    shard: `${shard}/${shards}`,
    sources: indices.length,
    resumed: 0,
    runs: 0,
    differing: 0,
    stalled: 0,
    uncharged: 0,
    units,
    timeout: seconds,
    seconds: 0,
    node: process.version,
  };
  const started = Date.now();
  /** A source's record into the summary: a stall, a safety net reached, or its runs and differences. */
  const count = (record) => {
    if (record.stalled !== undefined) summary.stalled += 1;
    else if (record.uncharged !== undefined) summary.uncharged += 1;
    else {
      summary.runs += record.runs;
      summary.differing += record.differing;
    }
  };
  const write = (record) => {
    if (out !== undefined) appendFileSync(out, `${JSON.stringify(record)}\n`);
  };
  let worker = null;
  /**
   * A worker that has loaded both trees and checked their modes (its `ready`), before any source is handed to it: a
   * refusal, or a worker that ends, fails or is not ready within the safety net first, ends the run with exit 2 and
   * never becomes a source's record (#2342, the final review's B1).
   */
  const fresh = async () => {
    const started = new Worker(fileURLToPath(import.meta.url), {
      workerData: { baseRoot, headRoot, set, stops, demands, units },
      resourceLimits: { maxOldGenerationSizeMb: memory },
    });
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(
        () => end(`not ready within the safety net, ${seconds} s`),
        seconds * 1000,
      );
      const onMessage = (message) =>
        end(message.ready === true ? null : (message.refused ?? "an unexpected first message"));
      const onError = (error) =>
        end(`${error?.code ?? error?.name}: ${error?.message}`.slice(0, 300));
      const onExit = (code) => end(`its worker ended (exit ${code})`);
      function end(failure) {
        clearTimeout(timer);
        started.off("message", onMessage).off("error", onError).off("exit", onExit);
        resolve(failure);
      }
      started.on("message", onMessage).on("error", onError).on("exit", onExit);
    });
    if (ready === null) return started;
    await started.terminate().catch(() => {});
    return refused(`the trees could not be compared: ${ready}`);
  };
  for (const index of indices) {
    const source = sources[index];
    if (done.has(placed(source))) {
      summary.resumed += 1;
      count(done.get(placed(source)));
      continue;
    }
    worker ??= await fresh();
    const current = worker;
    const record = await new Promise((resolve) => {
      // (the run going on, as the worker starts each; the run past the unit limit, as it ends)
      let running = null;
      let over = null;
      // (a worker's error, kept until its exit: Node can deliver the error before the messages the worker posted
      // first, never the exit, so the stall is recorded at the exit and names the run that threw; a record that
      // arrives after the error does not end the source, and the worker is not used again)
      let failed = null;
      // (the safety net a run: armed as the source is handed over and again as each run starts; it also bounds the
      // wait for the exit after an error, and then records that error)
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            finish(
              failed === null
                ? { uncharged: `safety net ${seconds} s`, run: running }
                : { stalled: failed, run: running },
            ),
          seconds * 1000,
        );
      };
      // (only a run, the run past the limit and this source's record: anything else is no record, #2342 R17)
      const onMessage = (message) => {
        if (message?.running !== undefined) {
          running = message.running;
          arm();
        } else if (message?.over !== undefined) over = message.over;
        // (a record after an error is not this source's result: its exit records the error, #2427's round 1)
        else if (Array.isArray(message?.modes) && message.name === source.name) {
          if (failed === null) finish(message);
        } else finish({ stray: JSON.stringify(message ?? null).slice(0, 300) });
      };
      const onError = (error) => {
        failed = `${error?.code ?? error?.name}: ${error?.message}`.slice(0, 300);
      };
      const onExit = (code) =>
        finish(
          failed !== null
            ? { stalled: failed, run: running }
            : code === OVER_EXIT
              ? { stalled: "units", ...(over ?? { run: running }) }
              : { stalled: `worker exit ${code}`, run: running },
        );
      function finish(value) {
        clearTimeout(timer);
        current.off("message", onMessage).off("error", onError).off("exit", onExit);
        resolve(value);
      }
      current.on("message", onMessage).on("error", onError).on("exit", onExit);
      arm();
      current.postMessage(index);
    });
    if (record.stray !== undefined) {
      await worker.terminate().catch(() => {});
      refused(`${source.name}: its worker posted no record but ${record.stray}`);
    }
    if (record.stalled !== undefined || record.uncharged !== undefined) {
      await worker.terminate().catch(() => {});
      worker = null;
      const failed = { set: summary.set, name: source.name, key: source.key, ...record };
      count(failed);
      write(failed);
      continue;
    }
    count(record);
    write(record);
  }
  await worker?.terminate();
  summary.seconds = Math.round((Date.now() - started) / 1000);
  console.log(JSON.stringify(summary));
  process.exitCode =
    summary.differing === 0 && summary.stalled === 0 && summary.uncharged === 0 ? 0 : 1;
} else {
  const { baseRoot, headRoot, set, stops, demands, units } = workerData;
  const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

  /**
   * The run going on (`run`): the units its tree's ledgers charged (`spent`) and the largest allowance of a ledger it
   * charged, or for a run at a test allowance its source's natural one on that tree (`floor`). Past `units` times that,
   * the worker posts the run and ends (`OVER_EXIT`). Each start is posted, so that the safety net is a run's.
   */
  const meter = { run: null, spent: 0, allowance: 0, floor: 0 };
  const start = (run, floor = 0) => {
    Object.assign(meter, { run, spent: 0, allowance: 0, floor });
    parentPort.postMessage({ running: run });
  };
  /**
   * `heldStops` of `tree` in `mode`: each analysis it makes, through the mode's `run`, is a run (`stop search`, numbered),
   * and its own work before, between and after them another (`stop search, between`), each metered at the natural
   * floor and posted as it starts, so neither counts to the run before it.
   */
  const searched = (tree, c, held) => {
    const mode = held.name;
    let analysis = 0;
    const between = () =>
      start({ tree: tree.name, mode, at: "stop search, between", analysis }, tree.natural);
    const metered = {
      ...held,
      run: (make) => {
        analysis += 1;
        start({ tree: tree.name, mode, at: "stop search", analysis }, tree.natural);
        try {
          return held.run(make);
        } finally {
          between();
        }
      },
    };
    between();
    try {
      return tree.held.heldStops(c, metered, 1);
    } finally {
      meter.run = null;
    }
  };

  async function load(root, name) {
    const dist = distOf(root);
    const imp = (file) => import(pathToFileURL(path.join(dist, file)).href);
    const tree = {
      name,
      compiler: await imp("src/compiler.js"),
      backend: await imp("src/type-inference/core/backend.js"),
      budget: await imp("src/type-inference/core/budget.js"),
      held: await imp("tests/helpers/type-core-held-host.js"),
      analysis: await imp("tests/helpers/type-core-analysis.js"),
      answers: await imp("src/type-inference/core/answers.js"),
      trace: null,
      questions: null,
      // (the largest ledger allowance of the source's last natural compile, a test allowance's run's floor)
      natural: 0,
    };
    // (every question asked of the answers, in order: the method and its arguments, a node by its id)
    const probe = tree.analysis.coreRequest(
      [{ path: "main.tease", source: "let a = 1\nexit\n" }],
      ["hostValue"],
    );
    const answersPrototype = Object.getPrototypeOf(tree.answers.analyseCore(probe));
    const argText = (value) =>
      typeof value === "number" || typeof value === "string"
        ? String(value)
        : Array.isArray(value)
          ? value.join("\u0001")
          : value === null || value === undefined
            ? "~"
            : typeof value.id === "number"
              ? `#${value.id}`
              : typeof value.property === "string"
                ? `.${value.property}`
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
      const asked = answersPrototype[method];
      answersPrototype[method] = function (...args) {
        const q = tree.questions;
        if (q !== null) {
          q.n += 1;
          const text = `${method}(${args.map(argText).join(",")})`;
          for (let i = 0; i < text.length; i += 1) {
            const c = text.charCodeAt(i);
            q.a = Math.imul(q.a ^ c, 16777619) >>> 0;
            q.b = Math.imul(q.b ^ c, 2246822519) >>> 0;
          }
          q.a = Math.imul(q.a ^ 0xff, 16777619) >>> 0;
        }
        return asked.apply(this, args);
      };
    }
    const { charge } = tree.budget.WorkLedger.prototype;
    tree.budget.WorkLedger.prototype.charge = function (counter, units = 1) {
      if (meter.run !== null) {
        meter.spent += units;
        if (Number.isInteger(this.allowance) && this.allowance > meter.allowance)
          meter.allowance = this.allowance;
        const allowance = Math.max(meter.allowance, meter.floor);
        if (allowance > 0 && meter.spent > multiple * allowance) {
          parentPort.postMessage({ over: { run: meter.run, work: meter.spent, allowance } });
          process.exit(OVER_EXIT);
        }
      }
      const t = tree.trace;
      if (t !== null) {
        t.n += 1;
        t.units += units;
        for (let i = 0; i < counter.length; i += 1) {
          const c = counter.charCodeAt(i);
          t.a = Math.imul(t.a ^ c, 16777619) >>> 0;
          t.b = Math.imul(t.b ^ c, 2246822519) >>> 0;
        }
        t.a = Math.imul(t.a ^ (units & 0xffff), 16777619) >>> 0;
        t.b = Math.imul(t.b ^ (units >>> 16), 2246822519) >>> 0;
        t.a = Math.imul(t.a ^ 0xff, 16777619) >>> 0;
      }
      return charge.call(this, counter, units);
    };
    return tree;
  }
  const multiple = units ?? Infinity;

  /**
   * One compile in a mode (a `HeldMode` of the tree), unstopped (`allowance` undefined), at a demand allowance
   * (`{ demand }`) or at a test allowance (a number): its plan's and diagnostics' hashes and its charge trace.
   */
  function compile(tree, unit, mode, allowance) {
    const at =
      allowance === undefined
        ? "natural"
        : typeof allowance === "object"
          ? `demand ${allowance.demand}`
          : `allowance ${allowance}`;
    start(
      { tree: tree.name, mode: mode.name, at },
      typeof allowance === "number" ? tree.natural : 0,
    );
    tree.trace = { n: 0, units: 0, a: 2166136261, b: 3266489917 };
    tree.questions = { n: 0, a: 2166136261, b: 3266489917 };
    const options = { globals: unit.globals };
    const make = () =>
      unit.single
        ? tree.compiler.compileSourceWithBackend(
            unit.files[0].source,
            options,
            tree.backend.CORE_BACKEND,
          )
        : tree.compiler.compileProjectWithBackend(unit.files, options, tree.backend.CORE_BACKEND);
    let result = null;
    let error = null;
    try {
      result = mode.run(() =>
        allowance === undefined
          ? make()
          : typeof allowance === "object"
            ? tree.budget.withTestDemandAllowance(allowance.demand, make)
            : tree.budget.withTestAllowance(allowance, make),
      );
    } catch (e) {
      error = `${e?.name}: ${e?.message}`;
    }
    if (allowance === undefined) tree.natural = meter.allowance;
    meter.run = null;
    const t = tree.trace;
    const q = tree.questions;
    tree.trace = null;
    tree.questions = null;
    return {
      // (a compile with no plan, an error or a decline, records none: never a digest of `null`, #2080)
      plan: result?.plan == null ? null : sha(JSON.stringify(result.plan)),
      diagnostics: result === null ? null : sha(JSON.stringify(result.diagnostics)),
      checks: result?.plan
        ? result.plan.instructions.filter((i) => i.typeCheck !== undefined).length
        : 0,
      error,
      trace: `${t.n}/${t.units}/${t.a.toString(16)}${t.b.toString(16)}`,
      questions: `${q.n}/${q.a.toString(16)}${q.b.toString(16)}`,
      units: t.units,
    };
  }

  const same = (a, b) =>
    a.plan === b.plan &&
    a.diagnostics === b.diagnostics &&
    a.error === b.error &&
    a.trace === b.trace &&
    a.questions === b.questions;

  /** The analysis's own charged units in a mode, unstopped, or `null`. */
  function analysisUnits(tree, unit, mode) {
    const request = tree.analysis.coreRequest(unit.files, unit.globals);
    if (request === null) return null;
    start({ tree: tree.name, mode: mode.name, at: "analysis" });
    tree.trace = { n: 0, units: 0, a: 0, b: 0 };
    try {
      mode.run(() => tree.answers.analyseCore(request));
    } catch {
      tree.trace = null;
      return null;
    } finally {
      meter.run = null;
    }
    const { units } = tree.trace;
    tree.trace = null;
    return units;
  }

  const base = await load(baseRoot, "base");
  const head = await load(headRoot, "head");
  // (each of the base's modes with the head's of its name, the identity a record names, #2342: never by position; every
  // slot read, a hole as no name, and no table but an array)
  const names = (tree) =>
    Array.isArray(tree.held.HELD_MODES)
      ? Array.from(tree.held.HELD_MODES, (mode) => mode?.name)
      : null;
  const [baseNames, headNames] = [names(base), names(head)];
  const unnamed = (list) =>
    list === null ||
    list.some((name) => typeof name !== "string" || name === "") ||
    new Set(list).size !== list.length;
  const refused =
    unnamed(baseNames) ||
    unnamed(headNames) ||
    baseNames.length !== headNames.length ||
    baseNames.some((name) => !headNames.includes(name));
  // (refused: said once, and no source runs; the runner ends the worker as it exits)
  if (refused)
    parentPort.postMessage({
      refused: `the trees' held modes are not the same names once each: base ${JSON.stringify(baseNames)}, head ${JSON.stringify(headNames)}`,
    });
  const modes = refused
    ? []
    : Array.from(base.held.HELD_MODES, (mode) => [
        mode,
        head.held.HELD_MODES.find((other) => other.name === mode.name),
      ]);
  const sources = await unitsOf(set, baseRoot, headRoot);
  const heldCases = sources.some((unit) => unit.held)
    ? new Map(base.held.heldFamily().map((c) => [c.name, c]))
    : null;
  // (loaded and checked: the runner hands this worker its first source only now)
  if (!refused) parentPort.postMessage({ ready: true });
  parentPort.on("message", (index) => {
    if (refused) return;
    const unit = sources[index];
    const record = {
      set: path.basename(set),
      name: unit.name,
      key: unit.key,
      runs: 0,
      differing: 0,
      modes: [],
    };
    for (const [mode, headMode] of modes) {
      const b = compile(base, unit, mode);
      const h = compile(head, unit, headMode);
      record.runs += 1;
      const entry = { mode: mode.name, base: b, head: h, same: same(b, h) };
      if (!entry.same) record.differing += 1;
      for (const demand of demands) {
        const [db, dh] = [
          compile(base, unit, mode, { demand }),
          compile(head, unit, headMode, { demand }),
        ];
        record.runs += 1;
        if (!same(db, dh)) {
          record.differing += 1;
          (entry.demands ??= []).push({ demand, base: db, head: dh });
        }
      }
      const c = heldCases?.get(unit.name);
      // (a held case whose base compile fails has no stop search: said so, never left out, #2340)
      if (stops && c?.slice && b.error !== null)
        entry.stops = {
          unavailable: `the base's unstopped compile failed: ${b.error}`.slice(0, 300),
        };
      if (stops && c?.slice && b.error === null) {
        const list = searched(base, c, mode);
        const headList = searched(head, c, headMode);
        entry.stops = {
          count: list.length,
          sameSet: JSON.stringify(list) === JSON.stringify(headList),
          differ: [],
        };
        // (both trees' stops where they differ, for the summary to say which phase each tree added, removed or moved)
        if (!entry.stops.sameSet) Object.assign(entry.stops, { base: list, head: headList });
        if (!entry.stops.sameSet) record.differing += 1;
        for (const { allowance, phase } of list) {
          const [sb, sh] = [
            compile(base, unit, mode, allowance),
            compile(head, unit, headMode, allowance),
          ];
          record.runs += 1;
          if (!same(sb, sh)) {
            record.differing += 1;
            entry.stops.differ.push({ allowance, phase, base: sb, head: sh });
          }
        }
        const analysed = analysisUnits(base, unit, mode);
        const analysedHead = analysisUnits(head, unit, headMode);
        const questions = {
          analysis: analysed,
          analysisHead: analysedHead,
          compile: b.units,
          sampled: 0,
          differ: [],
        };
        if (analysed !== analysedHead) record.differing += 1;
        else if (analysed !== null && b.units > analysed) {
          const span = b.units - analysed;
          const allowances =
            span <= 64
              ? Array.from({ length: span }, (_, i) => analysed + i)
              : [
                  ...new Set([
                    analysed,
                    b.units - 1,
                    ...Array.from(
                      { length: 32 },
                      (_, i) => analysed + Math.floor(((i + 1) * span) / 33),
                    ),
                  ]),
                ];
          for (const allowance of allowances) {
            const [qb, qh] = [
              compile(base, unit, mode, allowance),
              compile(head, unit, headMode, allowance),
            ];
            record.runs += 1;
            questions.sampled += 1;
            if (!same(qb, qh)) {
              record.differing += 1;
              questions.differ.push({ allowance, base: qb, head: qh });
            }
          }
        }
        entry.questions = questions;
      }
      record.modes.push(entry);
    }
    parentPort.postMessage(record);
  });
}
