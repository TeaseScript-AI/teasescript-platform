import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import type * as Client from "../../../player/engine-bridge/client.js";
import type * as InProcess from "../bridge/in-process.js";
import type { BuildIdentity } from "../../../player/engine-bridge/protocol.js";
import { decodeMessage } from "../../../player/engine-bridge/transport.js";
import type * as Bridge from "../../../player/runtime/player-bridge.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import { coverageGaps, type Coordinates } from "../family-coverage.js";
import { loadPlayerModule } from "../player-modules.js";
import { untypedClient } from "../bridge/untyped.js";
import type { Introduction } from "../../../player/engine-bridge/session-protocol.js";
import { deserializeCheckpoint } from "../../../src/runtime/snapshot/checkpoint.js";
import type { RuntimeSnapshot } from "../../../src/index.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";

/*
 * The composable's engine bridge on a Node Worker thread running the engine's Worker entry (L5i.7), as the Player runs
 * it, built from the test-modules bundle's own client and bridge, the composable's module instances. Its controls:
 * - `lose()`: the Worker lost, resolving once the client's loss listeners ran (the composable's first, as it registered
 *   at ready): the thread is terminated, and its `exit` reaches the client as a real loss.
 * - `hold(op)`, `held(later?)`, `release()`: from the post of the first request of `op` after `hold`, its reply and
 *   every later one are held at the client's port, this connection's alone, until `release`; `held()` resolves once
 *   that reply is among them, `held(later)` once the reply to the latest request of `later` is too.
 * - `posts`: every request the client posted, in order, as it reached the port.
 * - `assertTopology()`, also checked when the bridge is built: `thread` is a real thread (a positive id) that answered
 *   the bridge's handshake.
 * `tests/helpers/bridge/sends.ts` decides sends above the client instead; this helper works below it, so the client's
 * own disposition of a post stands, and the log holds only what reached the port.
 */

/** Where a row's engine runs: the Player's only topology, a Worker. Rows keep it in their names. */
export type Topology = "worker";

/*
 * A setting of a run, read once when this module loads (docs/TESTING.md "Worker-topology settings"):
 * `PLAYER_TEST_WORKER_DELAY_MS`, a whole number of milliseconds (default 0) by which every message from a Worker reaches
 * its client late, in the order the Worker sent it (`delayedDelivery`).
 */

/** The delay `setting` gives every message from a Worker: a whole number of milliseconds, 0 when empty. */
export function workerDelayMs(setting: string | undefined): number {
  if (setting === undefined || setting === "") return 0;
  const ms = /^\d+$/u.test(setting) ? Number(setting) : Number.NaN;
  if (!Number.isSafeInteger(ms))
    throw new Error(
      `PLAYER_TEST_WORKER_DELAY_MS is a whole number of milliseconds, not ${JSON.stringify(setting)}.`,
    );
  return ms;
}

export const TOPOLOGIES: readonly Topology[] = ["worker"];
const WORKER_DELAY_MS = workerDelayMs(process.env["PLAYER_TEST_WORKER_DELAY_MS"]);

// The real timer and monotonic clock, as this module loads: a test that mocks timers, `Date` or `performance` later
// neither moves nor holds a delayed delivery.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * Runs each callback given to `run` `delayMs` after it was given, in the order given, on the real timer; at 0, at once.
 * Each runs in a task of its own, as each of a Worker's events does, so the promise work one starts settles before the
 * next. `cancel` drops the callbacks not yet run and every later one, so none runs after the test that owned them.
 */
export function delayedDelivery(delayMs: number) {
  const queue: { readonly due: number; readonly deliver: () => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const schedule = () => {
    if (timer === null && queue.length > 0)
      timer = realSetTimeout(drain, Math.max(0, queue[0]!.due - monotonicMs()));
  };
  const drain = () => {
    timer = null;
    try {
      if (queue.length > 0 && queue[0]!.due <= monotonicMs()) queue.shift()!.deliver();
    } finally {
      schedule();
    }
  };
  return {
    run(deliver: () => void): void {
      if (cancelled) return;
      if (delayMs === 0) return deliver();
      queue.push({ due: monotonicMs() + delayMs, deliver });
      schedule();
    },
    cancel(): void {
      cancelled = true;
      queue.length = 0;
      if (timer !== null) realClearTimeout(timer);
      timer = null;
    },
    pending: (): number => queue.length,
  };
}

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
  held(later?: string): Promise<void>;
  release(): void;
  assertTopology(): void;
  /** Resolves with the thread's exit code once it exited. */
  readonly exited: Promise<number>;
  /** The thread that runs the host: its id, and how many messages it sent. */
  readonly thread: { readonly id: number; readonly messages: () => number };
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

/** Loads the bundle's client and bridge: call it in a `before` hook of a file that uses the helper. */
export async function loadTopology(): Promise<void> {
  // EVIDENCE: validation: the bundle's own modules, whose instances the composable runs with.
  client = (await loadPlayerModule("player/engine-bridge/client.ts")) as typeof Client;
  // EVIDENCE: validation: as above.
  bridgeModule = (await loadPlayerModule("player/runtime/player-bridge.ts")) as typeof Bridge;
}

/**
 * The in-process backend of the bundle the composable runs in, for a test to pass as the composable's `bridge`. Its
 * options are the backend's: replies after `delayMs`, and Debug's rewind histories' spill store and admission bound.
 */
export async function inProcessBackend(
  options: NonNullable<Parameters<typeof InProcess.createInProcessBackend>[1]> = {},
): Promise<PlayerBridge> {
  // EVIDENCE: validation: the bundle's own module, whose instances the composable runs with.
  const module = (await loadPlayerModule("tests/helpers/bridge/in-process.ts")) as typeof InProcess;
  return module.createInProcessBackend(BUILD, options);
}

/**
 * How long a wait on the engine's host may take: a reply or publication of a real Worker, which the host's load decides.
 * The slowest measured took about 0.6 s on a loaded queue host.
 */
const HOST_MS = 30_000;

/**
 * Whether a wait on the engine's host that began now may still go on: for `HOST_MS`, on the process's monotonic clock
 * (`process.hrtime`), which no test mocks as it does `Date`, `performance` and timers. Make it once per wait, outside
 * its loop: one made again each round renews the allowance without end. It neither waits nor fails: its caller yields
 * to real time between checks, so a Worker's messages arrive, and fails with its own label. For `until`, and for a wait
 * that steps a mocked clock itself. A test's several host waits still share the runner's limit per test.
 */
export function withinHostTime(): () => boolean {
  const deadline = process.hrtime.bigint() + BigInt(HOST_MS) * 1_000_000n;
  return () => process.hrtime.bigint() < deadline;
}

/**
 * Waits, in short real-time turns, until `check` holds, and fails with `never: <label>` if it never does. `on` says
 * what `check` depends on, chosen by that dependency, not by the topology or by how fast it was seen to hold:
 * - `"step"`: local work only, once every host reply or publication it needs has arrived; it gives up after 1,000 turns.
 * - `"host"`: a reply or publication of the engine's host that may still be under way, a held one included; it gives up
 *   after `HOST_MS` of real time (`withinHostTime`).
 *
 * A `"step"` wait that does depend on the host usually holds at once, and fails `never: <label>` on a slow runner or
 * under the delayed challenge (docs/TESTING.md "Worker-topology settings"), which is how the wrong choice shows. A
 * request that was never made is not found by a longer bound. Its turns run on real timers, so a test that mocks
 * `setTimeout` cannot use it; a loop that steps a mocked clock uses `withinHostTime` instead.
 */
export async function until(
  check: () => boolean,
  label: string,
  on: "step" | "host",
): Promise<void> {
  const within = withinHostTime();
  const waiting = (turn: number) => (on === "host" ? within() : turn < 1_000);
  for (let turn = 0; waiting(turn); turn += 1) {
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
  // The loss ends the client itself, not through a `terminate` a test counts as the Player's.
  const end = bridge.client.terminate.bind(bridge.client);
  return () => {
    end();
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

/** A bridge on a Worker, ended after the test. Its post log and reply gate are this connection's alone. */
export async function topologyBridge(
  context: TestContext,
  topology: Topology,
  { entry = "engine" }: { readonly entry?: keyof typeof WORKERS } = {},
): Promise<TopologyBridge> {
  assert.ok(client && bridgeModule, "call loadTopology first");
  const delivery = delayedDelivery(WORKER_DELAY_MS);
  const made = await onWorker(WORKERS[entry], delivery);
  // A delivery received before the test's end still reaches the client through the test's own loss, release and
  // waits; at its end, those not yet delivered are dropped.
  context.after(() => {
    made.bridge.client.terminate();
    delivery.cancel();
  });
  const assertTopology = () => {
    assert.ok(
      made.thread.id > 0 && made.thread.messages() > 0,
      "the host runs on a thread that answered",
    );
  };
  // No row can run labelled `worker` without a Worker.
  assertTopology();
  return { ...made, topology, assertTopology };
}

/**
 * The connections of one Player on a Worker: the first, and each fresh one its `nextConnection` (`next`) opens after a
 * loss, each ended after the test. `calls()` counts `next`'s calls; `failNext()` makes the next call
 * reject, as a connection that cannot open; `armNext(step)` runs `step` on the next fresh connection, and waits for it,
 * before `next` gives it. `ends(connection)` counts the calls of its client's `terminate()` during the test.
 */
export async function topologyConnections(context: TestContext, topology: Topology) {
  const ends = new Map<TopologyBridge, number>();
  const counted = (connection: TopologyBridge) => {
    const client = connection.bridge.client;
    const terminate = client.terminate.bind(client);
    ends.set(connection, 0);
    client.terminate = () => {
      ends.set(connection, (ends.get(connection) ?? 0) + 1);
      terminate();
    };
    return connection;
  };
  const made: TopologyBridge[] = [counted(await topologyBridge(context, topology))];
  let calls = 0;
  let failing = false;
  let armed: ((fresh: TopologyBridge) => void | Promise<void>) | null = null;
  return {
    /** Each connection made, the first included, in order. */
    get made(): readonly TopologyBridge[] {
      return made;
    },
    first: made[0]!,
    /** The connection opened last. */
    current: () => made.at(-1)!,
    calls: () => calls,
    ends: (connection: TopologyBridge) => ends.get(connection) ?? 0,
    failNext: () => void (failing = true),
    armNext: (step: (fresh: TopologyBridge) => void | Promise<void>) => void (armed = step),
    async next(): Promise<PlayerBridge> {
      calls += 1;
      if (failing) {
        failing = false;
        throw new Error("The engine Worker could not be opened.");
      }
      const fresh = counted(await topologyBridge(context, topology));
      made.push(fresh);
      const step = armed;
      armed = null;
      await step?.(fresh);
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
    held: (later?: string) =>
      until(
        () => {
          if (later === undefined) return gate.heldTarget;
          const last = posts.slice(gate.from).findLast((post) => post.op === later);
          return last !== undefined && buffered.some((data) => decoded(data)?.id === last.id);
        },
        `the reply to ${later ?? gate.target} held at the port; posted since: ${posts
          .slice(gate.from)
          .map((post) => post.op)
          .join(", ")}`,
        "host",
      ),
    release: () => {
      Object.assign(gate, { holding: false, target: null });
      for (const data of buffered.splice(0)) deliver(data);
    },
  };
}

async function onWorker(
  entry: URL,
  delivery: ReturnType<typeof delayedDelivery>,
): Promise<Omit<TopologyBridge, "topology" | "assertTopology">> {
  const worker = new Worker(entry, { workerData: { build: BUILD } });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  let messages = 0;
  // A failure takes its place in the same order as the messages: a reply the Worker sent before it ended reaches the
  // client before the loss does. This holds by construction (`onFailure` goes through `delivery.run`); no test
  // asserts it.
  const { port, posts, hold, held, release } = gatedPort({
    post: (message) => worker.postMessage(message),
    listen: (listener) =>
      void worker.on("message", (data: unknown) => {
        messages += 1;
        delivery.run(() => listener(data));
      }),
    onFailure: (listener) => {
      const fail = (error: Error) => delivery.run(() => listener(error));
      worker.on("error", fail);
      worker.on("messageerror", fail);
      worker.on("exit", (code) => fail(new Error(`The worker exited with code ${code}.`)));
    },
    terminate: () => void worker.terminate(),
  });
  const bridge = new bridgeModule!.PlayerBridge(await client!.connectBridge(port, BUILD));
  return {
    bridge,
    posts,
    exited,
    thread: { id: worker.threadId, messages: () => messages },
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

/** The host's snapshot of `session`, read over the bridge as its checkpoint (`captureCheckpoint`). */
export async function checkpointSnapshot(
  bridge: PlayerBridge,
  session: PlayerSession,
): Promise<RuntimeSnapshot> {
  const { checkpointJson } = await bridge.read(session, "captureCheckpoint");
  return deserializeCheckpoint(checkpointJson).snapshot;
}

/**
 * A session restored from `snapshotJson` against the held plan `token`, held by the host of `transport` with no events
 * before it, through the Worker test entry's `restoreForTest` (open the bridge with `entry: "restore"`).
 */
export async function restoredSession(
  transport: TopologyBridge,
  token: string,
  snapshotJson: string,
): Promise<PlayerSession> {
  const reply = await untypedClient(transport.bridge.client).request("restoreForTest", {
    plan: token,
    snapshotJson,
  });
  // EVIDENCE: validation: the test op replies with the new session's introduction.
  return transport.bridge.open(reply.session!, reply.view as Introduction);
}
