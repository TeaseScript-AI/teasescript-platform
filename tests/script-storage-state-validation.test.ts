import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  serializeCheckpoint,
  type FreshRuntimeOptions,
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
