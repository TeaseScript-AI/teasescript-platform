import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan, StartTimerInstruction, WaitInstruction } from "../src/plan/model.js";
import type { RuntimeTimerActionSnapshot } from "../src/runtime/actions/model.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { nextXorShift32 } from "../src/runtime/random.js";
import { createFreshRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent, functionFrames } from "./helpers/runtime-equivalence.js";
import {
  activePlayerRuntimePacingGate,
  playerRuntimeDeadlines,
} from "../player/runtime-adapter.js";

function playerRuntimeDeadlinesDue(snapshot: RuntimeSnapshot): boolean {
  return playerRuntimeDeadlines(snapshot).some(
    (deadline) => deadline <= snapshot.observedSessionTimeMs,
  );
}

/**
 * Generous bound for a catch-up that finishes in well under a second. The horizons that use it hold so many silent
 * rounds that expiring them one at a time would take days, so exceeding it means that regression rather than a slow
 * machine; it is not a performance threshold.
 */
const BOUNDED_CATCH_UP_LIMIT_MS = 20_000;

/**
 * Restores a checkpoint, observes a time, and runs the engine, round-tripping each resulting snapshot through checkpoint
 * JSON as `Session.at` does; prints the result as JSON. See `Session.atBounded`.
 */
const BOUNDED_CATCH_UP_SCRIPT = `
  import assert from "node:assert/strict";
  import {
    createCheckpoint, deserializeCheckpoint, observeTime, run, serializeCheckpoint,
  } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { checkpoint, nowMs } = JSON.parse(input);
  const { plan, snapshot } = deserializeCheckpoint(checkpoint);
  const restore = (current) => {
    const json = serializeCheckpoint(createCheckpoint(plan, current));
    const restored = deserializeCheckpoint(json).snapshot;
    assert.deepEqual(restored, current, "checkpoint JSON must round-trip exactly");
    return { json, restored };
  };
  const observed = observeTime(plan, snapshot, nowMs);
  const ran = run(plan, restore(observed.snapshot).restored);
  process.stdout.write(JSON.stringify({
    outcome: observed.outcome.kind,
    events: [...observed.events, ...ran.events],
    checkpoint: restore(ran.snapshot).json,
  }));
`;

/** Drives a session with explicit time observations and completions, round-tripping every checkpoint. */
class Session {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[] = [];

  constructor(
    source: string,
    options: {
      readonly pacing?: boolean;
      readonly seed?: number;
      readonly initialSessionTimeMs?: number;
    } = {},
  ) {
    this.plan = plan(source);
    const settings = {
      seed: options.seed ?? 0x1234_5678,
      initialSessionTimeMs: options.initialSessionTimeMs ?? 0,
    };
    const fresh =
      options.pacing === true
        ? createFreshRuntimeSnapshot(this.plan, settings)
        : createImmediatePacingRuntimeSnapshot(this.plan, settings);
    this.snapshot = fresh;
    this.run();
  }

  run(): this {
    this.#restore();
    const result = run(this.plan, this.snapshot);
    this.events.push(...result.events);
    this.snapshot = result.snapshot;
    this.#restore();
    return this;
  }

  at(nowMs: number): this {
    this.#restore();
    const observed = observeTime(this.plan, this.snapshot, nowMs);
    assert.equal(observed.outcome.kind, "observed");
    this.events.push(...observed.events);
    this.snapshot = observed.snapshot;
    return this.run();
  }

  /**
   * Like `at`, but catches up in a child process that is stopped after `BOUNDED_CATCH_UP_LIMIT_MS`. Catch-up is
   * synchronous, so a node:test `timeout` cannot interrupt it; the child turns a regression to per-round catch-up into
   * a failure instead of a hung suite.
   */
  atBounded(nowMs: number): this {
    this.#restore();
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", BOUNDED_CATCH_UP_SCRIPT],
      {
        input: JSON.stringify({
          checkpoint: serializeCheckpoint(createCheckpoint(this.plan, this.snapshot)),
          nowMs,
        }),
        encoding: "utf8",
        timeout: BOUNDED_CATCH_UP_LIMIT_MS,
      },
    );
    assert.equal(child.error, undefined, `catch-up to ${nowMs} ms must finish within the bound`);
    assert.equal(child.status, 0, child.stderr);
    // EVIDENCE: fixture: the child prints plain JSON data in this shape.
    const result = JSON.parse(child.stdout) as {
      outcome: string;
      events: InterpreterEvent[];
      checkpoint: string;
    };
    assert.equal(result.outcome, "observed");
    this.events.push(...result.events);
    this.snapshot = deserializeCheckpoint(result.checkpoint).snapshot;
    return this.run();
  }

  answer(text: string): string {
    this.#restore();
    const action = this.snapshot.foregroundAction;
    const actionId =
      action?.kind === "interaction"
        ? action.actionId
        : functionFrames(this.snapshot).find((frame) => frame.timerInterruption?.suspendedAction)
            ?.timerInterruption?.suspendedAction?.actionId;
    assert.ok(actionId !== undefined, "an interaction must be pending or suspended");
    const result = completeAction(this.plan, this.snapshot, {
      actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: text },
    });
    this.events.push(...result.events);
    this.snapshot = result.snapshot;
    if (result.outcome.kind === "completed") this.run();
    return result.outcome.kind;
  }

  said(): string[] {
    return this.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  }

  timers(): RuntimeTimerActionSnapshot[] {
    return this.snapshot.backgroundActions.filter(
      (action): action is RuntimeTimerActionSnapshot => action.kind === "timer",
    );
  }

  #restore(): void {
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(this.plan, this.snapshot)),
    );
    assert.deepEqual(restored.snapshot, this.snapshot, "checkpoint JSON must round-trip exactly");
    this.snapshot = restored.snapshot;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonPath = readonly (string | number)[];

/** Returns the checkpoint JSON with the value at `path` replaced, or appended when the path ends in `push`. */
function forged(json: string, path: JsonPath, value: Json): string {
  // EVIDENCE: fixture: checkpoint serialization produces plain JSON data.
  const root = JSON.parse(json) as Json;
  let parent = root;
  for (const key of path.slice(0, -1)) parent = child(parent, key);
  const last = path.at(-1)!;
  if (Array.isArray(parent)) {
    if (last === "push") parent.push(value);
    else if (typeof last === "number") parent[last] = value;
    else assert.fail(`cannot index an array with ${last}`);
  } else {
    assert.ok(typeof parent === "object" && parent !== null && typeof last === "string");
    parent[last] = value;
  }
  return JSON.stringify(root);
}

function child(value: Json, key: string | number): Json {
  if (Array.isArray(value) && typeof key === "number") return value[key]!;
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  assert.ok(typeof key === "string");
  return value[key]!;
}

function assertForgedRejected(json: string, path: JsonPath, value: Json): void {
  assert.throws(
    () => deserializeCheckpoint(forged(json, path, value)),
    (error: unknown) => error instanceof CheckpointError,
    JSON.stringify(path),
  );
}

/** Requested actions in request order. */
function requestedActions(events: readonly InterpreterEvent[]) {
  return events.flatMap((event) => (event.kind === "actionRequested" ? [event.action] : []));
}

/** Time-driven settlements as [action ID, settlement kind, scene time]. */
function timedSettlements(events: readonly InterpreterEvent[]) {
  return events.flatMap((event) =>
    event.kind === "actionCompleted" && "completedAtMs" in event.settlement
      ? [
          [
            event.settlement.actionId,
            event.settlement.settlementKind,
            event.settlement.completedAtMs,
          ],
        ]
      : [],
  );
}

function warnings(session: Session): string[] {
  return session.events.flatMap((event) => (event.kind === "developerWarning" ? [event.code] : []));
}

test("short and named timer forms lower to blocking delays or async timer starts", () => {
  const compiled = plan(
    [
      'timer mystery 2 min "Wait for it"',
      "timer hidden 500 ms",
      'let a = timer async visible 10 s "Deadline" { say "late" }',
      "timer async mystery 1..3",
      'let b = timer(duration: 5, async: true, display: "hidden", repeat: true, persist: true) { say "tick" }',
      'timer(label: "Named", duration: 3)',
      "exit",
    ].join("\n"),
  );
  const waits = compiled.instructions.filter(
    (instruction): instruction is WaitInstruction => instruction.kind === "wait",
  );
  assert.deepEqual(
    waits.map((wait) => [wait.command, wait.display, wait.label !== null]),
    [
      ["timer", "mystery", true],
      ["timer", "hidden", false],
      ["timer", "visible", true],
    ],
  );
  const starts = compiled.instructions.filter(
    (instruction): instruction is StartTimerInstruction => instruction.kind === "startTimer",
  );
  assert.deepEqual(
    starts.map((start) => [
      typeof start.display === "string" ? start.display : "expression",
      start.repeat,
      start.persist,
      start.handlerFunctionId !== null,
      start.destinationTemporary !== null,
    ]),
    [
      ["visible", false, false, true, true],
      ["mystery", false, false, false, false],
      ["expression", true, true, true, true],
    ],
  );
  assert.ok(compiled.functions.every((definition) => definition.handler === "timer"));
  assert.equal(compiled.functions.length, 2);
});

test("a blocking timer evaluates a named display expression like an async timer", () => {
  const blocking = new Session(
    'let mode = "mystery"\ntimer(duration: 30 s, display: mode, label: "Hold")\nsay "done"\nexit',
  );
  const delay = blocking.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  assert.equal(delay?.kind === "delay" ? delay.display : null, "mystery");
  blocking.at(30_000);
  assert.deepEqual(blocking.said(), ["done"]);

  // Operands written out of order are still evaluated in source order.
  const order = new Session(
    'let log = ""\nfunction mode { log = "${log}display "\nreturn "hidden" }\nfunction seconds { log = "${log}duration "\nreturn 1 }\ntimer(display: mode(), duration: seconds())\nsay log\nexit',
  );
  order.at(1_000);
  assert.deepEqual(order.said(), ["display duration "]);

  const invalid = new Session('let mode = "loud"\ntimer(duration: 1, display: mode)\nexit');
  assert.equal(invalid.snapshot.failure?.code, "TSR050");
});

test("static handle hints do not leak from untaken paths, and a variable keeps its handle type", () => {
  // A `load` value has no static type, so `o` may hold a handle on one path and an object on another.
  const untaken = compileSource(
    'let o = load "o"\nif false {\n  o = timer async 1\n}\nsay "${o.x}"\nexit',
  );
  assert.deepEqual(untaken.diagnostics, []);
  // `t` keeps its timer type, so a loaded value must be a timer too, and timers have no property `x`.
  const reassigned = 'let t = timer async 1\nt = load "t"\nsay "${t.x}"\nexit';
  assert.deepEqual(
    compileSource(reassigned).diagnostics.map((diagnostic) => [
      diagnostic.code,
      reassigned.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
    ]),
    [["TSV043", "x"]],
  );
});

test("a whole-second range may carry a trailing seconds unit", () => {
  const session = new Session("timer 5..10 s\nexit");
  const action = session.snapshot.foregroundAction;
  assert.ok(action?.kind === "delay");
  const seconds = (action.deadlineMs - action.createdAtMs) / 1_000;
  assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds < 10, String(seconds));
});

test("nested timers created by an expiry block leave the terminal wait valid", () => {
  const session = new Session("timer async 1 {\n  timer async 1\n}\nwait 3\nexit");
  session.at(1_000).at(3_000);
  assert.equal(session.snapshot.status, "halted");

  const requested = requestedActions(session.events);
  const timers = requested.filter((action) => action.kind === "timer");
  const delay = requested.find((action) => action.kind === "delay");
  assert.ok(delay);
  // The outer timer starts at 0 ms; its expiry block starts the nested one-second timer at 1000 ms.
  assert.deepEqual(
    timers.map((action) => [action.createdAtMs, action.timer.deadlineMs]),
    [
      [0, 1_000],
      [1_000, 2_000],
    ],
  );
  assert.notEqual(timers[0]!.actionId, timers[1]!.actionId);
  assert.notEqual(timers[0]!.timer.timerId, timers[1]!.timer.timerId);
  assert.deepEqual(timedSettlements(session.events), [
    [timers[0]!.actionId, "finished", 1_000],
    [timers[1]!.actionId, "finished", 2_000],
    [delay.actionId, "completed", 3_000],
  ]);
  assert.equal(session.events.filter((event) => event.kind === "exit").length, 1);
});

test("an async timer returns a typed handle whose reads follow scene time", () => {
  const session = new Session(
    [
      'let t = timer async mystery 10 s "Deadline"',
      'say "${t.state} ${t.display} ${t.label} ${t.remaining} ${t.elapsed} ${t.remaining > 9 s}"',
      "wait 4",
      'say "${t.remaining} ${t.elapsed}"',
      "wait 7",
      'say "${t.state} ${t.remaining} ${t.elapsed}"',
      "exit",
    ].join("\n"),
  );
  session.at(4_000).at(11_000);
  assert.deepEqual(session.said(), [
    "running mystery Deadline 10 s 0 s true",
    "6 s 4 s",
    "finished 0 s 10 s",
  ]);
  assert.equal(session.snapshot.status, "halted");
  const completed = session.events.filter((event) => event.kind === "actionCompleted");
  assert.ok(
    completed.some(
      (event) =>
        event.settlement.actionKind === "timer" && event.settlement.settlementKind === "finished",
    ),
  );
});

test("pause, resume, and stop follow the four lifecycle states with idempotent no-ops", () => {
  const session = new Session(
    [
      "let t = timer async 10",
      "wait 2",
      "t.pause()",
      "t.pause()",
      "wait 5",
      'say "${t.state} ${t.remaining} ${t.elapsed}"',
      "t.resume()",
      "t.resume()",
      "wait 1",
      'say "${t.state} ${t.remaining} ${t.elapsed}"',
      "t.stop()",
      "t.stop()",
      'say "${t.state} ${t.remaining} ${t.elapsed}"',
      "t.resume()",
      "t.pause()",
      "t.remaining += 5 s",
      't.display = "hidden"',
      "t.repeatDuration = 5 s",
      'say "${t.state} ${t.remaining}"',
      "exit",
    ].join("\n"),
  );
  session.at(2_000).at(7_000).at(8_000);
  assert.deepEqual(session.said(), [
    "paused 8 s 2 s",
    "running 7 s 3 s",
    "stopped 0 s 3 s",
    "stopped 0 s",
  ]);
  assert.deepEqual(warnings(session), ["TSW010", "TSW010", "TSW010", "TSW010", "TSW010"]);
  assert.equal(session.snapshot.status, "halted");
});

test("adjusting remaining changes only the current round and zero expires it immediately", () => {
  const session = new Session(
    [
      "let fired = 0",
      "let t = timer async 10 {",
      "  fired += 1",
      "}",
      "t.remaining -= 4 s",
      'say "${t.remaining}"',
      "t.pause()",
      "t.remaining = 20 s",
      'say "${t.state} ${t.remaining}"',
      "t.remaining -= 1 h",
      'say "${t.state} ${t.remaining} fired ${fired}"',
      "wait 1",
      'say "fired ${fired}"',
      "exit",
    ].join("\n"),
  );
  session.at(1_000);
  assert.deepEqual(session.said(), ["6 s", "paused 20 s", "finished 0 s fired 1", "fired 1"]);
});

test("a paused repeating timer expiring at zero stays paused with a full next round", () => {
  const session = new Session(
    [
      "let t = timer(duration: 3, async: true, repeat: true)",
      "t.pause()",
      "t.remaining = 0 s",
      'say "${t.state} ${t.remaining}"',
      "t.repeatDuration = 5 s",
      "t.resume()",
      "wait 4",
      'say "${t.remaining} ${t.elapsed}"',
      "exit",
    ].join("\n"),
  );
  session.at(3_000).at(4_000);
  assert.deepEqual(session.said(), ["paused 3 s", "4 s 4 s"]);
});

test("repeating ranges redraw each round from the session RNG, including during catch-up", () => {
  const seed = 0x1234_5678;
  const source = [
    "let rounds = []",
    "let t = timer(duration: 1..=4, async: true, repeat: true) {",
    "  rounds.add(t.elapsed)",
    '  say "${t.elapsed}"',
    "}",
    "wait 30",
    'say "${rounds.length}"',
    "exit",
  ].join("\n");
  const late = new Session(source, { seed });
  const firstRoundRng = structuredClone(late.snapshot.rng);
  late.at(30_000);
  const stepwise = new Session(source, { seed });
  for (let now = 500; now <= 30_000; now += 500) stepwise.at(now);
  // The same seed gives the same rounds, draws, and output whether time is observed late or stepwise.
  assert.deepEqual(late.events, stepwise.events);
  assert.deepEqual(late.snapshot, stepwise.snapshot);

  const said = late.said();
  const expiriesMs = said.slice(0, -1).map((text) => Number(text.replace(/ s$/u, "")) * 1_000);
  assert.equal(said.at(-1), String(expiriesMs.length));
  const roundsMs = expiriesMs.map((ms, index) => ms - (expiriesMs[index - 1] ?? 0));
  // Every round lasts whole seconds in 1..=4, and rounds keep expiring until the wait ends.
  assert.ok(
    roundsMs.every((ms) => [1_000, 2_000, 3_000, 4_000].includes(ms)),
    String(roundsMs),
  );
  assert.ok(30_000 - expiriesMs.at(-1)! < 4_000, String(expiriesMs));
  // Later rounds are drawn again from the session RNG instead of repeating the first round:
  // one draw per round, with the range's inclusive upper bound still reachable.
  assert.ok(new Set(roundsMs).size > 1, String(roundsMs));
  assert.ok(roundsMs.slice(1).includes(4_000), String(roundsMs));
  const expectedRng = structuredClone(firstRoundRng);
  for (let round = 0; round < expiriesMs.length; round += 1) nextXorShift32(expectedRng);
  assert.deepEqual(late.snapshot.rng, expectedRng);
});

test("an expiry block interrupts an unanswered ask and the prompt returns afterwards", () => {
  const session = new Session(
    [
      "let t = timer async 5 {",
      '  say "Hurry up."',
      "  wait 2",
      '  say "Still waiting."',
      "}",
      'let name = askText "Name?"',
      'say "Hello ${name}"',
      "exit",
    ].join("\n"),
  );
  const prompt = session.snapshot.foregroundAction;
  assert.equal(prompt?.kind, "interaction");
  session.at(5_000);
  assert.equal(session.snapshot.foregroundAction?.kind, "delay", "the block now waits");
  assert.equal(session.answer("Early"), "suspendedAction", "the interrupted prompt is inert");
  session.at(7_000);
  assert.deepEqual(session.snapshot.foregroundAction, prompt, "the same prompt is re-presented");
  assert.equal(session.answer("Ada"), "completed");
  assert.deepEqual(session.said(), ["Hurry up.", "Still waiting.", "Hello Ada"]);
  assert.equal(session.snapshot.status, "halted");
});

test("exit in an expiry block cancels the interrupted ask without assigning it", () => {
  const session = new Session(
    [
      "let t = timer async 5 {",
      '  say "Too slow."',
      "  exit",
      "}",
      'let name = askText "Name?"',
      'say "never ${name}"',
      "exit",
    ].join("\n"),
  );
  const prompt = session.snapshot.foregroundAction;
  assert.ok(prompt?.kind === "interaction");
  session.at(5_000);
  assert.deepEqual(session.said(), ["Too slow."]);
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.events.at(-1)?.kind, "exit");
  const late = completeAction(session.plan, session.snapshot, {
    actionId: prompt.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "late" },
  });
  assert.equal(late.outcome.kind, "staleAction");
});

test("an interrupted wait settles in deadline order and its path continues once", () => {
  const session = new Session(
    [
      "let t = timer async 1 {",
      '  say "block start"',
      "  wait 5",
      '  say "block end"',
      "}",
      "wait 3",
      'say "main after wait"',
      "exit",
    ].join("\n"),
  );
  session.at(1_000);
  session.at(3_000);
  const settled = session.events.filter((event) => event.kind === "actionCompleted");
  assert.equal(
    settled.at(-1)?.kind === "actionCompleted" && settled.at(-1)?.settlement.actionKind,
    "delay",
  );
  assert.deepEqual(session.said(), ["block start"], "the interrupted path stays suspended");
  session.at(6_000);
  assert.deepEqual(session.said(), ["block start", "block end", "main after wait"]);
});

test("expiry blocks run one at a time in due order, and later expiries queue behind a waiting block", () => {
  const session = new Session(
    [
      'let a = timer async 3 { say "A" }',
      "let b = timer async 1 {",
      '  say "B start"',
      "  wait 5",
      '  say "B end"',
      "}",
      'let c = timer async 2 { say "C" }',
      "wait 20",
      'say "main"',
      "exit",
    ].join("\n"),
  );
  // B's wait ends at 6 s, so a late observation at 10 s runs the whole block and then the queued C and A.
  session.at(10_000);
  assert.deepEqual(session.said(), ["B start", "B end", "C", "A"]);
  session.at(20_000);
  assert.deepEqual(session.said(), ["B start", "B end", "C", "A", "main"]);
});

test("stop cancels queued expiry blocks of that timer only", () => {
  const session = new Session(
    [
      "let count = 0",
      "let fast = timer(duration: 1, async: true, repeat: true) {",
      "  count += 1",
      "  if count == 2 {",
      "    fast.stop()",
      "  }",
      "}",
      'let other = timer async 3 { say "other ${count}" }',
      "wait 10",
      'say "count ${count} ${fast.state}"',
      "exit",
    ].join("\n"),
  );
  session.at(10_000);
  assert.deepEqual(session.said(), ["other 2", "count 2 stopped"]);
});

test("expiry blocks queued at script end still run, while script end stops running timers", () => {
  const session = new Session(
    [
      'let later = timer async 100 { say "never" }',
      'let now = timer async 50 { say "forced ${later.state}" }',
      "now.remaining = 0 s",
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(session.said(), ["forced running"]);
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.timers().length, 0);
  const settledState = (name: string) => {
    const handle = session.snapshot.frames[0]!.bindings.find(
      (binding) => binding.name === name,
    )?.value;
    assert.ok(typeof handle === "object" && handle?.kind === "timerHandle");
    return session.snapshot.settledTimers.find((timer) => timer.timerId === handle.timerId)?.state;
  };
  assert.deepEqual([settledState("now"), settledState("later")], ["finished", "stopped"]);
  assert.equal(session.snapshot.settledTimers.length, 2);
});

test("an expiry block interrupting a function keeps caller scopes, loops, and temporaries", () => {
  const session = new Session(
    [
      "let log = []",
      'let t = timer(duration: 1, async: true, repeat: true) { log.add("tick") }',
      "function work(n) {",
      "  let total = 0",
      "  for i in 0..n {",
      "    wait 2",
      "    total += i",
      "  }",
      "  return total",
      "}",
      'say "total ${work(3) + 1} ticks ${log.length}"',
      "exit",
    ].join("\n"),
  );
  for (let now = 1_000; now <= 6_000; now += 1_000) session.at(now);
  assert.deepEqual(session.said(), ["total 4 ticks 6"]);
});

test("paced output from an expiry block does not break the restored prompt or wait", () => {
  const ask = new Session(
    [
      'let t = timer async 2 { say "Think faster, please." }',
      'let name = askText "Name?"',
      'say "Hello ${name}"',
      "exit",
    ].join("\n"),
    { pacing: true },
  );
  ask.at(2_000);
  assert.equal(ask.snapshot.foregroundAction?.kind, "interaction");
  assert.equal(ask.answer("Bo"), "completed");
  assert.deepEqual(ask.said(), ["Think faster, please.", "Hello Bo"]);

  const wait = new Session(
    [
      'say "Hello there"',
      'let t = timer async 2 { say "interrupt one two" }',
      "wait 3",
      'say "after"',
      "exit",
    ].join("\n"),
    { pacing: true },
  );
  for (const now of [2_000, 3_000, 4_000, 8_000, 20_000]) wait.at(now);
  assert.deepEqual(wait.said(), ["Hello there", "interrupt one two", "after"]);
});

test("async timers and interrupts resume identically from every checkpoint boundary", () => {
  assertRuntimeResumeEquivalent(
    [
      "let log = []",
      'let t = timer(duration: 1..=2, async: true, repeat: true, label: "beat") {',
      "  log.add(t.elapsed)",
      "  if log.length == 3 {",
      "    t.pause()",
      "  }",
      "}",
      'let u = timer async mystery 2 { say "u ${t.state}" }',
      "function pause(n) {",
      "  wait n",
      "  return n",
      "}",
      "repeat 2 {",
      '  say "waited ${pause(3)}"',
      "}",
      "t.resume()",
      "t.remaining = 0 s",
      "timer 1",
      'say "done ${log.length} ${t.elapsed}"',
      "exit",
    ].join("\n"),
    { scenarioName: "async timer equivalence" },
  );
  // A queued block held behind pacing, and a repeat expiring while its own block waits.
  assertRuntimeResumeEquivalent(
    'timer async 1 { say "handler", 0 }\nsay "one", 2\nsay "two", 1\nwait 10\nexit',
    { scenarioName: "block behind pacing", instructionGuard: 200 },
  );
  assertRuntimeResumeEquivalent(
    "let n = 0\nlet t = timer(duration: 1, async: true, repeat: true) { n += 1\nwait 2\nif n == 2 { t.stop() } }\nwait 10\nexit",
    { scenarioName: "repeat behind a waiting block", instructionGuard: 200 },
  );
});

test("timer actions cannot be completed by the Player", () => {
  const session = new Session("let t = timer async 5\nwait 10\nexit");
  const timer = session.timers()[0]!;
  const result = completeAction(session.plan, session.snapshot, {
    actionId: timer.actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: 6_000 },
  });
  assert.equal(result.outcome.kind, "invalidPayload");
  assert.deepEqual(result.snapshot, session.snapshot);
});

test("malformed restored timer, handle, queue, and interrupt data is rejected", () => {
  const session = new Session(
    ["let t = timer async 2 {", "  wait 5", "}", 'let name = askText "Name?"', "exit"].join("\n"),
  );
  session.at(2_000);
  const json = serializeCheckpoint(createCheckpoint(session.plan, session.snapshot));
  const frame = ["snapshot", "callFrames", 0];
  const cases: ReadonlyArray<readonly [JsonPath, Json]> = [
    [["snapshot", "nextTimerId"], 5],
    [["snapshot", "settledTimers", 0, "state"], "running"],
    [["snapshot", "settledTimers", 0, "elapsedMs"], -1],
    [["snapshot", "frames", 0, "bindings", 0, "value"], { kind: "timerHandle", timerId: 9 }],
    [
      ["snapshot", "pendingTimerHandlers", "push"],
      { timerId: 1, handlerFunctionId: 1, dueAtMs: 99_999, count: 1 },
    ],
    [
      ["snapshot", "pendingTimerHandlers", "push"],
      { timerId: 1, handlerFunctionId: null, dueAtMs: 2_000, count: 1 },
    ],
    [[...frame, "timerInterruption", "suspendedAction", "scopeDepth"], 7],
    [[...frame, "timerInterruption", "timerId"], 999],
    [[...frame, "destinationTemporary"], 1],
    [[...frame, "timerInterruption"], null],
  ];
  for (const [path, value] of cases) assertForgedRejected(json, path, value);

  const running = new Session("let t = timer async 5\nwait 10\nexit");
  const runningJson = serializeCheckpoint(createCheckpoint(running.plan, running.snapshot));
  const timerIndex = running.snapshot.backgroundActions.findIndex(
    (action) => action.kind === "timer",
  );
  const action = ["snapshot", "backgroundActions", timerIndex];
  const owner = running.timers()[0]!.owningInstruction;
  const timerCases: ReadonlyArray<readonly [JsonPath, Json]> = [
    [[...action, "timer", "deadlineMs"], 0],
    [[...action, "timer", "state"], "paused"],
    [[...action, "timer", "display"], "loud"],
    [[...action, "timer", "handlerFunctionId"], 1],
    [[...action, "owningInstruction"], owner + 1],
    [[...action, "extra"], true],
  ];
  for (const [path, value] of timerCases) assertForgedRejected(runningJson, path, value);

  // Background work is canonical state in creation order, so a reordered list of valid entries is malformed.
  const pair = new Session("let a = timer async 5\nlet b = timer async 6\nwait 10\nexit");
  const pairJson = serializeCheckpoint(createCheckpoint(pair.plan, pair.snapshot));
  // EVIDENCE: fixture: checkpoint serialization produces plain JSON data.
  const pairActions = child(child(JSON.parse(pairJson) as Json, "snapshot"), "backgroundActions");
  assert.ok(Array.isArray(pairActions));
  assertForgedRejected(pairJson, ["snapshot", "backgroundActions"], [...pairActions].reverse());
});

test("repeat overrides, nested and interrupting expiry blocks, and stops stay checkpointable and ordered", () => {
  const overrideSeed = 0x8765_4321;
  const override = new Session(
    "let t = timer(duration: 1..=3, async: true, repeat: true)\nt.repeatDuration = 2 s\nwait 8 s\nexit",
    { seed: overrideSeed },
  );
  // Only the first round comes from the range; every later round lasts the assigned 2 s without a draw.
  const initialRng = structuredClone(override.snapshot.rng);
  const firstExpiryMs = override.timers()[0]!.timer.deadlineMs;
  assert.ok(
    firstExpiryMs === 1_000 || firstExpiryMs === 3_000,
    "the seed's first round must be in 1..=3 s and differ from the assigned 2 s",
  );
  for (let expiryMs = firstExpiryMs; expiryMs < 8_000; expiryMs += 2_000) {
    override.at(expiryMs);
    const { timer } = override.timers()[0]!;
    assert.deepEqual([timer.roundDurationMs, timer.deadlineMs], [2_000, expiryMs + 2_000]);
    assert.deepEqual(override.snapshot.rng, initialRng);
  }
  override.at(8_000);
  assert.equal(override.snapshot.status, "halted");
  assert.deepEqual(override.snapshot.rng, initialRng);

  const rootEnd = new Session(
    'timer async 1 s {\n  timer async 0 ms { say "nested" }\n  wait 1 s\n}\nwait 2 s\nexit',
  );
  rootEnd.at(1_000).at(2_000);
  assert.deepEqual(rootEnd.said(), ["nested"]);
  assert.equal(rootEnd.snapshot.status, "halted");

  const depthPlan = plan(
    'function f {\n  wait 2 s\n  return 1\n}\ntimer async 1 s { say "interrupt" }\nlet x = f()\nsay "x ${x}"\nexit',
  );
  const depthStart = run(
    depthPlan,
    createImmediatePacingRuntimeSnapshot(depthPlan, { maxCallDepth: 1 }),
  );
  const depthObserved = observeTime(depthPlan, depthStart.snapshot, 3_000);
  const depthEnd = run(depthPlan, depthObserved.snapshot);
  const depth = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(depthPlan, depthEnd.snapshot)),
  ).snapshot;
  assert.equal(depth.status, "halted");
  // The expiry block interrupts the wait inside f, which then returns 1.
  assert.deepEqual(
    [...depthStart.events, ...depthObserved.events, ...depthEnd.events].flatMap((event) =>
      event.kind === "say" ? [event.text] : [],
    ),
    ["interrupt", "x 1"],
  );

  const huge = new Session(
    "let t = timer async 1 s\nt.remaining = 10000000000000000000 h\nwait 1 s\nexit",
  );
  assert.equal(huge.snapshot.failure?.code, "TSR050");

  const deferred = new Session('timer async 1 s { say "interrupt" }\nwait 2 s\nexit');
  const delay = deferred.snapshot.foregroundAction!;
  const interrupted = observeTime(deferred.plan, deferred.snapshot, 2_000);
  assert.equal(interrupted.snapshot.currentSessionTimeMs, 1_000, "the earlier block runs first");
  assert.equal(interrupted.snapshot.foregroundAction?.actionId, delay.actionId);
  deferred.at(2_000);
  assert.deepEqual(deferred.said(), ["interrupt"]);
  assert.equal(deferred.snapshot.status, "halted");

  const stopSource =
    'let second = timer async 2 s { say "second" }\nlet first = timer async 1 s { second.stop() }\nwait 3 s\nexit';
  const stopped = new Session(stopSource);
  stopped.at(3_000);
  assert.deepEqual(stopped.said(), [], "a block that ran first can still stop a later timer");
  const [second, first, wait] = requestedActions(stopped.events);
  assert.deepEqual([second?.kind, first?.kind, wait?.kind], ["timer", "timer", "delay"]);
  // `first` expires naturally at 1 s and its block stops `second` then, before its 2-s deadline.
  const stopSettlements = [
    [first!.actionId, "finished", 1_000],
    [second!.actionId, "stopped", 1_000],
    [wait!.actionId, "completed", 3_000],
  ];
  assert.deepEqual(timedSettlements(stopped.events), stopSettlements);
  assert.equal(stopped.snapshot.status, "halted");

  const observedTwice = new Session(stopSource);
  const onceObserved = observeTime(observedTwice.plan, observedTwice.snapshot, 1_000);
  const twiceObserved = observeTime(observedTwice.plan, onceObserved.snapshot, 3_000);
  const twiceRun = run(observedTwice.plan, twiceObserved.snapshot);
  assert.ok(
    twiceRun.events.every((event) => event.kind !== "say"),
    "a queued block runs before later due work even across repeated observations",
  );
  const twiceEvents = [
    ...observedTwice.events,
    ...onceObserved.events,
    ...twiceObserved.events,
    ...twiceRun.events,
  ];
  assert.deepEqual(timedSettlements(twiceEvents), stopSettlements);
  const onTime = new Session(stopSource).at(1_000).at(3_000);
  assert.deepEqual(twiceEvents, onTime.events);
  assert.deepEqual(twiceRun.snapshot, onTime.snapshot);
});

test("a late observation across 10^12 silent fixed rounds ends with on-time elapsed and remaining", () => {
  // A scoped regression oracle for catch-up that does not expire silent rounds one at a time (docs/RUNTIME.md): that
  // path cannot reach this horizon within the bound. The values follow from the anchor formula.
  const late = new Session(
    'let t = timer(duration: 1 ms, async: true, repeat: true)\nwait 1000000000 s\nsay "${t.elapsed == 1000000000 s} ${t.remaining == 1 ms}"\nexit',
  ).atBounded(1e12);
  // The round ending with the wait settles first by action ID, so the next 1-ms round has just started.
  assert.deepEqual(late.said(), ["true true"]);
  assert.equal(late.snapshot.status, "halted");
});

test("pausing an overdue round stays paused, and restore rejects forged expiry invocations and start times", () => {
  const paused = new Session(
    "let t = timer(duration: 1, async: true, repeat: true) { t.pause() }\nwait 10\nexit",
  ).at(3_000);
  const pausedTimer = paused.timers()[0]!.timer;
  assert.equal(pausedTimer.state, "paused", "pausing an overdue round ends it and stays paused");
  assert.equal(pausedTimer.remainingMs, 1_000);

  const oneShot = new Session(
    'let hits = 0\ntimer async 1 { hits += 1 }\nwait 2\nsay "hits ${hits}"\nexit',
  );
  const queued = serializeCheckpoint(
    createCheckpoint(oneShot.plan, observeTime(oneShot.plan, oneShot.snapshot, 1_000).snapshot),
  );
  assertForgedRejected(queued, ["snapshot", "pendingTimerHandlers", 0, "count"], 2);
  // EVIDENCE: fixture: checkpoint serialization produces plain JSON data.
  const entry = child(
    child(child(JSON.parse(queued) as Json, "snapshot"), "pendingTimerHandlers"),
    0,
  );
  assertForgedRejected(queued, ["snapshot", "pendingTimerHandlers", "push"], entry);

  const created = new Session('wait 1\nlet t = timer async 2\nwait 3\nsay "${t.elapsed}"\nexit').at(
    1_000,
  );
  const running = serializeCheckpoint(createCheckpoint(created.plan, created.snapshot));
  assertForgedRejected(running, ["snapshot", "backgroundActions", 0, "timer", "runningSinceMs"], 0);
});

test("restore rejects impossible timer chronology and a repeated one-shot expiry", () => {
  const oneShot = new Session(
    'let hits = 0\nlet t = timer async 1 { hits += 1 }\nwait 2\nsay "hits ${hits}"\nexit',
  );
  const waiting = serializeCheckpoint(createCheckpoint(oneShot.plan, oneShot.snapshot));
  const timer = oneShot.timers()[0]!.timer;
  assertForgedRejected(waiting, ["snapshot", "pendingTimerHandlers", "push"], {
    timerId: timer.timerId,
    handlerFunctionId: timer.handlerFunctionId,
    dueAtMs: 0,
    count: 1,
  });

  const running = new Session("wait 1\nlet t = timer async 2\nwait 3\nexit").at(1_000);
  const runningJson = serializeCheckpoint(createCheckpoint(running.plan, running.snapshot));
  const path = ["snapshot", "backgroundActions", 0, "timer"] as const;
  assertForgedRejected(runningJson, [...path, "deadlineMs"], 500);
  assertForgedRejected(runningJson, [...path, "elapsedMs"], 10);

  const paused = new Session("let t = timer async 5\nt.pause()\nwait 1\nexit");
  const pausedJson = serializeCheckpoint(createCheckpoint(paused.plan, paused.snapshot));
  assertForgedRejected(pausedJson, [...path, "elapsedMs"], 10_000);

  const stopped = new Session("let t = timer async 5\nt.stop()\nwait 1\nexit");
  const stoppedJson = serializeCheckpoint(createCheckpoint(stopped.plan, stopped.snapshot));
  assertForgedRejected(stoppedJson, ["snapshot", "settledTimers", 0, "elapsedMs"], 10_000);
});

test("late observations run expiry blocks at their due scene time, like on-time observations", () => {
  const said = (source: string, observations: readonly number[]): string[] => {
    const session = new Session(source);
    for (const nowMs of observations) session.at(nowMs);
    return session.said();
  };
  const cases: readonly (readonly [string, readonly number[], readonly string[]])[] = [
    [
      'timer async 1 { timer async 0 { say "nested" } }\ntimer async 2 { say "second" }\nwait 10\nexit',
      [1_000, 2_000, 3_000],
      ["nested", "second"],
    ],
    [
      'timer async 1 {\n  timer async 0 { say "nested" }\n  wait 1\n}\ntimer async 3 { say "second" }\nwait 10\nexit',
      [1_000, 2_000, 3_000, 4_000],
      ["nested", "second"],
    ],
    [
      'let t = timer(duration: 1, async: true, repeat: true)\ntimer async 2 { t.repeatDuration = 10 s }\nwait 5\nsay "${t.remaining} ${t.elapsed}"\nexit',
      [1_000, 2_000, 3_000, 5_000],
      ["8 s 5 s"],
    ],
    [
      'let t = timer async 3 { say "too late" }\ntimer async 1 {\n  wait 1\n  t.stop()\n}\nwait 10\nexit',
      [1_000, 2_000, 3_000, 5_000],
      [],
    ],
  ];
  for (const [source, onTime, expected] of cases) {
    assert.deepEqual(said(source, onTime), expected, source);
    assert.deepEqual(said(source, [onTime.at(-1)!]), expected, `late: ${source}`);
  }
  // Scene-time replay makes the complete result independent of observation cadence, not only the output.
  const scripts = [
    ...cases.map(([source]) => source),
    'say "a"\nwait 1\nlet t = timer async 2 { say "block" }\nwait 3\nsay "b"\nt.stop()\nwait 1\nexit',
  ];
  for (const source of scripts) {
    const onTime = new Session(source, { pacing: true });
    for (let nowMs = 250; nowMs <= 12_000; nowMs += 250) onTime.at(nowMs);
    const late = new Session(source, { pacing: true }).at(12_000);
    assert.deepEqual(late.events, onTime.events, `events: ${source}`);
    assert.deepEqual(late.snapshot, onTime.snapshot, `snapshot: ${source}`);
  }
});

test("late observations replay the script at scene time and reject an unexplained observed-time lead", () => {
  const late = new Session('wait 1\nsay "done"\nwait 1\nsay "later"\nexit').at(5_000);
  const delays = late.events.flatMap((event) =>
    event.kind === "actionCompleted" && event.settlement.actionKind === "delay"
      ? [event.settlement.completedAtMs]
      : [],
  );
  assert.deepEqual(delays, [1_000, 2_000], "every delay settles at its deadline");
  assert.deepEqual(late.said(), ["done", "later"]);
  const onTime = new Session('wait 1\nsay "done"\nwait 1\nsay "later"\nexit');
  for (const nowMs of [1_000, 2_000, 5_000]) onTime.at(nowMs);
  assert.deepEqual(late.snapshot, onTime.snapshot);

  const waiting = new Session('wait 1\nsay "done"\nexit');
  const json = serializeCheckpoint(createCheckpoint(waiting.plan, waiting.snapshot));
  assertForgedRejected(json, ["snapshot", "observedSessionTimeMs"], 5_000);

  // Observed but not yet replayed: the script is runnable at the delay deadline behind the horizon.
  const held = observeTime(waiting.plan, waiting.snapshot, 5_000).snapshot;
  assert.equal(held.status, "running");
  assert.equal(held.currentSessionTimeMs, 1_000);
  assert.equal(held.observedSessionTimeMs, 5_000);
  const heldJson = serializeCheckpoint(createCheckpoint(waiting.plan, held));
  assert.deepEqual(deserializeCheckpoint(heldJson).snapshot, held);
  assertForgedRejected(heldJson, ["snapshot", "lastSettlement", "completedAtMs"], 3_000);
  assertForgedRejected(heldJson, ["snapshot", "currentSessionTimeMs"], 6_000);
});

test("catch-up holds for a queued block behind a commit window and timer settlements record scene time", () => {
  const source =
    'let t = timer async 3 { say "too late", 0 }\ntimer async 1 { t.stop() }\nsay "first", 2\nsay "second", 1\nlet name = askText "Hold"\nexit';
  const onTime = new Session(source, { pacing: true });
  for (const nowMs of [1_000, 2_000, 3_000, 5_000]) onTime.at(nowMs);
  const late = new Session(source, { pacing: true }).at(5_000);
  assert.deepEqual(onTime.said(), ["first", "second"]);
  assert.deepEqual(late.said(), onTime.said());

  const asking = new Session(
    'timer async 1 { say "handler" }\nlet name = askText "Name?"\nsay name\nexit',
  );
  const observed = observeTime(asking.plan, asking.snapshot, 5_000).snapshot;
  const answer = (snapshot: RuntimeSnapshot, actionId: number, text: string) =>
    completeAction(asking.plan, snapshot, {
      actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: text },
    });
  const questionId = observed.foregroundAction!.actionId;
  const early = answer(observed, questionId, "ok");
  assert.equal(early.outcome.kind, "executionPending", "the due block runs before input");
  assert.deepEqual(early.snapshot, observed);
  assert.deepEqual(early.events, []);
  const caughtUp = run(asking.plan, observed);
  assert.equal(caughtUp.snapshot.currentSessionTimeMs, 5_000);
  const completed = answer(caughtUp.snapshot, questionId, "ok");
  assert.equal(completed.outcome.kind, "completed");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(asking.plan, completed.snapshot)),
  ).snapshot;
  assert.deepEqual(
    [...caughtUp.events, ...run(asking.plan, restored).events].flatMap((event) =>
      event.kind === "say" ? [event.text] : [],
    ),
    ["handler", "ok"],
  );

  const silent = new Session("timer async 1\nwait 10\nexit").at(5_000);
  const settled = silent.events.find(
    (event) => event.kind === "actionCompleted" && event.settlement.actionKind === "timer",
  );
  assert.ok(settled?.kind === "actionCompleted" && settled.settlement.actionKind === "timer");
  assert.equal(settled.settlement.completedAtMs, 1_000);
});

test("pacing consumed or skipped during catch-up and terminal completions keep queued blocks valid", () => {
  const paced = new Session('timer async 1 { say "handler", 2 }\nlet name = askText "Name"\nexit', {
    pacing: true,
  }).at(5_000);
  assert.deepEqual(paced.said(), ["handler"]);
  assert.equal(paced.snapshot.lastSettlement?.settlementKind, "consumedByForegroundInteraction");

  const superseded = new Session(
    'timer async 1 { say "first", 2 }\ntimer async 3 { say "second", 0 }\nwait 10\nexit',
    { pacing: true },
  ).at(5_000);
  assert.deepEqual(superseded.said(), ["first", "second"]);

  const skipping = new Session(
    'timer async 1 { say "handler", 0 }\nsay "first", 2\nwait 10\nexit',
    { pacing: true },
  );
  const held = observeTime(skipping.plan, skipping.snapshot, 5_000).snapshot;
  const gate = held.backgroundActions.find((action) => action.kind === "chatPacingGate");
  assert.ok(gate !== undefined);
  const skipped = completeAction(skipping.plan, held, {
    actionId: gate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(skipped.outcome.kind, "executionPending");
  assert.deepEqual(skipped.snapshot, held);

  const button = new Session('timer async 1 { say "handler", 0 }\nshowButton "Continue"\nexit');
  const due = observeTime(button.plan, button.snapshot, 5_000).snapshot;
  const buttonId = due.foregroundAction!.actionId;
  const press = (snapshot: RuntimeSnapshot) =>
    completeAction(button.plan, snapshot, {
      actionId: buttonId,
      actionKind: "interaction",
      interactionKind: "button",
      payload: { kind: "activate" },
    });
  assert.equal(press(due).outcome.kind, "executionPending");
  const handled = run(button.plan, due);
  assert.deepEqual(
    handled.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["handler"],
  );
  const pressed = press(handled.snapshot);
  assert.equal(pressed.outcome.kind, "completed");
  const ended = run(button.plan, pressed.snapshot);
  assert.equal(ended.snapshot.status, "halted");
});

test("work due exactly at the observed time settles once execution waits or ends", () => {
  const cases: readonly (readonly [string, readonly number[]])[] = [
    // A block's pacing is due when the script ends at the same deadline.
    ['timer async 1 { say "block", 1 }\nwait 2\nexit', [1_000, 2_000]],
    // A nested timer is due when the script resumes and waits again at the same deadline.
    [
      'timer async 0.5 { timer async 0.5 { say "nested", instant } }\nwait 1\nwait 1\nsay "main", instant\nexit',
      [500, 1_000, 2_000],
    ],
    [
      'timer async 0.5 { timer async 0.5 { say "nested", instant } }\nwait 1\nshowButton "Go"\nexit',
      [500, 1_000],
    ],
    // A waiting block with another timer due at its wait's deadline.
    [
      'timer async 1 { wait 1 }\ntimer async 2 { say "second", instant }\nwait 5\nexit',
      [1_000, 2_000, 5_000],
    ],
  ];
  for (const [source, onTimeSchedule] of cases) {
    const horizon = onTimeSchedule.at(-1)!;
    // Session round-trips a checkpoint after every operation, so an invalid state fails here.
    const exact = new Session(source, { pacing: true });
    for (const nowMs of onTimeSchedule) exact.at(nowMs);
    const late = new Session(source, { pacing: true }).at(horizon);
    assert.deepEqual(late.events, exact.events, source);
    assert.deepEqual(late.snapshot, exact.snapshot, source);
    assert.equal(
      playerRuntimeDeadlinesDue(exact.snapshot),
      false,
      `nothing due at the horizon remains: ${source}`,
    );
  }
});

test("a failed session accepts no host input and schedules no further observation", () => {
  const failed = new Session('say "first", 10\nlet zero = 0\nlet x = 1 / zero\nexit', {
    pacing: true,
  });
  assert.equal(failed.snapshot.status, "failed");
  const observed = observeTime(failed.plan, failed.snapshot, 5_000).snapshot;
  const gate = observed.backgroundActions.find((action) => action.kind === "chatPacingGate");
  assert.ok(gate !== undefined);
  const skipped = completeAction(failed.plan, observed, {
    actionId: gate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(skipped.outcome.kind, "invalidPayload");
  assert.deepEqual(skipped.snapshot, observed);
  assert.deepEqual(playerRuntimeDeadlines(observed), []);
  assert.equal(activePlayerRuntimePacingGate(observed), null);
});

test("host input waits for scene-time catch-up and for an expiry block due at the same time", () => {
  // An answer at 5 s must not continue the script at the 1 s scene time of a queued block.
  const late = new Session(
    'let answer = "old"\ntimer async 1 { say answer, instant }\nanswer = askText "Name?"\nwait 1\nshowButton "Done"\nexit',
  );
  const lateObserved = observeTime(late.plan, late.snapshot, 5_000).snapshot;
  const lateId = lateObserved.foregroundAction!.actionId;
  const lateRequest = {
    actionId: lateId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "new" },
  };
  assert.equal(
    completeAction(late.plan, lateObserved, lateRequest).outcome.kind,
    "executionPending",
  );
  const lateRun = run(late.plan, lateObserved).snapshot;
  const answered = completeAction(late.plan, lateRun, lateRequest);
  assert.equal(answered.outcome.kind, "completed");
  const waiting = run(late.plan, answered.snapshot).snapshot;
  assert.equal(waiting.foregroundAction?.kind, "delay");
  assert.equal(
    waiting.foregroundAction?.kind === "delay" ? waiting.foregroundAction.deadlineMs : null,
    6_000,
  );

  // At equal time the due block still runs first, and its exit cancels the question.
  const exiting = new Session(
    'timer async 1 s { exit }\nlet answer = askText "Your answer"\nsay answer\nexit',
  );
  const equal = observeTime(exiting.plan, exiting.snapshot, 1_000).snapshot;
  assert.equal(equal.currentSessionTimeMs, equal.observedSessionTimeMs);
  const questionId = equal.foregroundAction!.actionId;
  const request = {
    actionId: questionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "too late" },
  };
  const pending = completeAction(exiting.plan, equal, request);
  assert.equal(pending.outcome.kind, "executionPending");
  assert.deepEqual(pending.snapshot, equal);
  const exited = run(exiting.plan, equal).snapshot;
  assert.equal(exited.status, "halted");
  assert.equal(completeAction(exiting.plan, exited, request).outcome.kind, "staleAction");
});

test("late fractional rounds match on time, tiny rounds end normally, zero remaining finishes, and a zero-based repeat range fails", () => {
  // Observes every timer deadline up to the horizon, as a Player that is never late would.
  const onTime = (source: string, horizonMs: number): Session => {
    const session = new Session(source);
    for (let guard = 0; session.snapshot.observedSessionTimeMs < horizonMs; guard += 1) {
      assert.ok(guard < 100, "on-time schedule must reach the horizon");
      const deadlines = session
        .timers()
        .map((action) => action.timer.deadlineMs)
        .filter((deadline): deadline is number => deadline !== null);
      session.at(Math.min(horizonMs, ...deadlines));
    }
    return session;
  };
  const fractional =
    'let t = timer(duration: 0.1 ms, async: true, repeat: true)\ntimer async 1 ms {\n  if t.remaining > 0.1 ms { say "long", 0 }\n  else { say "short", 0 }\n}\nwait 10 ms\nexit';
  const timely = onTime(fractional, 1);
  const late = new Session(fractional).at(1);
  assert.deepEqual(late.said(), timely.said());
  assert.deepEqual(late.timers()[0]!.timer, timely.timers()[0]!.timer);

  // Thousands of trillions of silent rounds end before 1 ms.
  const tiny = new Session(
    "timer(duration: 1e-16 ms, async: true, repeat: true)\nwait 1 ms\nexit",
  ).atBounded(1);
  assert.equal(tiny.snapshot.foregroundAction, null);
  // A failure would also clear the foreground action; the session must end normally.
  assert.equal(tiny.snapshot.status, "halted");
  assert.equal(tiny.snapshot.failure, null);
  assert.ok(tiny.events.every((event) => event.kind !== "runtimeFailure"));

  const adjusted = new Session(
    "wait 0.1 ms\nlet t = timer async 0.2 ms\nt.remaining = 0 ms\nwait 1 ms\nexit",
  ).at(0.1);
  assert.equal(adjusted.snapshot.status, "waiting");
  const [issued] = requestedActions(adjusted.events).filter((action) => action.kind === "timer");
  assert.ok(issued);
  // Setting remaining to zero expires the one-shot timer at once.
  assert.deepEqual(
    adjusted.snapshot.settledTimers.map((timer) => [timer.timerId, timer.state]),
    [[issued.timer.timerId, "finished"]],
  );
  assert.ok(adjusted.snapshot.settledTimers.every((timer) => timer.roundDurationMs >= 0));

  const range = plan("let n = 0\ntimer(duration: n..2, async: true, repeat: true)\nwait 10\nexit");
  const fresh = createImmediatePacingRuntimeSnapshot(range, { seed: 0x1234_5678 });
  const failed = run(range, fresh).snapshot;
  assert.equal(failed.failure?.code, "TSR050");
  assert.deepEqual(failed.rng, fresh.rng, "an invalid range fails before its round is drawn");
});

test("restore rejects contradictory rounds and early expiries, and a full expiry count loses none", () => {
  const path = ["snapshot", "backgroundActions", 0, "timer"] as const;
  const paused = new Session("let t = timer async 5\nt.pause()\nwait 10\nexit");
  const pausedJson = serializeCheckpoint(createCheckpoint(paused.plan, paused.snapshot));
  assertForgedRejected(pausedJson, [...path, "roundDurationMs"], 0);
  assertForgedRejected(pausedJson, [...path, "roundDurationMs"], 10_000);
  const running = new Session("let t = timer async 5\nwait 10\nexit");
  const runningJson = serializeCheckpoint(createCheckpoint(running.plan, running.snapshot));
  assertForgedRejected(runningJson, [...path, "roundDurationMs"], 0);
  const anchored = new Session(
    "let t = timer(duration: 1, async: true, repeat: true)\nwait 10\nexit",
  ).at(2_500);
  const anchoredJson = serializeCheckpoint(createCheckpoint(anchored.plan, anchored.snapshot));
  assertForgedRejected(anchoredJson, [...path, "deadlineMs"], 3_500);
  assertForgedRejected(anchoredJson, [...path, "anchoredRounds"], 5);

  const born = new Session(
    'wait 1\nlet t = timer(duration: 1, async: true, repeat: true) { say "expired", 0 }\nwait 10\nexit',
  ).at(1_000);
  const bornJson = serializeCheckpoint(createCheckpoint(born.plan, born.snapshot));
  assertForgedRejected(bornJson, ["snapshot", "pendingTimerHandlers", "push"], {
    timerId: 1,
    handlerFunctionId: born.timers()[0]!.timer.handlerFunctionId,
    dueAtMs: 0,
    count: 1,
  });

  const counted = new Session(
    "let t = timer(duration: 1, async: true, repeat: true) { wait 100 }\nwait 1000\nexit",
  )
    .at(1_000)
    .at(2_000);
  assert.equal(counted.snapshot.pendingTimerHandlers.length, 1);
  // EVIDENCE: fixture: checkpoint serialization produces plain JSON data with this queue shape.
  const full = JSON.parse(
    serializeCheckpoint(createCheckpoint(counted.plan, counted.snapshot)),
  ) as { snapshot: { pendingTimerHandlers: { count: number }[] } };
  full.snapshot.pendingTimerHandlers[0]!.count = Number.MAX_SAFE_INTEGER;
  counted.snapshot = deserializeCheckpoint(JSON.stringify(full)).snapshot;
  counted.at(3_000);
  // How the queue splits a full count is not a rule; the session must not fail, every checkpoint round-trips (so each
  // count stays a safe integer), and no expiry is lost.
  assert.equal(counted.snapshot.failure, null);
  assert.equal(
    counted.snapshot.pendingTimerHandlers.reduce((total, entry) => total + BigInt(entry.count), 0n),
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    "a full aggregate count loses no expiry",
  );
});

test("skipped rounds keep tie order, termination, and restorable rounds", () => {
  const onTime = (source: string, horizonMs: number, initialSessionTimeMs = 0): Session => {
    const session = new Session(source, { initialSessionTimeMs });
    for (let guard = 0; session.snapshot.observedSessionTimeMs < horizonMs; guard += 1) {
      assert.ok(guard < 100, "on-time schedule must reach the horizon");
      const deadlines = session
        .timers()
        .map((action) => action.timer.deadlineMs)
        .filter((deadline): deadline is number => deadline !== null);
      session.at(Math.min(horizonMs, ...deadlines));
    }
    return session;
  };
  const tie =
    'timer async 1 ms {\n  if t.remaining == 0 ms { say "due", 0 }\n  else { say "next round", 0 }\n}\nlet t = timer(duration: 0.1 ms, async: true, repeat: true)\nwait 10 ms\nexit';
  assert.deepEqual(onTime(tie, 1).said(), ["due"]);
  assert.deepEqual(new Session(tie).at(1).said(), ["due"], "a lower action ID runs first at a tie");

  const origin = Number.MAX_SAFE_INTEGER - 4;
  const terminal =
    'let t = timer(duration: 1 ms, async: true, repeat: true)\ntimer async 0 ms { wait 4 ms }\nlet answer = askText "Hold"\nexit';
  const timely = onTime(terminal, Number.MAX_SAFE_INTEGER, origin);
  const late = new Session(terminal, { initialSessionTimeMs: origin }).at(Number.MAX_SAFE_INTEGER);
  const finished = (session: Session) =>
    session.events.filter(
      (event) => event.kind === "actionCompleted" && event.settlement.actionKind === "timer",
    );
  assert.deepEqual(finished(late), finished(timely));

  const paused = new Session("wait 1\nlet t = timer async 0.1 ms\nt.pause()\nwait 1\nexit").at(
    1_000,
  );
  assert.equal(
    paused.timers()[0]!.timer.state,
    "paused",
    "a rounded paused record stays restorable",
  );
  const large = new Session("let t = timer async 0.3 ms\nt.pause()\nwait 1\nexit", {
    initialSessionTimeMs: 1e12,
  });
  assert.equal(large.timers()[0]!.timer.state, "paused");

  const anchored = new Session(
    "let t = timer(duration: 5, async: true, repeat: true)\nwait 20\nexit",
  );
  const json = serializeCheckpoint(createCheckpoint(anchored.plan, anchored.snapshot));
  // EVIDENCE: fixture: checkpoint serialization produces plain JSON data.
  const forgedRounds = JSON.parse(json) as {
    snapshot: { backgroundActions: { timer: { anchoredRounds: number; deadlineMs: number } }[] };
  };
  forgedRounds.snapshot.backgroundActions[0]!.timer.anchoredRounds = 1;
  forgedRounds.snapshot.backgroundActions[0]!.timer.deadlineMs = 10_000;
  assert.throws(
    () => deserializeCheckpoint(JSON.stringify(forgedRounds)),
    (error: unknown) => error instanceof CheckpointError,
    "completed anchored rounds must have ended",
  );
});

test("plateaued rounds terminate, a failed catch-up settles nothing further, and index exhaustion matches on time", () => {
  const plateau =
    "let t = timer(duration: 1 ms, async: true, repeat: true)\nt.repeatDuration = 1e-300 ms\nwait 2 ms\nexit";
  // From 1 ms on, every round deadline rounds to 1 ms until the round index is exhausted.
  const walked = new Session(plateau).atBounded(1).at(2);
  assert.equal(walked.snapshot.status, "halted");

  const failing = new Session(
    "let t = timer(duration: 1 ms, async: true, repeat: true) { return }\nt.repeatDuration = 1e-300 ms\nwait 2 ms\nexit",
  ).at(1);
  assert.equal(
    failing.snapshot.failure?.code,
    "TSR037",
    "handler catch-up exhausts the instruction budget",
  );
  const observed = observeTime(failing.plan, failing.snapshot, 5);
  assert.equal(observed.snapshot.currentSessionTimeMs, failing.snapshot.currentSessionTimeMs);
  assert.equal(observed.snapshot.observedSessionTimeMs, 5);
  assert.deepEqual(observed.events, [], "a failed session settles nothing further");

  // The last anchored round index ends both an on-time and a late schedule at the same point. The constants are a
  // regression oracle scoped to the current private index limit, zero-based `Number.MAX_SAFE_INTEGER - 2`: the last
  // 1e-16-ms round ends at (MAX_SAFE_INTEGER - 1) * 1e-16 ms = 0.900719925474099 ms, so the finished timer's elapsed
  // time stays at most that ("end"), and the on-time prefix stops a few rounds earlier. docs/RUNTIME.md documents the
  // late-versus-on-time equality and that an exhausted index finishes the timer, not the index value.
  const indexLimit =
    'let t = timer(duration: 1e-16 ms, async: true, repeat: true)\ntimer async 1 ms {\n  if t.elapsed > 0.900719925474099 ms { say "extra", 0 }\n  else { say "end", 0 }\n}\nwait 10 ms\nexit';
  const prefix = new Session(indexLimit).atBounded(0.9007199254740984);
  const late = new Session(indexLimit).atBounded(0.9007199254740984).at(1);
  for (let guard = 0; prefix.snapshot.observedSessionTimeMs < 1; guard += 1) {
    assert.ok(guard < 20, "the remaining rounds are few");
    const deadline = prefix.timers()[0]?.timer.deadlineMs ?? 1;
    prefix.at(Math.min(1, deadline));
  }
  assert.deepEqual(late.said(), ["end"]);
  assert.deepEqual(prefix.said(), late.said());
  assert.deepEqual(late.snapshot.settledTimers, prefix.snapshot.settledTimers);
});

test("restore rejects a non-string display, and a failed session keeps its pacing gate at scene time", () => {
  const session = new Session("let t = timer async 5\nwait 10\nexit");
  const json = serializeCheckpoint(createCheckpoint(session.plan, session.snapshot));
  assertForgedRejected(json, ["snapshot", "backgroundActions", 0, "timer", "display"], ["hidden"]);

  const failed = new Session(
    'timer async 1 ms { let n = 0\nlet x = 1 / n }\nsay "pacing", 0.001\nwait 2 ms\nexit',
    { pacing: true },
  ).at(1);
  assert.equal(failed.snapshot.status, "failed");
  const gate = failed.snapshot.backgroundActions.find((action) => action.kind === "chatPacingGate");
  assert.equal(
    gate?.kind === "chatPacingGate" && gate.deadlineMs,
    failed.snapshot.currentSessionTimeMs,
  );
  const observed = observeTime(failed.plan, failed.snapshot, 5);
  assert.deepEqual(observed.events, []);
  assert.equal(observed.snapshot.observedSessionTimeMs, 5);
  assert.equal(observed.snapshot.currentSessionTimeMs, failed.snapshot.currentSessionTimeMs);
});
