import type { InstructionPlan } from "../../src/playback.js";
import type { DebugRecording } from "../debug-recorder.js";
import {
  createPlayerRuntimeSession,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../runtime-adapter.js";
import type { PlayerSession } from "../runtime-view.js";
import { PlayerBridge } from "../player-bridge.js";
import { openBridge, type ClientPort } from "./client.js";
import {
  alignTrace,
  closeConnection,
  playerBridgeOps,
  playerOpsContext,
  type PlayerOpsContext,
  type TracingIntent,
} from "./player-ops.js";
import type { BuildIdentity } from "./protocol.js";
import {
  beginRecordingAt,
  HeldSession,
  introduction,
  startRandom,
  type StartOptions,
  type StartRandom,
} from "./ops/session.js";
import type { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import type { RandomControlOptions } from "../../src/runtime/random/random-control.js";
import type { Delivery } from "./delivery.js";
import { decodeMessage } from "./transport.js";
import { parseHistoryMarks, type HistoryMarks } from "../debug-history-marks.js";
import { startBridgeHost, type HostPort, type HostSessions } from "./worker-host.js";

/*
 * The Player's production backend: the same host and ops as a Worker's, in the page's realm, over a port pair that
 * passes every message through `structuredClone`. A request a session op handles runs when it is posted; replies arrive
 * later, on a microtask or after `delayMs`, as from a Worker.
 *
 * The **transition facade** below lets code that has not moved to the bridge reach the host's session synchronously.
 * Every main-realm import of one of its names is a RATCHET entry (`inventory.ts`); the L5 gate requires this module
 * gone, not only RATCHET empty.
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
 * Starts the in-process backend, ready at once: the Player's ops served on a port pair in this realm. With `delayMs`,
 * replies arrive after that delay instead of on a microtask (the delayed smoke). `historySpill` and `historyBudget` set
 * Debug's rewind histories' spill store and admission bound (`playerOpsContext`).
 */
export function createInProcessBackend(
  build: BuildIdentity,
  options: { readonly delayMs?: number } & NonNullable<Parameters<typeof playerOpsContext>[0]> = {},
): PlayerBridge {
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
      // Decoded on receipt, so `flush` reads the session of a reply that crossed as a flat form.
      const data = decodeMessage(structuredClone(message));
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
    // The client ends, by a loss or `terminate()`, and terminates its port first (`client.ts`), so the host here, which
    // outlives it, closes the connection directly: nothing goes through the ended client.
    terminate: () => {
      toHost = null;
      toClient = null;
      transit.length = 0;
      closeConnection(context, sessions);
    },
  };
  const { client } = openBridge(clientPort, build);
  const context = playerOpsContext(options);
  const sessions = startBridgeHost(hostPort, playerBridgeOps(context), build, context.delivery);
  const bridge = new PlayerBridge(client);
  const flush = (session: string) => {
    for (let index = 0; index < transit.length;) {
      if (transit[index]!.session !== session) index += 1;
      else toClient?.(transit.splice(index, 1)[0]!.data);
    }
  };
  // A stop's acknowledgement and the replies before it arrive at once, so the stop is synchronous here.
  bridge.deliverInTransit = flush;
  backends.set(bridge, { bridge, context, sessions, flush });
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
    if (next === held.sessionForOperation()) return store.session;
    // A session that only attached a trace or recorder keeps its revision: nothing is published.
    if (next.revision === held.revision) held.keep(next);
    else {
      held.endCatchUp();
      store.apply(held.publish(next));
    }
    return store.session;
  };
  const result = op(held.sessionForOperation());
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

/** What a transitional session factory receives from the host. */
export interface HostFactoryInput {
  /** The connection's debug recorder. */
  readonly recorder: PlayerRuntimeSessionOptions["recorder"] & object;
  /** Debug's value trace on the connection, which the session runs with, or `null` while Debug does not run. */
  readonly debugTrace: RuntimeDebugContext | null;
  /** The random control a Start's session runs with from its first statement (`StartRandom`), or `null`. */
  readonly randomControl: RandomControlOptions | null;
  /** The plan the host holds under `token`. */
  plan(token: string): InstructionPlan;
}

/**
 * **Facade.** Registers the session `make` creates in the host, under a new bridge session, and returns its first
 * publication. `make` is a transitional factory: a Start with Debug's trace or random control, a restore, a transfer,
 * DevelopmentPreview's Start. A session that brought a plan of its own gets a new plan token. `{ plan, options }`
 * starts a held plan instead. Either runs with the connection's value trace; a Start (`random`) also with its Player's
 * random control. A restore begins without ownership, until an explicit adoption (`adoptRandom`).
 *
 * Its plan and session are owned by a delivery of the facade's own (`delivery.ts`) until the bridge took the session: a
 * fault before that undoes them, and a closed connection admits neither. They are bound to that delivery by name, so an
 * op's delivery that is open meanwhile (one still running, or one a request the factory began opened) never owns them.
 */
export function introduceNow(
  bridge: PlayerBridge,
  make:
    | ((host: HostFactoryInput) => PlayerRuntimeSession)
    | { readonly plan: string; readonly options: StartOptions; readonly recording: boolean },
  /** The session's marks: a restore's, as it was kept or exported; `NO_MARKS` for a Start. */
  marks: HistoryMarks,
  tracing?: TracingIntent,
  random?: StartRandom,
): PlayerSession {
  const backend = backendOf(bridge);
  const { context } = backend;
  const delivery = context.delivery.begin();
  try {
    const opened = introduceIn(backend, delivery, make, marks, tracing, random);
    context.delivery.commit(delivery);
    return opened;
  } catch (error) {
    context.delivery.rollback(delivery);
    throw error;
  }
}

/** `introduceNow`'s body, inside its delivery. */
function introduceIn(
  backend: Backend,
  delivery: Delivery,
  make: Parameters<typeof introduceNow>[1],
  marks: HistoryMarks,
  tracing: TracingIntent | undefined,
  random: StartRandom | undefined,
): PlayerSession {
  const { bridge, context } = backend;
  // The Player's newest tracing and random intents hold before the session begins, also while their requests wait.
  if (tracing !== undefined) alignTrace(context, tracing);
  const control = startRandom(context, random);
  const plan = (token: string): InstructionPlan => {
    const held = context.plans.get(token);
    if (held === undefined) throw new Error(`No plan '${token}' is held.`);
    return held;
  };
  const created =
    typeof make === "function"
      ? make({
          recorder: context.recorder,
          debugTrace: context.trace,
          randomControl: control,
          plan,
        })
      : createPlayerRuntimeSession(plan(make.plan), {
          ...make.options,
          ...(make.recording ? { recorder: context.recorder } : {}),
          ...(context.trace === null ? {} : { debugTrace: context.trace }),
          ...(control === null ? {} : { randomControl: control }),
        });
  const known = [...context.plans].find(([, held]) => held === created.plan)?.[0];
  // Bound to the facade's delivery: a request the factory began may have opened one inside it, still running.
  const token = known ?? context.hold(created.plan, delivery);
  // A factory may not have installed the control it was given; its first read attaches it in any case.
  const held = new HeldSession(
    created,
    token,
    context,
    parseHistoryMarks(marks),
    random?.owner ?? null,
    typeof make === "function" ? null : control,
  );
  const id = backend.sessions.add(held, delivery);
  return bridge.open(id, introduction(held, context, known === undefined));
}

/**
 * **Facade.** Begins the connection's recording at `session` synchronously, with a new epoch of its value trace, as a
 * parked rewind session does inside its guard; the `beginRecording` op does the same over the bridge.
 */
export function beginRecordingNow(session: PlayerSession): void {
  const backend = backendOf(session.connection);
  beginRecordingAt(heldOf(backend, session), backend.context);
  backend.context.trace?.reset("restore");
}

/** **Facade, for tests.** The connection's random state, as its host holds it. */
export function heldRandom(bridge: PlayerBridge): PlayerOpsContext["random"] {
  return backendOf(bridge).context.random;
}

/** **Facade, for tests.** The connection's value trace, as its host holds it, or `null` while Debug does not run. */
export function heldTrace(bridge: PlayerBridge): RuntimeDebugContext | null {
  return backendOf(bridge).context.trace;
}

/** **Facade.** The plan the host holds under `token`, for code that still needs the graph. */
export function heldPlan(bridge: PlayerBridge, token: string): InstructionPlan {
  const plan = backendOf(bridge).context.plans.get(token);
  if (plan === undefined) throw new Error(`No plan '${token}' is held.`);
  return plan;
}

/**
 * **Facade.** The recording captured under `ticket` (`captureRecording`), or `null` when no recording is held under it;
 * without a ticket, what the connection's recorder holds now (`DebugRecorder.recording`).
 */
export function heldRecording(bridge: PlayerBridge, ticket?: string): DebugRecording | null {
  const { context } = backendOf(bridge);
  if (ticket === undefined) return context.recorder.recording();
  const held = context.recordings.get(ticket);
  return held?.kind === "recording" ? held.recording : null;
}
