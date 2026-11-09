// The debug recorder tests' replay (split from `player-debug-recorder.test.ts`): a recording replayed against its
// session, and a recording exported and parsed, which the operation log and the random resume both use.
import assert from "node:assert/strict";
import {
  DEBUG_EXPORT_VERSION,
  debugBuildRevisions,
  debugExportFile,
  parseDebugExport,
  replayDebugExport,
  type DebugExport,
  type DebugReplayResult,
} from "../../player/debug/debug-export.js";
import { DebugRecorder } from "../../player/debug/debug-recorder.js";
import { createCheckpoint } from "../../src/index.js";

/** Exports the recorder's recording with the session's current checkpoint, writes and reads it, and replays it. */
export async function replay(recorder: DebugRecorder): Promise<DebugReplayResult> {
  const recording = recorder.recording();
  assert.ok(recording);
  const exported: DebugExport = {
    format: "teasescript-debug-export",
    version: DEBUG_EXPORT_VERSION,
    build: { commit: null, dirty: null, mode: null, appVersion: null, ...debugBuildRevisions() },
    package: { id: null, version: null, contentHash: null },
    incident: {
      kind: "requested",
      code: null,
      path: null,
      line: null,
      column: null,
      hostError: null,
    },
    editedWhileDebugging: null,
    rewoundWhileDebugging: null,
    selection: {
      savedValues: true,
      answers: true,
      replay: true,
      sessionText: true,
      photos: false,
      player: false,
    },
    omissions: [],
    // The export checkpoints the state the recorded calls reach.
    checkpoint: createCheckpoint(recording.plan, recording.endSnapshot!),
    checkpointRole: "current",
    replay: {
      anchorSnapshot: recording.anchorSnapshot,
      operations: recording.operations,
      complete: recording.complete,
      reason: recording.reason,
    },
    photos: [],
    sections: {},
  };
  const file = await debugExportFile(exported, false);
  return replayDebugExport(parseDebugExport(await file.text()));
}

/** Exports the recorder's recording, as `replay` does, and returns the parsed export. */
export async function exportedRecording(recorder: DebugRecorder): Promise<DebugExport> {
  const recording = recorder.recording()!;
  const file = await debugExportFile(
    {
      format: "teasescript-debug-export",
      version: DEBUG_EXPORT_VERSION,
      build: { commit: null, dirty: null, mode: null, appVersion: null, ...debugBuildRevisions() },
      package: { id: null, version: null, contentHash: null },
      incident: {
        kind: "requested",
        code: null,
        path: null,
        line: null,
        column: null,
        hostError: null,
      },
      editedWhileDebugging: null,
      rewoundWhileDebugging: null,
      selection: {
        savedValues: true,
        answers: true,
        replay: true,
        sessionText: true,
        photos: false,
        player: false,
      },
      omissions: [],
      checkpoint: createCheckpoint(recording.plan, recording.endSnapshot!),
      checkpointRole: "current",
      replay: {
        anchorSnapshot: recording.anchorSnapshot,
        operations: recording.operations,
        complete: recording.complete,
        reason: recording.reason,
      },
      photos: [],
      sections: {},
    },
    false,
  );
  return parseDebugExport(await file.text());
}
