import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  run,
  serializeCheckpoint,
  type FreshRuntimeOptions,
  type RuntimeSnapshot,
} from "../src/index.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("fresh state and JSON checkpoint restore reject invalid external script storage", () => {
  const compiled = plan("exit");
  const canonical = createCheckpoint(
    compiled,
    createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "kept", value: 1 }] }),
  );
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(canonical)));

  for (const [name, invalid] of [
    ["non-array", {}],
    ["null", null],
    ["non-string key", [{ key: 1, value: "value" }]],
    [
      "duplicate key",
      [
        { key: "k", value: 1 },
        { key: "k", value: 2 },
      ],
    ],
    ["top-level null", [{ key: "k", value: null }]],
    [
      "nested handle",
      [{ key: "k", value: { kind: "list", items: [{ kind: "timerHandle", timerId: 1 }] } }],
    ],
    // Unknown fields could otherwise carry a session-only value past the storable-value check.
    [
      "range with an extra field",
      [
        {
          key: "k",
          value: {
            kind: "range",
            start: 1,
            end: 3,
            inclusive: true,
            extra: { kind: "timerHandle", timerId: 1 },
          },
        },
      ],
    ],
    [
      "list with an extra field",
      [
        {
          key: "k",
          value: { kind: "list", items: [], extra: { kind: "mediaHandle", mediaId: 1 } },
        },
      ],
    ],
    [
      "object property with an extra field",
      [
        {
          key: "k",
          value: {
            kind: "object",
            properties: [
              {
                name: "n",
                value: 1,
                extra: { kind: "speakerReference", speakerId: 1, identifier: "s" },
              },
            ],
          },
        },
      ],
    ],
  ] as const) {
    assert.throws(
      () =>
        createFreshRuntimeSnapshot(compiled, {
          // EVIDENCE: intentionally malformed host data exercises the public runtime validation boundary.
          scriptStorage: invalid as NonNullable<FreshRuntimeOptions["scriptStorage"]>,
        }),
      TypeError,
      name,
    );

    // EVIDENCE: widen only the storage field of a canonical checkpoint to simulate corrupted persisted JSON.
    const checkpoint = structuredClone(canonical) as { snapshot: { scriptStorage: unknown } };
    checkpoint.snapshot.scriptStorage = invalid;
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), CheckpointError, name);
  }
});

test("fresh storage accepts unordered entries and checkpoints retain a sorted view", () => {
  const compiled = plan("exit");
  const snapshot = createFreshRuntimeSnapshot(compiled, {
    persistentScriptStorage: true,
    scriptStorage: [
      { key: "z", value: 2 },
      { key: "a", value: 1 },
    ],
  });
  assert.deepEqual(snapshot.scriptStorage, [
    { key: "a", value: 1 },
    { key: "z", value: 2 },
  ]);
  assert.equal(snapshot.scriptStoragePersistent, true);
  const canonical = createCheckpoint(compiled, snapshot);
  const restored = deserializeCheckpoint(serializeCheckpoint(canonical));
  assert.deepEqual(restored.snapshot, snapshot);
  const unsorted = {
    ...canonical,
    snapshot: { ...canonical.snapshot, scriptStorage: [...snapshot.scriptStorage].reverse() },
  };
  assert.throws(() => deserializeCheckpoint(JSON.stringify(unsorted)), CheckpointError);
});

const invalidPersistenceValues = [null, 0, "true", {}, []];

test("fresh options reject non-boolean storage persistence", () => {
  const compiled = plan("exit");
  for (const invalid of invalidPersistenceValues) {
    assert.throws(
      () =>
        createFreshRuntimeSnapshot(compiled, {
          // EVIDENCE: intentionally malformed host option exercises the public validation boundary.
          persistentScriptStorage: invalid as NonNullable<
            FreshRuntimeOptions["persistentScriptStorage"]
          >,
        }),
      TypeError,
      JSON.stringify(invalid),
    );
  }
});

test("checkpoint restore rejects non-boolean storage persistence", () => {
  const compiled = plan("exit");
  const canonical = createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled));
  for (const invalid of invalidPersistenceValues) {
    // EVIDENCE: widen only the persistence flag to simulate corrupted persisted JSON.
    const checkpoint = structuredClone(canonical) as {
      snapshot: { scriptStoragePersistent: unknown };
    };
    checkpoint.snapshot.scriptStoragePersistent = invalid;
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), CheckpointError);
  }
});

test("restore rejects a pending storage write in session-local mode", () => {
  const compiled = plan('save 2 as "k"');
  const pending = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  );
  assert.equal(pending.snapshot.foregroundAction?.kind, "storageWrite");
  const canonical = createCheckpoint(compiled, pending.snapshot);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(canonical)));
  const local = {
    ...canonical,
    snapshot: { ...canonical.snapshot, scriptStoragePersistent: false },
  };
  assert.throws(() => deserializeCheckpoint(JSON.stringify(local)), CheckpointError);
});

test("restore rejects storage settlements inconsistent with persistence or the failure warning", () => {
  const compiled = plan('save 1 as "k"\nwait 1 s\nexit');
  const pending = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { persistentScriptStorage: true }),
  ).snapshot;
  const write = pending.foregroundAction;
  assert.ok(write?.kind === "storageWrite");
  const settle = (kind: "stored" | "failed") =>
    run(
      compiled,
      completeAction(compiled, pending, {
        actionId: write.actionId,
        actionKind: "storageWrite",
        payload: { kind },
      }).snapshot,
    ).snapshot;
  const restore = (snapshot: RuntimeSnapshot) => () =>
    deserializeCheckpoint(
      JSON.stringify({
        ...JSON.parse(serializeCheckpoint(createCheckpoint(compiled, settle("stored")))),
        snapshot,
      }),
    );

  const sessionLocal = { ...settle("stored"), scriptStoragePersistent: false };
  assert.equal(sessionLocal.lastSettlement?.actionKind, "storageWrite");
  assert.throws(restore(sessionLocal), CheckpointError);

  const failed = settle("failed");
  assert.ok(failed.lastSettlement?.actionKind === "storageWrite");
  const withoutWarningSlot = {
    ...failed,
    lastSettlement: {
      ...failed.lastSettlement,
      completionEventSequence: failed.lastSettlement.requestEventSequence + 1,
    },
  };
  assert.doesNotThrow(restore(failed));
  assert.throws(restore(withoutWarningSlot), CheckpointError);
});

test("a builtin result with an unknown field on a tagged value fails as malformed data", () => {
  const compiled = plan("let value = odd()\nexit", { builtins: ["odd"] });
  const result = run(compiled, createFreshRuntimeSnapshot(compiled), {
    builtins: {
      odd: () =>
        // EVIDENCE: the builtin deliberately returns a range with an unknown field for runtime rejection.
        ({ kind: "range", start: 1, end: 2, inclusive: true, extra: 1 }) as never,
    },
  });
  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR013");
});
