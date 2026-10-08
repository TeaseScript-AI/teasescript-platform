import assert from "node:assert/strict";
import test from "node:test";

import {
  applyExternalStorageEdit,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  observeTime,
  run,
  RuntimeDataError,
  serializeCheckpoint,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

// A debugging tool edits the session's script-storage view between engine calls (DEBUGGER.md "Player Debug"): the
// next `load` the script evaluates returns the edit, and values already loaded keep what they loaded.

function binding(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue | undefined {
  return snapshot.frames[0]?.bindings.find((item) => item.name === name)?.value;
}

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function start(
  source: string,
  scriptStorage: { key: string; value: SerializableRuntimeValue }[] = [],
) {
  const compiled = plan(source);
  const ran = run(compiled, createFreshRuntimeSnapshot(compiled, { scriptStorage }));
  return { plan: compiled, snapshot: ran.snapshot };
}

function edit(compiled: InstructionPlan, snapshot: RuntimeSnapshot, request: unknown) {
  return applyExternalStorageEdit(compiled, snapshot, request);
}

const twoLoads =
  'let first = load("k", default: 0)\nwait 5 s\nlet second = load("k", default: 0)\nsay "${first} ${second}", instant\nexit';

test("the next load returns an edited value, and a value loaded before keeps what it loaded", () => {
  const session = start(twoLoads, [{ key: "k", value: 1 }]);
  assert.equal(session.snapshot.status, "waiting");
  const edited = edit(session.plan, session.snapshot, { key: "k", value: 2 });
  assert.deepEqual(edited.outcome, { kind: "applied", key: "k", operation: "set" });
  assert.equal(edited.instructionsExecuted, 0);
  assert.deepEqual(edited.events, [
    {
      kind: "scriptStorageEdited",
      sequence: session.snapshot.nextEventSequence,
      key: "k",
      operation: "set",
      currentSessionTimeMs: 0,
      observedSessionTimeMs: 0,
    },
  ]);
  // Only the view and the event counter change; the waiting delay and the loaded value stay.
  assert.deepEqual(
    { ...edited.snapshot, scriptStorage: [], nextEventSequence: 0 },
    { ...session.snapshot, scriptStorage: [], nextEventSequence: 0 },
  );
  assert.equal(binding(edited.snapshot, "first"), 1);
  const observed = observeTime(session.plan, edited.snapshot, 5_000);
  assert.deepEqual(said(run(session.plan, observed.snapshot).events), ["1 2"]);
});

test("a null value deletes the key, so the next load uses its default", () => {
  const session = start(twoLoads, [{ key: "k", value: 1 }]);
  const edited = edit(session.plan, session.snapshot, { key: "k", value: null });
  assert.deepEqual(edited.outcome, { kind: "applied", key: "k", operation: "delete" });
  assert.deepEqual(edited.snapshot.scriptStorage, []);
  const observed = observeTime(session.plan, edited.snapshot, 5_000);
  assert.deepEqual(said(run(session.plan, observed.snapshot).events), ["1 0"]);
});

test("an edit stores its own copy, and a key is data, whatever its characters", () => {
  const session = start(twoLoads);
  const value = { kind: "list" as const, items: [1, "two"] };
  const key = "__proto__ ./ é";
  const edited = edit(session.plan, session.snapshot, { key, value });
  value.items.push(3);
  assert.deepEqual(edited.snapshot.scriptStorage, [
    { key, value: { kind: "list", items: [1, "two"] } },
  ]);
});

test("a malformed edit, or one an ended session cannot take, changes nothing", () => {
  const session = start(twoLoads, [{ key: "k", value: 1 }]);
  for (const request of [
    null,
    "k",
    { key: "k" },
    { key: "k", value: 1, extra: true },
    { key: 1, value: 1 },
    { key: "k", value: Number.NaN },
    { key: "k", value: { kind: "list" } },
    { key: "k", value: { kind: "timerHandle", timerId: 1 } },
  ]) {
    const refused = edit(session.plan, session.snapshot, request);
    assert.equal(refused.outcome.kind, "invalidEdit", JSON.stringify(request));
    assert.deepEqual(refused.events, []);
    assert.deepEqual(refused.snapshot, session.snapshot);
  }
  const ended = start('say "done", instant\nexit');
  assert.deepEqual(edit(ended.plan, ended.snapshot, { key: "k", value: 1 }).outcome, {
    kind: "invalidState",
    status: "halted",
  });
  const failed = start("let zero = 0\nlet broken = 1 / zero\nexit");
  assert.equal(failed.snapshot.status, "failed");
  assert.equal(
    edit(failed.plan, failed.snapshot, { key: "k", value: 1 }).outcome.kind,
    "invalidState",
  );
});

test("while the script's own write waits for the host, the edit waits too, and applies before the script goes on", () => {
  const compiled = plan(
    'save 1 as "k"\nlet loaded: integer? = load("k", default: null)\nsay "${loaded}", instant\nexit',
  );
  const waiting = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  );
  const write = waiting.snapshot.foregroundAction;
  assert.equal(write?.kind, "storageWrite");
  assert.deepEqual(edit(compiled, waiting.snapshot, { key: "k", value: 2 }).outcome, {
    kind: "storageWritePending",
    actionId: write.actionId,
  });
  // The host acknowledges the write without running on, applies the edit, and only then runs the script.
  const stored = completeAction(compiled, waiting.snapshot, {
    actionId: write.actionId,
    actionKind: "storageWrite",
    payload: { kind: "stored" },
  });
  assert.equal(stored.outcome.kind, "completed");
  const edited = edit(compiled, stored.snapshot, { key: "k", value: 2 });
  assert.equal(edited.outcome.kind, "applied");
  assert.deepEqual(said(run(compiled, edited.snapshot).events), ["2"]);
});

test("an edit applies at the current instruction, also while a due timer block has not run yet", () => {
  const session = start(
    'timer async 1 {\n  let seen = load("k", default: 0)\n  say "block ${seen}", instant\n}\nwait 5 s\nexit',
  );
  // The observation queues the due block; before the Player runs it, the edit applies.
  const observed = observeTime(session.plan, session.snapshot, 2_000);
  assert.equal(observed.snapshot.pendingTimerHandlers.length, 1);
  const edited = edit(session.plan, observed.snapshot, { key: "k", value: 7 });
  assert.equal(edited.outcome.kind, "applied");
  const event = edited.events[0];
  assert.ok(event?.kind === "scriptStorageEdited");
  assert.equal(event.observedSessionTimeMs, 2_000);
  assert.deepEqual(said(run(session.plan, edited.snapshot).events), ["block 7"]);
});

test("a checkpoint after an edit restores the edited view without applying it again", () => {
  const session = start(twoLoads, [{ key: "k", value: 1 }]);
  const edited = edit(session.plan, session.snapshot, { key: "k", value: 2 });
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(session.plan, edited.snapshot)),
  );
  assert.deepEqual(restored.snapshot, edited.snapshot);
  const direct = run(session.plan, observeTime(session.plan, edited.snapshot, 5_000).snapshot);
  const resumed = run(restored.plan, observeTime(restored.plan, restored.snapshot, 5_000).snapshot);
  assert.deepEqual(resumed.snapshot, direct.snapshot);
  assert.deepEqual(said(resumed.events), ["1 2"]);
});

test("an edit while a timer block waits reaches that block's next load", () => {
  const session = start(
    'timer async 1 {\n  wait 5 s\n  let seen = load("k", default: 0)\n  say "block ${seen}", instant\n}\nlet go = showButton "Go"\nexit',
  );
  // At 1 s the block runs and waits inside itself, with the button suspended behind it.
  const running = run(session.plan, observeTime(session.plan, session.snapshot, 1_000).snapshot);
  assert.equal(running.snapshot.foregroundAction?.kind, "delay");
  const edited = edit(session.plan, running.snapshot, { key: "k", value: 3 });
  assert.equal(edited.outcome.kind, "applied");
  const later = run(session.plan, observeTime(session.plan, edited.snapshot, 6_000).snapshot);
  assert.deepEqual(said(later.events), ["block 3"]);
});

test("without event sequence space left, an edit is refused as malformed state and changes nothing", () => {
  const session = start(twoLoads, [{ key: "k", value: 1 }]);
  const crowded = structuredClone(session.snapshot);
  crowded.nextEventSequence = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(crowded);
  assert.throws(
    () => edit(session.plan, crowded, { key: "k", value: 2 }),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
  );
  assert.deepEqual(crowded, before);
});
