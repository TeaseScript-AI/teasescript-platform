// Runs Teases on today's engine and as emitted programs, and compares what a player sees after each operation: the
// events, the status, the failure, the foreground action and the generator's state (research code of the study).
//   node study/js-route/compare.mjs [--seed S] [--emit DIR] FILE.tease...
// Play: run; while the session waits on reading time or a delay, observe its deadline and run again. Prints one JSON
// line per file: { file, verdict: "same" | "different" | "unsupported" | "uncompiled", operations, first difference }.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";
import { compileProject, compileSource, createFreshRuntimeSession } from "../../dist/src/index.js";
import { createEmittedSession, createGeneratorSession, createResumableSession, compileProgram } from "./driver.mjs";
import { Unsupported } from "./emit.mjs";

const args = process.argv.slice(2);
let seed = 20260713;
let emitDir = null;
let mode = "replay";
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--seed") seed = Number(args[++i]);
  else if (args[i] === "--emit") emitDir = args[++i];
  else if (args[i] === "--mode") mode = args[++i];
  else files.push(args[i]);
}
const FRESH = { seed, wallClockMs: Date.UTC(2026, 6, 13, 9, 0, 0) };
const BUDGET = 2_000_000_000;
const OPERATIONS = Number(process.env.OPERATIONS ?? 200);
/** RUNAWAY=1: the emitted program carries the cheap runaway check, so a loop that never ends faults after 10 s. */
const RUNAWAY = process.env.RUNAWAY === "1";

/**
 * The fields an action records of the interpreter's frames (the call it waits in, its open scopes and loops, a block's
 * scope), which an emitted program does not have; left out of the comparison and listed as a difference of the route.
 */
const PLACE = new Set(["ownerCallFrameId", "scopeDepth", "loopDepth", "rootScopeId"]);

function view(state, result) {
  return JSON.parse(
    JSON.stringify({
      events: result.events,
      status: state.status,
      failure: state.failure,
      foreground: state.foregroundAction,
      rng: state.rng,
    }),
    (key, value) => (PLACE.has(key) ? undefined : value),
  );
}

function teaseFiles(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) teaseFiles(root, full, out);
    else if (entry.name.endsWith(".tease")) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

/** A file's plan, or a package directory's: its `.tease` files with `main.tease` first. */
function planOf(file) {
  if (fs.statSync(file).isDirectory()) {
    const paths = teaseFiles(file);
    const ordered = ["main.tease", ...paths.filter((p) => p !== "main.tease")].filter((p) => paths.includes(p));
    const result = compileProject(ordered.map((p) => ({ path: p, source: fs.readFileSync(path.join(file, p), "utf8") })));
    return { plan: result.plan ?? null, files: ordered.length, diagnostics: result.diagnostics };
  }
  const result = compileSource(fs.readFileSync(file, "utf8"));
  return { plan: result.plan ?? null, files: 1, diagnostics: result.diagnostics };
}

function firstDifference(a, b, at = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return { at, today: a, emitted: b };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstDifference(a[key], b[key], `${at}/${key}`);
    if (found !== null) return found;
  }
  return { at, today: a, emitted: b };
}

/**
 * The host's next operation for a waiting session, decided by the action it waits on only, so both engines get the same
 * play: a reading time or a delay is observed at its deadline; a button is pressed, a choice takes its first option,
 * text and number asks get "1"; a storage write is stored. Anything else ends the play (`null`).
 */
function nextOperation(state) {
  const action = state.foregroundAction;
  if (state.status !== "waiting" || action === null) return null;
  if (action.kind === "chatPacingGate" || action.kind === "delay") return { kind: "time", nowMs: action.deadlineMs };
  if (action.kind === "storageWrite")
    return { kind: "complete", request: { actionId: action.actionId, actionKind: "storageWrite", payload: { kind: "stored" } } };
  if (action.kind !== "interaction") return null;
  const base = { actionId: action.actionId, actionKind: "interaction", interactionKind: action.interactionKind };
  switch (action.interactionKind) {
    case "button":
      return { kind: "complete", request: { ...base, payload: { kind: "activate" } } };
    case "choice":
      return { kind: "complete", request: { ...base, payload: { kind: "selectedOption", optionIndex: 0 } } };
    case "text":
    case "number":
    case "password":
      return { kind: "complete", request: { ...base, payload: { kind: "submittedText", submittedText: "1" } } };
    default:
      return null;
  }
}

function play(session, state, operations) {
  const out = [];
  const times = [];
  let instructions = 0;
  const timed = (f) => {
    const t0 = performance.now();
    const result = f();
    times.push(performance.now() - t0);
    instructions += result.instructionsExecuted ?? 0;
    return result;
  };
  // The state is read after the operation: `view(state(), op())` would read it first.
  const after = (result) => view(state(), result);
  out.push(after(timed(() => session.run({ instructionBudget: BUDGET }))));
  for (let n = 0; n < operations; n += 1) {
    const operation = nextOperation(state());
    if (operation === null) break;
    out.push(after(timed(() => (operation.kind === "time" ? session.observeTime(operation.nowMs) : session.completeAction(operation.request)))));
    out.push(after(timed(() => session.run({ instructionBudget: BUDGET }))));
  }
  return { out, times, instructions, waiting: state().foregroundAction?.kind ?? null, interaction: state().foregroundAction?.interactionKind ?? null };
}

for (const file of files) {
  const compiled = planOf(file);
  const name = path.basename(file);
  if (!compiled.plan) {
    // Codes and lines only; the messages (which can quote a source) with DIAGNOSTICS=1, for invented sources.
    const shownDiagnostic = (d) => `${d.span?.start?.line ?? "?"}:${d.code ?? ""}${process.env.DIAGNOSTICS === "1" ? ` ${d.message}` : ""}`;
    console.log(JSON.stringify({ file: name, verdict: "uncompiled", diagnostics: (compiled.diagnostics ?? []).filter((d) => d.severity !== "warning").slice(0, 3).map(shownDiagnostic) }));
    continue;
  }
  // Today's engine first, so that every compiled Tease reports its weight (instructions run in the play, plan size).
  const today = createFreshRuntimeSession(compiled.plan, FRESH);
  process.stderr.write(`${name}: today's engine\n`);
  const expected = play(today, () => today.exportSnapshot(), OPERATIONS);
  const weight = { files: compiled.files, planInstructions: compiled.plan.instructions.length, instructions: expected.instructions, operations: expected.out.length };
  let emitted;
  try {
    emitted = compileProgram(compiled.plan, mode === "resumable" ? true : mode === "generators" ? "generators" : false, RUNAWAY);
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    console.log(JSON.stringify({ file: name, verdict: "unsupported", why: error.message, ...weight }));
    continue;
  }
  if (emitDir !== null) fs.writeFileSync(path.join(emitDir, `${name}.js`), emitted.source);
  const session =
    mode === "resumable" ? createResumableSession(compiled.plan, FRESH, { runawayCheck: RUNAWAY })
    : mode === "generators" ? createGeneratorSession(compiled.plan, FRESH, { runawayCheck: RUNAWAY })
    : createEmittedSession(compiled.plan, FRESH, { runawayCheck: RUNAWAY });
  let largestSave = 0;
  if (mode === "resumable") {
    const run = session.run.bind(session);
    session.run = (o) => {
      const r = run(o);
      largestSave = Math.max(largestSave, session.save?.length ?? 0);
      return r;
    };
  }
  process.stderr.write(`${name}: emitted (${mode})\n`);
  let actual;
  try {
    actual = play(session, () => session.state, OPERATIONS);
  } catch (error) {
    console.log(JSON.stringify({ file: name, verdict: "unsupported", why: String(error?.message ?? error).slice(0, 300), ...weight }));
    continue;
  }
  const difference = firstDifference(expected.out, actual.out);
  const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  console.log(
    JSON.stringify({
      file: name,
      mode,
      verdict: difference === null ? "same" : "different",
      ...weight,
      events: expected.out.reduce((n, o) => n + o.events.length, 0),
      endsAt: expected.waiting === null ? expected.out.at(-1)?.status : `${expected.waiting}${expected.interaction ? `:${expected.interaction}` : ""}`,
      ...(difference === null ? {} : { difference: JSON.stringify(difference).slice(0, 600), emittedFailure: JSON.stringify(session.state.failure ?? null).slice(0, 400) }),
      size: emitted.source.length,
      gzip: zlib.gzipSync(emitted.source).length,
      bridgedCalls: session.bridged ?? 0,
      bridgedInstructions: session.bridgedInstructions ?? 0,
      todayMs: sum(expected.times),
      emittedMs: sum(actual.times),
      largestSave,
      emitMs: Math.round(emitted.emitMs * 100) / 100,
      loadMs: Math.round(emitted.loadMs * 100) / 100,
      resumableFunctions: emitted.canWait?.length ?? 0,
      emittedLastDriveMs: Math.round((actual.times.at(-1) ?? 0) * 100) / 100,
    }),
  );
}
