import type { InstructionPlan, RuntimeCheckpoint, RuntimeSnapshot } from "../../../src/index.js";
// The checkpoint's own module: the Worker's host loads no compiler until a source is prepared.
import { createCheckpoint } from "../../../src/runtime/snapshot/checkpoint.js";
import { serializeValidatedRuntimeJson } from "../../../src/runtime/snapshot/checkpoint-json.js";
import type { DebugExport, DebugReplay } from "../../debug/debug-export.js";
import type { DebugRecording } from "../../debug/debug-recorder.js";

/*
 * The parts of a debug export that need the engine, prepared in the host from an export ticket (L5h.3b): the plan's
 * content hash, and the replay data, whose checkpoints the engine's validation creates. The main side assembles the
 * rest (`debug-export-assembly.ts`).
 */

/** What `exportPrepare` gives an export: its plan's hash, and with replay chosen, its replay data and omissions. */
export interface PreparedExport {
  readonly contentHash: string | null;
  readonly checkpoint: RuntimeCheckpoint | null;
  readonly checkpointRole: DebugExport["checkpointRole"];
  readonly replay: DebugReplay | null;
  /** Why parts of the replay data were left out, in the order the export lists them. */
  readonly omissions: readonly string[];
}

/** What an export ticket freezes that its preparation reads: its plan, the shown session's state, and its recording. */
export interface ExportFrozen {
  readonly plan: InstructionPlan | null;
  readonly session: { readonly snapshot: RuntimeSnapshot | null } | null;
  readonly recording: DebugRecording | null;
}

/**
 * Prepares the export `frozen`: its plan's hash, and when `replay` is chosen, its replay data, which checkpoints where a
 * complete recording's calls lead (a failed session reached it before any later observation of time), else the state
 * shown, or without a session, the recording's end.
 */
export async function prepareExport(
  frozen: ExportFrozen,
  replay: boolean,
): Promise<PreparedExport> {
  const { plan, session, recording } = frozen;
  const shown = session === null ? (recording?.endSnapshot ?? null) : session.snapshot;
  const snapshot = recording?.complete === true ? recording.endSnapshot : shown;
  const omissions: string[] = [];
  const parts =
    replay && plan !== null
      ? replayData(plan, snapshot, recording, omissions)
      : { checkpoint: null, checkpointRole: null, replay: null };
  return { contentHash: plan === null ? null : await planHash(plan), ...parts, omissions };
}

/**
 * The checkpoint and recorded calls, or the last good state when the current one cannot be checkpointed, also when it
 * could not be exported (`null`).
 */
function replayData(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot | null,
  recording: DebugRecording | null,
  omissions: string[],
): Pick<DebugExport, "checkpoint" | "checkpointRole" | "replay"> {
  const calls = (anchorSnapshot: RuntimeSnapshot | null): DebugReplay | null =>
    recording === null
      ? null
      : {
          anchorSnapshot,
          operations: recording.operations,
          complete: recording.complete,
          reason: recording.reason,
        };
  if (recording === null) omissions.push("No engine calls were recorded for this session.");
  const current = snapshot === null ? null : checkpointOrNull(plan, snapshot);
  if (current !== null)
    return {
      checkpoint: current,
      checkpointRole: "current",
      replay: calls(recording?.anchorSnapshot ?? null),
    };
  if (recording === null) {
    omissions.push("The current state could not be checkpointed.");
    return { checkpoint: null, checkpointRole: null, replay: null };
  }
  omissions.push(
    "The current state could not be checkpointed; the export carries the last good state instead.",
  );
  return {
    checkpoint: createCheckpoint(plan, recording.anchorSnapshot),
    checkpointRole: "lastGood",
    replay: calls(null),
  };
}

/** A checkpoint of `snapshot`, or `null` when the engine's validation refuses the state. */
function checkpointOrNull(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): RuntimeCheckpoint | null {
  try {
    return createCheckpoint(plan, snapshot);
  } catch {
    return null;
  }
}

/** The SHA-256 of the compiled plan, identifying the script's content; `null` where the realm cannot hash. */
async function planHash(plan: InstructionPlan): Promise<string | null> {
  const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
  if (subtle === undefined) return null;
  try {
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializeValidatedRuntimeJson(plan)),
    );
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
