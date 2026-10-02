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
import type { SourceSpan } from "../src/source.js";
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

/** Rejected-source diagnostics as code plus source offsets. */
function diagnostics(source: string): string[] {
  const result = compileSource(source);
  assert.equal(result.plan, null, `${JSON.stringify(source)} must not compile`);
  return result.diagnostics.map(({ code, span }) =>
    located(code, span.start.offset, span.end.offset),
  );
}

function located(code: string, start: number, end: number): string {
  return `${code} ${start}-${end}`;
}

/** Expected code at the last occurrence of `subject`; an empty subject names the source end. */
function expectedAt(source: string, code: string, subject: string): string {
  const start = source.lastIndexOf(subject);
  assert.ok(start >= 0, `${JSON.stringify(subject)} must occur in ${JSON.stringify(source)}`);
  return located(code, start, start + subject.length);
}

test("timer compiles fixed seconds and integer-second ranges into visible foreground delays", () => {
  const compiled = plan("timer 3\ntimer 5..10\ntimer 5..=10\nwait 2\nexit");
  const waits = compiled.instructions.filter(
    (instruction): instruction is WaitInstruction => instruction.kind === "wait",
  );
  assert.deepEqual(
    waits.map((instruction) => instruction.display),
    ["visible", "visible", "visible", "hidden"],
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

test("unsupported and invalid timer forms, members, and handler scope fail with located diagnostics", () => {
  const cases: ReadonlyArray<readonly [source: string, code: string, subject: string]> = [
    ["timer", "TSP012", ""],
    ["timer(10)", "TSP034", "10"],
    ["timer(duration: 1, repeat: yes)", "TSP034", "yes"],
    ["timer(duration: 1, speed: 2)", "TSP034", "speed"],
    ['timer(label: "x")', "TSP034", 'timer(label: "x")'],
    ["timer 10 { exit }", "TSV033", "{ exit }"],
    ["timer(duration: 1, repeat: true)", "TSV033", "timer(duration: 1, repeat: true)"],
    ["let t = timer 10", "TSV033", "timer 10"],
    ['timer(duration: 1, display: "loud")', "TSV033", '"loud"'],
    ["timer 10 s ms", "TSV033", "10 s"],
    ["timer -1", "TSV011", "-1"],
    ["timer 1.5..3", "TSV010", "1.5..3"],
    ["timer -2..3", "TSV010", "-2..3"],
    ["timer 5..5", "TSV010", "5..5"],
    ["timer 6..=5", "TSV010", "6..=5"],
    ["let timer = 1", "TSV001", "timer"],
    // Async handle members, handler scope, and repeating-timer rules.
    ["let t = timer async 5\nsay t.nope", "TSV034", "nope"],
    ["let t = timer async 5\nt.elapsed = 1 s", "TSV034", "elapsed"],
    ["let t = timer async 5\nt.restart()", "TSV034", "restart"],
    ['function f {\n  let local = 1\n  timer async 1 { say "${local}" }\n}', "TSV002", "local"],
    ["timer async 1 { return 5 }", "TSV033", "5"],
    [
      "timer(duration: 1, async: true, repeat: true)\ntimer(duration: 0, async: true, repeat: true)",
      "TSV011",
      "0",
    ],
    ["timer(duration: 1, display: 5)", "TSV033", "5"],
    ["let t = timer async 5\n(t).bogus()", "TSV034", "bogus"],
    ["let t = timer async 5\nt.remaining = 1", "TSV034", "remaining"],
    ["let t = timer async 5\nt.display = 1", "TSV034", "display"],
    ["let t = timer async 5\nt.pause(1)", "TSV034", "pause"],
    ["timer(duration: 0..2, async: true, repeat: true)", "TSV010", "0..2"],
  ];
  for (const [source, code, subject] of cases) {
    const found = diagnostics(source);
    const expected = expectedAt(source, code, subject);
    assert.ok(
      found.includes(expected),
      `${JSON.stringify(source)}: ${expected} not in ${found.join(" | ")}`,
    );
  }
});

test("accepted duration forms without an implementation are never read as another duration", () => {
  // Calendar units (§35) and timer ranges with other units (§27) are not implemented yet. They may fail with a compile
  // or runtime error located in the duration, but a started timer must have the accepted meaning, never for example
  // plain seconds.
  const minutesFiveToTen = (deadlineMs: number): boolean =>
    deadlineMs >= 5 * 60_000 && deadlineMs < 10 * 60_000;
  const cases: ReadonlyArray<
    readonly [source: string, subject: string, accepted: (deadlineMs: number) => boolean]
  > = [
    // A calendar day spans 23, 24, or 25 elapsed hours around daylight-saving transitions.
    [
      "timer 1 day",
      "1 day",
      (deadlineMs) => deadlineMs >= 23 * 3_600_000 && deadlineMs <= 25 * 3_600_000,
    ],
    ["timer 5..10 min", "5..10 min", minutesFiveToTen],
    ["let n = 10\ntimer 5..n min", "5..n min", minutesFiveToTen],
  ];
  for (const [source, subject, accepted] of cases) {
    const start = source.lastIndexOf(subject);
    const inSubject = (span: SourceSpan): boolean =>
      span.start.offset >= start && span.end.offset <= start + subject.length;
    const message = `${JSON.stringify(source)}: an error must be located in ${JSON.stringify(subject)}`;
    const compiled = compileSource(source);
    if (compiled.plan === null) {
      assert.ok(
        compiled.diagnostics.some(({ span }) => inSubject(span)),
        message,
      );
      continue;
    }
    const { snapshot, events } = run(
      compiled.plan,
      createImmediatePacingRuntimeSnapshot(compiled.plan, { seed: SEEDS[0]! }),
    );
    const failure = events.at(-1);
    if (failure?.kind === "runtimeFailure") {
      assert.ok(inSubject(failure.span), message);
      continue;
    }
    const { deadlineMs } = delayAction(snapshot);
    assert.ok(accepted(deadlineMs), `${JSON.stringify(source)} must not mean ${deadlineMs} ms`);
  }
});

test("invalid dynamic timer durations fail deterministically before any action", () => {
  // The subject is the rejected duration or range operand of the timer or wait.
  const cases: ReadonlyArray<readonly [source: string, code: string, subject: string]> = [
    ['let d = "soon"\ntimer d', "TSR050", "d"],
    ["let d = -1\ntimer d", "TSR050", "d"],
    ["let a = 3\ntimer a..a", "TSR041", "a..a"],
    ["let a = 0.5\ntimer a..3", "TSR045", "a..3"],
    ["let a = -3\ntimer a..3", "TSR050", "a..3"],
    ["let d = 1..3\nwait d", "TSR050", "d"],
  ];
  for (const [source, code, subject] of cases) {
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
      assert.equal(
        located(failure.code, failure.span.start.offset, failure.span.end.offset),
        expectedAt(source, code, subject),
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

  // Each variant names the rejected field; an unknown key is reported at the instruction itself.
  const planVariants: ReadonlyArray<
    readonly [field: string, mutate: (instruction: Record<string, unknown>) => void]
  > = [
    ["display", (instruction) => delete instruction.display],
    ["display", (instruction) => (instruction.display = "loud")],
    ["unit", (instruction) => (instruction.unit = "days")],
    ["label", (instruction) => delete instruction.label],
    ["command", (instruction) => (instruction.command = "sleep")],
    ["", (instruction) => (instruction.extra = true)],
  ];
  for (const [field, mutate] of planVariants) {
    const candidate = jsonRecord(JSON.parse(checkpointJson));
    const instructions = jsonRecord(candidate.plan).instructions;
    assert.ok(Array.isArray(instructions));
    const index = instructions.findIndex((entry) => jsonRecord(entry).kind === "wait");
    mutate(jsonRecord(instructions[index]));
    const instructionPath = `instructions[${index}]`;
    const fieldPath = `$.${instructionPath}${field === "" ? "" : `.${field}`}`;
    assert.ok(
      validateInstructionPlan(candidate.plan).errors.some(
        (error) => error.code === "TSC002" && error.path === fieldPath,
      ),
      `plan validation must reject ${fieldPath}`,
    );
    const checkpointPath = `$.plan.${instructionPath}`;
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(candidate)),
      (error: unknown) =>
        error instanceof CheckpointError &&
        error.info.code === "TSK002" &&
        (error.info.path === checkpointPath || error.info.path.startsWith(`${checkpointPath}.`)),
      `checkpoint restore must reject the plan at ${checkpointPath}`,
    );
  }
});

function jsonRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  // EVIDENCE: fixture: the value is a parsed JSON object, checked as a non-array object above.
  return value as Record<string, unknown>;
}
