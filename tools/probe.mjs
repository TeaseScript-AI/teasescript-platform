#!/usr/bin/env node
// Compiles one TeaseScript source with this checkout's build and prints its diagnostics. With --run it also runs the
// script: default reading time is zero, and the script's clock moves forward to the next moment something is due (a
// `wait`, an authored reading time, a timer), one moment at a time, so a timer's button or ask appears at its own time.
// The run stops when the script ends, fails (the runtime's own limits apply, such as its step limit for a busy loop),
// waits for the player (an answer, a button, also a timed button), or after 10,000 clock moves.
// --clock gives the run a wall clock, a UTC date and time such as 2026-10-04T18:30:00Z (seconds and milliseconds are
// optional), which moves with the script's clock; without one, reading the current time fails with TSR064. --zone gives
// the player's IANA time zone, such as Europe/Amsterdam, instead of UTC. Dates and times keep their locale-neutral text.
// --account gives the player's account: a JSON file with the person fields a host gives, such as
// {"firstName": "Alex", "gender": "male", "petNames": ["puppy", "pet"]}; without one, the account has no fields, so
// reading one fails with TSR017.
// Usage: npm run probe -- [--run [--clock <UTC date-time>] [--zone <IANA time zone>] [--account <file.json>]] [--json]
//   <file.tease | ->
// (- or no file reads standard input)
// For JSON consumers, call `node tools/probe.mjs --json …` or `npm --silent run probe -- --json …`, so npm prints no
// banner. Needs `npm run build:typescript` first: the probe loads dist/, so rebuild after changing the source.
// Exit status: 0 no error (also when the run stops waiting), 1 compile errors, 3 runtime failure, 2 usage, missing
// build, or unreadable source.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage =
  "Usage: npm run probe -- [--run [--clock <UTC date-time>] [--zone <IANA time zone>] [--account <file.json>]] [--json] <file.tease | ->";
const maxClockMoves = 10_000;
const options = { run: false, json: false, clock: undefined, zone: undefined, account: undefined };
const files = [];
const args = process.argv.slice(2);
while (args.length > 0) {
  const arg = args.shift();
  if (arg === "--run") options.run = true;
  else if (arg === "--json") options.json = true;
  else if (arg === "--clock") options.clock = args.shift() ?? fail("--clock needs a value.");
  else if (arg === "--zone") options.zone = args.shift() ?? fail("--zone needs a value.");
  else if (arg === "--account") options.account = args.shift() ?? fail("--account needs a value.");
  else if (arg === "-h" || arg === "--help") {
    console.log(usage);
    process.exit(0);
  } else if (arg.startsWith("--")) fail(`Unknown option ${arg}`);
  else files.push(arg);
}
if (files.length > 1) fail("One source at a time.");
if (
  !options.run &&
  (options.clock !== undefined || options.zone !== undefined || options.account !== undefined)
)
  fail("--clock, --zone, and --account apply to --run only.");
const file = files[0] ?? "-";
const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "index.js");
if (!existsSync(entry)) {
  console.error(`No build at ${entry}. Run npm run build:typescript first.`);
  process.exit(2);
}
const {
  captureTemporalContext,
  compileSource,
  createFreshRuntimeSession,
  createFreshRuntimeSnapshot,
  DEFAULT_TEMPORAL_CONTEXT,
  runtimeTimedWork,
} = await import(pathToFileURL(entry).href);
// Zero reading time, so a `say` does not wait for the player's reading.
const sessionOptions = { baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 };
if (options.clock !== undefined) sessionOptions.wallClockMs = clockMs(options.clock);
if (options.zone !== undefined) sessionOptions.temporalContext = zoneContext(options.zone);
if (options.account !== undefined) sessionOptions.account = accountInput(options.account);
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
  const session = createFreshRuntimeSession(plan, sessionOptions);
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

// The next moment the script waits for by time alone, or null when it waits for the player or the host. The engine
// says what comes due by time; a foreground interaction (an ask, a button with or without a timeout) always stops the
// probe, and so does a foreground wait that nothing timed settles.
function nextDueMs(view) {
  const due = runtimeTimedWork(view);
  const foreground = view.foregroundAction;
  if (
    foreground !== null &&
    (foreground.kind === "interaction" ||
      !due.some((work) => work.actionId === foreground.actionId))
  )
    return null;
  // A running loop, not Math.min(...): a script may start any number of timers.
  let earliest = Infinity;
  for (const work of due) if (work.deadlineMs < earliest) earliest = work.deadlineMs;
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

// The epoch milliseconds of a UTC date and time such as 2026-10-04T18:30:00Z, with seconds and milliseconds optional.
function clockMs(value) {
  const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(value)
    ? Date.parse(value)
    : NaN;
  // Date.parse moves an impossible date or time, such as February 30, on to a later one, so the fields must read back.
  if (Number.isNaN(ms) || !new Date(ms).toISOString().startsWith(value.slice(0, -1)))
    fail(`--clock takes a UTC date and time such as 2026-10-04T18:30:00Z, not ${value}.`);
  return ms;
}

// The zone's rules from this host's time-zone data. Dates and times keep their locale-neutral text, as without --zone,
// so the locale the capture is given does not matter.
function zoneContext(timeZone) {
  try {
    return { ...DEFAULT_TEMPORAL_CONTEXT, zone: captureTemporalContext(timeZone, "en").zone };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    fail(`--zone: ${error.message}`);
  }
}

// The account in the JSON file, checked as a fresh session checks the account its host gives, which names the first
// field the file gives wrongly. The check needs a plan, and any compiled plan will do, so a wrong account is refused
// before the source is read, as a wrong --clock or --zone is.
function accountInput(file) {
  let account;
  try {
    account = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`--account ${file}: ${error.message}`);
  }
  try {
    createFreshRuntimeSnapshot(compileSource("exit\n").plan, { account });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    fail(`--account ${file}: ${error.message}`);
  }
  return account;
}

// Spans count lines and columns from 0; editors count from 1.
function where(span) {
  return span?.start ? `${name}:${span.start.line + 1}:${span.start.column + 1}` : name;
}

function fail(message) {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}
