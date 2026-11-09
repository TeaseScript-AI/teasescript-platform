import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import {
  BridgeRequestError,
  openBridge,
  type BridgeResult,
  type ClientPort,
} from "../../player/engine-bridge/client.js";
import { NO_MARKS } from "../../player/debug/debug-history-marks.js";
import { DeliveryRefusedError } from "../../player/engine-bridge/delivery.js";
import {
  createInProcessBackend,
  hatch,
  heldPlan,
  introduceNow,
} from "../../player/engine-bridge/in-process.js";
import {
  closeConnection,
  playerBridgeOps,
  playerOpsContext,
  type PlayerOpsContext,
} from "../../player/engine-bridge/player-ops.js";
import { decodeMessage } from "../../player/engine-bridge/transport.js";
import {
  type BridgeOp,
  type BridgeOps,
  type HostPort,
  type HostSessions,
  type OpOutcome,
  startBridgeHost,
} from "../../player/engine-bridge/worker-host.js";
import { createPlayerRuntimeRestorePoint } from "../../player/runtime/runtime-adapter.js";
import { sessionTransferText } from "../../player/persistence/session-transfer.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";

/*
 * Who owns what the host allocates (#2006, `delivery.ts`): its capability allocations and their ancillary state, not
 * the diagnostic state `releaseConnection` deliberately keeps (the recorder, the value trace, the random control).
 * One invariant: every such allocation the host retains belongs to a live delivery or a live owner, and an ended
 * delivery or owner leaves none behind. A delivery is live from just before its op runs until its success reply is
 * posted; after that, what it allocated is the connection's, until it is released or the connection closes.
 *
 * This file: the host and facade lifecycle, over allocation class × what happens to a delivery or its owner, on the
 * real host, client and in-process backend. The owner's decisions and the construction checks have files of their own
 * (`player-bridge-delivery-owner.test.ts`, `player-bridge-delivery-census.test.ts`).
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };
const SCRIPT = ["let n = randomInteger(1..=6)", 'say "rolled ${n}"', "exit"].join("\n");
const PLAN = compilePlayerProject(SCRIPT).plan!;
const PLAN_JSON = serializeValidatedRuntimeJson(PLAN);
const TRANSFER_TEXT = await sessionTransferText(
  {
    scope: "development-package:delivery",
    name: "Delivery",
    session: createPlayerRuntimeRestorePoint(createPlayerRuntimeSession(PLAN)),
    entries: [],
    media: [],
  },
  false,
);

// ---------------------------------------------------------------------------------------------------------------------
// The family: what the host retains, over allocation class × what happens to its delivery or owner.

/**
 * What happens to the delivery of the case's request, injected into its op or its port: `holdOpen` keeps its real op's
 * outcome back, with its allocation made and its delivery open, until released.
 */
type Injection =
  "holdOpen" | "throwBeforeOutcome" | "throwInAnswer" | "failedEncoding" | "failedPost";

/** A connection assembled from production parts: the client, the host and the Player's ops, over a test port. */
interface Connection {
  readonly context: PlayerOpsContext;
  readonly sessions: HostSessions;
  request(op: string, args: unknown, session?: string): Promise<BridgeResult>;
  /** Makes `injection` happen to the next request of `op`, and to it alone. */
  arm(op: string, injection: Injection): void;
  /** Lets an op `holdOpen` kept back go on to its reply. */
  releaseHeld(): void;
  /** Fails the client's port, as a lost Worker does: the client loses the connection. */
  lose(): void;
  /** How often the client reported its loss to a listener. */
  losses(): number;
  /** Replies posted and not yet delivered to the client. */
  readonly transit: unknown[];
  deliver(): void;
  /** How many success replies were posted for requests of `op`. */
  successPosts(op: string): number;
}

/** A value nested past what crosses as it is, holding a function: its encoding clones it and fails. */
type Unencodable = { readonly run: () => number } | { readonly value: Unencodable };
function unencodable(): Unencodable {
  let value: Unencodable = { run: () => 0 };
  for (let level = 0; level < 300; level += 1) value = { value };
  return value;
}

function assembled(): Connection {
  const context = playerOpsContext();
  const opOf = new Map<number, string>();
  const successes = new Map<string, number>();
  const transit: unknown[] = [];
  let armed: { readonly op: string; readonly injection: Injection } | null = null;
  let releaseHeld = () => {};
  const held = new Promise<void>((resolve) => (releaseHeld = resolve));
  let fail: (reason: unknown) => void = () => {};
  /** The armed injection for a request of `op`, used up. */
  const take = (op: string, kinds: readonly Injection[]): Injection | null => {
    if (armed === null || armed.op !== op || !kinds.includes(armed.injection)) return null;
    const { injection } = armed;
    armed = null;
    return injection;
  };
  let toHost: ((data: unknown) => void) | null = null;
  let toClient: ((data: unknown) => void) | null = null;
  const hostPort: HostPort = {
    post: (message) => {
      const data = decodeMessage(structuredClone(message));
      // EVIDENCE: fixture: this port carries only the messages the host posts, each with these fields where it has them.
      const reply = data as { kind?: string; id?: number; ok?: boolean };
      if (reply.kind === "reply" && reply.ok === true) {
        const op = opOf.get(reply.id!)!;
        if (take(op, ["failedPost"]) !== null) throw new Error("injected: the success post fails");
        successes.set(op, (successes.get(op) ?? 0) + 1);
      }
      transit.push(data);
    },
    listen: (listener) => void (toHost = listener),
  };
  const clientPort: ClientPort = {
    post: (message) => {
      // EVIDENCE: fixture: this port carries only the client's requests, each with its ID and op.
      const request = decodeMessage(structuredClone(message)) as { id: number; op: string };
      opOf.set(request.id, request.op);
      toHost?.(request);
    },
    listen: (listener) => void (toClient = listener),
    onFailure: (listener) => void (fail = listener),
    // As the in-process backend's: the client ends its port first, which closes the connection directly.
    terminate: () => closeConnection(context, sessions),
  };
  const ops = playerBridgeOps(context);
  // Each op runs as it is, but for an armed injection into the outcome of its next request.
  const wrapped: BridgeOps = Object.fromEntries(
    Object.entries(ops).map(([name, op]) => [
      name,
      {
        ...op,
        run: (...args: Parameters<BridgeOp["run"]>) => {
          const injection = take(name, [
            "holdOpen",
            "throwBeforeOutcome",
            "throwInAnswer",
            "failedEncoding",
          ]);
          if (injection === null) return op.run(...args);
          if (injection === "holdOpen")
            return Promise.resolve(op.run(...args)).then(async (outcome) => {
              await held;
              return outcome;
            });
          return Promise.resolve(op.run(...args)).then((outcome): OpOutcome => {
            if (injection === "throwBeforeOutcome")
              throw new Error("injected: after the allocation");
            if (injection === "throwInAnswer")
              return {
                ...outcome,
                get view(): never {
                  throw new Error("injected: building the answer");
                },
              };
            return { ...outcome, result: { result: outcome.result, unencodable: unencodable() } };
          });
        },
      } satisfies BridgeOp,
    ]),
  );
  const { client } = openBridge(clientPort, BUILD);
  const sessions = startBridgeHost(hostPort, wrapped, BUILD, context.delivery);
  let losses = 0;
  client.onLoss(() => (losses += 1));
  const connection: Connection = {
    context,
    sessions,
    request: (op, args, session) =>
      client.request(op, args, session === undefined ? {} : { session }),
    arm: (op, injection) => void (armed = { op, injection }),
    releaseHeld: () => releaseHeld(),
    lose: () => fail(new Error("injected: the Worker failed")),
    losses: () => losses,
    transit,
    deliver: () => {
      for (const data of transit.splice(0)) toClient?.(data);
    },
    successPosts: (op) => successes.get(op) ?? 0,
  };
  connection.deliver();
  return connection;
}

/** Delivers replies until `pending` settles. */
async function settled<T>(
  connection: Connection,
  pending: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  let result: PromiseSettledResult<T> | null = null;
  void pending.then(
    (value) => (result = { status: "fulfilled", value }),
    (reason: unknown) => (result = { status: "rejected", reason }),
  );
  for (let turn = 0; result === null; turn += 1) {
    assert.ok(turn < 1000, "the request settles");
    connection.deliver();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return result;
}

/** Waits, without delivering, until a reply is in transit. */
async function inTransit(connection: Connection): Promise<void> {
  for (let turn = 0; connection.transit.length === 0; turn += 1) {
    assert.ok(turn < 1000, "a reply is posted");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** What the host retains, by registry and identity. Sessions are found by their IDs, which the host gives in order. */
function retained({ context, sessions }: Connection): string[] {
  return [
    ...[...context.plans.keys()].map((token) => `plan ${token}`),
    ...[...context.sources.keys()].map((token) => `sources ${token}`),
    ...[...context.planTexts.keys()].map((token) => `slot ${token}`),
    ...[...context.transfers.keys()].map((ticket) => `transfer ${ticket}`),
    ...[...context.recordings].map(([ticket, held]) => `${held.kind} ${ticket}`),
    ...[...context.sourceViews.texts.keys()].map((token) => `sidecar text ${token}`),
    ...[...context.sourceViews.sidecars.keys()].map((token) => `sidecar ${token}`),
    ...(context.sourceViews.latestFile.value === null ? [] : ["latest file"]),
    ...Array.from({ length: 20 }, (_, index) => `s${index + 1}`)
      .filter((id) => sessions.get(id) !== undefined)
      .map((id) => `session ${id}`),
  ].sort();
}

/** The allocation classes, each through the real op that makes it, and whether that op awaits before it allocates. */
const CLASSES = {
  plan: { op: "prepare", async: false },
  sources: { op: "prepare", async: true },
  session: { op: "start", async: false },
  transfer: { op: "readTransfer", async: true },
  slot: { op: "preparePlanText", async: false },
  cache: { op: "drawCode", async: true },
  recording: { op: "captureRecording", async: false },
  export: { op: "captureExport", async: false },
} as const;
type AllocationClass = keyof typeof CLASSES;
/** The classes whose op awaits before it allocates. */
const AWAITING = new Set(
  Object.entries(CLASSES)
    .filter(([, each]) => each.async)
    .map(([name]) => name),
);

/**
 * What happens to the delivery or its owner: its whole life (`lifecycle`: open, posted, received, retired), a reusable
 * teardown after receipt, an injection (`Injection`), or the connection closed while the op runs, with its reply in
 * transit, or after receipt.
 */
const FAMILY_AXES = {
  allocation: [
    "plan",
    "sources",
    "session",
    "transfer",
    "slot",
    "cache",
    "recording",
    "export",
  ] satisfies readonly AllocationClass[],
  event: [
    "lifecycle",
    "teardown",
    "throwBeforeOutcome",
    "throwInAnswer",
    "failedEncoding",
    "failedPost",
    "closeWhileRunning",
    "closeInTransit",
    "closeAfterReceipt",
  ],
} as const;
type FamilyEvent = (typeof FAMILY_AXES.event)[number];
type FamilyCase = { readonly allocation: AllocationClass; readonly event: FamilyEvent };

/**
 * Why a combination is no case: an op with no await (production `start`, a plan's `prepare`, `preparePlanText`)
 * allocates and replies in one step, so nothing happens while it runs. (Encoding cannot fail after the reply was posted,
 * and a failed post is not that reply delivered: each is its own event, before the post. An ID-based release needs the
 * ID received, so it is the lifecycle's last point.)
 */
const familyInfeasible = ({ allocation, event }: Coordinates) =>
  event === "closeWhileRunning" && !AWAITING.has(allocation!);

function familyCases(): FamilyCase[] {
  const feasible = product(FAMILY_AXES).filter((each) => !familyInfeasible(each));
  // EVIDENCE: fixture: `product` gives each axis one value of its declared domain.
  return feasible as FamilyCase[];
}

/** What every allocation class owes, declared on its own: the events of an op that allocates at once, or after an await. */
const AT_ONCE: readonly FamilyEvent[] = [
  "lifecycle",
  "teardown",
  "throwBeforeOutcome",
  "throwInAnswer",
  "failedEncoding",
  "failedPost",
  "closeInTransit",
  "closeAfterReceipt",
];
const AFTER_AWAIT: readonly FamilyEvent[] = [...AT_ONCE, "closeWhileRunning"];
const OBLIGATIONS: Readonly<Record<AllocationClass, readonly FamilyEvent[]>> = {
  plan: AT_ONCE,
  sources: AFTER_AWAIT,
  session: AT_ONCE,
  transfer: AFTER_AWAIT,
  slot: AT_ONCE,
  cache: AFTER_AWAIT,
  recording: AT_ONCE,
  export: AT_ONCE,
};

/** What each class's op adds to the controls, exactly. */
const ADDED: Readonly<Record<AllocationClass, readonly string[]>> = {
  plan: ["plan p4"],
  sources: ["plan p4", "sources p4"],
  session: ["session s2"],
  transfer: ["transfer transfer-2"],
  slot: ["slot p2"],
  cache: ["latest file", "sidecar p3", "sidecar text p3"],
  recording: ["recording r1"],
  export: ["export r1"],
};

/**
 * How the owner of what each class's op added lets go of it once received: an op of its own, with its arguments and
 * session; `null` where the connection owns it until it closes (plans, their sources, the source-view caches).
 */
const RETIRE: Readonly<
  Record<
    AllocationClass,
    { readonly op: string; readonly args: unknown; readonly session?: string } | null
  >
> = {
  plan: null,
  sources: null,
  session: { op: "release", args: null, session: "s2" },
  transfer: { op: "releaseTransfer", args: { ticket: "transfer-2" } },
  slot: { op: "releasePlanText", args: { plan: "p2" } },
  cache: null,
  recording: { op: "releaseRecording", args: { ticket: "r1" } },
  export: { op: "releaseRecording", args: { ticket: "r1" } },
};

/**
 * The controls, which exist before the case's request and which no failure of it may undo: a plan `p1` with its slot,
 * a session `s1` on it, which the recorder records, a transfer, a second plan `p2` (for a new slot), and a compiled plan `p3` (for the source views).
 */
async function withControls(connection: Connection): Promise<void> {
  const send = async (op: string, args: unknown) =>
    assert.equal((await settled(connection, connection.request(op, args))).status, "fulfilled");
  await send("prepare", { source: { kind: "plan", text: PLAN_JSON } });
  await send("preparePlanText", { plan: "p1" });
  // Recorded, so that a recording capture and an export of it have a recording to hold.
  await send("start", { plan: "p1", options: START, recording: true });
  await send("readTransfer", { text: TRANSFER_TEXT });
  await send("prepare", { source: { kind: "plan", text: PLAN_JSON } });
  await send("prepare", { source: { kind: "source", script: SCRIPT } });
}

/** The arguments of `allocation`'s op on a connection with the controls. */
async function argumentsOf(
  connection: Connection,
  allocation: AllocationClass,
): Promise<Readonly<Record<string, unknown>>> {
  switch (allocation) {
    case "plan":
      return { source: { kind: "plan", text: PLAN_JSON } };
    case "sources":
      return { source: { kind: "source", script: SCRIPT } };
    case "session":
      return { plan: "p1", options: START, recording: false };
    case "transfer":
      return { text: TRANSFER_TEXT };
    case "slot":
      return { plan: "p2" };
    case "recording":
      return { session: "s1" };
    case "export":
      return { session: "s1", recording: "current" };
    case "cache": {
      const metadata = await settled(
        connection,
        connection.request("planMetadata", { plan: "p3" }),
      );
      assert.equal(metadata.status, "fulfilled");
      // EVIDENCE: fixture: the request was fulfilled (asserted above).
      const { result } = (metadata as PromiseFulfilledResult<BridgeResult>).value;
      // EVIDENCE: fixture: `planMetadata` of a held plan gives its random sites, and SCRIPT has one.
      const site = (result as { randomSites: readonly { path: string }[] }).randomSites[0]!;
      return { plan: "p3", path: site.path, site };
    }
  }
}

const PLAN_REQUEST = { source: { kind: "plan", text: PLAN_JSON } };

/** Waits, delivering nothing, until `ready` holds. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let turn = 0; !ready(); turn += 1) {
    assert.ok(turn < 1000, what);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

for (const each of familyCases())
  test(`a host allocation: ${each.allocation}, ${each.event}`, async () => {
    const { op } = CLASSES[each.allocation];
    const connection = assembled();
    await withControls(connection);
    const args = await argumentsOf(connection, each.allocation);
    const controls = retained(connection);
    const withAdded = [...controls, ...ADDED[each.allocation]].sort();
    const postsBefore = connection.successPosts(op);
    if (each.event === "lifecycle") connection.arm(op, "holdOpen");
    if (
      each.event === "throwBeforeOutcome" ||
      each.event === "throwInAnswer" ||
      each.event === "failedEncoding" ||
      each.event === "failedPost"
    )
      connection.arm(op, each.event);
    const pending = connection.request(op, args);
    if (each.event === "closeWhileRunning")
      closeConnection(connection.context, connection.sessions);
    if (each.event === "closeInTransit") {
      await inTransit(connection);
      closeConnection(connection.context, connection.sessions);
    }
    if (each.event === "lifecycle") {
      // Open: the allocation made, its delivery not posted. The delivery owns it.
      await until(() => retained(connection).length === withAdded.length, "the op allocated");
      assert.deepEqual(
        retained(connection),
        withAdded,
        "open: the controls and exactly what it added",
      );
      assert.equal(connection.transit.length, 0, "open: nothing posted");
      // Posted: its reply in transit, not yet received; the connection owns it.
      connection.releaseHeld();
      await inTransit(connection);
      assert.deepEqual(retained(connection), withAdded, "posted");
    }
    const result = await settled(connection, pending);
    switch (each.event) {
      case "lifecycle": {
        assert.equal(result.status, "fulfilled");
        assert.deepEqual(retained(connection), withAdded, "received");
        const retire = RETIRE[each.allocation];
        if (retire !== null) {
          const released = await settled(
            connection,
            connection.request(retire.op, retire.args, retire.session),
          );
          assert.equal(released.status, "fulfilled");
          assert.deepEqual(retained(connection), controls, "retired: that allocation alone gone");
        }
        break;
      }
      case "teardown":
        assert.equal(result.status, "fulfilled");
        await settled(connection, connection.request("teardown", null));
        assert.deepEqual(retained(connection), [], "the teardown let go of everything");
        // The connection stays open: a later op allocates as before.
        await settled(connection, connection.request("prepare", PLAN_REQUEST));
        // Tokens go on from wherever the connection's count stood.
        assert.deepEqual(
          retained(connection).map((one) => one.replace(/\d+$/u, "N")),
          ["plan pN"],
        );
        break;
      case "throwBeforeOutcome":
      case "throwInAnswer":
      case "failedEncoding":
      case "failedPost":
        assert.equal(result.status, "rejected", "the request fails");
        assert.deepEqual(
          retained(connection),
          controls,
          "that allocation undone, the controls kept",
        );
        assert.equal(connection.successPosts(op), postsBefore, "no success reply reached the port");
        break;
      case "closeWhileRunning":
      case "closeInTransit":
      case "closeAfterReceipt":
        if (each.event === "closeAfterReceipt") {
          assert.equal(result.status, "fulfilled");
          closeConnection(connection.context, connection.sessions);
        }
        assert.deepEqual(retained(connection), [], "the closed connection holds nothing");
        // Work completing late found it closed; nothing is admitted any more.
        assert.equal(
          (await settled(connection, connection.request("prepare", PLAN_REQUEST))).status,
          "rejected",
        );
        assert.deepEqual(retained(connection), []);
        break;
    }
  });

test("the host allocation cases are every obligation declared for each class, and no other", () => {
  const owed = Object.entries(OBLIGATIONS).flatMap(([allocation, events]) =>
    events.map((event) => ({ allocation, event })),
  );
  assert.deepEqual(coverageGaps(owed, familyCases(), { tuples: true }), []);
});

test("closing twice, and closing with an undo that throws, leaves nothing; the client's loss still completes", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const connection = assembled();
  await withControls(connection);
  assert.ok(retained(connection).length > 0);
  // An allocation of a delivery still open, whose undo throws.
  const open = connection.context.delivery.begin();
  connection.context.delivery.own(open, () => {
    throw new Error("injected: the undo fails");
  });
  const pending = connection.request("readTransfer", { text: TRANSFER_TEXT });
  connection.lose();
  const result = await settled(connection, pending);
  assert.equal(result.status, "rejected", "the pending request was rejected");
  assert.equal(connection.losses(), 1, "the loss listener ran");
  assert.deepEqual(retained(connection), [], "everything committed was released all the same");
  assert.equal(errors.mock.callCount(), 1, "the failed undo was reported once");
  closeConnection(connection.context, connection.sessions);
  assert.deepEqual(retained(connection), []);
  assert.equal(errors.mock.callCount(), 1, "a second close undoes nothing more");
});

test("a committed slot's waiting task, run under another delivery that then fails, stays the slot's", async () => {
  const ops = playerOpsContext();
  const run = playerBridgeOps(ops);
  const sessions: HostSessions = {
    get: () => undefined,
    add: () => "none",
    delete: () => {},
    clear: () => {},
  };
  const inDelivery = async (op: string, args: unknown) => {
    const delivery = ops.delivery.begin();
    await run[op]!.run(args, sessions, null);
    ops.delivery.commit(delivery);
  };
  await inDelivery("prepare", PLAN_REQUEST);
  await inDelivery("preparePlanText", { plan: "p1" });
  const slot = ops.planTexts.get("p1")!;
  assert.equal(slot.json, null, "its task waits");
  const other = ops.delivery.begin();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(slot.json, null, "its task ran meanwhile");
  ops.delivery.rollback(other);
  assert.equal(ops.planTexts.get("p1"), slot, "the slot stays, with what its task wrote");
});

// ---------------------------------------------------------------------------------------------------------------------
// The real in-process backend: its termination closes the connection, and the facade has deliveries of its own.

test("terminating the in-process backend's client closes its connection: plans and sessions are gone, and stay so", async () => {
  const bridge = createInProcessBackend(BUILD);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: PLAN_JSON },
  });
  // EVIDENCE: fixture: `prepare` of this plan prepares.
  const plan = (reply.result as { plan: string }).plan;
  const session = introduceNow(bridge, () => createPlayerRuntimeSession(PLAN), NO_MARKS);
  assert.equal(heldPlan(bridge, plan), heldPlan(bridge, plan));
  bridge.client.terminate();
  assert.throws(() => heldPlan(bridge, plan), /No plan 'p1' is held/);
  assert.throws(() => hatch(session, (held) => held), /The host holds no such session/);
  // A facade call after the close is refused before it allocates.
  assert.throws(
    () => introduceNow(bridge, () => createPlayerRuntimeSession(PLAN), NO_MARKS),
    DeliveryRefusedError,
  );
});

/**
 * The facade's delivery and a request's, nested both ways: the request pending when the facade runs, or begun by the
 * facade's own factory (the in-process client posts at once, so the host opens its delivery inside the facade's).
 */
const SCOPE_AXES = {
  order: ["requestThenFacade", "facadeThenRequest"],
  request: ["fails", "succeeds"],
} as const;

for (const each of product(SCOPE_AXES))
  test(`a facade call and a request, nested: ${each.order}, the request ${each.request}`, async () => {
    const bridge = createInProcessBackend(BUILD);
    // Valid JSON that is no transfer fails after the read's first await; a transfer is read.
    const text = each.request === "fails" ? "{}" : TRANSFER_TEXT;
    let pending: Promise<BridgeResult> | null = null;
    if (each.order === "requestThenFacade")
      pending = bridge.client.request("readTransfer", { text });
    const session = introduceNow(
      bridge,
      () => {
        if (each.order === "facadeThenRequest")
          pending = bridge.client.request("readTransfer", { text });
        return createPlayerRuntimeSession(PLAN);
      },
      NO_MARKS,
    );
    const settledRequest = await Promise.allSettled([pending!]);
    assert.equal(settledRequest[0]!.status, each.request === "fails" ? "rejected" : "fulfilled");
    assert.ok(
      hatch(session, (held) => held.plan),
      "the facade's session stays",
    );
    assert.ok(heldPlan(bridge, session.planToken), "and its plan");
  });

test("the facade nesting cases are every coordinate of their declaration", () => {
  const owed = [
    { order: "requestThenFacade", request: "fails" },
    { order: "requestThenFacade", request: "succeeds" },
    { order: "facadeThenRequest", request: "fails" },
    { order: "facadeThenRequest", request: "succeeds" },
  ];
  assert.deepEqual(coverageGaps(owed, product(SCOPE_AXES), { tuples: true }), []);
});

test("a facade call whose handoff fails undoes what it allocated, and keeps what existed before", async () => {
  const bridge = createInProcessBackend(BUILD);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: PLAN_JSON },
  });
  // EVIDENCE: fixture: `prepare` of this plan prepares.
  const before = (reply.result as { plan: string }).plan;
  const open = bridge.open.bind(bridge);
  bridge.open = () => {
    throw new Error("injected: the handoff fails");
  };
  const other = compilePlayerProject('say "other"\nexit').plan!;
  assert.throws(
    () => introduceNow(bridge, () => createPlayerRuntimeSession(other), NO_MARKS),
    /handoff fails/,
  );
  bridge.open = open;
  assert.ok(heldPlan(bridge, before), "the plan held before stays");
  assert.throws(() => heldPlan(bridge, "p2"), /No plan 'p2' is held/);
  // The session it added, `s1`, is gone: the host refuses to release a session it does not hold.
  await assert.rejects(
    bridge.client.request("release", null, { session: "s1" }),
    (error: unknown) =>
      error instanceof BridgeRequestError && error.kind === "bridge" && error.code === "session",
  );
});
