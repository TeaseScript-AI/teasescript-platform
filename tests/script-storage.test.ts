import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
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
} from "../src/index.js";
import { parse } from "../src/parser.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

const keyMessage = "Storage key must be a string.";
const loadKeyMessage =
  "Storage key must be a string. To compare the loaded value, write '(load \"k\") == null'.";
const unstorableMessage =
  "save cannot store a timer handle, media handle, or speaker reference; they exist only in the current session.";

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
      // `dynamic` hides the text's type, so the saved list may hold numbers and text.
      "function dynamic(value) {\n  return value\n}",
      'save [1, null, dynamic("two")] as "list"',
      'save { nested: [true, null] } as "object"',
      'save set["a", "b"] as "set"',
      'save 2..=5 as "range"',
      'save 1.5 s as "duration"',
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
    expected.map(({ key }, index) => `let loaded${index} = load "${key}"`).join("\n"),
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
    const compiled = plan(`let key = "k"\n${command}\nlet loaded = load "k"\nexit`);
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
          "function fallback { calls += 1\nreturn 9 }",
          command,
          'let plain = load "k"',
          'let withDefault = load "k", default: fallback()',
          'let stillMissing = load "k"',
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
            message: `${command.startsWith("save") ? "save" : "delete"} could not persist "k"; the previous value is kept.`,
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
    'save 1 as "z"\nsave 2 as "a"\nlet saved = load "z"\ndelete "z"\nlet deleted = load "z"\nexit',
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
  const compiled = plan('save [1, null] as "list"\nlet loaded = load "list"\nexit');
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
      'timer async 1 s { seen = load "k"\nelapsed = clock.elapsed }',
      'save 2 as "k"',
      "wait 10 s",
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

test("a terminal save completes the root after acknowledgement even with background chat pacing", () => {
  for (const source of ['save 2 as "k"', 'say "Before"\nsave 2 as "k"']) {
    const compiled = plan(source);
    const pending = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
    );
    assert.equal(pending.snapshot.status, "waiting");
    const action = storageWrite(pending.snapshot);
    if (source.startsWith("say")) {
      assert.ok(pending.snapshot.backgroundActions.some((item) => item.kind === "chatPacingGate"));
    }
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
        .filter((event) => event.kind === "complete")
        .map(({ kind }) => kind),
      ["complete"],
    );
  }
});

test("absent loads return null or the default without storing it", () => {
  const result = assertRuntimeResumeEquivalent(
    'let missing = load "k"\nlet fallback = load "k", default: 7\nlet stillMissing = load "k"\nexit',
  );
  assert.equal(binding(result.finalSnapshot, "missing"), null);
  assert.equal(binding(result.finalSnapshot, "fallback"), 7);
  assert.equal(binding(result.finalSnapshot, "stillMissing"), null);
  assert.deepEqual(result.finalSnapshot.scriptStorage, []);
});

test("present loads skip side effects and blocking interactions in defaults", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'save "Ada" as "name"',
      "let calls = 0",
      'function fallback { calls = calls + 1\nreturn "fallback" }',
      'let fromFunction = load "name", default: fallback()',
      'let fromPrompt = load "name", default: askText "Your name?"',
      "exit",
    ].join("\n"),
  );
  assert.equal(binding(result.finalSnapshot, "calls"), 0);
  assert.equal(binding(result.finalSnapshot, "fromFunction"), "Ada");
  assert.equal(binding(result.finalSnapshot, "fromPrompt"), "Ada");
  assert.deepEqual(
    result.events.filter((event) => event.kind === "actionRequested"),
    [],
  );
});

test("an absent load resumes its blocking function default at every instruction boundary", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let calls = 0",
      'function fallback { calls = calls + 1\nwait 1 ms\nreturn "Ada" }',
      'let name = load "name", default: fallback()',
      'let missing = load "name"',
      "exit",
    ].join("\n"),
  );
  assert.ok(result.boundaries.some((snapshot) => snapshot.status === "waiting"));
  assert.equal(binding(result.finalSnapshot, "calls"), 1);
  assert.equal(binding(result.finalSnapshot, "name"), "Ada");
  assert.equal(binding(result.finalSnapshot, "missing"), null);
  assert.deepEqual(result.finalSnapshot.scriptStorage, []);
});

test("an absent load suspends for askText and resumes after a JSON checkpoint round trip", () => {
  const compiled = plan(
    'let name = load "name", default: askText "Your name?"\nlet stillMissing = load "name"\nsave name as "name"\nexit',
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
});

test("same-session loads see saves and copy nested collections in both directions", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let original = [{ items: [1] }]",
      'save original as "k"',
      "original[0].items.add(2)",
      'let loaded = load "k"',
      "loaded[0].items.add(3)",
      'let reloaded = load "k"',
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
    'save 1 as "k"\nsave null as "k"\nlet afterNull = load "k"\nsave 2 as "k"\nlet replaced = load "k"\ndelete "k"\ndelete "absent"\nlet missing = load "k"\nexit',
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
      'let absent = load mark("missing"), default: mark("default")',
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

test("parentheses compare the loaded value; an unparenthesized comparison gets TSV038 and its hint", () => {
  const result = assertRuntimeResumeEquivalent('let absent = (load "k") == null\nexit');
  assert.equal(binding(result.finalSnapshot, "absent"), true);
  const invalid = compileSource('let absent = load "k" == null');
  assert.equal(invalid.plan, null);
  assert.deepEqual(
    invalid.diagnostics.map(({ code, message }) => [code, message]),
    [["TSV038", loadKeyMessage]],
  );
});

test("statically non-string storage keys get TSV038 after unwrapping parentheses", () => {
  for (const key of [
    "1",
    "1 s",
    "true",
    "null",
    "[]",
    "set[]",
    "{ item: 1 }",
    "1..=2",
    "-1",
    "not true",
    '"a" == "b"',
    '"a" != "b"',
    "1 < 2",
    "1 <= 2",
    "1 > 2",
    "1 >= 2",
    "true and false",
    "true or false",
    "timer async 1 s",
    'playAudio async "a.mp3"',
  ]) {
    for (const [source, message] of [
      [`let value = load ((${key}))`, loadKeyMessage],
      [`save 0 as ((${key}))`, keyMessage],
      [`delete ((${key}))`, keyMessage],
    ] as const) {
      const compiled = compileSource(source);
      assert.equal(compiled.plan, null, source);
      assert.deepEqual(
        compiled.diagnostics.map(({ code, message: text }) => [code, text]),
        [["TSV038", message]],
        source,
      );
    }
  }
});

test("string-producing keys compile and run for save, load, and delete", () => {
  const keys = ["keys[0]", "key", "keyFunction()", "object.key", '"${key}-interpolated"'];
  const result = assertRuntimeResumeEquivalent(
    [
      'let key = "variable"',
      'let keys = ["indexed"]',
      'let object = { key: "property" }',
      'function keyFunction { return "function" }',
      ...keys.flatMap((key, index) => [
        `save 7 as ${key}`,
        `let loaded${index} = load ${key}`,
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
  for (const [command, message] of [
    ["let value = load key", loadKeyMessage],
    ["save 7 as key", keyMessage],
    ["delete key", keyMessage],
  ]) {
    const compiled = plan(
      `function dynamic(input) {\n  return input\n}\nlet key = dynamic(1)\n${command}`,
    );
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    assert.equal(result.snapshot.status, "failed", command);
    assert.equal(result.snapshot.failure?.code, "TSR054", command);
    assert.equal(result.snapshot.failure?.message, message, command);
    assert.deepEqual(result.snapshot.scriptStorage, [], command);
  }
});

test("save rejects session handles and speaker references at the top level and nested with TSR055", () => {
  for (const declaration of [
    "let handle = timer async 1 s",
    'let handle = playAudio async "a.mp3"',
    "speaker vera {}\nlet handle = vera",
  ]) {
    for (const value of ["handle", "{ nested: [handle] }"]) {
      // `dynamic` hides the value's type from the compiler, which rejects a known speaker or handle before runtime.
      const compiled = plan(
        `function dynamic(value) {\n  return value\n}\n${declaration}\nsave dynamic(${value}) as "k"`,
      );
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
      assert.equal(result.snapshot.failure?.code, "TSR055");
      assert.equal(result.snapshot.failure?.message, unstorableMessage);
      assert.deepEqual(result.snapshot.scriptStorage, []);
    }
  }
});

test("typed load initializers reject incompatible stored values with TSR058", () => {
  for (const [type, value, message] of [
    ["number", "stored", "holds a number, so it cannot take text (string)"],
    ["integer", 1.5, "holds a whole number (integer), so it cannot take a number"],
    [
      "string[]",
      { kind: "list", items: ["a", 1] },
      "holds a list (string[]), so it cannot take a list with a whole number (integer) at [1]",
    ],
    [
      "integer set",
      { kind: "set", items: [1, 1.5] },
      "holds a set (integer set), so it cannot take a set with a number at [1]",
    ],
    // These types have no runtime values yet, so no stored value fits them.
    ["date", "2026-10-02", "holds a date, so it cannot take text (string)"],
    ["time", "12:00", "holds a time, so it cannot take text (string)"],
    ["datetime", "2026-10-02T12:00:00Z", "holds a date and time, so it cannot take text (string)"],
  ] satisfies readonly (readonly [string, SerializableRuntimeValue, string])[]) {
    const compiled = plan(`let value: ${type} = load "k"`);
    const result = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value }] }),
    );
    assert.equal(result.snapshot.status, "failed", type);
    assert.equal(result.snapshot.failure?.code, "TSR058", type);
    assert.equal(result.snapshot.failure?.message, `'value' ${message}.`);
  }
  const compiled = plan('let value: number = ((load "k"))');
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value: "stored" }] }),
  );
  assert.equal(result.snapshot.failure?.code, "TSR058");
});

test("typed load initializers accept matching scalars, collections, integers, and optional types", () => {
  for (const [type, value] of [
    ["string", "stored"],
    ["boolean", false],
    ["number", 1.5],
    ["integer", 2],
    ["duration", { kind: "duration", milliseconds: 1_500 }],
    ["string[]", { kind: "list", items: ["a", "b"] }],
    ["integer set", { kind: "set", items: [1, 2] }],
    ["number?", 3],
  ] satisfies readonly (readonly [string, SerializableRuntimeValue])[]) {
    const compiled = plan(`let value: ${type} = load "k"`);
    const result = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value }] }),
    );
    assert.equal(result.snapshot.status, "halted", type);
    assert.deepEqual(binding(result.snapshot, "value"), value, type);
  }
});

test("loaded values are checked against the variable's type, including missing keys, defaults, and indirect loads", () => {
  const storage = [{ key: "k", value: "stored" }];
  const failure = (source: string) => {
    const compiled = plan(`function identity(value) { return value }\n${source}\nexit`);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled, { scriptStorage: storage }));
    return [result.snapshot.failure?.code, result.snapshot.failure?.message];
  };
  assert.deepEqual(failure('let missing: number = load "missing"'), [
    "TSR058",
    "'missing' holds a number, so it cannot take null.",
  ]);
  assert.deepEqual(
    failure('let fallback: number = load "missing", default: identity("fallback")'),
    ["TSR058", "'fallback' holds a number, so it cannot take text (string)."],
  );
  assert.deepEqual(failure('let assigned: number = 0\nassigned = load "k"'), [
    "TSR058",
    "'assigned' holds a number, so it cannot take text (string).",
  ]);
  assert.deepEqual(failure('let indirect: number = identity(load "k")'), [
    "TSR058",
    "'indirect' holds a number, so it cannot take text (string).",
  ]);

  const optional = plan('let missing: number? = load "missing"\nlet text: string = load "k"\nexit');
  const result = run(optional, createFreshRuntimeSnapshot(optional, { scriptStorage: storage }));
  assert.equal(result.snapshot.status, "halted");
  assert.equal(binding(result.snapshot, "missing"), null);
  assert.equal(binding(result.snapshot, "text"), "stored");
  assert.deepEqual(result.snapshot.scriptStorage, storage);
});

test("compact interactions end at the save 'as', and a grouped load key leaves the fallback to load", () => {
  const compiled = plan(
    [
      'save askText as "bare"',
      'save askText "Your name?" as "name"',
      'save load "nick", default: askText "Nickname?" as "nick"',
      'let pick = load (choose first: "a", second: "b"), default: "fallback"',
      "exit",
    ].join("\n"),
  );
  let result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "second", value: "stored" }] }),
  );
  for (const answer of ["Bare", "Ada", "Addy"]) {
    const action = result.snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction" && action.interactionKind === "text", answer);
    const completed = completeAction(compiled, result.snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: answer },
    });
    result = run(compiled, completed.snapshot);
  }
  assert.deepEqual(result.snapshot.scriptStorage, [
    { key: "bare", value: "Bare" },
    { key: "name", value: "Ada" },
    { key: "nick", value: "Addy" },
    { key: "second", value: "stored" },
  ]);
  const choice = result.snapshot.foregroundAction;
  assert.ok(choice?.kind === "interaction" && choice.interactionKind === "choice");
  const chosen = completeAction(compiled, result.snapshot, {
    actionId: choice.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  const finished = run(compiled, chosen.snapshot);
  assert.equal(finished.snapshot.status, "halted");
  assert.equal(binding(finished.snapshot, "pick"), "stored");

  // A present key never prompts; its stored value is saved again.
  const present = plan('save load "nick", default: askText "Nickname?" as "nick"\nexit');
  const rerun = run(
    present,
    createFreshRuntimeSnapshot(present, { scriptStorage: [{ key: "nick", value: "Addy" }] }),
  );
  assert.equal(rerun.snapshot.status, "halted");
  assert.deepEqual(rerun.snapshot.scriptStorage, [{ key: "nick", value: "Addy" }]);

  // Inside a save value, `as` belongs to save; a speaker clause needs parentheses.
  const speakerSource = 'speaker mistress {\n  name: "M"\n}\n';
  assert.notEqual(
    compileSource(`${speakerSource}save (askText as mistress "Name?") as "name"`).plan,
    null,
  );
  assert.deepEqual(
    compileSource(`${speakerSource}let name = askText "Your name?" as mistress`).diagnostics.map(
      ({ code }) => code,
    ),
    ["TSP032"],
  );
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
      'let a = load "a"',
      'let b = load "b"',
      'let c = load "c"',
      'let d = load "d"',
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

test("load takes its fallback as ', default:', and the earlier form names the fix", () => {
  const diagnostics = (source: string) =>
    compileSource(source).diagnostics.map(
      (item) => `${item.code} ${item.span.start.column + 1} ${item.message}`,
    );
  const fix =
    "TSP017 18 Write a fallback for load as 'load key, default: value', with a comma and a colon.";

  assert.deepEqual(diagnostics('let v = load "k" default 1'), [fix]);
  assert.deepEqual(diagnostics('let v = load "k" default: 1'), [fix]);
  assert.deepEqual(diagnostics('let v = load "k", default:'), [
    "TSP012 27 Expected a fallback value after 'default:'.",
  ]);
  // The fix is named after a choice key and inside interpolation too.
  assert.equal(
    diagnostics('let v = load choose a: "x", b: "y" default "z"')[0],
    "TSP017 36 Write a fallback for load as 'load key, default: value', with a comma and a colon.",
  );
  assert.equal(
    diagnostics('let v = "${load "k" default "x"}"')[0],
    "TSP017 21 Write a fallback for load as 'load key, default: value', with a comma and a colon.",
  );
  // A missing fallback leaves the next statement intact.
  const missing = parse('let v = load "k", default:\nlet ok = 1');
  assert.deepEqual(
    missing.diagnostics.map((item) => item.code),
    ["TSP012"],
  );
  assert.equal(missing.program.statements.length, 2);
});

test("a ', default:' belongs to the nearest load or ask before it", () => {
  const initializer = (source: string) => {
    const [statement] = parse(source).program.statements;
    assert.ok(statement?.kind === "letStatement");
    return statement.initializer;
  };

  const askKey = initializer('let v = load askText "Key?", default: "x"');
  assert.ok(askKey.kind === "loadExpression" && askKey.defaultValue === null);
  assert.ok(askKey.key.kind === "interactionExpression" && askKey.key.defaultValue !== null);

  const loadDefault = initializer('let v = askText "Name?", default: load "name", default: "Ada"');
  assert.ok(loadDefault.kind === "interactionExpression");
  assert.ok(loadDefault.defaultValue?.kind === "loadExpression");
  assert.equal(loadDefault.defaultValue.defaultValue?.kind, "stringLiteral");

  const list = initializer('let v = [load "a", default: 1, 2]');
  assert.ok(list.kind === "listLiteral" && list.elements.length === 2);
  assert.ok(list.elements[0]?.kind === "loadExpression" && list.elements[0].defaultValue !== null);

  // Inside delimiters a line break does not end the expression, so a comma on the next line binds the same way; outside
  // them a line may not start with a comma (V30 §2).
  const object = initializer('let v = {first: load "k"\n, default: "x"}');
  assert.ok(object.kind === "objectLiteral" && object.properties.length === 1);
  const grouped = initializer('let v = (load "k"\n, default: 7)');
  assert.ok(grouped.kind === "parenthesizedExpression");
  assert.ok(
    grouped.expression.kind === "loadExpression" && grouped.expression.defaultValue !== null,
  );
  assert.notDeepEqual(parse('let v = load "k"\n, default: 7').diagnostics, []);
  // Every `()` list counts, also function parameters and say presentation options.
  for (const source of [
    'function f(x = load "k"\n, default: 7) { return x }\nsay f()',
    'say bubble(color: load "color"\n, default: "red") "Hi", instant',
  ])
    assert.deepEqual(compileSource(source).diagnostics, [], source);

  // By the same rule, a compact choice takes `default:` as its own option label; grouping gives the fallback to load.
  for (const source of [
    'let v = load choose a: "x", b: "y", default: "z"',
    'let v = (load choose a: "x", b: "y"\n, default: "z")',
  ]) {
    let labelled = initializer(source);
    if (labelled.kind === "parenthesizedExpression") labelled = labelled.expression;
    assert.ok(labelled.kind === "loadExpression" && labelled.defaultValue === null, source);
    assert.ok(labelled.key.kind === "interactionExpression", source);
    assert.equal(labelled.key.options.length, 3, source);
  }
  const choiceKey = initializer('let v = load (choose a: "x", b: "y"), default: "z"');
  assert.ok(choiceKey.kind === "loadExpression" && choiceKey.defaultValue !== null);
});

test("compact interactions parse in every storage operand position", () => {
  const prelude =
    'speaker mistress {\n  name: "M"\n}\nfunction wrap(value) { return "${value}" }\n';
  const values = [
    "askText",
    'askText "Hint?"',
    "askNumber",
    'askNumber "Age?"',
    'choose "a", "b"',
    'choose default: "A", other: "B"',
    '(askText as mistress "Hint?")',
    '(choose as mistress "a", "b")',
    '"${askText}"',
    "wrap(askNumber)",
    'timer(duration: 1 s, async: true, label: askText as mistress "Label?").state',
    'playAudio(file: askText as mistress "File?", async: true).state',
  ];
  // `true` marks a storage key position, where a number answer is a type error rather than a parse error.
  const positions: readonly (readonly [(value: string) => string, boolean])[] = [
    [(value) => `save ${value} as "k"`, false],
    [(value) => `save [${value}] as "k"`, false],
    [(value) => `let v = load ${value}`, true],
    // A `, default:` after an ungrouped interaction would belong to the interaction, so these keys are grouped.
    [(value) => `let v = load (${value}), default: "d"`, true],
    [(value) => `let v = load "k", default: ${value}`, false],
    [(value) => `save load "k", default: ${value} as "k"`, false],
    [(value) => `save load ${value} as "k"`, true],
    [(value) => `save load (${value}), default: "d" as "k"`, true],
  ];
  for (const value of values) {
    for (const [position, key] of positions) {
      const source = position(value);
      const compiled = compileSource(prelude + source);
      const numberKey = key && value.startsWith("askNumber");
      assert.deepEqual(
        compiled.diagnostics.map((diagnostic) => diagnostic.code),
        numberKey ? ["TSV043"] : [],
        source,
      );
    }
  }
});

test("save keeps the value it evaluated before its key expression runs", () => {
  for (const source of [
    'let items = [1]\nsave items as "k${items.clear()}"\nlet stored = load "knull"\nexit',
    'let items = [1]\nfunction clearItems { items.clear()\nreturn "knull" }\nsave items as clearItems()\nlet stored = load "knull"\nexit',
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
  const compiled = plan('timer async 100 s\nsave 7 as "k"\nwait 200 s');
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

test("load operands may be quoted strings inside interpolation", () => {
  const result = assertRuntimeResumeEquivalent(
    'save "Ada" as "k"\nlet key = "missing"\nlet present = "${load "k"}"\nlet absent = "${load key, default: "fallback"}"\nexit',
  );
  assert.equal(binding(result.finalSnapshot, "present"), "Ada");
  assert.equal(binding(result.finalSnapshot, "absent"), "fallback");
});

test("inspection of a pending write with a deeply nested value stays detached", () => {
  const depth = 1_024;
  const compiled = plan(`save ${"[".repeat(depth)}1${"]".repeat(depth)} as "k"`);
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

test("a member named load or default does not start a nested string in interpolation", () => {
  const diagnostics = (member: string) =>
    compileSource(
      `let obj = { load: "Ada", default: "fallback", name: "Bo" }\nsay "\${obj.${member}"\nlet after = 7\nexit`,
    ).diagnostics.map(({ code }) => code);
  // Recovery from the malformed interpolation matches an ordinary member name.
  assert.deepEqual(diagnostics("load"), diagnostics("name"));
  assert.deepEqual(diagnostics("default"), diagnostics("name"));
});
