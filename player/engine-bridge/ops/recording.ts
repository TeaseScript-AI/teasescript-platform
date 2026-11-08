import type { DebugRecording, DebugRecordingEnd } from "../../debug-recorder.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { RecordingCaptureReply } from "../session-protocol.js";
import type { BridgeOps } from "../worker-host.js";
import { heldSession } from "./persistence.js";

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

/** The connection's tickets (`PlayerOpsContext.recordings`), by kind. */
export type HeldTicket = RecordingTicket;

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
  return {
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
