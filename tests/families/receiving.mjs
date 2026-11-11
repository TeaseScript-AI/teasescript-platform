// node tests/families/receiving.mjs <tree> <cases.jsonl> --out <records.jsonl>
// The receiving-context class (#1072, the cyclic class) of each typed call of a cases file, on one built tree: for each
// `fromJson` and each `load` without a declared receiver whose value lands in no written place (a destined call), and
// each level the readers ask of it (its rest), in each of the four modes (`MODES`):
//   w0     the A4 term (`inheritedAt`) at that level, every call reading no context: the destinations' terms combined,
//          none where two destinations disagree, none among them included;
//   w1     the same with the call reading w0 at every level: the level is coherent where w1 = w0;
//   alts   each candidate T other than w0 that is a fixed point of the call's whole assignment: T forced at the level and
//          w0 at its other levels, every level's combined term equals its forced one. The candidates are every
//          sub-term of every written type of the program (an element, a property, a union's member), each also with
//          `null`, whatever path reaches the level.
//   reads  whether an A4 proof the queries made read the call's value or contract: with every reader kept
//          (`withEveryRecord`), forgetting the call's own finished demands forgets that proof, whether the proof
//          computed the call's answer or found it memoised, by the constructor too.
// A call's class, from the unshared forward mode (the call's own keys are asked there, never a class's): I where a
// level is incoherent; L where a level has an alternate; R+ where an A4 proof reads the call and a w0 is not none; R
// where one reads it; A otherwise, with no candidate tried. R and R+ are candidate-tested: no candidate is a second
// fixed point, which does not prove the map constant. Every other call stays without a context throughout.
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
const { withEveryRecord } = await load("src/type-inference/core/solver.js", ["withEveryRecord"]);
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
 * through to the literal's own landing, never a level itself). A value is followed once per path, at any depth, depth
 * first in source order. */
function destinations(contract, value) {
  const { program, definitions } = contract.pass;
  const out = { written: false, places: [] };
  const seen = new Map();
  // (each step is a value to follow at a path, or a terminal place to record in this order)
  const todo = [{ value, at: [] }];
  while (todo.length > 0) {
    const step = todo.pop();
    if (step.place !== undefined) {
      out.places.push(step.place);
      continue;
    }
    const paths = seen.get(step.value) ?? new Set();
    if (paths.has(step.at.join("."))) continue;
    seen.set(step.value, paths.add(step.at.join(".")));
    const next = [];
    for (const d of definitions.byValue.get(step.value) ?? []) {
      const owner = program.cellOwner.get(d.place);
      if (owner?.kind === "cell") next.push({ value: owner.owner, at: ["element", ...step.at] });
      else if (d.kind !== "whole") continue;
      else if (writtenOf(program.place(d.place).kind) !== null) out.written = true;
      else next.push({ place: { place: d.place, path: [...d.path, ...step.at] } });
    }
    const operation = definitions.fallbackOf.get(step.value);
    if (operation !== undefined) next.push({ value: operation, at: step.at });
    todo.push(...next.reverse());
  }
  return out;
}

/** The combined terms of `call`'s levels on a fresh pass, with `assignment` (rest -> term) as its context, or none;
 * whether an A4 proof the queries made read the call. Each reader evaluation is recorded under `label`. */
function query(request, call, assignment, label) {
  forced = assignment === null ? null : new Map([[call.result, assignment]]);
  log = [];
  try {
    return withEveryRecord(() => {
      const pass = narrowingPass(request);
      const admission = new Admission(
        pass,
        { run: (work) => pass.solver.run(work) },
        new Map(),
        new Set(),
      );
      const terms = new Map();
      for (const rest of call.rests) {
        const each = call.places.map((d) =>
          inheritedAt(admission, d.place, [...d.path, ...(rest === "" ? [] : rest.split("."))]),
        );
        terms.set(rest, new Set(each.map(show)).size === 1 ? each[0] : null);
      }
      // (the call's own finished demands, its value's and its contract's at every path, and the proofs made; a
      // forget of the first reaches each proof that read one of them, memoised or not)
      const finished = pass.solver.demandWork().map((d) => d.key);
      const own = finished.filter((key) => {
        const [kind, of] = key.split("|");
        return (
          (kind === "cop" || kind === "op" || kind === "op-below") && of === String(call.result)
        );
      });
      const proofs = finished.filter((key) => key.startsWith("a4|"));
      pass.solver.forget(own);
      const reads = proofs.some((key) => pass.solver.answer(key) === undefined);
      return { terms, reads };
    });
  } finally {
    for (const [at, e] of log.entries())
      emit({ ev: at, ...label, result: e.c.result, rest: e.rest });
    forced = null;
    log = null;
  }
}

/** The candidates: every sub-term of every written type of the program (itself, an element, a property, a union's
 * member, a union's element), each also with `null`, at any depth, in a fixed order (depth first, as written). */
function candidates(program) {
  const out = new Map();
  const todo = [...program.places]
    .map((place) => (place?.kind === undefined ? null : writtenOf(place.kind)))
    .reverse();
  while (todo.length > 0) {
    const term = todo.pop();
    if (term === null || term.kind === "ref" || out.has(show(term))) continue;
    out.set(show(term), term);
    const optional = optionalOf(term, true);
    if (optional !== null && !out.has(show(optional))) out.set(show(optional), optional);
    const parts =
      term.kind === "list" || term.kind === "set" || term.kind === "dict"
        ? [term.element]
        : term.kind === "object"
          ? (term.properties ?? []).map((p) => p.type)
          : term.kind === "union"
            ? [...term.members, termAt(term, ["element"])]
            : [];
    todo.push(...parts.reverse());
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
          const tried = base.reads ? candidates(call.program) : [];
          for (const level of levels)
            for (const candidate of tried) {
              if (show(candidate) === level.w0) continue;
              const assignment = new Map(kappa);
              assignment.set(level.rest, candidate);
              const got = query(request, call, assignment, {
                ...at,
                query: `alt ${level.rest} ${show(candidate)}`,
              });
              const fixed = call.rests.every(
                (rest) => show(got.terms.get(rest) ?? null) === show(assignment.get(rest) ?? null),
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
