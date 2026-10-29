// node tests/families/run.mjs <area> <base> <head> [--sizes 4,8] [--allowances natural,16,256] [--shard i/N]
//   [--timeout 60] [--memory 2048] [--out differences.jsonl]
// Runs every generator of tests/families/<area>/ against two built trees (a checkout with `dist/`, or `dist/` itself),
// in the four modes (source and reversed order, the sharing on and off), and compares what the sources publish
// (`publication`) and, for a generator whose `checks` include "stops", which decisions stop and when (`stopSet`) at each
// demand allowance. Each tree's own oracle library (`dist/tests/helpers/type-core-oracles.js`) analyses its sources, in
// a worker thread: a source that takes longer than `--timeout` seconds or more than `--memory` MB of heap is counted as
// stalled and the next source runs in a fresh worker. Prints one JSON line per generator and a total: sources,
// unparsed, stalled, modes, runs, differences.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

/** The host globals a source may read, unless its generator exports its own `globals`. */
const GLOBALS = ["hostValue", "hostOther", "hostInit", "otherHost"];

/** A tree's oracle library, from its `dist/`. */
async function oracles(root) {
  const dist = existsSync(path.join(root, "dist", "tests")) ? path.join(root, "dist") : root;
  const file = path.join(dist, "tests", "helpers", "type-core-oracles.js");
  if (!existsSync(file)) throw new Error(`no oracle library at ${file}: build the tree first`);
  return import(pathToFileURL(file).href);
}

/** What `run` returns, as text; an exception's message where it throws (both trees are held to the same). */
function attempt(run) {
  try {
    return JSON.stringify(run());
  } catch (error) {
    return `error: ${String(error).slice(0, 300)}`;
  }
}

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

if (!isMainThread) {
  // the worker: each source's runs in the four modes on both trees
  const { baseRoot, headRoot, allowances } = workerData;
  const [base, head] = await Promise.all([oracles(baseRoot), oracles(headRoot)]);
  parentPort.on("message", ({ files, checks, globals }) => {
    const reply = { runs: 0, parsed: true, differences: [] };
    for (const mode of head.MODES) {
      const runs = [];
      if (checks.includes("publication"))
        runs.push(["publication", (oracle) => oracle.publication(files, mode, globals)]);
      if (checks.includes("stops"))
        for (const allowance of allowances)
          runs.push([
            `stops ${allowance ?? "natural"}`,
            (oracle) => oracle.stopSet(files, mode, globals, allowance),
          ]);
      for (const [check, run] of runs) {
        const [was, is] = [attempt(() => run(base)), attempt(() => run(head))];
        if (is === "null") reply.parsed = false;
        reply.runs += 1;
        if (was !== is)
          reply.differences.push({
            mode: `${mode.reversed ? "rev" : "src"}-${mode.unshared ? "off" : "on"}`,
            check,
            base: hash(was),
            head: hash(is),
          });
      }
    }
    parentPort.postMessage(reply);
  });
} else {
  const [area, baseRoot, headRoot, ...rest] = process.argv.slice(2);
  if (area === undefined || baseRoot === undefined || headRoot === undefined) {
    console.error("usage: node tests/families/run.mjs <area> <base> <head> [options]");
    process.exit(2);
  }
  const option = (name) => {
    const index = rest.indexOf(`--${name}`);
    return index === -1 ? undefined : rest[index + 1];
  };
  const sizesOption = option("sizes")?.split(",").map(Number);
  const allowances = (option("allowances") ?? "natural,16,256")
    .split(",")
    .map((text) => (text === "natural" ? null : Number(text)));
  const [shard, shards] = (option("shard") ?? "0/1").split("/").map(Number);
  const timeout = Number(option("timeout") ?? 60) * 1000;
  const memory = Number(option("memory") ?? 2048);
  const out = option("out");
  if (out !== undefined) writeFileSync(out, "");
  const record = (line) => {
    if (out !== undefined) appendFileSync(out, `${JSON.stringify(line)}\n`);
  };
  // fail before the first source when a tree has no library
  await Promise.all([oracles(baseRoot), oracles(headRoot)]);

  let worker = null;
  const fresh = () =>
    new Worker(fileURLToPath(import.meta.url), {
      workerData: { baseRoot, headRoot, allowances },
      resourceLimits: { maxOldGenerationSizeMb: memory },
    });
  /** One source's reply, or why it stalled (`timeout`, or the worker's error). */
  const analysed = (message) =>
    new Promise((resolve) => {
      worker ??= fresh();
      const current = worker;
      const onMessage = (reply) => settle(reply);
      const onError = (error) => settle({ stalled: String(error).slice(0, 200) });
      const onExit = (code) => settle({ stalled: `exit ${code}` });
      // (only these listeners go: the worker keeps its port referenced through its own)
      const settle = (result) => {
        clearTimeout(timer);
        current.off("message", onMessage).off("error", onError).off("exit", onExit);
        if ("stalled" in result) {
          worker = null;
          void current.terminate();
        }
        resolve(result);
      };
      const timer = setTimeout(() => settle({ stalled: "timeout" }), timeout);
      current.on("message", onMessage).on("error", onError).on("exit", onExit);
      current.postMessage(message);
    });

  /** A generator's sources: its fixed `cases`, and each of its `shapes` at each size. */
  const sourcesOf = (generator) => {
    const files = (value) =>
      typeof value === "string" ? [{ path: "main.tease", source: value }] : value;
    const cases = (generator.cases ?? []).map(([name, value]) => ({ name, files: files(value) }));
    const shapes = generator.shapes ?? {};
    const sized = (sizesOption ?? generator.sizes ?? [4, 8]).flatMap((size) =>
      Object.entries(shapes).map(([name, shape]) => ({
        name: `${name}@${size}`,
        files: files(shape(size)),
      })),
    );
    return [...cases, ...sized];
  };

  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), area);
  const generators = readdirSync(folder)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  const counts = ["sources", "unparsed", "stalled", "runs", "differences"];
  const total = { area, generators: 0, sources: 0, unparsed: 0, stalled: 0, modes: 4, runs: 0 };
  total.differences = 0;
  for (const name of generators) {
    const generator = await import(pathToFileURL(path.join(folder, name)).href);
    const checks = generator.checks ?? ["publication"];
    const globals = generator.globals ?? GLOBALS;
    const row = { generator: name, sources: 0, unparsed: 0, stalled: 0, runs: 0, differences: 0 };
    const sources = sourcesOf(generator).filter((_, index) => index % shards === shard);
    for (const source of sources) {
      row.sources += 1;
      const reply = await analysed({ files: source.files, checks, globals });
      if ("stalled" in reply) {
        row.stalled += 1;
        record({
          generator: name,
          source: source.name,
          stalled: reply.stalled,
          files: source.files,
        });
        continue;
      }
      row.runs += reply.runs;
      if (!reply.parsed) row.unparsed += 1;
      row.differences += reply.differences.length;
      for (const difference of reply.differences)
        record({ generator: name, source: source.name, ...difference, files: source.files });
    }
    console.log(JSON.stringify(row));
    total.generators += 1;
    for (const key of counts) total[key] += row[key];
  }
  await worker?.terminate();
  console.log(JSON.stringify({ ...total, node: process.version }));
  process.exitCode = total.differences === 0 && total.stalled === 0 ? 0 : 1;
}
