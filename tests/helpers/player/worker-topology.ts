import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import type * as Client from "../../../player/engine-bridge/client.js";
import type * as InProcess from "../../../player/engine-bridge/in-process.js";
import type { BuildIdentity } from "../../../player/engine-bridge/protocol.js";
import { decodeMessage } from "../../../player/engine-bridge/transport.js";
import type * as Bridge from "../../../player/runtime/player-bridge.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import { coverageGaps, type Coordinates } from "../family-coverage.js";
import { loadPlayerModule } from "../player-modules.js";
import { untypedClient } from "../bridge/untyped.js";
import { restorePlayerRuntimeSessionAt } from "../../../player/runtime/runtime-adapter.js";
import { NO_MARKS } from "../../../player/debug/debug-history-marks.js";
import type { Introduction } from "../../../player/engine-bridge/session-protocol.js";
import { deserializeCheckpoint } from "../../../src/runtime/snapshot/checkpoint.js";
import type { RuntimeSnapshot } from "../../../src/index.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";

/*
 * The composable's engine bridge on either topology (L5i.7): the in-process host, or a Node Worker thread running the
 * engine's Worker entry. Both are built from the test-modules bundle's own client and bridge, the composable's module
 * instances. Each gives the same controls, so one row runs on both:
 * - `lose()`: the Worker lost, resolving once the client's loss listeners ran (the composable's first, as it registered
 *   at ready). In-process, the client is terminated and its listeners get a `BridgeLostError`, as a real loss; on the
 *   Worker, the thread is terminated, and its `exit` reaches the client as a real loss.
 * - `hold(op)`, `held()`, `release()`: from the post of the first request of `op` after `hold`, its reply and every
 *   later one are held until `release`; `held()` resolves once that reply is among them. Both topologies hold the
 *   incoming messages at the client's port, this connection's alone.
 * - `posts`: every request the client posted, in order, as it reached the port.
 * - `topology`, checked by `assertTopology()`: `deliverInTransit` is `null` exactly on the Worker.
 * `tests/helpers/bridge/sends.ts` decides sends above the client instead; this helper works below it, so the client's
 * own disposition of a post stands, and the log holds only what reached the port.
 */

export type Topology = "in-process" | "worker";
export const TOPOLOGIES: readonly Topology[] = ["in-process", "worker"];

/** A request the client posted, as it reached the port, with the page's clock then (`performance.now()`). */
export interface Posted {
  readonly id: number;
  readonly op: string;
  readonly session: string | null;
  readonly args: unknown;
  readonly at: number;
}

export interface TopologyBridge {
  readonly topology: Topology;
  readonly bridge: PlayerBridge;
  readonly posts: readonly Posted[];
  lose(): Promise<void>;
  hold(op: string): void;
  held(): Promise<void>;
  release(): void;
  assertTopology(): void;
  /** On the Worker, resolves with the thread's exit code once it exited; `null` in-process. */
  readonly exited: Promise<number> | null;
}

const BUILD: BuildIdentity = { commit: null, dirty: null, mode: null, appVersion: null };
const WORKERS = {
  // The engine's Worker entry, as the Player runs it.
  engine: new URL("../../../player/engine-bridge/node-worker.js", import.meta.url),
  // The same, with the maintained test ops (`restoreForTest`), for rows that restore a state on the Worker.
  restore: new URL("../bridge-restore-worker.js", import.meta.url),
};

let client: typeof Client | null = null;
let bridgeModule: typeof Bridge | null = null;
let facade: typeof InProcess | null = null;

/** Loads the bundle's client, bridge and backend: call it in a `before` hook of a file that uses the helper. */
export async function loadTopology(): Promise<void> {
  // EVIDENCE: validation: the bundle's own modules, whose instances the composable runs with.
  client = (await loadPlayerModule("player/engine-bridge/client.ts")) as typeof Client;
  // EVIDENCE: validation: as above.
  bridgeModule = (await loadPlayerModule("player/runtime/player-bridge.ts")) as typeof Bridge;
  // EVIDENCE: validation: as above.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof InProcess;
}

/** Waits, in short real-time turns, until `check` holds. */
export async function until(check: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`never: ${label}`);
}

/**
 * Makes an in-process `bridge`'s client lose its Worker on the returned call, as a real loss: the client ends, and its
 * loss listeners get a `Lost` (the error class of the client module the bridge was built with). Call it before anything
 * registers a loss listener.
 */
export function inProcessLoss(
  bridge: PlayerBridge,
  Lost: new (message: string) => Client.BridgeLostError,
): () => void {
  const listeners: ((error: Client.BridgeLostError) => void)[] = [];
  bridge.client.onLoss = (listener) => void listeners.push(listener);
  return () => {
    bridge.client.terminate();
    const lost = new Lost("The engine Worker failed: injected.");
    for (const listener of listeners) listener(lost);
  };
}

/** A message as it crosses: the request or reply it decodes to, or `null` for another kind. */
function decoded(
  message: unknown,
): {
  readonly kind: string;
  readonly id: number;
  readonly op?: string;
  readonly session?: string | null;
  readonly args?: unknown;
} | null {
  const value: unknown = decodeMessage(message);
  if (typeof value !== "object" || value === null || !("kind" in value) || !("id" in value))
    return null;
  // EVIDENCE: fixture: the bridge's requests and replies carry `kind` and a numeric `id`; a request, `op`, `session` and `args`.
  return value as {
    kind: string;
    id: number;
    op?: string;
    session?: string | null;
    args?: unknown;
  };
}

/** The log's entry for a request as it reaches the port. */
const postOf = (request: {
  readonly id: number;
  readonly op?: string;
  readonly session?: string | null;
  readonly args?: unknown;
}): Posted => ({
  id: request.id,
  op: request.op!,
  session: request.session ?? null,
  args: request.args ?? null,
  at: performance.now(),
});

/**
 * A bridge of `topology`, ended after the test. In-process, its replies arrive after `delayMs`, or on a microtask. Its
 * post log and reply gate are this connection's alone, on either topology.
 */
export async function topologyBridge(
  context: TestContext,
  topology: Topology,
  {
    delayMs,
    entry = "engine",
  }: { readonly delayMs?: number; readonly entry?: keyof typeof WORKERS } = {},
): Promise<TopologyBridge> {
  assert.ok(client && bridgeModule && facade, "call loadTopology first");
  const made = topology === "worker" ? await onWorker(WORKERS[entry]) : inProcess(delayMs);
  context.after(() => made.bridge.client.terminate());
  return {
    ...made,
    topology,
    assertTopology: () =>
      assert.equal(made.bridge.deliverInTransit === null, topology === "worker", "the topology"),
  };
}

/**
 * The connections of one Player on `topology`: the first, and each fresh one its `nextConnection` (`next`) opens after a
 * loss, all of `topology` and ended after the test. `calls()` counts `next`'s calls; `failNext()` makes the next call
 * reject, as a connection that cannot open.
 */
export async function topologyConnections(
  context: TestContext,
  topology: Topology,
  options: { readonly delayMs?: number } = {},
) {
  const made: TopologyBridge[] = [await topologyBridge(context, topology, options)];
  let calls = 0;
  let failing = false;
  return {
    /** Each connection made, the first included, in order. */
    get made(): readonly TopologyBridge[] {
      return made;
    },
    first: made[0]!,
    /** The connection opened last. */
    current: () => made.at(-1)!,
    calls: () => calls,
    failNext: () => void (failing = true),
    async next(): Promise<PlayerBridge> {
      calls += 1;
      if (failing) {
        failing = false;
        throw new Error("The engine Worker could not be opened.");
      }
      const fresh = await topologyBridge(context, topology, options);
      made.push(fresh);
      return fresh.bridge;
    },
  };
}
export type TopologyConnections = Awaited<ReturnType<typeof topologyConnections>>;

/**
 * `port` with this connection's post log and reply gate: each request it posts is logged; once the gate's target op is
 * posted, every reply from then on waits at the port, the target's among them, until `release`.
 */
function gatedPort(port: Client.ClientPort) {
  const posts: Posted[] = [];
  const gate: {
    target: string | null;
    id: number | null;
    holding: boolean;
    heldTarget: boolean;
    from: number;
  } = { target: null, id: null, holding: false, heldTarget: false, from: 0 };
  const buffered: unknown[] = [];
  let deliver: (data: unknown) => void = () => {};
  const gated: Client.ClientPort = {
    ...port,
    post: (message) => {
      const request = decoded(message);
      if (request?.kind === "request") {
        posts.push(postOf(request));
        if (gate.target !== null && request.op === gate.target && gate.id === null) {
          gate.id = request.id;
          gate.holding = true;
        }
      }
      port.post(message);
    },
    listen: (listener) => {
      deliver = listener;
      port.listen((data) => {
        if (!gate.holding) return listener(data);
        if (decoded(data)?.id === gate.id) gate.heldTarget = true;
        buffered.push(data);
      });
    },
  };
  return {
    port: gated,
    posts,
    hold: (op: string) =>
      void Object.assign(gate, { target: op, id: null, heldTarget: false, from: posts.length }),
    held: () =>
      until(
        () => gate.heldTarget,
        `the reply to ${gate.target} held at the port; posted since: ${posts
          .slice(gate.from)
          .map((post) => post.op)
          .join(", ")}`,
      ),
    release: () => {
      Object.assign(gate, { holding: false, target: null });
      for (const data of buffered.splice(0)) deliver(data);
    },
  };
}

function inProcess(
  delayMs: number | undefined,
): Omit<TopologyBridge, "topology" | "assertTopology"> {
  const wrapped: { gated?: ReturnType<typeof gatedPort> } = {};
  const bridge = facade!.createInProcessBackend(BUILD, {
    ...(delayMs === undefined ? {} : { delayMs }),
    wrapPort: (port) => (wrapped.gated = gatedPort(port)).port,
  });
  const gated = wrapped.gated;
  assert.ok(gated !== undefined, "the backend took the gated port");
  const { posts, hold, held, release } = gated;
  const lose = inProcessLoss(bridge, client!.BridgeLostError);
  return { bridge, posts, exited: null, lose: async () => lose(), hold, held, release };
}

async function onWorker(entry: URL): Promise<Omit<TopologyBridge, "topology" | "assertTopology">> {
  const worker = new Worker(entry, { workerData: { build: BUILD } });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  const { port, posts, hold, held, release } = gatedPort({
    post: (message) => worker.postMessage(message),
    listen: (listener) => void worker.on("message", (data: unknown) => listener(data)),
    onFailure: (listener) => {
      worker.on("error", listener);
      worker.on("messageerror", listener);
      worker.on("exit", (code) => listener(new Error(`The worker exited with code ${code}.`)));
    },
    terminate: () => void worker.terminate(),
  });
  const bridge = new bridgeModule!.PlayerBridge(await client!.connectBridge(port, BUILD));
  return {
    bridge,
    posts,
    exited,
    lose: () =>
      new Promise<void>((resolve) => {
        bridge.client.onLoss(() => resolve());
        void worker.terminate();
      }),
    hold,
    held,
    release,
  };
}

/** A row's acknowledgement that its body reached its end: `rows` gives each row its own, through `end()`. */
export class RowEnd {
  readonly #row: string;
  constructor(row: string) {
    this.#row = row;
  }
  toString(): string {
    return this.#row;
  }
}

/**
 * A file's rerun registry: each case's id with the topologies it runs on. `rows` registers a case once and makes one test
 * per listed topology. A row is complete once its body returned the acknowledgement its `end()` gives that row, and its
 * cleanup ran after; the file's end checks that every listed row completed. A body that returns otherwise, early or at
 * its start, fails its row, and TypeScript refuses a bare `return` in it.
 *
 * It closes the registered cases only: a test written outside the registry is not covered. It cannot tell that every
 * assertion of a body ran: a body that acknowledges early (`return end()` before its last assertions), or that skips
 * assertions in a branch without returning, completes its row. Only a reading of the body shows those.
 */
export function rerunRegistry<Id extends string>(cases: Readonly<Record<Id, readonly Topology[]>>) {
  const feasible: Coordinates[] = Object.entries<readonly Topology[]>(cases).flatMap(
    ([id, topologies]) => topologies.map((topology) => ({ case: id, topology })),
  );
  const completed: Coordinates[] = [];
  const registered = new Set<Id>();
  after(() =>
    assert.deepEqual(coverageGaps(feasible, completed, { tuples: true }), [], "registered rows"),
  );
  return {
    rows(
      id: Id,
      name: string,
      body: (context: TestContext, topology: Topology, end: () => RowEnd) => Promise<RowEnd>,
    ): void {
      // One registration per case: a second would complete the first's coordinates in its place.
      assert.ok(!registered.has(id), `the case ${id} is registered twice`);
      registered.add(id);
      for (const topology of cases[id])
        test(`${name} (${topology})`, async (context) => {
          const token = new RowEnd(`${id} (${topology})`);
          const returned = await body(context, topology, () => token);
          assert.equal(returned, token, "the row's body returned its own end()");
          context.after(() => void completed.push({ case: id, topology }));
        });
    },
  };
}

/** The host's snapshot of `session`, read over the bridge as its checkpoint (`captureCheckpoint`), on either topology. */
export async function checkpointSnapshot(
  bridge: PlayerBridge,
  session: PlayerSession,
): Promise<RuntimeSnapshot> {
  const { checkpointJson } = await bridge.read(session, "captureCheckpoint");
  return deserializeCheckpoint(checkpointJson).snapshot;
}

/**
 * A session restored from `snapshotJson` against the held plan `token`, held by the host of `transport` with no events
 * before it, as a test restores one: in-process through the facade, on a Worker through the test entry's
 * `restoreForTest` (open the bridge with `entry: "restore"`).
 */
export async function restoredSession(
  transport: TopologyBridge,
  token: string,
  snapshotJson: string,
): Promise<PlayerSession> {
  if (transport.topology === "in-process")
    return facade!.introduceNow(
      transport.bridge,
      (host) => restorePlayerRuntimeSessionAt(host.plan(token), snapshotJson, []),
      NO_MARKS,
    );
  const reply = await untypedClient(transport.bridge.client).request("restoreForTest", {
    plan: token,
    snapshotJson,
  });
  // EVIDENCE: validation: the test op replies with the new session's introduction.
  return transport.bridge.open(reply.session!, reply.view as Introduction);
}
