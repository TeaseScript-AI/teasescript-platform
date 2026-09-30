import assert from "node:assert/strict";
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
import { createFreshRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

/** Drives a session with explicit time observations and completions, round-tripping every checkpoint. */
class Session {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[] = [];

  constructor(source: string, options: { readonly pacing?: boolean; readonly seed?: number } = {}) {
    this.plan = plan(source);
    const seed = options.seed ?? 0x1234_5678;
    const fresh =
      options.pacing === true
        ? createFreshRuntimeSnapshot(this.plan, { seed })
        : createImmediatePacingRuntimeSnapshot(this.plan, { seed });
    this.snapshot = fresh;
    this.run();
  }

  run(): this {
    this.#restore();
    const result = run(this.plan, this.snapshot);
    this.events.push(...result.events);
    this.snapshot = result.snapshot;
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

  answer(text: string): string {
    this.#restore();
    const action = this.snapshot.foregroundAction;
    const actionId =
      action?.kind === "interaction"
        ? action.actionId
        : this.snapshot.callFrames.find((frame) => frame.timerInterruption?.suspendedAction)
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

function diagnostics(source: string): string[] {
  const result = compileSource(source);
  assert.equal(result.plan, null, `${JSON.stringify(source)} must not compile`);
  return result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`);
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
  assert.ok(compiled.functions.every((definition) => definition.timerHandler));
  assert.equal(compiled.functions.length, 2);
});

test("timer forms reject invalid positions, members, and handler scope", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["let t = timer 5", "TSV033 A blocking timer returns no handle"],
    ["timer 5 { exit }", "TSV033 Only an async timer may have an expiry block"],
    ["let t = timer async 5\nsay t.nope", "TSV034 Timer handles have no property 'nope'"],
    [
      "let t = timer async 5\nt.elapsed = 1 s",
      "TSV034 Timer handle property 'elapsed' cannot be assigned",
    ],
    ["let t = timer async 5\nt.restart()", "TSV034 Timer handles have no method 'restart'"],
    [
      'function f {\n  let local = 1\n  timer async 1 { say "${local}" }\n}',
      "TSV002 Unknown variable 'local'",
    ],
    [
      "timer async 1 { return 5 }",
      "TSV033 A timer expiry block may use 'return' only without a value.",
    ],
    [
      "timer(duration: 1, async: true, repeat: true)\ntimer(duration: 0, async: true, repeat: true)",
      "TSV011 A repeating timer duration must be greater than zero.",
    ],
    [
      'let d = "hidden"\ntimer(duration: 1, display: d)',
      "TSV033 A blocking timer needs a literal display",
    ],
    ["let t = timer async 5\n(t).bogus()", "TSV034 Timer handles have no method 'bogus'"],
    [
      "let t = timer async 5\nt.remaining = 1",
      "TSV034 Timer remaining must be assigned a duration",
    ],
    ["let t = timer async 5\nt.display = 1", "TSV034 Timer display must be"],
    ["let t = timer async 5\nt.pause(1)", "TSV034 Timer pause() takes no arguments."],
    ["timer 5..10 min", "TSV010 A timer range counts whole seconds"],
    [
      "timer(duration: 0..2, async: true, repeat: true)",
      "TSV010 A repeating timer range must start at one second or more.",
    ],
  ];
  for (const [source, expected] of cases) {
    const found = diagnostics(source);
    assert.ok(
      found.some((diagnostic) => diagnostic.startsWith(expected)),
      `${JSON.stringify(source)}: ${found.join(" | ")}`,
    );
  }
});

test("static handle hints do not leak from untaken or reassigned paths", () => {
  const compiled = compileSource(
    'let o = { x: 1 }\nif false {\n  o = timer async 1\n}\nsay "${o.x}"\nlet t = timer async 1\nt = { x: 2 }\nsay "${t.x}"',
  );
  assert.deepEqual(compiled.diagnostics, []);
});

test("a whole-second range may carry a trailing seconds unit", () => {
  const session = new Session("timer 5..10 s\nexit");
  const action = session.snapshot.foregroundAction;
  assert.ok(action?.kind === "delay");
  const seconds = (action.deadlineMs - action.createdAtMs) / 1_000;
  assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds < 10, String(seconds));
});

test("nested timers created by an expiry block leave the terminal wait valid", () => {
  const session = new Session("timer async 1 {\n  timer async 1\n}\nwait 3");
  session.at(1_000).at(3_000);
  assert.equal(session.snapshot.status, "halted");
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
    ].join("\n"),
  );
  session.at(3_000).at(4_000);
  assert.deepEqual(session.said(), ["paused 3 s", "4 s 4 s"]);
});

test("repeating ranges redraw each round from the session RNG, including during catch-up", () => {
  const source = [
    "let rounds = []",
    "let t = timer(duration: 1..=4, async: true, repeat: true) {",
    "  rounds.add(t.elapsed)",
    "}",
    "wait 30",
    'say "${rounds.length}"',
  ].join("\n");
  const late = new Session(source, { seed: 0x1234_5678 });
  late.at(30_000);
  const stepwise = new Session(source, { seed: 0x1234_5678 });
  for (let now = 500; now <= 30_000; now += 500) stepwise.at(now);
  assert.deepEqual(late.said(), stepwise.said());
  assert.ok(Number(late.said()[0]) >= 7, late.said()[0]);
  assert.deepEqual(late.snapshot.rng, stepwise.snapshot.rng);
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
    ].join("\n"),
  );
  session.at(5_000);
  assert.deepEqual(session.said(), ["Too slow."]);
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.events.at(-1)?.kind, "exit");
  const late = completeAction(session.plan, session.snapshot, {
    actionId: 2,
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
    ].join("\n"),
  );
  session.at(10_000);
  assert.deepEqual(session.said(), ["B start"]);
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
    ].join("\n"),
  );
  assert.deepEqual(session.said(), ["forced running"]);
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.timers().length, 0);
  assert.deepEqual(
    session.snapshot.settledTimers.map((timer) => timer.state),
    ["finished", "stopped"].reverse().sort(),
  );
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
    ].join("\n"),
    { scenarioName: "async timer equivalence" },
  );
});

test("timer actions cannot be completed by the Player", () => {
  const session = new Session("let t = timer async 5\nwait 10");
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
    ["let t = timer async 2 {", "  wait 5", "}", 'let name = askText "Name?"'].join("\n"),
  );
  session.at(2_000);
  const json = serializeCheckpoint(createCheckpoint(session.plan, session.snapshot));
  const mutations: Array<(snapshot: Record<string, any>) => void> = [
    (snapshot) => (snapshot.nextTimerId = 5),
    (snapshot) => (snapshot.settledTimers[0].state = "running"),
    (snapshot) => (snapshot.settledTimers[0].elapsedMs = -1),
    (snapshot) => (snapshot.frames[0].bindings[0].value = { kind: "timerHandle", timerId: 9 }),
    (snapshot) =>
      snapshot.pendingTimerHandlers.push({
        timerId: 1,
        handlerFunctionId: 1,
        dueAtMs: 99_999,
        count: 1,
      }),
    (snapshot) => (snapshot.callFrames[0].timerInterruption.suspendedAction.scopeDepth = 7),
    (snapshot) => (snapshot.callFrames[0].destinationTemporary = 1),
    (snapshot) => (snapshot.callFrames[0].timerInterruption = null),
  ];
  for (const mutate of mutations) {
    const candidate = JSON.parse(json);
    mutate(candidate.snapshot);
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(candidate)),
      (error: unknown) => error instanceof CheckpointError,
      mutate.toString(),
    );
  }

  const running = new Session("let t = timer async 5\nwait 10");
  const runningJson = serializeCheckpoint(createCheckpoint(running.plan, running.snapshot));
  const timerMutations: Array<(action: Record<string, any>) => void> = [
    (action) => (action.timer.deadlineMs = 0),
    (action) => (action.timer.state = "paused"),
    (action) => (action.timer.display = "loud"),
    (action) => (action.timer.handlerFunctionId = 1),
    (action) => (action.owningInstruction = action.owningInstruction + 1),
    (action) => (action.extra = true),
  ];
  for (const mutate of timerMutations) {
    const candidate = JSON.parse(runningJson);
    mutate(candidate.snapshot.backgroundActions.find((action: any) => action.kind === "timer"));
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(candidate)),
      (error: unknown) => error instanceof CheckpointError,
      mutate.toString(),
    );
  }
});

test("runtime review regressions stay checkpointable and ordered", () => {
  const override = new Session(
    "let t = timer(duration: 1..=3, async: true, repeat: true)\nt.repeatDuration = 2 s\nwait 5 s",
  );
  assert.equal(override.timers()[0]!.timer.range, null);
  override.at(5_000);

  const rootEnd = new Session(
    'timer async 1 s {\n  timer async 0 ms { say "nested" }\n  wait 1 s\n}\nwait 2 s',
  );
  rootEnd.at(1_000).at(2_000);
  assert.deepEqual(rootEnd.said(), ["nested"]);
  assert.equal(rootEnd.snapshot.status, "halted");

  const depthPlan = plan(
    'function f {\n  wait 2 s\n  return 1\n}\ntimer async 1 s { say "interrupt" }\nlet x = f()\nsay "x ${x}"',
  );
  let depth = run(
    depthPlan,
    createImmediatePacingRuntimeSnapshot(depthPlan, { maxCallDepth: 1 }),
  ).snapshot;
  depth = run(depthPlan, observeTime(depthPlan, depth, 3_000).snapshot).snapshot;
  depth = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(depthPlan, depth))).snapshot;
  assert.equal(depth.status, "halted");

  const huge = new Session(
    "let t = timer async 1 s\nt.remaining = 10000000000000000000 h\nwait 1 s",
  );
  assert.equal(huge.snapshot.failure?.code, "TSR050");

  const deferred = new Session('timer async 1 s { say "interrupt" }\nwait 2 s');
  const delay = deferred.snapshot.foregroundAction!;
  const completion = completeAction(deferred.plan, deferred.snapshot, {
    actionId: delay.actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: 2_000 },
  });
  assert.equal(completion.outcome.kind, "suspendedAction");

  const stopped = new Session(
    'let second = timer async 2 s { say "second" }\nlet first = timer async 1 s { second.stop() }\nwait 3 s',
  );
  stopped.at(3_000);
  assert.deepEqual(stopped.said(), [], "a block that ran first can still stop a later timer");
});

test("a late observation skips silent fixed repeat rounds arithmetically", () => {
  const source = "let t = timer(duration: 1 ms, async: true, repeat: true)\nwait 10000 s\nexit";
  const late = new Session(source);
  const started = performance.now();
  late.at(3_600_000);
  assert.ok(performance.now() - started < 500, "catch-up must not process every silent round");
  const timer = late.timers()[0]!.timer;
  assert.equal(timer.elapsedMs, 3_600_000);
  assert.equal(timer.deadlineMs, 3_600_001);
});
