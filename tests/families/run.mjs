// node tests/families/run.mjs <area> <base> <head> [--sizes 4,8] [--allowances natural,16,256] [--shard i/N]
//   [--timeout 180] [--memory 2048] [--out differences.jsonl]
// node tests/families/run.mjs <area> <head> --baseline <folder> [options]
// node tests/families/run.mjs <area> <tree> --store <folder> [--shard i/N]
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
// compared either, and is counted apart (`unanswered`) and kept in `--out`. With `--baseline`, the head alone runs, and
// each run is judged against the stored base result of the same source, mode and check (a source with each run it
// does not hold is kept in `--out` as `uncompared`, never agreement); `--store` runs one tree of a commit (sx-tree's,
// with `src/` and `.sha`) at the runner's defaults and stores one shard of each source's results, one JSON line each, in
// the baseline of its `src/` tree (`baselines.mjs`), whose area folder's `*.runs.jsonl` files `--baseline` then reads.
// Prints one JSON line per generator and a total: sources, unparsed, stalled, exceptions, unanswered, uncompared, modes,
// runs, differences.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  beginShard,
  DEFAULTS,
  endShard,
  identityOf,
  owned,
  planned,
  planOf,
} from "./baselines.mjs";
import { generatorsOf, placeOf, sourceKey } from "./sources.mjs";

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
 * `publication` split into the same parts, with the count its fifth element holds where it has one; `null` when the
 * files do not parse or resolve.
 */
function partHashes(oracle, files, mode, globals) {
  if (typeof oracle.publicationHashes === "function") {
    const hashes = oracle.publicationHashes(files, mode, globals);
    return Array.isArray(hashes) ? { parts: hashes, unanswered: 0 } : hashes;
  }
  const whole = oracle.publication(files, mode, globals);
  if (whole === null) return null;
  const [answers, record, occurrences, route, stopped] = JSON.parse(whole);
  return {
    parts: [answers, record, ...occurrences, route].map((part) => hash(JSON.stringify(part))),
    unanswered: stopped?.unanswered ?? 0,
  };
}

/**
 * A run's result by its hash (a publication's by its parts'), with a publication's part hashes (`parts`, each cut to 16
 * digits, which still place a difference and keep a stored run small) and unanswered nodes, and whether the files did
 * not parse.
 */
const digest = (value) => ({
  hash: hash(textOf(value?.parts ?? value)),
  parts: value?.parts?.map((part) => part.slice(0, 16)) ?? null,
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

/**
 * A run's outcome from the base's result (`was`, run or stored; none where the baseline has none) and the head's
 * (`is`): an exception on either, never compared (#1439); nodes left unanswered on either; with no base, `uncompared`,
 * never agreement; else a difference, or nothing where they agree.
 */
function judged(was, is) {
  if (was?.thrown !== undefined || is.thrown !== undefined)
    return { thrown: { base: was?.thrown, head: is.thrown } };
  if (was?.value.unanswered > 0 || is.value.unanswered > 0)
    return { unanswered: { base: was?.value.unanswered, head: is.value.unanswered } };
  if (was === undefined) return { uncompared: true };
  if (was.value.hash === is.value.hash) return {};
  return {
    difference: {
      base: was.value.hash.slice(0, 16),
      head: is.value.hash.slice(0, 16),
      ...firstPart(was.value.parts, is.value.parts),
    },
  };
}

if (process.argv[2] === "--child") {
  // the child: each source's runs in the four modes on each tree (the base and the head, or one)
  const { roots, allowances } = JSON.parse(process.argv[3]);
  const trees = await Promise.all(roots.map(oracles));
  const head = trees.at(-1);
  /**
   * `message` sent to the runner, once it is written: a send returns before that, and a process that ends with sends
   * still queued loses them.
   */
  const sent = (message) =>
    new Promise((resolve, reject) =>
      process.send(message, (error) => (error ? reject(error) : resolve())),
    );
  /**
   * One source's runs in the four modes on its trees, each run's outcome (`run`: a difference or an exception, or one
   * tree's result) sent as it ends and written before the next run starts, so that a later stall in the source keeps
   * it.
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
        const results = trees.map((tree) => attempt(() => digest(run(tree))));
        const is = results.at(-1);
        if (is.value?.unparsed) parsed = false;
        // one tree's result goes to the runner, which compares it with the stored one or stores it
        const outcome = results.length === 2 ? judged(results[0], is) : { result: is };
        await sent({ run: { mode: label, check, ...outcome } });
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
  // each option takes one value; the other arguments are the area and its trees
  const args = process.argv.slice(2);
  const options = new Map();
  const [area, ...roots] = args.filter((arg, index) => {
    if (arg.startsWith("--")) options.set(arg.slice(2), args[index + 1]);
    return !arg.startsWith("--") && !args[index - 1]?.startsWith("--");
  });
  const option = (name) => options.get(name);
  // the base against the head, the head against a stored baseline (`--baseline`), or one tree's runs stored (`--store`)
  const baseline = option("baseline");
  const store = option("store");
  const single = baseline !== undefined || store !== undefined;
  /** A usage the runner refuses (exit 2), before any source runs. */
  const refused = (problem) => {
    console.error(problem);
    process.exit(2);
  };
  if (area === undefined || roots.length !== (single ? 1 : 2) || (baseline && store))
    refused(
      "usage: node tests/families/run.mjs <area> <base> <head> [options]\n" +
        "       node tests/families/run.mjs <area> <head> --baseline <folder> [options]\n" +
        "       node tests/families/run.mjs <area> <tree> --store <folder> [--shard i/N]",
    );
  const sizesOption = option("sizes")?.split(",").map(Number);
  const allowances = (option("allowances") ?? DEFAULTS.allowances)
    .split(",")
    .map((text) => (text === "natural" ? null : Number(text)));
  const [shard, shards] = (option("shard") ?? "0/1").split("/").map(Number);
  // a baseline holds the runs of a commit's tree at the runner's defaults, so that every writer stores the same ones
  if (store !== undefined) {
    const changed = ["sizes", "allowances", "timeout", "memory"].filter((name) =>
      options.has(name),
    );
    const tree = roots[0];
    if (changed.length > 0)
      refused(`--store runs at the runner's defaults: drop --${changed.join(", --")}`);
    if (!(
      Number.isInteger(shards) &&
      shards > 0 &&
      Number.isInteger(shard) &&
      shard >= 0 &&
      shard < shards
    ))
      refused(`--shard ${option("shard")} is no shard i/N`);
    if (!existsSync(path.join(tree, "src")) || !existsSync(path.join(tree, ".sha")))
      refused(`${tree} is no built tree of a commit (sx-tree's, with src/ and .sha) to store`);
  }
  // 180 s by default, 60 s in CI (GitHub Actions sets `CI`), whose runs are the runner's own tests (owner, 2026-10-30)
  const seconds = Number(option("timeout") ?? DEFAULTS.timeout);
  const timeout = seconds * 1000;
  const memory = Number(option("memory") ?? DEFAULTS.memory);
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
  await Promise.all(roots.map(oracles));

  let child = null;
  /** A child process, keeping the end of its error output: a fatal V8 error says there why the process ended. */
  const fresh = () => {
    const created = fork(
      fileURLToPath(import.meta.url),
      ["--child", JSON.stringify({ roots, allowances })],
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
  // each generator's sources in this shard, and with `--store` all of them (the area's PLAN)
  const every = await generatorsOf(folder, sizesOption);
  const generators = every.map(({ sources, ...generator }) => ({
    ...generator,
    sources: sources.filter((_, index) => index % shards === shard),
  }));
  /** The stored runs of this shard's sources (each its line), by their place, from the baseline's `*.runs.jsonl`. */
  const stored = new Map();
  if (baseline !== undefined) {
    const files = existsSync(baseline)
      ? readdirSync(baseline).filter((file) => file.endsWith(".runs.jsonl"))
      : [];
    if (files.length === 0) {
      console.error(`no stored runs (*.runs.jsonl) in ${baseline}`);
      process.exit(2);
    }
    const places = new Set(
      generators.flatMap(({ name, sources }) => sources.map((source) => placeOf(name, source))),
    );
    for (const file of files.sort())
      for await (const line of createInterface({
        input: createReadStream(path.join(baseline, file)),
      })) {
        const { generator, source, key } = JSON.parse(line);
        const place = JSON.stringify([generator, source, key]);
        // (a stored shard's last line, its total, is no source's)
        if (!places.has(place)) continue;
        // a source stored twice with other results has no one baseline
        if (stored.has(place) && stored.get(place) !== line) {
          console.error(`${place} is stored twice, with other results, in ${baseline}`);
          process.exit(2);
        }
        stored.set(place, line);
      }
  }
  // `--store`: this shard of the area in the baseline of the tree's `src/` tree (`baselines.mjs`), which the tree must
  // share (its oracle library, lockfile and Node) and whose PLAN the area's sources must have; a shard that verifies, or
  // that a running writer stores, ends here
  let storing;
  if (store !== undefined) {
    const tree = path.resolve(roots[0]);
    const identity = identityOf(tree);
    if (identity.src === null) refused(`${tree}/src holds no file`);
    const commit = readFileSync(path.join(tree, ".sha"), "utf8").trim();
    const top = await owned(store, identity, `commit ${commit} ${tree}`);
    if (top.refused !== undefined) refused(top.refused);
    const dir = path.join(top.dir, path.basename(folder));
    const plan = await planned(top.dir, dir, planOf(path.basename(folder), every, shards));
    if (plan.refused !== undefined) refused(plan.refused);
    storing = beginShard(top.dir, dir, shard, shards, plan.plan, plan.places[shard]);
    if (storing.skipped !== undefined) {
      const { file, skipped } = storing;
      console.log(JSON.stringify({ area, shard: `${shard}/${shards}`, stored: file, skipped }));
      process.exit(0);
    }
    storing.made = { shard: `${shard}/${shards}`, commit, tree, ...identity };
  }
  /** What the stored tree and the head did (a stall's or an exception's text), where either did. */
  const either = (base, head) =>
    base === undefined && head === undefined ? undefined : { base, head };
  const counts = [
    "sources",
    "unparsed",
    "stalled",
    "exceptions",
    "unanswered",
    "uncompared",
    "runs",
    "differences",
  ];
  const zeros = () => Object.fromEntries(counts.map((key) => [key, 0]));
  const total = { area, generators: 0, ...zeros(), modes: 4 };
  for (const { name, checks, sources } of generators) {
    const row = { generator: name, ...zeros() };
    for (const source of sources) {
      row.sources += 1;
      const reply = await analysed({ files: source.files, checks, globals: source.globals });
      const inputs = { files: source.files, globals: source.globals };
      const line = stored.get(placeOf(name, source));
      const kept = line === undefined ? undefined : JSON.parse(line);
      const results = {};
      const uncompared = [];
      // the runs that ended count, those of a source that stalls or throws after them included
      row.runs += reply.runs.length;
      for (const { result, ...run } of reply.runs) {
        // one tree's result, judged against the stored one, where there is one
        const id = `${run.mode} ${run.check}`;
        results[id] = result;
        const outcome = result === undefined ? run : { ...run, ...judged(kept?.runs[id], result) };
        const { thrown: exception, unanswered, difference, uncompared: alone, ...where } = outcome;
        if (exception !== undefined) {
          row.exceptions += 1;
          thrown({ generator: name, source: source.name, ...where, thrown: exception }, source);
        } else if (unanswered !== undefined) {
          row.unanswered += 1;
          record({ generator: name, source: source.name, ...where, unanswered, ...inputs });
        } else if (difference !== undefined) {
          row.differences += 1;
          record({ generator: name, source: source.name, ...where, ...difference, ...inputs });
        } else if (alone && baseline !== undefined) uncompared.push(id);
      }
      if (uncompared.length > 0) {
        row.uncompared += uncompared.length;
        record({ generator: name, source: source.name, uncompared, ...inputs });
      }
      // with a baseline, a source stalls or throws outside its runs where either tree did, as with both trees run
      const stalled = baseline === undefined ? reply.stalled : either(kept?.stalled, reply.stalled);
      const failed =
        baseline === undefined ? reply.thrown : either(kept?.thrown?.runner, reply.thrown?.runner);
      if (storing !== undefined) {
        const key = sourceKey(source);
        const entry = { generator: name, source: source.name, key, stalled, thrown: failed };
        appendFileSync(storing.tmp, `${JSON.stringify({ ...entry, runs: results })}\n`);
      }
      // (with a baseline, one tree may stall where the other threw)
      if (stalled !== undefined) {
        row.stalled += 1;
        record({ generator: name, source: source.name, stalled, ...inputs });
      }
      if (failed !== undefined) {
        row.exceptions += 1;
        thrown({ generator: name, source: source.name, thrown: failed }, source);
      } else if (stalled === undefined && !reply.parsed) row.unparsed += 1;
    }
    console.log(JSON.stringify(row));
    total.generators += 1;
    for (const key of counts) total[key] += row[key];
  }
  child?.kill();
  const ended = { ...total, timeout: seconds, node: process.version };
  if (storing !== undefined) {
    // the shard whole, its total last, with what made it
    const runner = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url)));
    const made = { ...ended, ...storing.made, runner: runner.digest("hex") };
    const published = await endShard(storing, made);
    // (foreign contents or a retired baseline, found at publication: nothing is published)
    if (published.refused !== undefined) refused(published.refused);
    Object.assign(ended, { stored: storing.file, verified: published.verified });
  }
  console.log(JSON.stringify(ended));
  process.exitCode =
    total.differences + total.stalled + total.exceptions + total.unanswered + total.uncompared === 0
      ? 0
      : 1;
}
