import type { InterpreterEvent } from "../../src/runtime/events.js";
import type { RuntimeSessionCall } from "../../src/runtime/session.js";
import type { InstructionFacts } from "./instruction-facts.js";
import type { PlanMetadata } from "./player-ops.js";
import type { OpArgs, OpResult, WorkerOp } from "./op-catalogue.js";
import type { HistoryMarks } from "../debug/debug-history-marks.js";
import type { HistoryDelta } from "./history/core.js";
import type { DebugRecording, DebugRecordingEnd } from "../debug/debug-recorder.js";
import type { RuntimeFailureSnapshot, RuntimeSnapshot } from "../../src/index.js";
import type { DiagnosticIdentity, ExportIncident } from "./recording/export-observation.js";
import type { PlayerRuntimeState } from "../runtime/runtime-adapter.js";

/*
 * What a session op's reply carries in `view` (the L5 reply contract). The host keeps one cursor per session: how many
 * of its events it has handed out, in replies or, in tests, through the in-process backend's facade. Every publication carries the events
 * after that cursor, so the main side's store applies them contiguously; a publication's identity is its revision.
 */

/**
 * What every publication shows (the critical view): the session's state without its active calls, which only Debug's
 * Now view and the error dialog read, and which a recursive script makes up to 1024 frames long.
 */
export type PlayerCriticalState = Omit<PlayerRuntimeState, "calls">;

/** The full view's addition to the critical one: the active calls, while the main side asks for them (`viewCalls`). */
export interface PlayerCallView {
  readonly calls: readonly RuntimeSessionCall[];
}

/**
 * The call view of a session's latest publication, as `viewCalls` answers it and `halt`'s acknowledgement carries it:
 * the main side merges it into the publication of the same revision, never into another.
 */
export interface CallViewReply {
  readonly revision: number;
  readonly instructions: InstructionFacts;
  readonly callView: PlayerCallView | null;
}

/**
 * What a Player error stop's acknowledgement carries: the stopped publication's call view, its diagnostic identity with
 * the stop, and the run's committed incident.
 */
export interface StopReply extends CallViewReply {
  readonly diagnostic: DiagnosticIdentity;
  readonly incident: ExportIncident | null;
}

/** One publication of a session: its state, its revision, and its events after the cursor `from`. */
export interface Publication {
  readonly revision: number;
  readonly state: PlayerCriticalState;
  /** The cursor before this publication: how many of the session's events were handed out before. */
  readonly from: number;
  /** The cursor after it. */
  readonly eventsThrough: number;
  /** The session's events in `(from, eventsThrough]`, in order. */
  readonly events: readonly InterpreterEvent[];
  /** Where in the script each instruction the view names is, by instruction index (`instructionFacts`). */
  readonly instructions: InstructionFacts;
  /** The active calls while the session's calls are viewed (`viewCalls`), else `null`. */
  readonly callView: PlayerCallView | null;
  /** The session's marks for a debug export, as the host holds them (`HeldSession.marks`). */
  readonly marks: HistoryMarks;
  /** The diagnostic run the session belongs to, and no stop: a stop's identity comes with its acknowledgement. */
  readonly diagnostic: DiagnosticIdentity;
  /** The run's committed Player error incident (`ExportObservation`), or `null` while it has none. */
  readonly incident: ExportIncident | null;
  /** The changes of Debug's rewind history this publication made, oldest first; empty for most. */
  readonly history: readonly HistoryDelta[];
}

/** The first publication of a session the host now holds, from cursor 0, with what stays fixed for its lifetime. */
export interface Introduction extends Publication {
  readonly from: 0;
  /** The host's token for the plan instance the session runs. */
  readonly planToken: string;
  /** What the Player reads from that plan, when the session brought a plan of its own (a restore or a transfer). */
  readonly metadata: PlanMetadata | null;
  /** The first event sequence the session's own runs emitted; the events before it are restored history. */
  readonly liveEventSequence: number;
  /** The key Debug's rewind history names the session's event log by (`HistoryPosition.log`). */
  readonly historyKey: string;
}

/**
 * A capture of a session's recording (`captureRecording`): kept under `ticket` when the recorder records that session,
 * with how it ends and whether every call is recorded; `stale` when it records another, `none` before any recording.
 */
export type RecordingCaptureReply =
  | {
      readonly kind: "captured";
      readonly ticket: string;
      readonly end: DebugRecordingEnd;
      readonly complete: boolean;
    }
  | { readonly kind: "stale" }
  | { readonly kind: "none" };

/** What a debug export's capture names as its session's observation: matched against the main side's store view. */
export interface ExportIdentity {
  readonly run: number | null;
  readonly session: string | null;
  readonly revision: number | null;
  readonly eventsThrough: number | null;
  /** The Player error stop that froze the session, or `null`. */
  readonly stop: number | null;
}

/**
 * A debug export's capture (`captureExport`): frozen under `ticket` with the shown session's state, marks and failure,
 * the run's incident and the selected recording; `pending` while a stop of the run commits (retry); `refused` with why.
 */
export type ExportCaptureReply =
  | {
      readonly kind: "captured";
      readonly ticket: string;
      readonly identity: ExportIdentity;
      readonly snapshot: RuntimeSnapshot | null;
      readonly failure: RuntimeFailureSnapshot | null;
      readonly marks: HistoryMarks | null;
      readonly incident: ExportIncident | null;
      readonly recording: DebugRecording | null;
    }
  | { readonly kind: "pending" }
  /**
   * The capture is no candidate: the host could not prove the current recording's provenance, or (on the main side,
   * `PlayerBridge.captureExport`) the store's view of the session is not the publication the host observed.
   */
  | { readonly kind: "refused"; readonly reason: "provenance" | "identity" };

/**
 * The host's session-free reads (`PlayerBridge.read`), by name, at run time: ops of no session (`WorkerOp`), each of
 * which reads the session its arguments name.
 */
export const READ_OPS = {
  debugView: true,
  captureKeep: true,
  captureCheckpoint: true,
  randomTried: true,
  captureStorage: true,
  captureRecording: true,
} as const satisfies { readonly [O in WorkerOp]?: true };
export type ReadOp = keyof typeof READ_OPS;
/**
 * Each read op with its arguments and its result, from its definition (`op-catalogue.ts`): the arguments without the
 * `session` that `read` inserts. A read of another op, or with other arguments, does not compile. The arguments are
 * checked again by the host at run time; the result is the same build's, so it is not checked when it arrives.
 */
export type ReadOps = {
  readonly [O in ReadOp]: {
    readonly args: Omit<OpArgs<O>, "session">;
    readonly result: OpResult<O>;
  };
};
/**
 * `read`'s call after the session for each read op, distributed so that an op and its arguments stay paired: no
 * arguments for a read whose only argument is the session.
 */
export type ReadCall<O extends ReadOp> = O extends unknown
  ? ReadOps[O]["args"] extends Record<string, never>
    ? [op: O]
    : [op: O, args: ReadOps[O]["args"]]
  : never;
