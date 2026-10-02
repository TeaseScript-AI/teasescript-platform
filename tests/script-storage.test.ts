import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  reportMediaLoad,
  run,
  serializeCheckpoint,
  type InterpreterEvent,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
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

function changes(events: readonly InterpreterEvent[]) {
  return events.filter((event) => event.kind === "scriptStorageChanged");
}

test("emitted saves seed a new session without losing stored value types", () => {
  const writer = plan(
    [
      'save "Ada" as "name"',
      'save 2.5 as "score"',
      'save false as "enabled"',
      'save [1, null, "two"] as "list"',
      'save { nested: [true, null] } as "object"',
      'save set["a", "b"] as "set"',
      'save 2..=5 as "range"',
      'save 1.5 s as "duration"',
      "exit",
    ].join("\n"),
  );
  const written = run(writer, createFreshRuntimeSnapshot(writer));
  assert.equal(written.snapshot.status, "halted");
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
  const persisted = new Map<string, SerializableRuntimeValue>();
  for (const event of changes(written.events)) {
    if (event.value === null) persisted.delete(event.key);
    else persisted.set(event.key, event.value);
  }
  const scriptStorage = Array.from(persisted, ([key, value]) => ({ key, value }));
  assert.deepEqual(scriptStorage, expected);

  const reader = plan(
    expected.map(({ key }, index) => `let loaded${index} = load "${key}"`).join("\n"),
  );
  const read = run(reader, createFreshRuntimeSnapshot(reader, { scriptStorage }));
  assert.equal(read.snapshot.status, "halted");
  for (const [index, entry] of expected.entries()) {
    assert.deepEqual(binding(read.snapshot, `loaded${index}`), entry.value, entry.key);
  }
  assert.deepEqual(changes(read.events), []);
});

test("absent loads return null or the default without storing it", () => {
  const result = assertRuntimeResumeEquivalent(
    'let missing = load "k"\nlet fallback = load "k" default 7\nlet stillMissing = load "k"\nexit',
  );
  assert.equal(binding(result.finalSnapshot, "missing"), null);
  assert.equal(binding(result.finalSnapshot, "fallback"), 7);
  assert.equal(binding(result.finalSnapshot, "stillMissing"), null);
  assert.deepEqual(changes(result.events), []);
  assert.deepEqual(result.finalSnapshot.scriptStorage, []);
});

test("present loads skip side effects and blocking interactions in defaults", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'save "Ada" as "name"',
      "let calls = 0",
      'function fallback { calls = calls + 1\nreturn "fallback" }',
      'let fromFunction = load "name" default fallback()',
      'let fromPrompt = load "name" default askText "Your name?"',
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
      'let name = load "name" default fallback()',
      'let missing = load "name"',
      "exit",
    ].join("\n"),
  );
  assert.ok(result.boundaries.some((snapshot) => snapshot.status === "waiting"));
  assert.equal(binding(result.finalSnapshot, "calls"), 1);
  assert.equal(binding(result.finalSnapshot, "name"), "Ada");
  assert.equal(binding(result.finalSnapshot, "missing"), null);
  assert.deepEqual(changes(result.events), []);
});

test("an absent load suspends for askText and resumes after a JSON checkpoint round trip", () => {
  const compiled = plan(
    'let name = load "name" default askText "Your name?"\nlet stillMissing = load "name"\nsave name as "name"\nexit',
  );
  const pending = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(pending.snapshot.status, "waiting");
  const action = pending.snapshot.foregroundAction;
  assert.equal(action?.kind, "interaction");
  assert.ok(action?.kind === "interaction");
  assert.equal(action.interactionKind, "text");
  assert.deepEqual(changes(pending.events), []);
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
  assert.deepEqual(
    changes(resumed.events).map(({ key, value }) => ({ key, value })),
    [{ key: "name", value: "Ada" }],
  );
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
  assert.deepEqual(
    changes(result.events).map((event) => event.value),
    [stored],
  );
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

test("save null and delete remove keys and emit ordered mutations even for an absent key", () => {
  const result = assertRuntimeResumeEquivalent(
    'save 1 as "k"\nsave null as "k"\nsave 2 as "k"\ndelete "k"\ndelete "absent"\nlet missing = load "k"\nexit',
  );
  assert.deepEqual(
    changes(result.events).map(({ sequence, key, value }) => [sequence, key, value]),
    [
      [1, "k", 1],
      [2, "k", null],
      [3, "k", 2],
      [4, "k", null],
      [5, "absent", null],
    ],
  );
  assert.equal(binding(result.finalSnapshot, "missing"), null);
  assert.deepEqual(result.finalSnapshot.scriptStorage, []);
});

test("storage operands evaluate in source order and present loads skip their defaults", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let order = []",
      "function mark(value) { order.add(value)\nreturn value }",
      'save mark("value") as mark("key")',
      'let present = load mark("key") default mark("unused")',
      'delete mark("key")',
      'let absent = load mark("missing") default mark("default")',
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
  for (const [command, message] of [
    ["let value = load key", loadKeyMessage],
    ["save 7 as key", keyMessage],
    ["delete key", keyMessage],
  ]) {
    const compiled = plan(`let key = 1\n${command}`);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    assert.equal(result.snapshot.status, "failed", command);
    assert.equal(result.snapshot.failure?.code, "TSR054", command);
    assert.equal(result.snapshot.failure?.message, message, command);
    assert.deepEqual(changes(result.events), [], command);
  }
});

test("save rejects session handles and speaker references at the top level and nested with TSR055", () => {
  for (const declaration of [
    "let handle = timer async 1 s",
    'let handle = playAudio async "a.mp3"',
    "speaker vera {}\nlet handle = vera",
  ]) {
    for (const value of ["handle", "{ nested: [handle] }"]) {
      const compiled = plan(`${declaration}\nsave ${value} as "k"`);
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
      assert.deepEqual(changes(result.events), []);
    }
  }
});

test("direct typed load initializers reject incompatible stored values with TSR056", () => {
  for (const [type, value] of [
    ["number", "stored"],
    ["integer", 1.5],
    ["string[]", { kind: "list", items: ["a", 1] }],
    ["integer set", { kind: "set", items: [1, 1.5] }],
    ["date", "2026-10-02"],
    ["time", "12:00"],
    ["datetime", "2026-10-02T12:00:00Z"],
  ] satisfies readonly (readonly [string, SerializableRuntimeValue])[]) {
    const compiled = plan(`let value: ${type} = load "k"`);
    const result = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value }] }),
    );
    assert.equal(result.snapshot.status, "failed", type);
    assert.equal(result.snapshot.failure?.code, "TSR056", type);
    assert.equal(
      result.snapshot.failure?.message,
      `Stored value for "k" does not match the declared type ${type}.`,
    );
  }
  const compiled = plan('let value: number = ((load "k"))');
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value: "stored" }] }),
  );
  assert.equal(result.snapshot.failure?.code, "TSR056");
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

test("persisted-value type checks exclude missing keys, defaults, and non-direct loads", () => {
  const compiled = plan(
    [
      'let missing: number = load "missing"',
      'let fallback: number = load "missing" default "fallback"',
      "let assigned: number = 0",
      'assigned = load "k"',
      "function identity(value) { return value }",
      'let indirect: number = identity(load "k")',
      "exit",
    ].join("\n"),
  );
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "k", value: "stored" }] }),
  );
  assert.equal(result.snapshot.status, "halted");
  assert.equal(binding(result.snapshot, "missing"), null);
  assert.equal(binding(result.snapshot, "fallback"), "fallback");
  assert.equal(binding(result.snapshot, "assigned"), "stored");
  assert.equal(binding(result.snapshot, "indirect"), "stored");
  assert.deepEqual(changes(result.events), []);
});

test("compact interactions end at the save 'as' and the load 'default' delimiters", () => {
  const compiled = plan(
    'save askText "Your name?" as "name"\nlet pick = load choose "a", "b" default "fallback"\nexit',
  );
  const pending = run(compiled, createFreshRuntimeSnapshot(compiled));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.interactionKind === "text");
  const completed = completeAction(compiled, pending.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "Ada" },
  });
  const choosing = run(compiled, completed.snapshot);
  assert.deepEqual(
    changes([...completed.events, ...choosing.events]).map(({ key, value }) => ({ key, value })),
    [{ key: "name", value: "Ada" }],
  );
  const choice = choosing.snapshot.foregroundAction;
  assert.ok(choice?.kind === "interaction" && choice.interactionKind === "choice");

  const misplaced = compileSource('let name = askText "Your name?" as narrator');
  assert.deepEqual(
    misplaced.diagnostics.map(({ code }) => code),
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
  assert.deepEqual(
    new Map(result.finalSnapshot.scriptStorage.map(({ key, value }) => [key, value])),
    new Map([
      ["b", 20],
      ["c", 3],
      ["d", 4],
    ]),
  );
});
