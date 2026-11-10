import type { DebugRecording, DebugRecordingEnd } from "../../debug/debug-recorder.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { ExportCaptureReply, RecordingCaptureReply } from "../session-protocol.js";
import { playerRuntimeSnapshotOrNull } from "../../runtime/runtime-adapter.js";
import {
  prepareExport,
  type ExportFrozen,
  type PreparedExport,
} from "../recording/export-replay.js";
import type { BridgeOp, BridgeOps } from "../worker-host.js";
import { heldSession } from "./persistence.js";
import {
  advanceExportObservation,
  ensureRun,
  RetiredRunError,
  isStopArguments,
  type ExportIncident,
  type StopArguments,
} from "../recording/export-observation.js";

/*
 * The recording ticket contract (L5h.3b): a capture of a session's recording, frozen under a ticket of the connection's
 * `recordings` registry until it is released. The recording binds to the engine that began it (`DebugRecorder.capture`),
 * so a capture answers `captured` only for the session whose engine the recorder records; `stale` and `none` capture
 * nothing.
 */

/** A session's recording as it was captured, with how it ends and the begin it belongs to. */
export interface RecordingTicket {
  readonly kind: "recording";
  readonly recording: DebugRecording;
  readonly end: DebugRecordingEnd;
  readonly epoch: number;
}

/**
 * A debug export's capture, held for its preparation (`exportPrepare`): what `ExportFrozen` keeps, the plan the export
 * identifies (the recording's before the shown one's), the shown session's snapshot and the selected recording. The
 * shown failure, marks and incident are delivered in the capture's reply (`ExportCaptureReply`), not held here.
 */
export interface ExportTicket extends ExportFrozen {
  readonly kind: "export";
}

/** The connection's tickets (`PlayerOpsContext.recordings`), by kind. */
export type HeldTicket = RecordingTicket | ExportTicket;

/** What `captureExport`'s check admits: the session, or none, and the recording it selects. */
export interface ExportCaptureArguments {
  readonly session: string | null;
  readonly recording: "current" | "none" | { readonly ticket: string };
}

const isRun = (value: unknown): value is number => Number.isSafeInteger(value);

const isTicketArgs = (args: unknown): args is { readonly ticket: string } =>
  isRecord(args) && exactly(args, ["ticket"]) && typeof args.ticket === "string";

/** The ticket of kind `kind` held under `ticket`; throws for an unknown, released or other kind of ticket. */
function heldTicket<K extends HeldTicket["kind"]>(
  context: PlayerOpsContext,
  ticket: string,
  kind: K,
): Extract<HeldTicket, { readonly kind: K }> {
  const held = context.recordings.get(ticket);
  if (held?.kind !== kind) throw new Error(`No ${kind} is held under this ticket.`);
  // EVIDENCE: validation: the held ticket's kind is `kind`, checked above.
  return held as Extract<HeldTicket, { readonly kind: K }>;
}

export function recordingOps(context: PlayerOpsContext) {
  return { ...recordingRunOps(context), ...exportCaptureOps(context) } satisfies BridgeOps;
}

/** The run and its recordings: the run retired, an incident committed, a recording captured, a ticket released. */
function recordingRunOps(context: PlayerOpsContext) {
  const owner = context.exportObservation;
  return {
    // The Player's disposal ends its run.
    retireRun: {
      session: "none",
      checkArguments: (args): args is { readonly run: number } =>
        isRecord(args) && exactly(args, ["run"]) && isRun(args.run),
      run: (args) => {
        const { run } = args;
        advanceExportObservation(owner, { kind: "retire", run });
        return { result: null };
      },
    } satisfies BridgeOp<{ readonly run: number }, null, "none">,
    // A Player error with no session to stop: its run begins here when the host has not seen it, as when its
    // activation failed before its first host request, ending the run before it. An incident of a run that ended is
    // refused before any effect.
    commitIncident: {
      session: "none",
      checkArguments: isStopArguments,
      run: (args) => {
        const stop = args;
        if (!ensureRun(owner, stop)) throw new RetiredRunError(stop.run);
        advanceExportObservation(owner, { kind: "stopRequested", stop });
        const committed = advanceExportObservation(owner, {
          kind: "stopCommitted",
          stop,
          session: null,
        });
        return { result: committed.kind === "incident" ? committed.incident : null };
      },
    } satisfies BridgeOp<StopArguments, ExportIncident | null, "none">,
    // The named session's recording, kept under a new ticket when the recorder records that session's engine.
    captureRecording: {
      session: "none",
      checkArguments: (args): args is { readonly session: string } =>
        isRecord(args) && exactly(args, ["session"]) && typeof args.session === "string",
      run: (args, sessions) => {
        const held = heldSession(sessions, args.session);
        const capture = context.recorder.capture(held.sessionForOperation().engine);
        if (capture.kind !== "captured") return { result: capture satisfies RecordingCaptureReply };
        const ticket = context.nextTicket();
        context.recordings.set(ticket, {
          kind: "recording",
          recording: capture.recording,
          end: capture.end,
          epoch: capture.epoch,
        });
        const result: RecordingCaptureReply = {
          kind: "captured",
          ticket,
          end: capture.end,
          complete: capture.recording.complete,
        };
        return { result };
      },
    } satisfies BridgeOp<{ readonly session: string }, RecordingCaptureReply, "none">,
    // Lets go of a ticket of any kind; releasing one already released, or unknown, changes nothing.
    releaseRecording: {
      session: "none",
      checkArguments: isTicketArgs,
      run: (args) => {
        context.recordings.delete(args.ticket);
        return { result: null };
      },
    } satisfies BridgeOp<{ readonly ticket: string }, null, "none">,
    // A read for the composable's test API (`debugRecording()`), with no production caller: the recording held under a
    // recording ticket, or with `null` the recorder's current one, as they stand when the host dispatches it; `null` for
    // an unknown, released or export ticket, and before any recording. It changes nothing.
    readRecording: {
      session: "none",
      checkArguments: (args): args is { readonly ticket: string | null } =>
        isRecord(args) &&
        exactly(args, ["ticket"]) &&
        (args.ticket === null || typeof args.ticket === "string"),
      run: (args) => {
        if (args.ticket === null) return { result: context.recorder.recording() };
        const held = context.recordings.get(args.ticket);
        return { result: held?.kind === "recording" ? held.recording : null };
      },
    } satisfies BridgeOp<{ readonly ticket: string | null }, DebugRecording | null, "none">,
  } satisfies BridgeOps;
}

/** A debug export: its capture, and what its file needs of the engine. */
function exportCaptureOps(context: PlayerOpsContext) {
  const owner = context.exportObservation;
  return {
    // A debug export's capture of the named session, or of none, with the recording `current` (the session's own, by its
    // engine), `none` (no recording: what a Player error's capture that settled unavailable selects), or one held under a
    // recording ticket. Refused when a stop of the run is still committing (retry) or the current recording's provenance
    // is not proved; never with another recording or state in its place.
    captureExport: {
      session: "none",
      checkArguments: (args): args is ExportCaptureArguments =>
        isRecord(args) &&
        exactly(args, ["session", "recording"]) &&
        (args.session === null || typeof args.session === "string") &&
        (args.recording === "current" ||
          args.recording === "none" ||
          (isRecord(args.recording) &&
            exactly(args.recording, ["ticket"]) &&
            typeof args.recording.ticket === "string")),
      run: (args, sessions) => {
        const selector = args;
        const held = selector.session === null ? null : heldSession(sessions, selector.session);
        const run = held === null ? owner.current : held.run;
        const decided = advanceExportObservation(owner, { kind: "capture", run });
        if (decided.kind === "pending") return { result: decided satisfies ExportCaptureReply };
        const incident = decided.kind === "incident" ? decided.incident : null;
        // The session at its latest publication, made ready for this op as every op does.
        const current = held?.sessionForOperation() ?? null;
        let recording: DebugRecording | null = null;
        if (typeof selector.recording === "object")
          recording = heldTicket(context, selector.recording.ticket, "recording").recording;
        else if (selector.recording === "current" && current !== null) {
          const capture = context.recorder.capture(current.engine);
          if (capture.kind === "stale")
            return {
              result: { kind: "refused", reason: "provenance" } satisfies ExportCaptureReply,
            };
          if (capture.kind === "captured") recording = capture.recording;
        }
        const snapshot = current === null ? null : playerRuntimeSnapshotOrNull(current);
        const plan =
          recording?.plan ?? (held === null ? null : (context.plans.get(held.planToken) ?? null));
        const ticket = context.nextTicket();
        context.recordings.set(ticket, {
          kind: "export",
          plan,
          session: held === null ? null : { snapshot },
          recording,
        });
        const result: ExportCaptureReply = {
          kind: "captured",
          ticket,
          identity: {
            run,
            session: selector.session,
            revision: held?.observation?.revision ?? null,
            eventsThrough: held?.observation?.eventsThrough ?? null,
            stop: held?.stoppedBy ?? null,
          },
          snapshot,
          failure: current?.state.failure ?? null,
          marks: held?.marks ?? null,
          incident,
          recording,
        };
        return { result };
      },
    } satisfies BridgeOp<ExportCaptureArguments, ExportCaptureReply, "none">,
    // What an export ticket's file needs of the engine: its plan's hash and, with `replay`, its replay data.
    exportPrepare: {
      session: "none",
      checkArguments: (args): args is { readonly ticket: string; readonly replay: boolean } =>
        isRecord(args) &&
        exactly(args, ["ticket", "replay"]) &&
        typeof args.ticket === "string" &&
        typeof args.replay === "boolean",
      run: async (args) => {
        const { ticket, replay } = args;
        return { result: await prepareExport(heldTicket(context, ticket, "export"), replay) };
      },
    } satisfies BridgeOp<
      { readonly ticket: string; readonly replay: boolean },
      PreparedExport,
      "none"
    >,
  } satisfies BridgeOps;
}
