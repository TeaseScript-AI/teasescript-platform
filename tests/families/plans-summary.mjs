// The plans comparison's `summary` (`node tests/families/plans.mjs summary <records>...`): the check every records line
// passes first and the classification it prints, as `plans.mjs`'s header states them.
import { readFileSync } from "node:fs";

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
export function summarize(files, limit) {
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
