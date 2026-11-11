import { createInProcessBackend } from "../../../engine-bridge/in-process.js";
import type { BridgeLostError, BridgeResult } from "../../../engine-bridge/client.js";
import type { OpResult } from "../../../engine-bridge/op-catalogue.js";
import type { PlayerProject } from "../../../runtime/runtime-adapter.js";
import type { PlayerBridge } from "../../../runtime/player-bridge.js";
import { playerBuildIdentity } from "../../../build-identity.js";
import type { PlayerSessionOptions } from "./usePlayerSession.js";

/*
 * The Player's connection to the engine's host: the bridge, its readiness, this Player's claim on it, the listener of its
 * loss, the script's preparation in it (`prepare`), and, after a loss, its replacement by a fresh connection from the
 * player's click (PLAYER-UI "Session end and failure").
 */

/** What the connection tells the Player's session composable, in the order the steps below give. */
interface EngineConnectionHost {
  readonly options: PlayerSessionOptions;
  readonly isDisposed: () => boolean;
  /** A fresh connection replaces a lost one: what the Player issued to the lost host is issued again on it. */
  readonly replaced: () => void;
  /** The Player's claim on the ready bridge was taken, with its generation (`PlayerBridge.claim`). */
  readonly claimed: (generation: number) => void;
  /** The bridge was lost after it was ready; an intentional `terminate()` is no loss. */
  readonly lost: (error: BridgeLostError) => void;
  /** The bridge is ready and this Player holds it: what waited for it is sent now. */
  readonly ready: (bridge: PlayerBridge) => void;
  /** The host never became reachable, or another Player holds it. */
  readonly unreachable: () => void;
}

/** The script source this Player prepared, which a replacement prepares again, and the plan token the host gave it. */
interface PreparedSource {
  readonly script: string | PlayerProject;
  readonly plan: string | null;
}

/** A replacement that cannot go on: the Player was unmounted, or it offers no fresh connection. */
class NoReplacement extends Error {
  override readonly name = "NoReplacement";
}

export function useEngineConnection({
  options,
  isDisposed,
  replaced,
  claimed,
  lost,
  ready,
  unreachable,
}: EngineConnectionHost) {
  // The default in-process backend, made at once and again for each replacement.
  const inProcess = () =>
    createInProcessBackend(playerBuildIdentity, {
      ...(options.debugHistorySpill && { historySpill: options.debugHistorySpill }),
      ...(options.debugHistoryMemoryBudget !== undefined && {
        historyBudget: options.debugHistoryMemoryBudget,
      }),
    });
  // The engine's host, which owns the plans, the sessions and the recorder of every session's engine calls from Start,
  // in every build, for a debug export (DEBUGGER.md "Debug export"); in-process by default.
  // The in-process backend is ready at once, so a Start within the first click needs no wait.
  let bridge: PlayerBridge | null = options.bridge === undefined ? inProcess() : null;
  // How a lost connection is replaced: the host's factory, or a new in-process backend; none for an injected bridge
  // without one, whose loss stays the Player's error stop.
  const nextConnection: (() => Promise<PlayerBridge>) | null =
    options.nextConnection ??
    (options.bridge === undefined ? () => Promise.resolve(inProcess()) : null);
  // This Player's hold on its bridge (`PlayerBridge.claim`): one live Player per bridge.
  const claim = Symbol("Player");
  // The current connection's bridge once its source promise yields it, before the claim and the readiness hook, either
  // of which can still reject `connected`; kept also for a Player disposed meanwhile, which does not take it. `null`
  // before, and while a replacement opens.
  let settled: PlayerBridge | null = null;
  // The source the pages prepared last, with its plan token in the current host.
  let source: PreparedSource | null = null;
  /** Takes `reached`, now ready, as this Player's connection; its loss counts only while it is the current one. */
  function take(reached: PlayerBridge) {
    claimed(reached.claim(claim));
    bridge = reached;
    reached.client.onLoss((error) => {
      if (bridge === reached) lost(error);
    });
    ready(reached);
  }
  // Once the host is reachable, and only while this Player lives: it takes the bridge, observes its loss, and sends what
  // waited for it before any Start that waits for it. A host that never became reachable, or one another Player holds,
  // is the `bridge` promise's failure, which its own callers handle.
  let connected = (options.bridge ?? Promise.resolve(bridge!)).then((reached) => {
    settled = reached;
    if (isDisposed()) return reached;
    take(reached);
    return reached;
  });
  connected.catch(() => unreachable());

  /**
   * Sends `script`'s `prepare` to `host`, and remembers it with the plan the reply names. Until the reply, the same
   * script keeps the plan it had, so a connection lost while a replacement prepares it can still be replaced.
   */
  function prepareIn(
    host: PlayerBridge,
    script: string | PlayerProject,
  ): Promise<BridgeResult<OpResult<"prepare">>> {
    const asked: PreparedSource = { script, plan: source?.script === script ? source.plan : null };
    source = asked;
    const reply = host.client.request("prepare", { source: { kind: "source", script } });
    void reply.then(
      (prepared) => {
        if (source === asked && prepared.result.kind === "prepared")
          source = { script, plan: prepared.result.plan };
      },
      () => {},
    );
    return reply;
  }

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
    /** The current connection once it is ready: the one this Player was given, or the one that last replaced it. */
    currentConnection: (): Promise<PlayerBridge> => connected,
    /**
     * Compiles `script` in the engine's host without running it (`prepare`): the one place the Player's pages send it.
     * It is sent at once when the connection is ready, else as soon as it is. The source is remembered, so that a
     * replacement prepares it again.
     */
    prepareScriptSource(
      script: string | PlayerProject,
    ): Promise<BridgeResult<OpResult<"prepare">>> {
      return settled !== null
        ? prepareIn(settled, script)
        : connected.then((host) => prepareIn(host, script));
    },
    /**
     * The plan token the host gave the pages' last prepared source, when a lost connection can be replaced and that
     * source prepared again; else `null`.
     */
    replaceablePlan: (): string | null => (nextConnection === null ? null : (source?.plan ?? null)),
    /**
     * Replaces the lost connection with a fresh one, from the player's click only: the lost one is given up, the fresh
     * one is taken once ready, and the remembered source is prepared in it. Resolves with that preparation's reply;
     * rejects when the fresh connection cannot be opened or the Player was unmounted meanwhile (`NoReplacement`).
     */
    async replace(): Promise<BridgeResult<OpResult<"prepare">>> {
      const script = source?.script;
      if (nextConnection === null || script === undefined) throw new NoReplacement();
      bridge?.unclaim(claim);
      bridge?.client.terminate();
      bridge = null;
      settled = null;
      const opening = nextConnection();
      connected = opening;
      const fresh = await opening;
      // Only the candidate still current is taken: not one a later replacement superseded, nor one an unmounted Player
      // opened.
      if (isDisposed() || connected !== opening) {
        fresh.client.terminate();
        throw new NoReplacement();
      }
      settled = fresh;
      replaced();
      take(fresh);
      return prepareIn(fresh, script);
    },
    /** Gives the bridge up at the Player's disposal, for a later Player to claim. */
    release(): void {
      bridge?.unclaim(claim);
    },
  };
}
