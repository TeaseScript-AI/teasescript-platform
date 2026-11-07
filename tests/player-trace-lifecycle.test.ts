import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { effectScope, watch, type Ref } from "vue";

import type * as Client from "../player/engine-bridge/client.js";
import type * as CompileProject from "../player/compile-project.js";
import type * as InProcess from "../player/engine-bridge/in-process.js";
import type { DebugView, DebugViewRequest } from "../player/debug-view.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import type {
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { PlayerSession } from "../player/runtime-view.js";
import type { RuntimeDebugContext } from "../src/runtime/debug/debug-trace.js";
import { coverageGaps, product, type Coordinates } from "./helpers/family-coverage.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

/*
 * L5i.3, the trace-ordering family (Sol r1 R2, r2 R2.1, r3 R2.2, r4 R2.3) over the Player's lifetime. The connection's
 * value trace follows the newest tracing intent a live Player sent; a setting made before the host is reachable waits
 * as the Player's, and only its latest goes, once the host is reachable and while the Player lives. One live Player per
 * bridge; a later one reuses it. The host's side of the rule, every carrier in every delivery order, is
 * `player-trace-intent.test.ts`'s.
 */

interface TracingPlayer {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly debugTracing: Readonly<Ref<boolean>>;
  readonly traceId: Readonly<Ref<number | null>>;
  prepare(create: (recording: PlayerRuntimeSessionOptions) => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  setDebugTracing(on: boolean): void;
  debugView(request: DebugViewRequest): Promise<DebugView | null>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
}) => TracingPlayer;
let facade: typeof InProcess;
let compiler: typeof CompileProject;
let BridgeLostError: typeof Client.BridgeLostError;

const restore: (() => void)[] = [];
before(async () => {
  const module = await loadPlayerModule("player/vue/src/usePlayerSession.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: the bundle the composable runs in, whose facade reaches its host.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/compile-project.ts")) as typeof compiler;
  const client = await loadPlayerModule("player/engine-bridge/client.ts");
  // EVIDENCE: validation: the bundle's client module, whose loss error the client's listeners receive.
  BridgeLostError = client.BridgeLostError as typeof BridgeLostError;
  // A browser surface with event targets and silent audio.
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(surface)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
after(() => {
  for (const undo of restore) undo();
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
// A declaration, an interpolated message and an input: the source the trace records from its first statement.
const SCRIPT = 'let mood = "calm"\nsay "${mood} now", instant\nlet answer = askText "Ready?"\nexit';
const OBSOLETE = 'say "obsolete", instant\nlet answer = askText "Old?"\nexit';
const RECENT: DebugViewRequest = {
  messages: { limit: 20, openNewest: false },
  selected: null,
  variables: null,
  image: false,
  trees: {},
};
const ONE_PLAYER = /One live Player per engine bridge/u;

// The family's axes, declared once.
/** The Player before this one on the same connection: its tracing changes; it ends at once after the last. */
const HISTORIES = {
  fresh: [],
  "ended on": [true],
  "ended off": [true, false],
  "ended on-off-on": [true, false, true],
} as const;
const HISTORY_NAMES = ["fresh", "ended on", "ended off", "ended on-off-on"] as const;
/** This Player's tracing changes; a Start goes before the change at its place, or after the last. */
const SEQUENCES = {
  untouched: [],
  on: [true],
  "on-off": [true, false],
  "on-off-on": [true, false, true],
} as const;
const SEQUENCE_NAMES = ["untouched", "on", "on-off", "on-off-on"] as const;
/**
 * The Player's lifetime around its changes and Start. `waiting`: its bridge becomes ready after them; `ready` and
 * `issued`: before them, with the connection's queue held by a compile. `dispose`: it ends before its bridge is ready;
 * `handover`: it ends, and a next Player on the bridge asks the opposite and starts; `replaced`: a second Start
 * replaces the first.
 */
const LIFECYCLES = [
  "ready/live",
  "waiting/live",
  "waiting/dispose",
  "waiting/handover",
  "waiting/replaced",
  "issued/replaced",
  "issued/handover",
] as const;
type History = (typeof HISTORY_NAMES)[number];
type Sequence = (typeof SEQUENCE_NAMES)[number];
type Lifecycle = (typeof LIFECYCLES)[number];
interface Case {
  readonly history: History;
  readonly sequence: Sequence;
  readonly start: number;
  readonly lifecycle: Lifecycle;
  readonly name: string;
}

const places = (sequence: Sequence) => [...Array(SEQUENCES[sequence].length + 1).keys()];
const CASES: readonly Case[] = HISTORY_NAMES.flatMap((history) =>
  SEQUENCE_NAMES.flatMap((sequence) =>
    places(sequence).flatMap((start) =>
      LIFECYCLES.map((lifecycle) => ({
        history,
        sequence,
        start,
        lifecycle,
        name: `${history}; ${sequence}, Start at ${start}; ${lifecycle}`,
      })),
    ),
  ),
);
/** The cases each sibling of the family was found by, as the family names them. */
const WITNESSES: Readonly<Record<string, string>> = {
  "fresh; on, Start at 1; ready/live": "R2",
  "fresh; on-off-on, Start at 3; ready/live": "R2.1",
  "ended on-off-on; on, Start at 1; ready/live": "R2.2",
  "fresh; on, Start at 0; waiting/dispose": "R2.3",
  "ended off; on-off-on, Start at 3; waiting/handover": "R2.3",
};

const coordinates = (each: Case): Coordinates => ({
  history: each.history,
  sequence: each.sequence,
  start: String(each.start),
  lifecycle: each.lifecycle,
});
/** The feasible cases, enumerated apart from `CASES`: a Start's place is at most the sequence's length. */
const FEASIBLE = product({
  history: [...HISTORY_NAMES],
  sequence: [...SEQUENCE_NAMES],
  start: ["0", "1", "2", "3"],
  lifecycle: [...LIFECYCLES],
}).filter((tuple) => {
  // EVIDENCE: invariant: `product` takes each `sequence` from `SEQUENCE_NAMES`.
  const sequence = tuple.sequence as Sequence;
  return Number(tuple.start) <= SEQUENCES[sequence].length;
});

test("the lifecycle cases are each feasible case once, named by their axes", () => {
  assert.equal(new Set(CASES.map((each) => each.name)).size, CASES.length, "names are unique");
  const observed = CASES.map(coordinates);
  assert.deepEqual(coverageGaps(FEASIBLE, observed, { tuples: true }), []);
  assert.equal(CASES.length, 4 * (1 + 2 + 3 + 4) * 7);
  for (const name of Object.keys(WITNESSES))
    assert.ok(
      CASES.some((each) => each.name === name),
      `the witness ${name} is a case`,
    );
  // The check fails a family that lacks a slice of history × lifecycle.
  const lacking = observed.filter(
    (tuple) => !(tuple.history === "ended on" && tuple.lifecycle === "waiting/dispose"),
  );
  assert.ok(coverageGaps(FEASIBLE, lacking).some((gap) => gap.startsWith("missing pair")));
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Settles the connection: its queue holds nothing before a request sent now, and the replies' continuations ran. */
async function settle(bridge: PlayerBridge) {
  await bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
  await turn();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Each test's Players' names of a trace given while their Debug was off: a reply of an older change names none.
const staleNames = new WeakMap<TestContext, number[]>();

/** A Player on `bridge`, unmounted at the test's end at the latest. */
function mounted(context: TestContext, bridge: Promise<PlayerBridge>) {
  const scope = effectScope();
  const player = scope.run(() => {
    const made = usePlayerSession({ bridge, debugHistorySpill: async () => null });
    const named = staleNames.get(context) ?? [];
    staleNames.set(context, named);
    watch(
      () => made.traceId.value,
      (id) => {
        if (id !== null && !made.debugTracing.value) named.push(id);
      },
      { flush: "sync" },
    );
    return made;
  })!;
  context.after(() => scope.stop());
  return { player, end: () => scope.stop() };
}

/** No Player of the test named a trace while its Debug was off. */
const namedNoStaleTrace = (context: TestContext, name: string) =>
  assert.deepEqual(staleNames.get(context) ?? [], [], `${name}: no older reply names a trace`);

/** A host whose replies take a millisecond, with the count of the tracing serials minted on it. */
function backend(context: TestContext) {
  const bridge = facade.createInProcessBackend(BUILD, { delayMs: 1 });
  context.after(() => bridge.client.terminate());
  const minted = context.mock.method(bridge, "nextTracingIntent");
  return { bridge, minted: () => minted.mock.callCount() };
}

/** The Player before this one on the connection, as `history` says: its changes reach the host, then it ends. */
async function lived(context: TestContext, bridge: PlayerBridge, history: History) {
  const changes = HISTORIES[history];
  if (changes.length === 0) return;
  const { player, end } = mounted(context, Promise.resolve(bridge));
  await player.bridge;
  for (const on of changes) player.setDebugTracing(on);
  await settle(bridge);
  end();
}

/** The Starts a test's factories began, in order: their script, and the trace each began with. */
type Starts = { readonly script: string; readonly trace: RuntimeDebugContext | null }[];
const starting =
  (starts: Starts, script: string) =>
  (recording: PlayerRuntimeSessionOptions): PlayerRuntimeSession => {
    starts.push({ script, trace: recording.debugTrace ?? null });
    return compiler.createPlayerRuntimeSession(script, { ...recording, wallClockMs: 0 });
  };

/**
 * The oracle, once settled: the host traces as its live Player (`owner`, `null` for none) last asked, the Player names
 * the host's trace, it shows its own Start only, and a Start that began with the trace that stays keeps its history.
 */
async function holds(
  name: string,
  bridge: PlayerBridge,
  owner: { readonly player: TracingPlayer; readonly asked: boolean } | null,
  kept: RuntimeDebugContext | null,
) {
  const want = owner?.asked ?? false;
  const trace = facade.heldTrace(bridge);
  assert.equal(trace !== null, want, `${name}: the host traces as its live Player asked last`);
  if (owner === null) return;
  const { player } = owner;
  assert.equal(player.debugTracing.value, want, `${name}: the Player shows what it asked`);
  const view = await player.debugView(RECENT);
  assert.equal(
    player.traceId.value,
    want ? view!.traceId : null,
    `${name}: names the host's trace`,
  );
  const shown = player.session.value!.transcriptEntries.map((entry) => entry.text);
  assert.ok(shown.includes("calm now"), `${name}: its Start shows`);
  assert.ok(!shown.includes("obsolete"), `${name}: a replaced Start shows nothing`);
  if (want && kept !== null) {
    assert.equal(trace, kept, `${name}: the trace its Start began with stays`);
    const status = trace!.status();
    assert.equal(status.origin, "start", name);
    assert.ok(status.records >= 2, `${name}: ${status.records} records`);
    assert.ok((view!.messages?.count ?? 0) >= 1, `${name}: recent chat holds the Start's message`);
  }
}

/** Plays one case, and checks every Start's trace as it began, and the oracle once settled. */
async function play(context: TestContext, each: Case) {
  const { bridge, minted } = backend(context);
  await lived(context, bridge, each.history);
  const { lifecycle } = each;
  const waiting = lifecycle.startsWith("waiting");
  const handover = lifecycle.endsWith("handover");
  const replaced = lifecycle.endsWith("replaced");
  const changes = SEQUENCES[each.sequence];
  const asked = changes.at(-1) ?? false;
  const gate = deferred<PlayerBridge>();
  const current = mounted(context, waiting ? gate.promise : Promise.resolve(bridge));
  const holding = waiting
    ? null
    : current.player.bridge.then(() =>
        bridge.client.request("prepare", { source: { kind: "source", script: "exit" } }),
      );
  if (!waiting) await current.player.bridge;
  // The Starts expected, each with whether it begins traced: as the Player's latest change sent then, while its bridge
  // is ready; else once ready, as its latest change; an ended or replaced Player's waiting Start never begins.
  const starts: Starts = [];
  const expected: { script: string; traced: boolean }[] = [];
  const activations: Promise<void>[] = [];
  const start = (script: string, traced: boolean) => {
    current.player.prepare(starting(starts, script));
    activations.push(current.player.activate());
    if (!waiting) expected.push({ script, traced });
  };
  const first = replaced ? OBSOLETE : SCRIPT;
  changes.forEach((on, index) => {
    if (index === each.start) start(first, changes[index - 1] ?? false);
    current.player.setDebugTracing(on);
  });
  if (each.start === changes.length) start(first, asked);
  if (replaced) start(SCRIPT, asked);
  if (waiting && (lifecycle === "waiting/live" || replaced))
    expected.push({ script: SCRIPT, traced: asked });
  let owner: { readonly player: TracingPlayer; readonly asked: boolean } | null = {
    player: current.player,
    asked,
  };
  if (lifecycle === "waiting/dispose" || handover) {
    current.end();
    owner = null;
  }
  let handedOver: Promise<void> | null = null;
  if (handover) {
    const next = mounted(context, Promise.resolve(bridge));
    await next.player.bridge;
    next.player.setDebugTracing(!asked);
    next.player.prepare(starting(starts, SCRIPT));
    expected.push({ script: SCRIPT, traced: !asked });
    handedOver = next.player.activate();
    activations.push(handedOver);
    owner = { player: next.player, asked: !asked };
  }
  // The Player's bridge becomes ready, after what a next one did has settled.
  let before: { trace: RuntimeDebugContext | null; status: unknown } | null = null;
  const mintedBefore = minted();
  if (waiting) {
    if (handedOver !== null) {
      // The ended Player's Start still waits for its bridge.
      await handedOver;
      await settle(bridge);
      const trace = facade.heldTrace(bridge);
      before = { trace, status: trace?.status() ?? null };
    }
    const ready = minted();
    gate.resolve(bridge);
    await current.player.bridge;
    if (owner?.player === current.player)
      // A bridge no Player traced on needs no setting until one changes.
      assert.equal(
        minted() - ready,
        changes.length > 0 || each.history !== "fresh" ? 1 : 0,
        `${each.name}: only the latest setting goes, once`,
      );
  }
  await Promise.all(activations);
  await holding;
  await settle(bridge);
  if (lifecycle === "waiting/dispose" || lifecycle === "waiting/handover")
    assert.equal(minted(), mintedBefore, `${each.name}: a Player that ended sends nothing`);
  assert.deepEqual(
    starts.map(({ script, trace }) => ({ script, traced: trace !== null })),
    expected,
    `${each.name}: each Start begins with the trace its Player's newest intent says`,
  );
  if (before !== null) {
    const trace = facade.heldTrace(bridge);
    assert.equal(
      trace,
      before.trace,
      `${each.name}: the ended Player's work leaves the next one's trace`,
    );
    assert.deepEqual(trace?.status() ?? null, before.status, each.name);
  }
  // The last Start keeps its trace when no change came after it.
  const last = starts.at(-1);
  const afterChanges = waiting || handover || replaced || each.start === changes.length;
  await holds(each.name, bridge, owner, afterChanges && last !== undefined ? last.trace : null);
  namedNoStaleTrace(context, each.name);
}

for (const each of CASES) {
  const witness = WITNESSES[each.name];
  test(`tracing over the Player's lifetime: ${each.name}${witness === undefined ? "" : ` (${witness})`}`, (context) =>
    play(context, each));
}

// The ends of a connection: a bridge that never became ready, and one lost after it was.
for (const sequence of SEQUENCE_NAMES) {
  test(`tracing on a bridge that never becomes ready: ${sequence}`, async (context) => {
    const gate = deferred<PlayerBridge>();
    const { player } = mounted(context, gate.promise);
    const changes = SEQUENCES[sequence];
    for (const on of changes) player.setDebugTracing(on);
    gate.reject(new Error("No engine host."));
    await assert.rejects(player.bridge, /No engine host/u);
    player.setDebugTracing(!(changes.at(-1) ?? false));
    await turn();
    assert.equal(player.traceId.value, null, sequence);
  });

  test(`tracing on a bridge lost after it was ready: ${sequence}`, async (context) => {
    const { bridge, minted } = backend(context);
    // The client's loss, as a real loss: its listeners hear a `BridgeLostError`.
    const listeners: ((error: Client.BridgeLostError) => void)[] = [];
    bridge.client.onLoss = (listener) => void listeners.push(listener);
    const reports = context.mock.method(console, "error", () => {});
    // A Player that ended before its bridge was ready observes no loss.
    const gate = deferred<PlayerBridge>();
    const ended = mounted(context, gate.promise);
    const { player } = mounted(context, Promise.resolve(bridge));
    await player.bridge;
    ended.end();
    gate.resolve(bridge);
    await ended.player.bridge;
    const changes = SEQUENCES[sequence];
    for (const on of changes) player.setDebugTracing(on);
    await settle(bridge);
    assert.equal(player.traceId.value !== null, changes.at(-1) ?? false, sequence);
    bridge.client.terminate();
    for (const listener of listeners)
      listener(new BridgeLostError("The engine Worker failed: injected."));
    assert.equal(player.traceId.value, null, `${sequence}: the trace went with the host`);
    const sent = minted();
    player.setDebugTracing(!(changes.at(-1) ?? false));
    for (let index = 0; index < 3; index += 1) await turn();
    assert.equal(player.traceId.value, null, `${sequence}: a lost host names no trace`);
    assert.ok(minted() - sent <= 1, `${sequence}: no retry`);
    const hostErrors = reports.mock.calls.filter(
      (call) => call.arguments[0] === "[player] host error",
    );
    assert.equal(hostErrors.length, 1, `${sequence}: only the live Player reports the loss`);
  });
}

// One live Player per bridge: a second one is refused before it sends anything, and a later one reuses the bridge.
for (const history of HISTORY_NAMES)
  for (const sequence of SEQUENCE_NAMES)
    for (const order of ["refused while live", "ready after another"] as const)
      test(`one live Player per bridge: ${history}; ${sequence}; ${order}`, async (context) => {
        const name = `${history}; ${sequence}; ${order}`;
        const { bridge, minted } = backend(context);
        await lived(context, bridge, history);
        const changes = SEQUENCES[sequence];
        const asked = changes.at(-1) ?? false;
        const starts: Starts = [];
        if (order === "refused while live") {
          const live = mounted(context, Promise.resolve(bridge));
          await live.player.bridge;
          for (const on of changes) live.player.setDebugTracing(on);
          live.player.prepare(starting(starts, SCRIPT));
          await live.player.activate();
          await settle(bridge);
          const sent = minted();
          const second = mounted(context, Promise.resolve(bridge));
          await assert.rejects(second.player.bridge, ONE_PLAYER);
          second.player.setDebugTracing(!asked);
          second.end();
          await settle(bridge);
          assert.equal(minted(), sent, `${name}: the refused Player sends nothing`);
          await holds(name, bridge, { player: live.player, asked }, starts.at(-1)!.trace);
          // Once the live Player ended, a next one takes the bridge.
          live.end();
          const next = mounted(context, Promise.resolve(bridge));
          await next.player.bridge;
          await settle(bridge);
          assert.equal(facade.heldTrace(bridge), null, `${name}: the ended Player's trace went`);
        } else {
          const gate = deferred<PlayerBridge>();
          const late = mounted(context, gate.promise);
          for (const on of changes) late.player.setDebugTracing(on);
          const live = mounted(context, Promise.resolve(bridge));
          await live.player.bridge;
          live.player.setDebugTracing(!asked);
          live.player.prepare(starting(starts, SCRIPT));
          await live.player.activate();
          await settle(bridge);
          const sent = minted();
          gate.resolve(bridge);
          await assert.rejects(late.player.bridge, ONE_PLAYER);
          await settle(bridge);
          assert.equal(minted(), sent, `${name}: the refused Player sends nothing`);
          await holds(name, bridge, { player: live.player, asked: !asked }, starts.at(-1)!.trace);
        }
      });
