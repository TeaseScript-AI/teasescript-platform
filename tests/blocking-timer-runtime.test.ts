import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { WaitInstruction } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import type { RuntimeDelayActionSnapshot } from "../src/runtime/actions/model.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

const SEEDS = [0x1234_5678, 0x9e37_79b9, 0x0bad_f00d, 0x7fff_ffff, 0xdead_beef, 0x0f0f_0f0f];

function delayAction(snapshot: RuntimeSnapshot): RuntimeDelayActionSnapshot {
  assert.equal(snapshot.status, "waiting");
  assert.ok(snapshot.foregroundAction?.kind === "delay");
  return snapshot.foregroundAction;
}

function start(source: string, seed = SEEDS[0]!) {
  const compiled = plan(source);
  const operation = run(compiled, createImmediatePacingRuntimeSnapshot(compiled, { seed }));
  return { compiled, ...operation };
}

function diagnostics(source: string): string[] {
  const result = compileSource(source);
  assert.equal(result.plan, null, `${JSON.stringify(source)} must not compile`);
  return result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`);
}

test("timer compiles fixed seconds and integer-second ranges into visible foreground delays", () => {
  const compiled = plan("timer 3\ntimer 5..10\ntimer 5..=10\nwait 2\nexit");
  const waits = compiled.instructions.filter(
    (instruction): instruction is WaitInstruction => instruction.kind === "wait",
  );
  assert.deepEqual(
    waits.map((instruction) => [instruction.display, instruction.unit]),
    [
      ["visible", null],
      ["visible", null],
      ["visible", null],
      ["hidden", null],
    ],
  );

  const { snapshot, events } = start('timer 3\nsay "after"\nexit');
  const action = delayAction(snapshot);
  assert.equal(action.display, "visible");
  assert.equal(action.createdAtMs, 0);
  assert.equal(action.deadlineMs, 3_000);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["actionRequested"],
  );
  assert.ok(events[0]?.kind === "actionRequested");
  assert.equal(events[0].action.kind === "delay" && events[0].action.display, "visible");

  const hidden = start("wait 3\nexit");
  assert.equal(delayAction(hidden.snapshot).display, "hidden");
});

test("timer blocks until an explicit observation reaches its deadline", () => {
  const { compiled, snapshot } = start('timer 2\nsay "after"\nexit');
  const early = observeTime(compiled, snapshot, 1_999);
  assert.equal(early.snapshot.status, "waiting");
  assert.deepEqual(early.events, []);
  assert.deepEqual(run(compiled, early.snapshot).events, []);

  const due = observeTime(compiled, early.snapshot, 2_000);
  assert.equal(due.snapshot.status, "running");
  assert.equal(due.snapshot.foregroundAction, null);
  assert.deepEqual(
    due.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  const done = run(compiled, due.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.deepEqual(
    done.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["after", "exit"],
  );
});

test("timer ranges draw one whole second from the session RNG in source order", () => {
  const exclusive = new Set<number>();
  const inclusive = new Set<number>();
  for (const seed of SEEDS) {
    for (let offset = 0; offset < 40; offset += 1) {
      const runSeed = (seed + offset * 0x10_0001) >>> 0 || 1;
      exclusive.add(delayAction(start("timer 5..7\nexit", runSeed).snapshot).deadlineMs);
      inclusive.add(delayAction(start("timer 5..=7\nexit", runSeed).snapshot).deadlineMs);
    }
  }
  assert.deepEqual([...exclusive].sort(), [5_000, 6_000]);
  assert.deepEqual([...inclusive].sort(), [5_000, 6_000, 7_000]);

  for (const seed of SEEDS) {
    const timer = start("timer 10..=20\nexit", seed);
    const reference = start("let drawn = randomInteger(10..=20)\nwait drawn\nexit", seed);
    assert.equal(
      delayAction(timer.snapshot).deadlineMs,
      delayAction(reference.snapshot).deadlineMs,
    );
    assert.deepEqual(timer.snapshot.rng, reference.snapshot.rng, "exactly one RNG draw");
    assert.deepEqual(start("timer 10..=20\nexit", seed).snapshot, timer.snapshot, "deterministic");
  }

  // Duration expressions evaluate before the draw; draws follow source order.
  const ordered = start(
    'let first = randomInteger(1..=100)\ntimer first..first + 50\nsay "${randomInteger(1..=100)}"\nexit',
    SEEDS[1],
  );
  const reference = start(
    'let first = randomInteger(1..=100)\nlet drawn = randomInteger(first..first + 50)\nwait drawn\nsay "${randomInteger(1..=100)}"\nexit',
    SEEDS[1],
  );
  assert.equal(
    delayAction(ordered.snapshot).deadlineMs,
    delayAction(reference.snapshot).deadlineMs,
  );
  const laterDraw = (value: typeof ordered): string => {
    const settled = observeTime(value.compiled, value.snapshot, 1_000_000).snapshot;
    const say = run(value.compiled, settled).events.find((event) => event.kind === "say");
    assert.ok(say?.kind === "say");
    return say.text;
  };
  assert.match(laterDraw(ordered), /^\d+$/u);
  assert.equal(laterDraw(ordered), laterDraw(reference));
});

test("a pending timer checkpoint restores without a redraw or duplicate request", () => {
  for (const seed of SEEDS) {
    const { compiled, snapshot } = start('timer 30..=90\nsay "after"\nexit', seed);
    const action = delayAction(snapshot);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(compiled, snapshot)),
    );
    assert.deepEqual(restored.snapshot, snapshot);
    assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);

    const resumed = run(restored.plan, restored.snapshot);
    assert.deepEqual(resumed.events, [], "restore neither re-requests nor settles");
    assert.deepEqual(resumed.snapshot.foregroundAction, action);

    const early = observeTime(restored.plan, resumed.snapshot, action.deadlineMs - 1);
    assert.equal(early.snapshot.status, "waiting");
    const due = observeTime(restored.plan, early.snapshot, action.deadlineMs);
    assert.equal(due.snapshot.lastSettlement?.actionId, action.actionId);
    assert.equal(run(restored.plan, due.snapshot).snapshot.status, "halted");
  }
});

test("timer resume equivalence holds at every boundary in loops, calls, and at root end", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "function countdown(seconds) {",
      '    say "Hold for ${seconds} seconds."',
      "    timer seconds",
      "    return seconds",
      "}",
      "let total = 0",
      "repeat 2 {",
      "    timer 1..=3",
      "    total = total + countdown(2)",
      "}",
      'say "total ${total}"',
      "timer 4..8",
    ].join("\n"),
    { scenarioName: "blocking timer equivalence" },
  );
  const requested = result.events.filter((event) => event.kind === "actionRequested");
  assert.equal(requested.length, 5);
  assert.ok(
    requested.every((event) => event.action.kind === "delay" && event.action.display === "visible"),
  );
  assert.equal(result.events.filter((event) => event.kind === "actionCompleted").length, 5);
  assert.equal(result.events.at(-1)?.kind, "complete");
});

test("a timer coexists with an older background pacing gate and settles in deadline order", () => {
  const compiled = plan('say "hello there"\ntimer 1\nsay "after"\nexit');
  const started = run(compiled, createFreshRuntimeSnapshot(compiled));
  const timer = delayAction(started.snapshot);
  assert.equal(started.snapshot.backgroundActions.length, 1);
  const gate = started.snapshot.backgroundActions[0];
  assert.ok(gate?.kind === "chatPacingGate");
  assert.ok(gate.deadlineMs > timer.deadlineMs, "the pacing gate outlasts the one-second timer");

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, started.snapshot)),
  );
  const timerDue = observeTime(restored.plan, restored.snapshot, timer.deadlineMs);
  assert.equal(timerDue.snapshot.lastSettlement?.actionId, timer.actionId);
  const next = run(restored.plan, timerDue.snapshot);
  assert.equal(next.snapshot.status, "waiting");
  assert.equal(next.snapshot.foregroundAction?.kind, "chatPacingGate");

  const gateDue = observeTime(restored.plan, next.snapshot, gate.deadlineMs);
  const done = run(restored.plan, gateDue.snapshot);
  assert.deepEqual(
    done.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["after"],
  );
  assert.equal(done.events.at(-1)?.kind, "exit");
});

test("zero timers are immediate and create no action", () => {
  const { snapshot, events } = start('timer 0\nsay "now"\nexit');
  assert.equal(snapshot.status, "halted");
  assert.equal(snapshot.nextActionId, 1);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["say", "exit"],
  );
});

test("unsupported and invalid timer forms fail with structured diagnostics", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["timer", "TSP012 Expected a timer duration"],
    ["timer(10)", "TSP034 The parenthesized timer form uses named arguments"],
    ["timer(duration: 1, repeat: yes)", "TSP034 Timer argument 'repeat' must be the literal"],
    ["timer(duration: 1, speed: 2)", "TSP034 Unknown timer argument 'speed'"],
    ['timer(label: "x")', "TSP034 The parenthesized timer form requires a 'duration'"],
    ["timer 10 { exit }", "TSV033 Only an async timer may have an expiry block"],
    ["timer(duration: 1, repeat: true)", "TSV033 Only an async timer may have an expiry block"],
    ["let t = timer 10", "TSV033 A blocking timer returns no handle"],
    ['timer(duration: 1, display: "loud")', "TSV033 Timer display must be"],
    ["timer 10 s ms", "TSV033 This duration already has a unit."],
    ["timer 1 day", "TSP033"],
    ["timer 5..10 min", "TSV010 A timer range counts whole seconds"],
    ["let n = 10\ntimer 5..n min", "TSV010 A timer range counts whole seconds"],
    ["timer -1", "TSV011 Timer duration must not be negative."],
    ["timer 1.5..3", "TSV010 A statically known timer range must have integer second bounds."],
    ["timer -2..3", "TSV010 A timer range must not start below zero seconds."],
    ["timer 5..5", "TSV010 A timer range must contain at least one whole second."],
    ["timer 6..=5", "TSV010 A timer range must contain at least one whole second."],
    ["let timer = 1", "TSV001"],
  ];
  for (const [source, expected] of cases) {
    const found = diagnostics(source);
    assert.ok(
      found.some((diagnostic) => diagnostic.startsWith(expected)),
      `${JSON.stringify(source)}: ${found.join(" | ")}`,
    );
  }
});

test("invalid dynamic timer durations fail deterministically before any action", () => {
  // Each row names the failure code and the duration operand it must locate.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['let d = "soon"\ntimer d', "TSR050", "d"],
    ["let d = -1\ntimer d", "TSR050", "d"],
    ["let a = 3\ntimer a..a", "TSR041", "a..a"],
    ["let a = 0.5\ntimer a..3", "TSR045", "a..3"],
    ["let a = -3\ntimer a..3", "TSR050", "a..3"],
    ["let d = 1..3\nwait d", "TSR050", "d"],
  ];
  for (const [source, code, operand] of cases) {
    const operandStart = source.lastIndexOf(operand);
    for (const seed of SEEDS) {
      const { compiled, snapshot, events } = start(source, seed);
      assert.equal(snapshot.status, "failed", source);
      assert.equal(snapshot.nextActionId, 1, source);
      assert.deepEqual(
        snapshot.rng,
        createImmediatePacingRuntimeSnapshot(compiled, { seed }).rng,
        `${source}: rejection happens before any RNG draw`,
      );
      const failure = events.at(-1);
      assert.ok(failure?.kind === "runtimeFailure", source);
      assert.deepEqual(
        [failure.code, failure.span.start.offset, failure.span.end.offset],
        [code, operandStart, operandStart + operand.length],
        source,
      );
    }
  }
});

test("restored timer display data is validated against its owning instruction", () => {
  const { compiled, snapshot } = start("timer 5\nexit");
  const checkpointJson = serializeCheckpoint(createCheckpoint(compiled, snapshot));

  const actionVariants: Array<(action: Record<string, unknown>) => void> = [
    (action) => delete action.display,
    (action) => (action.display = "mystery"),
    (action) => (action.display = "hidden"),
  ];
  for (const mutate of actionVariants) {
    const candidate = jsonRecord(JSON.parse(checkpointJson));
    mutate(jsonRecord(jsonRecord(candidate.snapshot).foregroundAction));
    assertCheckpointRejected(candidate, "TSK002");
  }

  const planVariants: Array<(instruction: Record<string, unknown>) => void> = [
    (instruction) => delete instruction.display,
    (instruction) => (instruction.display = "loud"),
    (instruction) => (instruction.unit = "days"),
    (instruction) => delete instruction.label,
    (instruction) => (instruction.command = "sleep"),
    (instruction) => (instruction.extra = true),
  ];
  for (const mutate of planVariants) {
    const candidate = jsonRecord(JSON.parse(checkpointJson));
    const instructions = jsonRecord(candidate.plan).instructions;
    assert.ok(Array.isArray(instructions));
    const instruction = instructions.map(jsonRecord).find((entry) => entry.kind === "wait");
    assert.ok(instruction !== undefined);
    mutate(instruction);
    assert.equal(validateInstructionPlan(candidate.plan).valid, false);
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(candidate)),
      (error: unknown) => error instanceof CheckpointError,
    );
  }
});

function jsonRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  // EVIDENCE: fixture: the value is a parsed JSON object, checked as a non-array object above.
  return value as Record<string, unknown>;
}
