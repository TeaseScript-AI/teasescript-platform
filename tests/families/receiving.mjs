// node tests/families/receiving.mjs <tree> <cases.jsonl> --out <records.jsonl>
// The receiving-context class (#1072, the cyclic class) of each typed call of a cases file, on one built tree: for each
// `fromJson` and each `load` without a declared receiver whose value lands in no written place (a destined call), and
// each level the readers ask of it (its rest), in each of the four modes (`MODES`):
//   w0     the A4 term (`inheritedAt`) at that level, every call reading no context: the destinations' terms combined,
//          none where two destinations disagree, none among them included;
//   w1     the same with the call reading w0 at every level: the level is coherent where w1 = w0;
//   alts   each candidate T other than w0 that is a fixed point of the call's whole assignment: T forced at the level and
//          w0 at its other levels, every level's combined term equals its forced one. A level's candidates are the
//          program's written types projected along each suffix of the level's destination path, each also with `null`.
// A call's class, from the unshared forward mode (the call's own keys are asked there, never a class's): I where a
// level is incoherent; L where a level has an alternate; R+ where the A4 query reads the call and a w0 is not none; R
// where it reads the call; A otherwise. R and R+ are candidate-tested: no candidate is a second fixed point, which does
// not prove the map constant. Every other call stays without a context throughout.
// A call's context is applied by wrapping `Contract.expectedOf` and `Contract.landsIn` in this process: `landsIn` of the
// call's value answers the forced level's term while the call's own reader runs. No file of the tree is written.
// Output, one JSON line each: `{ev}` per evaluation of a reader (`expectedOf`), in the analysis that finds the calls
// and in each query, named by `query`; `{alt}` per candidate tried; `{call}` per destined call and mode; `{summary}`
// per destined call, its class and whether its terms agree in the modes that found it, on the levels each of them
// asked; `{totals}` last. A case is `{name, source | files, globals?}`.
// Exit 0: every case analysed; 1: a case threw (its record holds `threw`); 2: a refused usage, cases file or tree.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { distOf } from "./units.mjs";

const refuse = (why) => {
  process.stderr.write(`receiving.mjs: ${why}\n`);
  process.exit(2);
};
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const [tree, casesFile] = args;
if (tree === undefined || casesFile === undefined || outAt < 2 || args[outAt + 1] === undefined)
  refuse("usage: receiving.mjs <tree> <cases.jsonl> --out <records.jsonl>");
const outFile = args[outAt + 1];

const CASE_KEYS = new Set(["name", "source", "files", "globals"]);
const cases = [];
for (const [at, line] of readFileSync(casesFile, "utf8").split("\n").entries()) {
  if (line === "") continue;
  let c;
  try {
    c = JSON.parse(line);
  } catch (error) {
    refuse(`${casesFile}:${at + 1}: ${error.message}`);
  }
  const extra = Object.keys(c).filter((key) => !CASE_KEYS.has(key));
  if (
    typeof c.name !== "string" ||
    (typeof c.source === "string") === Array.isArray(c.files) ||
    extra.length > 0
  )
    refuse(
      `${casesFile}:${at + 1}: a case is {name, source | files, globals?}${extra.length > 0 ? `, not ${extra}` : ""}`,
    );
  cases.push({
    name: c.name,
    files: c.files ?? [{ path: "main.tease", source: c.source }],
    globals: c.globals ?? ["hostValue"],
  });
}

const dist = distOf(tree);
const load = async (file, names) => {
  let module;
  try {
    module = await import(pathToFileURL(path.join(dist, file)).href);
  } catch (error) {
    refuse(`the tree ${tree} has no usable ${file}: ${error.message}`);
  }
  for (const name of names)
    if (module[name] === undefined) refuse(`${file} of ${tree} has no ${name}`);
  return module;
};
const { Contract } = await load("src/type-inference/core/contract.js", ["Contract"]);
const { writtenOf, termAt } = await load("src/type-inference/core/contract/terms.js", [
  "writtenOf",
  "termAt",
]);
const { Admission } = await load("src/type-inference/core/admission.js", ["Admission"]);
const { analyseCore } = await load("src/type-inference/core/answers.js", ["analyseCore"]);
const { inheritedAt, optionalOf } = await load("src/type-inference/core/inherited/inherited.js", [
  "inheritedAt",
  "optionalOf",
]);
const { coreRequest } = await load("tests/helpers/type-core-analysis.js", ["coreRequest"]);
const { narrowingPass } = await load("tests/helpers/type-core/type-core-narrowing.js", [
  "narrowingPass",
]);
const { inMode, MODES } = await load("tests/helpers/type-core-oracles.js", ["inMode", "MODES"]);
/** The mode the classes come from: forward, unshared. */
const CLASS_MODE = MODES.findIndex((mode) => !mode.reversed && mode.unshared);

const show = (term) =>
  term === null ? "none" : JSON.stringify(term).replace(/\{"kind":"atom","name":"(\w+)"\}/g, "$1");

// The reader wrap: while `log` is set each evaluation is recorded; a call in `forced` reads its level's term as the
// landing of its own value, only while its own reader's steps run.
let log = null;
let forced = null;
let landing = null;
const expectedOf = Contract.prototype.expectedOf;
Contract.prototype.expectedOf = function* (c, rest, flow = null) {
  log?.push({ contract: this, c, rest: rest.join(".") });
  const term = forced?.get(c.result)?.get(rest.join("."));
  const inner = expectedOf.call(this, c, rest, flow);
  if (term === undefined || term === null) return yield* inner;
  const here = { value: c.result, term: nest(term, rest) };
  let next = (input) => inner.next(input);
  for (;;) {
    const saved = landing;
    landing = here;
    let step;
    try {
      step = next();
    } finally {
      landing = saved;
    }
    if (step.done) return step.value;
    try {
      const input = yield step.value;
      next = () => inner.next(input);
    } catch (error) {
      next = () => inner.throw(error);
    }
  }
};
const landsIn = Contract.prototype.landsIn;
Contract.prototype.landsIn = function (value, at, depth = 0) {
  if (landing !== null && landing.value === value && at.length === 0) return landing.term;
  return landsIn.call(this, value, at, depth);
};

/** A root term whose term at `rest` is `term`. */
function nest(term, rest) {
  let out = term;
  for (let i = rest.length - 1; i >= 0; i -= 1)
    out =
      rest[i] === "element"
        ? { kind: "list", element: out }
        : { kind: "object", properties: [{ name: rest[i], type: out }] };
  return out;
}

/** Where a value lands: whether in a written place, and its unwritten terminal places (a literal's cell is passed
 * through to the literal's own landing, never a level itself). */
function destinations(contract, value, at = [], depth = 0, out = { written: false, places: [] }) {
  if (depth > 32) return out;
  const { program, definitions } = contract.pass;
  for (const d of definitions.byValue.get(value) ?? []) {
    const owner = program.cellOwner.get(d.place);
    if (owner?.kind === "cell") {
      destinations(contract, owner.owner, ["element", ...at], depth + 1, out);
      continue;
    }
    if (d.kind !== "whole") continue;
    if (writtenOf(program.place(d.place).kind) !== null) out.written = true;
    else out.places.push({ place: d.place, path: [...d.path, ...at] });
  }
  const operation = definitions.fallbackOf.get(value);
  if (operation !== undefined) destinations(contract, operation, at, depth + 1, out);
  return out;
}

/** The combined terms of `call`'s levels on a fresh pass, with `assignment` (rest -> term) as its context, or none;
 * whether the A4 queries read the call. Each reader evaluation is recorded under `label`. */
function query(request, call, assignment, label) {
  forced = assignment === null ? null : new Map([[call.result, assignment]]);
  log = [];
  try {
    const pass = narrowingPass(request);
    const admission = new Admission(
      pass,
      { run: (work) => pass.solver.run(work) },
      new Map(),
      new Set(),
    );
    const keys = [`cop|${call.result}`, ...call.rests.map((rest) => `op|${call.result}|${rest}`)];
    const before = keys.some((key) => pass.solver.answer(key) !== undefined);
    const terms = new Map();
    for (const rest of call.rests) {
      const each = call.places.map((d) =>
        inheritedAt(admission, d.place, [...d.path, ...(rest === "" ? [] : rest.split("."))]),
      );
      terms.set(rest, new Set(each.map(show)).size === 1 ? each[0] : null);
    }
    const reads = !before && keys.some((key) => pass.solver.answer(key) !== undefined);
    return { terms, reads };
  } finally {
    for (const [at, e] of log.entries())
      emit({ ev: at, ...label, result: e.c.result, rest: e.rest });
    forced = null;
    log = null;
  }
}

/** A level's candidates: each written type of the program projected along each suffix of the level's paths, and each
 * with `null`, in a fixed order. */
function candidates(program, call, rest) {
  const written = new Map();
  for (const place of program.places) {
    const term = place?.kind === undefined ? null : writtenOf(place.kind);
    if (term !== null) written.set(show(term), term);
  }
  const out = new Map();
  for (const d of call.places) {
    const full = [...d.path, ...(rest === "" ? [] : rest.split("."))];
    for (let from = 0; from <= full.length; from += 1)
      for (const term of written.values()) {
        const at = termAt(term, full.slice(from));
        if (at === null) continue;
        for (const each of [at, optionalOf(at, true)]) if (each !== null) out.set(show(each), each);
      }
  }
  return [...out.values()];
}

const CLASSES = ["A", "R", "R+", "L", "I"];
const totals = {
  cases: 0,
  unparsed: 0,
  threw: 0,
  calls: 0,
  modeDiffering: 0,
  ...Object.fromEntries(CLASSES.map((c) => [c, 0])),
};
const lines = [];
const emit = (record) => lines.push(JSON.stringify(record));
for (const c of cases) {
  totals.cases += 1;
  const request = coreRequest(c.files, c.globals);
  if (request === null) {
    totals.unparsed += 1;
    emit({ case: c.name, unparsed: true });
    continue;
  }
  try {
    const byCall = new Map();
    for (const [m, mode] of MODES.entries())
      inMode(mode, () => {
        log = [];
        let events;
        try {
          analyseCore(request);
        } finally {
          events = log;
          log = null;
        }
        const calls = new Map();
        for (const [at, e] of events.entries()) {
          emit({
            ev: at,
            case: c.name,
            mode: m,
            query: "analysis",
            result: e.c.result,
            rest: e.rest,
          });
          if (e.c.kind === "load" && e.c.receiver !== null) continue;
          let call = calls.get(e.c.result);
          if (call === undefined) {
            const dest = destinations(e.contract, e.c.result);
            if (dest.written || dest.places.length === 0) continue;
            calls.set(
              e.c.result,
              (call = {
                result: e.c.result,
                places: dest.places,
                rests: [],
                program: e.contract.pass.program,
              }),
            );
          }
          if (!call.rests.includes(e.rest)) call.rests.push(e.rest);
        }
        for (const call of calls.values()) {
          call.rests.sort();
          const at = { case: c.name, mode: m, call: call.result };
          const base = query(request, call, null, { ...at, query: "w0" });
          const kappa = new Map([...base.terms].filter(([, term]) => term !== null));
          const one = query(request, call, kappa, { ...at, query: "w1" });
          const levels = call.rests.map((rest) => ({
            rest,
            w0: show(base.terms.get(rest)),
            w1: show(one.terms.get(rest)),
            alts: [],
          }));
          if (base.reads)
            for (const level of levels)
              for (const candidate of candidates(call.program, call, level.rest)) {
                if (show(candidate) === level.w0) continue;
                const assignment = new Map(kappa);
                assignment.set(level.rest, candidate);
                const got = query(request, call, assignment, {
                  ...at,
                  query: `alt ${level.rest} ${show(candidate)}`,
                });
                const fixed = call.rests.every(
                  (rest) =>
                    show(got.terms.get(rest) ?? null) === show(assignment.get(rest) ?? null),
                );
                emit({
                  alt: true,
                  case: c.name,
                  mode: m,
                  result: call.result,
                  rest: level.rest,
                  candidate: show(candidate),
                  fixed,
                });
                if (fixed) level.alts.push(show(candidate));
              }
          const cls = levels.some((l) => l.w1 !== l.w0)
            ? "I"
            : levels.some((l) => l.alts.length > 0)
              ? "L"
              : base.reads
                ? levels.some((l) => l.w0 !== "none")
                  ? "R+"
                  : "R"
                : "A";
          emit({
            call: true,
            case: c.name,
            mode: m,
            result: call.result,
            reads: base.reads,
            levels,
            class: cls,
          });
          const all = byCall.get(call.result) ?? new Map();
          all.set(m, { cls, terms: new Map(levels.map((l) => [l.rest, `${l.w0} ${l.w1}`])) });
          byCall.set(call.result, all);
        }
      });
    for (const [result, modes] of byCall) {
      totals.calls += 1;
      // (on the levels every mode asked: with sharing on, a class's keys answer some levels for the call)
      const common = [...modes.values()]
        .map((x) => [...x.terms.keys()])
        .reduce((a, b) => a.filter((r) => b.includes(r)));
      const termsAgree = common.every(
        (rest) => new Set([...modes.values()].map((x) => x.terms.get(rest))).size === 1,
      );
      if (!termsAgree) totals.modeDiffering += 1;
      const cls = (modes.get(CLASS_MODE) ?? [...modes.values()][0]).cls;
      totals[cls] += 1;
      emit({ summary: true, case: c.name, result, class: cls, modes: modes.size, termsAgree });
    }
  } catch (error) {
    totals.threw += 1;
    emit({ case: c.name, threw: String(error?.stack ?? error).slice(0, 400) });
  }
}
emit({ totals });
writeFileSync(outFile, lines.join("\n") + "\n");
process.exit(totals.threw > 0 ? 1 : 0);
