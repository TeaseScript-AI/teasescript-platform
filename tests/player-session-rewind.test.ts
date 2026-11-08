import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";

import type { HistoryPoint } from "../player/engine-bridge/history/core.js";
import type { DebugHistorySpill } from "../player/engine-bridge/history/snapshots.js";
import type { DebugHistoryView } from "../player/debug-history.js";
import type { LifecycleAction } from "../player/rewind-lifecycle.js";
import type { DebugRecorder } from "../player/debug-recorder.js";
import {
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice as rawSelectPlayerRuntimeChoice,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
  playerRuntimeSnapshot as rawPlayerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../player/compile-project.js";
import { playerRuntimeForeground, type PlayerSession } from "../player/runtime-view.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import { memoryKeptRoomStore, type KeptRoomStore } from "../player/kept-sessions.js";
import type { RuntimeSnapshot, SerializableRuntimeValue } from "../src/index.js";
import type { RuntimeDebugContext } from "../src/runtime/debug/debug-trace.js";
import { published } from "./helpers/debug-readers.js";
import { coverageGaps, product, type Coordinates } from "./helpers/family-coverage.js";
import {
  LIFECYCLE,
  excluded,
  expectation,
  lifecycleCases,
  type LifecycleCase,
} from "./helpers/rewind-lifecycle.js";
import {
  obligations as transferObligations,
  transferCoverage,
  type Obligation,
} from "./helpers/rewind-transfer-domain.js";
import { loadPlayerModule } from "./helpers/player-modules.js";
import { hostTrace, loadHostFacade, onHost } from "./helpers/host-sessions.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import type * as ClientModule from "../player/engine-bridge/client.js";

/** The value trace the host's session runs with, as the host holds it. */
const traceOf = (session: PlayerRuntimeSession | null | undefined) =>
  session === null || session === undefined
    ? null
    : onHost((held: PlayerRuntimeSession) => held.debugTrace)(session);

// The adapter's functions, also on the sessions the composables' host holds (`helpers/host-sessions.ts`).
const selectPlayerRuntimeChoice = onHost(rawSelectPlayerRuntimeChoice);
const playerRuntimeSnapshot = onHost(rawPlayerRuntimeSnapshot);

// Debug's rewind through the Player's real session host (DEBUGGER.md "Rewind"): Back shows an earlier state for
// inspection without running it or touching saved data; new input adopts it as the session, with its saved data.

/** What reviewing an import gives, which the import then takes; these tests do not read it. */
interface ImportReview {
  readonly scripts: readonly object[];
}
interface RewindHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string }[]>>;
  readonly rewind: {
    readonly inspecting: Readonly<Ref<boolean>>;
    readonly canRewind: Readonly<Ref<boolean>>;
    readonly adopting: Readonly<Ref<boolean>>;
    beforeRestart(): void | Promise<void>;
    /** The Player's rewind owner (`rewindOwner.ts`): the history view it shows. */
    readonly owner: {
      readonly view: Readonly<Ref<DebugHistoryView | null>>;
      readonly state: { readonly sealed: "disposal" | "loss" | null };
      readonly reinstatement: Readonly<Ref<"pending" | "failed" | null>>;
      retryReturn(): boolean;
    } & MutableOwner;
  };
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(
    create: (recording: {
      readonly recorder: DebugRecorder;
      readonly debugTrace?: RuntimeDebugContext;
    }) => PlayerRuntimeSession,
  ): void;
  activate(): void;
  toStartPage(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
  prepareInput(): true | Promise<boolean>;
  setDebugTracing(on: boolean): void;
  reviewSavedDataImport(bundle: {
    readonly scripts: readonly {
      readonly scope: string;
      readonly name: string | null;
      readonly photos: readonly string[];
      readonly entries: readonly {
        readonly key: string;
        readonly value: SerializableRuntimeValue;
      }[];
    }[];
    readonly images: readonly never[];
  }): Promise<ImportReview>;
  importSavedData(review: ImportReview, chosen: ReadonlySet<string>): Promise<void>;
  clearScriptStorage(): Promise<boolean>;
  readonly bridge: Promise<PlayerBridge>;
  reportHostError(error: unknown): void;
  editSavedData(edit: {
    key: string;
    value: SerializableRuntimeValue;
    expected: SerializableRuntimeValue | undefined;
  }): Promise<{ readonly kind: string }>;
  observe(): Promise<PlayerRuntimeSession | null>;
  demandCallView(): { release(): void };
  debugRecording(): {
    readonly anchorSnapshot: RuntimeSnapshot;
    readonly endSnapshot: RuntimeSnapshot;
    readonly operations: readonly unknown[];
    readonly complete: boolean;
  } | null;
  debugExportCandidate(
    player: Record<string, never>,
  ): Promise<{
    readonly session: { readonly snapshot: RuntimeSnapshot } | null;
    readonly recording: {
      readonly operations: readonly { readonly kind: string; readonly thrown: string | null }[];
      readonly complete: boolean;
    } | null;
    readonly rewoundWhileDebugging: { restoredSceneTimeMs: number; rewindCount: number } | null;
  }>;
}
interface Rewind {
  readonly state: Readonly<
    Ref<{
      readonly history: number | null;
      readonly points: readonly HistoryPoint[];
      readonly inspection: {
        readonly points: number;
        readonly canForward: boolean;
        readonly adopting: boolean;
        readonly shown: { readonly id: number; readonly eventCount: number };
        readonly future: { readonly eventCount: number } | null;
      } | null;
    }>
  >;
  back(point: number): Promise<boolean>;
  forward(): Promise<boolean>;
  resume(): Promise<boolean>;
  returnToSession(): Promise<boolean>;
  endWithPlayer(): void;
}
let usePlayerSession: (options: {
  bridge?: Promise<PlayerBridge>;
  scriptStorage: ScriptStorageProvider;
  debugHistorySpill: () => Promise<DebugHistorySpill | null>;
  debugRooms?: KeptRoomStore;
}) => RewindHost;
let useDebugRewind: (player: RewindHost) => Rewind;
/** Collects into `reported` each error the Player reports as a host failure (its `[player] host error` line). */
function reportsInto(context: TestContext, reported: unknown[]) {
  const write = console.error.bind(console);
  context.mock.method(console, "error", (...args: unknown[]) => {
    if (args[0] === "[player] host error") reported.push(args[1]);
    else write(...args);
  });
}

/** Back to the point at `index` in the history's points, by its ID. */
const backTo = (rewind: Rewind, index: number) =>
  rewind.back(rewind.state.value.points[index]?.id ?? -1);
// The composable's own in-process backend and the client's loss class, from the modules it loads.
let createInProcessBackend: (build: {
  readonly commit: null;
  readonly dirty: null;
  readonly mode: null;
  readonly appVersion: null;
}) => PlayerBridge;
let BridgeLostError: typeof ClientModule.BridgeLostError;
let usePlayerDebug: (
  player: RewindHost,
  initial: { readonly menu: boolean; readonly autoSkip: boolean },
) => { readonly active: Ref<boolean>; readonly rewind: Readonly<Ref<Rewind | null>> };

before(async () => {
  await loadHostFacade();
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerSession.ts",
  );
  const rewind: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/useDebugRewind.ts",
  );
  const debug: Record<string, unknown> = await loadPlayerModule("player/vue/src/usePlayerDebug.ts");
  const facade: Record<string, unknown> = await loadPlayerModule(
    "player/engine-bridge/in-process.ts",
  );
  const client: Record<string, unknown> = await loadPlayerModule("player/engine-bridge/client.ts");
  assert.equal(typeof facade.createInProcessBackend, "function");
  // EVIDENCE: validation: Vite loaded the real source modules; these are the composable's own backend and loss class.
  createInProcessBackend = facade.createInProcessBackend as typeof createInProcessBackend;
  // EVIDENCE: validation: as above.
  BridgeLostError = client.BridgeLostError as typeof BridgeLostError;
  assert.equal(typeof debug.usePlayerDebug, "function");
  // EVIDENCE: validation: as above.
  usePlayerDebug = debug.usePlayerDebug as typeof usePlayerDebug;
  assert.equal(typeof session.usePlayerSession, "function");
  assert.equal(typeof rewind.useDebugRewind, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: as above.
  useDebugRewind = rewind.useDebugRewind as typeof useDebugRewind;
});

/**
 * An in-process bridge whose connection `lose()` loses as a real loss does: the client rejects everything pending and
 * posts nothing more, and its loss listeners run in the same tick.
 */
function lossyBridge(): { readonly bridge: PlayerBridge; lose(): void } {
  const bridge = createInProcessBackend({
    commit: null,
    dirty: null,
    mode: null,
    appVersion: null,
  });
  const listeners: ((error: ClientModule.BridgeLostError) => void)[] = [];
  bridge.client.onLoss = (listener) => void listeners.push(listener);
  return {
    bridge,
    lose: () => {
      bridge.client.terminate();
      const lost = new BridgeLostError("The engine Worker failed: injected.");
      for (const listener of listeners) listener(lost);
    },
  };
}

/** Saved data in memory, recording each provider call; the next `replace` can be made to fail. */
function memoryStorage() {
  const entries = new Map<string, SerializableRuntimeValue>();
  const calls: string[] = [];
  let failReplace = false;
  let failNext = false;
  let replaceHeld: Promise<void> | null = null;
  let replaceReached = false;
  let writeHeld: Promise<void> | null = null;
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [...entries].map(([key, value]) => ({ key, value })),
    write: async (key, value) => {
      calls.push(`write ${key}`);
      await writeHeld;
      if (value === null) entries.delete(key);
      else entries.set(key, value);
    },
    replace: async (replacement) => {
      calls.push("replace");
      if (replaceHeld !== null) replaceReached = true;
      const fails = failNext;
      failNext = false;
      await replaceHeld;
      if (failReplace || fails) throw new Error("quota");
      entries.clear();
      for (const entry of replacement) entries.set(entry.key, entry.value);
    },
    clear: async () => entries.clear(),
  };
  return {
    provider,
    calls,
    saved: () => Object.fromEntries(entries),
    failReplaces() {
      failReplace = true;
    },
    /** Fails the next replacement only. */
    failNextReplace() {
      failNext = true;
    },
    /** Holds every write until `release` is called. */
    holdWrites() {
      let release!: () => void;
      writeHeld = new Promise((resolve) => (release = resolve));
      return () => release();
    },
    /** Holds every replacement until `release` is called; `reached` says whether one arrived at the hold. */
    holdReplaces() {
      let release!: () => void;
      replaceHeld = new Promise((resolve) => (release = resolve));
      return Object.assign(() => release(), { reached: () => replaceReached });
    },
  };
}

function memorySpill() {
  const state = { destroyed: 0 };
  const rows = new Map<number, string>();
  let getHeld: Promise<void> | null = null;
  let getReached = false;
  let getFails = false;
  const spill: DebugHistorySpill = {
    put: async (id, json) => void rows.set(id, json),
    get: async (id) => {
      if (getHeld !== null) getReached = true;
      await getHeld;
      if (getFails) throw new Error("The read failed.");
      return rows.get(id);
    },
    delete: async (ids) => ids.forEach((id) => rows.delete(id)),
    destroy: async () => {
      rows.clear();
      state.destroyed += 1;
    },
  };
  return {
    spill,
    state,
    /** Holds every read until `release` is called; `reached` says whether one arrived at the hold. */
    holdGets() {
      let release!: () => void;
      getHeld = new Promise((resolve) => (release = resolve));
      return Object.assign(() => release(), { reached: () => getReached });
    },
    /** Fails every read from now on. */
    failGets() {
      getFails = true;
    },
  };
}

function createHost(
  context: TestContext,
  provider: ScriptStorageProvider,
  options: {
    readonly debugRooms?: KeptRoomStore;
    /** A bridge of its own whose connection the test can lose (`lose`), as `player-bridge-loss.test.ts` does it. */
    readonly lossy?: boolean;
  } = {},
) {
  // Event targets are the only browser surface these scripts use, besides the audio elements a Start primes while it
  // reads the stored values.
  const values = {
    document: new EventTarget(),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const spill = memorySpill();
  const lossy = options.lossy === true ? lossyBridge() : null;
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      ...(lossy && { bridge: Promise.resolve(lossy.bridge) }),
      scriptStorage: provider,
      debugHistorySpill: async () => spill.spill,
      ...(options.debugRooms && { debugRooms: options.debugRooms }),
    }),
  );
  assert.ok(host);
  // Debug's features have a scope of their own, which turning Debug off stops.
  const debug = effectScope();
  const rewind = debug.run(() => useDebugRewind(host));
  assert.ok(rewind);
  context.after(() => {
    debug.stop();
    scope.stop();
  });
  return {
    host,
    rewind,
    debug,
    scope,
    spill: spill.state,
    holdGets: spill.holdGets,
    failGets: spill.failGets,
    lose: lossy?.lose,
  };
}

// Lets storage writes report, which the host does in a later task.
async function settle(context: TestContext) {
  for (let round = 0; round < 4; round += 1) {
    for (let turn = 0; turn < 5; turn += 1) await nextTick();
    context.mock.timers.tick(0);
  }
  for (let turn = 0; turn < 5; turn += 1) await nextTick();
}

const script = [
  'save 1 as "k"',
  'let first = askChoice "One", "Two"',
  'save first as "pick"',
  'say "first ${first}", instant',
  'let second = askChoice "Red", "Blue"',
  'save second as "color"',
  'say "second ${second}", instant',
  'let third = askChoice "A", "B"',
  "exit",
].join("\n");

const SCOPES_USED_UP = /nextScopeId is at its largest value, so it cannot advance/u;

async function start(context: TestContext, host: RewindHost) {
  await host.loadScriptStorage();
  host.prepare((recording) =>
    createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
  );
  host.activate();
  await settle(context);
}

// Chooses as the Player's interaction does: the session is readied for input first, and only then is input evaluated.
async function choose(context: TestContext, host: RewindHost, label: string) {
  if (await host.prepareInput()) {
    const session = host.session.value!;
    const foreground = playerRuntimeForeground(session);
    assert.ok(foreground?.kind === "choose", label);
    const option = foreground.options.find((candidate) => candidate.label === label)!;
    host.update(selectPlayerRuntimeChoice(session, option.id)!.session);
  }
  await settle(context);
}

function said(host: RewindHost): string[] {
  return (host.session.value?.transcriptEntries ?? []).map((entry) => entry.text);
}

test("Back shows an earlier state paused, and Forward and Return restore the state it left", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value!;
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  assert.deepEqual(
    rewind.state.value.points.map((point) => point.response?.text ?? null),
    ["One", null],
  );

  assert.equal(await backTo(rewind, 0), true);
  assert.equal(host.rewind.inspecting.value, true);
  assert.deepEqual(said(host), []);
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "choose");
  // Nothing runs on its own while inspecting: no time is observed, and saved data stay as they were.
  const inspected = host.session.value;
  assert.equal(await host.observe(), inspected);
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  // The restored state is a diagnostic fork, and its recording begins at it.
  assert.deepEqual((await host.debugExportCandidate({})).rewoundWhileDebugging, {
    restoredSceneTimeMs: inspected!.state.observedSessionTimeMs,
    rewindCount: 1,
  });
  assert.deepEqual(host.debugRecording()?.anchorSnapshot, playerRuntimeSnapshot(inspected!));

  assert.equal(await rewind.forward(), true);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!), playerRuntimeSnapshot(tip));
  assert.deepEqual(said(host), ["One", "first One"]);
  assert.equal(host.rewind.inspecting.value, true);

  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
  assert.equal(host.rewind.inspecting.value, false);
  assert.equal((await host.debugExportCandidate({})).rewoundWhileDebugging, null);
  assert.deepEqual(storage.calls, ["write k", "write pick"]);
});

test("after an engine call throws, the export, Back, Forward, and Return work from the state the Player showed", async (context) => {
  const { host, rewind } = createHost(context, memoryStorage().provider);
  // With the scope IDs used up, the run after the second answer throws (TSR101) when it enters the block, an error no
  // script reaches otherwise.
  const source = [
    'let first = askChoice "One", "Two"',
    'say "first ${first}", instant',
    'let second = askChoice "Red", "Long"',
    'if second == "Long" {',
    '  say "deep", instant',
    "}",
    'say "second ${second}", instant',
    "exit",
  ].join("\n");
  await host.loadScriptStorage();
  const started = createPlayerRuntimeSession(source, host.scriptStorageOptions());
  const usedUp = JSON.stringify({
    ...playerRuntimeSnapshot(started),
    nextScopeId: Number.MAX_SAFE_INTEGER,
  });
  host.prepare(({ recorder }) =>
    restorePlayerRuntimeSessionAt(started.plan, usedUp, started.events, recorder),
  );
  host.activate();
  await settle(context);
  await choose(context, host, "One");
  const tip = host.session.value!;
  const shown = playerRuntimeSnapshot(tip);
  await assert.rejects(choose(context, host, "Long"), SCOPES_USED_UP);
  assert.equal(host.session.value, tip);

  const candidate = await host.debugExportCandidate({});
  assert.deepEqual(candidate.session?.snapshot, shown);
  assert.deepEqual(
    candidate.recording?.operations.map((operation) => [operation.kind, operation.thrown]),
    [
      ["completeAction", null],
      ["run", null],
      ["completeAction", null],
      ["run", "RuntimeDataError"],
    ],
  );
  assert.equal(candidate.recording?.complete, true);

  // After another error, Back keeps the state it left, the one the Player showed, for Forward.
  await assert.rejects(choose(context, host, "Long"), SCOPES_USED_UP);
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "choose");
  assert.equal(await rewind.forward(), true);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!), shown);
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
  await choose(context, host, "Red");
  assert.equal(host.session.value!.state.status, "halted");
  assert.deepEqual(said(host).slice(-2), ["Red", "second Red"]);
});

test("a different choice adopts the restored state: its saved data, then the new writes, and no way back", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);

  await choose(context, host, "Two");
  assert.equal(host.rewind.inspecting.value, false);
  // The saved data are the point's, then the branch saves as any session.
  assert.deepEqual(storage.calls, ["write k", "write pick", "replace", "write pick"]);
  assert.deepEqual(storage.saved(), { k: 1, pick: "Two" });
  assert.deepEqual(said(host), ["Two", "first Two"]);
  // The later point went with the discarded future; the branch's own takes its place.
  assert.deepEqual(
    rewind.state.value.points.map((point) => point.response?.text ?? null),
    ["Two", null],
  );
  assert.equal(await rewind.returnToSession(), false);
  assert.equal(rewind.state.value.inspection, null);
  assert.deepEqual((await host.debugExportCandidate({})).rewoundWhileDebugging?.rewindCount, 1);

  // Turning Debug off keeps the branch: it is the session now.
  const branch = host.session.value;
  debug.stop();
  assert.equal(host.session.value, branch);
  await choose(context, host, "Red");
  assert.deepEqual(said(host), ["Two", "first Two", "Red", "second Red"]);
});

test("Resume adopts the restored state without input", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.resume(), true);
  assert.equal(host.rewind.inspecting.value, false);
  assert.deepEqual(storage.saved(), { k: 1 });
  assert.equal(await rewind.returnToSession(), false);
});

test("when the saved data cannot be restored, the state stays inspected and Return still reinstates the session", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value;
  assert.equal(await backTo(rewind, 0), true);
  const inspected = host.session.value;
  storage.failReplaces();
  await choose(context, host, "Two");
  assert.equal(host.rewind.inspecting.value, true);
  assert.equal(host.session.value, inspected);
  assert.ok(host.notices.value.some((notice) => notice.key === "rewind-not-adopted"));
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  assert.equal(await rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
});

test("Debug off during a pending adoption, then a loss: the adoption's late outcome reinstates nothing and rejects nothing unhandled", async (context) => {
  for (const hold of ["request", "reply"] as const) {
    await context.test(hold, async (subtest) => {
      const made = createHost(subtest, memoryStorage().provider, { lossy: true });
      const { host, rewind } = made;
      await start(subtest, host);
      await choose(subtest, host, "One");
      const tip = shownView(host);
      assert.equal(await backTo(rewind, 0), true);
      const held = holdRead(subtest, await host.bridge, "captureStorage", hold, false);
      // Input adopts the inspected state; the adoption waits for its read.
      const chosen = Promise.resolve(host.prepareInput());
      await held.arrived;
      made.debug.stop();
      made.lose!();
      held.release();
      await chosen.catch(() => {});
      await settle(subtest);
      assert.notEqual(
        host.session.value === null ? null : shownView(host).lineage,
        tip.lineage,
        "the parked session is not reinstated",
      );
    });
  }
});

test("a rewind reply that rejects on a live connection is reported as a host failure; one the loss ended is not", async (context) => {
  for (const lost of [false, true]) {
    await context.test(lost ? "lost" : "live", async (subtest) => {
      const { host, rewind } = createHost(subtest, memoryStorage().provider);
      await start(subtest, host);
      await choose(subtest, host, "One");
      assert.equal(await backTo(rewind, 0), true);
      const bridge = await host.bridge;
      const failure = lost
        ? new BridgeLostError("The engine Worker failed: injected.")
        : new Error("A host failure.");
      const request = bridge.client.request.bind(bridge.client);
      subtest.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) =>
        args[0] === "rewindReturn" ? Promise.reject(failure) : request(...args),
      );
      const reported: unknown[] = [];
      reportsInto(subtest, reported);
      assert.equal(await rewind.returnToSession(), true);
      await settle(subtest);
      assert.deepEqual(reported, lost ? [] : [failure]);
    });
  }
});

test("turning Debug off while inspecting reinstates the session and deletes the history", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug, spill } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value;
  assert.equal(await backTo(rewind, 0), true);
  debug.stop();
  // Debug off goes through the Player's lifecycle queue and the restart gate, then shows the parked session.
  await settle(context);
  assert.equal(host.session.value, tip);
  assert.equal(host.rewind.inspecting.value, false);
  await settle(context);
  assert.equal(spill.destroyed, 1);
});

for (const end of ["Debug off", "unmount"] as const)
  test(`after the connection is lost, ${end} while a state is inspected reinstates nothing and throws nothing`, async (context) => {
    const storage = memoryStorage();
    const made = createHost(context, storage.provider, { lossy: true });
    const { host, rewind, debug } = made;
    await start(context, host);
    await choose(context, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    const inspected = host.session.value;
    made.lose!();
    await settle(context);
    // The lost host's states are gone, and with them Debug's history: the rewind is sealed by the loss.
    assert.equal(host.rewind.owner.state.sealed, "loss");
    if (end === "Debug off") debug.stop();
    else made.scope.stop();
    assert.equal(host.session.value, inspected, "nothing reinstated");
  });

for (const hold of ["request", "reply"] as const)
  test(`Debug off while an adoption's read is held (${hold}), then a lost connection: nothing is reinstated, and nothing rejects`, async (context) => {
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", record);
    context.after(() => void process.off("unhandledRejection", record));
    // What the Player reports as host errors: the loss, and nothing a reinstatement attempted after it.
    const reported: unknown[] = [];
    context.mock.method(console, "error", (...args: unknown[]) => void reported.push(args[1]));
    const storage = memoryStorage();
    const made = createHost(context, storage.provider, { lossy: true });
    const { host, rewind, debug } = made;
    await start(context, host);
    await choose(context, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    const shown = host.session.value;
    const held = holdRead(context, await host.bridge, "captureStorage", hold, false);
    const chosen = choose(context, host, "Two");
    await held.arrived;
    debug.stop();
    made.lose!();
    held.release();
    await chosen;
    await settle(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.session.value, shown, "the lost session is not reinstated");
    assert.deepEqual(rejections, [], "no promise rejected unhandled");
    assert.deepEqual(
      reported.map((error) => (error instanceof Error ? error.message : String(error))),
      ["The engine Worker failed: injected."],
      "only the loss was reported: no reinstatement was attempted",
    );
  });

test("the Player's unmount releases the history's lineages on the connection that lives, an adoption's included", async (context) => {
  for (const adopting of [false, true]) {
    await context.test(adopting ? "adopting" : "inspecting", async (subtest) => {
      // Debug on goes on in the debug room, whose saved data here are the ones `storage` holds.
      const storage = memoryStorage();
      const made = createHost(subtest, memoryStorage().provider, {
        debugRooms: { ...memoryKeptRoomStore(), values: () => storage.provider },
      });
      const { host } = made;
      // The Player's own Debug features, which unmount with it.
      made.debug.stop();
      const features = effectScope();
      const debug = features.run(() => usePlayerDebug(host, { menu: true, autoSkip: false }))!;
      await settle(subtest);
      await start(subtest, host);
      await choose(subtest, host, "One");
      const parked = shownView(host);
      assert.equal(await backTo(debug.rewind.value!, 0), true);
      const shown = shownView(host);
      const bridge = await host.bridge;
      const release = adopting ? storage.holdReplaces() : null;
      const chosen = adopting ? choose(subtest, host, "Two") : null;
      if (adopting) await settle(subtest);
      features.stop();
      made.scope.stop();
      release?.();
      await chosen;
      await settle(subtest);
      assert.deepEqual(
        { parked: await heldInHost(bridge, parked.id), shown: await heldInHost(bridge, shown.id) },
        { parked: false, shown: false },
      );
    });
  }
});

test("Back waits for a pending save, and a new session deletes the history", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, spill } = createHost(context, storage.provider);
  await start(context, host);
  const session = host.session.value!;
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  // The choice saves; the write waits for the host until a later task, and Back with it.
  host.update(selectPlayerRuntimeChoice(session, foreground.options[0]!.id)!.session);
  assert.equal(host.rewind.canRewind.value, false);
  assert.equal(await backTo(rewind, 0), false);
  await settle(context);
  assert.equal(host.rewind.canRewind.value, true);
  assert.equal(rewind.state.value.points.length, 2);

  await start(context, host);
  assert.equal(spill.destroyed, 1);
  assert.equal(rewind.state.value.points.length, 1);
});

test("turning Debug off while an adoption is under way reinstates the session only if the adoption fails", async (context) => {
  for (const fails of [true, false]) {
    await context.test(fails ? "fails" : "succeeds", async (subtest) => {
      const storage = memoryStorage();
      const { host, rewind, debug } = createHost(subtest, storage.provider);
      await start(subtest, host);
      await choose(subtest, host, "One");
      const tip = host.session.value;
      assert.equal(await backTo(rewind, 0), true);
      const release = storage.holdReplaces();
      if (fails) storage.failReplaces();
      const chosen = choose(subtest, host, "Two");
      debug.stop();
      release();
      await chosen;
      assert.equal(host.rewind.inspecting.value, false);
      if (fails) assert.equal(host.session.value, tip);
      else assert.deepEqual(said(host), ["Two", "first Two"]);
    });
  }
});

test("input to an inspected state is evaluated only once it is adopted, so a failed adoption changes nothing", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const inspected = host.session.value!;
  const events = inspected.events.length;
  storage.failReplaces();
  await choose(context, host, "Two");
  assert.equal(host.session.value, inspected);
  assert.deepEqual(said(host), []);
  assert.equal(inspected.events.length, events);
  assert.deepEqual(host.debugRecording()?.endSnapshot, playerRuntimeSnapshot(inspected));
});

test("a second input while the state is being adopted is refused, and the first applies once", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const release = storage.holdReplaces();
  const first = choose(context, host, "Two");
  assert.equal(await host.prepareInput(), false);
  release();
  await first;
  assert.deepEqual(said(host), ["Two", "first Two"]);
  const sequences = host.session.value!.events.map((event) => event.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.deepEqual(storage.saved(), { k: 1, pick: "Two" });
});

test("Back waits for a Storage editor change until the session took it", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const release = storage.holdWrites();
  const edit = host.editSavedData({ key: "pick", value: "Edited", expected: "One" });
  await settle(context);
  assert.equal(host.rewind.canRewind.value, false);
  assert.equal(await backTo(rewind, 0), false);
  release();
  assert.deepEqual(await edit, { kind: "saved", live: true });
  await settle(context);
  assert.equal(host.rewind.canRewind.value, true);
});

test("an unmounted Player whose adoption fails publishes nothing", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug, scope } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const release = storage.holdReplaces();
  storage.failReplaces();
  const chosen = choose(context, host, "Two");
  const generation = host.generation.value;
  scope.stop();
  debug.stop();
  release();
  await chosen;
  assert.equal(host.generation.value, generation);
});

test("every restored state begins a new epoch of the value trace, which may turn off while a state is adopted", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  host.setDebugTracing(true);
  await start(context, host);
  await choose(context, host, "One");
  const trace = hostTrace(await host.bridge)!;
  const epoch = trace.status().epoch;
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(traceOf(host.session.value), trace);
  assert.equal(trace.status().epoch, epoch + 1);
  assert.equal(await rewind.forward(), true);
  assert.equal(trace.status().epoch, epoch + 2);

  // Turning the trace off rewraps the inspected session; the adoption under way still completes.
  assert.equal(await backTo(rewind, 0), true);
  const release = storage.holdReplaces();
  const chosen = choose(context, host, "Two");
  host.setDebugTracing(false);
  release();
  await chosen;
  assert.equal(host.rewind.inspecting.value, false);
  assert.deepEqual(said(host), ["Two", "first Two"]);
  assert.deepEqual(storage.saved(), { k: 1, pick: "Two" });
});

test("turning the Debug switch off while an adoption fails reinstates the session, also as the trace turns off", async (context) => {
  const storage = memoryStorage();
  // Debug on goes on in the debug room, whose saved data here are the ones `storage` holds.
  const { host, debug: rewindScope } = createHost(context, memoryStorage().provider, {
    debugRooms: { ...memoryKeptRoomStore(), values: () => storage.provider },
  });
  // The Player's own Debug features, as the Debug panel's switch turns them on and off.
  rewindScope.stop();
  const scope = effectScope();
  const debug = scope.run(() => usePlayerDebug(host, { menu: true, autoSkip: false }))!;
  context.after(() => scope.stop());
  // Debug on goes on in the debug room first; Start waits for it.
  await settle(context);
  await start(context, host);
  await choose(context, host, "One");
  const tip = playerRuntimeSnapshot(host.session.value!);
  assert.equal(await backTo(debug.rewind.value!, 0), true);
  const release = storage.holdReplaces();
  storage.failReplaces();
  const chosen = choose(context, host, "Two");
  debug.active.value = false;
  release();
  await chosen;
  assert.equal(host.rewind.inspecting.value, false);
  // The session is back as it was, and reads that Debug is off.
  assert.equal(tip.debugMode, true);
  assert.equal(host.session.value!.state.debugMode, false);
  assert.deepEqual({ ...playerRuntimeSnapshot(host.session.value!), debugMode: true }, tip);
  assert.deepEqual(said(host), ["One", "first One"]);
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
});

test("input is refused while a step reads a spilled state, so the saved data stay as the shown session's", async (context) => {
  const storage = memoryStorage();
  // Every point is written through to the spill store, so each step reads its state back.
  const { host, rewind, holdGets } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  await choose(context, host, "Red");
  assert.deepEqual(storage.saved(), { k: 1, pick: "One", color: "Red" });
  assert.equal(await backTo(rewind, 1), true);
  const release = holdGets();
  const back = backTo(rewind, 0);
  assert.equal(await host.prepareInput(), false);
  assert.equal(await rewind.returnToSession(), false);
  release();
  assert.equal(await back, true);
  assert.deepEqual(storage.saved(), { k: 1, pick: "One", color: "Red" });
  assert.equal(await rewind.returnToSession(), true);
  const view = Object.fromEntries(
    playerRuntimeSnapshot(host.session.value!).scriptStorage.map((entry) => [
      entry.key,
      entry.value,
    ]),
  );
  assert.deepEqual(view, storage.saved());
});

test("importing the shown script ends its rewind history and an inspected state, also one that ended", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  for (const label of ["One", "Red", "A"]) await choose(context, host, label);
  assert.equal(host.session.value?.state.status, "halted");
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.forward(), true);
  assert.equal(host.rewind.inspecting.value, true);
  const review = await host.reviewSavedDataImport({
    scripts: [{ scope: "test", name: null, photos: [], entries: [{ key: "imported", value: 9 }] }],
    images: [],
  });
  await host.importSavedData(review, new Set(["test"]));
  assert.equal(host.rewind.inspecting.value, false);
  assert.deepEqual(rewind.state.value.points, []);
  assert.equal(await rewind.resume(), false);
  assert.equal(await rewind.returnToSession(), false);
  assert.deepEqual(storage.saved(), { imported: 9 });
});

test("a step whose prepared state arrives after Start or Continue began is dropped: it shows nothing and changes nothing", async (context) => {
  for (const step of ["back", "forward"] as const) {
    await context.test(step, async (subtest) => {
      const storage = memoryStorage();
      const { host, rewind, holdGets } = createHost(subtest, storage.provider);
      await start(subtest, host);
      await choose(subtest, host, "One");
      await choose(subtest, host, "Red");
      assert.equal(await backTo(rewind, 1), true);
      if (step === "forward") assert.equal(await backTo(rewind, 0), true);
      const shown = host.session.value;
      const before = rewind.state.value.inspection;
      const release = holdGets();
      const pending = step === "back" ? backTo(rewind, 0) : rewind.forward();
      host.prepare((recording) =>
        createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
      );
      release();
      assert.equal(await pending, false);
      await settle(subtest);
      assert.equal(host.session.value, shown, "the restored state does not show");
      // The handoff was dropped: the host's timeline and the page's are as before, and the shown session is held.
      const bridge = await host.bridge;
      const held = await bridge.historyTimeline(rewind.state.value.history!);
      assert.deepEqual(held!.inspection, before);
      assert.deepEqual(rewind.state.value.inspection, before);
      assert.equal(
        (await bridge.read(shownView(host), "captureStorage")).revision,
        shownView(host).revision,
      );
    });
  }
});

test("a session-local state that rewind adopted leaves Play again session-local", async (context) => {
  const writes: string[] = [];
  const { host, rewind } = createHost(context, {
    scope: "test",
    load: async () => {
      throw new Error("Storage is denied.");
    },
    write: async (key) => void writes.push(key),
    replace: async () => void writes.push("replace"),
    clear: async () => {},
  });
  await host.loadScriptStorage();
  host.prepare((recording) =>
    createPlayerRuntimeSession(
      [
        'let k = load("k", default: 0) + 1',
        'save k as "k"',
        'let pick = askChoice "Go", "Stay"',
        'say "${k}", instant',
        "exit",
      ].join("\n"),
      { ...host.scriptStorageOptions(), ...recording },
    ),
  );
  host.activate();
  await settle(context);
  await choose(context, host, "Go");
  assert.equal(host.session.value?.state.status, "halted");
  assert.equal(await backTo(rewind, 0), true);
  await choose(context, host, "Stay");
  assert.equal(host.rewind.inspecting.value, false);
  assert.equal(host.session.value?.state.status, "halted");

  await host.toStartPage();
  await host.activate();
  await settle(context);
  await choose(context, host, "Go");
  assert.equal(said(host).at(-1), "1");
  assert.deepEqual(writes, []);
});

/** The shown session as the Player holds it: a published view, with its lineage and call view. */
const shownView = (host: RewindHost): PlayerSession => published(host.session.value);

test("the call view follows the shown session through Back and Return while a demand stands, and ends with it", async (context) => {
  const { host, rewind, scope } = createHost(context, memoryStorage().provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  const bridge = tip.connection;
  const sent: { readonly lineage: object; readonly on: boolean }[] = [];
  const viewCalls = bridge.viewCalls.bind(bridge);
  bridge.viewCalls = (session, on) => {
    sent.push({ lineage: session.lineage, on });
    return viewCalls(session, on);
  };

  // A demand released while its request is in flight: the end follows the start, and none stays.
  host.demandCallView().release();
  await settle(context);
  assert.deepEqual(sent.splice(0), [
    { lineage: tip.lineage, on: true },
    { lineage: tip.lineage, on: false },
  ]);
  assert.equal(shownView(host).callView, null);

  const demand = host.demandCallView();
  // A second demand asks for nothing more.
  const second = host.demandCallView();
  await settle(context);
  assert.deepEqual(sent, [{ lineage: tip.lineage, on: true }]);
  assert.notEqual(shownView(host).callView, null);

  // Back shows another lineage: the left one's calls are no longer viewed, the shown one's are.
  assert.equal(await backTo(rewind, 0), true);
  await settle(context);
  const inspected = shownView(host);
  assert.notEqual(inspected.lineage, tip.lineage);
  assert.deepEqual(sent.slice(1), [
    { lineage: tip.lineage, on: false },
    { lineage: inspected.lineage, on: true },
  ]);
  assert.notEqual(shownView(host).callView, null);

  // Return shows the left lineage again, with its calls viewed again.
  assert.equal(await rewind.returnToSession(), true);
  await settle(context);
  assert.equal(shownView(host).lineage, tip.lineage);
  assert.deepEqual(sent.slice(3), [
    { lineage: inspected.lineage, on: false },
    { lineage: tip.lineage, on: true },
  ]);
  assert.notEqual(shownView(host).callView, null);

  // Released while inspecting: the call view ends, and Return asks for none.
  assert.equal(await backTo(rewind, 0), true);
  await settle(context);
  second.release();
  demand.release();
  // A second release does nothing.
  demand.release();
  await settle(context);
  const back = shownView(host);
  assert.deepEqual(sent.slice(-1), [{ lineage: back.lineage, on: false }]);
  assert.equal(back.callView, null);
  const count = sent.length;
  assert.equal(await rewind.returnToSession(), true);
  await settle(context);
  assert.equal(sent.length, count, "without a demand, Return asks for no call view");

  // An unmount ends a demand still standing.
  host.demandCallView();
  await settle(context);
  assert.deepEqual(sent.at(-1), { lineage: tip.lineage, on: true });
  scope.stop();
  assert.deepEqual(sent.at(-1), { lineage: tip.lineage, on: false });
});

/*
 * The async exits of Back's step and an adoption's read in the host (`rewindBack`, `captureStorage`), as one
 * declaration: the request × where it is held (before it is posted, or after the host answered, with its reply held) ×
 * what the page does meanwhile × how it settles (its reply, or a rejection). The outcome is one decision,
 * `exitOutcome`: when the page moved on, the step changes nothing it shows (Back shows no restored state; an adoption
 * writes and says nothing), but for the two exceptions of
 * DEBUGGER.md "Rewind": Back after a Player error stop parks the stopped session, and Debug's end waits for an adoption
 * under way, which completes or fails as it would. A read that settles by rejection fails its step; a failed adoption
 * that still owns the page says so. Unmounting ends Debug's features and the Player together; a lost connection settles
 * every read it held by rejection.
 *
 * This family is where "no stale failure notice after the page moved on" is proven: with the read held, each end of
 * the page's lifecycle (replacement, stop, unmount, loss), and the notice observed on the page. The source check of
 * `player-persistence-operations-source.test.ts` sees only how the read's settlement is wired, not what it says.
 */
const EXIT_AXES = {
  read: ["back", "adopt"],
  hold: ["request", "reply"],
  lifecycle: ["none", "publication", "replaced", "debugOff", "stopped", "disposed", "lost"],
  settlement: ["reply", "rejection"],
} as const;
type ExitCase = { readonly [Axis in keyof typeof EXIT_AXES]: (typeof EXIT_AXES)[Axis][number] };
const READS = { back: "rewindBack", adopt: "captureStorage" } as const;

/**
 * Why a combination is no case: a lost connection posts nothing more and delivers no reply; and an inspected state, which
 * an adoption reads, shows no newer publication, for it runs nothing until it is adopted.
 */
const infeasible = ({ read, lifecycle, settlement }: Coordinates) =>
  (lifecycle === "lost" && settlement === "reply") ||
  (read === "adopt" && lifecycle === "publication");

/** Every case of the declaration, but the infeasible. */
function exitCases(): ExitCase[] {
  const cases: ExitCase[] = [];
  for (const read of EXIT_AXES.read)
    for (const hold of EXIT_AXES.hold)
      for (const lifecycle of EXIT_AXES.lifecycle)
        for (const settlement of EXIT_AXES.settlement) {
          const each: ExitCase = { read, hold, lifecycle, settlement };
          if (!infeasible(each)) cases.push(each);
        }
  return cases;
}

/** What the step does in `each`: whether it succeeds, whether the saved values are written, and whether it says it failed. */
function exitOutcome({ read, lifecycle, settlement }: ExitCase): {
  readonly done: boolean;
  readonly wrote: boolean;
  readonly notice: boolean;
} {
  const replied = settlement === "reply";
  // Back parks the host's session itself, not a capture of it, so a newer publication of it moves nothing.
  if (read === "back")
    return {
      done:
        replied && (lifecycle === "none" || lifecycle === "stopped" || lifecycle === "publication"),
      wrote: false,
      notice: false,
    };
  // The adoption owns the page while nothing replaced, stopped or unmounted it; Debug's end waits for it.
  const owns = lifecycle === "none" || lifecycle === "debugOff";
  return { done: owns && replied, wrote: owns && replied, notice: owns && !replied };
}

/**
 * Holds the first request of `op` on `bridge`: before it is posted (`request`), or after the host answered it (`reply`),
 * until `release()`; then it settles with the host's answer, or rejects (`rejects`).
 */
function holdRead(
  context: TestContext,
  bridge: PlayerBridge,
  op: string,
  hold: ExitCase["hold"],
  rejects: boolean,
) {
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const request = bridge.client.request.bind(bridge.client);
  let first = true;
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    if (args[0] !== op || !first) return request(...args);
    first = false;
    const settle = (answer: ReturnType<typeof request>) =>
      rejects ? answer.then(() => Promise.reject(new Error("The read failed."))) : answer;
    if (hold === "request") {
      reached();
      return gate.then(() => settle(request(...args)));
    }
    const answered = request(...args);
    void answered.then(reached, reached);
    return gate.then(() => settle(answered));
  });
  return { arrived, release: () => release() };
}

for (const each of exitCases())
  test(`a rewind read in the host: ${Object.values(each).join(", ")}`, async (context) => {
    const storage = memoryStorage();
    const made = createHost(context, storage.provider, { lossy: each.lifecycle === "lost" });
    const { host, rewind } = made;
    await start(context, host);
    await choose(context, host, "One");
    if (each.read === "adopt") assert.equal(await backTo(rewind, 0), true);
    const bridge = await host.bridge;
    const shown = shownView(host);
    const callsBefore = storage.calls.length;
    const held = holdRead(
      context,
      bridge,
      READS[each.read],
      each.hold,
      each.settlement === "rejection",
    );
    const step = each.read === "back" ? backTo(rewind, 0) : rewind.resume();
    await held.arrived;
    if (each.lifecycle === "publication") {
      // The page shows a newer publication of the session, which the read did not see: a later observation.
      context.mock.timers.tick(1_000);
      host.observe();
      await settle(context);
      assert.notEqual(shownView(host).revision, shown.revision, "a newer publication shows");
    } else if (each.lifecycle === "replaced") {
      host.prepare((recording) =>
        createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
      );
      host.activate();
    } else if (each.lifecycle === "debugOff") made.debug.stop();
    else if (each.lifecycle === "stopped") host.reportHostError(new Error("A Player error."));
    else if (each.lifecycle === "disposed") {
      made.debug.stop();
      made.scope.stop();
    } else if (each.lifecycle === "lost") made.lose!();
    held.release();
    const done = await step.catch(() => false);
    await settle(context);
    const want = exitOutcome(each);
    assert.equal(done, want.done, "the step's result");
    assert.equal(
      storage.calls.slice(callsBefore).includes("replace"),
      want.wrote,
      "the saved values written",
    );
    assert.equal(
      host.notices.value.some((one) => one.key === "rewind-not-adopted"),
      want.notice,
      "the adoption's failure said",
    );
    if (each.read === "back")
      assert.equal(host.rewind.inspecting.value, want.done, "a state parked");
  });

test("the rewind reads' exit cases are every feasible coordinate of their declaration", () => {
  const all = product(EXIT_AXES).filter((each) => !infeasible(each));
  assert.deepEqual(coverageGaps(all, exitCases(), { tuples: true }), []);
});

/*
 * L5i.6: every lineage transfer of Debug's rewind (`transferLineages`), as the declared domain generates its obligations
 * (`tests/helpers/rewind-transfer-domain.ts`), each run through the Player's real session host and its host ops: the
 * page is brought into the inspection state, the transition runs as the Player or its host runs it, and the fates of
 * the parked and the shown lineage are read back from the host (a released session is gone there) and the page. A
 * refusal is the composable's and the host op's both, and changes no ownership; so does a failed guard. The coverage
 * check binds the cases run to the obligations.
 */
const TRANSFERS = transferObligations();
const transfersRun = new Set<string>();

/** Saved data that cannot be read, so the session is session-local and an adoption replaces none. */
function deniedStorage(): ScriptStorageProvider {
  return {
    scope: "test",
    load: async () => {
      throw new Error("Storage is denied.");
    },
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
}

/** Chooses the shown interaction's option `index` as the Player does, without waiting for its adoption. */
function chooseAt(host: RewindHost, index: number): Promise<void> {
  return (async () => {
    if (await host.prepareInput()) {
      const session = host.session.value!;
      const foreground = playerRuntimeForeground(session);
      assert.ok(foreground?.kind === "choose");
      host.update(selectPlayerRuntimeChoice(session, foreground.options[index]!.id)!.session);
    }
  })();
}

/** Whether the host still holds session `id`. */
async function heldInHost(bridge: PlayerBridge, id: string): Promise<boolean> {
  const reply = await bridge.client.request("captureKeep", { session: id, plan: null });
  // EVIDENCE: validation: `captureKeep` replies from the same build with a `KeepCapture`.
  return (reply.result as { readonly kind: string }).kind !== "gone";
}

/** The page in `inspection`, with the lineage parked (or live) and the one shown, as the family's transitions meet it. */
async function transferState(
  context: TestContext,
  each: Obligation,
): Promise<{
  readonly made: ReturnType<typeof createHost>;
  readonly storage: ReturnType<typeof memoryStorage> | null;
  readonly bridge: PlayerBridge;
  readonly parked: PlayerSession;
  readonly shown: PlayerSession | null;
  /** The adoption under way, and how it is let go: it succeeds, or fails. */
  readonly adoption: { readonly done: Promise<void>; release(): void } | null;
}> {
  const sessionLocal = each.variant.includes("session-local");
  const storage = sessionLocal ? null : memoryStorage();
  const made = createHost(context, storage?.provider ?? deniedStorage());
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  await choose(context, host, "Red");
  // A clear needs a session that ended.
  if (each.transition === "close by clear" && each.inspection === "not inspecting")
    await choose(context, host, "A");
  const bridge = await host.bridge;
  const parked = shownView(host);
  if (each.inspection === "not inspecting")
    return { made, storage, bridge, parked, shown: null, adoption: null };
  assert.equal(await backTo(rewind, 1), true);
  if (each.inspection === "inspecting without a future") assert.equal(await rewind.forward(), true);
  await settle(context);
  const shown = shownView(host);
  if (each.inspection !== "adopting")
    return { made, storage, bridge, parked, shown, adoption: null };
  // The adoption's read is held in the host's reply; it then succeeds, or fails as its persistence fails.
  const fails = each.variant.startsWith("failed") || each.case.includes("failure");
  if (fails && storage !== null) storage.failReplaces();
  const held = holdRead(context, bridge, "captureStorage", "reply", fails && storage === null);
  const done = chooseAt(host, 1);
  await held.arrived;
  assert.equal(host.rewind.adopting.value, true);
  return { made, storage, bridge, parked, shown, adoption: { done, release: held.release } };
}

/** Runs `each`'s transition as the Player (or, for a teardown, its host) runs it; resolves to whether the page acted. */
async function runTransfer(
  context: TestContext,
  each: Obligation,
  state: Awaited<ReturnType<typeof transferState>>,
): Promise<boolean> {
  const { made, bridge, adoption } = state;
  const { host, rewind } = made;
  const guard = each.case.endsWith("guard fails") ? each.case.split(" ")[0] : null;
  if (guard === "readiness")
    // A Start being prepared: the session may not be left now.
    host.prepare((recording) =>
      createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
    );
  if (guard === "read") made.failGets();
  const settleAdoption = async () => {
    adoption?.release();
    await adoption?.done.catch(() => {});
  };
  switch (each.transition) {
    case "back": {
      // The target guard names a point that does not lead to the state shown: the point shown, or none at all.
      const index = guard !== "target" ? 0 : each.inspection === "inspecting with a future" ? 1 : 9;
      return backTo(rewind, index);
    }
    case "forward":
      return rewind.forward();
    case "return":
      return await rewind.returnToSession();
    case "adopt begun": {
      if (each.inspection === "not inspecting" || each.inspection === "adopting") {
        // No state to adopt, or one being adopted: the input does not adopt.
        if (each.inspection === "adopting") return (await host.prepareInput()) !== false;
        return false;
      }
      if (state.storage === null) holdRead(context, bridge, "captureStorage", "reply", false);
      else state.storage.holdReplaces();
      void chooseAt(host, 1);
      await settle(context);
      return host.rewind.adopting.value;
    }
    case "adopt ended":
      if (adoption === null) return false;
      await settleAdoption();
      return true;
    case "close by debugOff":
      made.debug.stop();
      await settleAdoption();
      return true;
    case "close by replacement":
      await start(context, host);
      await settleAdoption();
      return true;
    case "close by import": {
      const review = await host.reviewSavedDataImport({
        scripts: [{ scope: "test", name: null, photos: [], entries: [] }],
        images: [],
      });
      await host.importSavedData(review, new Set(["test"]));
      await settleAdoption();
      if (each.variant === "with a replacement") await start(context, host);
      return true;
    }
    case "close by clear":
      return host.clearScriptStorage();
    case "close by disposal":
      // The Player unmounts, its Debug features with it (as `usePlayerDebug` ends them), on a connection that lives.
      rewind.endWithPlayer();
      made.debug.stop();
      made.scope.stop();
      await settleAdoption();
      return true;
  }
  throw new Error(`No such transition: ${each.transition}`);
}

/** The host op `each`'s transition sends, as a refusal must also be the host's. */
function rawTransfer(each: Obligation, history: number, live: PlayerSession) {
  switch (each.transition) {
    case "back":
      return { op: "rewindBack", args: { history, point: 1, live: live.id, events: [] } };
    case "forward":
      return { op: "rewindForward", args: { history, events: [] } };
    case "return":
      return { op: "rewindReturn", args: { history } };
    case "adopt begun":
      return { op: "rewindAdopt", args: { history, phase: "begin" } };
    case "adopt ended":
      return {
        op: "rewindAdopt",
        args: { history, phase: "end", succeeded: each.variant.startsWith("succeeded") },
      };
    case "close by clear":
      return { op: "historyClose", args: { history, by: "clear" } };
  }
  return null;
}

for (const each of TRANSFERS)
  test(`a rewind lineage transfer: ${each.key}`, async (context) => {
    const state = await transferState(context, each);
    const { made, bridge, parked, shown } = state;
    const { host, rewind } = made;
    const history = rewind.state.value.history!;
    const before = { lineage: shownView(host).lineage, inspection: rewind.state.value.inspection };
    const acted = await runTransfer(context, each, state);
    await settle(context);
    const alive = {
      parked: await heldInHost(bridge, parked.id),
      shown: shown === null ? false : await heldInHost(bridge, shown.id),
    };
    const expect = each.expect;
    if (expect.kind !== "transfer") {
      assert.deepEqual(alive, { parked: true, shown: shown !== null }, "no lineage released");
      if (expect.kind === "unchanged" && each.transition.startsWith("close")) {
        // The history closes with no lineage parked: nothing to transfer.
        assert.equal(rewind.state.value.inspection, null);
      } else {
        assert.equal(acted, false, "the page changes nothing");
        assert.equal(shownView(host).lineage, before.lineage, "the same state shows");
        assert.deepEqual(rewind.state.value.inspection, before.inspection, "the same inspection");
      }
      const raw = expect.kind === "refused" ? rawTransfer(each, history, parked) : null;
      if (raw !== null) {
        const reply = await bridge.client.request(raw.op, raw.args);
        // EVIDENCE: validation: the history ops reply from the same build with a `HistoryOpResult`.
        assert.equal(
          (reply.result as { readonly kind: string }).kind,
          "refused",
          "the host refuses",
        );
      }
    } else {
      const page = host.session.value === null ? null : shownView(host);
      const inspection = rewind.state.value.inspection;
      const parkedFate = !alive.parked
        ? "released"
        : page?.lineage === parked.lineage && !host.rewind.inspecting.value
          ? "live"
          : before.inspection === null
            ? "parked"
            : "kept";
      const showsNew =
        page !== null && page.lineage !== parked.lineage && page.lineage !== shown?.lineage;
      const shownFate =
        showsNew && host.rewind.inspecting.value
          ? each.transition === "forward"
            ? "future"
            : "target"
          : shown === null || !alive.shown
            ? "released"
            : host.rewind.adopting.value
              ? "adopting"
              : page?.lineage === shown.lineage && host.rewind.inspecting.value
                ? "inspecting"
                : "live";
      assert.deepEqual(
        { parked: parkedFate, shown: shownFate },
        { parked: expect.parked, shown: expect.shown },
      );
      // What a step shows is the state it names: Back's target point, or the state Forward restores.
      if (shownFate === "target")
        assert.equal(inspection?.shown.id, rewind.state.value.points[0]!.id);
      if (shownFate === "future")
        assert.equal(inspection?.shown.eventCount, before.inspection?.future?.eventCount);
    }
    transfersRun.add(each.key);
  });

test("the transfer family ran every obligation of the declared domain, and nothing else", () => {
  assert.equal(TRANSFERS.length, 72);
  assert.deepEqual(transferCoverage(TRANSFERS, transfersRun), { missing: [], unexpected: [] });
});

/*
 * L5i.6's handoff, by the lifecycle grammar (`tests/helpers/rewind-lifecycle.ts`): each schedule holds one step or
 * adoption at one boundary, inserts one lifecycle event there, lets the operation go, and compares the quiescent page
 * and host with the grammar's independent oracle: what shows, and is usable through a real host read; which sessions
 * the host holds; the recording the debug export takes; and the timeline, which is the host's.
 */
const LIFECYCLE_CASES = lifecycleCases();
/**
 * `value` as JSON, one field a line: a snapshot or a recording compared by content, whatever prototypes its copy has;
 * a difference shows as the lines that differ.
 */
const plain = <T extends Readonly<Record<string, unknown>>>(value: T): string =>
  JSON.stringify(value, null, 1);
const lifecycleRun: Coordinates[] = [];

/** The rewind owner's methods a caller mutant replaces: each is called through the owner (`usePlayerSession.ts`). */
interface MutableOwner {
  adoptionBegun: () => boolean;
  adoptionSettled: (succeeded: boolean) => boolean;
  newSession: () => readonly LifecycleAction[];
}

for (const each of LIFECYCLE_CASES)
  test(`a rewind handoff: ${Object.values(each).join(", ")}`, (context) =>
    handoffRow(context, each));

/** One schedule of the lifecycle grammar; `mutate`, a caller mutant, changes the real owner first. */
async function handoffRow(
  context: TestContext,
  each: LifecycleCase,
  mutate?: (owner: MutableOwner) => void,
  /** A negative control of the candidate's state: the target captured with a wrong saved value. */
  wrongTarget = false,
): Promise<void> {
  {
    const local = each.operation === "adopt session-local";
    const gated = each.operation === "Return" || each.operation === "reinstate";
    const storage = local ? null : memoryStorage();
    const made = createHost(context, storage?.provider ?? deniedStorage(), {
      lossy: each.event === "loss",
    });
    const { host, rewind } = made;
    // The owner is a plain object, whose methods the composable calls through it.
    mutate?.(host.rewind.owner);
    const want = expectation(each);
    // An adoption that succeeds adopts by its answer, so the session runs on from the restored state; after a loss its
    // completion is refused, and nothing runs on.
    const adopted = each.operation.startsWith("adopt") && each.outcome === "succeeds" && !want.lost;
    // Traced, so a restart shows as a new epoch of the value trace.
    host.setDebugTracing(true);
    // Each shown state as the page showed it, captured apart from the history: the first point Back restores, and the
    // tip Forward does.
    const shownStates: { readonly snapshot: RuntimeSnapshot; readonly sceneTimeMs: number }[] = [];
    const capture = () => {
      const page = shownView(host);
      shownStates.push({
        snapshot: playerRuntimeSnapshot(page),
        sceneTimeMs: page.state.observedSessionTimeMs,
      });
    };
    await start(context, host);
    capture();
    await choose(context, host, "One");
    capture();
    await choose(context, host, "Red");
    capture();
    // A clear is admitted only once the session ended.
    if (each.event === "clear on an ended session") {
      await choose(context, host, "A");
      assert.equal(host.session.value?.state.status, "halted");
      capture();
    }
    const bridge = await host.bridge;
    const live = shownView(host);
    let restored: PlayerSession | null = null;
    if (each.operation !== "back") {
      assert.equal(await backTo(rewind, 1), true);
      await settle(context);
      restored = shownView(host);
    }
    // The candidates the host prepares, from their replies, and the adoptions' captures, by their requests.
    const candidates: string[] = [];
    let captures = 0;
    const replaces = () => storage?.calls.filter((call) => call === "replace").length ?? 0;
    const request = bridge.client.request.bind(bridge.client);
    context.mock.method(bridge.client, "request", async (...args: Parameters<typeof request>) => {
      if (args[0] === "captureStorage") captures += 1;
      const reply = await request(...args);
      if (
        (args[0] === "rewindBack" || args[0] === "rewindForward") &&
        typeof reply.session === "string"
      )
        candidates.push(reply.session);
      return reply;
    });
    // The hold: a step's snapshot read or its restart gate, or an adoption's saved-data write; `reached` says whether
    // the operation arrived there.
    let release: () => void;
    let reached: () => boolean;
    let acknowledged: Promise<void> = Promise.resolve();
    const arrival = (arrived: Promise<void>) => {
      let at = false;
      void arrived.then(() => (at = true));
      return () => at;
    };
    if (each.boundary === "read") {
      const held = made.holdGets();
      release = held;
      reached = held.reached;
    } else if (each.boundary === "acknowledgement") {
      const held = holdRead(context, bridge, "rewindCommit", "reply", false);
      acknowledged = held.arrived;
      reached = arrival(held.arrived);
      release = held.release;
    } else if (each.boundary === "gate") {
      let open!: () => void;
      let at = false;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const original = host.rewind.beforeRestart.bind(host.rewind);
      host.rewind.beforeRestart = async () => {
        at = true;
        await gate;
        if (gated && each.outcome === "fails") throw new Error("The restart gate failed.");
        await original();
      };
      release = () => open();
      reached = () => at;
    } else if (local) {
      // Saved data that live only in the session: held where the adoption reads them; a failing one fails that read.
      const held = holdRead(context, bridge, "captureStorage", "reply", each.outcome === "fails");
      release = held.release;
      reached = arrival(held.arrived);
    } else {
      // The provider's replacement, admitted and held; a failing one fails there.
      // The import's own replacement, later, is not the adoption's and succeeds.
      if (each.outcome === "fails") storage!.failNextReplace();
      const held = storage!.holdReplaces();
      release = held;
      reached = held.reached;
    }
    const recordingBefore = host.debugRecording();
    const epochBefore = hostTrace(bridge)!.status().epoch;
    // What each identity is before the operation, and the events a step restores as the history names them: Back's
    // first point, or the state Forward restores.
    const before = {
      live: { snapshot: playerRuntimeSnapshot(live), events: live.events, marks: live.marks },
      restored:
        restored === null
          ? null
          : {
              snapshot: playerRuntimeSnapshot(restored),
              events: restored.events,
              marks: restored.marks,
            },
    };
    const history = host.rewind.owner.view.value!;
    const target =
      each.operation === "forward"
        ? history.timeline.inspection?.future
        : history.timeline.points[0];
    const targetEvents = target === undefined || target === null ? null : history.eventsAt(target);
    if (!each.operation.startsWith("adopt")) assert.ok(targetEvents !== null, "the step's target");
    const replacesBefore = replaces();
    let inputAdmitted: boolean | null = null;
    const operation: Promise<unknown> =
      each.operation === "forward"
        ? rewind.forward()
        : each.operation === "Return"
          ? rewind
              .returnToSession()
              .then((returned) =>
                assert.equal(
                  returned,
                  each.outcome === "succeeds" && !want.lost && each.event !== "disposal",
                  "returned",
                ),
              )
          : each.operation === "reinstate"
            ? Promise.resolve(made.debug.stop())
            : each.operation.startsWith("adopt")
              ? (async () => {
                  // The answer adopts the restored state; it is evaluated only if its input is admitted.
                  // A preparation that rejects (its host lost) admits nothing either.
                  inputAdmitted = await Promise.resolve(host.prepareInput()).catch(() => false);
                  if (!inputAdmitted) return;
                  const session = host.session.value!;
                  const foreground = playerRuntimeForeground(session);
                  assert.ok(foreground?.kind === "choose");
                  host.update(
                    selectPlayerRuntimeChoice(session, foreground.options[1]!.id)!.session,
                  );
                })()
              : backTo(rewind, 0);
    await settle(context);
    // The commit's reply is held only once the page accepted the step.
    await acknowledged;
    assert.equal(reached(), true, "the operation reached its hold");
    // The event, while the operation is held.
    let atError: RuntimeSnapshot | null = null;
    let event: Promise<unknown> = Promise.resolve();
    switch (each.event) {
      case "publication":
        context.mock.timers.tick(1_000);
        event = host.observe();
        break;
      case "Return":
        event = rewind.returnToSession().then((returned) => assert.equal(returned, false));
        break;
      case "clear":
      case "clear on an ended session":
        event = host
          .clearScriptStorage()
          .then((cleared) => assert.equal(cleared, want.clears, "the clear's admission"));
        break;
      case "Player error":
        host.reportHostError(new Error("A Player error."));
        await settle(context);
        atError = playerRuntimeSnapshot(host.session.value!);
        break;
      case "Start prepared":
        host.prepare((recording) =>
          createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
        );
        break;
      case "Debug off":
        made.debug.stop();
        break;
      case "Debug off and on": {
        made.debug.stop();
        const again = effectScope();
        again.run(() => useDebugRewind(host));
        context.after(() => again.stop());
        break;
      }
      case "replacement":
        // A Start that shows its session before the hold is let go.
        await host.loadScriptStorage();
        host.prepare((recording) =>
          createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
        );
        event = Promise.resolve(host.activate());
        break;
      case "import ending the session": {
        // Reviewed first, so the import ends the session before the hold is let go.
        const review = await host.reviewSavedDataImport({
          scripts: [{ scope: "test", name: null, photos: [], entries: [] }],
          images: [],
        });
        event = host.importSavedData(review, new Set(["test"]));
        break;
      }
      case "disposal":
        rewind.endWithPlayer();
        made.debug.stop();
        made.scope.stop();
        break;
      // Attempts to adopt while the return waits: refused, they read, write and evaluate nothing.
      case "answer":
        event = Promise.resolve(host.prepareInput()).then((prepared) =>
          assert.equal(prepared, false, "the answer is refused"),
        );
        break;
      case "Resume":
        event = rewind
          .resume()
          .then((resumed) => assert.equal(resumed, false, "Resume is refused"));
        break;
      case "loss":
        made.lose!();
        break;
    }
    release();
    // A gated operation's own assertion stands; a step's or an adoption's rejection is its outcome, compared below.
    await (gated ? operation : operation.catch(() => false));
    await event;
    await settle(context);
    // An adoption's answer is admitted only where the adoption runs on: a completion the owner refused admits none.
    if (each.operation.startsWith("adopt"))
      assert.equal(inputAdmitted, want.recording === "continued", "the answer's input admitted");
    // A refused attempt read nothing in the host and replaced no saved data.
    if (each.event === "answer" || each.event === "Resume")
      assert.deepEqual(
        { captures, replaces: replaces() - replacesBefore },
        { captures: 0, replaces: 0 },
        "a refused attempt's effects",
      );

    const page = host.session.value === null ? null : shownView(host);
    const candidate = candidates.at(-1) ?? null;
    const lineages = { live: live.lineage, restored: restored?.lineage };
    if (want.shows !== "none") {
      assert.ok(page !== null, "a session shows");
      const shown =
        page.lineage === lineages.live
          ? "live"
          : page.lineage === lineages.restored
            ? "restored"
            : page.id === candidate
              ? "candidate"
              : "new";
      assert.equal(shown, want.shows, "the session shown");
      assert.equal(host.rewind.inspecting.value, want.inspecting, "inspected");
      // Shown on the surviving bridge: usable through a real host read, at the revision it shows.
      if (!want.lost)
        assert.equal((await bridge.read(page, "captureStorage")).revision, page.revision);
      // The state the session shows is the one it was: a candidate shows its target's events with one rewind more;
      // a live or restored session shows its own state, events and marks unchanged. A new session's state is the
      // Start's, which this family does not compare.
      if (shown === "candidate") {
        assert.deepEqual(page.events, targetEvents, "the target's events");
        // Its state is the target's as the page showed it, and its marks one rewind of it.
        const target = shownStates[each.operation === "forward" ? shownStates.length - 1 : 0]!;
        const expected = wrongTarget
          ? {
              ...target.snapshot,
              scriptStorage: target.snapshot.scriptStorage.map((entry) =>
                entry.key === "k" ? { ...entry, value: 999 } : entry,
              ),
            }
          : target.snapshot;
        assert.equal(
          plain({ at: playerRuntimeSnapshot(page) }),
          plain({ at: expected }),
          "the target's state",
        );
        assert.deepEqual(
          plain({ marks: page.marks }),
          plain({
            marks: {
              editedWhileDebugging: null,
              rewoundWhileDebugging: { restoredSceneTimeMs: target.sceneTimeMs, rewindCount: 1 },
            },
          }),
          "the candidate's marks",
        );
      } else if (shown === "restored" && adopted) {
        // Adopted by its answer: the restored session's events, then the answer's.
        const was = before.restored!;
        assert.deepEqual(
          page.events.slice(0, was.events.length),
          was.events,
          "the restored events",
        );
        assert.notEqual(
          plain({ at: playerRuntimeSnapshot(page) }),
          plain({ at: was.snapshot }),
          "the answer's state",
        );
      } else if (shown !== "new") {
        const was = before[shown]!;
        // After a loss its state is no longer the host's to read: its events and marks still are the page's.
        assert.deepEqual(
          plain({
            ...(want.lost ? {} : { snapshot: playerRuntimeSnapshot(page) }),
            events: page.events,
            marks: page.marks,
          }),
          plain({
            ...(want.lost ? {} : { snapshot: was.snapshot }),
            events: was.events,
            marks: was.marks,
          }),
          "the session shown, unchanged",
        );
      }
    }
    const ids: Record<"live" | "restored" | "candidate", string | null> = {
      live: live.id,
      restored: restored?.id ?? null,
      candidate,
    };
    for (const identity of ["live", "restored", "candidate"] as const) {
      const held = want.held[identity];
      if (held === undefined) continue;
      const id = ids[identity];
      if (id === null) assert.equal(held, false, `${identity} was never made`);
      else assert.equal(await heldInHost(bridge, id), held, `the host holds ${identity}`);
    }
    // The recording begun once at the shown session, with nothing recorded since; or the one before, unchanged.
    const recording = host.debugRecording();
    // Read only where a recording is compared: the Player's end takes the trace with it.
    const epochs = () => hostTrace(bridge)!.status().epoch - epochBefore;
    if (want.recording === "shown") {
      const at = playerRuntimeSnapshot(page!);
      assert.deepEqual(
        plain({
          anchor: recording?.anchorSnapshot,
          end: recording?.endSnapshot,
          operations: recording?.operations,
          complete: recording?.complete,
          epochs: epochs(),
        }),
        plain({ anchor: at, end: at, operations: [], complete: true, epochs: want.restarts ?? 1 }),
        "begun once at the shown session",
      );
    }
    if (want.recording === "continued") {
      // The same recording, run on by the answer: its anchor, and its operations before, then the answer's.
      const was = recordingBefore!.operations;
      assert.deepEqual(
        plain({
          anchor: recording?.anchorSnapshot,
          operations: recording?.operations.slice(0, was.length),
          epochs: epochs(),
        }),
        plain({ anchor: recordingBefore?.anchorSnapshot, operations: was, epochs: 0 }),
        "the recording before it, run on",
      );
      assert.ok(recording!.operations.length > was.length, "the answer is recorded");
    }
    if (want.recording === "kept")
      assert.deepEqual(
        plain({ recording, epochs: epochs() }),
        plain({ recording: recordingBefore, epochs: 0 }),
        "the recording before it",
      );
    if (want.recording === "error")
      assert.deepEqual(recording?.endSnapshot, atError, "the recording up to the error");
    // The page's timeline is the host's, and every point's log resolves from a session the page holds.
    const view = host.rewind.owner.view.value;
    if (want.lost) assert.ok(view !== null, "the history's view stays, read-only");
    else if (want.history) {
      assert.ok(view !== null, "a history is open");
      const timeline = await bridge.historyTimeline(view.timeline.history);
      assert.ok(timeline !== null, "the host holds the history");
      assert.deepEqual(view.timeline.inspection, timeline.inspection);
      assert.deepEqual(view.timeline.points, timeline.points);
      // Every retained position's log resolves: each point, and the shown and future states of an inspection.
      const { inspection } = view.timeline;
      for (const position of [
        ...view.timeline.points,
        ...(inspection === null ? [] : [inspection.shown]),
        ...(inspection?.future == null ? [] : [inspection.future]),
      ])
        assert.ok(
          view.eventsAt(position) !== null,
          `the log at ${JSON.stringify(position)} resolves`,
        );
    } else assert.equal(view, null, "no history is open");
    // The return's state, which the Player shows, and a failed reinstatement retried through the same gate.
    if (gated && !want.lost && (want.shows === "live" || want.shows === "restored")) {
      const failed = each.operation === "reinstate" && each.outcome === "fails";
      assert.equal(
        host.rewind.owner.reinstatement.value,
        failed ? "failed" : null,
        "the return's state",
      );
      if (failed) {
        host.rewind.beforeRestart = async () => {};
        assert.equal(host.rewind.owner.retryReturn(), true, "retried");
        await settle(context);
        assert.equal(shownView(host).lineage, live.lineage, "reinstated on the retry");
        assert.equal(host.rewind.inspecting.value, false, "no longer inspected");
      }
    }
    if (mutate === undefined) lifecycleRun.push(each);
  }
}

/*
 * The caller seam's negative controls (design-r2 §2): each mutant changes the real owner as the composable calls it,
 * and the named row must fail.
 */
const CALLER_MUTANTS: readonly {
  readonly name: string;
  readonly row: LifecycleCase;
  readonly mutate: (owner: MutableOwner) => void;
}[] = [
  {
    name: "an adoption the owner refused proceeds",
    row: { operation: "reinstate", boundary: "gate", outcome: "succeeds", event: "answer" },
    mutate: (owner) => void (owner.adoptionBegun = () => true),
  },
  {
    // Page flow cannot make a write succeed while the owner refuses its completion (the page's `ownsShown` stops each
    // such path first), so the caller's branch is decided by refusing an otherwise successful completion: the caller
    // must then activate nothing, and the row, which expects the adoption to run on, fails.
    name: "a completion the owner refuses activates nothing",
    row: {
      operation: "adopt persistent",
      boundary: "provider",
      outcome: "succeeds",
      event: "none",
    },
    mutate: (owner) => {
      const settle = owner.adoptionSettled;
      owner.adoptionSettled = (succeeded) => {
        settle(succeeded);
        return false;
      };
    },
  },
  {
    name: "the page keeps a stale inspection",
    row: { operation: "back again", boundary: "gate", outcome: "none", event: "replacement" },
    mutate: (owner) => void (owner.newSession = () => []),
  },
];

test("a candidate restored with a wrong saved value fails its row (negative control)", async (context) => {
  const row: LifecycleCase = {
    operation: "back",
    boundary: "read",
    outcome: "none",
    event: "none",
  };
  await assert.rejects(handoffRow(context, row, undefined, true), assert.AssertionError);
});

test("the caller seam's mutants each fail their row", async (context) => {
  for (const { name, row, mutate } of CALLER_MUTANTS) {
    assert.equal(excluded(row), null, `${name}: a schedule of the grammar`);
    await context.test(name, async (subtest) => {
      await assert.rejects(handoffRow(subtest, row, mutate), assert.AssertionError);
    });
  }
});

test("the handoff family ran every schedule of the lifecycle grammar, with its exclusions reasoned", () => {
  const feasible = product(LIFECYCLE).filter((each) => excluded(each) === null);
  assert.deepEqual(coverageGaps(feasible, lifecycleRun, { tuples: true }), []);
});

test("Debug off reinstates the session Back left, and the Player's unmount then releases it", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  assert.equal(await backTo(rewind, 0), true);
  const bridge = await host.bridge;
  made.debug.stop();
  await settle(context);
  assert.equal(shownView(host).lineage, tip.lineage, "reinstated");
  made.scope.stop();
  await settle(context);
  assert.equal(await heldInHost(bridge, tip.id), false);
});

test("Debug off waiting on an adoption when the Player unmounts releases everything, whichever scope ends first", async (context) => {
  for (const order of ["Debug first", "Player first"] as const) {
    await context.test(order, async (subtest) => {
      const storage = memoryStorage();
      const made = createHost(subtest, storage.provider);
      const { host, rewind } = made;
      await start(subtest, host);
      await choose(subtest, host, "One");
      const tip = shownView(host);
      assert.equal(await backTo(rewind, 0), true);
      const restored = shownView(host);
      const bridge = await host.bridge;
      const release = storage.holdReplaces();
      const chosen = chooseAt(host, 1);
      await settle(subtest);
      if (order === "Debug first") {
        made.debug.stop();
        made.scope.stop();
      } else {
        made.scope.stop();
        made.debug.stop();
      }
      release();
      await chosen.catch(() => {});
      await settle(subtest);
      assert.deepEqual(
        { parked: await heldInHost(bridge, tip.id), shown: await heldInHost(bridge, restored.id) },
        { parked: false, shown: false },
      );
    });
  }
});

/*
 * Sol code r2's probes (`reviews/l5i6/sol-code-r2.md`), as rows through the real composables and host: each decided by
 * the page side's one function (`player/rewind-lifecycle.ts`) and the host's (`advanceHistory`).
 */

test("Sol r2 B1: Debug off after a commit was sent, before its acknowledgement, reinstates the parked session", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  const bridge = await host.bridge;
  const held = holdRead(context, bridge, "rewindCommit", "reply", false);
  const stepped = backTo(rewind, 0);
  await held.arrived;
  made.debug.stop();
  held.release();
  await stepped;
  await settle(context);
  assert.equal(shownView(host).lineage, tip.lineage, "the parked session shows again");
  assert.equal(
    (await bridge.read(shownView(host), "captureStorage")).revision,
    shownView(host).revision,
  );
});

test("Sol r2 B2: the Player's disposal during Debug off's restart gate releases the parked session", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  assert.equal(await backTo(rewind, 0), true);
  const shown = shownView(host);
  const bridge = await host.bridge;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  host.rewind.beforeRestart = () => gate;
  made.debug.stop();
  await settle(context);
  made.scope.stop();
  open();
  await settle(context);
  assert.deepEqual(
    { parked: await heldInHost(bridge, tip.id), shown: await heldInHost(bridge, shown.id) },
    { parked: false, shown: false },
  );
});

test("Sol r2 B3: a step whose restart gate rejects drops its candidate, and the next step goes", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const bridge = await host.bridge;
  const candidates: string[] = [];
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", async (...args: Parameters<typeof request>) => {
    const reply = await request(...args);
    if (args[0] === "rewindBack" && typeof reply.session === "string")
      candidates.push(reply.session);
    return reply;
  });
  const original = host.rewind.beforeRestart.bind(host.rewind);
  host.rewind.beforeRestart = () => Promise.reject(new Error("The gate failed."));
  assert.equal(await backTo(rewind, 0), false);
  await settle(context);
  assert.equal(await heldInHost(bridge, candidates[0]!), false, "the candidate went");
  host.rewind.beforeRestart = original;
  assert.equal(await backTo(rewind, 0), true, "the next step goes");
});

test("Sol r2 B4: after Resume, Back then Forward restores the adopted session's state from its kept log", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  await choose(context, host, "Red");
  assert.equal(await backTo(rewind, 1), true);
  assert.equal(await rewind.resume(), true);
  await settle(context);
  const adopted = shownView(host);
  assert.equal(await backTo(rewind, 0), true);
  await settle(context);
  assert.ok(rewind.state.value.inspection?.future, "a future to go forward to");
  assert.equal(await rewind.forward(), true);
  await settle(context);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!), playerRuntimeSnapshot(adopted));
});

test("Sol r2 B5: a clear's close that fails on a live connection is reported, and no history opens after it", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host } = made;
  await start(context, host);
  for (const label of ["One", "Red", "A"]) await choose(context, host, label);
  assert.equal(host.session.value?.state.status, "halted");
  const bridge = await host.bridge;
  const sent: string[] = [];
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    if (typeof args[0] === "string" && args[0].startsWith("history")) sent.push(args[0]);
    return args[0] === "historyClose"
      ? Promise.reject(new Error("A host failure."))
      : request(...args);
  });
  const reported: unknown[] = [];
  reportsInto(context, reported);
  assert.equal(await host.clearScriptStorage(), true);
  await settle(context);
  assert.deepEqual(sent, ["historyClose"]);
  assert.equal(reported.length, 1);
});

test("Sol r2 B6: an adoption that succeeds while Debug off waits keeps the recording and the trace's epoch", async (context) => {
  const storage = memoryStorage();
  const made = createHost(context, storage.provider);
  const { host, rewind } = made;
  host.setDebugTracing(true);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const trace = hostTrace(await host.bridge)!;
  const epoch = trace.status().epoch;
  const anchor = host.debugRecording()?.anchorSnapshot;
  let gates = 0;
  const original = host.rewind.beforeRestart.bind(host.rewind);
  host.rewind.beforeRestart = () => {
    gates += 1;
    return original();
  };
  const release = storage.holdReplaces();
  const resumed = rewind.resume();
  await settle(context);
  made.debug.stop();
  release();
  assert.equal(await resumed, true);
  await settle(context);
  assert.deepEqual({ epoch: trace.status().epoch, gates }, { epoch, gates: 0 });
  assert.deepEqual(host.debugRecording()?.anchorSnapshot, anchor);
});

test("Sol r2 S1: an enrollment that fails on a live connection is reported", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host } = made;
  await start(context, host);
  const bridge = await host.bridge;
  const request = bridge.client.request.bind(bridge.client);
  const failure = new Error("A host failure.");
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) =>
    args[0] === "historyEnroll" ? Promise.reject(failure) : request(...args),
  );
  const reported: unknown[] = [];
  reportsInto(context, reported);
  made.debug.stop();
  const again = effectScope();
  again.run(() => useDebugRewind(host));
  context.after(() => again.stop());
  await settle(context);
  assert.deepEqual(reported, [failure]);
});

for (const gateA of ["succeeds", "fails"] as const)
  test(`Sol r5 B1: an obsolete reinstatement gate that ${gateA} decides nothing; the current one reinstates`, async (context) => {
    const reported: unknown[] = [];
    reportsInto(context, reported);
    const made = createHost(context, memoryStorage().provider);
    const { host } = made;
    // The reinstatement gates held, in the order asked; a step's gate goes through as it is.
    const gates: { readonly resolve: () => void; readonly reject: (error: Error) => void }[] = [];
    const original = host.rewind.beforeRestart.bind(host.rewind);
    let holding = false;
    host.rewind.beforeRestart = () =>
      holding
        ? new Promise<void>((resolve, reject) => void gates.push({ resolve, reject }))
        : original();
    await start(context, host);
    await choose(context, host, "One");
    assert.equal(await backTo(made.rewind, 0), true);
    // Debug off: gate A waits.
    holding = true;
    made.debug.stop();
    holding = false;
    await settle(context);
    assert.equal(gates.length, 1);
    // A replacement session, Debug on again, and a later inspection of the new history.
    await host.loadScriptStorage();
    host.prepare((recording) =>
      createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
    );
    await host.activate();
    await settle(context);
    const again = effectScope();
    const rewind = again.run(() => useDebugRewind(host))!;
    context.after(() => again.stop());
    await settle(context);
    await choose(context, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    await settle(context);
    const inspected = shownView(host);
    // Debug off again: gate B waits.
    holding = true;
    again.stop();
    holding = false;
    await settle(context);
    assert.equal(gates.length, 2);
    // A settles: obsolete, it decides nothing, its failure is not reported, and the later inspection stands.
    if (gateA === "succeeds") gates[0]!.resolve();
    else gates[0]!.reject(new Error("Gate A failed."));
    await settle(context);
    assert.deepEqual(reported, [], "nothing reported");
    assert.equal(host.rewind.inspecting.value, true, "still inspected");
    assert.equal(shownView(host).lineage, inspected.lineage, "the later inspection shows");
    // B, the current gate, reinstates.
    gates[1]!.resolve();
    await settle(context);
    assert.equal(host.rewind.inspecting.value, false, "reinstated");
    assert.notEqual(shownView(host).lineage, inspected.lineage);
  });
