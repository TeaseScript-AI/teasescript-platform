import type { InstructionPlan, MediaProgressReport } from "../../src/playback.js";
import type { DebugRecording } from "../debug-recorder.js";
import {
  beginPlayerRuntimeRecording,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../runtime-adapter.js";
import type { PlayerSession } from "../runtime-view.js";
import { PlayerBridge } from "../player-bridge.js";
import { connectBridge, type ClientPort } from "./client.js";
import { playerBridgeOps, playerOpsContext, type PlayerOpsContext } from "./player-ops.js";
import type { BuildIdentity } from "./protocol.js";
import { HeldSession, introduction, type StartOptions } from "./ops/session.js";
import { startBridgeHost, type HostPort, type HostSessions } from "./worker-host.js";

/*
 * The production backend until the L5 series activates the Worker: the same host and ops, in the page's realm, over a
 * port pair that passes every message through `structuredClone`. A request a session op handles runs when it is posted;
 * replies arrive later, on a microtask or after `delayMs`, so the UI meets replies that come later, as from a Worker.
 *
 * Until each family converts its UI, the **transition facade** below lets that family's code reach the host's session
 * synchronously, as before. Every main-realm import of one of its names is a RATCHET entry (`inventory.ts`), and the L5
 * gate requires this module gone, not only RATCHET empty.
 */

interface Backend {
  readonly bridge: PlayerBridge;
  readonly context: PlayerOpsContext;
  readonly sessions: HostSessions;
  /** Delivers the replies of `session` still in transit, in order, before anything else of it happens. */
  flush(session: string): void;
}

const backends = new WeakMap<PlayerBridge, Backend>();

/** The in-process backend of a connection, or a programming error for any other connection. */
function backendOf(connection: PlayerBridge): Backend {
  const backend = backends.get(connection);
  if (backend === undefined)
    throw new Error("This Player session belongs to no in-process backend.");
  return backend;
}

function heldOf(backend: Backend, session: PlayerSession): HeldSession {
  backend.flush(session.id);
  const held = backend.sessions.get(session.id);
  if (held === undefined) throw new Error("The host holds no such session.");
  // EVIDENCE: validation: every session the Player's ops and this facade add is a HeldSession.
  return held as HeldSession;
}

/**
 * Starts the in-process backend: the Player's ops served on a port pair in this realm. With `delayMs`, replies arrive
 * after that delay instead of on a microtask (the delayed smoke).
 */
export async function createInProcessBackend(
  build: BuildIdentity,
  options: { readonly delayMs?: number } = {},
): Promise<PlayerBridge> {
  let toHost: ((data: unknown) => void) | null = null;
  let toClient: ((data: unknown) => void) | null = null;
  const transit: { readonly session: string | null; readonly data: unknown }[] = [];
  const deliverOne = () => {
    const next = transit.shift();
    if (next !== undefined) toClient?.(next.data);
  };
  const schedule = () =>
    options.delayMs === undefined
      ? queueMicrotask(deliverOne)
      : setTimeout(deliverOne, options.delayMs);
  const hostPort: HostPort = {
    post: (message) => {
      const data = structuredClone(message);
      const session =
        typeof data === "object" &&
        data !== null &&
        "session" in data &&
        typeof data.session === "string"
          ? data.session
          : null;
      transit.push({ session, data });
      schedule();
    },
    listen: (listener) => void (toHost = listener),
  };
  const clientPort: ClientPort = {
    post: (message) => toHost?.(structuredClone(message)),
    listen: (listener) => void (toClient = listener),
    onFailure: () => {},
    terminate: () => {
      toHost = null;
      toClient = null;
      transit.length = 0;
    },
  };
  const connecting = connectBridge(clientPort, build);
  const context = playerOpsContext();
  const sessions = startBridgeHost(hostPort, playerBridgeOps(context), build);
  const bridge = new PlayerBridge(await connecting);
  backends.set(bridge, {
    bridge,
    context,
    sessions,
    flush: (session) => {
      for (let index = 0; index < transit.length;) {
        if (transit[index]!.session !== session) index += 1;
        else toClient?.(transit.splice(index, 1)[0]!.data);
      }
    },
  });
  return bridge;
}

/** A result of an adapter function with each of its sessions replaced by the main side's. */
export type Hatched<R> = R extends PlayerRuntimeSession
  ? PlayerSession
  : R extends { readonly session: PlayerRuntimeSession }
    ? Omit<R, "session"> & { readonly session: PlayerSession }
    : R;

const isAdapterSession = (value: unknown): value is PlayerRuntimeSession =>
  typeof value === "object" && value !== null && "engine" in value && "plan" in value;

/**
 * **Facade.** Runs `op`, an adapter function, on the host's latest publication of `session`, synchronously. The
 * session's replies still in transit reach its store first; `op`'s new publication, if any, is applied after them.
 * Returns `op`'s result with each adapter session replaced by the store's session; other values pass through.
 */
export function hatch<R>(
  session: PlayerSession,
  op: (session: PlayerRuntimeSession) => R,
): Hatched<R> {
  const backend = backendOf(session.connection);
  const held = heldOf(backend, session);
  const store = backend.bridge.store(session)!;
  const adopt = (next: PlayerRuntimeSession): PlayerSession => {
    if (next === held.current) return store.session;
    // A session that only attached a trace or recorder keeps its revision: nothing is published.
    if (next.revision === held.revision) held.keep(next);
    else {
      held.catchUp = null;
      store.apply(held.publish(next));
    }
    return store.session;
  };
  const result = op(held.current);
  if (isAdapterSession(result)) {
    // EVIDENCE: validation: `isAdapterSession` checked the result, which `Hatched` maps to the store's session.
    return adopt(result) as Hatched<R>;
  }
  if (
    typeof result === "object" &&
    result !== null &&
    "session" in result &&
    isAdapterSession(result.session)
  )
    // EVIDENCE: validation: the result's `session` was checked to be an adapter session, which `Hatched` maps.
    return { ...result, session: adopt(result.session) } as Hatched<R>;
  // EVIDENCE: validation: a result with no adapter session is what `Hatched` leaves as it is.
  return result as Hatched<R>;
}

/** **Facade.** An ordinary observation of scene time, synchronously, for an observing chain not yet converted. */
export function observeNow(
  session: PlayerSession,
  atMs: number,
  media: readonly MediaProgressReport[],
): Hatched<ReturnType<typeof observePlayerRuntimeTime>> {
  return hatch(session, (current) => observePlayerRuntimeTime(current, atMs, media));
}

/** What a transitional session factory receives from the host. */
export interface HostFactoryInput {
  /** The connection's debug recorder. */
  readonly recorder: PlayerRuntimeSessionOptions["recorder"] & object;
  /** The plan the host holds under `token`. */
  plan(token: string): InstructionPlan;
}

/**
 * **Facade.** Registers the session `make` creates in the host, under a new bridge session, and returns its first
 * publication. `make` is a transitional factory: a Start with Debug's trace or random control, a restore, a transfer,
 * DevelopmentPreview's Start. A session that brought a plan of its own gets a new plan token. `{ plan, options }`
 * starts a held plan instead, with `extras` (trace, random control) attached before its first run.
 */
export function introduceNow(
  bridge: PlayerBridge,
  make:
    | ((host: HostFactoryInput) => PlayerRuntimeSession)
    | {
        readonly plan: string;
        readonly options: StartOptions;
        readonly extras?: Pick<PlayerRuntimeSessionOptions, "debugTrace" | "randomControl">;
        readonly recording: boolean;
      },
): PlayerSession {
  const backend = backendOf(bridge);
  const { context } = backend;
  const plan = (token: string): InstructionPlan => {
    const held = context.plans.get(token);
    if (held === undefined) throw new Error(`No plan '${token}' is held.`);
    return held;
  };
  const created =
    typeof make === "function"
      ? make({ recorder: context.recorder, plan })
      : createPlayerRuntimeSession(plan(make.plan), {
          ...make.options,
          ...make.extras,
          ...(make.recording ? { recorder: context.recorder } : {}),
        });
  const known = [...context.plans].find(([, held]) => held === created.plan)?.[0];
  const token = known ?? context.hold(created.plan);
  const held = new HeldSession(created, token);
  const id = backend.sessions.add(held);
  return bridge.open(id, introduction(held, context, known === undefined));
}

/**
 * **Facade.** Begins the connection's recording at `session` synchronously, as a parked rewind session does inside its
 * guard; the `beginRecording` op does the same over the bridge.
 */
export function beginRecordingNow(session: PlayerSession): void {
  const backend = backendOf(session.connection);
  const held = heldOf(backend, session);
  const attached = Object.freeze({ ...held.current, recorder: backend.context.recorder });
  beginPlayerRuntimeRecording(attached, backend.context.recorder);
  held.keep(attached);
}

/** **Facade.** Holds `plan`, which the main realm compiled, in the host; returns its token, the one it has if held. */
export function holdPlan(bridge: PlayerBridge, plan: InstructionPlan): string {
  const { context } = backendOf(bridge);
  return [...context.plans].find(([, held]) => held === plan)?.[0] ?? context.hold(plan);
}

/** **Facade.** The plan the host holds under `token`, for code that still needs the graph. */
export function heldPlan(bridge: PlayerBridge, token: string): InstructionPlan {
  const plan = backendOf(bridge).context.plans.get(token);
  if (plan === undefined) throw new Error(`No plan '${token}' is held.`);
  return plan;
}

/** **Facade.** What the connection's recorder holds for a debug export (`DebugRecorder.recording`). */
export function heldRecording(bridge: PlayerBridge): DebugRecording | null {
  return backendOf(bridge).context.recorder.recording();
}
