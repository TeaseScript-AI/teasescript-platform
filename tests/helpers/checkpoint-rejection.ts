import assert from "node:assert/strict";

import { CheckpointError, restoreCheckpoint } from "../../src/runtime/checkpoint.js";

export function assertCheckpointRejected(value: unknown, code: string): void {
  assert.throws(
    () => restoreCheckpoint(value),
    (error: unknown) => error instanceof CheckpointError && error.info.code === code,
  );
}
