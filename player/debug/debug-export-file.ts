import type {
  RandomChoiceReceipt,
  RuntimeCheckpoint,
  RuntimeSnapshot,
  StoredFileKind,
} from "../../src/playback.js";
import {
  CHECKPOINT_VERSION,
  serializeValidatedRuntimeJson,
} from "../../src/runtime/snapshot/checkpoint-json.js";
import { INSTRUCTION_PLAN_VERSION } from "../../src/plan/model.js";
import { RUNTIME_SNAPSHOT_VERSION } from "../../src/runtime/snapshot/snapshot-format.js";
import type {
  DebugEditedWhileDebugging,
  DebugRewoundWhileDebugging,
} from "./debug-history-marks.js";
import { base64urlSlices, jsonFile, measuredJsonFile } from "../persistence/transfer-encoding.js";

/*
 * The debug export's format and its file, as the Player's main realm writes it: the types, the revisions, the file name
 * and the writer. It loads no engine module. Reading a file and replaying it are `debug-export.ts`'s, in the Worker and
 * in `tools/debug-export.mjs`.
 */

/**
 * A debug export: what a developer needs to find why a Player session failed, gathered with the player's consent. The
 * technical report locates the failure without runtime values. With the player's consent it also carries the canonical
 * checkpoint, the snapshot an earlier boundary left (the replay anchor), and every engine call the Player made since, so
 * `replayDebugExport` can run the same calls again; and photos the session used, linked to where they were used. The
 * file is untrusted external data wherever it is read.
 */
export interface DebugExport {
  readonly format: typeof DEBUG_EXPORT_FORMAT;
  readonly version: typeof DEBUG_EXPORT_VERSION;
  readonly build: DebugBuild;
  readonly package: DebugPackage;
  readonly incident: DebugIncident;
  /**
   * Whether Debug's storage editor changed the session's saved values (DEBUGGER.md "Player Debug"), which makes it a
   * diagnostic fork: the scene time of the first edit and how many there were; `null` when none. An edit before the
   * replay anchor is not among the recorded calls, so only this says so.
   */
  readonly editedWhileDebugging: DebugEditedWhileDebugging | null;
  /**
   * Whether Debug's rewind (DEBUGGER.md "Rewind") restored an earlier state of the session, which makes it a
   * diagnostic fork: the scene time of the state the latest rewind restored and how many rewinds led to the session;
   * `null` when none. The replay anchor is at or after that restored state.
   */
  readonly rewoundWhileDebugging: DebugRewoundWhileDebugging | null;
  /** The player's choices; `replay` requires `savedValues`, `answers`, and `sessionText`, because state copies them. */
  readonly selection: DebugSelection;
  /** Why parts are missing, in words for the developer. */
  readonly omissions: readonly string[];
  readonly checkpoint: RuntimeCheckpoint | null;
  /**
   * `current`: the state after the last recorded call, which a replay must reach. `lastGood`: the state could not be
   * checkpointed, so this is the last valid one, which is also the replay anchor.
   */
  readonly checkpointRole: "current" | "lastGood" | null;
  readonly replay: DebugReplay | null;
  readonly photos: readonly DebugPhoto[];
  /** Readable sections such as recent events or the Debug log, by name; replay never reads them. */
  readonly sections: Readonly<Record<string, unknown>>;
}

export interface DebugBuild {
  readonly commit: string | null;
  /** Whether the build had uncommitted changes; `null` when unknown. */
  readonly dirty: boolean | null;
  readonly mode: string | null;
  readonly appVersion: string | null;
  readonly checkpointVersion: number;
  readonly planVersion: number;
  readonly snapshotVersion: number;
}

/** What the trusted host knows of the script; unknown fields are `null`, never guessed. */
export interface DebugPackage {
  readonly id: string | null;
  readonly version: string | null;
  readonly contentHash: string | null;
}

export interface DebugIncident {
  /** A script failure, an exception of the Player itself, or an export the player asked for. */
  readonly kind: "runtimeFailure" | "hostError" | "requested";
  readonly code: string | null;
  readonly path: string | null;
  /** One-based line and column. */
  readonly line: number | null;
  readonly column: number | null;
  /** The error name of a Player exception, never its message. */
  readonly hostError: string | null;
}

export interface DebugSelection {
  readonly savedValues: boolean;
  readonly answers: boolean;
  readonly replay: boolean;
  readonly sessionText: boolean;
  readonly photos: boolean;
  readonly player: boolean;
}

export interface DebugReplay {
  /**
   * The snapshot the calls start from; `null` when the checkpoint is the last good state and itself the anchor. A
   * written export's anchor is one the engine's validation accepts for the checkpoint's plan.
   */
  readonly anchorSnapshot: RuntimeSnapshot | null;
  readonly operations: readonly DebugOperation[];
  /** Whether every call since the anchor is recorded; otherwise `reason` says why not. */
  readonly complete: boolean;
  readonly reason: string | null;
}

export type DebugOperationKind = (typeof OPERATION_KINDS)[number];

/**
 * How the player gave the answer a `completeAction` passed: Enter in the composer (`enter`), its Send button (`send`), a
 * button of the request, clicked or activated by key (`button`), or the key that activates the preselected button from
 * the composer (`preselectedKey`).
 */
export type DebugAnswerInput = (typeof ANSWER_INPUTS)[number];

/**
 * One engine call the Player made, with the plain arguments it passed after the plan and snapshot: `run` takes its run
 * options; `observeTime` the time and media reports; `completeAction` the request; `reportMediaLoad` the media and
 * report; `pressPermanentButton` the button; `recordContinueCapture` the capture; `applyExternalStorageEdit` the edit;
 * `updateInteraction` the form edit; `resumeRandomDraw` the resolution of a draw that paused before the anchor;
 * `setDebugMode` whether Debug is on.
 *
 * A call that paused at a random draw (`docs/RUNTIME.md#controlled-randomness`) stays one record while the Player
 * resolves its draws: each resolution adds its events to the call it continues, and a chosen one also its outcome, so
 * the record holds the call as one decided run would make it.
 */
export interface DebugOperation {
  readonly seq: number;
  readonly kind: DebugOperationKind;
  readonly args: readonly unknown[];
  /** The answers the Player's media store gave during a `completeAction`, in order. */
  readonly admissionQueries: readonly DebugAdmissionQuery[];
  /** The outcome kind, `ran` for `run`, or `null` when the call threw. */
  readonly outcome: string | null;
  /** The sequence of the first event the call emitted, and how many it emitted. */
  readonly events: { readonly first: number | null; readonly count: number };
  /** The session status after the call; unchanged when it threw. */
  readonly status: RuntimeSnapshot["status"];
  /** The error name when the call threw. */
  readonly thrown: string | null;
  /** The random outcomes the Player chose during the call and the resolutions that continued it, in draw order. */
  readonly randomChoices: readonly RandomChoiceReceipt[];
  /** The ID of the random draw the call stands paused at, or `null`. */
  readonly pausedAt: number | null;
  /** For a `completeAction`, how the player gave its answer; `null` for other calls and other answers. */
  readonly input: DebugAnswerInput | null;
}

export interface DebugAdmissionQuery {
  readonly reference: string;
  readonly kind: StoredFileKind;
  readonly result: boolean;
}

/**
 * A photo the export refers to; `data` is its original bytes when the player chose to include them. `usedBy` is empty
 * for a photo no recorded call or saved value used, which the export holds otherwise, such as in a variable.
 */
export interface DebugPhoto {
  readonly reference: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly data: Uint8Array<ArrayBuffer> | null;
  readonly usedBy: readonly DebugPhotoUse[];
}

/** Where a photo was used: the recorded call and the action it answered, or the saved value it was loaded from. */
export interface DebugPhotoUse {
  readonly relation: "capture" | "imageAnswer" | "savedValue";
  readonly operation: number | null;
  readonly actionId: number | null;
}

export const DEBUG_EXPORT_FORMAT = "teasescript-debug-export";
// 2: adds the `applyExternalStorageEdit` call. 3: adds the `updateInteraction` call. 4: adds a call's chosen random
// outcomes and paused draw, and the `resumeRandomDraw` call. 5: adds the `setDebugMode` call. 6: adds how the player
// gave an answer.
export const DEBUG_EXPORT_VERSION = 6;
/** The most JSON a reader decompresses or parses; a diagnostic-tool limit, not a TeaseScript one. */
export const DEBUG_EXPORT_MAX_JSON_BYTES = 64 * 1024 * 1024;

export const OPERATION_KINDS = [
  "run",
  "observeTime",
  "completeAction",
  "reportMediaLoad",
  "pressPermanentButton",
  "recordContinueCapture",
  "applyExternalStorageEdit",
  "updateInteraction",
  "resumeRandomDraw",
  "setDebugMode",
] as const;
export const ANSWER_INPUTS = ["enter", "send", "button", "preselectedKey"] as const;

/** The revisions of this build, for an export's `build`. */
export function debugBuildRevisions(): Pick<
  DebugBuild,
  "checkpointVersion" | "planVersion" | "snapshotVersion"
> {
  return {
    checkpointVersion: CHECKPOINT_VERSION,
    planVersion: INSTRUCTION_PLAN_VERSION,
    snapshotVersion: RUNTIME_SNAPSHOT_VERSION,
  };
}

/** The file name for a debug export of the named script. */
export function debugExportFileName(name: string, gzip: boolean): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 80);
  return `${safe || "script"}-debug.teasedebug.json${gzip ? ".gz" : ""}`;
}

/**
 * The export as a file: gzip, or plain JSON without `gzip`. It writes the export as given, without checkpoint
 * validation: its caller supplies a checkpoint `createCheckpoint` made and an anchor valid for that checkpoint's plan,
 * as the Player's come from the host's `exportPrepare`. A file is validated where it is read (`parseDebugExport`).
 */
export function debugExportFile(exported: DebugExport, gzip: boolean): Promise<Blob> {
  return jsonFile(pieces(exported), gzip);
}

/** `debugExportFile`, with the size of the uncompressed JSON in UTF-8 bytes. */
export function measuredDebugExportFile(
  exported: DebugExport,
  gzip: boolean,
): Promise<{ readonly file: Blob; readonly jsonBytes: number }> {
  return measuredJsonFile(pieces(exported), gzip);
}

/** The document in pieces: deep runtime state is written without recursion, photo data slice by slice. */
function* pieces(exported: DebugExport): Generator<string> {
  const { checkpoint, replay, photos, sections } = exported;
  yield `{"format":${JSON.stringify(DEBUG_EXPORT_FORMAT)},"version":${DEBUG_EXPORT_VERSION},`;
  for (const field of [
    "build",
    "package",
    "incident",
    "editedWhileDebugging",
    "rewoundWhileDebugging",
    "selection",
    "omissions",
  ] as const)
    yield `\n${JSON.stringify(field)}:${JSON.stringify(exported[field])},`;
  yield `\n"checkpoint":${checkpoint === null ? "null" : serializeValidatedRuntimeJson(checkpoint)},`;
  yield `\n"checkpointRole":${JSON.stringify(exported.checkpointRole)},`;
  if (replay === null) yield `\n"replay":null,`;
  else {
    const anchor =
      replay.anchorSnapshot === null || checkpoint === null
        ? "null"
        : serializeValidatedRuntimeJson(replay.anchorSnapshot);
    yield `\n"replay":{"complete":${replay.complete},"reason":${JSON.stringify(replay.reason)},"anchorSnapshot":${anchor},"operations":[`;
    for (const [index, operation] of replay.operations.entries())
      yield `${index === 0 ? "\n" : ",\n"}${serializeValidatedRuntimeJson(operation)}`;
    yield "]},";
  }
  yield `\n"photos":[`;
  for (const [index, photo] of photos.entries()) {
    const { data, ...descriptor } = photo;
    yield `${index === 0 ? "\n" : ",\n"}${JSON.stringify(descriptor).slice(0, -1)},"data":`;
    if (data === null) yield "null}";
    else {
      yield '"';
      yield* base64urlSlices(data);
      yield '"}';
    }
  }
  yield `],\n"sections":${serializeValidatedRuntimeJson(sections)}}\n`;
}

/** JSON text of plain data from an export, such as recorded arguments, written without recursion. */
export function debugExportJson(value: unknown): string {
  return serializeValidatedRuntimeJson(value);
}
