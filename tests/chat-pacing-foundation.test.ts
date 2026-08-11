import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  CHECKPOINT_VERSION,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  calculatePacingDeadlineMs,
  calculateSmartPacingDurationMs,
  secondsToPacingMilliseconds,
} from "../src/runtime/actions/pacing.js";
import {
  RUNTIME_SNAPSHOT_VERSION,
  cloneRuntimeSnapshot,
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type ChatPacingSettings,
} from "../src/runtime/state.js";

function plan() {
  const compiled = compileSource("exit");
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}

function settings(
  overrides: Partial<ChatPacingSettings> = {},
): ChatPacingSettings {
  return {
    baseDelayMs: 1500,
    delayPerWordMs: 300,
    delayPerCharacterMs: 30,
    ...overrides,
  };
}

test("fresh runtime captures default and explicit chat pacing settings", () => {
  const compiled = plan();
  assert.deepEqual(createFreshRuntimeSnapshot(compiled).chatPacingSettings, settings());
  assert.deepEqual(
    createFreshRuntimeSnapshot(compiled, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).chatPacingSettings,
    settings({ baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 }),
  );
  assert.deepEqual(
    createFreshRuntimeSnapshot(compiled, {
      baseDelayMs: 17,
      delayPerWordMs: 19,
      delayPerCharacterMs: 23,
    }).chatPacingSettings,
    settings({ baseDelayMs: 17, delayPerWordMs: 19, delayPerCharacterMs: 23 }),
  );
});

test("fresh runtime rejects invalid captured chat pacing settings at its input boundary", () => {
  const compiled = plan();
  for (const [name, value] of [
    ["baseDelayMs", -1],
    ["delayPerWordMs", 0.5],
    ["delayPerCharacterMs", Number.MAX_SAFE_INTEGER + 1],
    ["baseDelayMs", Number.NaN],
    ["delayPerWordMs", Number.POSITIVE_INFINITY],
  ] as const) {
    assert.throws(() => createFreshRuntimeSnapshot(compiled, { [name]: value }));
  }
});

test("captured settings clone, validate, and checkpoint through JSON", () => {
  const compiled = plan();
  const snapshot = createFreshRuntimeSnapshot(compiled, {
    baseDelayMs: 17,
    delayPerWordMs: 19,
    delayPerCharacterMs: 23,
  });
  const cloned = cloneRuntimeSnapshot(snapshot);
  assert.notEqual(cloned.chatPacingSettings, snapshot.chatPacingSettings);
  assert.deepEqual(cloned.chatPacingSettings, snapshot.chatPacingSettings);
  assert.equal(validateRuntimeSnapshot(cloned, compiled).valid, true);

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, snapshot)),
  );
  assert.deepEqual(restored.snapshot.chatPacingSettings, snapshot.chatPacingSettings);
});

test("snapshot and checkpoint reject malformed persisted chat pacing settings", () => {
  const compiled = plan();
  const checkpoint = JSON.parse(serializeCheckpoint(
    createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled)),
  )) as { snapshot: { chatPacingSettings: Record<string, unknown> } };
  checkpoint.snapshot.chatPacingSettings.baseDelayMs = -1;

  assert.equal(validateRuntimeSnapshot(checkpoint.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)));
});

test("captured pacing settings and representable pacing arithmetic retain the safe-integer boundary", () => {
  const compiled = plan();
  assert.equal(
    createFreshRuntimeSnapshot(compiled, {
      baseDelayMs: Number.MAX_SAFE_INTEGER,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).chatPacingSettings.baseDelayMs,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    calculateSmartPacingDurationMs("", settings({
      baseDelayMs: Number.MAX_SAFE_INTEGER,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    })),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    calculateSmartPacingDurationMs("word", settings({
      baseDelayMs: 0,
      delayPerWordMs: Number.MAX_SAFE_INTEGER,
      delayPerCharacterMs: 0,
    })),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(calculatePacingDeadlineMs(0, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("snapshot and checkpoint reject their previous versions", () => {
  const compiled = plan();
  const snapshot = createFreshRuntimeSnapshot(compiled) as unknown as { version: number };
  snapshot.version = RUNTIME_SNAPSHOT_VERSION - 1;
  assert.deepEqual(validateRuntimeSnapshot(snapshot, compiled).errors, [
    "Unsupported runtime-snapshot version.",
  ]);

  const checkpoint = createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled));
  assert.throws(() => deserializeCheckpoint(JSON.stringify({
    ...checkpoint,
    version: CHECKPOINT_VERSION - 1,
  })));
});

test("smart pacing duration counts words, whitespace, and Unicode code points", () => {
  assert.equal(calculateSmartPacingDurationMs("one two", settings()), 2100);
  assert.equal(calculateSmartPacingDurationMs(" one\t\ntwo  ", settings()), 2100);
  assert.equal(
    calculateSmartPacingDurationMs("😀", settings({ baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 10 })),
    10,
  );
  assert.equal(
    calculateSmartPacingDurationMs("anything", settings({ baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 })),
    0,
  );
});

test("smart pacing counts large text without changing word semantics", () => {
  const text = "word ".repeat(20_000);
  assert.equal(
    calculateSmartPacingDurationMs(
      text,
      settings({ baseDelayMs: 0, delayPerWordMs: 1, delayPerCharacterMs: 0 }),
    ),
    20_000,
  );
});

test("smart pacing duration rejects multiplication and addition overflow", () => {
  assert.throws(() => calculateSmartPacingDurationMs(
    "aa",
    settings({ baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: Number.MAX_SAFE_INTEGER }),
  ));
  assert.throws(() => calculateSmartPacingDurationMs(
    "a",
    settings({ baseDelayMs: Number.MAX_SAFE_INTEGER, delayPerWordMs: 1, delayPerCharacterMs: 0 }),
  ));
});

test("exact pacing seconds preserve fractional milliseconds and reject unsupported values", () => {
  assert.equal(secondsToPacingMilliseconds(0), 0);
  assert.equal(secondsToPacingMilliseconds(2), 2000);
  assert.equal(secondsToPacingMilliseconds(1.5), 1500);
  assert.equal(secondsToPacingMilliseconds(0.0005), 0.5);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, "1"]) {
    assert.throws(() => secondsToPacingMilliseconds(value));
  }
});

test("pacing deadlines remain within session-time representation and move forward", () => {
  assert.equal(calculatePacingDeadlineMs(10, 0), 10);
  assert.equal(calculatePacingDeadlineMs(10, 0.5), 10.5);
  assert.throws(() => calculatePacingDeadlineMs(Number.MAX_SAFE_INTEGER, 1));
  assert.throws(() => calculatePacingDeadlineMs(Number.MAX_SAFE_INTEGER, 0.5));
});
