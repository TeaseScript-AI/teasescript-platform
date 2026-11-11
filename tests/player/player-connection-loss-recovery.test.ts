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
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import {
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyConnections,
  until,
  type Topology,
  type TopologyConnections,
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
 * The feasible states: a click under way cleared the session shown and the prepared activation, and only a shown state
 * can be one Debug's rewind restored.
 */
const feasible = (state: Coordinates) =>
  (state.clicking === "none" ||
    (state.shown === "none" && state.prepared === "none" && state.inspecting === "no")) &&
  (state.inspecting === "no" || state.shown !== "none");

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
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly nextConnection?: () => Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
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
  }: { kept?: KeptSessionStore; script?: string; replaceable?: boolean } = {},
) {
  browser(context);
  const hostErrors = hostErrorLog(context);
  const connections = await topologyConnections(context, topology);
  const scriptStorage: ScriptStorageProvider = {
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
    }),
  )!;
  context.after(() => scope.stop());
  await player.loadScriptStorage();
  connections.first.assertTopology();
  const prepared = await player.prepareScriptSource(script);
  const plan = prepared.result.plan;
  assert.ok(plan !== undefined, "the script was prepared");
  await player.prepareScript(plan, { plan, options: () => ({ wallClockMs: 0 }) });
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
    await player.activate();
    await until(() => player.session.value?.state.foregroundAction != null, "the question again");
    assert.equal(connections.calls(), 1);
    await onTheFreshConnection(player, connections);
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
