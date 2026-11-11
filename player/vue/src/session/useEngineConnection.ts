import { createInProcessBackend } from "../../../engine-bridge/in-process.js";
import type { BridgeLostError, BridgeResult } from "../../../engine-bridge/client.js";
import type { OpArgs, OpResult } from "../../../engine-bridge/op-catalogue.js";
import type { PlayerBridge } from "../../../runtime/player-bridge.js";
import { playerBuildIdentity } from "../../../build-identity.js";
import type { PlayerSessionOptions } from "./usePlayerSession.js";

/*
 * The Player's connection to the engine's host, moved from `usePlayerSession` unchanged: the bridge, its readiness, this
 * Player's claim on it, the listener of its loss, and the script's preparation in it (`prepare`).
 */

/** What the connection tells the Player's session composable, in the order the steps below give. */
interface EngineConnectionHost {
  readonly options: PlayerSessionOptions;
  readonly isDisposed: () => boolean;
  /** The Player's claim on the ready bridge was taken, with its generation (`PlayerBridge.claim`). */
  readonly claimed: (generation: number) => void;
  /** The bridge was lost after it was ready; an intentional `terminate()` is no loss. */
  readonly lost: (error: BridgeLostError) => void;
  /** The bridge is ready and this Player holds it: what waited for it is sent now. */
  readonly ready: (bridge: PlayerBridge) => void;
  /** The host never became reachable, or another Player holds it. */
  readonly unreachable: () => void;
}

export function useEngineConnection({
  options,
  isDisposed,
  claimed,
  lost,
  ready,
  unreachable,
}: EngineConnectionHost) {
  // The engine's host, which owns the plans, the sessions and the recorder of every session's engine calls from Start,
  // in every build, for a debug export (DEBUGGER.md "Debug export"); in-process by default.
  // The in-process backend is ready at once, so a Start within the first click needs no wait.
  let bridge: PlayerBridge | null =
    options.bridge === undefined
      ? createInProcessBackend(playerBuildIdentity, {
          ...(options.debugHistorySpill && { historySpill: options.debugHistorySpill }),
          ...(options.debugHistoryMemoryBudget !== undefined && {
            historyBudget: options.debugHistoryMemoryBudget,
          }),
        })
      : null;
  // This Player's hold on its bridge (`PlayerBridge.claim`): one live Player per bridge.
  const claim = Symbol("Player");
  // The bridge once this Player took it, or `null` before.
  let held: PlayerBridge | null = null;
  // Once the host is reachable, and only while this Player lives: it takes the bridge, observes its loss, and sends what
  // waited for it before any Start that waits for it. A host that never became reachable, or one another Player holds,
  // is the `bridge` promise's failure, which its own callers handle.
  const connected = (options.bridge ?? Promise.resolve(bridge!)).then((reached) => {
    if (isDisposed()) return reached;
    claimed(reached.claim(claim));
    bridge = reached;
    held = reached;
    reached.client.onLoss(lost);
    ready(reached);
    return reached;
  });
  connected.catch(() => unreachable());

  return {
    /** This Player's claim, with which it holds the bridge and its random control there. */
    claim,
    /** The engine's host now, or `null` before it is ready; the in-process backend is there at once. */
    now: (): PlayerBridge | null => bridge,
    /** The engine's host, which the in-process backend gives at once; an injected one is ready before any Start. */
    require(): PlayerBridge {
      if (bridge === null) throw new Error("The engine's host is not ready.");
      return bridge;
    },
    /** The current connection once it is ready: the one this Player was given, for its whole life. */
    currentConnection: (): Promise<PlayerBridge> => connected,
    /**
     * Compiles `script` in the engine's host without running it (`prepare`): the one place the Player's pages send it.
     * It is sent at once when this Player holds the bridge, else as soon as it does.
     */
    prepareScriptSource(
      script: OpArgs<"prepare">["source"]["script"],
    ): Promise<BridgeResult<OpResult<"prepare">>> {
      const send = (host: PlayerBridge) =>
        host.client.request("prepare", { source: { kind: "source", script } });
      return held !== null ? send(held) : connected.then(send);
    },
    /** Gives the bridge up at the Player's disposal, for a later Player to claim. */
    release(): void {
      bridge?.unclaim(claim);
    },
  };
}
