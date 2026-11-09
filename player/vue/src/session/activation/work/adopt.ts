import type { BridgeResult } from "../../../../../engine-bridge/client.js";
import type { RandomIntent } from "../../../../../engine-bridge/player-ops.js";
import type { Origin, ReplyHandlers, Settlement } from "../useActivationRun.js";
import type { SessionTarget } from "./target.js";

/*
 * The adoption's work (session split S2): giving a shown session this Player's random control, for the activation that
 * shows it. Its reply writes the history's revision and its failure stops the Player only while that activation lives.
 */

/** What the adoption's work needs from the random control's owner. */
export interface AdoptPage {
  readonly admits: (origin: Origin) => boolean;
  /** Settles a reply for `origin`, inside the reaction this work attaches (the record's `settle`). */
  readonly settle: <T>(origin: Origin, outcome: Settlement<T>, handlers: ReplyHandlers<T>) => void;
  /** Takes the history's revision from the adoption's reply, while the Player lives. */
  readonly adopted: (reply: BridgeResult) => void;
  /** Whether a failure is no error stop (it ends quietly, or the Player was unmounted). */
  readonly quiet: (error: unknown) => boolean;
  readonly report: (origin: Origin, error: unknown) => void;
}

/** Gives `target`'s session the control of `intent`, for `origin`: settled once its reply's reaction ran. */
export function adopt(
  target: SessionTarget,
  intent: RandomIntent,
  origin: Origin,
  page: AdoptPage,
): Promise<void> {
  if (!page.admits(origin)) return Promise.resolve();
  const handlers: ReplyHandlers<BridgeResult> = {
    done: (reply) => {
      page.adopted(reply);
      return undefined;
    },
    failed: (error) => {
      if (!page.quiet(error)) page.report(origin, error);
      return undefined;
    },
  };
  // The adoption's own reaction, in which the record settles its reply.
  return target.adoptRandom(intent).then(
    (reply) => page.settle(origin, { ok: true, value: reply }, handlers),
    (error: unknown) => page.settle(origin, { ok: false, error }, handlers),
  );
}
