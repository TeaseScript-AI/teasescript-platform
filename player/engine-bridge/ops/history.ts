import type { RuntimeScriptStorageEntrySnapshot } from "../../../src/index.js";
import { playerRuntimeSnapshot } from "../../runtime-adapter.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps } from "../worker-host.js";
import { heldSession } from "./persistence.js";

/** What a rewind adoption replaces the saved values with: the shown state's script storage, at its revision. */
export interface StorageCapture {
  readonly revision: number;
  readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
  /** Whether the state's saved values are persistent: only then does an adoption write them. */
  readonly persistent: boolean;
}

/**
 * Debug's rewind reads of a held session (`useDebugRewind`, `adoptShown`): session-free ops, as `PlayerBridge.read`
 * posts them after the session's earlier requests.
 */
export function historyOps(_context: PlayerOpsContext): BridgeOps {
  return {
    // The session's saved values as its state holds them, for an adoption.
    captureStorage: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["session"]) && typeof args.session === "string",
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted the session's ID.
        const held = heldSession(sessions, (args as { readonly session: string }).session);
        const current = held.sessionForOperation();
        const snapshot = playerRuntimeSnapshot(current);
        const result: StorageCapture = {
          revision: current.revision,
          entries: snapshot.scriptStorage,
          persistent: snapshot.scriptStoragePersistent,
        };
        return { result };
      },
    },
  };
}
