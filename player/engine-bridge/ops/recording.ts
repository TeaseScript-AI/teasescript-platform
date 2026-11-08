import type { DebugRecording, DebugRecordingEnd } from "../../debug-recorder.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { ExportCaptureReply, RecordingCaptureReply } from "../session-protocol.js";
import { playerRuntimeSnapshotOrNull } from "../../runtime-adapter.js";
import { prepareExport, type ExportFrozen } from "../recording/export-replay.js";
import type { BridgeOps } from "../worker-host.js";
import { heldSession } from "./persistence.js";
import {
  advanceExportObservation,
  isStopArguments,
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
 * A debug export's capture, frozen: the shown session's state and failure (none without a session), its marks, the
 * run's incident, the selected recording, and the plan the export identifies (the recording's before the shown one's).
 */
export interface ExportTicket extends ExportFrozen {
  readonly kind: "export";
}

/** The connection's tickets (`PlayerOpsContext.recordings`), by kind. */
export type HeldTicket = RecordingTicket | ExportTicket;

const isRun = (value: unknown): value is number => Number.isSafeInteger(value);

const isTicketArgs = (args: unknown): args is { readonly ticket: string } =>
  isRecord(args) && exactly(args, ["ticket"]) && typeof args.ticket === "string";

/** The ticket of kind `kind` held under `ticket`; throws for an unknown, released or other kind of ticket. */
export function heldTicket<K extends HeldTicket["kind"]>(
  context: PlayerOpsContext,
  ticket: string,
  kind: K,
): Extract<HeldTicket, { readonly kind: K }> {
  const held = context.recordings.get(ticket);
  if (held?.kind !== kind) throw new Error(`No ${kind} is held under this ticket.`);
  // EVIDENCE: validation: the held ticket's kind is `kind`, checked above.
  return held as Extract<HeldTicket, { readonly kind: K }>;
}

export function recordingOps(context: PlayerOpsContext): BridgeOps {
  const owner = context.exportObservation;
  return {
    // A Start or a Continue begins diagnostic run `run`, before any of its sessions exists; `retires` ends the run before.
    beginRun: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["run", "retires"]) &&
        isRun(args.run) &&
        (args.retires === null || isRun(args.retires)),
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { run, retires } = args as { readonly run: number; readonly retires: number | null };
        advanceExportObservation(owner, { kind: "beginRun", run, retires });
        return { result: null };
      },
    },
    // The Player's disposal ends its run.
    retireRun: {
      session: "none",
      checkArguments: (args) => isRecord(args) && exactly(args, ["run"]) && isRun(args.run),
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        advanceExportObservation(owner, {
          kind: "retire",
          run: (args as { readonly run: number }).run,
        });
        return { result: null };
      },
    },
    // A Player error before its run had a session: the run's incident, with no session to stop.
    commitIncident: {
      session: "none",
      checkArguments: isStopArguments,
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted stop arguments before run.
        const stop = args as StopArguments;
        advanceExportObservation(owner, { kind: "stopRequested", stop });
        const committed = advanceExportObservation(owner, {
          kind: "stopCommitted",
          stop,
          session: null,
        });
        return { result: committed.kind === "incident" ? committed.incident : null };
      },
    },
    // The named session's recording, kept under a new ticket when the recorder records that session's engine.
    captureRecording: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["session"]) && typeof args.session === "string",
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const held = heldSession(sessions, (args as { readonly session: string }).session);
        const capture = context.recorder.capture(held.publication.engine);
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
    },
    // A debug export's capture of the named session, or of none, with the recording `current` (the session's own, by its
    // engine) or held under a recording ticket. Refused when a stop of the run is still committing (retry) or the current
    // recording's provenance is not proved; never with another recording or state in its place.
    captureExport: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["session", "recording"]) &&
        (args.session === null || typeof args.session === "string") &&
        (args.recording === "current" ||
          (isRecord(args.recording) &&
            exactly(args.recording, ["ticket"]) &&
            typeof args.recording.ticket === "string")),
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const selector = args as {
          readonly session: string | null;
          readonly recording: "current" | { readonly ticket: string };
        };
        const held = selector.session === null ? null : heldSession(sessions, selector.session);
        const run = held === null ? owner.current : held.run;
        const decided = advanceExportObservation(owner, { kind: "capture", run });
        if (decided.kind === "pending") return { result: decided satisfies ExportCaptureReply };
        const incident = decided.kind === "incident" ? decided.incident : null;
        let recording: DebugRecording | null = null;
        if (selector.recording !== "current")
          recording = heldTicket(context, selector.recording.ticket, "recording").recording;
        else if (held !== null) {
          const capture = context.recorder.capture(held.publication.engine);
          if (capture.kind === "stale")
            return { result: { kind: "refused" } satisfies ExportCaptureReply };
          if (capture.kind === "captured") recording = capture.recording;
        }
        const current = held?.sessionForOperation() ?? null;
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
    },
    // What an export ticket's file needs of the engine: its plan's hash and, with `replay`, its replay data.
    exportPrepare: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["ticket", "replay"]) &&
        typeof args.ticket === "string" &&
        typeof args.replay === "boolean",
      run: async (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { ticket, replay } = args as { readonly ticket: string; readonly replay: boolean };
        return { result: await prepareExport(heldTicket(context, ticket, "export"), replay) };
      },
    },
    // Lets go of a ticket of any kind; releasing one already released, or unknown, changes nothing.
    releaseRecording: {
      session: "none",
      checkArguments: isTicketArgs,
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        context.recordings.delete((args as { readonly ticket: string }).ticket);
        return { result: null };
      },
    },
  };
}
