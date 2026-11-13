// Runs Teases on today's engine and as emitted programs, and compares what a player sees after each operation: the
// events, the status, the failure, the foreground action and the generator's state (research code of the study).
//   node study/js-route/compare.mjs [--seed S] [--emit DIR] FILE.tease...
// Play: run; while the session waits on reading time or a delay, observe its deadline and run again. Prints one JSON
// line per file: { file, verdict: "same" | "different" | "unsupported" | "uncompiled", operations, first difference }.
import fs from "node:fs";
import path from "node:path";
import { compileSource, createFreshRuntimeSession } from "../../dist/src/index.js";
import { createEmittedSession, compileProgram } from "./driver.mjs";
import { Unsupported } from "./emit.mjs";

const args = process.argv.slice(2);
let seed = 20260713;
let emitDir = null;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--seed") seed = Number(args[++i]);
  else if (args[i] === "--emit") emitDir = args[++i];
  else files.push(args[i]);
}
const FRESH = { seed, wallClockMs: Date.UTC(2026, 6, 13, 9, 0, 0) };
const BUDGET = 2_000_000_000;

function view(state, result) {
  return JSON.parse(
    JSON.stringify({
      events: result.events,
      status: state.status,
      failure: state.failure,
      foreground: state.foregroundAction,
      rng: state.rng,
    }),
  );
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

function play(session, state, operations) {
  const out = [];
  out.push(view(state(), session.run({ instructionBudget: BUDGET })));
  for (let n = 0; n < operations; n += 1) {
    const s = state();
    if (s.status !== "waiting") break;
    const action = s.foregroundAction;
    if (action === null || (action.kind !== "chatPacingGate" && action.kind !== "delay")) break;
    out.push(view(state(), session.observeTime(action.deadlineMs)));
    out.push(view(state(), session.run({ instructionBudget: BUDGET })));
  }
  return out;
}

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const compiled = compileSource(source);
  const name = path.basename(file);
  if (!compiled.plan) {
    console.log(JSON.stringify({ file: name, verdict: "uncompiled" }));
    continue;
  }
  let emitted;
  try {
    emitted = compileProgram(compiled.plan);
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    console.log(JSON.stringify({ file: name, verdict: "unsupported", why: error.message }));
    continue;
  }
  if (emitDir !== null) fs.writeFileSync(path.join(emitDir, `${name}.js`), emitted.source);
  const today = createFreshRuntimeSession(compiled.plan, FRESH);
  const expected = play(today, () => today.exportSnapshot(), 50);
  const session = createEmittedSession(compiled.plan, FRESH);
  let actual;
  try {
    actual = play(session, () => session.state, 50);
  } catch (error) {
    console.log(JSON.stringify({ file: name, verdict: "unsupported", why: String(error?.message ?? error) }));
    continue;
  }
  const difference = firstDifference(expected, actual);
  console.log(
    JSON.stringify({
      file: name,
      verdict: difference === null ? "same" : "different",
      operations: expected.length,
      events: expected.reduce((n, o) => n + o.events.length, 0),
      ...(difference === null ? {} : { difference }),
      size: emitted.source.length,
    }),
  );
}
