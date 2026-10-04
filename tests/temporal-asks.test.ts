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
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { AMSTERDAM } from "./helpers/temporal-fixtures.js";

function start(source: string): PlayerRuntimeSession {
  return createPlayerRuntimeSession(source, { temporalContext: AMSTERDAM });
}

function answer(session: PlayerRuntimeSession, text: string) {
  const result = submitPlayerRuntimeComposer(session, text);
  assert.ok(result !== null, "a date or time field accepts composer text");
  return result;
}

function transcript(session: PlayerRuntimeSession): string[] {
  return session.transcriptEntries.map((entry) => entry.text);
}

test("askDate, askTime, and askDateTime return the ISO answer as a value", () => {
  for (const { command, kind, text, iso } of [
    { command: "askDate", kind: "ask-date", text: "2026-10-04", iso: "2026-10-04" },
    { command: "askTime", kind: "ask-time", text: "14:30", iso: "14:30" },
    { command: "askTime", kind: "ask-time", text: " 14:30:15 ", iso: "14:30:15" },
    {
      command: "askDateTime",
      kind: "ask-datetime",
      text: "2026-10-04T18:00",
      iso: "2026-10-04T18:00",
    },
    // A time the zone skips in spring is still a valid local value.
    {
      command: "askDateTime",
      kind: "ask-datetime",
      text: "2026-03-29T02:30",
      iso: "2026-03-29T02:30",
    },
  ] as const) {
    const session = start(`let value = ${command} "When?"\nsay value, instant\nsay value.toISO()`);
    assert.deepEqual(playerRuntimeForeground(session), {
      kind,
      accessibleName: "Answer",
      hint: "When?",
    });
    const answered = answer(session, text);
    assert.equal(answered.outcome.kind, "completed", text);
    assert.equal(answered.session.snapshot.status, "halted");
    // The transcript shows the answer as `say` shows the value, in the player's presentation.
    const [shownAnswer, said, toIso] = transcript(answered.session).slice(-3);
    assert.equal(shownAnswer, said, text);
    assert.equal(toIso, iso, text);
  }
});

test("a date or time field asks again for anything but strict ISO text", () => {
  for (const { command, message, texts } of [
    {
      command: "askDate",
      message: "That is wrong. I asked for a date.",
      texts: ["", "   ", "4-10-2026", "2026-02-30", "2026-10-04T18:00", "26-10-04", "20261004"],
    },
    {
      command: "askTime",
      message: "That is wrong. I asked for a time.",
      texts: ["", "2:30 PM", "24:00", "14:30Z", "14:30:15.2500", "14h30"],
    },
    {
      command: "askDateTime",
      message: "That is wrong. I asked for a date and time.",
      texts: ["", "2026-10-04", "2026-10-04 18:00", "2026-10-04T18:00Z", "2026-10-04T18:00+02:00"],
    },
  ]) {
    const session = start(`let value = ${command} "When?"`);
    for (const text of texts) {
      const rejected = answer(session, text);
      assert.equal(rejected.outcome.kind, "invalidPayload", `${command} ${JSON.stringify(text)}`);
      assert.equal(rejected.outcome.kind === "invalidPayload" && rejected.outcome.message, message);
      assert.deepEqual(rejected.session.snapshot, session.snapshot);
    }
  }
});

test("a default answer prefills the field as ISO text and submitting it returns the default", () => {
  for (const { source, prefill } of [
    { source: 'let value = askDate default: toDate("2026-10-04")', prefill: "2026-10-04" },
    { source: 'let value = askTime "At?", default: toTime("07:05:09")', prefill: "07:05:09" },
    {
      source:
        'let dinner = toDateTime("2026-10-04T18:00:15.250")\nlet value = askDateTime default: dinner',
      prefill: "2026-10-04T18:00:15.250",
    },
  ]) {
    const session = start(`${source}\nsay value.toISO()`);
    const foreground = playerRuntimeForeground(session);
    assert.equal(foreground !== null && "prefill" in foreground && foreground.prefill, prefill);
    // Clearing the field never falls back to the default.
    assert.equal(answer(session, "").outcome.kind, "invalidPayload");
    assert.equal(transcript(answer(session, prefill).session).at(-1), prefill, source);
    assert.equal(foreground !== null && "isoText" in foreground, false, source);
  }
  // A native date control has no year 0000, so the Player shows such a default as ISO text it can edit and submit.
  const yearZero = start('let value = askDate default: toDate("0000-01-01")\nsay value.toISO()');
  assert.deepEqual(playerRuntimeForeground(yearZero), {
    kind: "ask-date",
    accessibleName: "Answer",
    hint: "",
    prefill: "0000-01-01",
    isoText: true,
  });
  assert.equal(transcript(answer(yearZero, "0000-01-01").session).at(-1), "0000-01-01");
});

test("a default of another kind fails at compile time or before the field opens", () => {
  for (const { source, fix } of [
    {
      source: 'let value = askDate default: "2026-10-04"',
      fix: "Convert the text with toDate(...)",
    },
    { source: 'let value = askTime default: toDate("2026-10-04")', fix: "must be a time" },
    { source: "let value = askDateTime default: 5", fix: "must be a date and time" },
  ]) {
    const diagnostics = compileSource(source).diagnostics;
    assert.equal(diagnostics[0]?.code, "TSV039", source);
    assert.ok(diagnostics[0]?.message.includes(fix), diagnostics[0]?.message);
  }
  assert.ok(compileSource("let value: date = askTime").diagnostics.length > 0);

  const plan = compileValidPlan(
    'function same(text) {\n    return text\n}\nlet value = askDate default: same("2026-10-04")',
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan, { temporalContext: AMSTERDAM }));
  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.foregroundAction, null);
  assert.equal(result.snapshot.failure?.code, "TSR052");
  assert.ok(result.snapshot.failure?.message.includes("Convert the text with toDate(...)"));
});

test("a checkpoint while the field is open restores the control and its default", () => {
  const session = start(
    'let day = toDate("2026-10-04")\nlet value = askDate "Which day?", default: day',
  );
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
  assert.deepEqual(playerRuntimeForeground(restored), playerRuntimeForeground(session));
  assert.equal(answer(restored, "4-10-2026").outcome.kind, "invalidPayload");
  assert.deepEqual(
    answer(restored, "2026-10-05").session.snapshot,
    answer(session, "2026-10-05").session.snapshot,
  );
});

/** A malformed snapshot fails validation and cannot be restored from a checkpoint. */
function rejects(plan: InstructionPlan, snapshot: unknown): boolean {
  const checkpoint = createCheckpoint(plan, createFreshRuntimeSnapshot(plan));
  assert.throws(() => deserializeCheckpoint(JSON.stringify({ ...checkpoint, snapshot })));
  return !validateRuntimeSnapshot(snapshot, plan).valid;
}

test("plan and snapshot validation keep the date and time rules", () => {
  const session = start('let value = askTime default: toTime("14:30")');
  const { plan, snapshot } = session;
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "temporal");
  for (const [name, ui] of [
    ["unknown kind", { ...action.ui, temporalKind: "week" }],
    ["prefill of another kind", { ...action.ui, prefill: "2026-10-04" }],
    ["missing kind", { ...action.ui, temporalKind: undefined }],
  ] as const)
    assert.ok(rejects(plan, { ...snapshot, foregroundAction: { ...action, ui } }), name);

  const answered = answer(session, "09:15").session.snapshot;
  const settlement = answered.lastSettlement!;
  for (const [name, change] of [
    ["a result of another kind", { result: { kind: "date", year: 2026, month: 10, day: 4 } }],
    ["a text result", { result: "09:15" }],
    ["a transcript on two lines", { transcriptText: "09:15\n" }],
  ] as const)
    assert.ok(rejects(plan, { ...answered, lastSettlement: { ...settlement, ...change } }), name);

  const instruction = plan.instructions.find((candidate) => candidate.kind === "interaction")!;
  assert.ok("preparedUi" in instruction && instruction.preparedUi.kind === "temporal");
  const instructions = plan.instructions.map((candidate) =>
    candidate === instruction
      ? { ...instruction, preparedUi: { ...instruction.preparedUi, temporalKind: "week" } }
      : candidate,
  );
  assert.equal(validateInstructionPlan({ ...plan, instructions }).valid, false);
});
