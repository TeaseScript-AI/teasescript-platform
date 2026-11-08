import {
  openBridge,
  type BridgeResult,
  type ClientPort,
} from "../../player/engine-bridge/client.js";
import {
  closeConnection,
  playerBridgeOps,
  playerOpsContext,
} from "../../player/engine-bridge/player-ops.js";
import { decodeMessage } from "../../player/engine-bridge/transport.js";
import {
  type BridgeOp,
  type HostPort,
  type HostSessions,
  type OpOutcome,
  startBridgeHost,
} from "../../player/engine-bridge/worker-host.js";
import { compilePlayerProject, createPlayerRuntimeSession } from "../../player/compile-project.js";
import { createPlayerRuntimeRestorePoint } from "../../player/runtime-adapter.js";
import { sessionTransferText } from "../../player/session-transfer.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { childCases, markerOf, reach, snapshotForRetention } from "./retention-child.js";
import { markedProject, planText } from "./source-ops-project.js";

/*
 * The retention child of the delivery invariant (`player-bridge-delivery-retention.test.ts`; see
 * `retention-witness.ts`). Each case (`moment/class`) runs the real op of one allocation class, with its own marked
 * project or transfer, on a connection assembled from the production client, host and Player ops:
 * - `committed`: the op's reply is posted, and the connection stays open: its allocation is the connection's;
 * - `aborted`: on the same connection, the op's success post fails, so its delivery aborts;
 * - `closed`: on a connection of its own, the op commits, then the client ends, which closes the connection.
 * A test-side wrapper of the op takes weak references to what the op added, before its reply goes. The parent scans the
 * snapshot for each case's marker; this reports how many of the weak references still hold.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };

/** The classes `own` registers, each through the op that allocates it. */
const OPS = {
  plan: "prepare",
  sources: "prepare",
  session: "start",
  transfer: "readTransfer",
  slot: "preparePlanText",
  cache: "drawCode",
} as const;
type AllocationClass = keyof typeof OPS;
const CLASSES: readonly AllocationClass[] = [
  "plan",
  "sources",
  "session",
  "transfer",
  "slot",
  "cache",
];

interface Connection {
  request(op: string, args: unknown): Promise<BridgeResult>;
  /** Makes the next success post of `op` fail. */
  failPost(op: string): void;
  /** Weak references to what the next run of `op` adds, once it ran. */
  watch(op: string): Promise<readonly WeakRef<WeakKey>[]>;
  terminate(): void;
}

function connection(): Connection {
  const context = playerOpsContext();
  const opOf = new Map<number, string>();
  let failing: string | null = null;
  let watching: { op: string; done: (refs: readonly WeakRef<WeakKey>[]) => void } | null = null;
  let toHost: ((data: unknown) => void) | null = null;
  let toClient: ((data: unknown) => void) | null = null;
  // The host's sessions, once it started; the wrapper reads a new one through them.
  let sessions: HostSessions | null = null;
  const hostPort: HostPort = {
    post: (message) => {
      const data = decodeMessage(structuredClone(message));
      // EVIDENCE: fixture: this port carries only the messages the host posts, each with these fields where it has them.
      const reply = data as { kind?: string; id?: number; ok?: boolean };
      if (reply.kind === "reply" && reply.ok === true && opOf.get(reply.id!) === failing) {
        failing = null;
        throw new Error("injected: the success post fails");
      }
      queueMicrotask(() => toClient?.(data));
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
    onFailure: () => {},
    terminate: () => {
      toHost = null;
      toClient = null;
      closeConnection(context, sessions!);
    },
  };
  const ops = playerBridgeOps(context);
  const wrapped = Object.fromEntries(
    Object.entries(ops).map(([name, op]) => [
      name,
      {
        ...op,
        run: async (...args: Parameters<BridgeOp["run"]>): Promise<OpOutcome> => {
          const watch = watching?.op === name ? watching : null;
          if (watch === null) return op.run(...args);
          watching = null;
          const before = reach(context);
          const outcome = await op.run(...args);
          const added = [...reach(context)].filter((value) => !before.has(value));
          // A new session's whole payload: the held session, and the publication behind its private fields.
          const created =
            outcome.session === undefined ? undefined : sessions!.get(outcome.session);
          const publication =
            created !== undefined &&
            "publication" in created &&
            typeof created.publication === "object" &&
            created.publication !== null
              ? [created.publication]
              : [];
          const payload = created === undefined ? [] : [created, ...publication];
          // A new slot's waiting task is its payload too.
          const timers = added.flatMap((value) =>
            typeof value === "object" &&
            "timer" in value &&
            typeof value.timer === "object" &&
            value.timer !== null
              ? [value.timer]
              : [],
          );
          watch.done([...added, ...payload, ...timers].map((value) => new WeakRef(value)));
          return outcome;
        },
      } satisfies BridgeOp,
    ]),
  );
  const { client } = openBridge(clientPort, BUILD);
  sessions = startBridgeHost(hostPort, wrapped, BUILD, context.delivery);
  return {
    request: (op, args) => client.request(op, args),
    failPost: (op) => void (failing = op),
    watch: (op) => new Promise((done) => (watching = { op, done })),
    terminate: () => client.terminate(),
  };
}

/** A session transfer whose names and saved value carry `marker`. */
function markedTransfer(marker: string): Promise<string> {
  const plan = compilePlayerProject(markedProject(marker)).plan!;
  return sessionTransferText(
    {
      scope: `development-package:${marker}`,
      name: `Delivery ${marker}`,
      session: createPlayerRuntimeRestorePoint(createPlayerRuntimeSession(plan)),
      entries: [{ key: `key_${marker}`, value: `value ${marker}` }],
      media: [],
    },
    false,
  );
}

/** Runs `allocation`'s op on `link` for `marker`: its prerequisites first, committed, then the op itself. */
/**
 * Runs `allocation`'s op on `link`: its prerequisite plan first, committed, marked with `planMarker`, then the op itself,
 * whose own input carries `marker` where one can (a plan, sources, a transfer, a session's saved data).
 */
async function allocate(
  link: Connection,
  allocation: AllocationClass,
  marker: string,
  planMarker: string,
  fail: boolean,
): Promise<readonly WeakRef<WeakKey>[]> {
  const prepared = async (source: unknown) => {
    // EVIDENCE: fixture: `prepare` of a marked project or its plan prepares.
    return ((await link.request("prepare", { source })).result as { plan: string }).plan;
  };
  const argsOf = async (): Promise<Readonly<Record<string, unknown>>> => {
    switch (allocation) {
      case "plan":
        return { source: { kind: "plan", text: planText(markedProject(marker)) } };
      case "sources":
        return { source: { kind: "source", script: markedProject(marker) } };
      case "session":
        return {
          plan: await prepared({ kind: "plan", text: planText(markedProject(planMarker)) }),
          // The session's own marker, in its saved data, which its state and publication hold.
          options: {
            ...START,
            scriptStorage: [{ key: `key_${marker}`, value: `value ${marker}` }],
          },
          recording: false,
        };
      case "transfer":
        return { text: await markedTransfer(marker) };
      case "slot":
        return {
          plan: await prepared({ kind: "plan", text: planText(markedProject(planMarker)) }),
        };
      case "cache": {
        const plan = await prepared({ kind: "source", script: markedProject(planMarker) });
        const metadata = await link.request("planMetadata", { plan });
        // EVIDENCE: fixture: `planMetadata` of a held plan gives its random sites, and the project has two.
        const site = (metadata.result as { randomSites: readonly { path: string }[] })
          .randomSites[0]!;
        return { plan, path: site.path, site };
      }
    }
  };
  const args = await argsOf();
  const op = OPS[allocation];
  const watched = link.watch(op);
  if (fail) link.failPost(op);
  await link.request(op, args).catch(() => {});
  return watched;
}

/** Every case of the child, grouped by class; returns, per case, how many of its weak references still hold. */
async function runCases() {
  const cases = childCases();
  const seedOf = (name: string) => cases.find((each) => each.name === name)?.seed;
  const results: { name: string; refs: readonly WeakRef<WeakKey>[] }[] = [];
  for (const allocation of CLASSES) {
    const open = connection();
    connections.push(open);
    // A case's prerequisite plan has a marker of its own (`…/plan`), or the case's when it has none.
    const markers = (name: string) => {
      const seed = seedOf(name);
      const plan = seedOf(`${name}/plan`) ?? seed;
      return seed === undefined ? null : ([markerOf(seed), markerOf(plan!)] as const);
    };
    for (const moment of ["committed", "aborted"] as const) {
      const marked = markers(`${moment}/${allocation}`);
      if (marked === null) continue;
      const refs = await allocate(open, allocation, ...marked, moment === "aborted");
      results.push({ name: `${moment}/${allocation}`, refs });
    }
    const marked = markers(`closed/${allocation}`);
    if (marked === null) continue;
    const closing = connection();
    connections.push(closing);
    const refs = await allocate(closing, allocation, ...marked, false);
    closing.terminate();
    results.push({ name: `closed/${allocation}`, refs });
  }
  return results;
}

// Every connection until the snapshot: what they still hold counts as held.
const connections: Connection[] = [];
const results = await runCases();
const snapshot = await snapshotForRetention();
const report = results.map(({ name, refs }) => ({
  name,
  refs: refs.length,
  held: refs.filter((ref) => ref.deref() !== undefined).length,
}));
process.stdout.write(JSON.stringify({ report, snapshot }));
