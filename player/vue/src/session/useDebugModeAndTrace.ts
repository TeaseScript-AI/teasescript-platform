import { ref, shallowRef, type Ref } from "vue";
import { BridgeRequestError } from "../../../engine-bridge/client.js";
import type { TracingIntent } from "../../../engine-bridge/player-ops.js";
import type { DebugView, DebugViewRequest } from "../../../debug/debug-view.js";
import { bridgeOf, endsQuietly, type PlayerBridge } from "../../../runtime/player-bridge.js";
import type { PlayerSession } from "../../../runtime/runtime-view.js";
import type { useRuntimeSceneClock } from "./useRuntimeSceneClock";
import type { ActivationRun, useActivationRun } from "./activation/useActivationRun.js";

/*
 * Debug's two switches as the host holds them, moved from `usePlayerSession` unchanged: the value trace, with its
 * views, and Debug mode, which the script reads.
 */

/** What Debug mode and the value trace need from the Player's session composable. */
interface DebugModeAndTraceHost {
  /** The engine's host now, or `null` before it is ready. */
  readonly bridgeNow: () => PlayerBridge | null;
  readonly isDisposed: () => boolean;
  readonly reportHostError: (error: unknown, origin?: ActivationRun | null) => void;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly activationRun: ReturnType<typeof useActivationRun>;
  readonly publishOwned: (next: PlayerSession) => PlayerSession | null;
  readonly keepSessionLater: () => void;
  readonly copyToDebugRoom: () => Promise<void>;
  /** The scene clock, read when used. */
  readonly clock: () => ReturnType<typeof useRuntimeSceneClock>;
  /** The room shown, read when used. */
  readonly room: () => Readonly<Ref<"normal" | "debug">>;
  /** Whether the script has its own saved data, read when used. */
  readonly hasNormalStorage: () => boolean;
  /** Whether a restored state is inspected, read when used. */
  readonly inspecting: () => Readonly<Ref<boolean>>;
  /** The prepared Start or Continue, read when used. */
  readonly activation: () => Readonly<Ref<unknown>>;
}

export function useDebugModeAndTrace({
  bridgeNow,
  isDisposed,
  reportHostError,
  session,
  stopped,
  activationRun,
  publishOwned,
  keepSessionLater,
  copyToDebugRoom,
  clock,
  room,
  hasNormalStorage,
  inspecting,
  activation,
}: DebugModeAndTraceHost) {
  // Debug's value trace (DEBUGGER.md "Player Debug"), while Debug runs: the host holds it, as the connection's state
  // (`debugTracing`), and every session operation there records into it. `traceId` names the host's trace now, once
  // the host answered.
  const debugTracing = ref(false);
  const traceId = shallowRef<number | null>(null);
  // Counts this Player's tracing changes, so a reply of an older one sets no `traceId`.
  let tracingToggles = 0;
  // Whether `debugTracing` waits to be sent, until the host is reachable. Only the latest setting goes, and only while
  // this Player lives. A bridge a Player traced on before may still hold that Player's work in its queue: the setting
  // then goes in any case, so that this Player's Starts carry it ahead of that work.
  let pendingTracing = false;
  // This Player's newest tracing intent sent, with its serial from the connection (`nextTracingIntent`), which every op
  // that sets the host's trace carries (`TracingIntent`): the host applies only the newest, whichever channel brings it.
  let lastIssued: TracingIntent | undefined;
  /** This Player's newest tracing intent sent, or `undefined` before any: the host's trace is then off. */
  const tracingIntent = () => lastIssued;
  /** Sends tracing `on`, with the connection's next serial. */
  function issueTracing(host: PlayerBridge, on: boolean) {
    const intent = { on, intent: host.nextTracingIntent() };
    lastIssued = intent;
    return host.client.request("debugTracing", intent);
  }
  /** Sends the pending tracing setting, while this Player lives; its reply names the host's trace. */
  function flushTracing(host: PlayerBridge) {
    if (!pendingTracing || isDisposed()) return;
    pendingTracing = false;
    const toggle = tracingToggles;
    issueTracing(host, debugTracing.value).then(
      (reply) => {
        // EVIDENCE: validation: `debugTracing` replies from the same build with the trace it holds now.
        const now = (reply.result as { readonly traceId: number | null }).traceId;
        if (toggle === tracingToggles && !isDisposed()) traceId.value = now;
      },
      (error: unknown) => {
        if (!endsQuietly(error) && !isDisposed()) reportHostError(error);
      },
    );
  }
  /**
   * A view of Debug's value trace for the shown session, made in the host (`debugView`, `debug-view.ts`): the reply
   * names the revision and trace it shows, which its caller compares with what shows when it arrives. `null` without a
   * shown session or a trace, and for a session that no longer shows or that the host no longer holds; it never
   * rejects.
   */
  function debugView(request: DebugViewRequest): Promise<DebugView | null> {
    const current = session.value;
    if (current === null || !debugTracing.value) return Promise.resolve(null);
    return bridgeOf(current)
      .read(current, "debugView", { request })
      .then(
        (view) => (session.value?.lineage === current.lineage ? view : null),
        (error: unknown) => {
          // A session the host released meanwhile has nothing to read; any other failure is the Player's error stop,
          // as an op's failure is.
          const gone = error instanceof BridgeRequestError && error.name === "SessionGoneError";
          if (
            !endsQuietly(error) &&
            !gone &&
            !isDisposed() &&
            !stopped.value &&
            session.value?.lineage === current.lineage
          )
            reportHostError(error);
          return null;
        },
      );
  }
  // Whether Debug is on, which the script reads as `debugMode`.
  let debugMode = false;
  /** The Debug mode last asked of a session's host while its request is under way (`applyDebugMode`), or `null`. */
  let debugModeAsked: { readonly lineage: object; readonly on: boolean } | null = null;
  /**
   * Turns Debug on or off for the script. On in the normal room, play goes on in the debug room (`copyToDebugRoom`). Off,
   * play goes on where it is. A running session reads the change from its next statement on.
   */
  function setDebugMode(enabled: boolean) {
    if (enabled === debugMode) return;
    // A catch-up under way finishes first, as one observation, so the change comes no earlier than without it.
    clock().before("debugMode");
    debugMode = enabled;
    if (enabled && room().value === "normal" && hasNormalStorage()) void copyToDebugRoom();
    else applyDebugMode();
  }
  /**
   * Gives the running session the current Debug state. One that waits for Continue takes it at Continue, and a state
   * Debug's rewind shows for inspection once it is adopted or the session it left is back.
   */
  function applyDebugMode() {
    const current = session.value;
    if (
      current === null ||
      inspecting().value ||
      stopped.value ||
      activation().value !== null ||
      (current.state.status !== "running" && current.state.status !== "waiting")
    )
      return;
    // What the host will hold once the requests sent settle: the last one asked of this session, else what shows.
    const held =
      debugModeAsked?.lineage === current.lineage ? debugModeAsked.on : current.state.debugMode;
    if (held === debugMode) return;
    const on = debugMode;
    const asked = { lineage: current.lineage, on };
    debugModeAsked = asked;
    // It acts for the activation that shows the session: a Continue keeps the lineage, so the lineage alone does not
    // say that its activation still lives.
    const origin = activationRun.current();
    // In the host (`setDebugMode`); the session shows the change while it still owns the UI.
    void bridgeOf(current)
      .request<{ readonly kind: string }>(
        current,
        "setDebugMode",
        { on },
        { publish: (next) => void publishOwned(next) },
      )
      .finally(() => {
        if (debugModeAsked === asked) debugModeAsked = null;
      })
      .then(
        (outcome) => {
          if (origin !== null && !activationRun.admits(origin)) return;
          if (outcome.kind === "set" && session.value?.lineage === current.lineage)
            keepSessionLater();
        },
        (error: unknown) => {
          if (endsQuietly(error)) return;
          if (origin !== null && !activationRun.admits(origin)) return;
          if (!isDisposed() && !stopped.value && session.value?.lineage === current.lineage)
            reportHostError(error, origin ?? activationRun.current());
        },
      );
  }

  /**
   * Turns Debug's value trace on or off, in the host (the return surface's `setDebugTracing`); an unmounted Player
   * changes nothing.
   */
  function setDebugTracing(on: boolean) {
    if (isDisposed() || on === debugTracing.value) return;
    debugTracing.value = on;
    traceId.value = null;
    tracingToggles += 1;
    pendingTracing = true;
    if (bridgeNow() !== null) flushTracing(bridgeNow()!);
  }

  return {
    debugTracing,
    traceId,
    tracingIntent,
    flushTracing,
    debugView,
    setDebugTracing,
    setDebugMode,
    applyDebugMode,
    /** Whether Debug is on, which the script reads as `debugMode`. */
    debugModeOn: () => debugMode,
    /** Marks the tracing setting as waiting to be sent, as an earlier Player's work may hold the bridge's trace. */
    pendTracing() {
      pendingTracing = true;
    },
    /** Drops the tracing setting waiting to be sent: the host is unreachable or lost. */
    dropPending() {
      pendingTracing = false;
    },
    /** Ends this Player's trace at its disposal, on `bridge`. */
    dispose(bridge: PlayerBridge | null) {
      // The trace was this Player's: it ends with it, as when the trace lived in the page, and a Player that uses the
      // connection next begins with it off. A setting not yet sent goes nowhere; a connection already lost takes nothing.
      pendingTracing = false;
      if (lastIssued?.on && bridge !== null) issueTracing(bridge, false).catch(() => {});
      lastIssued = undefined;
    },
  };
}
