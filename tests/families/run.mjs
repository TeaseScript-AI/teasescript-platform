// node tests/families/run.mjs <area> <base> <head> [--sizes 4,8] [--allowances natural,16,256] [--shard i/N]
//   [--timeout 60] [--memory 2048] [--out differences.jsonl]
// Runs every generator of tests/families/<area>/ (or of the folder an absolute <area> names) against two built trees (a
// checkout with `dist/`, or `dist/` itself), in the four modes (source and reversed order, the sharing on and off), and
// compares what the sources publish (`publication`, part by part: a difference names the first part that differs,
// #1503) and, for a generator whose `checks` include "stops", which decisions stop and when (`stopSet`) at each demand
// allowance. Each tree's own oracle library (`dist/tests/helpers/type-core-oracles.js`) analyses its sources, in a
// child process: a source that takes longer than `--timeout` seconds, more than `--memory` MB of heap, or that ends the
// process (a fatal V8 error) is counted as stalled, with the reason, and the next source runs in a fresh process. A run
// that throws on either tree is an exception, never compared (#1439): printed to stderr with its source, mode and
// check, and kept with its stack in `--out`, as is a difference, also where the source stalls later. A publication whose
// oracle left nodes unanswered at its own budget stop (`publicationHashes`'s `unanswered`) on either tree is never
// compared either, and is counted apart (`unanswered`) and kept in `--out`. Prints one JSON line per generator and a
// total: sources, unparsed, stalled, exceptions, unanswered, modes, runs, differences.
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

/** An oracle's result as text (the publication's own text as it is: encoding it again would double a large one). */
const textOf = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/** An exception as text: its stack where it has one, whose first line is its message. */
const thrownText = (error) => String(error?.stack ?? error).slice(0, 2000);

/**
 * What `run` returns (`value`), or the exception it throws (`thrown`), which is never compared: identical exceptions on
 * both trees are not agreement (#1439).
 */
function attempt(run) {
  try {
    return { value: run() };
  } catch (error) {
    return { thrown: thrownText(error) };
  }
}

const hash = (text) => createHash("sha256").update(text).digest("hex");

/**
 * A publication's parts, each by its hash, in the whole's order (#1503), and the nodes its oracle left unanswered
 * (`unanswered`): the tree's `publicationHashes`, which hashes each part as it is made and never holds the whole, as
 * this library writes it or as a library before `unanswered` did (its parts alone), or an older library's
 * `publication` split into the same parts; `null` when the files do not parse or resolve.
 */
function partHashes(oracle, files, mode, globals) {
  if (typeof oracle.publicationHashes === "function") {
    const hashes = oracle.publicationHashes(files, mode, globals);
    return Array.isArray(hashes) ? { parts: hashes, unanswered: 0 } : hashes;
  }
  const whole = oracle.publication(files, mode, globals);
  if (whole === null) return null;
  const [answers, record, occurrences, route] = JSON.parse(whole);
  return {
    parts: [answers, record, ...occurrences, route].map((part) => hash(JSON.stringify(part))),
    unanswered: 0,
  };
}

/**
 * A run's result by its hash (a publication's by its parts'), with a publication's part hashes (`parts`) and unanswered
 * nodes, and whether the files did not parse.
 */
const digest = (value) => ({
  hash: hash(textOf(value?.parts ?? value)),
  parts: value?.parts ?? null,
  unanswered: value?.unanswered ?? 0,
  unparsed: value === null,
});

/** Where two publications' parts first differ: the part's index in the whole's order and each one's count of parts. */
function firstPart(was, is) {
  if (was === null || is === null) return {};
  let part = 0;
  while (part < was.length && part < is.length && was[part] === is[part]) part += 1;
  return { part, parts: [was.length, is.length] };
}

if (process.argv[2] === "--child") {
  // the child: each source's runs in the four modes on both trees
  const { baseRoot, headRoot, allowances } = JSON.parse(process.argv[3]);
  const [base, head] = await Promise.all([oracles(baseRoot), oracles(headRoot)]);
  /**
   * `message` sent to the runner, once it is written: a send returns before that, and a process that ends with sends
   * still queued loses them.
   */
  const sent = (message) =>
    new Promise((resolve, reject) =>
      process.send(message, (error) => (error ? reject(error) : resolve())),
    );
  /**
   * One source's runs in the four modes on both trees, each run's outcome sent as it ends (`run`: a difference or an
   * exception) and written before the next run starts, so that a later stall in the same source keeps it.
   */
  const compared = async ({ files, checks, globals }) => {
    let parsed = true;
    for (const mode of head.MODES) {
      const label = `${mode.reversed ? "rev" : "src"}-${mode.unshared ? "off" : "on"}`;
      const runs = [];
      if (checks.includes("publication"))
        runs.push(["publication", (oracle) => partHashes(oracle, files, mode, globals)]);
      if (checks.includes("stops"))
        for (const allowance of allowances)
          runs.push([
            `stops ${allowance ?? "natural"}`,
            (oracle) => oracle.stopSet(files, mode, globals, allowance),
          ]);
      for (const [check, run] of runs) {
        // compared by hash, so that the base's text is not held while the head runs
        const was = attempt(() => digest(run(base)));
        const is = attempt(() => digest(run(head)));
        if (is.value?.unparsed) parsed = false;
        const outcome = { mode: label, check };
        if ("thrown" in was || "thrown" in is)
          outcome.thrown = { base: was.thrown, head: is.thrown };
        else if (was.value.unanswered > 0 || is.value.unanswered > 0)
          outcome.unanswered = { base: was.value.unanswered, head: is.value.unanswered };
        else if (was.value.hash !== is.value.hash)
          outcome.difference = {
            base: was.value.hash.slice(0, 16),
            head: is.value.hash.slice(0, 16),
            ...firstPart(was.value.parts, is.value.parts),
          };
        await sent({ run: outcome });
      }
    }
    return { parsed };
  };
  // an exception outside the runs (the runner's own, or a library without `MODES`) is the source's exception, not a
  // stall: the process that ends with it would say only its exit code
  process.on("message", async (message) => {
    let reply;
    try {
      reply = await compared(message);
    } catch (error) {
      reply = { thrown: { runner: thrownText(error) } };
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
  /** An exception: on stderr with each message (its first line), in `--out` with each stack and the source. */
  const thrown = (line, source) => {
    const messages = Object.entries(line.thrown).map(([where, text]) => [
      where,
      text?.split("\n", 1)[0],
    ]);
    console.error(JSON.stringify({ ...line, thrown: Object.fromEntries(messages) }));
    record({ ...line, files: source.files, globals: source.globals });
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
  /**
   * One source's reply, or why it stalled (`timeout`, or how the process ended), with the runs that ended (`runs`). At
   * the deadline the process ends and the runs it had written are read before it closes: a source whose timeout
   * callback has run stalls, with them.
   */
  const analysed = (message) =>
    new Promise((resolve) => {
      // a child that ended between sources (its channel closed) is replaced, not given the next source
      if (child?.connected !== true) child = fresh();
      const current = child;
      const runs = [];
      let expired = false;
      const onMessage = (reply) => {
        if ("run" in reply) runs.push(reply.run);
        else if (!expired) settle(reply);
      };
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
        resolve({ ...(expired ? { stalled: "timeout" } : result), runs });
      };
      // (the process's `close` then settles the source, after the frames it had written)
      const timer = setTimeout(() => {
        expired = true;
        current.kill("SIGKILL");
      }, timeout);
      current.on("message", onMessage).on("error", onError).on("close", onClose);
      current.send(message);
    });

  const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), area);
  const generators = readdirSync(folder)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  const counts = [
    "sources",
    "unparsed",
    "stalled",
    "exceptions",
    "unanswered",
    "runs",
    "differences",
  ];
  const zeros = () => Object.fromEntries(counts.map((key) => [key, 0]));
  const total = { area, generators: 0, ...zeros(), modes: 4 };
  for (const name of generators) {
    const generator = await import(pathToFileURL(path.join(folder, name)).href);
    const checks = generator.checks ?? ["publication"];
    const row = { generator: name, ...zeros() };
    const sources = sourcesOf(generator, sizesOption).filter(
      (_, index) => index % shards === shard,
    );
    for (const source of sources) {
      row.sources += 1;
      const reply = await analysed({ files: source.files, checks, globals: source.globals });
      const inputs = { files: source.files, globals: source.globals };
      // the runs that ended count, those of a source that stalls or throws after them included
      row.runs += reply.runs.length;
      for (const { thrown: exception, unanswered, difference, ...run } of reply.runs)
        if (exception !== undefined) {
          row.exceptions += 1;
          thrown({ generator: name, source: source.name, ...run, thrown: exception }, source);
        } else if (unanswered !== undefined) {
          row.unanswered += 1;
          record({ generator: name, source: source.name, ...run, unanswered, ...inputs });
        } else if (difference !== undefined) {
          row.differences += 1;
          record({ generator: name, source: source.name, ...run, ...difference, ...inputs });
        }
      if ("stalled" in reply) {
        row.stalled += 1;
        record({ generator: name, source: source.name, stalled: reply.stalled, ...inputs });
      } else if ("thrown" in reply) {
        row.exceptions += 1;
        thrown({ generator: name, source: source.name, thrown: reply.thrown }, source);
      } else if (!reply.parsed) row.unparsed += 1;
    }
    console.log(JSON.stringify(row));
    total.generators += 1;
    for (const key of counts) total[key] += row[key];
  }
  child?.kill();
  console.log(JSON.stringify({ ...total, node: process.version }));
  process.exitCode =
    total.differences + total.stalled + total.exceptions + total.unanswered === 0 ? 0 : 1;
}
