import assert from "node:assert/strict";
import test from "node:test";
import {
  completeAction,
  createCheckpoint,
  createFreshRuntimeSession,
  createFreshRuntimeSnapshot,
  restoreRuntimeSession,
  deserializeCheckpoint,
  observeTime,
  reportMediaLoad,
  run,
  executeInstruction,
  inspectRuntimeState,
  serializeCheckpoint,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../../../src/index.js";
import { compileValidPlan as plan } from "../../helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../../helpers/runtime-equivalence.js";

/** The message for a session-only `kind`, saved directly or nested in an object. */
const unstorableMessage = (kind: string, nested: boolean) =>
  `save cannot store ${nested ? `this object: it holds ${kind}, which exists` : `${kind}: it exists`} only in the current session. ${kind === "a message handle" ? "Save a message's text with its text property, as in 'save line.text as \"status\"'." : "Save values such as text, numbers, or lists instead."}`;

/**
 * The compact and the bounded spelling of `load`, which behave the same. Without a fallback, the default is `null` and
 * the key is computed, so the load reads stored data of any type.
 */
const loadSpellings = [
  (key: string, fallback?: string) =>
    fallback === undefined
      ? `load ${key} + "", default: null`
      : `load ${key}, default: ${fallback}`,
  (key: string, fallback?: string) =>
    fallback === undefined
      ? `load(${key} + "", default: null)`
      : `load(${key}, default: ${fallback})`,
] as const;

function binding(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const found = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(found !== undefined, `binding ${name} exists`);
  return found.value;
}

function storageWrite(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "storageWrite");
  return action;
}

test("host-acknowledged saves seed a new session without losing stored value types", () => {
  const writer = plan(
    [
      'save "Ada" as "name"',
      'save 2.5 as "score"',
      'save false as "enabled"',
      'let savedList: (integer | string | null)[] = [1, null, "two"]',
      'save savedList as "list"',
      'save { nested: [true, null] } as "object"',
      'save set["a", "b"] as "set"',
      'save 2..=5 as "range"',
      'save 1.5 s as "duration"',
      'save pi rad as "angle"',
      "exit",
    ].join("\n"),
  );
  const expected: { key: string; value: SerializableRuntimeValue }[] = [
    { key: "name", value: "Ada" },
    { key: "score", value: 2.5 },
    { key: "enabled", value: false },
    { key: "list", value: { kind: "list", items: [1, null, "two"] } },
    {
      key: "object",
      value: {
        kind: "object",
        properties: [{ name: "nested", value: { kind: "list", items: [true, null] } }],
      },
    },
    { key: "set", value: { kind: "set", items: ["a", "b"] } },
    { key: "range", value: { kind: "range", start: 2, end: 5, inclusive: true } },
    { key: "duration", value: { kind: "duration", milliseconds: 1_500 } },
    { key: "angle", value: { kind: "angle", degrees: 180 } },
  ];
  const recorded: { key: string; value: SerializableRuntimeValue }[] = [];
  let written = run(writer, createFreshRuntimeSnapshot(writer, { persistentScriptStorage: true }));
  for (const entry of expected) {
    const action = storageWrite(written.snapshot);
    assert.deepEqual({ key: action.key, value: action.value }, entry);
    const acknowledged = completeAction(writer, written.snapshot, {
      actionId: action.actionId,
      actionKind: "storageWrite",
      payload: { kind: "stored" },
    });
    assert.equal(acknowledged.outcome.kind, "completed");
    recorded.push({ key: action.key, value: action.value });
    written = run(writer, acknowledged.snapshot);
  }
  assert.equal(written.snapshot.status, "halted");
  assert.deepEqual(recorded, expected);
  assert.deepEqual(
    written.snapshot.scriptStorage,
    [...expected].sort((a, b) => a.key.localeCompare(b.key)),
  );

  const reader = plan(
    [
      ...expected.map(({ key }, index) => `let loaded${index} = load "${key}" + "", default: null`),
      "exit",
    ].join("\n"),
  );
  const read = run(reader, createFreshRuntimeSnapshot(reader, { scriptStorage: recorded }));
  assert.equal(read.snapshot.status, "halted");
  for (const [index, entry] of expected.entries()) {
    assert.deepEqual(binding(read.snapshot, `loaded${index}`), entry.value, entry.key);
  }
  assert.deepEqual(read.snapshot.scriptStorage, written.snapshot.scriptStorage);
});

test("persistent writes wait with the old view until stored acknowledges the evaluated operands", () => {
  for (const [command, value, initial] of [
    ['save 2 + 1 as "${key}"', 3, [{ key: "k", value: 1 }]],
    ['delete "${key}"', null, [{ key: "k", value: 1 }]],
    ['save null as "${key}"', null, [{ key: "k", value: 1 }]],
    ['delete "${key}"', null, []],
  ] as const) {
    const compiled = plan(
      `let key = "k"\n${command}\nlet loaded = load "k" + "", default: null\nexit`,
    );
    const pending = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, {
        persistentScriptStorage: true,
        scriptStorage: initial,
      }),
    );
    assert.equal(pending.snapshot.status, "waiting", command);
    assert.deepEqual(pending.snapshot.scriptStorage, initial, command);
    const action = storageWrite(pending.snapshot);
    assert.deepEqual({ key: action.key, value: action.value }, { key: "k", value });
    assert.deepEqual(pending.snapshot.backgroundActions, []);
    assert.equal(pending.events.length, 1);
    const requested = pending.events[0]!;
    assert.ok(requested.kind === "actionRequested");
    assert.deepEqual(requested.action, action);
    assert.equal(action.requestEventSequence, requested.sequence);

    const acknowledged = completeAction(compiled, pending.snapshot, {
      actionId: action.actionId,
      actionKind: "storageWrite",
      payload: { kind: "stored" },
    });
    assert.ok(acknowledged.outcome.kind === "completed");
    assert.equal(acknowledged.events.length, 1);
    const completed = acknowledged.events[0]!;
    assert.ok(completed.kind === "actionCompleted");
    const settlement = {
      actionId: action.actionId,
      actionKind: "storageWrite",
      settlementKind: "completed",
      outcome: "stored",
      key: "k",
      owningInstruction: action.owningInstruction,
      continuationInstruction: action.continuationInstruction,
      requestEventSequence: requested.sequence,
      completionEventSequence: completed.sequence,
      completedAtMs: 0,
    };
    assert.deepEqual(completed.settlement, settlement);
    assert.deepEqual(acknowledged.outcome.settlement, settlement);
    assert.deepEqual(acknowledged.snapshot.lastSettlement, settlement);
    const committed = value === null ? [] : [{ key: "k", value }];
    assert.deepEqual(acknowledged.snapshot.scriptStorage, committed);
    const finished = run(compiled, acknowledged.snapshot);
    assert.equal(finished.snapshot.status, "halted");
    assert.equal(binding(finished.snapshot, "loaded"), value);
    assert.deepEqual(finished.snapshot.scriptStorage, committed);
  }
});

test("failed persistent saves and deletes keep the old value or absence and allow lazy fallback", () => {
  for (const command of ['save 2 as "k"', 'delete "k"']) {
    for (const previous of [7, null]) {
      const initial = previous === null ? [] : [{ key: "k", value: previous }];
      const compiled = plan(
        [
          "let calls = 0",
          "function backup { calls += 1\nreturn 9 }",
          command,
          'let plain = load "k" + "", default: null',
          'let withDefault = load "k", default: backup()',
          'let stillMissing = load "k" + "", default: null',
          "exit",
        ].join("\n"),
      );
      const pending = run(
        compiled,
        createFreshRuntimeSnapshot(compiled, {
          persistentScriptStorage: true,
          scriptStorage: initial,
        }),
      );
      const action = storageWrite(pending.snapshot);
      const failed = completeAction(compiled, pending.snapshot, {
        actionId: action.actionId,
        actionKind: "storageWrite",
        payload: { kind: "failed" },
      });
      assert.ok(failed.outcome.kind === "completed");
      assert.deepEqual(failed.snapshot.scriptStorage, initial);
      const completed = failed.events.find((event) => event.kind === "actionCompleted");
      assert.ok(completed?.kind === "actionCompleted");
      assert.deepEqual(failed.snapshot.lastSettlement, {
        actionId: action.actionId,
        actionKind: "storageWrite",
        settlementKind: "completed",
        outcome: "failed",
        key: "k",
        owningInstruction: action.owningInstruction,
        continuationInstruction: action.continuationInstruction,
        requestEventSequence: action.requestEventSequence,
        completionEventSequence: completed.sequence,
        completedAtMs: 0,
      });
      assert.deepEqual(completed.settlement, failed.snapshot.lastSettlement);
      assert.deepEqual(failed.outcome.settlement, failed.snapshot.lastSettlement);
      const finished = run(compiled, failed.snapshot);
      assert.equal(finished.snapshot.status, "halted");
      assert.equal(binding(finished.snapshot, "plain"), previous);
      assert.equal(binding(finished.snapshot, "withDefault"), previous ?? 9);
      assert.equal(binding(finished.snapshot, "calls"), previous === null ? 1 : 0);
      assert.equal(binding(finished.snapshot, "stillMissing"), previous);
      assert.deepEqual(finished.snapshot.scriptStorage, initial);
      assert.deepEqual(
        failed.events
          .filter((event) => event.kind === "developerWarning")
          .map(({ code, message }) => ({ code, message })),
        [
          {
            code: "TSW014",
            message: `${command.startsWith("save") ? "save" : "delete"} could not persist "k", so the previous value is kept.`,
          },
        ],
      );
      assert.deepEqual(
        finished.events.filter((event) => event.kind === "developerWarning"),
        [],
      );
    }
  }
});

test("storage write completion rejects invalid payloads and wrong action kinds, then settles only once", () => {
  const compiled = plan('save 2 as "k"\nexit');
  const pending = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  );
  const action = storageWrite(pending.snapshot);
  const request = { actionId: action.actionId, actionKind: "storageWrite" };
  for (const payload of [null, {}, { kind: "unknown" }]) {
    const invalid = completeAction(compiled, pending.snapshot, { ...request, payload });
    assert.equal(invalid.outcome.kind, "invalidPayload");
    assert.deepEqual(invalid.snapshot, pending.snapshot);
    assert.deepEqual(invalid.events, []);
  }
  const wrong = completeAction(compiled, pending.snapshot, {
    ...request,
    actionKind: "interaction",
    payload: { kind: "stored" },
  });
  assert.equal(wrong.outcome.kind, "wrongActionKind");
  assert.deepEqual(wrong.snapshot, pending.snapshot);
  assert.deepEqual(wrong.events, []);
  const completion = { ...request, payload: { kind: "stored" } };
  const settled = completeAction(compiled, pending.snapshot, completion);
  assert.equal(settled.outcome.kind, "completed");
  const repeated = completeAction(compiled, settled.snapshot, completion);
  assert.deepEqual(repeated.outcome, {
    kind: "alreadySettled",
    settlement: settled.snapshot.lastSettlement,
  });
  assert.deepEqual(repeated.snapshot, settled.snapshot);
  assert.deepEqual(repeated.events, []);
});

test("default session-local storage changes immediately without actions, events, or warnings", () => {
  const compiled = plan(
    'save 1 as "z"\nsave 2 as "a"\nlet saved = load "z" + "", default: null\ndelete "z"\nlet deleted = load "z" + "", default: null\nexit',
  );
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(result.snapshot.status, "halted");
  assert.equal(result.snapshot.scriptStoragePersistent, false);
  assert.equal(binding(result.snapshot, "saved"), 1);
  assert.equal(binding(result.snapshot, "deleted"), null);
  assert.deepEqual(result.snapshot.scriptStorage, [{ key: "a", value: 2 }]);
  assert.equal(result.snapshot.foregroundAction, null);
  assert.deepEqual(result.snapshot.backgroundActions, []);
  assert.deepEqual(
    result.events.map(({ kind }) => kind),
    ["exit"],
  );
});

test("pending persistent writes complete identically after a JSON checkpoint round trip", () => {
  const compiled = plan(
    'save [1, null] as "list"\nlet loaded = load "list" + "", default: null\nexit',
  );
  const pending = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  );
  const action = storageWrite(pending.snapshot);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, pending.snapshot)),
  );
  assert.deepEqual(restored.snapshot, pending.snapshot);
  for (const kind of ["stored", "failed"]) {
    const completion = { actionId: action.actionId, actionKind: "storageWrite", payload: { kind } };
    const directCompletion = completeAction(compiled, pending.snapshot, completion);
    const restoredCompletion = completeAction(restored.plan, restored.snapshot, completion);
    assert.equal(directCompletion.outcome.kind, "completed");
    assert.deepEqual(restoredCompletion, directCompletion);
    const direct = run(compiled, directCompletion.snapshot);
    const resumed = run(restored.plan, restoredCompletion.snapshot);
    assert.equal(resumed.snapshot.status, "halted");
    assert.deepEqual(resumed.snapshot, direct.snapshot);
    assert.deepEqual(
      [...pending.events, ...restoredCompletion.events, ...resumed.events],
      [...pending.events, ...directCompletion.events, ...direct.events],
    );
  }
});

test("a due timer block waits for the write and reads the acknowledged value at its due scene time", () => {
  const compiled = plan(
    [
      "let seen = null",
      "let elapsed = null",
      "let clock = timer async 20 s",
      'timer async 1 s { seen = load "k" + "", default: null\nelapsed = clock.elapsed }',
      'save 2 as "k"',
      "wait 10 s",
      "exit",
    ].join("\n"),
  );
  const pending = run(
    compiled,
    createImmediatePacingRuntimeSnapshot(compiled, {
      persistentScriptStorage: true,
      scriptStorage: [{ key: "k", value: 1 }],
    }),
  );
  const action = storageWrite(pending.snapshot);
  const late = observeTime(compiled, pending.snapshot, 5_000);
  assert.equal(late.outcome.kind, "observed");
  const held = run(compiled, late.snapshot);
  assert.equal(held.snapshot.status, "waiting");
  assert.deepEqual(storageWrite(held.snapshot), action);
  assert.equal(held.snapshot.currentSessionTimeMs, 1_000);
  assert.equal(held.snapshot.observedSessionTimeMs, 5_000);
  assert.equal(binding(held.snapshot, "seen"), null);
  assert.deepEqual(held.snapshot.scriptStorage, [{ key: "k", value: 1 }]);
  const later = observeTime(compiled, held.snapshot, 6_000);
  assert.equal(later.outcome.kind, "observed");
  assert.equal(later.snapshot.currentSessionTimeMs, 1_000);
  assert.equal(later.snapshot.observedSessionTimeMs, 6_000);
  const completed = completeAction(compiled, later.snapshot, {
    actionId: action.actionId,
    actionKind: "storageWrite",
    payload: { kind: "stored" },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.ok(completed.snapshot.lastSettlement?.actionKind === "storageWrite");
  assert.equal(completed.snapshot.lastSettlement.completedAtMs, 1_000);
  assert.equal(binding(completed.snapshot, "seen"), null);
  const caughtUp = run(compiled, completed.snapshot);
  assert.equal(binding(caughtUp.snapshot, "seen"), 2);
  assert.deepEqual(binding(caughtUp.snapshot, "elapsed"), {
    kind: "duration",
    milliseconds: 1_000,
  });
  assert.equal(caughtUp.snapshot.currentSessionTimeMs, 6_000);
  assert.equal(caughtUp.snapshot.observedSessionTimeMs, 6_000);
});

test("a final save runs on into exit after acknowledgement, also after a reading time", () => {
  for (const source of ['save 2 as "k"\nexit', 'say "Before"\nsave 2 as "k"\nexit']) {
    const compiled = plan(source);
    let pending = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
    );
    assert.equal(pending.snapshot.status, "waiting");
    if (source.startsWith("say")) {
      // The save starts only when the message's reading time ends.
      const gate = pending.snapshot.foregroundAction;
      assert.equal(gate?.kind, "chatPacingGate");
      pending = run(compiled, observeTime(compiled, pending.snapshot, gate!.deadlineMs).snapshot);
    }
    const action = storageWrite(pending.snapshot);
    const completed = completeAction(compiled, pending.snapshot, {
      actionId: action.actionId,
      actionKind: "storageWrite",
      payload: { kind: "stored" },
    });
    assert.equal(completed.outcome.kind, "completed");
    const finished = run(compiled, completed.snapshot);
    assert.equal(finished.snapshot.status, "halted");
    assert.deepEqual(finished.snapshot.scriptStorage, [{ key: "k", value: 2 }]);
    assert.deepEqual(
      [...completed.events, ...finished.events]
        .filter((event) => event.kind === "exit")
        .map(({ kind }) => kind),
      ["exit"],
    );
  }
});

test("absent loads return null or the default without storing it", () => {
  for (const load of loadSpellings) {
    const result = assertRuntimeResumeEquivalent(
      `let missing = ${load('"k"')}\nlet backup = ${load('"k"', "7")}\nlet stillMissing = ${load('"k"')}\nexit`,
    );
    assert.equal(binding(result.finalSnapshot, "missing"), null);
    assert.equal(binding(result.finalSnapshot, "backup"), 7);
    assert.equal(binding(result.finalSnapshot, "stillMissing"), null);
    assert.deepEqual(result.finalSnapshot.scriptStorage, []);
  }
});

test("present loads skip side effects and blocking interactions in defaults", () => {
  for (const load of loadSpellings) {
    const result = assertRuntimeResumeEquivalent(
      [
        'save "Ada" as "name"',
        "let calls = 0",
        'function backup { calls = calls + 1\nreturn "backup" }',
        `let fromFunction = ${load('"name"', "backup()")}`,
        `let fromPrompt = ${load('"name"', 'askText "Your name?"')}`,
        `let fromRandom = ${load('"name"', '["a", "b"].random')}`,
        "exit",
      ].join("\n"),
    );
    assert.equal(binding(result.finalSnapshot, "calls"), 0);
    assert.equal(binding(result.finalSnapshot, "fromFunction"), "Ada");
    assert.equal(binding(result.finalSnapshot, "fromPrompt"), "Ada");
    assert.equal(binding(result.finalSnapshot, "fromRandom"), "Ada");
    // The unused random default draws nothing.
    assert.deepEqual(result.finalSnapshot.rng, result.boundaries[0]!.rng);
    assert.deepEqual(
      result.events.filter((event) => event.kind === "actionRequested"),
      [],
    );
  }
});

test("an absent load resumes its blocking function default at every instruction boundary", () => {
  for (const load of loadSpellings) {
    const result = assertRuntimeResumeEquivalent(
      [
        "let calls = 0",
        'function backup { calls = calls + 1\nwait 1 ms\nreturn "Ada" }',
        `let name = ${load('"name"', "backup()")}`,
        `let missing = ${load('"name"')}`,
        "exit",
      ].join("\n"),
    );
    assert.ok(result.boundaries.some((snapshot) => snapshot.status === "waiting"));
    assert.equal(binding(result.finalSnapshot, "calls"), 1);
    assert.equal(binding(result.finalSnapshot, "name"), "Ada");
    assert.equal(binding(result.finalSnapshot, "missing"), null);
    assert.deepEqual(result.finalSnapshot.scriptStorage, []);
  }
});

test("an absent load suspends for askText and resumes after a JSON checkpoint round trip", () => {
  for (const load of loadSpellings) {
    const compiled = plan(
      `let name = ${load('"name"', 'askText "Your name?"')}\nlet stillMissing = ${load('"name"')}\nsave name as "name"\nexit`,
    );
    const pending = run(compiled, createFreshRuntimeSnapshot(compiled));
    assert.equal(pending.snapshot.status, "waiting");
    const action = pending.snapshot.foregroundAction;
    assert.equal(action?.kind, "interaction");
    assert.ok(action?.kind === "interaction");
    assert.equal(action.interactionKind, "text");
    assert.deepEqual(pending.snapshot.scriptStorage, []);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(compiled, pending.snapshot)),
    );
    assert.deepEqual(restored.snapshot, pending.snapshot);

    const completion = {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: "Ada" },
    } as const;
    const directCompletion = completeAction(compiled, pending.snapshot, completion);
    const restoredCompletion = completeAction(restored.plan, restored.snapshot, completion);
    assert.equal(directCompletion.outcome.kind, "completed");
    assert.equal(restoredCompletion.outcome.kind, "completed");
    const direct = run(compiled, directCompletion.snapshot);
    const resumed = run(restored.plan, restoredCompletion.snapshot);
    assert.equal(resumed.snapshot.status, "halted");
    assert.deepEqual(resumed.snapshot, direct.snapshot);
    assert.deepEqual(
      [...pending.events, ...restoredCompletion.events, ...resumed.events],
      [...pending.events, ...directCompletion.events, ...direct.events],
    );
    assert.equal(binding(resumed.snapshot, "name"), "Ada");
    assert.equal(binding(resumed.snapshot, "stillMissing"), null);
    assert.deepEqual(resumed.snapshot.scriptStorage, [{ key: "name", value: "Ada" }]);
  }
});

test("same-session loads see saves and copy nested collections in both directions", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let original = [{ items: [1] }]",
      'save original as "k"',
      "original[0].items.add(2)",
      'let loaded = load "k" + "", default: null',
      "loaded[0].items.add(3)",
      'let reloaded = load("k" + "", default: null)',
      "exit",
    ].join("\n"),
  );
  const stored: SerializableRuntimeValue = {
    kind: "list",
    items: [
      { kind: "object", properties: [{ name: "items", value: { kind: "list", items: [1] } }] },
    ],
  };
  assert.deepEqual(binding(result.finalSnapshot, "reloaded"), stored);
  assert.deepEqual(result.finalSnapshot.scriptStorage, [{ key: "k", value: stored }]);
  assert.deepEqual(binding(result.finalSnapshot, "original"), {
    kind: "list",
    items: [
      { kind: "object", properties: [{ name: "items", value: { kind: "list", items: [1, 2] } }] },
    ],
  });
  assert.deepEqual(binding(result.finalSnapshot, "loaded"), {
    kind: "list",
    items: [
      { kind: "object", properties: [{ name: "items", value: { kind: "list", items: [1, 3] } }] },
    ],
  });
});

test("session-local save null and delete remove keys, including an absent key", () => {
  const result = assertRuntimeResumeEquivalent(
    'save 1 as "k"\nsave null as "k"\nlet afterNull = load "k" + "", default: null\nsave 2 as "k"\nlet replaced = load "k" + "", default: null\ndelete "k"\ndelete "absent"\nlet missing = load "k" + "", default: null\nexit',
  );
  assert.equal(binding(result.finalSnapshot, "afterNull"), null);
  assert.equal(binding(result.finalSnapshot, "replaced"), 2);
  assert.equal(binding(result.finalSnapshot, "missing"), null);
  assert.deepEqual(result.finalSnapshot.scriptStorage, []);
});

test("storage operands evaluate in source order and present loads skip their defaults", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let order = []",
      "function mark(value) { order.add(value)\nreturn value }",
      'save mark("value") as mark("key")',
      'let present = load mark("key"), default: mark("unused")',
      'delete mark("key")',
      'let absent = load(mark("missing"), default: mark("default"))',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(binding(result.finalSnapshot, "order"), {
    kind: "list",
    items: ["value", "key", "key", "key", "missing", "default"],
  });
  assert.equal(binding(result.finalSnapshot, "present"), "value");
  assert.equal(binding(result.finalSnapshot, "absent"), "default");
});

test("string-producing keys compile and run for save, load, and delete", () => {
  const keys = ["keys[0]", "key", "keyFunction()", "record.key", '"${key}-interpolated"'];
  const result = assertRuntimeResumeEquivalent(
    [
      'let key = "variable"',
      'let keys = ["indexed"]',
      'let record = { key: "property" }',
      'function keyFunction { return "function" }',
      ...keys.flatMap((key, index) => [
        `save 7 as ${key}`,
        `let loaded${index} = load ${key}, default: null`,
        `delete ${key}`,
      ]),
      "exit",
    ].join("\n"),
  );
  for (const index of keys.keys()) assert.equal(binding(result.finalSnapshot, `loaded${index}`), 7);
  assert.deepEqual(result.finalSnapshot.scriptStorage, []);
});

test("dynamic non-string keys fail with TSR054 and the command's message", () => {
  // `dynamic` hides the key's type from the compiler, which rejects a known non-string key before runtime.
  for (const [command, use] of [
    ["let value = load key, default: null", "load"],
    ["save 7 as key", "save"],
    ["delete key", "delete"],
  ]) {
    const message = `Cannot ${use} with key 1: storage keys must be text (string). Use "1" as the key, or convert the number with the toString function.`;
    const compiled = plan(
      `function dynamic(input) {\n  return input\n}\nlet key = dynamic(1)\n${command}\nexit`,
    );
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    assert.equal(result.snapshot.status, "failed", command);
    assert.equal(result.snapshot.failure?.code, "TSR054", command);
    assert.equal(result.snapshot.failure?.message, message, command);
    assert.deepEqual(result.snapshot.scriptStorage, [], command);
  }
  // A key that is true or false is most often a comparison that the load took as its key.
  const compiled = plan(
    "function dynamic(input) {\n  return input\n}\nlet key = dynamic(true)\nlet value = load key, default: null\nexit",
  );
  assert.equal(
    run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot.failure?.message,
    "Cannot load with key true: storage keys must be text (string). If you meant to compare the loaded value, load the value into a variable first and compare the variable.",
  );
});

test("save rejects session handles and speaker references at the top level and nested with the compiler's TSV043", () => {
  for (const [declaration, kind] of [
    ["let handle = timer async 1 s", "a timer handle"],
    ['let handle = playAudio async "a.mp3"', "a media handle"],
    ["speaker vera {}\nlet handle = vera", "a speaker"],
    ['let handle = say "Shown", instant', "a message handle"],
  ] as const) {
    for (const value of ["handle", "{ nested: [handle] }"]) {
      // `dynamic` hides the value's type from the compiler, which rejects a known speaker or handle before runtime.
      const source = `function dynamic(value) {\n  return value\n}\n${declaration}\nsave dynamic(${value}) as "k"\nexit`;
      const compiled = plan(source);
      let result = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
      if (declaration.includes("playAudio")) {
        assert.equal(result.snapshot.status, "waiting");
        const media = result.snapshot.backgroundActions.find((action) => action.kind === "media");
        assert.ok(media?.kind === "media");
        const loaded = reportMediaLoad(compiled, result.snapshot, media.media.mediaId, {
          kind: "loaded",
          durationMs: 1_000,
        });
        assert.equal(loaded.outcome.kind, "accepted");
        result = run(compiled, loaded.snapshot);
      }
      assert.equal(result.snapshot.status, "failed", `${declaration}: ${value}`);
      assert.equal(result.snapshot.failure?.code, "TSV043");
      assert.equal(result.snapshot.failure?.message, unstorableMessage(kind, value !== "handle"));
      assert.deepEqual(result.snapshot.scriptStorage, []);
    }
  }
});

test("a declared load ignores a stored value of another type and uses its default", () => {
  for (const [type, fallback, value, saved] of [
    ["number", "0", "stored", "is text (string)"],
    ["integer", "0", 1.5, "is a number"],
    ["string[]", "[]", { kind: "list", items: ["a", 1] }, "has a whole number (integer) at [1]"],
    ["integer set", "set[]", { kind: "set", items: [1, 1.5] }, "has a number at [1]"],
    ["date", 'toDate("2026-01-01")', "2026-10-02", "is text (string)"],
    ["time", 'toTime("12:00")', "12:00", "is text (string)"],
    ["datetime", 'toDateTime("2026-01-01T12:00")', "2026-10-02T12:00:00Z", "is text (string)"],
  ] satisfies readonly (readonly [string, string, SerializableRuntimeValue, string])[]) {
    const compiled = plan(`let value: ${type} = load "k", default: ${fallback}\nexit`);
    const result = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value }] }),
    );
    assert.equal(result.snapshot.status, "halted", type);
    const warning = result.events.find((event) => event.kind === "developerWarning");
    assert.equal(warning?.kind === "developerWarning" && warning.code, "TSW016", type);
    assert.match(
      warning?.kind === "developerWarning" ? warning.message : "",
      new RegExp(`but the saved value ${saved.replace(/[()[\]]/gu, "\\$&")}\\.`, "u"),
      type,
    );
    assert.deepEqual(result.snapshot.scriptStorage, [{ key: "k", value }], type);
  }
});

test("typed load initializers accept matching scalars, collections, integers, and optional types", () => {
  for (const [type, fallback, value] of [
    ["string", '""', "stored"],
    ["boolean", "true", false],
    ["number", "0", 1.5],
    ["integer", "0", 2],
    ["duration", "0 s", { kind: "duration", milliseconds: 1_500 }],
    ["string[]", "[]", { kind: "list", items: ["a", "b"] }],
    ["integer set", "set[]", { kind: "set", items: [1, 2] }],
    ["number?", "null", 3],
  ] satisfies readonly (readonly [string, string, SerializableRuntimeValue])[]) {
    const compiled = plan(`let value: ${type} = load "k", default: ${fallback}\nexit`);
    const result = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value }] }),
    );
    assert.equal(result.snapshot.status, "halted", type);
    assert.deepEqual(binding(result.snapshot, "value"), value, type);
  }
});

test("a load the compiler cannot type is checked where its value is stored", () => {
  const storage = [{ key: "k", value: "stored" }];
  const failure = (source: string) => {
    const compiled = plan(`function identity(value) { return value }\n${source}\nexit`);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled, { scriptStorage: storage }));
    return [result.snapshot.failure?.code, result.snapshot.failure?.message];
  };
  // A load checks a default it cannot know against its own type before the variable takes it.
  assert.deepEqual(failure('let backup: number = load("missing", default: identity("backup"))'), [
    "TSR058",
    'Storage key "missing" holds a number or null, so it cannot take text (string) "backup".',
  ]);
  assert.deepEqual(failure('let assigned: number = 0\nassigned = load "k" + "", default: 0'), [
    "TSR058",
    `'assigned' holds a number, so it cannot take text (string) "stored".`,
  ]);
  assert.deepEqual(failure('let indirect: number = identity(load "k" + "", default: null)'), [
    "TSR058",
    `'indirect' holds a number, so it cannot take text (string) "stored".`,
  ]);

  const optional = plan(
    'let missing: number? = load("missing" + "", default: null)\nlet text: string = load "k", default: ""\nexit',
  );
  const result = run(optional, createFreshRuntimeSnapshot(optional, { scriptStorage: storage }));
  assert.equal(result.snapshot.status, "halted");
  assert.equal(binding(result.snapshot, "missing"), null);
  assert.equal(binding(result.snapshot, "text"), "stored");
  assert.deepEqual(result.snapshot.scriptStorage, storage);
});

test("deleting a key keeps every other stored key readable and writable", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'save 1 as "a"',
      'save 2 as "b"',
      'save 3 as "c"',
      'delete "a"',
      'save 4 as "d"',
      'save 20 as "b"',
      'let a = load "a" + "", default: null',
      'let b = load "b" + "", default: null',
      'let c = load "c" + "", default: null',
      'let d = load "d" + "", default: null',
      "exit",
    ].join("\n"),
  );
  assert.equal(binding(result.finalSnapshot, "a"), null);
  assert.equal(binding(result.finalSnapshot, "b"), 20);
  assert.equal(binding(result.finalSnapshot, "c"), 3);
  assert.equal(binding(result.finalSnapshot, "d"), 4);
  assert.deepEqual(result.finalSnapshot.scriptStorage, [
    { key: "b", value: 20 },
    { key: "c", value: 3 },
    { key: "d", value: 4 },
  ]);
});

test("save keeps the value it evaluated before its key expression runs", () => {
  for (const source of [
    'let items = [1]\nsave items as "k${items.clear()}"\nlet stored = load "knull" + "", default: null\nexit',
    'let items = [1]\nfunction clearItems { items.clear()\nreturn "knull" }\nsave items as clearItems()\nlet stored = load "knull" + "", default: null\nexit',
  ]) {
    const result = assertRuntimeResumeEquivalent(source);
    const kept = { kind: "list", items: [1] };
    assert.deepEqual(binding(result.finalSnapshot, "stored"), kept, source);
    assert.deepEqual(result.finalSnapshot.scriptStorage, [{ key: "knull", value: kept }], source);
  }
});

test("a write inside a timer block holds catch-up for the next due block", () => {
  const compiled = plan(
    [
      "let clock = timer async 20 s",
      "let seen = null",
      'timer async 1 s { save 2 as "k" }',
      "timer async 2 s { seen = clock.elapsed }",
      "wait 10 s",
      "exit",
    ].join("\n"),
  );
  let snapshot = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  ).snapshot;
  snapshot = run(compiled, observeTime(compiled, snapshot, 5_000).snapshot).snapshot;
  const write = snapshot.foregroundAction;
  assert.ok(write?.kind === "storageWrite");
  assert.equal(snapshot.currentSessionTimeMs, 2_000);
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
  const completed = completeAction(compiled, snapshot, {
    actionId: write.actionId,
    actionKind: "storageWrite",
    payload: { kind: "stored" },
  });
  assert.ok(
    completed.outcome.kind === "completed" &&
      completed.outcome.settlement.actionKind === "storageWrite",
  );
  assert.equal(completed.outcome.settlement.completedAtMs, 2_000);
  snapshot = run(compiled, completed.snapshot).snapshot;
  assert.deepEqual(binding(snapshot, "seen"), { kind: "duration", milliseconds: 2_000 });
});

test("a write reserves the completion events of every active action", () => {
  const compiled = plan('timer async 100 s\nsave 7 as "k"\nwait 200 s\nexit');
  const snapshot = executeInstruction(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  ).snapshot;
  snapshot.nextEventSequence = Number.MAX_SAFE_INTEGER - 3;
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
  const result = executeInstruction(compiled, snapshot);
  assert.equal(result.snapshot.status, "failed");
  assert.equal(validateRuntimeSnapshot(result.snapshot, compiled).valid, true);
});

test("inspection of a pending write with a deeply nested value stays detached", () => {
  const depth = 1_024;
  const compiled = plan(`save ${"[".repeat(depth)}1${"]".repeat(depth)} as "k"\nexit`);
  const pending = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  ).snapshot;
  const inspected = inspectRuntimeState(compiled, pending);
  assert.ok(inspected.valid);
  const action = pending.foregroundAction;
  assert.ok(action?.kind === "storageWrite");
  assert.notEqual(inspected.foregroundAction?.action, action);
  assert.equal(Object.isFrozen(action.value), false);
  // The innermost inspected list is frozen, and changing the session's value does not reach the inspection.
  const innermost = (value: SerializableRuntimeValue): SerializableRuntimeValue[] => {
    let current = value;
    for (let level = 1; level < depth; level += 1) {
      assert.ok(typeof current === "object" && current !== null && current.kind === "list");
      current = current.items[0]!;
    }
    assert.ok(typeof current === "object" && current !== null && current.kind === "list");
    return current.items;
  };
  const inspectedAction = inspected.foregroundAction?.action;
  assert.ok(inspectedAction?.kind === "storageWrite");
  assert.equal(Object.isFrozen(innermost(inspectedAction.value)), true);
  innermost(action.value)[0] = 2;
  assert.deepEqual(innermost(inspectedAction.value), [1]);
});

test("an acknowledged save stores its own copy, which later changes to the variable or a loaded value never reach", () => {
  const compiled = plan(
    [
      "let original = [{ items: [1] }]",
      'save original as "k"',
      "original[0].items.add(2)",
      'let loaded = load "k" + "", default: null',
      "loaded[0].items.add(3)",
      'let reloaded = load("k" + "", default: null)',
      "exit",
    ].join("\n"),
  );
  const nested = (items: number[]): SerializableRuntimeValue => ({
    kind: "list",
    items: [{ kind: "object", properties: [{ name: "items", value: { kind: "list", items } }] }],
  });
  const fresh = createFreshRuntimeSession(compiled, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
    persistentScriptStorage: true,
  });
  const requested = fresh.run().events;
  // Also a write restored while it waits: the restored action's value is the one storage takes.
  const restored = restoreRuntimeSession(JSON.parse(serializeCheckpoint(fresh.exportCheckpoint())));
  for (const session of [fresh, restored]) {
    const action = session.view().foregroundAction;
    assert.ok(action?.kind === "storageWrite");
    session.completeAction({
      actionId: action.actionId,
      actionKind: "storageWrite",
      payload: { kind: "stored" },
    });
    session.run();
    const finished = session.exportSnapshot();
    assert.equal(finished.status, "halted");
    assert.deepEqual(finished.scriptStorage, [{ key: "k", value: nested([1]) }]);
    assert.deepEqual(binding(finished, "reloaded"), nested([1]));
    assert.deepEqual(binding(finished, "original"), nested([1, 2]));
    assert.deepEqual(binding(finished, "loaded"), nested([1, 3]));
  }
  // The request the host saw still shows the value as it was saved.
  const request = requested.find((event) => event.kind === "actionRequested");
  assert.ok(request?.kind === "actionRequested" && request.action.kind === "storageWrite");
  assert.deepEqual(request.action.value, nested([1]));
});
