import assert from "node:assert/strict";

import {
  sessionTransferFile,
  type SessionTransfer,
} from "../../player/persistence/session-transfer.js";

/** A session read for an import, as these tests pass it to a review: its checkpoint stays in the host. */
export interface SessionRead {
  readonly kind: "session";
  readonly ticket: string;
}

/**
 * `transfer` read for an import on `host`, as the Player's import dialog reads an exported file: its bytes, in the
 * engine host (`readTransfer`), which keeps its checkpoint under a ticket.
 */
export async function readForImport(
  host: {
    readTransfer(input: {
      readonly bytes: Uint8Array<ArrayBuffer>;
    }): Promise<{ readonly kind: string }>;
  },
  transfer: SessionTransfer,
): Promise<SessionRead> {
  const bytes = new Uint8Array(await (await sessionTransferFile(transfer, false)).arrayBuffer());
  const read = await host.readTransfer({ bytes });
  assert.equal(read.kind, "session");
  // EVIDENCE: validation: `readTransfer` read a session, checked above; its reply is the composable's read of one.
  return read as SessionRead;
}
