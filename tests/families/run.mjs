// node tests/families/run.mjs <area> <base> <head> [--sizes 4,8] [--allowances natural,16,256] [--shard i/N]
//   [--timeout 60] [--memory 2048] [--out differences.jsonl]
// Runs every generator of tests/families/<area>/ against two built trees (a checkout with `dist/`, or `dist/` itself),
// in the four modes (source and reversed order, the sharing on and off), and compares what the sources publish
// (`publication`) and, for a generator whose `checks` include "stops", which decisions stop and when (`stopSet`) at each
// demand allowance. Each tree's own oracle library (`dist/tests/helpers/type-core-oracles.js`) analyses its sources, in
// a child process: a source that takes longer than `--timeout` seconds, more than `--memory` MB of heap, or that ends
// the process (a fatal V8 error) is counted as stalled, with the reason, and the next source runs in a fresh process.
// Prints one JSON line per generator and a total: sources, unparsed, stalled, modes, runs, differences.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourcesOf } from "./sources.mjs";

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

if (process.argv[2] === "--child") {
  // the child: each source's runs in the four modes on both trees
  const { baseRoot, headRoot, allowances } = JSON.parse(process.argv[3]);
  const [base, head] = await Promise.all([oracles(baseRoot), oracles(headRoot)]);
  process.on("message", ({ files, checks, globals }) => {
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
    process.send(reply);
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

  let child = null;
  /** A child process, keeping the end of its error output: a fatal V8 error says there why the process ended. */
  const fresh = () => {
    const created = fork(
      fileURLToPath(import.meta.url),
      ["--child", JSON.stringify({ baseRoot, headRoot, allowances })],
      {
        execArgv: [`--max-old-space-size=${memory}`],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    created.errors = "";
    created.stderr.on("data", (chunk) => {
      created.errors = (created.errors + chunk).slice(-4000);
    });
    return created;
  };
  // a runner stopped by a signal stops its child first (it would go on analysing), then ends by that signal
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => {
      child?.kill("SIGKILL");
      process.kill(process.pid, signal);
    });
  /** One source's reply, or why it stalled (`timeout`, or how the process ended). */
  const analysed = (message) =>
    new Promise((resolve) => {
      // a child that ended between sources (its channel closed) is replaced, not given the next source
      if (child?.connected !== true) child = fresh();
      const current = child;
      const onMessage = (reply) => settle(reply);
      const onError = (error) => settle({ stalled: String(error).slice(0, 200) });
      // after `close`, the process's error output is complete
      const onClose = (code, signal) => {
        const fatal = /FATAL ERROR: [^\n]*/.exec(current.errors)?.[0];
        settle({
          stalled: [signal ?? `exit ${code}`, fatal].filter(Boolean).join(": ").slice(0, 200),
        });
      };
      const settle = (result) => {
        clearTimeout(timer);
        current.off("message", onMessage).off("error", onError).off("close", onClose);
        if ("stalled" in result) {
          child = null;
          current.kill("SIGKILL");
        }
        resolve(result);
      };
      const timer = setTimeout(() => settle({ stalled: "timeout" }), timeout);
      current.on("message", onMessage).on("error", onError).on("close", onClose);
      current.send(message);
    });

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
    const row = { generator: name, sources: 0, unparsed: 0, stalled: 0, runs: 0, differences: 0 };
    const sources = sourcesOf(generator, sizesOption).filter(
      (_, index) => index % shards === shard,
    );
    for (const source of sources) {
      row.sources += 1;
      const reply = await analysed({ files: source.files, checks, globals: source.globals });
      if ("stalled" in reply) {
        row.stalled += 1;
        record({
          generator: name,
          source: source.name,
          stalled: reply.stalled,
          files: source.files,
          globals: source.globals,
        });
        continue;
      }
      row.runs += reply.runs;
      if (!reply.parsed) row.unparsed += 1;
      row.differences += reply.differences.length;
      for (const difference of reply.differences)
        record({
          generator: name,
          source: source.name,
          ...difference,
          files: source.files,
          globals: source.globals,
        });
    }
    console.log(JSON.stringify(row));
    total.generators += 1;
    for (const key of counts) total[key] += row[key];
  }
  child?.kill();
  console.log(JSON.stringify({ ...total, node: process.version }));
  process.exitCode = total.differences === 0 && total.stalled === 0 ? 0 : 1;
}
