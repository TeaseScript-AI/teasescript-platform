import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  memoryKeptSessionStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerRuntimeSessionOptions } from "../../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import {
  recoveryKind,
  type LossState,
  type Recovery,
  type ShownStatus,
} from "../../player/vue/src/session/activation/recoveryKind.js";
import type { SessionTransfer } from "../../player/persistence/session-transfer.js";
import type { RewindOwner } from "../../player/vue/src/session/rewindOwner.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { readForImport, type SessionRead } from "../helpers/player/transfer-read.js";
import { presentedAction, runtimeInput } from "../helpers/player/player-input.js";
import { memoryStorage } from "../helpers/player/storage-host.js";
import { playerRuntimeForeground } from "../../player/runtime/runtime-view.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import {
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyConnections,
  until,
  type Topology,
  type TopologyBridge,
  type TopologyConnections,
  checkpointSnapshot,
} from "../helpers/player/worker-topology.js";

/*
 * What the player sees and can do after the engine's connection is lost (PLAYER-UI "Session end and failure", #1897):
 * the stop offers Continue from the last kept point or Start again, and only the player's click replaces the connection.
 * `recoveryKind`'s family decides what the loss leaves to recover; the rows run the real composable on both topologies
 * (`worker-topology.ts`), its replacements from a factory of the same topology that counts its calls.
 */

// `recoveryKind`'s family: every feasible state at the loss, each with what it leaves to recover.

const AXES = {
  disposed: ["no", "yes"],
  replaceable: ["yes", "no"],
  shown: ["none", "ready", "running", "waiting", "halted", "failed"],
  inspecting: ["no", "yes"],
  clicking: ["none", "start", "continue"],
  prepared: ["none", "start", "continue"],
} as const;

/**
 * The feasible states: a click under way cleared the session shown and the prepared activation. An inspection of
 * Debug's rewind outlives the session shown until a new session shows, through a recovery click and after one that
 * failed ("a Debug inspection at a recovery click", "... after a failed recovery click" below), so it goes with any
 * other coordinate.
 */
const feasible = (state: Coordinates) =>
  state.clicking === "none" || (state.shown === "none" && state.prepared === "none");

function optional<T extends string>(value: string): T | null {
  if (value === "none") return null;
  // EVIDENCE: fixture: each axis value but "none" is a member of the field's type (`AXES`).
  return value as T;
}

function lossState(state: Coordinates): LossState {
  return {
    disposed: state.disposed === "yes",
    replaceable: state.replaceable === "yes",
    shown: optional<ShownStatus>(state.shown!),
    inspecting: state.inspecting === "yes",
    clicking: optional<"start" | "continue">(state.clicking!),
    prepared: optional<"start" | "continue">(state.prepared!),
  };
}

/** The oracle, from the specification's sentences. */
function expected(state: Coordinates): Recovery | null {
  const { clicking, prepared } = lossState(state);
  // Nothing recovers on an unmounted page, or where no fresh connection can prepare the script again.
  if (state.disposed === "yes" || state.replaceable === "no") return null;
  // A Start or Continue lost before its session showed: the start page offers it again.
  if (clicking !== null) return { kind: clicking, shown: true };
  // A session that runs or waits, or a state inspected in place of the live one, stops with the kept-point offer.
  if (state.inspecting === "yes" || ["ready", "running", "waiting"].includes(state.shown!))
    return { kind: "kept" };
  // A session that ended keeps its end.
  if (state.shown === "halted" || state.shown === "failed") return { kind: "ended" };
  // A start page lost before its click stays as it is; one not yet prepared is no session's.
  return prepared === null ? null : { kind: prepared, shown: false };
}

test("recoveryKind gives each feasible state at the loss what it leaves to recover", () => {
  const states = product(AXES).filter(feasible);
  const observed: Coordinates[] = [];
  for (const state of states) {
    assert.deepEqual(recoveryKind(lossState(state)), expected(state), JSON.stringify(state));
    observed.push(state);
  }
  assert.deepEqual(coverageGaps(states, observed, { tuples: true }), []);
});

test("recoveryKind gives an undeclared status of the shown session nothing to recover: the error stop", () => {
  const state = {
    ...lossState({
      disposed: "no",
      replaceable: "yes",
      shown: "none",
      inspecting: "no",
      clicking: "none",
      prepared: "start",
    }),
    // EVIDENCE: fixture: a status no runtime version gives, as a state the page cannot classify.
    shown: "paused" as ShownStatus,
  };
  assert.equal(recoveryKind(state), null);
});

// The composable, on both topologies.

interface RecoveryHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly recovery: Readonly<
    Ref<{ readonly offer: "start" | "continue"; readonly where: "line" | "page" } | null>
  >;
  readonly connectionLosses: Readonly<Ref<number>>;
  readonly rewind: { readonly owner: RewindOwner; readonly inspecting: Readonly<Ref<boolean>> };
  readonly bridge: Promise<PlayerBridge>;
  loadScriptStorage(): Promise<void>;
  prepareScriptSource(
    script: string,
  ): Promise<{ readonly result: { readonly kind: string; readonly plan?: string } }>;
  prepareScript(
    plan: string,
    create: { readonly plan: string; readonly options: () => PlayerRuntimeSessionOptions },
  ): Promise<void>;
  activate(): Promise<void>;
  toStartPage(): Promise<void>;
  setDebugTracing(on: boolean): void;
  setRandomControl(control: { readonly sites: readonly [] } | null): void;
  exportSession(): Promise<{ readonly transfer: SessionTransfer }>;
  readTransfer(input: {
    readonly bytes: Uint8Array<ArrayBuffer>;
  }): Promise<{ readonly kind: string }>;
  reviewSessionImport(transfer: SessionRead): Promise<ImportReview>;
  importSession(review: ImportReview): Promise<void>;
  discardSessionReview(transfer: SessionRead): void;
  readonly inputSection: unknown;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
}
/** The composable's review of a session to import, which only `importSession` reads. */
interface ImportReview {
  readonly transfer: SessionRead;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly nextConnection?: () => Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly capabilities?: { readonly camera: boolean };
  readonly scriptStorage?: ScriptStorageProvider;
  readonly keptSessions?: KeptSessionStore;
}) => RecoveryHost;

before(async () => {
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  await loadTopology();
});

/** The browser surface the composable uses: a page, and audio elements that never load. */
function browser(context: TestContext) {
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class extends EventTarget {
      src = "";
      preload = "";
      volume = 1;
      duration = 3;
      paused = true;
      ended = false;
      currentTime = 0;
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(surface)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

/** The host errors the Player logs. */
function hostErrorLog(context: TestContext) {
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void errors.push(String(args[0]));
  context.after(() => void (console.error = log));
  return () => errors.filter((line) => line.includes("host error")).length;
}

const turns = async (count: number) => {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
};

const SCOPE = "recovery";
/** A question the session is kept at, then a line after the answer. */
const KEEPS_AT_A_QUESTION =
  'say "Hello", instant\nlet pick = askChoice "Go"\nsay "after", instant\nexit';

/**
 * The real composable on `topology` with a factory of fresh connections, its page prepared through
 * `prepareScriptSource` and, with `kept`, keeping its session there. Without `replaceable`, it is given the bridge
 * without a factory, as a host that offers none.
 */
async function page(
  context: TestContext,
  topology: Topology,
  {
    kept = memoryKeptSessionStore(),
    script = KEEPS_AT_A_QUESTION,
    replaceable = true,
    storage,
    camera = false,
  }: {
    kept?: KeptSessionStore;
    script?: string;
    replaceable?: boolean;
    storage?: ScriptStorageProvider;
    camera?: boolean;
  } = {},
) {
  browser(context);
  const hostErrors = hostErrorLog(context);
  const connections = await topologyConnections(context, topology);
  const scriptStorage: ScriptStorageProvider = storage ?? {
    scope: SCOPE,
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(connections.first.bridge),
      ...(replaceable && { nextConnection: () => connections.next() }),
      debugHistorySpill: async () => null,
      scriptStorage,
      keptSessions: kept,
      capabilities: { camera },
    }),
  )!;
  context.after(() => scope.stop());
  await player.loadScriptStorage();
  connections.first.assertTopology();
  const prepared = await player.prepareScriptSource(script);
  const plan = prepared.result.plan;
  assert.ok(plan !== undefined, "the script was prepared");
  // The session's saves go to the page's script storage, as the hosted page starts it.
  await player.prepareScript(plan, {
    plan,
    options: () => ({ ...player.scriptStorageOptions(), wallClockMs: 0 }),
  });
  return { connections, player, kept, hostErrors, scope };
}

/** Waits until the session shows its question, and the store keeps it there. */
async function keptAtTheQuestion(player: RecoveryHost, kept: KeptSessionStore) {
  await until(() => player.session.value?.state.foregroundAction != null, "the question shows");
  for (let turn = 0; ; turn++) {
    const stored = await kept.session(SCOPE);
    if (stored !== null && stored.events.length > 0) return stored;
    assert.ok(turn < 200, "the session was not kept");
    await turns(1);
  }
}

/** Whether `player` shows a session that runs or waits on the connection `connections` opened last. */
async function onTheFreshConnection(player: RecoveryHost, connections: TopologyConnections) {
  assert.equal(await player.bridge, connections.current().bridge, "the current connection");
  assert.notEqual(connections.current(), connections.first);
  connections.current().assertTopology();
}

const RERUN = rerunRegistry({
  "running, nothing kept": TOPOLOGIES,
  "waiting at a kept point": TOPOLOGIES,
  "a Start lost before its session showed": TOPOLOGIES,
  "a start page lost before its click": TOPOLOGIES,
  "a fresh connection that cannot open": TOPOLOGIES,
  "a kept point gone before the click": TOPOLOGIES,
  "no fresh connection": TOPOLOGIES,
  "after exit": TOPOLOGIES,
  "a second loss during the preparation": TOPOLOGIES,
  "unmounted during the replacement": TOPOLOGIES,
  "the trace and random control go again": TOPOLOGIES,
  "the trace and random control turned off while lost": TOPOLOGIES,
  "a session import read before the loss": TOPOLOGIES,
  "a keep's publish under way at the loss": TOPOLOGIES,
  // Only the in-process host can report the loss of a client already ended; a Worker's ended client reports none.
  "a late loss of the replaced connection": ["in-process"],
  "the reload witness": TOPOLOGIES,
  "a refused keep after a recovered Continue": TOPOLOGIES,
  "a session review finishing after the loss": TOPOLOGIES,
  "an old review beside a fresh ticket": TOPOLOGIES,
  "a second loss during restoreKept": TOPOLOGIES,
  "a second loss during beginRecording": TOPOLOGIES,
  "a second loss during continue": TOPOLOGIES,
  "the camera of a rejected replacement": TOPOLOGIES,
  "the camera of a second loss during the preparation": TOPOLOGIES,
  "a Debug inspection at a recovery click": TOPOLOGIES,
  "a refused begin of a recovery": TOPOLOGIES,
  "a prepared Continue lost before its click": TOPOLOGIES,
  "a Continue lost before its session showed": TOPOLOGIES,
  "running before the first keep": TOPOLOGIES,
  "an unreadable kept record": TOPOLOGIES,
  "a kept store that cannot be read": TOPOLOGIES,
  "a second loss during start": TOPOLOGIES,
  "a failed recompile": TOPOLOGIES,
  "a Debug inspection after a failed recovery click": TOPOLOGIES,
  "an ended record at the offer": TOPOLOGIES,
  "a record with refused events at the offer": TOPOLOGIES,
  "an unreadable record before the Continue click": TOPOLOGIES,
  "an ended record before the Continue click": TOPOLOGIES,
  "a kept point appearing before a Start again click": TOPOLOGIES,
  "a discarded review": TOPOLOGIES,
});

RERUN.rows(
  "running, nothing kept",
  "a lost session with no kept point offers Start again, and only the click replaces the connection",
  async (context, topology, end) => {
    const { connections, player, hostErrors } = await page(context, topology, {
      // A question before any keep: the session is not kept until it shows one.
      kept: memoryKeptSessionStore(),
      script: 'let pick = askChoice "Go"\nexit',
    });
    // Its first keep is held: nothing is kept when the connection is lost.
    connections.first.hold("captureKeep");
    await player.activate();
    await connections.first.held();
    await connections.first.lose();
    connections.first.release();
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "start", where: "line" });
    assert.equal(player.hostError.value, null, "no error stop");
    assert.equal(player.connectionLosses.value, 1);
    await turns(10);
    assert.equal(connections.calls(), 0, "nothing reconnects without a click");
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the new question");
    assert.equal(connections.calls(), 1);
    await onTheFreshConnection(player, connections);
    assert.equal(player.recovery.value, null);
    assert.equal(player.hostError.value, null);
    assert.equal(hostErrors(), 1, "the loss alone is logged, for the developer");
    return end();
  },
);

RERUN.rows(
  "waiting at a kept point",
  "a session lost at a kept point offers Continue from it, and the click continues it on a fresh connection",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    await player.activate();
    const stored = await keptAtTheQuestion(player, kept);
    const transcript = player.session.value!.transcriptEntries.length;
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "line" });
    // The stopped session stays shown under the line.
    assert.ok(player.session.value !== null);
    const recovering = player.activate();
    assert.equal(player.recovery.value, null, "the offer goes while its click is under way");
    await recovering;
    await until(() => player.session.value?.state.foregroundAction != null, "the question again");
    assert.equal(connections.calls(), 1);
    await onTheFreshConnection(player, connections);
    // The fresh host is asked for the plan's JSON, which its kept session's next save stores.
    assert.ok(connections.current().posts.some((post) => post.op === "preparePlanText"));
    assert.equal(player.session.value!.transcriptEntries.length, transcript);
    assert.equal(player.recovery.value, null);
    assert.deepEqual(
      (await kept.session(SCOPE))?.events,
      stored.events,
      "the kept point is the one continued",
    );
    return end();
  },
);

RERUN.rows(
  "a Start lost before its session showed",
  "a Start lost before its session showed offers Start again on the start page",
  async (context, topology, end) => {
    const { connections, player } = await page(context, topology);
    connections.first.hold("start");
    const starting = player.activate();
    await connections.first.held();
    await connections.first.lose();
    connections.first.release();
    await starting;
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "start", where: "page" });
    assert.equal(player.session.value, null);
    assert.equal(player.activation.value, null);
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question");
    assert.equal(connections.calls(), 1);
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "a start page lost before its click",
  "a start page lost before its click looks unchanged, and its Start recovers",
  async (context, topology, end) => {
    const { connections, player } = await page(context, topology);
    assert.equal(player.activation.value, "start");
    await connections.first.lose();
    await turns(5);
    assert.equal(player.activation.value, "start", "the start page is unchanged");
    assert.equal(player.recovery.value, null);
    assert.equal(player.hostError.value, null);
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question");
    assert.equal(connections.calls(), 1);
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "a fresh connection that cannot open",
  "a fresh connection that cannot open shows the same offer again, and only the next click tries again",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    connections.failNext();
    await player.activate();
    await until(() => player.recovery.value !== null, "the offer again");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "page" });
    assert.equal(player.hostError.value, null, "no error stop");
    await turns(10);
    assert.equal(connections.calls(), 1, "no attempt without a click");
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question again");
    assert.equal(connections.calls(), 2);
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "a kept point gone before the click",
  "a kept point gone between the offer and the click shows the start page with Start, and nothing begins",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    assert.equal(player.recovery.value?.offer, "continue");
    await kept.discard(SCOPE);
    await player.activate();
    await until(() => player.activation.value !== null, "the start page");
    assert.equal(player.activation.value, "start");
    assert.equal(player.session.value, null, "nothing begins");
    assert.equal(player.recovery.value, null);
    assert.equal(connections.calls(), 1);
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question");
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "no fresh connection",
  "a Player given a bridge without a factory of fresh connections keeps the error stop",
  async (context, topology, end) => {
    const { connections, player, kept, hostErrors } = await page(context, topology, {
      replaceable: false,
    });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.hostError.value !== null, "the error stop");
    assert.equal(player.hostError.value, "BridgeLostError");
    assert.equal(player.recovery.value, null);
    assert.equal(hostErrors(), 1);
    return end();
  },
);

RERUN.rows(
  "after exit",
  "a session that ended by exit keeps its end, and the start page's Start recovers",
  async (context, topology, end) => {
    const { connections, player } = await page(context, topology, {
      script: 'say "Bye", instant\nexit',
    });
    await player.activate();
    await until(() => player.session.value?.state.status === "halted", "the end");
    await connections.first.lose();
    await turns(5);
    assert.equal(player.recovery.value, null, "the end shows as it is");
    assert.equal(player.session.value?.state.status, "halted");
    assert.equal(player.hostError.value, null);
    // The end dialog closes: the start page offers Start.
    await player.toStartPage();
    await until(() => player.activation.value !== null, "the start page");
    assert.equal(player.activation.value, "start");
    assert.equal(connections.calls(), 0);
    await player.activate();
    await until(() => player.session.value?.state.status === "halted", "the new session's end");
    assert.equal(connections.calls(), 1);
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "a second loss during the preparation",
  "a fresh connection lost while it prepares the script offers the same choice again, without another attempt",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    connections.armNext((fresh) => fresh.hold("prepare"));
    const recovering = player.activate();
    await until(() => connections.made.length === 2, "the fresh connection");
    const fresh = connections.current();
    await fresh.held();
    await fresh.lose();
    fresh.release();
    await recovering;
    await until(() => player.recovery.value !== null, "the offer again");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "page" });
    assert.equal(player.hostError.value, null, "no error stop");
    await turns(10);
    assert.equal(connections.calls(), 1, "no attempt without a click");
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question again");
    assert.equal(connections.calls(), 2);
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "unmounted during the replacement",
  "a Player unmounted while its fresh connection opens shows and sends nothing more",
  async (context, topology, end) => {
    const { connections, player, kept, scope, hostErrors } = await page(context, topology);
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    connections.armNext(() => scope.stop());
    await player.activate();
    await turns(10);
    assert.equal(connections.calls(), 1);
    assert.deepEqual(connections.current().posts, [], "nothing is sent to the fresh connection");
    assert.equal(player.session.value, null);
    assert.equal(hostErrors(), 1, "the loss alone is logged");
    return end();
  },
);

for (const [id, name, offWhileLost] of [
  [
    "the trace and random control go again",
    "the value trace and Debug's random control asked for go to the fresh connection before its session starts",
    false,
  ],
  [
    "the trace and random control turned off while lost",
    "the value trace and Debug's random control turned off while lost do not go to the fresh connection",
    true,
  ],
] as const)
  RERUN.rows(id, name, async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    player.setDebugTracing(true);
    player.setRandomControl({ sites: [] });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    const first = connections.first.posts.map((post) => post.op);
    assert.ok(first.includes("debugTracing") && first.includes("randomControl"), first.join());
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    if (offWhileLost) {
      player.setDebugTracing(false);
      player.setRandomControl(null);
    }
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question again");
    await onTheFreshConnection(player, connections);
    // Only the settings are compared: the fresh connection also prepares, restores and continues the session.
    const posts = connections.current().posts;
    const ops = posts.map((post) => post.op);
    const settings = posts.filter(
      (post) => post.op === "debugTracing" || post.op === "randomControl",
    );
    assert.deepEqual(
      settings.map((post) => post.op),
      offWhileLost ? [] : ["debugTracing", "randomControl"],
    );
    // They go before the session's restore, as at a page load, with the settings asked for.
    for (const post of settings)
      assert.ok(ops.indexOf(post.op) < ops.indexOf("restoreKept"), post.op);
    if (!offWhileLost) {
      assert.match(JSON.stringify(settings[0]!.args), /"on":true/u);
      assert.match(JSON.stringify(settings[1]!.args), /"control":\{"sites":\[\]\}/u);
    }
    return end();
  });

RERUN.rows(
  "a session import read before the loss",
  "a session import read by the lost connection imports nothing on the fresh one",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    await player.activate();
    await keptAtTheQuestion(player, kept);
    const { transfer } = await player.exportSession();
    const review = await player.reviewSessionImport(await readForImport(player, transfer));
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question again");
    await onTheFreshConnection(player, connections);
    const stored = await kept.session(SCOPE);
    await assert.rejects(player.importSession(review), /lost with the engine's connection/u);
    assert.deepEqual(await kept.session(SCOPE), stored, "the kept session stays");
    return end();
  },
);

RERUN.rows(
  "a keep's publish under way at the loss",
  "a keep's publish under way at the loss is waited for: the offer reads the point it stored",
  async (context, topology, end) => {
    // The store holds each publish after `holding` until `release`.
    const store = memoryKeptSessionStore();
    let holding = false;
    const gate: { held: (() => void) | null } = { held: null };
    const kept: KeptSessionStore = {
      session: (scope) => store.session(scope),
      media: store.media,
      discard: (scope) => store.discard(scope),
      publish: async (scope, update) => {
        if (holding) await new Promise<void>((resolve) => (gate.held = resolve));
        return store.publish(scope, update);
      },
    };
    // Nothing is kept before the question; its keep's publish is held.
    const { connections, player } = await page(context, topology, {
      kept,
      script: 'let pick = askChoice "Go"\nsay "after", instant\nexit',
    });
    holding = true;
    await player.activate();
    await until(() => gate.held !== null, "the publish held");
    await connections.first.lose();
    await turns(10);
    assert.equal(player.recovery.value, null, "the offer waits for the publish");
    assert.equal(await store.session(SCOPE), null);
    holding = false;
    gate.held!();
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "line" });
    return end();
  },
);

RERUN.rows(
  "a late loss of the replaced connection",
  "a loss the replaced connection reports late stops nothing on the fresh one",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question again");
    await connections.first.lose();
    await turns(5);
    assert.equal(player.recovery.value, null);
    assert.equal(player.hostError.value, null);
    assert.equal(player.connectionLosses.value, 1);
    return end();
  },
);

/** Answers the shown choice with its first option, as its button does. */
async function answerFirst(player: RecoveryHost): Promise<void> {
  const input = await runtimeInput();
  const shown = player.session.value!;
  const foreground = playerRuntimeForeground(shown);
  assert.ok(foreground?.kind === "choose");
  const result = await input.runInput(
    player.inputSection,
    presentedAction(shown),
    presentedAction,
    input.intents.choice(foreground.options[0]!.id, "button"),
  );
  assert.equal(result.kind, "answered");
}

/** A choice kept, its answer saved, the next keep's capture held: then the connection is lost. */
const WITNESS =
  'let pick = askChoice go: "Go"\nsave pick as "picked"\nsay "after", instant\nlet next = askChoice again: "Again"\nexit';

/** One run of the witness up to its loss, with stores of its own. */
async function witnessToLoss(context: TestContext, topology: Topology) {
  const kept = memoryKeptSessionStore();
  const storage = memoryStorage({});
  const provider: ScriptStorageProvider = { ...storage.provider, scope: SCOPE };
  const run = await page(context, topology, { kept, script: WITNESS, storage: provider });
  await run.player.activate();
  await keptAtTheQuestion(run.player, kept);
  run.connections.first.hold("captureKeep");
  await answerFirst(run.player);
  await run.connections.first.held();
  // The page writes the save in its own task, while the next keep's capture is held.
  await until(() => storage.writes.length > 0, "the save written");
  assert.deepEqual(storage.writes, [["picked", "go"]], "the save was written before the loss");
  await run.connections.first.lose();
  run.connections.first.release();
  return { ...run, kept, storage, provider };
}

/** What the witness compares once the continued session answered again and shows its next choice. */
async function witnessAfter(
  player: RecoveryHost,
  connection: TopologyBridge,
  storage: ReturnType<typeof memoryStorage>,
) {
  await until(() => player.session.value?.state.foregroundAction != null, "the kept question");
  const transcriptAtContinue = player.session.value!.transcriptEntries.length;
  // The kept state as the restore gave it, as `captureKeep` exports it.
  const restoredState = JSON.stringify(
    await checkpointSnapshot(connection.bridge, player.session.value!),
  );
  await answerFirst(player);
  await until(
    () =>
      (player.session.value?.transcriptEntries.length ?? 0) > transcriptAtContinue &&
      player.session.value?.state.foregroundAction != null,
    "the next question",
  );
  const shown = player.session.value!;
  const posts = connection.posts;
  const from = posts.findIndex((post) => post.op === "restoreKept");
  // Ids that are this connection's own (sessions, plans) are named by their first appearance. Times are compared as
  // they are: the page's clocks are fixed for the witness (`fixedClocks`).
  const names = new Map<string, string>();
  const normalized = (value: unknown) =>
    JSON.stringify(value, (key, field: unknown) => {
      if (typeof field !== "string" || !CONNECTION_LOCAL.has(key)) return field;
      if (!names.has(field)) names.set(field, `${key}#${names.size}`);
      return names.get(field);
    });
  return {
    writes: storage.writes,
    entries: [...storage.entries],
    events: normalized(shown.events),
    transcriptAtContinue,
    transcript: normalized(shown.transcriptEntries),
    restoredState: normalized(JSON.parse(restoredState)),
    state: normalized(await checkpointSnapshot(connection.bridge, shown)),
    // The begin's posts, from the kept session's restore on; the preparation's come before it on either path.
    begin: posts
      .slice(from)
      .map((post) => normalized({ op: post.op, session: post.session, args: post.args })),
  };
}

/**
 * Fixes the page's clocks for the rest of the test: the wall clock (`Date.now`, the click's capture) and the monotonic
 * one (`performance.now`, each observation), so two runs of one schedule sample the same times.
 */
function fixedClocks(context: TestContext) {
  const [now, monotonic] = [Date.now, performance.now];
  Date.now = () => 1_800_000_000_000;
  performance.now = () => 1_000;
  context.after(() => {
    Date.now = now;
    performance.now = monotonic;
  });
}
/** The fields of a post whose strings name something of one connection only. */
const CONNECTION_LOCAL = new Set(["session", "plan", "ticket", "id"]);

RERUN.rows(
  "the reload witness",
  "Continue after a recovery repeats what a reload and Continue repeat: the save after the kept point runs again in both",
  async (context, topology, end) => {
    fixedClocks(context);
    // R: the recovery in the page.
    const recovered = await witnessToLoss(context, topology);
    await until(() => recovered.player.recovery.value !== null, "the offer");
    assert.equal(recovered.player.recovery.value?.offer, "continue");
    await recovered.player.activate();
    const r = await witnessAfter(
      recovered.player,
      recovered.connections.current(),
      recovered.storage,
    );
    // B: a reload: a new Player on a new connection with the same stores, and its Continue.
    const lost = await witnessToLoss(context, topology);
    lost.scope.stop();
    const reloaded = await page(context, topology, {
      kept: lost.kept,
      script: WITNESS,
      storage: lost.provider,
    });
    assert.equal(reloaded.player.activation.value, "continue");
    await reloaded.player.activate();
    const b = await witnessAfter(reloaded.player, reloaded.connections.first, lost.storage);
    assert.deepEqual(
      r.writes,
      [
        ["picked", "go"],
        ["picked", "go"],
      ],
      "the save runs again",
    );
    assert.match(
      r.begin[0]!,
      /^\{"op":"restoreKept"/u,
      "the begin's posts are compared from the restore",
    );
    assert.deepEqual(r, b);
    return end();
  },
);

RERUN.rows(
  "a refused keep after a recovered Continue",
  "a recovered Continue whose next keep is refused offers Continue from the same kept point after another loss",
  async (context, topology, end) => {
    const store = memoryKeptSessionStore();
    const refusal = { on: false, refused: 0 };
    const kept: KeptSessionStore = {
      session: (scope) => store.session(scope),
      media: store.media,
      discard: (scope) => store.discard(scope),
      publish: async (scope, update) => {
        if (refusal.on) {
          refusal.refused += 1;
          throw new Error("The store refused the write.");
        }
        return store.publish(scope, update);
      },
    };
    const { connections, player } = await page(context, topology, { kept, script: WITNESS });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the kept question");
    await turns(5);
    const stored = await store.session(SCOPE);
    assert.ok(stored !== null);
    refusal.on = true;
    await answerFirst(player);
    await until(() => refusal.refused > 0, "the next keep refused");
    assert.deepEqual(await store.session(SCOPE), stored, "the kept point stays");
    await connections.current().lose();
    await until(() => player.recovery.value !== null, "the offer again");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "line" });
    return end();
  },
);

/** Script storage in memory that `replace` changes, as the browser provider's does. */
function replacingStorage(initial: Record<string, string>) {
  const storage = memoryStorage(initial);
  const gate: { holdLoad: boolean; release: (() => void) | null } = {
    holdLoad: false,
    release: null,
  };
  const provider: ScriptStorageProvider = {
    ...storage.provider,
    scope: SCOPE,
    replace: async (entries) => {
      storage.entries.clear();
      for (const { key, value } of entries) storage.entries.set(key, value);
    },
    load: async () => {
      if (gate.holdLoad) {
        gate.holdLoad = false;
        await new Promise<void>((resolve) => (gate.release = resolve));
      }
      return storage.provider.load();
    },
  };
  return { storage, provider, gate };
}

RERUN.rows(
  "a session review finishing after the loss",
  "a session review that finishes after the loss is refused, and changes no saved value or kept point",
  async (context, topology, end) => {
    const { storage, provider, gate } = replacingStorage({ local: "keep" });
    const { connections, player, kept } = await page(context, topology, { storage: provider });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    const { transfer } = await player.exportSession();
    const read = await readForImport(player, {
      ...transfer,
      entries: [{ key: "foreign", value: "imported" }],
    });
    // The review's last step, its read of the saved values, waits while the connection is lost.
    gate.holdLoad = true;
    const reviewing = player.reviewSessionImport(read);
    await until(() => gate.release !== null, "the review reading the saved values");
    await connections.first.lose();
    const keptBefore = await kept.session(SCOPE);
    gate.release!();
    await assert.rejects(reviewing, /lost with the engine's connection/u);
    assert.deepEqual([...storage.entries], [["local", "keep"]]);
    assert.deepEqual(await kept.session(SCOPE), keptBefore);
    return end();
  },
);

RERUN.rows(
  "an old review beside a fresh ticket",
  "a review from before the loss imports nothing, also once the fresh host issued the same ticket; the fresh one imports",
  async (context, topology, end) => {
    const { storage, provider } = replacingStorage({ local: "keep" });
    const { connections, player, kept } = await page(context, topology, { storage: provider });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    const { transfer } = await player.exportSession();
    const oldRead = await readForImport(player, {
      ...transfer,
      entries: [{ key: "old", value: "old" }],
    });
    const oldReview = await player.reviewSessionImport(oldRead);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    await player.activate();
    await until(
      () => player.session.value?.state.foregroundAction != null,
      "the recovered question",
    );
    const freshRead = await readForImport(player, {
      ...transfer,
      entries: [{ key: "new", value: "new" }],
    });
    const freshReview = await player.reviewSessionImport(freshRead);
    assert.equal(oldRead.ticket, freshRead.ticket, "each host numbers its tickets alike");
    await assert.rejects(player.importSession(oldReview), /lost with the engine's connection/u);
    assert.deepEqual([...storage.entries], [["local", "keep"]]);
    await player.importSession(freshReview);
    assert.deepEqual([...storage.entries], [["new", "new"]]);
    return end();
  },
);

for (const op of ["restoreKept", "beginRecording", "continue"] as const)
  RERUN.rows(
    `a second loss during ${op}`,
    `a fresh connection lost during the recovery's ${op} offers the same choice again`,
    async (context, topology, end) => {
      const { connections, player, kept } = await page(context, topology);
      await player.activate();
      await keptAtTheQuestion(player, kept);
      await connections.first.lose();
      await until(() => player.recovery.value !== null, "the first offer");
      connections.armNext((fresh) => fresh.hold(op));
      const recovering = player.activate();
      await until(() => connections.made.length === 2, "the fresh connection");
      const fresh = connections.current();
      await fresh.held();
      await fresh.lose();
      fresh.release();
      await recovering;
      await until(() => player.recovery.value !== null, "the second offer");
      assert.deepEqual(player.recovery.value, { offer: "continue", where: "page" });
      assert.equal(player.hostError.value, null);
      assert.equal(connections.calls(), 1);
      await player.activate();
      await until(() => player.session.value?.state.foregroundAction != null, "the question again");
      assert.equal(connections.calls(), 2);
      await onTheFreshConnection(player, connections);
      return end();
    },
  );

/** A camera the composable opens: each `getUserMedia` gives one track, recorded with its state. */
function fakeCamera(context: TestContext) {
  class FakeTrack extends EventTarget {
    readonly kind = "video";
    readonly label = "fake camera";
    readyState: "live" | "ended" = "live";
    stop() {
      this.readyState = "ended";
    }
    getSettings() {
      return { deviceId: "fake camera" };
    }
  }
  const tracks: FakeTrack[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: Object.assign(new EventTarget(), {
        getUserMedia: async () => {
          const track = new FakeTrack();
          tracks.push(track);
          return { getTracks: () => [track] };
        },
        enumerateDevices: async () => [],
      }),
    },
  });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  return tracks;
}

for (const [id, phase] of [
  ["the camera of a rejected replacement", "rejected"],
  ["the camera of a second loss during the preparation", "lost"],
] as const)
  RERUN.rows(
    id,
    `${id} is released; a recovery that succeeds keeps its own`,
    async (context, topology, end) => {
      const tracks = fakeCamera(context);
      const { connections, player, kept } = await page(context, topology, { camera: true });
      await player.activate();
      await keptAtTheQuestion(player, kept);
      await connections.first.lose();
      await until(() => player.recovery.value !== null, "the first offer");
      assert.deepEqual(
        tracks.map((track) => track.readyState),
        ["ended"],
        "the loss released the camera",
      );
      if (phase === "rejected") connections.failNext();
      else connections.armNext((fresh) => fresh.hold("prepare"));
      const recovering = player.activate();
      if (phase === "lost") {
        await until(() => connections.made.length === 2, "the fresh connection");
        const fresh = connections.current();
        await fresh.held();
        await fresh.lose();
        fresh.release();
      }
      await recovering;
      await until(() => player.recovery.value !== null, "the second offer");
      assert.deepEqual(
        tracks.map((track) => track.readyState),
        ["ended", "ended"],
      );
      await player.activate();
      await until(() => player.session.value?.state.foregroundAction != null, "the question again");
      assert.deepEqual(
        tracks.map((track) => track.readyState),
        ["ended", "ended", "live"],
      );
      return end();
    },
  );

RERUN.rows(
  "a Debug inspection at a recovery click",
  "an inspection lost with its connection stays until the recovered session shows, which clears the old view",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology, { script: WITNESS });
    const rewind = player.rewind.owner;
    rewind.debugOn();
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await until(
      () => (rewind.view.value?.timeline.points.length ?? 0) > 0,
      "the first history point",
    );
    const point = rewind.view.value!.timeline.points[0]!.id;
    await answerFirst(player);
    await until(
      () => (rewind.view.value?.timeline.points.length ?? 0) > 1,
      "the next history point",
    );
    assert.equal(await rewind.back(point), true);
    assert.equal(player.rewind.inspecting.value, true);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "line" });
    connections.armNext((fresh) => fresh.hold("prepare"));
    const recovering = player.activate();
    await until(() => connections.made.length === 2, "the fresh connection");
    const fresh = connections.current();
    await fresh.held();
    // The family's state at a loss now: no session shown, still inspecting, the Continue click under way.
    assert.equal(player.session.value, null);
    assert.equal(player.rewind.inspecting.value, true);
    fresh.release();
    await recovering;
    await until(
      () => player.session.value?.state.foregroundAction != null,
      "the recovered question",
    );
    assert.equal(rewind.view.value, null, "the recovered session cleared the old view");
    assert.equal(player.rewind.inspecting.value, false);
    assert.equal(rewind.state.sealed, "loss", "no rewind until a reload");
    return end();
  },
);

RERUN.rows(
  "a refused begin of a recovery",
  "a begin the fresh host refuses before its session shows offers the same choice again, without the error stop",
  async (context, topology, end) => {
    const { connections, player } = await page(context, topology);
    await connections.first.lose();
    connections.armNext((fresh) => {
      fresh.bridge.start = async () => {
        throw new Error("The fresh host could not begin the session.");
      };
    });
    await player.activate();
    await until(() => player.recovery.value !== null, "the offer again");
    assert.deepEqual(player.recovery.value, { offer: "start", where: "page" });
    assert.equal(player.hostError.value, null);
    assert.equal(player.session.value, null);
    assert.equal(connections.calls(), 1);
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question");
    assert.equal(connections.calls(), 2);
    return end();
  },
);

/** A page whose store keeps a session at the question from an earlier page, so its start page offers Continue. */
async function continuePage(context: TestContext, topology: Topology) {
  const kept = memoryKeptSessionStore();
  const earlier = await page(context, topology, { kept });
  await earlier.player.activate();
  await keptAtTheQuestion(earlier.player, kept);
  earlier.scope.stop();
  const later = await page(context, topology, { kept });
  assert.equal(later.player.activation.value, "continue");
  return later;
}

RERUN.rows(
  "a prepared Continue lost before its click",
  "a start page offering Continue looks unchanged after the loss, and its Continue recovers",
  async (context, topology, end) => {
    const { connections, player } = await continuePage(context, topology);
    await connections.first.lose();
    await turns(5);
    assert.equal(player.activation.value, "continue");
    assert.equal(player.recovery.value, null);
    assert.equal(player.hostError.value, null);
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the kept question");
    assert.equal(connections.calls(), 1);
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "a Continue lost before its session showed",
  "a Continue lost before its session showed offers Continue from last kept point on the start page",
  async (context, topology, end) => {
    const { connections, player } = await continuePage(context, topology);
    connections.first.hold("continue");
    const continuing = player.activate();
    await connections.first.held();
    await connections.first.lose();
    connections.first.release();
    await continuing;
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "page" });
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the kept question");
    await onTheFreshConnection(player, connections);
    return end();
  },
);

RERUN.rows(
  "running before the first keep",
  "a session lost while it runs, before anything was kept, offers Start again on the line",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology, {
      script: 'say "Waiting", instant\nwait 60 s\nexit',
    });
    // Its first keep is held: nothing is kept when the connection is lost.
    connections.first.hold("captureKeep");
    await player.activate();
    await connections.first.held();
    assert.equal(
      player.session.value!.state.foregroundAction?.kind,
      "delay",
      "it waits on its timer",
    );
    assert.equal(await kept.session(SCOPE), null);
    await connections.first.lose();
    connections.first.release();
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "start", where: "line" });
    return end();
  },
);

for (const [id, read] of [
  // A record no validation accepts, as a store of another version can hold (`JSON.parse` gives it untyped).
  [
    "an unreadable kept record",
    (): ReturnType<KeptSessionStore["session"]> =>
      Promise.resolve(JSON.parse('{"unreadable":true}')),
  ],
  [
    "a kept store that cannot be read",
    (): ReturnType<KeptSessionStore["session"]> =>
      Promise.reject(new Error("The store cannot be read.")),
  ],
] as const)
  RERUN.rows(id, `${id} at the loss offers Start again`, async (context, topology, end) => {
    const store = memoryKeptSessionStore();
    const reading = { broken: false };
    const kept: KeptSessionStore = {
      session: (scope) => (reading.broken ? read() : store.session(scope)),
      media: store.media,
      discard: (scope) => store.discard(scope),
      publish: (scope, update) => store.publish(scope, update),
    };
    const { connections, player } = await page(context, topology, { kept });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    reading.broken = true;
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "start", where: "line" });
    return end();
  });

RERUN.rows(
  "a second loss during start",
  "a fresh connection lost during a recovered Start's begin offers Start again",
  async (context, topology, end) => {
    const { connections, player } = await page(context, topology);
    await connections.first.lose();
    connections.armNext((fresh) => fresh.hold("start"));
    const recovering = player.activate();
    await until(() => connections.made.length === 2, "the fresh connection");
    const fresh = connections.current();
    await fresh.held();
    await fresh.lose();
    fresh.release();
    await recovering;
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "start", where: "page" });
    assert.equal(player.hostError.value, null);
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question");
    assert.equal(connections.calls(), 2);
    return end();
  },
);

RERUN.rows(
  "a failed recompile",
  "a fresh connection that does not compile the script again offers the same choice again",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology);
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    connections.armNext((fresh) => {
      const client = fresh.bridge.client;
      // EVIDENCE: fixture: the client's own request, called with the arguments the Player passes it.
      const original = client.request.bind(client) as (
        op: string,
        ...rest: unknown[]
      ) => ReturnType<typeof client.request>;
      // EVIDENCE: fixture: the host's reply to a source that does not compile, in place of its own reply.
      client.request = ((op: string, ...rest: unknown[]) =>
        op === "prepare"
          ? Promise.resolve({ result: { kind: "notCompiled", diagnostics: [] } })
          : original(op, ...rest)) as typeof client.request;
    });
    await player.activate();
    await until(() => player.recovery.value !== null, "the offer again");
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "page" });
    assert.equal(player.hostError.value, null);
    assert.equal(connections.calls(), 1);
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the kept question");
    assert.equal(connections.calls(), 2);
    return end();
  },
);

RERUN.rows(
  "a Debug inspection after a failed recovery click",
  "an inspection lost with its connection stays after a failed recovery click, and the next click's session clears it",
  async (context, topology, end) => {
    const { connections, player, kept } = await page(context, topology, { script: WITNESS });
    const rewind = player.rewind.owner;
    rewind.debugOn();
    await player.activate();
    await keptAtTheQuestion(player, kept);
    await until(
      () => (rewind.view.value?.timeline.points.length ?? 0) > 0,
      "the first history point",
    );
    const point = rewind.view.value!.timeline.points[0]!.id;
    await answerFirst(player);
    await until(
      () => (rewind.view.value?.timeline.points.length ?? 0) > 1,
      "the next history point",
    );
    assert.equal(await rewind.back(point), true);
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    connections.failNext();
    await player.activate();
    await until(() => player.recovery.value !== null, "the offer again");
    // The family's state after the failed click: no session shown, still inspecting, no click, nothing prepared.
    assert.equal(player.session.value, null);
    assert.equal(player.rewind.inspecting.value, true);
    assert.equal(player.activation.value, null);
    assert.deepEqual(player.recovery.value, { offer: "continue", where: "page" });
    await player.activate();
    await until(
      () => player.session.value?.state.foregroundAction != null,
      "the recovered question",
    );
    assert.equal(player.rewind.inspecting.value, false);
    assert.equal(rewind.view.value, null);
    return end();
  },
);

/** A stored record of `kind`: a session that ended by `exit`, or one whose events the engine's checks refuse. */
async function storedRecord(context: TestContext, topology: Topology, kind: "ended" | "refused") {
  const kept = memoryKeptSessionStore();
  const earlier = await page(context, topology, { kept });
  await earlier.player.activate();
  const stored = await keptAtTheQuestion(earlier.player, kept);
  if (kind === "refused") {
    earlier.scope.stop();
    return {
      ...stored,
      events: [...stored.events, JSON.parse('{"kind":"notAnEvent","sequence":-1}')],
    };
  }
  await answerFirst(earlier.player);
  for (let turn = 0; ; turn++) {
    const ended = await kept.session(SCOPE);
    if (
      ended !== null &&
      ended.events.length > stored.events.length &&
      earlier.player.session.value?.state.status === "halted"
    )
      return ended;
    assert.ok(turn < 200, "the ended session was not kept");
    await turns(1);
  }
}

/** A store that gives `record` in place of its own once `swapped`. */
function swappingStore(record: () => ReturnType<KeptSessionStore["session"]>) {
  const store = memoryKeptSessionStore();
  const swap = { on: false };
  const kept: KeptSessionStore = {
    session: (scope) => (swap.on ? record() : store.session(scope)),
    media: store.media,
    discard: (scope) => store.discard(scope),
    publish: (scope, update) => store.publish(scope, update),
  };
  return { kept, swap };
}

for (const [id, kind] of [
  ["an ended record at the offer", "ended"],
  ["a record with refused events at the offer", "refused"],
] as const)
  RERUN.rows(id, `${id} offers Start again`, async (context, topology, end) => {
    const record = await storedRecord(context, topology, kind);
    const { kept, swap } = swappingStore(() => Promise.resolve(record));
    const { connections, player } = await page(context, topology, { kept });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    swap.on = true;
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    assert.deepEqual(player.recovery.value, { offer: "start", where: "line" });
    return end();
  });

for (const [id, kind] of [
  ["an unreadable record before the Continue click", "unreadable"],
  ["an ended record before the Continue click", "ended"],
] as const)
  RERUN.rows(
    id,
    `${id} shows the start page with Start, and nothing begins`,
    async (context, topology, end) => {
      const record =
        kind === "ended"
          ? await storedRecord(context, topology, "ended")
          : JSON.parse('{"unreadable":true}');
      const { kept, swap } = swappingStore(() => Promise.resolve(record));
      const { connections, player } = await page(context, topology, { kept });
      await player.activate();
      await keptAtTheQuestion(player, kept);
      await connections.first.lose();
      await until(() => player.recovery.value !== null, "the offer");
      assert.equal(player.recovery.value?.offer, "continue");
      swap.on = true;
      await player.activate();
      await until(() => player.activation.value !== null, "the start page");
      assert.equal(player.activation.value, "start");
      assert.equal(player.session.value, null, "nothing begins");
      return end();
    },
  );

RERUN.rows(
  "a kept point appearing before a Start again click",
  "Start again starts anew, without the Continue check, also when a kept point appeared after the offer",
  async (context, topology, end) => {
    const store = memoryKeptSessionStore();
    const hidden = { on: true };
    const kept: KeptSessionStore = {
      session: (scope) => (hidden.on ? Promise.resolve(null) : store.session(scope)),
      media: store.media,
      discard: (scope) => store.discard(scope),
      publish: (scope, update) => store.publish(scope, update),
    };
    const { connections, player } = await page(context, topology, { kept });
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question");
    for (let turn = 0; (await store.session(SCOPE)) === null; turn++) {
      assert.ok(turn < 200, "the session was not kept");
      await turns(1);
    }
    await connections.first.lose();
    await until(() => player.recovery.value !== null, "the offer");
    assert.equal(player.recovery.value?.offer, "start");
    hidden.on = false;
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question");
    assert.equal(player.session.value!.liveEventSequence, 0, "a session started anew");
    return end();
  },
);

RERUN.rows(
  "a discarded review",
  "a review whose read was let go of imports nothing, and a review of that read asks its host, which refuses",
  async (context, topology, end) => {
    const { storage, provider } = replacingStorage({ local: "keep" });
    const { connections, player, kept } = await page(context, topology, { storage: provider });
    await player.activate();
    await keptAtTheQuestion(player, kept);
    const { transfer } = await player.exportSession();
    const read = await readForImport(player, {
      ...transfer,
      entries: [{ key: "foreign", value: "imported" }],
    });
    const review = await player.reviewSessionImport(read);
    player.discardSessionReview(read);
    const posted = connections.first.posts.length;
    await assert.rejects(player.reviewSessionImport(read));
    assert.ok(
      connections.first.posts.slice(posted).some((post) => post.op === "reviewTransfer"),
      "the review asked the host that read it",
    );
    const before = await kept.session(SCOPE);
    await assert.rejects(player.importSession(review), /let go of/u);
    assert.deepEqual([...storage.entries], [["local", "keep"]]);
    assert.deepEqual(await kept.session(SCOPE), before);
    return end();
  },
);
