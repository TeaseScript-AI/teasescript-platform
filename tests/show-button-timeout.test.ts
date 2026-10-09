import assert from "node:assert/strict";
import test from "node:test";

import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDeadlines,
  playerRuntimeForeground,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, deserializeCheckpoint } from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { playerStateOf } from "./helpers/player-state.js";

function seconds(milliseconds: number) {
  return { kind: "duration", milliseconds };
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

function observe(session: PlayerRuntimeSession, atMs: number): PlayerRuntimeSession {
  const observed = observePlayerRuntimeTime(session, atMs);
  assert.equal(observed.outcome.kind, "observed");
  return observed.session;
}

function click(session: PlayerRuntimeSession): PlayerRuntimeSession {
  const activated = activatePlayerRuntimeButton(session);
  assert.equal(activated?.outcome.kind, "completed");
  return activated.session;
}

function settlementKinds(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "actionCompleted" && event.settlement.actionKind === "interaction"
      ? [event.settlement.settlementKind]
      : [],
  );
}

function playerMessages(session: PlayerRuntimeSession): string[] {
  return session.transcriptEntries.flatMap((entry) =>
    entry.kind === "message" && entry.speakerId === "user" ? [entry.text] : [],
  );
}

test("a click before the timeout returns the elapsed scene time as a duration", () => {
  const source =
    'let elapsed = showButton "Continue", timeout: 5\nif elapsed < 2 s { say "That was quick.", instant }\nexit';
  for (const { clickAtMs, quick } of [
    { clickAtMs: 1_500, quick: true },
    { clickAtMs: 2_500, quick: false },
  ]) {
    let session = createPlayerRuntimeSession(source);
    assert.deepEqual(playerRuntimeDeadlines(session.state), [5_000]);
    session = observe(session, clickAtMs);
    assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
    session = click(session);
    assert.equal(session.state.status, "halted");
    assert.deepEqual(binding(playerRuntimeSnapshot(session), "elapsed"), seconds(clickAtMs));
    assert.deepEqual(playerMessages(session), ["Continue"]);
    assert.equal(
      session.transcriptEntries.some((entry) => entry.text === "That was quick."),
      quick,
    );
    assert.deepEqual(settlementKinds(session.events), ["completed"]);
  }
});

test("a reached timeout removes the button without a chat message and returns the timeout", () => {
  for (const { timeout, milliseconds } of [
    { timeout: "5", milliseconds: 5_000 },
    { timeout: "500 ms", milliseconds: 500 },
    { timeout: "0.25 min", milliseconds: 15_000 },
    { timeout: "limit", milliseconds: 2_000 },
  ]) {
    let session = createPlayerRuntimeSession(
      `let limit = 2 s\nlet elapsed = showButton "Continue", timeout: ${timeout}\nsay "Too slow.", instant\nexit`,
    );
    assert.deepEqual(playerRuntimeDeadlines(session.state), [milliseconds], timeout);
    session = observe(session, milliseconds - 1);
    assert.equal(playerRuntimeForeground(session)?.kind, "show-button", timeout);
    session = observe(session, milliseconds);
    assert.equal(session.state.status, "halted", timeout);
    assert.equal(playerRuntimeForeground(session), null);
    assert.deepEqual(
      binding(playerRuntimeSnapshot(session), "elapsed"),
      seconds(milliseconds),
      timeout,
    );
    assert.deepEqual(playerMessages(session), [], timeout);
    assert.ok(session.events.every((event) => event.kind !== "playerTranscript"));
    assert.deepEqual(settlementKinds(session.events), ["timedOut"]);
    assert.equal(session.transcriptEntries.at(-1)?.text, "Too slow.");
  }
});

test("without a timeout the button waits for the click however late time is observed", () => {
  let session = createPlayerRuntimeSession('let elapsed = showButton "Continue"\nexit');
  assert.deepEqual(playerRuntimeDeadlines(session.state), []);
  session = observe(session, 3_600_000);
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
  session = click(session);
  assert.deepEqual(binding(playerRuntimeSnapshot(session), "elapsed"), seconds(3_600_000));
});

test("an ignored result keeps the button result-free", () => {
  for (const source of ['showButton "Continue", timeout: 2', 'showButton "Continue"']) {
    const plan = compileValidPlan(`${source}\nsay "Next", instant\nexit`);
    const instruction = plan.instructions.find((candidate) => candidate.kind === "interaction");
    assert.equal(instruction?.kind, "interaction");
    assert.equal(instruction.destinationTemporary, null, source);
    assert.equal(instruction.expectedResult, "none", source);
  }
  let session = createPlayerRuntimeSession(
    'showButton "Continue", timeout: 2\nsay "Next", instant\nexit',
  );
  session = observe(session, 2_000);
  assert.equal(session.state.status, "halted");
  const settlement = playerRuntimeSnapshot(session).lastSettlement;
  assert.equal(settlement?.actionKind, "interaction");
  assert.equal(settlement.settlementKind, "timedOut");
  assert.equal(settlement.result, null);
  assert.equal(session.transcriptEntries.at(-1)?.text, "Next");
});

test("options appear in either order and evaluate in source order", () => {
  const record =
    'let order = ""\nfunction record(value) {\n  order = "${order}${value} "\n  return value\n}';
  for (const { options, order } of [
    { options: 'timeout: record(3), background: record("gold")', order: "Go 3 gold " },
    { options: 'background: record("gold"), timeout: record(3)', order: "Go gold 3 " },
  ]) {
    let session = createPlayerRuntimeSession(
      `${record}\nspeaker guide { name: "Guide" }\nlet result = { elapsed: showButton as guide record("Go"), ${options} }\nexit`,
    );
    assert.equal(binding(playerRuntimeSnapshot(session), "order"), order);
    const foreground = playerRuntimeForeground(session);
    assert.equal(foreground?.kind, "show-button");
    assert.ok(foreground.authoredFill !== undefined);
    session = observe(session, 3_000);
    assert.deepEqual(binding(playerRuntimeSnapshot(session), "result"), {
      kind: "object",
      properties: [{ name: "elapsed", value: seconds(3_000) }],
    });
  }
});

test("a button works as a value inside interpolation", () => {
  const session = observe(
    createPlayerRuntimeSession('say "You waited ${showButton "Go", timeout: 1}.", instant\nexit'),
    1_000,
  );
  assert.equal(session.state.status, "halted");
  assert.equal(session.transcriptEntries.at(-1)?.text, "You waited 1 s.");
});

test("the compiler rejects a timeout it can see is invalid and names the fix", () => {
  for (const { source, code, fix } of [
    { source: 'showButton "Go", timeout: 0', code: "TSV011", fix: "Remove 'timeout:'" },
    { source: 'showButton "Go", timeout: -1', code: "TSV011", fix: "Remove 'timeout:'" },
    { source: 'let e = showButton "Go", timeout: 0 ms', code: "TSV011", fix: "Remove 'timeout:'" },
    { source: 'showButton "Go", timeout: -2 s', code: "TSV011", fix: "Remove 'timeout:'" },
    { source: 'showButton "Go", timeout: 2 min - 150 s', code: "TSV011", fix: "Remove 'timeout:'" },
    { source: 'showButton "Go", timeout: 1e308', code: "TSV011", fix: "shorter timeout" },
    // An overflowing step is the language-wide overflow error, even when later arithmetic would bring the value back.
    { source: 'showButton "Go", timeout: 1e308 * 10', code: "TSV050", fix: "smaller values" },
    {
      source: 'showButton "Go", timeout: 1e300 h / 1e-300',
      code: "TSV050",
      fix: "shorter duration",
    },
    {
      source: 'showButton "Go", timeout: 1 / (1e308 * 10) + 1',
      code: "TSV050",
      fix: "smaller values",
    },
    {
      source: 'showButton "Go", timeout: 1 s + 1 h / (1e300 * 1e10)',
      code: "TSV050",
      fix: "smaller values",
    },
    {
      source: 'showButton "Go", timeout: 9007199254740992 ms',
      code: "TSV011",
      fix: "shorter timeout",
    },
    { source: 'showButton "Go", timeout: "5"\nexit', code: "TSV043", fix: "a number of seconds" },
    {
      source: 'let t = true\nshowButton "Go", timeout: t\nexit',
      code: "TSV043",
      fix: "a number of seconds",
    },
    { source: 'showButton "Go", timeout: [5]\nexit', code: "TSV043", fix: "a number of seconds" },
    {
      source: 'showButton "Go", timeout: 2 calendar days\nexit',
      code: "TSV043",
      fix: "A calendar day or month has no fixed length",
    },
    { source: 'showButton "Go", timeout: 1, timeout: 2', code: "TSP032", fix: "one timeout:" },
    { source: 'showButton "Go", 5', code: "TSP032", fix: "background: and timeout:" },
    { source: 'showButton("Go", 5)', code: "TSP032", fix: "Parenthesized" },
    { source: 'showButton "Go", timeout:', code: "TSP028", fix: "timeout: 500 ms" },
    {
      source: 'function f(elapsed = showButton "Go") {\n}',
      code: "TSV032",
      fix: "parameter defaults",
    },
    {
      source: 'function f(text = "${showButton "Go"}") {\n}',
      code: "TSV032",
      fix: "parameter defaults",
    },
  ]) {
    const diagnostics = compileSource(source).diagnostics;
    assert.equal(diagnostics[0]?.code, code, source);
    assert.ok(diagnostics[0]?.message.includes(fix), `${source}: ${diagnostics[0]?.message}`);
  }
});

test("a timeout the compiler cannot know fails at runtime before the button appears", () => {
  for (const { source, message } of [
    { source: "let limit = 0", message: "greater than zero" },
    { source: "let limit = -3", message: "greater than zero" },
    {
      source: 'function pick(value) {\n  return value\n}\nlet limit = pick("5")',
      message: "greater than zero",
    },
    { source: "let limit = 1e300", message: "too long for scene time to reach" },
  ]) {
    const plan = compileValidPlan(`${source}\nlet elapsed = showButton "Go", timeout: limit\nexit`);
    const result = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(result.snapshot.status, "failed", source);
    assert.equal(result.snapshot.foregroundAction, null);
    assert.ok(result.events.every((event) => event.kind !== "actionRequested"));
    const failure = result.snapshot.failure;
    assert.equal(failure?.code, "TSR050", source);
    assert.ok(failure.message.includes(message), failure.message);
  }
});

test("a checkpoint while the button is shown resumes with its original start and deadline", () => {
  let session = createPlayerRuntimeSession('let elapsed = showButton "Continue", timeout: 5\nexit');
  session = observe(session, 1_200);
  const restorePoint = createPlayerRuntimeRestorePoint(session);
  const clicked = restorePlayerRuntimeSession(restorePoint);
  assert.equal(validateRuntimeSnapshot(playerRuntimeSnapshot(clicked), clicked.plan).valid, true);
  assert.deepEqual(playerRuntimeForeground(clicked), playerRuntimeForeground(session));
  assert.deepEqual(playerRuntimeDeadlines(clicked.state), [5_000]);
  assert.deepEqual(
    binding(playerRuntimeSnapshot(click(observe(clicked, 1_800))), "elapsed"),
    seconds(1_800),
  );
  const timedOut = observe(restorePlayerRuntimeSession(restorePoint), 5_000);
  assert.deepEqual(binding(playerRuntimeSnapshot(timedOut), "elapsed"), seconds(5_000));

  for (const source of [
    'let elapsed = showButton "Continue", timeout: 2\nsay "Waited ${elapsed}.", instant\nexit',
    'speaker guide { name: "Guide" }\nsay "Ready?"\nshowButton as guide "Continue", timeout: 1.5, background: "gold"\nwait 1\nexit',
    'timer async 1 { wait 5 }\nlet elapsed = showButton "Continue", timeout: 3\nsay "${elapsed}"\nexit',
  ]) {
    assertRuntimeResumeEquivalent(source);
  }
});

/** Runs and observes each time in turn, checking every published snapshot. */
function playAt(plan: InstructionPlan, initial: RuntimeSnapshot, times: readonly number[]) {
  const events: InterpreterEvent[] = [];
  let current = run(plan, initial);
  events.push(...current.events);
  for (const atMs of times) {
    const observed = observeTime(plan, current.snapshot, atMs);
    current = run(plan, observed.snapshot);
    events.push(...observed.events, ...current.events);
    assert.equal(validateRuntimeSnapshot(current.snapshot, plan).valid, true);
  }
  return { events, snapshot: current.snapshot };
}

test("a timeout reached during catch-up matches observing every deadline on time", () => {
  for (const { source, onTime } of [
    {
      // The script continues at the timeout, not at the late observation.
      source:
        'let elapsed = showButton "Go", timeout: 2\nwait 1\nsay "Done after ${elapsed}."\nexit',
      onTime: [2_000, 3_000],
    },
    {
      // An expiry block suspends the button past its deadline; the button times out when the block returns.
      source:
        'timer async 1 { wait 5 }\nlet elapsed = showButton "Go", timeout: 3\nsay "After ${elapsed}."\nexit',
      onTime: [1_000, 6_000],
    },
    {
      // A block that returns before the deadline leaves the button to time out on schedule; the block's paced
      // message is consumed when the button returns.
      source:
        'timer async 1 { say "Tick." }\nlet elapsed = showButton "Go", timeout: 3\nsay "After ${elapsed}."\nexit',
      onTime: [1_000, 3_000],
    },
  ]) {
    const plan = compileValidPlan(source);
    const late = playAt(plan, createFreshRuntimeSnapshot(plan), [60_000]);
    const timely = playAt(plan, createFreshRuntimeSnapshot(plan), [...onTime, 60_000]);
    assert.deepEqual(late.events, timely.events, source);
    assert.deepEqual(late.snapshot, timely.snapshot, source);
    assert.equal(late.snapshot.status, "halted");
    assert.deepEqual(settlementKinds(late.events), ["timedOut"]);
  }
  // Suspended by the block, the button is inert, and the Player observes only the block's own deadline.
  const plan = compileValidPlan('timer async 1 { wait 5 }\nshowButton "Go", timeout: 3\nexit');
  const suspended = playAt(plan, createFreshRuntimeSnapshot(plan), [1_000]).snapshot;
  assert.equal(suspended.foregroundAction?.kind, "delay");
  assert.deepEqual(playerRuntimeDeadlines(playerStateOf(plan, suspended)), [6_000]);
});

test("a button consumes the pacing gate before it, and its timeout starts when it appears", () => {
  const plan = compileValidPlan(
    'say "Ready?", 2\nlet elapsed = showButton "Go", timeout: 3\nsay "Waited ${elapsed}.", instant\nexit',
  );
  const shown = run(plan, createFreshRuntimeSnapshot(plan));
  const gate = shown.events.find(
    (event) => event.kind === "actionCompleted" && event.settlement.actionKind === "chatPacingGate",
  );
  assert.equal(gate?.kind, "actionCompleted");
  assert.equal(gate.settlement.settlementKind, "consumedByForegroundInteraction");
  const button = shown.snapshot.foregroundAction;
  assert.equal(button?.kind, "interaction");
  assert.deepEqual([button.createdAtMs, button.timeoutMs], [0, 3_000]);
  assert.deepEqual(shown.snapshot.backgroundActions, []);
  const done = playAt(plan, shown.snapshot, [3_000]);
  assert.deepEqual(binding(done.snapshot, "elapsed"), seconds(3_000));
});

test("a click that arrives after the timeout does not revive the button", () => {
  const plan = compileValidPlan('let elapsed = showButton "Go", timeout: 1\nexit');
  const shown = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const actionId = shown.foregroundAction!.actionId;
  const timedOut = observeTime(plan, shown, 1_000).snapshot;
  const late = completeAction(plan, timedOut, {
    actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  assert.equal(late.outcome.kind, "alreadySettled");
  assert.equal(late.outcome.settlement.actionKind, "interaction");
  assert.equal(late.outcome.settlement.settlementKind, "timedOut");
  assert.deepEqual(late.events, []);
  assert.deepEqual(late.snapshot, timedOut);
});

/** A malformed snapshot fails validation and cannot be restored from a checkpoint. */
/** The snapshot with its handed-off button result replaced in every copy. */
function withResult(snapshot: RuntimeSnapshot, result: unknown) {
  const handoff = snapshot.interactionResultHandoff!;
  return {
    ...snapshot,
    lastSettlement: { ...snapshot.lastSettlement!, result },
    interactionResultHandoff: { ...handoff, result },
    temporaries: snapshot.temporaries.map((temporary) =>
      temporary.id === handoff.destinationTemporary ? { ...temporary, value: result } : temporary,
    ),
  };
}

function rejects(plan: InstructionPlan, snapshot: unknown): boolean {
  const checkpoint = createCheckpoint(plan, createFreshRuntimeSnapshot(plan));
  assert.throws(() => deserializeCheckpoint(JSON.stringify({ ...checkpoint, snapshot })));
  return !validateRuntimeSnapshot(snapshot, plan).valid;
}

test("plan and snapshot validation reject malformed button results and timing", () => {
  const plan = compileValidPlan('let elapsed = showButton "Go", timeout: 5\nexit');
  const shown = createImmediatePacingRuntimeSnapshot(plan);
  const waiting = run(plan, shown).snapshot;
  const action = waiting.foregroundAction!;
  assert.equal(action.kind, "interaction");
  for (const [name, change] of [
    ["zero timeout", { timeoutMs: 0 }],
    ["negative timeout", { timeoutMs: -1 }],
    ["text timeout", { timeoutMs: "5000" }],
    ["timeout the prepared value does not give", { timeoutMs: 4_000 }],
    ["start after now", { createdAtMs: 1 }],
    ["missing start", { createdAtMs: undefined }],
  ] as const) {
    assert.ok(rejects(plan, { ...waiting, foregroundAction: { ...action, ...change } }), name);
  }
  const overdue = { ...waiting, currentSessionTimeMs: 5_001, observedSessionTimeMs: 5_001 };
  assert.ok(rejects(plan, overdue), "overdue presented button");

  const timedOut = observeTime(plan, waiting, 5_000).snapshot;
  assert.equal(validateRuntimeSnapshot(timedOut, plan).valid, true);
  const settlement = timedOut.lastSettlement!;
  for (const [name, change] of [
    ["transcript text", { transcriptText: "Go" }],
    ["transcript sequence", { transcriptEventSequence: 2 }],
  ] as const) {
    assert.ok(rejects(plan, { ...timedOut, lastSettlement: { ...settlement, ...change } }), name);
  }
  // A result changed consistently in the settlement, the handoff, and the destination is still impossible.
  const clicked = completeAction(plan, observeTime(plan, waiting, 1_000).snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  }).snapshot;
  for (const [name, snapshot, result] of [
    ["number result", timedOut, 5_000],
    ["negative duration", timedOut, seconds(-1)],
    ["zero timeout result", timedOut, seconds(0)],
    ["timed-out result below the timeout", timedOut, seconds(4_000)],
    ["elapsed time beyond the timeout", clicked, seconds(10_000)],
    ["elapsed time beyond the current scene time", clicked, seconds(4_000)],
  ] as const) {
    assert.ok(rejects(plan, withResult(snapshot, result)), name);
  }
  assert.equal(validateRuntimeSnapshot(withResult(clicked, seconds(500)), plan).valid, true);
  const untimed = compileValidPlan('let elapsed = showButton "Go"\nexit');
  const shownUntimed = run(untimed, createFreshRuntimeSnapshot(untimed)).snapshot;
  const clickedUntimed = completeAction(
    untimed,
    observeTime(untimed, shownUntimed, 1_000).snapshot,
    {
      actionId: shownUntimed.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: "button",
      payload: { kind: "activate" },
    },
  ).snapshot;
  const untimedSettlement = clickedUntimed.lastSettlement!;
  assert.ok(
    rejects(untimed, {
      ...clickedUntimed,
      lastSettlement: {
        ...untimedSettlement,
        settlementKind: "timedOut",
        transcriptEventSequence: null,
        transcriptText: null,
      },
    }),
    "a button without a timeout cannot time out",
  );

  // A valued button's result is consumed right after it, as for any result interaction.
  const consumed = compileValidPlan('let elapsed = showButton "Go", timeout: 1\nwait 1\nexit');
  const at = consumed.instructions.findIndex((candidate) => candidate.kind === "interaction");
  const wait = consumed.instructions.find((candidate) => candidate.kind === "wait")!;
  const skipped = consumed.instructions.map((candidate, index) =>
    index === at + 1 ? { ...wait, span: candidate.span } : candidate,
  );
  assert.equal(validateInstructionPlan({ ...consumed, instructions: skipped }).valid, false);

  const instruction = plan.instructions.find((candidate) => candidate.kind === "interaction")!;
  const index = plan.instructions.indexOf(instruction);
  assert.ok("preparedUi" in instruction && instruction.preparedUi.kind === "button");
  for (const [name, change] of [
    ["result-free domain with a destination", { expectedResult: "none" }],
    ["text domain", { expectedResult: "string" }],
    [
      "timeout aliasing the label",
      {
        preparedUi: {
          ...instruction.preparedUi,
          timeoutTemporary: instruction.preparedUi.buttonLabelTemporary,
        },
      },
    ],
  ] as const) {
    const instructions = plan.instructions.map((candidate, at) =>
      at === index ? { ...candidate, ...change } : candidate,
    );
    assert.equal(validateInstructionPlan({ ...plan, instructions }).valid, false, name);
  }
});
