// node tests/families/plans.mjs <base tree> <head tree> <set> [--shard i/N] [--out f.jsonl] [--stops] [--demands 16,64]
//   [--limit n] [--units 4] [--timeout 1800] [--memory 2048] [--only names.json]
// node tests/families/plans.mjs summary <records>... [--list 40]
// The plans comparison (#1526 phase A's kit, landed from #1678's copy): the plan each source compiles to through the core
// backend, in the four modes (`HELD_MODES`), on two built trees in one worker, compared as the exact serialized JSON
// (sha256 of `JSON.stringify(plan)` and of the diagnostics) together with the trace of every work unit the compile
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
// nothing stalled or reached the safety net, else 1.
// `summary` classifies the records per set, source and mode (`modes`, each with its demand, stop and questions runs):
// identical; work only (the plan, the diagnostics, the error and the questions equal, the charge trace not); a question
// sequence apart; a publication difference; at a demand allowance apart; for the held family, a stop set or a stopped
// compile apart, and the analysis's units apart; and lists each with the stalled and uncharged sources.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { unitsOf } from "./units.mjs";

/** The exit of a worker whose run passed the unit limit, after it posted the run (`over`). */
const OVER_EXIT = 86;

const distOf = (root) => (existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root);

/** `set` as a path where it names an area of the head tree's `tests/families`, else as given. */
const setOf = (set, headRoot) => {
  if (["corpus", "fixture", "held"].includes(set) || set.includes("/")) return set;
  return path.join(headRoot, "tests", "families", set);
};

/** The records' classification (`summary`): one line per set, then each difference, stall and safety net reached. */
function summarize(files, limit) {
  const sets = new Map();
  const listed = [];
  const bump = (set, key) => {
    if (!sets.has(set))
      sets.set(set, {
        sources: 0,
        modes: 0,
        identical: 0,
        workOnly: 0,
        workLower: 0,
        workHigher: 0,
        questions: 0,
        publication: 0,
        demand: 0,
        stopSet: 0,
        stoppedCompile: 0,
        analysisApart: 0,
        stalled: 0,
        uncharged: 0,
      });
    sets.get(set)[key] += 1;
  };
  const rows = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line)),
  );
  for (const r of rows) {
    bump(r.set, "sources");
    if (r.stalled !== undefined || r.uncharged !== undefined) {
      const kind = r.stalled !== undefined ? "stalled" : "uncharged";
      bump(r.set, kind);
      listed.push(`${r.set} ${r.name}: ${kind} (${r[kind]}, ${JSON.stringify(r.run ?? null)})`);
      continue;
    }
    for (const m of r.modes) {
      bump(r.set, "modes");
      const { base: b, head: h } = m;
      const at = `${r.set} ${r.name} mode ${m.mode}`;
      if (m.same) bump(r.set, "identical");
      else if (b.plan === h.plan && b.diagnostics === h.diagnostics && b.error === h.error) {
        if (b.questions !== h.questions) {
          bump(r.set, "questions");
          listed.push(
            `${at}: questions ${b.questions} → ${h.questions}, units ${b.units} → ${h.units}`,
          );
        } else {
          bump(r.set, "workOnly");
          bump(r.set, h.units < b.units ? "workLower" : "workHigher");
          listed.push(`${at}: work ${b.units} → ${h.units}`);
        }
      } else {
        bump(r.set, "publication");
        const sign = (x, y) => (x === y ? "=" : "≠");
        listed.push(
          `${at}: PUBLICATION plan ${sign(b.plan, h.plan)} diagnostics ${sign(b.diagnostics, h.diagnostics)} ` +
            `error ${b.error} → ${h.error}, units ${b.units} → ${h.units}`,
        );
      }
      for (const d of m.demands ?? []) {
        bump(r.set, "demand");
        listed.push(`${at}: at demand allowance ${d.demand} apart`);
      }
      if (m.stops !== undefined) {
        if (!m.stops.sameSet) {
          bump(r.set, "stopSet");
          listed.push(`${at}: STOP SET apart (main ${m.stops.count} stops)`);
        }
        for (const d of m.stops.differ) {
          bump(r.set, "stoppedCompile");
          listed.push(`${at}: stopped compile at ${d.allowance} (${d.phase}) apart`);
        }
      }
      if (m.questions !== undefined && m.questions.analysis !== m.questions.analysisHead) {
        bump(r.set, "analysisApart");
        listed.push(`${at}: analysis units ${m.questions.analysis} → ${m.questions.analysisHead}`);
      }
      for (const d of m.questions?.differ ?? []) {
        bump(r.set, "stoppedCompile");
        listed.push(`${at}: questions-phase compile at ${d.allowance} apart`);
      }
    }
  }
  for (const [set, counts] of sets) console.log(JSON.stringify({ set, ...counts }));
  for (const line of listed.slice(0, limit)) console.log(line);
  if (listed.length > limit) console.log(`… ${listed.length - limit} more`);
}

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
  // (a source already in --out is not run again, its record counted as it stands: a stall stays a stall)
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
  const fresh = () =>
    new Worker(fileURLToPath(import.meta.url), {
      workerData: { baseRoot, headRoot, set, stops, demands, units },
      resourceLimits: { maxOldGenerationSizeMb: memory },
    });
  for (const index of indices) {
    const source = sources[index];
    if (done.has(source.name)) {
      summary.resumed += 1;
      count(done.get(source.name));
      continue;
    }
    worker ??= fresh();
    const current = worker;
    const record = await new Promise((resolve) => {
      // (the run going on, as the worker starts each; the run past the unit limit, as it ends)
      let running = null;
      let over = null;
      // (the safety net a run: armed as the source is handed over and again as each run starts)
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish({ uncharged: `safety net ${seconds} s`, run: running }),
          seconds * 1000,
        );
      };
      const onMessage = (message) => {
        if (message.running !== undefined) {
          running = message.running;
          arm();
        } else if (message.over !== undefined) over = message.over;
        else finish(message);
      };
      const onError = (error) =>
        finish({
          stalled: `${error?.code ?? error?.name}: ${error?.message}`.slice(0, 300),
          run: running,
        });
      const onExit = (code) =>
        finish(
          code === OVER_EXIT
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
    if (record.stalled !== undefined || record.uncharged !== undefined) {
      await worker.terminate().catch(() => {});
      worker = null;
      const failed = { set: summary.set, name: source.name, ...record };
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
  const searched = (tree, c, mode) => {
    const held = tree.held.HELD_MODES[mode];
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
   * One compile in a mode, unstopped (`allowance` undefined), at a demand allowance (`{ demand }`) or at a test allowance
   * (a number): its plan's and diagnostics' hashes and its charge trace.
   */
  function compile(tree, unit, mode, allowance) {
    const at =
      allowance === undefined
        ? "natural"
        : typeof allowance === "object"
          ? `demand ${allowance.demand}`
          : `allowance ${allowance}`;
    start({ tree: tree.name, mode, at }, typeof allowance === "number" ? tree.natural : 0);
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
      result = tree.held.HELD_MODES[mode].run(() =>
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
      plan: result === null ? null : sha(JSON.stringify(result.plan)),
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
    start({ tree: tree.name, mode, at: "analysis" });
    tree.trace = { n: 0, units: 0, a: 0, b: 0 };
    try {
      tree.held.HELD_MODES[mode].run(() => tree.answers.analyseCore(request));
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
  const sources = await unitsOf(set, baseRoot, headRoot);
  const heldCases = sources.some((unit) => unit.held)
    ? new Map(base.held.heldFamily().map((c) => [c.name, c]))
    : null;
  parentPort.on("message", (index) => {
    const unit = sources[index];
    const record = { set: path.basename(set), name: unit.name, runs: 0, differing: 0, modes: [] };
    for (let mode = 0; mode < 4; mode += 1) {
      const b = compile(base, unit, mode);
      const h = compile(head, unit, mode);
      record.runs += 1;
      const entry = { mode, base: b, head: h, same: same(b, h) };
      if (!entry.same) record.differing += 1;
      for (const demand of demands) {
        const [db, dh] = [
          compile(base, unit, mode, { demand }),
          compile(head, unit, mode, { demand }),
        ];
        record.runs += 1;
        if (!same(db, dh)) {
          record.differing += 1;
          (entry.demands ??= []).push({ demand, base: db, head: dh });
        }
      }
      const c = heldCases?.get(unit.name);
      if (stops && c?.slice && b.error === null) {
        const list = searched(base, c, mode);
        const headList = searched(head, c, mode);
        entry.stops = {
          count: list.length,
          sameSet: JSON.stringify(list) === JSON.stringify(headList),
          differ: [],
        };
        if (!entry.stops.sameSet) record.differing += 1;
        for (const { allowance, phase } of list) {
          const [sb, sh] = [
            compile(base, unit, mode, allowance),
            compile(head, unit, mode, allowance),
          ];
          record.runs += 1;
          if (!same(sb, sh)) {
            record.differing += 1;
            entry.stops.differ.push({ allowance, phase, base: sb, head: sh });
          }
        }
        const analysed = analysisUnits(base, unit, mode);
        const analysedHead = analysisUnits(head, unit, mode);
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
              compile(head, unit, mode, allowance),
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
