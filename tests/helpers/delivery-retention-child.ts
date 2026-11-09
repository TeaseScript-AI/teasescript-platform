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
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import type { HistoryTimeline } from "../../player/engine-bridge/history/core.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { playerRuntimeForeground } from "../../player/runtime/runtime-view.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import { createPlayerRuntimeRestorePoint } from "../../player/runtime/runtime-adapter.js";
import { sessionTransferText } from "../../player/persistence/session-transfer.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { childCases, markerOf, reach, snapshotForRetention } from "./retention-child.js";
import { markedProject, planText } from "./bridge/source-ops-project.js";

/*
 * The retention child of the delivery invariant (`player-bridge-delivery-retention.test.ts`; see
 * `retention-witness.ts`). Each case (`moment/class`) runs the real op of one allocation class, with its own marked
 * project or transfer, on a connection assembled from the production client, host and Player ops:
 * - `committed`: the op's reply is posted, and the connection stays open: its allocation is the connection's;
 * - `aborted`: on the same connection, the op's success post fails, so its delivery aborts;
 * - `closed`: on a connection of its own, the op commits, then the client ends, which closes the connection.
 * A rewind history (`historyOpen`) and a step's candidate (`rewindBack`, its prepared Back) are classes too: the
 * candidate's own marker is in the events its Back gives, which only the candidate keeps.
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
  history: "historyOpen",
  candidate: "rewindBack",
  point: "submitComposer",
} as const;
type AllocationClass = keyof typeof OPS;
const CLASSES: readonly AllocationClass[] = [
  "plan",
  "sources",
  "session",
  "transfer",
  "slot",
  "cache",
  "history",
  "candidate",
  "point",
];

interface Connection {
  /** Sends `op`, on host session `session` when one is given, with no basis. */
  request(op: string, args: unknown, session?: string): Promise<BridgeResult>;
  /** The Player's bridge over the same client, for a session's own requests. */
  readonly bridge: PlayerBridge;
  /** Makes the next success post of `op` fail. */
  failPost(op: string): void;
  /** Weak references to what the next run of `op` adds, once it ran. */
  watch(op: string): Promise<readonly WeakRef<WeakKey>[]>;
  terminate(): void;
  /** The connection's ops context, for the classes the registry keeps behind its entries. */
  readonly context: ReturnType<typeof playerOpsContext>;
  /** Lets go of plan `token`'s compiled sources, as a release does, keeping the plan. */
  retireSources(token: string): void;
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
          const pointsBefore = new Set(context.history.core(lastIntent)?.timeline().points ?? []);
          const outcome = await op.run(...args);
          const added = [...reach(context)].filter((value) => !before.has(value));
          // A new session's whole payload: the held session,
          const created =
            outcome.session === undefined ? undefined : sessions!.get(outcome.session);
          // and every object of its publication's public graph the op added (a second net beside the session's marker).
          const publication =
            created !== undefined &&
            "publication" in created &&
            typeof created.publication === "object" &&
            created.publication !== null
              ? [...reach(created.publication)].filter(
                  (value) => !before.has(value) && !shared.has(value),
                )
              : [];
          const payload = created === undefined ? [] : [created, ...publication];
          // A history's whole payload the op made: its entry and all it reaches, but what every history holds.
          const entry =
            name === "historyOpen" ? context.history.entries.get(lastIntent) : undefined;
          if (entry !== undefined)
            payload.push(
              ...[...reach(entry)].filter(
                (value) => !before.has(value) && !historyShared.has(value),
              ),
            );
          // A publishing op's point, which its history keeps behind its core.
          if (name === "submitComposer") {
            const points = context.history.core(lastIntent)?.timeline().points ?? [];
            payload.push(...points.filter((point) => !pointsBefore.has(point)));
          }
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
    request: (op, args, session) =>
      client.request(op, args, session === undefined ? {} : { session }),
    bridge: new PlayerBridge(client),
    context,
    failPost: (op) => void (failing = op),
    watch: (op) => new Promise((done) => (watching = { op, done })),
    terminate: () => client.terminate(),
    retireSources: (token) => void context.sources.delete(token),
  };
}

/**
 * A session's plan, marked with `planMarker`, that loads its saved value and says it, so the session's own marker (the
 * saved value's) sits in its engine state, its transcript and its events. Its publication's state view does not carry
 * it; weak references to its original public graph cover that view.
 */
function sessionProject(planMarker: string) {
  return {
    files: [
      {
        path: "main.tease",
        source: [
          `// ${planMarker}`,
          `let plan_${planMarker} = 1`,
          'let probe = load "probe", default: ""',
          'say "${probe}", instant',
          `showButton "Done ${planMarker}"`,
          "exit",
        ].join("\n"),
      },
    ],
  };
}

/**
 * A plan for the source-view caches: its code carries `planMarker`, and only its comments carry `marker`, which the
 * plan does not keep, but its sources and the caches made from them do.
 */
function cacheProject(planMarker: string, marker: string) {
  return {
    files: [
      {
        path: "main.tease",
        source: [
          `let hit_${planMarker} = chance(50) // ${marker}`,
          `showButton "Done ${planMarker}" // ${marker}`,
          `exit // ${marker}`,
        ].join("\n"),
      },
    ],
  };
}

/** A session whose plan carries `planMarker` and whose first interaction is a choice: answered, it gives a second point. */
function candidateProject(planMarker: string) {
  return {
    files: [
      {
        path: "main.tease",
        source: [
          `// ${planMarker}`,
          'say "before", instant',
          `let pick = askChoice "One ${planMarker}", "Two"`,
          'say "after ${pick}", instant',
          `showButton "Done ${planMarker}"`,
          "exit",
        ].join("\n"),
      },
    ],
  };
}

/**
 * A session that asks a text first, then a choice: answered with a marked text, its next point's state, and so its
 * snapshot, keeps the marker, which no earlier point has.
 */
function pointProject(planMarker: string) {
  return {
    files: [
      {
        path: "main.tease",
        source: [
          `// ${planMarker}`,
          'let name = askText "Name?"',
          'say "Hi ${name}", instant',
          `let pick = askChoice "One ${planMarker}", "Two"`,
          "exit",
        ].join("\n"),
      },
    ],
  };
}

/** The history intents the cases open, increasing on every connection. */
let lastIntent = 0;

/**
 * Back's arguments for a candidate of `plan`: a history opened, a session started and answered once, and the events up
 * to its first point, with `marker` in a say's text, so only the candidate restored from them keeps it.
 */
async function backArgs(link: Connection, plan: string, marker: string) {
  const history = ++lastIntent;
  await link.request("historyOpen", { intent: history });
  const session = await link.bridge.start(plan, START, false);
  const shown = link.bridge.latest(session)!;
  const foreground = playerRuntimeForeground(shown);
  if (foreground?.kind !== "choose") throw new Error("The candidate's session asks no choice.");
  await link.bridge.request(session, "selectChoice", {
    actionId: shown.state.foregroundAction!.actionId,
    optionId: foreground.options[0]!.id,
    input: null,
  });
  // EVIDENCE: fixture: `historyTimeline` of an open history gives its timeline.
  const timeline = (await link.request("historyTimeline", { history })).result as HistoryTimeline;
  const point = timeline.points[0]!;
  const events: InterpreterEvent[] = link.bridge
    .latest(session)!
    .events.slice(0, point.eventCount)
    .map((event) => (event.kind === "say" ? { ...event, text: `${event.text} ${marker}` } : event));
  if (!events.some((event) => event.kind === "say")) throw new Error("No say carries the marker.");
  return { history, point: point.id, live: session.id, events };
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
          plan: await prepared({ kind: "source", script: sessionProject(planMarker) }),
          // The session's own marker, in the saved value its script loads and says.
          options: { ...START, scriptStorage: [{ key: "probe", value: `value ${marker}` }] },
          recording: false,
        };
      case "transfer":
        return { text: await markedTransfer(marker) };
      case "slot":
        return {
          plan: await prepared({ kind: "plan", text: planText(markedProject(planMarker)) }),
        };
      case "cache": {
        const plan = await prepared({ kind: "source", script: cacheProject(planMarker, marker) });
        cachePlan = plan;
        const metadata = await link.request("planMetadata", { plan });
        // EVIDENCE: fixture: `planMetadata` of a held plan gives its random sites.
        const site = (metadata.result as { randomSites: readonly { path: string }[] })
          .randomSites[0]!;
        return { plan, path: site.path, site };
      }
      case "history":
        return { intent: ++lastIntent };
      case "candidate":
        return backArgs(
          link,
          await prepared({ kind: "source", script: candidateProject(planMarker) }),
          marker,
        );
      case "point": {
        // A followed session at its text, whose answer carries the marker.
        const plan = await prepared({ kind: "source", script: pointProject(planMarker) });
        await link.request("historyOpen", { intent: ++lastIntent });
        const session = await link.bridge.start(plan, START, false);
        pointSession = session.id;
        return {
          actionId: link.bridge.latest(session)!.state.foregroundAction!.actionId,
          text: `name ${marker}`,
          input: null,
        };
      }
    }
  };
  let pointSession: string | undefined;
  let cachePlan: string | null = null;
  const args = await argsOf();
  const op = OPS[allocation];
  const watched = link.watch(op);
  if (fail) link.failPost(op);
  await link.request(op, args, allocation === "point" ? pointSession : undefined).catch(() => {});
  // The caches' only other holder of their marker, the plan's sources, goes once they were made; the plan stays.
  if (cachePlan !== null) link.retireSources(cachePlan);
  return watched;
}

/**
 * What every session's publication reaches whatever it ran (the engine's module constants, such as its default
 * speakers): found from a publication of an unmarked session, so the publication net counts only what a case's own
 * session added.
 */
const shared = new Set<WeakKey>();

async function sharedReach(): Promise<void> {
  const link = connection();
  connections.push(link);
  const watched = link.watch("start");
  // EVIDENCE: fixture: `prepare` of this project prepares.
  const prepared = (
    await link.request("prepare", { source: { kind: "source", script: sessionProject("shared") } })
  ).result as { plan: string };
  await link.request("start", { plan: prepared.plan, options: START, recording: false });
  for (const ref of await watched) {
    const value = ref.deref();
    if (value !== undefined) shared.add(value);
  }
}

/** What every history holds whatever it ran (its spill factory, its connection's): from an unmarked warm-up history. */
const historyShared = new Set<WeakKey>();

async function historySharedReach(): Promise<void> {
  const link = connection();
  connections.push(link);
  const intent = ++lastIntent;
  await link.request("historyOpen", { intent });
  const entry = link.context.history.entries.get(intent)!;
  for (const value of reach(entry))
    if (value !== entry && value !== entry.core) historyShared.add(value);
}

/** What the control keeps, outside anything the connection owns. */
const kept: (() => WeakKey)[] = [];

/**
 * The negative control in #2006's style (`control/history`): a history's open whose reply fails, with its core kept
 * in a module closure afterwards; its weak references must then be found held.
 */
async function historyControl(): Promise<readonly WeakRef<WeakKey>[]> {
  const link = connection();
  connections.push(link);
  const watched = link.watch("historyOpen");
  const intent = ++lastIntent;
  link.failPost("historyOpen");
  await link.request("historyOpen", { intent }).catch(() => {});
  const refs = await watched;
  // The open's core, which its delivery undid: kept by a closure the connection does not own.
  const undone = refs
    .map((ref) => ref.deref())
    .find((value) => typeof value === "object" && "pendingStep" in value);
  if (undone === undefined) throw new Error("The control's core was not among its references.");
  kept.push(() => undone);
  return refs;
}

/** Every case of the child, grouped by class; returns, per case, how many of its weak references still hold. */
async function runCases() {
  await sharedReach();
  await historySharedReach();
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
      // A history's open replaces the connection's earlier history, the committed case's: its abort runs on its own.
      let link = open;
      if (moment === "aborted" && ["history", "candidate", "point"].includes(allocation)) {
        link = connection();
        connections.push(link);
      }
      const refs = await allocate(link, allocation, ...marked, moment === "aborted");
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
  if (seedOf("control/history") !== undefined)
    results.push({ name: "control/history", refs: await historyControl() });
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
