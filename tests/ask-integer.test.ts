import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  restorePlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, deserializeCheckpoint } from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

function binding(session: PlayerRuntimeSession, name: string) {
  return session.snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

function answer(session: PlayerRuntimeSession, text: string) {
  const result = submitPlayerRuntimeComposer(session, text);
  assert.ok(result !== null, "an integer field accepts composer text");
  return result;
}

test("askInteger returns a whole number as an integer and shows it as the player's answer", () => {
  for (const { text, value } of [
    { text: "12", value: 12 },
    { text: " -7 ", value: -7 },
    { text: "+3", value: 3 },
    { text: "-0", value: 0 },
    { text: "9007199254740991", value: Number.MAX_SAFE_INTEGER },
  ]) {
    let session = createPlayerRuntimeSession(
      'let count = askInteger "How many?", hint: "A whole number"\nlet doubled: integer = count * 2\nexit',
    );
    assert.deepEqual(playerRuntimeForeground(session), {
      kind: "ask-number",
      accessibleName: "Number",
      hint: "A whole number",
      integer: true,
    });
    const answered = answer(session, text);
    assert.equal(answered.outcome.kind, "completed", text);
    session = answered.session;
    assert.equal(session.snapshot.status, "halted");
    assert.equal(binding(session, "count"), value, text);
    assert.equal(session.transcriptEntries.at(-1)?.text, text.trim());
  }
});

test("askInteger asks again for anything but a whole number", () => {
  const session = createPlayerRuntimeSession('let count = askInteger "How many?"\nexit');
  for (const text of [
    "2.5",
    "2.0",
    "1e3",
    "ten",
    "",
    "   ",
    "1 2",
    "7\n8",
    // Like `askNumber`, an answer is one line, even when trimming would leave a whole number.
    "\n1\n",
    "1\r",
    "1\u2028",
    "9007199254740992",
    "0x10",
  ]) {
    const rejected = answer(session, text);
    assert.equal(rejected.outcome.kind, "invalidPayload", JSON.stringify(text));
    assert.equal(
      rejected.outcome.kind === "invalidPayload" && rejected.outcome.message,
      "That is wrong. I asked for a whole number.",
    );
    assert.deepEqual(rejected.session.snapshot, session.snapshot, JSON.stringify(text));
  }
});

test("askInteger prefills a whole-number default answer", () => {
  for (const { source, prefill } of [
    { source: "let count = askInteger default: 10\nexit", prefill: "10" },
    { source: 'let count = askInteger "How many?", default: -3\nexit', prefill: "-3" },
    { source: "let level = 4\nlet count = askInteger default: level * 2\nexit", prefill: "8" },
  ]) {
    const session = createPlayerRuntimeSession(source);
    const foreground = playerRuntimeForeground(session);
    assert.equal(foreground?.kind === "ask-number" && foreground.prefill, prefill, source);
    const answered = answer(session, prefill);
    assert.equal(binding(answered.session, "count"), Number(prefill));
  }
});

test("a default that is not a whole number fails at compile time or before the field opens", () => {
  for (const { source, fix } of [
    { source: "let count = askInteger default: 2.5\nexit", fix: "round(...)" },
    { source: "let count = askInteger default: 2.0\nexit", fix: "round(...)" },
    { source: "let n = 1\nn = 1.5\nlet count = askInteger default: n\nexit", fix: "line 2" },
    { source: 'let count = askInteger default: "10"\nexit', fix: "'default: 10'" },
    { source: "let count = askInteger default: 9007199254740992\nexit", fix: "remove 'default:'" },
  ]) {
    const diagnostics = compileSource(source).diagnostics;
    assert.equal(diagnostics[0]?.code, "TSV039", source);
    assert.ok(diagnostics[0]?.message.includes(fix), diagnostics[0]?.message);
  }
  const plan = compileValidPlan(
    "function half(value) {\n  return value / 2\n}\nlet count = askInteger default: half(5)\nexit",
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.foregroundAction, null);
  assert.equal(result.snapshot.failure?.code, "TSR052");
  assert.ok(result.snapshot.failure?.message.includes("whole number"));
});

test("a checkpoint while the field is open restores the whole-number field and its default", () => {
  const session = createPlayerRuntimeSession(
    'let base = 3\nlet count = askInteger "How many?", default: base + 1\nexit',
  );
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
  assert.deepEqual(playerRuntimeForeground(restored), playerRuntimeForeground(session));
  assert.equal(answer(restored, "2.5").outcome.kind, "invalidPayload");
  assert.deepEqual(answer(restored, "4").session.snapshot, answer(session, "4").session.snapshot);
});

/** A malformed snapshot fails validation and cannot be restored from a checkpoint. */
function rejects(plan: InstructionPlan, snapshot: unknown): boolean {
  const checkpoint = createCheckpoint(plan, createFreshRuntimeSnapshot(plan));
  assert.throws(() => deserializeCheckpoint(JSON.stringify({ ...checkpoint, snapshot })));
  return !validateRuntimeSnapshot(snapshot, plan).valid;
}

/** The snapshot with `replay` as its retained settlement and `result` in the handoff and its destination. */
function withHandoffResult(snapshot: RuntimeSnapshot, replay: unknown, result: number) {
  const handoff = snapshot.interactionResultHandoff!;
  return {
    ...snapshot,
    lastSettlement: replay,
    interactionResultHandoff: { ...handoff, result },
    temporaries: snapshot.temporaries.map((temporary) =>
      temporary.id === handoff.destinationTemporary ? { ...temporary, value: result } : temporary,
    ),
  };
}

test("a handed-off askInteger result must be a safe whole number", () => {
  // A newer pacing settlement, left by an expiry block's message, is the retained replay record, so only the handoff
  // and its destination carry the answer.
  for (const ask of [
    'let count = askInteger "How many?"',
    'let level = 7\nlet count = askInteger "How many?", default: level',
  ]) {
    const plan = compileValidPlan(
      `timer async 1 { say "handler", 2 }\n${ask}\nsay count, instant\nexit`,
    );
    let snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
    snapshot = run(plan, observeTime(plan, snapshot, 1_000).snapshot).snapshot;
    const replay = snapshot.lastSettlement;
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction" && replay?.actionKind === "chatPacingGate");
    snapshot = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "number",
      payload: { kind: "submittedText", submittedText: "7" },
    }).snapshot;
    for (const result of [7, 2.5, 2 ** 60]) {
      const changed = withHandoffResult(snapshot, replay, result);
      if (result === 7) assert.equal(validateRuntimeSnapshot(changed, plan).valid, true, ask);
      else assert.ok(rejects(plan, changed), `${ask}: ${result}`);
    }
  }
});

test("plan and snapshot validation keep the whole-number rule", () => {
  const session = createPlayerRuntimeSession("let count = askInteger default: 10\nexit");
  const { plan, snapshot } = session;
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "number");
  for (const [name, ui] of [
    ["flag other than true", { ...action.ui, integer: false }],
    ["non-whole prefill", { ...action.ui, prefill: "2.5" }],
    ["missing flag", { ...action.ui, integer: undefined }],
  ] as const)
    assert.ok(rejects(plan, { ...snapshot, foregroundAction: { ...action, ui } }), name);

  const answered = answer(session, "7").session.snapshot;
  const settlement = answered.lastSettlement!;
  assert.ok(
    rejects(plan, { ...answered, lastSettlement: { ...settlement, transcriptText: "7.0" } }),
    "a decimal transcript for a whole-number answer",
  );

  const instruction = plan.instructions.find((candidate) => candidate.kind === "interaction")!;
  assert.ok("ui" in instruction && instruction.ui.kind === "number");
  const instructions = plan.instructions.map((candidate) =>
    candidate === instruction
      ? { ...instruction, ui: { ...instruction.ui, integer: "yes" } }
      : candidate,
  );
  assert.equal(validateInstructionPlan({ ...plan, instructions }).valid, false);
});
