import type { InterpreterEvent } from "../../src/runtime/events.js";
import type { RuntimeSessionCall } from "../../src/runtime/session.js";
import type { InstructionFacts } from "./instruction-facts.js";
import type { PlanMetadata } from "./player-ops.js";
import type { DebugView, DebugViewRequest } from "../debug-view.js";
import type { CheckpointCapture, KeepCapture } from "./ops/persistence.js";
import type { RandomTriedView } from "./ops/random.js";
import type { StorageCapture } from "./ops/history.js";
import type { HistoryMarks } from "../debug-history-marks.js";
import type { HistoryDelta } from "./history/core.js";
import type { DebugRecordingEnd } from "../debug-recorder.js";
import type { PlayerRuntimeState } from "../runtime-adapter.js";

/*
 * What a session op's reply carries in `view` (the L5 reply contract). The host keeps one cursor per session: how many
 * of its events it has handed out, in replies or through the transition facade. Every publication carries the events
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

/**
 * The host's session-free reads (`PlayerBridge.read`), each op with its arguments and its result: a read of an op this
 * map lacks, or with other arguments, does not compile. The arguments are checked again by the host at run time; the
 * result is the same build's, so it is not checked when it arrives.
 */
export interface ReadOps {
  readonly debugView: {
    readonly args: { readonly request: DebugViewRequest };
    readonly result: DebugView;
  };
  readonly captureKeep: {
    readonly args: { readonly plan: string | null };
    readonly result: KeepCapture;
  };
  readonly captureCheckpoint: {
    readonly args: Record<string, never>;
    readonly result: CheckpointCapture;
  };
  readonly randomTried: {
    readonly args: { readonly site: string };
    readonly result: RandomTriedView;
  };
  readonly captureStorage: {
    readonly args: Record<string, never>;
    readonly result: StorageCapture;
  };
  readonly captureRecording: {
    readonly args: Record<string, never>;
    readonly result: RecordingCaptureReply;
  };
}
export type ReadOp = keyof ReadOps;
/** The read ops by name, at run time: exactly the keys of `ReadOps`. */
export const READ_OPS = {
  debugView: true,
  captureKeep: true,
  captureCheckpoint: true,
  randomTried: true,
  captureStorage: true,
  captureRecording: true,
} as const satisfies Record<ReadOp, true>;
