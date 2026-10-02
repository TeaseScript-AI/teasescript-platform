import assert from "node:assert/strict";

import { CheckpointError, restoreCheckpoint } from "../../src/runtime/checkpoint.js";

/**
 * Asserts a structured checkpoint rejection. Snapshot errors always report `$.snapshot`, so a snapshot row isolates its
 * rule only through a single-field corruption of a valid checkpoint; plan rows can also pass the expected `$.plan` path.
 */
export function assertCheckpointRejected(value: unknown, code: string, path?: string): void {
  assert.throws(
    () => restoreCheckpoint(value),
    (error: unknown) =>
      error instanceof CheckpointError &&
      error.info.code === code &&
      (path === undefined || error.info.path === path),
  );
}
