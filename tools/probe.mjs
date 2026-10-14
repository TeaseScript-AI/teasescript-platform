#!/usr/bin/env node
// Compiles one TeaseScript source with this checkout's build and prints its diagnostics. With --run it also runs the
// script: default reading time is zero, and the script's clock moves forward to the next moment something is due (a
// `wait`, an authored reading time, a timer), one moment at a time, so a timer's button or ask appears at its own time.
// The run stops when the script ends, fails (the runtime's own limits apply, such as its step limit for a busy loop),
// waits for the player (an answer, a button, also a timed button), or after 10,000 clock moves.
// Usage: npm run probe -- [--run] [--json] <file.tease | ->   (- or no file reads standard input)
// For JSON consumers, call `node tools/probe.mjs --json …` or `npm --silent run probe -- --json …`, so npm prints no
// banner. Needs `npm run build:typescript` first: the probe loads dist/, so rebuild after changing the source.
// Exit status: 0 no error (also when the run stops waiting), 1 compile errors, 3 runtime failure, 2 usage, missing
// build, or unreadable source.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage = "Usage: npm run probe -- [--run] [--json] <file.tease | ->";
const maxClockMoves = 10_000;
// Foreground actions that complete by time alone; every other foreground wait needs the player or the host.
const timedForeground = new Set(["delay", "chatPacingGate"]);
const options = { run: false, json: false };
const files = [];
const args = process.argv.slice(2);
for (const arg of args) {
  if (arg === "--run") options.run = true;
  else if (arg === "--json") options.json = true;
  else if (arg === "-h" || arg === "--help") {
    console.log(usage);
    process.exit(0);
  } else if (arg.startsWith("--")) fail(`Unknown option ${arg}`);
  else files.push(arg);
}
if (files.length > 1) fail("One source at a time.");
const file = files[0] ?? "-";
const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "index.js");
if (!existsSync(entry)) {
  console.error(`No build at ${entry}. Run npm run build:typescript first.`);
  process.exit(2);
}
const { compileSource, createFreshRuntimeSession } = await import(pathToFileURL(entry).href);
let source;
try {
  source = readFileSync(file === "-" ? 0 : file, "utf8");
} catch (error) {
  console.error(`Cannot read ${file === "-" ? "standard input" : file}: ${error.message}`);
  process.exit(2);
}
const name = file === "-" ? "<stdin>" : file;

const compiled = compileSource(source);
const diagnostics = compiled.diagnostics.map((d) => ({
  severity: d.severity,
  code: d.code,
  message: d.message,
  at: where(d.span),
}));
const compileFailed = compiled.plan === null || diagnostics.some((d) => d.severity === "error");
const run = options.run && !compileFailed ? runScript(compiled.plan) : null;

if (options.json) {
  console.log(JSON.stringify({ diagnostics, run }, null, 2));
} else {
  for (const d of diagnostics) console.log(`${d.at} ${d.severity} ${d.code} ${d.message}`);
  if (diagnostics.length === 0) console.log("no diagnostics");
  if (compileFailed && options.run) console.log("not run: the source has compile errors");
  if (run !== null) {
    for (const line of run.events) console.log(line);
    console.log(run.summary);
  }
}
// exitCode, not exit(): a forced exit can cut off output still being written to a pipe.
process.exitCode = compileFailed ? 1 : run?.status === "failed" ? 3 : 0;

function runScript(plan) {
  // Zero reading time, so a `say` does not wait for the player's reading.
  const session = createFreshRuntimeSession(plan, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  const events = [];
  let instructions = 0;
  let clockMoves = 0;
  let view = session.view();
  for (;;) {
    const result = session.run();
    instructions += result.instructionsExecuted;
    for (const event of result.events) events.push(describe(event));
    view = session.view();
    const next = view.status === "waiting" ? nextDueMs(view) : null;
    if (next === null || clockMoves === maxClockMoves) break;
    clockMoves += 1;
    // Only up to the earliest due moment: a timer due before a long `wait` runs first, and a button or ask it shows
    // stops the probe before any later deadline (such as that button's own timeout) passes.
    const observed = session.observeTime(next);
    for (const event of observed.events) events.push(describe(event));
  }
  const waiting =
    view.status === "waiting" ? `, waiting for ${actionKind(view.foregroundAction)}` : "";
  const limit =
    clockMoves === maxClockMoves && view.status === "waiting"
      ? ` (stopped after ${maxClockMoves} clock moves)`
      : "";
  const clock =
    view.currentSessionTimeMs > 0 ? `, script time ${view.currentSessionTimeMs} ms` : "";
  return {
    status: view.status,
    instructionsExecuted: instructions,
    scriptTimeMs: view.currentSessionTimeMs,
    events,
    summary: `${view.status} after ${instructions} instructions${clock}${waiting}${limit}`,
  };
}

// The next moment the script waits for by time alone, or null when it waits for the player or the host. A foreground
// interaction (an ask, a button with or without a timeout) always stops the probe.
function nextDueMs(view) {
  const foreground = view.foregroundAction;
  if (foreground !== null && !timedForeground.has(foreground.kind)) return null;
  // A running loop, not Math.min(...): a script may start any number of timers.
  let earliest = Infinity;
  if (foreground !== null && Number.isFinite(foreground.deadlineMs))
    earliest = foreground.deadlineMs;
  for (const action of view.backgroundActions) {
    const deadline =
      action.timer?.state === "running" ? action.timer.deadlineMs : action.deadlineMs;
    if (Number.isFinite(deadline) && deadline < earliest) earliest = deadline;
  }
  if (earliest === Infinity) return null;
  return Math.max(earliest, view.currentSessionTimeMs);
}

function describe(event) {
  switch (event.kind) {
    case "say":
      return `say: ${event.text}`;
    case "messageUpdated":
      return `message updated: ${event.text}`;
    case "runtimeFailure":
      return `runtime failure ${event.code} at ${where(event.span)}: ${event.message}`;
    case "developerWarning":
      return `warning ${event.code} at ${where(event.span)}: ${event.message}`;
    case "actionRequested":
      return `requested: ${actionKind(event.action)}`;
    default:
      return event.kind;
  }
}

function actionKind(action) {
  if (action === null || action === undefined) return "the host";
  return action.interactionKind ?? action.kind ?? "an action";
}

// Spans count lines and columns from 0; editors count from 1.
function where(span) {
  return span?.start ? `${name}:${span.start.line + 1}:${span.start.column + 1}` : name;
}

function fail(message) {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}
