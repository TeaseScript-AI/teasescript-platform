import { serializeValidatedRuntimeJson } from "../../../src/runtime/snapshot/checkpoint-json.js";
import { playerRuntimeSnapshotJson } from "../../runtime/runtime-adapter.js";
import type { PlayerTransfer, SessionTransfer } from "../../persistence/session-transfer.js";
import {
  readPlayerTransferFile,
  readPlayerTransferText,
  restoreSessionTransfer,
} from "../../persistence/session-transfer-read.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOp, BridgeOps } from "../worker-host.js";
import { readPlanText } from "./persistence.js";

/*
 * The reading of an exported file or text of saved data or a session, in the host (L5h.2): decompression, the whole
 * document's parse and validation, and a session's restore against the shown script, whose checkpoint and restored
 * state stay here under a ticket. The main side gets plain data back, and for an import the state as the kept session
 * stores it (`transferCommit`). Errors keep their class and words (`StorageTransferError`).
 */

/** A session read for an import: the document, and once reviewed, the restored state as the kept session stores it. */
export interface TransferTicket {
  readonly transfer: SessionTransfer;
  snapshotJson: string | null;
}

/**
 * What `readTransfer` replies: saved data whole, or a session as plain data, whose checkpoint the host keeps under
 * `ticket`.
 */
export type TransferRead =
  | Extract<PlayerTransfer, { readonly kind: "savedData" }>
  | ({ readonly kind: "session"; readonly ticket: string } & Pick<
      SessionTransfer,
      "scope" | "name" | "entries" | "media"
    > & { readonly events: SessionTransfer["session"]["events"] });

const isTicket = (args: unknown): args is { readonly ticket: string } =>
  isRecord(args) && exactly(args, ["ticket"]) && typeof args.ticket === "string";

/** The session held under `ticket`; throws for a ticket released, or of a connection torn down since. */
function ticketOf(context: PlayerOpsContext, ticket: string): TransferTicket {
  const held = context.transfers.get(ticket);
  if (held === undefined)
    throw new Error("No session read for an import is held under this ticket.");
  return held;
}

export function transferOps(context: PlayerOpsContext) {
  return {
    // A file's bytes or a pasted text: saved data comes back whole; a session as plain data, its checkpoint kept here.
    readTransfer: {
      session: "none",
      checkArguments: (
        args,
      ): args is { readonly bytes: Uint8Array<ArrayBuffer> } | { readonly text: string } =>
        isRecord(args) &&
        ((exactly(args, ["bytes"]) &&
          args.bytes instanceof Uint8Array &&
          // One realm, as `instanceof Uint8Array` assumes; names no `SharedArrayBuffer`, absent in non-isolated pages.
          args.bytes.buffer instanceof ArrayBuffer) ||
          (exactly(args, ["text"]) && typeof args.text === "string")),
      run: async (args) => {
        const input = args;
        const read =
          "bytes" in input
            ? await readPlayerTransferFile(input.bytes)
            : await readPlayerTransferText(input.text);
        if (read.kind === "savedData") return { result: read };
        const { session: transfer } = read;
        context.transferCount += 1;
        const ticket = `transfer-${context.transferCount}`;
        const held: TransferTicket = { transfer, snapshotJson: null };
        context.transfers.set(ticket, held);
        return {
          result: {
            kind: "session",
            ticket,
            scope: transfer.scope,
            name: transfer.name,
            entries: transfer.entries,
            media: transfer.media,
            events: transfer.session.events,
          },
        };
      },
    } satisfies BridgeOp<
      { readonly bytes: Uint8Array<ArrayBuffer> } | { readonly text: string },
      TransferRead,
      "none"
    >,
    // The ticket's session restored against the held plan `plan` of the script of storage scope `scope`: refused with
    // the reason when it cannot continue there; kept as the kept session stores it.
    reviewTransfer: {
      session: "none",
      checkArguments: (
        args,
      ): args is { readonly ticket: string; readonly scope: string; readonly plan: string } =>
        isRecord(args) &&
        exactly(args, ["ticket", "scope", "plan"]) &&
        typeof args.ticket === "string" &&
        typeof args.scope === "string" &&
        typeof args.plan === "string",
      run: (args) => {
        const { ticket, scope, plan } = args;
        const held = ticketOf(context, ticket);
        const restored = restoreSessionTransfer(held.transfer, scope, readPlanText(context, plan));
        held.snapshotJson = playerRuntimeSnapshotJson(restored);
        return { result: null };
      },
    } satisfies BridgeOp<
      { readonly ticket: string; readonly scope: string; readonly plan: string },
      null,
      "none"
    >,
    // What the kept session of a reviewed import stores: its state, and its events as the engine writes them.
    transferCommit: {
      session: "none",
      checkArguments: isTicket,
      run: (args) => {
        const held = ticketOf(context, args.ticket);
        if (held.snapshotJson === null)
          throw new Error("This session was not reviewed for an import.");
        return {
          result: {
            snapshotJson: held.snapshotJson,
            eventsJson: held.transfer.session.events.map(serializeValidatedRuntimeJson),
          },
        };
      },
    } satisfies BridgeOp<
      { readonly ticket: string },
      { readonly snapshotJson: string; readonly eventsJson: readonly string[] },
      "none"
    >,
    // Lets go of a ticket: the review was cancelled, replaced or committed.
    releaseTransfer: {
      session: "none",
      checkArguments: isTicket,
      run: (args) => {
        context.transfers.delete(args.ticket);
        return { result: null };
      },
    } satisfies BridgeOp<{ readonly ticket: string }, null, "none">,
  } satisfies BridgeOps;
}
