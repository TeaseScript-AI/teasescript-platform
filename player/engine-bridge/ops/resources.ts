import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps } from "../worker-host.js";

/** The ops of family L5e (the L5 series), capture, file store and lock answers: none yet; L5e adds them here. */
export function resourceOps(_context: PlayerOpsContext): BridgeOps {
  return {};
}
