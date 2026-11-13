#!/usr/bin/env node
// The runtime benchmark (#827, #1693): the sources of `benchmarks/runtime/` run through the public runtime API.
//
//   node tools/benchmark-runtime.mjs --count-only [--dist DIR] [--all] [--cases A,B] [--update] [--json FILE]
//   node tools/benchmark-runtime.mjs --cpu --base DIR --candidate DIR --out DIR [--all] [--cases A,B]
//                                    [--rounds N] [--warmups N] [--batch N]
//
// A DIR is a `dist/` of `npm run build:typescript`. `--count-only` checks the build (default: this checkout's `dist/`)
// against `benchmarks/runtime/baseline.json`: at every cut (each `stepToEvent`, `run`, `observeTime` or tape call
// return, so at every event, wait, host call and the end) the instructions so far, the status, the RNG state, a digest
// of the snapshot without its `format` and `version`, and a digest of the events; also each source's and tape's hash
// and what its manifest entry states. A probe, or a case with `restoreEachCut`, also runs restored from checkpoint
// JSON at every cut, where it must give the same cuts. `--update` rewrites the baseline entries of the cases it ran.
// `--cpu` loads both builds in one process, requires the candidate to equal the base at every cut (instruction counts
// may differ) and both to hold the manifest's statements, then times them interleaved, checking every timed run the
// same way, and writes raw samples and a summary under `--out`. CPU never decides the exit status. Exit 0: equal;
// 1: a difference; 2: a usage or run failure.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const benchmarkDirectory = path.join(root, "benchmarks", "runtime");
const budget = 2_000_000_000;
const maximumCuts = 10_000;

export class UsageError extends Error {}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** A JSON text of `value` with every object's keys sorted, so a digest does not depend on property order. */
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** The digest of a snapshot without its `format` and `version`, which a format revision alone moves. */
export function stateDigest(snapshot) {
  const { format: _format, version: _version, ...content } = snapshot;
  return sha256(canonicalJson(content));
}

export const eventsDigest = (events) => sha256(canonicalJson(events));

/** The names of every case in the manifest, on-demand ones included. */
export const manifestNames = (directory = benchmarkDirectory) =>
  JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")).cases.map(
    (entry) => entry.name,
  );

/**
 * The media store's answers a `completeAction` gets, in order, as the Player's debug export records them: a question
 * that is not the next recorded one, or one left unasked, is an error, since the call would then not be the recorded
 * one.
 */
export function recordedMedia(queries = []) {
  const left = [...queries];
  return {
    holds(reference, kind) {
      const query = left.shift();
      if (query?.reference !== reference || query.kind !== kind)
        throw new Error(
          `the tape did not record the media store's answer for ${kind} ${reference}`,
        );
      return query.result;
    },
    unasked: () => left.length,
  };
}

/**
 * A tape entry as the host call it makes: `{ kind, ... }` with the arguments named, as 0b.1's differential harness
 * takes it; `capturedMedia` is the media store a `completeAction` answers from. The runner applies the same calls.
 */
export function tapeHostCall(entry, capturedMedia) {
  const [first, second] = entry.args;
  switch (entry.kind) {
    case "completeAction":
      return { kind: "completeAction", request: first, capturedMedia };
    case "updateInteraction":
      return { kind: "updateInteraction", request: first };
    case "observeTime":
      return { kind: "observeTime", nowMs: first, reports: second ?? [] };
    case "reportMediaLoad":
      return { kind: "reportMediaLoad", mediaId: first, report: second };
    case "pressPermanentButton":
      return { kind: "pressPermanentButton", buttonId: first };
  }
  throw new Error(`no host call ${entry.kind}`);
}

/** Makes a host call on `session`. */
function applyHostCall(session, call) {
  switch (call.kind) {
    case "completeAction":
      return session.completeAction(call.request, { capturedMedia: call.capturedMedia });
    case "updateInteraction":
      return session.updateInteraction(call.request);
    case "observeTime":
      return session.observeTime(call.nowMs, call.reports);
    case "reportMediaLoad":
      return session.reportMediaLoad(call.mediaId, call.report);
    case "pressPermanentButton":
      return session.pressPermanentButton(call.buttonId);
  }
  throw new Error(`no host call ${call.kind}`);
}

const tapeKinds = new Set([
  "completeAction",
  "updateInteraction",
  "observeTime",
  "reportMediaLoad",
  "pressPermanentButton",
]);

/**
 * A tape's entries, checked: each `{ kind, args, admissionQueries?, unit? }` names a host call of `tapeHostCall`, its
 * arguments and, for a `completeAction`, the media store's answers to it (`{ reference, kind, result }`), and
 * `unit: true` marks the call that completes one useful unit. A tape is input only; what the calls give is the
 * baseline's.
 */
export function loadTape(text, label) {
  const tape = JSON.parse(text);
  if (!Array.isArray(tape)) throw new UsageError(`${label}: a tape is a list of host calls`);
  tape.forEach((entry, index) => {
    const keys = Object.keys(entry ?? {});
    if (
      !tapeKinds.has(entry?.kind) ||
      !Array.isArray(entry.args) ||
      keys.some((key) => !["kind", "args", "admissionQueries", "unit"].includes(key)) ||
      (entry.unit !== undefined && entry.unit !== true) ||
      (entry.admissionQueries !== undefined &&
        (entry.kind !== "completeAction" || !Array.isArray(entry.admissionQueries)))
    )
      throw new UsageError(
        `${label}: entry ${index + 1} is not { kind, args, admissionQueries?, unit? } of a known host call`,
      );
  });
  return tape;
}

/**
 * The interpreter's run of a tape: `next` gives the entry a waiting session gets, or `null` when the tape is used up,
 * a problem then; `call` makes an entry its host call, with a media store that answers from the entry's recorded
 * answers in order. What the session then receives is the guards' to check (`tapeGuards`), not the interpreter's.
 */
export function tapeRun(tape, label) {
  let position = 0;
  const problems = [];
  return {
    next(where = "") {
      if (position === tape.length) {
        problems.push(`${label}: the tape is used up while the session waits${where}`);
        return null;
      }
      return tape[position++];
    },
    call: (entry) => tapeHostCall(entry, recordedMedia(entry.admissionQueries)),
    problems: () => problems,
  };
}

/** How many data arguments each host method takes before its options. */
const receiptArity = {
  completeAction: 1,
  updateInteraction: 1,
  observeTime: 2,
  reportMediaLoad: 2,
  pressPermanentButton: 1,
};

/**
 * The calls a tape asks the session to receive, detached, from its entries' fields alone and never through
 * `tapeHostCall`: each method, its data arguments (`observeTime`'s reports `[]` when the tape gives none), the media
 * store's questions and answers a `completeAction` must see, and whether it completes a unit.
 */
export function prepareTape(tape) {
  return JSON.parse(
    JSON.stringify(
      tape.map((entry) => ({
        method: entry.kind,
        args: entry.kind === "observeTime" ? [entry.args[0], entry.args[1] ?? []] : entry.args,
        media: entry.kind === "completeAction" ? (entry.admissionQueries ?? []) : null,
        unit: entry.unit === true,
      })),
    ),
  );
}

/**
 * The session's other host operations, which no tape holds (`loadTape` takes only `receiptArity`'s): a guarded
 * session refuses each at the call, before the session runs it.
 */
const untapedHostMethods = new Set([
  "recordContinueCapture",
  "applyExternalStorageEdit",
  "setDebugMode",
  "resumeRandomDraw",
  "setRandomControl",
]);

/** A host call the session received that is not its tape's: thrown before the session runs it. */
export class TapeMismatch extends Error {}

/**
 * The guards of one execution of a tape, one per session it makes (the fresh one, each restored one, each fork), all
 * checking against one prepared expectation (`prepareTape`). A guard checks each host method's receipt at its entry,
 * before the session runs it: the method and its data arguments must be the tape's next entry's, or it throws
 * `TapeMismatch`. For a `completeAction` it watches the media store's questions and answers, which must be the entry's
 * recorded ones, all of them, and a unit must complete. `start(position)` makes a guard at a position; a `null`
 * position is set later with `place` (a restored session whose cut is not known yet). `problems(status)` gives every
 * guard's problems, each with the entries it had left when the execution ended in `status`.
 */
export function tapeGuards(expected, label) {
  const guards = [];
  const problems = [];
  const shown = (value) => canonicalJson(value);
  const start = (position) => {
    let at = position;
    const guard = {
      place(position) {
        at = position;
      },
      get position() {
        return at;
      },
      fork: () => start(at),
      refuse(method, args) {
        const want = at === null ? undefined : expected[at];
        const problem =
          `${label}: host call ${at === null ? "?" : at + 1} is ${shown({ method, args })}, which no tape holds; ` +
          `its tape entry ${want === undefined ? "none" : shown({ method: want.method, args: want.args })}`;
        problems.push(problem);
        throw new TapeMismatch(problem);
      },
      receive(method, args, apply, time) {
        const arity = receiptArity[method];
        const data = method === "observeTime" ? [args[0], args[1] ?? []] : args.slice(0, arity);
        const want = at === null ? undefined : expected[at];
        const got = { method, args: data };
        if (want === undefined || shown(got) !== shown({ method: want.method, args: want.args })) {
          const problem =
            `${label}: host call ${at === null ? "?" : at + 1} is ${shown(got)}, its tape entry ` +
            `${want === undefined ? "none" : shown({ method: want.method, args: want.args })}`;
          problems.push(problem);
          throw new TapeMismatch(problem);
        }
        const call = [...args];
        const asked = [];
        if (method === "completeAction") {
          const options = args[arity] ?? {};
          const store = options.capturedMedia;
          call[arity] = {
            ...options,
            capturedMedia:
              store === undefined
                ? undefined
                : {
                    holds(reference, kind) {
                      const query = { reference, kind, result: undefined };
                      asked.push(query);
                      query.result = store.holds(reference, kind);
                      return query.result;
                    },
                  },
          };
        }
        let result;
        try {
          result = time(() => apply(call));
        } finally {
          if (method === "completeAction" && shown(asked) !== shown(want.media))
            problems.push(
              `${label}: host call ${at + 1} asked the media store ${shown(asked)}, its tape entry recorded ` +
                `${shown(want.media)}`,
            );
        }
        if (want.unit && result?.outcome?.kind !== "completed")
          problems.push(
            `${label}: tape entry ${at + 1}, a unit, gave ${result?.outcome?.kind}, not completed`,
          );
        at++;
        return result;
      },
    };
    guards.push(guard);
    return guard;
  };
  return {
    start,
    problems(status) {
      const left = guards
        .filter((guard) => guard.position !== null && guard.position < expected.length)
        .map(
          (guard) =>
            `${label}: the session ${status} with ${expected.length - guard.position} tape entries left`,
        );
      return [...problems, ...new Set(left)];
    },
  };
}

/**
 * `session` with its host methods checked by `guard` at receipt (see `tapeGuards`), and those no tape holds refused,
 * `time` timing only the session's own work, and its forks checked by guards of their own, placed where it stood.
 * Every other member is the session's.
 */
export function checkedHostSession(session, guard, time = (operation) => operation()) {
  return new Proxy(session, {
    get(target, name) {
      if (Object.hasOwn(receiptArity, name))
        return (...args) => guard.receive(name, args, (call) => target[name](...call), time);
      if (untapedHostMethods.has(name)) return (...args) => guard.refuse(name, args);
      if (name === "fork")
        return (...args) => checkedHostSession(target.fork(...args), guard.fork(), time);
      const value = target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The manifest's cases, each with its source text and hash; `select` picks by name, `all` adds the on-demand ones. */
export function loadCases(directory = benchmarkDirectory, { all = false, select = null } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const known = new Set(manifest.cases.map((entry) => entry.name));
  for (const name of select ?? [])
    if (!known.has(name)) throw new UsageError(`no case '${name}' in ${directory}/manifest.json`);
  const read = (file) => fs.readFileSync(path.join(directory, file), "utf8");
  return manifest.cases
    .filter((entry) => (select ? select.includes(entry.name) : all || !entry.onDemand))
    .map((entry) => {
      // A project's files compile together, in the manifest's order, under their paths in the project.
      const files = entry.project
        ? entry.files.map((file) => ({ path: file, source: read(path.join(entry.project, file)) }))
        : null;
      const source = files ? canonicalJson(files) : read(entry.file);
      const tapeText = entry.tape ? read(entry.tape) : null;
      const tape = tapeText === null ? null : loadTape(tapeText, `${entry.name}: ${entry.tape}`);
      if (tape && entry.units !== tape.filter((call) => call.unit).length)
        throw new UsageError(
          `${entry.name}: the tape marks ${tape.filter((call) => call.unit).length} units, the manifest states ${entry.units}`,
        );
      return {
        ...entry,
        source,
        sourceSha256: sha256(source),
        ...(files ? { files } : {}),
        ...(tape ? { tape, tapeExpected: prepareTape(tape), tapeSha256: sha256(tapeText) } : {}),
        fresh: {
          seed: entry.seed ?? manifest.seed,
          wallClockMs: manifest.wallClockMs,
          baseDelayMs: 0,
          delayPerWordMs: 0,
          delayPerCharacterMs: 0,
          ...entry.fresh,
        },
      };
    });
}

/** The runtime API of a `dist/` directory. */
export async function loadRuntime(dist) {
  const entry = path.resolve(dist, "src", "index.js");
  if (!fs.existsSync(entry))
    throw new UsageError(`${entry} does not exist: build with npm run build:typescript`);
  return import(pathToFileURL(entry).href);
}

/** The plan of a case's source; a source that does not compile is a run failure. */
export function compileCase(api, testCase) {
  const compiled = testCase.files
    ? api.compileProject(testCase.files)
    : api.compileSource(testCase.source);
  const errors = compiled.diagnostics.filter((item) => item.severity === "error");
  if (!compiled.plan || errors.length > 0)
    throw new Error(`${testCase.name} does not compile: ${JSON.stringify(errors.slice(0, 3))}`);
  return compiled.plan;
}

const cpuUs = (start) => {
  const used = process.cpuUsage(start);
  return used.user + used.system;
};

/**
 * Runs a case to its end and records every cut. A case drives `stepToEvent` with the research allowance, or, with
 * `budget: "product"`, `run` without a budget, as the Player does, so the product default applies at each scene time
 * (a `run` cut). Without a tape it observes each wait's deadline (an `observe` cut). With a tape, every host call is the
 * tape's next entry, `observeTime` too (a `host` cut, which also has the call's outcome and its digest); the tape must
 * be used up exactly when the session stops waiting, and each entry it marks as a unit must complete;
 * `observed.tapeProblems` says otherwise. With `restore`, the session is replaced at every cut by one restored from its checkpoint's JSON
 * text, which must export the same snapshot. With `timed`, the record also has `cpuUs`, the CPU of the drive,
 * `observeTime` and tape calls alone, and `setupCpuUs`, that of the session's creation; the cut records are made
 * outside those segments, so a timed run is checked like any other. `observed` holds what the manifest's statements
 * are checked against and stays out of the baseline.
 */
export function recordCase(
  api,
  testCase,
  { plan = compileCase(api, testCase), restore = false, timed = false } = {},
) {
  let cpu = 0;
  const time = timed
    ? (operation) => {
        const start = process.cpuUsage();
        const result = operation();
        cpu += cpuUs(start);
        return result;
      }
    : (operation) => operation();
  const tape = testCase.tape ?? null;
  const tapeOwner = tape ? tapeRun(tape, testCase.name) : null;
  // The session receives every host call through the guard, which checks it before the session runs it; `time` times
  // the session's own work, never the check.
  const guards = tape
    ? tapeGuards(testCase.tapeExpected ?? prepareTape(tape), testCase.name)
    : null;
  const guard = guards?.start(0) ?? null;
  const guarded = (made) => (guard === null ? made : checkedHostSession(made, guard, time));
  let session = guarded(time(() => api.createFreshRuntimeSession(plan, testCase.fresh)));
  const setupCpuUs = cpu;
  cpu = 0;
  let instructions = 0;
  const cuts = [];
  const said = [];
  const restoreProblems = [];
  const product = testCase.budget === "product";
  const drive = product
    ? () => session.run()
    : () => session.stepToEvent({ instructionBudget: budget });
  const cut = (kind, result) => {
    instructions += result.instructionsExecuted;
    for (const event of result.events) if (event.kind === "say") said.push(event.text);
    const snapshot = session.exportSnapshot();
    const record = {
      kind,
      instructions,
      status: snapshot.status,
      rng: snapshot.rng,
      events: result.events.length,
      eventsDigest: eventsDigest(result.events),
      stateDigest: stateDigest(snapshot),
      ...(kind === "host"
        ? {
            outcome: result.outcome?.kind ?? null,
            outcomeDigest: sha256(canonicalJson(result.outcome ?? null)),
          }
        : {}),
    };
    cuts.push(record);
    if (restore) {
      session = guarded(api.deserializeRuntimeSession(JSON.stringify(session.exportCheckpoint())));
      const restored = stateDigest(session.exportSnapshot());
      if (restored !== record.stateDigest)
        restoreProblems.push(
          `${testCase.name}: the session restored at cut ${cuts.length} exports another snapshot (${restored})`,
        );
    }
    return snapshot;
  };
  // Texts the manifest states by digest are kept by digest, so a long one stays out of the baseline.
  const finish = (failure, status) => ({
    name: testCase.name,
    sourceSha256: testCase.sourceSha256,
    ...(tape ? { tapeSha256: testCase.tapeSha256 } : {}),
    instructions,
    ...(testCase.saidSha256 === undefined ? { said } : { saidSha256: sha256(canonicalJson(said)) }),
    cuts,
    observed: {
      failure,
      tapeProblems: tape ? [...tapeOwner.problems(), ...guards.problems(status)] : [],
    },
    ...(restore ? { restoreProblems } : {}),
    ...(timed ? { cpuUs: cpu, setupCpuUs } : {}),
  });
  // A tape call that leaves nothing to run, such as a form edit or a refused answer, needs no drive: the next call
  // follows at once.
  let waiting = null;
  while (cuts.length < maximumCuts) {
    let snapshot = waiting;
    waiting = null;
    if (snapshot === null) {
      const result = time(drive);
      snapshot = cut(product ? "run" : "step", result);
      if (snapshot.status === "running") {
        if (product ? result.instructionsExecuted === 0 : result.events.length === 0)
          throw new Error(
            product
              ? `${testCase.name}: run stopped running without executing anything`
              : `${testCase.name}: ${budget} instructions did not reach an event, a wait or the end`,
          );
        continue;
      }
    }
    if (snapshot.status !== "waiting") {
      return finish(snapshot.failure?.code ?? null, snapshot.status);
    }
    if (tapeOwner) {
      const entry = tapeOwner.next(` at cut ${cuts.length}`);
      if (entry === null) return finish(null, snapshot.status);
      const answered = applyHostCall(session, tapeOwner.call(entry));
      const after = cut("host", answered);
      if (after.status === "waiting" && !session.view().runnable) waiting = after;
      continue;
    }
    const deadline = snapshot.foregroundAction?.deadlineMs;
    if (typeof deadline !== "number")
      throw new Error(
        `${testCase.name}: waits for something other than time at cut ${cuts.length}`,
      );
    cut(
      "observe",
      time(() => session.observeTime(deadline)),
    );
  }
  throw new Error(`${testCase.name}: more than ${maximumCuts} cuts`);
}

const cutFields = [
  "kind",
  "instructions",
  "status",
  "rng",
  "events",
  "eventsDigest",
  "stateDigest",
  "outcome",
  "outcomeDigest",
];
const show = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/** Every difference between two records of one case, as text; `fields` limits which cut fields count. */
export function compareRecords(expected, actual, { fields = cutFields, label = actual.name } = {}) {
  const problems = [];
  if (expected.sourceSha256 !== undefined && expected.sourceSha256 !== actual.sourceSha256)
    problems.push(`${label}: source sha256 ${expected.sourceSha256} became ${actual.sourceSha256}`);
  if (expected.tapeSha256 !== undefined && expected.tapeSha256 !== actual.tapeSha256)
    problems.push(`${label}: tape sha256 ${expected.tapeSha256} became ${actual.tapeSha256}`);
  if (fields.includes("instructions") && expected.instructions !== actual.instructions)
    problems.push(`${label}: ${expected.instructions} instructions became ${actual.instructions}`);
  if (canonicalJson(expected.said) !== canonicalJson(actual.said))
    problems.push(`${label}: said ${show(expected.said)}, now ${show(actual.said)}`);
  if (expected.saidSha256 !== actual.saidSha256)
    problems.push(
      `${label}: said texts of sha256 ${expected.saidSha256}, now ${actual.saidSha256}`,
    );
  const length = Math.max(expected.cuts.length, actual.cuts.length);
  for (let index = 0; index < length; index++) {
    const before = expected.cuts[index];
    const after = actual.cuts[index];
    if (before === undefined || after === undefined) {
      problems.push(
        `${label}: ${expected.cuts.length} cuts became ${actual.cuts.length}` +
          ` (cut ${index + 1} is ${before === undefined ? "new" : "gone"})`,
      );
      break;
    }
    for (const field of fields)
      if (canonicalJson(before[field]) !== canonicalJson(after[field]))
        problems.push(
          `${label}: cut ${index + 1} (${before.kind}) ${field} ${show(before[field])} became ${show(after[field])}`,
        );
  }
  return problems;
}

/**
 * The differences of a case's record from what its manifest entry states: its texts, or for long ones the SHA-256 of
 * their canonical JSON, and its failure, a code and the instructions executed until it. A tape's own problems count
 * too.
 */
export function checkStated(testCase, record) {
  const problems = [...record.observed.tapeProblems];
  if (testCase.said !== undefined && canonicalJson(testCase.said) !== canonicalJson(record.said))
    problems.push(
      `${testCase.name}: says ${show(record.said)}, the manifest states ${show(testCase.said)}`,
    );
  if (testCase.saidSha256 !== undefined && record.saidSha256 !== testCase.saidSha256)
    problems.push(
      `${testCase.name}: says texts of sha256 ${record.saidSha256}, the manifest states ${testCase.saidSha256}`,
    );
  if (testCase.failure !== undefined) {
    const failed = { code: record.observed.failure, instructions: record.instructions };
    if (canonicalJson(failed) !== canonicalJson(testCase.failure))
      problems.push(
        `${testCase.name}: ends with ${show(failed)}, the manifest states ${show(testCase.failure)}`,
      );
  }
  return problems;
}

/**
 * Records every case and compares it with the baseline (`problems`), and with what holds whatever the baseline says
 * (`invariants`): the manifest's statements and, for a probe or a case with `restoreEachCut`, its run restored from
 * JSON at every cut.
 */
export function checkCounts(api, cases, baseline) {
  const records = [];
  const problems = [];
  const invariants = [];
  for (const testCase of cases) {
    const plan = compileCase(api, testCase);
    const record = recordCase(api, testCase, { plan });
    records.push(record);
    invariants.push(...checkStated(testCase, record));
    if (testCase.probe || testCase.restoreEachCut) {
      const restored = recordCase(api, testCase, { plan, restore: true });
      invariants.push(
        ...restored.restoreProblems,
        ...restored.observed.tapeProblems.map((problem) => `${problem} (restored at every cut)`),
        ...compareRecords(record, restored, { label: `${testCase.name} restored at every cut` }),
      );
    }
    const expected = baseline.cases[testCase.name];
    if (expected === undefined) problems.push(`${testCase.name}: not in the baseline`);
    else problems.push(...compareRecords(expected, record));
  }
  return { records, problems, invariants };
}

/** The baseline with the given records' entries replaced, cases outside the manifest dropped, in manifest order. */
export function updatedBaseline(baseline, records, manifestNames) {
  const byName = { ...baseline.cases };
  for (const record of records) {
    const { name, observed: _observed, ...entry } = record;
    byName[name] = entry;
  }
  return {
    cases: Object.fromEntries(
      manifestNames.filter((name) => byName[name]).map((name) => [name, byName[name]]),
    ),
  };
}

/** The baseline as JSON text with one line per cut, so an update reads as a small diff. */
export function formatBaseline(baseline) {
  const entries = Object.entries(baseline.cases).map(([name, entry]) => {
    const fields = Object.entries(entry)
      .filter(([key]) => key !== "cuts")
      .map(([key, value]) => `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    const cuts = entry.cuts.map((item) => `        ${JSON.stringify(item)}`).join(",\n");
    return `    ${JSON.stringify(name)}: {\n${fields.join(",\n")},\n      "cuts": [\n${cuts}\n      ]\n    }`;
  });
  return `{\n  "cases": {\n${entries.join(",\n")}\n  }\n}\n`;
}

/**
 * The base and candidate builds on every case: first equal results at every cut (instruction counts may differ) and
 * what the manifest states, tape problems included, for each build; then `warmups` tagged rounds (negative) and
 * `rounds` measured ones, the builds' order alternating per round, each sample `batch` executions (one for a case
 * whose manifest entry has `cpuBatch`). Every timed execution is recorded too and must equal its build's untimed
 * record and the manifest's statements. Returns the samples, or the differences: when a build differs before timing
 * nothing is timed; when a timed execution differs, the measurement stops there.
 */
export function measureCpu(
  builds,
  cases,
  { rounds = 9, warmups = 3, batch = 7, onSample = () => {} } = {},
) {
  const names = Object.keys(builds);
  const plans = {};
  const expected = {};
  const problems = [];
  for (const testCase of cases) {
    const records = {};
    for (const name of names) {
      plans[`${testCase.name}\0${name}`] = compileCase(builds[name], testCase);
      records[name] = recordCase(builds[name], testCase, {
        plan: plans[`${testCase.name}\0${name}`],
      });
      expected[`${testCase.name}\0${name}`] = records[name];
      problems.push(
        ...checkStated(testCase, records[name]).map((problem) => `${problem} (${name})`),
      );
    }
    for (const name of names.slice(1))
      problems.push(
        ...compareRecords(records[names[0]], records[name], {
          fields: cutFields.filter((field) => field !== "instructions"),
          label: `${testCase.name} (${name} against ${names[0]})`,
        }),
      );
  }
  if (problems.length > 0) return { problems, samples: [] };
  const samples = [];
  for (const testCase of cases) {
    const executions = testCase.cpuBatch ?? batch;
    for (let round = -warmups; round < rounds; round++) {
      const shift = (round + warmups) % names.length;
      const order = [...names.slice(shift), ...names.slice(0, shift)];
      for (const name of order) {
        const plan = plans[`${testCase.name}\0${name}`];
        const sample = {
          name: testCase.name,
          build: name,
          round,
          order,
          executions,
          units: testCase.units ?? null,
        };
        let instructions = 0;
        let timed = 0;
        let setupCpuUs = 0;
        for (let repeat = 0; repeat < executions; repeat++) {
          const one = recordCase(builds[name], testCase, { plan, timed: true });
          const differences = [
            ...compareRecords(expected[`${testCase.name}\0${name}`], one, {
              label: `${testCase.name} (${name}, timed round ${round})`,
            }),
            ...checkStated(testCase, one).map(
              (problem) => `${problem} (${name}, timed round ${round})`,
            ),
          ];
          if (differences.length) return { problems: differences, samples };
          instructions += one.instructions;
          timed += one.cpuUs;
          setupCpuUs += one.setupCpuUs;
        }
        Object.assign(sample, {
          instructions,
          cpuUs: timed,
          setupCpuUs,
          suite: Boolean(testCase.suite),
        });
        samples.push(sample);
        onSample(sample);
      }
    }
  }
  return { problems, samples };
}

/** The median, minimum, maximum and count of `values`. */
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted.at(-1), n: sorted.length };
}

/**
 * The report of measured samples (round >= 0): per case and build the instructions per execution and per unit, CPU per
 * unit and per instruction; per case the paired speed `base / candidate` of CPU per execution in matching rounds; and
 * the geometric mean over the suite cases of those paired medians. Report arithmetic only, never a threshold.
 */
export function summarizeCpu(samples, base = "base", candidate = "candidate") {
  const measured = samples.filter((sample) => sample.round >= 0);
  const cases = {};
  for (const name of new Set(measured.map((sample) => sample.name))) {
    const mine = measured.filter((sample) => sample.name === name);
    const builds = {};
    for (const build of new Set(mine.map((sample) => sample.build))) {
      const rows = mine.filter((sample) => sample.build === build);
      const perExecution = rows[0].instructions / rows[0].executions;
      builds[build] = {
        instructionsPerExecution: perExecution,
        ...(rows[0].units ? { instructionsPerUnit: perExecution / rows[0].units } : {}),
        cpuUsPerExecution: distribution(rows.map((row) => row.cpuUs / row.executions)),
        ...(rows[0].units
          ? {
              cpuUsPerUnit: distribution(rows.map((row) => row.cpuUs / row.executions / row.units)),
            }
          : {}),
        cpuNsPerInstruction: distribution(rows.map((row) => (1000 * row.cpuUs) / row.instructions)),
      };
    }
    const byRound = (build) =>
      new Map(mine.filter((row) => row.build === build).map((row) => [row.round, row]));
    const baseRows = byRound(base);
    const candidateRows = byRound(candidate);
    const ratios = [...baseRows.keys()]
      .filter((round) => candidateRows.has(round))
      .map((round) => {
        const a = baseRows.get(round);
        const b = candidateRows.get(round);
        return a.cpuUs / a.executions / (b.cpuUs / b.executions);
      });
    cases[name] = {
      suite: mine[0].suite,
      builds,
      ...(ratios.length ? { pairedSpeed: distribution(ratios) } : {}),
    };
  }
  const suite = Object.values(cases).filter((entry) => entry.suite && entry.pairedSpeed);
  return {
    cpu: "process.cpuUsage() user + system over the run and observeTime calls; session creation and checks excluded",
    pairedSpeed: `${base} CPU / ${candidate} CPU per execution in the same round; above 1 means ${candidate} is faster`,
    suiteGeometricMeanOfPairedMedians: suite.length
      ? Math.exp(
          suite.reduce((sum, entry) => sum + Math.log(entry.pairedSpeed.median), 0) / suite.length,
        )
      : null,
    suiteCases: suite.length,
    cases,
  };
}

function parseArguments(argv) {
  const options = { all: false, update: false };
  const value = (index) => {
    if (index >= argv.length || argv[index].startsWith("--"))
      throw new UsageError(`${argv[index - 1]} needs a value`);
    return argv[index];
  };
  const count = (text, name) => {
    if (!/^\d+$/.test(text)) throw new UsageError(`${name} needs a whole number, not '${text}'`);
    return Number(text);
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--count-only" || argument === "--cpu") {
      if (options.mode) throw new UsageError("give --count-only or --cpu, not both");
      options.mode = argument.slice(2);
    } else if (argument === "--all") options.all = true;
    else if (argument === "--update") options.update = true;
    else if (["--dist", "--base", "--candidate", "--out", "--json"].includes(argument))
      options[argument.slice(2)] = value(++index);
    else if (argument === "--cases") options.cases = value(++index).split(",");
    else if (["--rounds", "--warmups", "--batch"].includes(argument))
      options[argument.slice(2)] = count(value(++index), argument);
    else throw new UsageError(`unknown argument '${argument}'`);
  }
  if (!options.mode) throw new UsageError("give --count-only or --cpu");
  if (options.mode === "cpu" && !(options.base && options.candidate && options.out))
    throw new UsageError("--cpu needs --base, --candidate and --out");
  if (options.mode === "cpu" && options.update)
    throw new UsageError("--update belongs to --count-only");
  if (options.batch === 0) throw new UsageError("--batch needs at least 1");
  return options;
}

const formatCount = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

export async function main(argv, { directory = benchmarkDirectory, log = console.log } = {}) {
  const options = parseArguments(argv);
  const cases = loadCases(directory, { all: options.all, select: options.cases ?? null });
  if (options.mode === "count-only") {
    const api = await loadRuntime(options.dist ?? path.join(root, "dist"));
    const baselineFile = path.join(directory, "baseline.json");
    const baseline = fs.existsSync(baselineFile)
      ? JSON.parse(fs.readFileSync(baselineFile, "utf8"))
      : { cases: {} };
    const { records, problems, invariants } = checkCounts(api, cases, baseline);
    const names = manifestNames(directory);
    for (const name of Object.keys(baseline.cases))
      if (!names.includes(name))
        problems.push(`${name}: in the baseline but not in the manifest (--update removes it)`);
    for (const record of records) {
      const testCase = cases.find((entry) => entry.name === record.name);
      const last = record.cuts.at(-1);
      log(
        `${record.name}: ${record.instructions} instructions` +
          (testCase.units
            ? `, ${formatCount(record.instructions / testCase.units)} per ${testCase.unit}`
            : "") +
          `, ${last.status}, rng ${show(last.rng)}, state ${last.stateDigest.slice(0, 12)},` +
          ` events ${last.eventsDigest.slice(0, 12)}, ${record.cuts.length} cuts`,
      );
    }
    if (options.json) fs.writeFileSync(options.json, `${JSON.stringify(records, null, 1)}\n`);
    for (const problem of invariants) log(`DIFFERENCE ${problem}`);
    if (options.update) {
      if (invariants.length) {
        log("baseline not updated: the differences above hold whatever the baseline says");
        return 1;
      }
      fs.writeFileSync(baselineFile, formatBaseline(updatedBaseline(baseline, records, names)));
      log(`updated ${records.length} cases in ${baselineFile}`);
      return 0;
    }
    for (const problem of problems) log(`DIFFERENCE ${problem}`);
    if (problems.length)
      log(
        "A change of counts or results fails until the baseline is updated on purpose: " +
          "npm run benchmark:runtime -- --count-only --update (add --all for the on-demand cases), and review its diff.",
      );
    else if (!invariants.length) log(`${records.length} cases equal to the baseline`);
    return problems.length || invariants.length ? 1 : 0;
  }
  const builds = {
    base: await loadRuntime(options.base),
    candidate: await loadRuntime(options.candidate),
  };
  const timedCases = options.cases ? cases : cases.filter((entry) => !entry.probe);
  fs.mkdirSync(options.out, { recursive: true });
  const samplesFile = path.join(options.out, "samples.jsonl");
  fs.rmSync(path.join(options.out, "summary.json"), { force: true });
  fs.writeFileSync(samplesFile, "");
  const { problems, samples } = measureCpu(builds, timedCases, {
    rounds: options.rounds,
    warmups: options.warmups,
    batch: options.batch,
    onSample: (sample) => fs.appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`),
  });
  for (const problem of problems) log(`DIFFERENCE ${problem}`);
  if (problems.length) return 1;
  const summary = {
    node: process.version,
    base: path.resolve(options.base),
    candidate: path.resolve(options.candidate),
    samplesSha256: sha256(fs.readFileSync(samplesFile)),
    ...summarizeCpu(samples),
  };
  fs.writeFileSync(path.join(options.out, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  for (const [name, entry] of Object.entries(summary.cases)) {
    const speed = entry.pairedSpeed;
    log(
      `${name}: base/candidate CPU ${speed.median.toFixed(3)} [${speed.min.toFixed(3)}–${speed.max.toFixed(3)}],` +
        ` ${Object.entries(entry.builds)
          .map(
            ([build, figures]) =>
              `${build} ${figures.cpuNsPerInstruction.median.toFixed(1)} ns/instruction`,
          )
          .join(", ")}`,
    );
  }
  if (summary.suiteGeometricMeanOfPairedMedians !== null)
    log(
      `suite (${summary.suiteCases} cases): geometric mean of paired medians ${summary.suiteGeometricMeanOfPairedMedians.toFixed(3)}`,
    );
  log(`samples and summary in ${options.out}; CPU is reported, never checked`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(error instanceof UsageError ? `benchmark-runtime: ${error.message}` : error);
      process.exitCode = 2;
    },
  );
}
