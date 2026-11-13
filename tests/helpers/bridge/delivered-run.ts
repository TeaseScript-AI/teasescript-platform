import type { PlayerOpsContext } from "../../../player/engine-bridge/player-ops.js";
import type {
  BridgeOps,
  HostSessions,
  OpOutcome,
} from "../../../player/engine-bridge/worker-host.js";

/**
 * Runs the Player's ops directly, as their host does: each inside a delivery of the context's owner (`delivery.ts`),
 * committed once it settled, undone when it throws. An allocation outside a delivery is refused.
 */
export function deliveredRun(
  context: PlayerOpsContext,
  ops: BridgeOps,
  sessions: HostSessions,
): (op: string, args: unknown) => Promise<OpOutcome> {
  return async (op, args) => {
    const delivery = context.delivery.begin();
    try {
      const outcome = await ops[op]!.run(args, sessions, null);
      context.delivery.commit(delivery);
      return outcome;
    } catch (error) {
      context.delivery.rollback(delivery);
      throw error;
    }
  };
}
