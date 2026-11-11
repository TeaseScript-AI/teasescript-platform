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
import { unitsOf } from "./units.mjs";

/** The exit of a worker whose run passed the unit limit, after it posted the run (`over`). */
const OVER_EXIT = 86;

const distOf = (root) => (existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root);

/** `set` as a path where it names an area of the head tree's `tests/families`, else as given. */
const setOf = (set, headRoot) => {
  if (["corpus", "fixture", "held"].includes(set) || set.includes("/")) return set;
  return path.join(headRoot, "tests", "families", set);
};

/** A compile's parts as a record holds them, each by the name the summary prints, in that order. */
const PARTS = [
  ["plan", "plan"],
  ["diagnostics", "diagnostics"],
  ["error", "error"],
  ["questions", "questions"],
  ["trace", "work"],
];
/** The parts that make a publication: what a compile emits, as against what it asks and charges. */
const OUTPUT = new Set(["plan", "diagnostics", "error"]);

/** The parts in which two compiles of a record (each proved by `recordFault`) differ, by their printed names. */
function partsApart(b, h) {
  return PARTS.filter(([field]) => b[field] !== h[field]).map(([, name]) => name);
}

/**
 * A difference's one class, by precedence: `publication` where the output differs (whatever else does), else
 * `questions`, else `work`.
 */
function classOf(parts) {
  if (parts.some((part) => OUTPUT.has(part))) return "publication";
  return parts.includes("questions") ? "questions" : "work";
}

const whole = (value) => Number.isInteger(value) && value >= 0;
const text = (value) => typeof value === "string";
const textOrNull = (value) => value === null || text(value);
/** Whether `value` is an object with every key of `required` and no key outside `required` and `optional`. */
const shaped = (value, required, optional = []) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
/**
 * An allowance as a pair records it (R19): every runner on main writes what `--demands`' `map(Number)`, the tree's
 * `heldStops` or the questions phase's sums give, unchecked, so any number, and `null` for one JSON cannot hold (NaN,
 * an infinity).
 */
const allowanceOf = (n) => n === null || typeof n === "number";
/** A run's place at an allowance (`demand 16`, `allowance 0`), the allowance in JavaScript's own text of that number. */
const atAllowance = (at) => {
  const [, number] = /^(?:demand|allowance) (.+)$/.exec(at) ?? [];
  return number !== undefined && String(Number(number)) === number;
};
/** A mode as a record names it: a `HeldMode` name, or before #2342 its index, 0 to 3. */
const modeName = (mode) =>
  (text(mode) && mode !== "") || (Number.isInteger(mode) && mode >= 0 && mode < 4);

// (the forms every runner on main writes: a digest is sha256's first 32 hex digits; a count is a whole number's text; a
// trace or questions hash is two 32-bit words, each in hex without leading zeros, side by side)
const DIGEST = /^[0-9a-f]{32}$/;
const COUNT = "(?:0|[1-9]\\d*)";
const WORDS = "(?:0|[1-9a-f][0-9a-f]{0,7})(?:0|[1-9a-f][0-9a-f]{0,7})";
const TRACE = new RegExp(`^${COUNT}/(${COUNT})/${WORDS}$`);
const QUESTIONS = new RegExp(`^${COUNT}/${WORDS}$`);

/** Why `c` is no compile `compile` writes, else undefined. */
function compileFault(c) {
  if (!shaped(c, ["plan", "diagnostics", "checks", "error", "trace", "questions", "units"]))
    return "a compile without exactly its seven parts";
  if (![c.plan, c.diagnostics].every((part) => part === null || (text(part) && DIGEST.test(part))))
    return "a compile's plan or diagnostics neither a digest nor null";
  if (!textOrNull(c.error)) return "a compile's error neither text nor null";
  const trace = text(c.trace) ? TRACE.exec(c.trace) : null;
  if (trace === null) return "a compile's trace not n/units/hash";
  if (!text(c.questions) || !QUESTIONS.test(c.questions)) return "a compile's questions not n/hash";
  if (!whole(c.checks) || !whole(c.units)) return "a compile's checks or units no whole number";
  if (c.units !== Number(trace[1])) return "a compile's units not its trace's";
  return undefined;
}

/** Why `pair` (`{base, head}` and the `fields` it also holds) is no pair the runner writes, else undefined. */
function pairFault(pair, fields, differing) {
  if (!shaped(pair, ["base", "head", ...Object.keys(fields)]))
    return `a compared pair without exactly ${["base", "head", ...Object.keys(fields)].join(", ")}`;
  for (const [field, proved] of Object.entries(fields))
    if (!proved(pair[field])) return `a compared pair's ${field} not one the runner writes`;
  const fault = compileFault(pair.base) ?? compileFault(pair.head);
  if (fault !== undefined) return fault;
  // (the runner keeps a demand, stop or questions-phase pair only where its compiles differ)
  if (differing && partsApart(pair.base, pair.head).length === 0)
    return "a pair kept as differing whose compiles do not differ";
  return undefined;
}

const listOf = (value, fault) =>
  Array.isArray(value) ? value.map(fault).find((each) => each !== undefined) : "no list";

/**
 * Why a records line is not one `plans.mjs` writes (#2341, under the lead's rulings R13 and R21), else undefined: the
 * closed set of its keys, types and value formats, a source's (its runs, or a stall or a safety net reached) with its
 * modes, compiles and pairs. It does not prove the invariants between one record's fields.
 */
function recordFault(r) {
  if (
    !shaped(
      r,
      ["set", "name"],
      ["key", "runs", "differing", "modes", "stalled", "uncharged", "run", "work", "allowance"],
    )
  )
    return "no source record";
  if (!text(r.set) || !text(r.name)) return "a set or name that is no text";
  if (r.key !== undefined && !(text(r.key) && /^[0-9a-f]{64}$/.test(r.key)))
    return "a key that is no sha256";
  if (r.uncharged !== undefined && !(text(r.uncharged) && /^safety net .+ s$/.test(r.uncharged)))
    return "a safety net reached that the runner does not word so";
  const ends = ["stalled", "uncharged"].filter((key) => r[key] !== undefined);
  if (ends.length > 0) {
    if (ends.length > 1 || !text(r[ends[0]])) return "a stall that is not one text";
    if (["runs", "differing", "modes"].some((key) => r[key] !== undefined))
      return "a stall that also holds runs";
    const run = r.run;
    if (
      run !== null &&
      !(
        shaped(run, ["tree", "mode", "at"], ["analysis"]) &&
        ["base", "head"].includes(run.tree) &&
        modeName(run.mode) &&
        text(run.at) &&
        // (a compile's run, or the stop search's, which alone counts its analyses)
        (["stop search", "stop search, between"].includes(run.at)
          ? whole(run.analysis)
          : run.analysis === undefined &&
            (run.at === "natural" || run.at === "analysis" || atAllowance(run.at)))
      )
    )
      return "a stall's run not one the runner names";
    if (["work", "allowance"].some((key) => r[key] !== undefined && !whole(r[key])))
      return "a stall's work or allowance no whole number";
    return undefined;
  }
  if (["run", "work", "allowance"].some((key) => r[key] !== undefined))
    return "a run's stall fields without a stall";
  if (!whole(r.runs) || !whole(r.differing)) return "runs or differing no whole number";
  if (!Array.isArray(r.modes) || r.modes.length === 0) return "no modes";
  if (new Set(r.modes.map((m) => m?.mode)).size !== r.modes.length) return "a mode twice";
  for (const m of r.modes) {
    if (!shaped(m, ["mode", "base", "head", "same"], ["demands", "stops", "questions"]))
      return "a mode not one the runner writes";
    if (!modeName(m.mode)) return "a mode named neither by a name nor by an index 0 to 3";
    const fault =
      pairFault({ base: m.base, head: m.head }, {}, false) ??
      (m.demands === undefined
        ? undefined
        : listOf(m.demands, (d) => pairFault(d, { demand: allowanceOf }, true))) ??
      stopsFault(m.stops) ??
      questionsFault(m.questions);
    if (fault !== undefined) return fault;
    if (typeof m.same !== "boolean" || m.same !== (partsApart(m.base, m.head).length === 0))
      return "same that is not whether the compiles' parts are equal";
  }
  return undefined;
}

/** Why a mode's `stops` is not one the runner writes, else undefined. */
function stopsFault(stops) {
  if (stops === undefined) return undefined;
  // (a held case whose base compile failed, #2340)
  if (shaped(stops, ["unavailable"]))
    return text(stops.unavailable) ? undefined : "stops unavailable without its reason";
  if (!shaped(stops, ["count", "sameSet", "differ"], ["base", "head"]))
    return "stops not one the runner writes";
  if (!whole(stops.count) || typeof stops.sameSet !== "boolean")
    return "stops' count or sameSet malformed";
  // (both trees' lists, where the sets differ, #2340; none in a record from before it)
  const lists = ["base", "head"].filter((side) => stops[side] !== undefined);
  if (lists.length === 1) return "one tree's stop list without the other's";
  if (lists.length === 2) {
    if (stops.sameSet) return "stop lists kept for a stop set the same on both trees";
    const fault = stopListFault(stops.base) ?? stopListFault(stops.head);
    if (fault !== undefined) return fault;
    if (stops.count !== stops.base.length) return "a count that is not the base's stops";
    if (JSON.stringify(stops.base) === JSON.stringify(stops.head))
      return "stop lists equal where the sets differ";
  }
  return listOf(stops.differ, (d) => pairFault(d, { allowance: allowanceOf, phase: text }, true));
}

/**
 * Why `list` is no stop list the runner writes, else undefined: `{allowance, phase}` stops as the tree's `heldStops(…, 1)`
 * gives them, unchecked, so an allowance as any pair holds one (R19), in any order (R21: the order of a tree's phases
 * and allowances is the tree's, not the record's form).
 */
function stopListFault(list) {
  if (!Array.isArray(list)) return "a stop list that is no list";
  for (const stop of list)
    if (!shaped(stop, ["allowance", "phase"]) || !allowanceOf(stop.allowance) || !text(stop.phase))
      return "a stop that is no {allowance, phase}";
  return undefined;
}

/** Why a mode's `questions` (the questions phase) is not one the runner writes, else undefined. */
function questionsFault(q) {
  if (q === undefined) return undefined;
  if (!shaped(q, ["analysis", "analysisHead", "compile", "sampled", "differ"]))
    return "questions phase not one the runner writes";
  if (
    ![q.analysis, q.analysisHead].every((n) => n === null || whole(n)) ||
    !whole(q.compile) ||
    !whole(q.sampled)
  )
    return "questions phase's units malformed";
  return listOf(q.differ, (d) => pairFault(d, { allowance: allowanceOf }, true));
}

/**
 * A demand row as #2341 reads it: its parts apart, its class, and for each tree the parts in which its compile at the
 * allowance differs from that tree's own unstopped compile in the mode (`natural`), so that which tree the allowance
 * stops, by its output, is a fact of the record: `base`, `head`, `both` or `neither`.
 */
function demandRow(d, natural) {
  const parts = partsApart(d.base, d.head);
  const own = { base: partsApart(natural.base, d.base), head: partsApart(natural.head, d.head) };
  const stops = (side) => own[side].some((part) => OUTPUT.has(part));
  const stopped =
    stops("base") && stops("head")
      ? "both"
      : stops("base")
        ? "base"
        : stops("head")
          ? "head"
          : "neither";
  return { parts, kind: classOf(parts), own, stopped };
}

/**
 * What differs between two trees' settled stops (`stops.base`, `stops.head`, #2340, each proved by `stopListFault`), a
 * stop known by its phase: a phase on the head alone is `added`, on the base alone `removed`, on both at other
 * allowances `moved`; each with both trees' allowances in that phase, ascending (a null last), so that allowances in
 * another order are no move (#2340's round 1, the order being the tree's, R21). Known limit: a stop that changes phase over an
 * overlapping allowance range reads as one removed and one added. `null` where the record holds no lists (one from
 * before #2340), never equal.
 */
function stopMoves({ base, head }) {
  if (base === undefined) return null;
  const byPhase = (list) => {
    const phases = new Map();
    for (const stop of list) {
      if (!phases.has(stop.phase)) phases.set(stop.phase, []);
      phases.get(stop.phase).push(stop.allowance);
    }
    for (const allowances of phases.values())
      allowances.sort((x, y) => (x === null) - (y === null) || x - y);
    return phases;
  };
  const [b, h] = [byPhase(base), byPhase(head)];
  return [...new Set([...b.keys(), ...h.keys()])].flatMap((phase) => {
    const [was, is] = [b.get(phase) ?? [], h.get(phase) ?? []];
    if (JSON.stringify(was) === JSON.stringify(is)) return [];
    const kind = was.length === 0 ? "added" : is.length === 0 ? "removed" : "moved";
    return [{ phase, kind, base: was, head: is }];
  });
}

/** Allowances in the list's order as runs, each increasing by exactly 1 (`5..7, 9`, `0.5..2.5`), or `none`. */
const runsOf = (allowances) => {
  const runs = [];
  for (const allowance of allowances) {
    const last = runs.at(-1);
    if (last !== undefined && allowance === last[1] + 1) last[1] = allowance;
    else runs.push([allowance, allowance]);
  }
  return runs.length === 0
    ? "none"
    : runs.map(([low, high]) => (low === high ? `${low}` : `${low}..${high}`)).join(", ");
};

/** The records' classification (`summary`): one line per set, then each difference, stall and safety net reached. */
function summarize(files, limit) {
  const sets = new Map();
  const listed = [];
  let numbered = false;
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
        demandPublication: 0,
        demandQuestions: 0,
        demandWork: 0,
        demandStopsBase: 0,
        demandStopsHead: 0,
        demandStopsBoth: 0,
        demandStopsNeither: 0,
        stopSet: 0,
        stopsAdded: 0,
        stopsRemoved: 0,
        stopsMoved: 0,
        stopsUnavailable: 0,
        stoppedCompile: 0,
        analysisApart: 0,
        stalled: 0,
        uncharged: 0,
      });
    sets.get(set)[key] += 1;
  };
  // (every line proved before any is read: one that is not a record `plans.mjs` writes refuses the input, R13)
  const rows = [];
  for (const file of files)
    for (const [at, line] of readFileSync(file, "utf8").split("\n").entries()) {
      if (line === "") continue;
      let record;
      let fault;
      try {
        record = JSON.parse(line);
        fault = recordFault(record);
      } catch (error) {
        fault = `no JSON (${error.message})`;
      }
      if (fault !== undefined) {
        process.stderr.write(`plans.mjs summary: ${file}:${at + 1}: ${fault}\n`);
        process.exit(2);
      }
      rows.push(record);
    }
  for (const r of rows) {
    bump(r.set, "sources");
    if (r.stalled !== undefined || r.uncharged !== undefined) {
      const kind = r.stalled !== undefined ? "stalled" : "uncharged";
      bump(r.set, kind);
      if (typeof r.run?.mode === "number") numbered = true;
      listed.push(`${r.set} ${r.name}: ${kind} (${r[kind]}, ${JSON.stringify(r.run ?? null)})`);
      continue;
    }
    for (const m of r.modes) {
      bump(r.set, "modes");
      const { base: b, head: h } = m;
      // (a name, or a number from before #2342, printed as recorded and said once below)
      if (typeof m.mode === "number") numbered = true;
      const at = `${r.set} ${r.name} mode ${typeof m.mode === "number" ? m.mode : JSON.stringify(m.mode)}`;
      const kind = m.same ? "identical" : classOf(partsApart(b, h));
      if (kind === "identical") bump(r.set, "identical");
      else if (kind === "questions") {
        bump(r.set, "questions");
        listed.push(
          `${at}: questions ${b.questions} → ${h.questions}, units ${b.units} → ${h.units}`,
        );
      } else if (kind === "work") {
        bump(r.set, "workOnly");
        bump(r.set, h.units < b.units ? "workLower" : "workHigher");
        listed.push(`${at}: work ${b.units} → ${h.units}`);
      } else {
        bump(r.set, "publication");
        const sign = (x, y) => (x === y ? "=" : "≠");
        listed.push(
          `${at}: PUBLICATION plan ${sign(b.plan, h.plan)} diagnostics ${sign(b.diagnostics, h.diagnostics)} ` +
            `error ${b.error} → ${h.error}, units ${b.units} → ${h.units}`,
        );
      }
      const list = (parts) => parts.join(", ") || "none";
      for (const d of m.demands ?? []) {
        bump(r.set, "demand");
        const row = demandRow(d, m);
        bump(r.set, `demand${row.kind[0].toUpperCase()}${row.kind.slice(1)}`);
        bump(r.set, `demandStops${row.stopped[0].toUpperCase()}${row.stopped.slice(1)}`);
        const error = row.parts?.includes("error")
          ? `, error ${d.base.error} → ${d.head.error}`
          : "";
        listed.push(
          `${at}: at demand allowance ${d.demand} apart (${row.kind}): ${list(row.parts)}${error}; ` +
            `stops ${row.stopped} (against its own unstopped compile, base: ${list(row.own.base)}, head: ` +
            `${list(row.own.head)}); checks ${b.checks}/${d.base.checks} → ${h.checks}/${d.head.checks} ` +
            `(unstopped/at the allowance), units ${d.base.units} → ${d.head.units}`,
        );
      }
      if (m.stops?.unavailable !== undefined) {
        bump(r.set, "stopsUnavailable");
        listed.push(`${at}: stop set unavailable (${m.stops.unavailable})`);
      } else if (m.stops !== undefined) {
        if (!m.stops.sameSet) {
          bump(r.set, "stopSet");
          listed.push(`${at}: STOP SET apart (main ${m.stops.count} stops)`);
          const moves = stopMoves(m.stops);
          if (moves === null || moves.length === 0) {
            bump(r.set, "stopsUnavailable");
            listed.push(
              `${at}: which stops moved is unavailable (${moves === null ? "no stop lists recorded, a record from before #2340" : "the lists differ, no phase does"})`,
            );
          }
          for (const move of moves ?? []) {
            bump(r.set, `stops${move.kind[0].toUpperCase()}${move.kind.slice(1)}`);
            listed.push(
              `${at}: stop phase ${JSON.stringify(move.phase)} ${move.kind}: base ${runsOf(move.base)} ` +
                `(${move.base.length}), head ${runsOf(move.head)} (${move.head.length})`,
            );
          }
        }
        for (const d of m.stops.differ ?? []) {
          bump(r.set, "stoppedCompile");
          listed.push(
            `${at}: stopped compile at ${d.allowance} (${d.phase}) apart: ${list(partsApart(d.base, d.head))}`,
          );
        }
      }
      if (m.questions !== undefined && m.questions.analysis !== m.questions.analysisHead) {
        bump(r.set, "analysisApart");
        listed.push(`${at}: analysis units ${m.questions.analysis} → ${m.questions.analysisHead}`);
      }
      for (const d of m.questions?.differ ?? []) {
        bump(r.set, "stoppedCompile");
        listed.push(
          `${at}: questions-phase compile at ${d.allowance} apart: ${list(partsApart(d.base, d.head))}`,
        );
      }
    }
  }
  for (const [set, counts] of sets) console.log(JSON.stringify({ set, ...counts }));
  if (numbered)
    console.log(
      "mode <number>: a record from before #2342, the mode's index in HELD_MODES at the commit that wrote it",
    );
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
