/*
 * The rewind tests' shared host (`player-session-rewind`, `-transfer`, `-handoff`, `-activations`): the composable on its
 * in-process engine with Debug's rewind, its storage and spill, and the reads and holds the families share.
 */

import assert from "node:assert/strict";
import { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";
import type { HistoryPoint } from "../../../player/engine-bridge/history/core.js";
import type { DebugHistorySpill } from "../../../player/engine-bridge/history/snapshots.js";
import type { DebugHistoryView } from "../../../player/debug/debug-history.js";
import type { LifecycleAction } from "../../../player/debug/rewind-lifecycle.js";
import type { DebugRecorder } from "../../../player/debug/debug-recorder.js";
import {
  selectPlayerRuntimeChoice as rawSelectPlayerRuntimeChoice,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
  playerRuntimeSnapshot as rawPlayerRuntimeSnapshot,
} from "../../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../../player/runtime/compile-project.js";
import {
  playerRuntimeForeground,
  type PlayerSession,
} from "../../../player/runtime/runtime-view.js";
import type { ScriptStorageProvider } from "../../../player/persistence/script-storage.js";
import type { KeptRoomStore } from "../../../player/persistence/kept-sessions.js";
import type { RuntimeSnapshot, SerializableRuntimeValue } from "../../../src/index.js";
import type { RuntimeDebugContext } from "../../../src/runtime/debug/debug-trace.js";
import { published } from "../debug-readers.js";
import { loadPlayerModule } from "../player-modules.js";
import { loadHostFacade, onHost } from "./host-sessions.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import type * as ClientModule from "../../../player/engine-bridge/client.js";

// The adapter's functions, also on the sessions the composables' host holds (`helpers/player/host-sessions.ts`).
export const selectPlayerRuntimeChoice = onHost(rawSelectPlayerRuntimeChoice);
export const playerRuntimeSnapshot = onHost(rawPlayerRuntimeSnapshot);

// Debug's rewind through the Player's real session host (DEBUGGER.md "Rewind"): Back shows an earlier state for
// inspection without running it or touching saved data; new input adopts it as the session, with its saved data.

/** What reviewing an import gives, which the import then takes; these tests do not read it. */
interface ImportReview {
  readonly scripts: readonly object[];
}
export interface RewindHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string }[]>>;
  readonly rewind: {
    readonly inspecting: Readonly<Ref<boolean>>;
    readonly canRewind: Readonly<Ref<boolean>>;
    readonly adopting: Readonly<Ref<boolean>>;
    beforeRestart(): void | Promise<void>;
    /** The Player's rewind owner (`rewindOwner.ts`): the history view it shows, and its public state. */
    readonly owner: {
      readonly view: Readonly<Ref<DebugHistoryView | null>>;
      readonly problem: Readonly<Ref<string | null>>;
      readonly busy: Readonly<Ref<boolean>>;
      readonly inspecting: Readonly<Ref<boolean>>;
      readonly showing: boolean;
      readonly state: { readonly sealed: "disposal" | "loss" | null; readonly blocked: boolean };
      readonly reinstatement: Readonly<Ref<"pending" | "failed" | null>>;
      retryReturn(): boolean;
    } & MutableOwner;
  };
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(
    create:
      | ((recording: {
          readonly recorder: DebugRecorder;
          readonly debugTrace?: RuntimeDebugContext;
        }) => PlayerRuntimeSession)
      | { readonly plan: string; readonly options: () => PlayerRuntimeSessionOptions },
  ): void;
  activate(): void;
  prepareRestore(given: PlayerRuntimeSession): void;
  reportHostError(error: unknown): void;
  setDebugTracing(on: boolean): void;
  readonly hostError: Readonly<Ref<string | null>>;
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
    details: () => Record<string, never>,
    wanted: AbortSignal,
  ): Promise<{
    readonly session: {
      readonly snapshot: RuntimeSnapshot;
      readonly events: readonly { readonly sequence: number }[];
      readonly transcriptEntries: readonly { readonly text: string }[];
    } | null;
    readonly recording: {
      readonly operations: readonly { readonly kind: string; readonly thrown: string | null }[];
      readonly complete: boolean;
    } | null;
    readonly rewoundWhileDebugging: { restoredSceneTimeMs: number; rewindCount: number } | null;
    readonly editedWhileDebugging: { firstEditSceneTimeMs: number; editCount: number } | null;
    readonly hostError: string | null;
    release(): void;
  }>;
}
export interface Rewind {
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
  /** Why the last rewind step changed nothing, or `null`. */
  readonly problem: Readonly<Ref<string | null>>;
  back(point: number): Promise<boolean>;
  forward(): Promise<boolean>;
  resume(): Promise<boolean>;
  returnToSession(): Promise<boolean>;
  endWithPlayer(): void;
}
export let usePlayerSession: (options: {
  bridge?: Promise<PlayerBridge>;
  scriptStorage: ScriptStorageProvider;
  debugHistorySpill: () => Promise<DebugHistorySpill | null>;
  debugRooms?: KeptRoomStore;
}) => RewindHost;
export let useDebugRewind: (player: RewindHost) => Rewind;
/** Collects into `reported` each error the Player reports as a host failure (its `[player] host error` line). */
export function reportsInto(context: TestContext, reported: unknown[]) {
  const write = console.error.bind(console);
  context.mock.method(console, "error", (...args: unknown[]) => {
    if (args[0] === "[player] host error") reported.push(args[1]);
    else write(...args);
  });
}

/** Back to the point at `index` in the history's points, by its ID. */
export const backTo = (rewind: Rewind, index: number) =>
  rewind.back(rewind.state.value.points[index]?.id ?? -1);
// The composable's own in-process backend and the client's loss class, from the modules it loads.
let createInProcessBackend: (build: {
  readonly commit: null;
  readonly dirty: null;
  readonly mode: null;
  readonly appVersion: null;
}) => PlayerBridge;
export let BridgeLostError: typeof ClientModule.BridgeLostError;
// The diagnostic runs and the tickets a bridge of that backend holds (`heldRuns`, `heldTickets`).
export let heldRuns: (bridge: PlayerBridge) => number[];
export let heldTickets: (bridge: PlayerBridge) => string[];
export let usePlayerDebug: (
  player: RewindHost,
  initial: { readonly menu: boolean; readonly autoSkip: boolean },
) => { readonly active: Ref<boolean>; readonly rewind: Readonly<Ref<Rewind | null>> };

before(async () => {
  await loadHostFacade();
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  const rewind: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/debug/history/useDebugRewind.ts",
  );
  const debug: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/debug/usePlayerDebug.ts",
  );
  const facade: Record<string, unknown> = await loadPlayerModule(
    "player/engine-bridge/in-process.ts",
  );
  const client: Record<string, unknown> = await loadPlayerModule("player/engine-bridge/client.ts");
  assert.equal(typeof facade.createInProcessBackend, "function");
  // EVIDENCE: validation: Vite loaded the real source modules; these are the composable's own backend and loss class.
  createInProcessBackend = facade.createInProcessBackend as typeof createInProcessBackend;
  assert.equal(typeof facade.heldRuns, "function");
  // EVIDENCE: validation: as above, its callable facade.
  heldRuns = facade.heldRuns as typeof heldRuns;
  assert.equal(typeof facade.heldTickets, "function");
  // EVIDENCE: validation: as above, its callable facade.
  heldTickets = facade.heldTickets as typeof heldTickets;
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
export function memoryStorage() {
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

export function createHost(
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
export async function settle(context: TestContext) {
  for (let round = 0; round < 4; round += 1) {
    for (let turn = 0; turn < 5; turn += 1) await nextTick();
    context.mock.timers.tick(0);
  }
  for (let turn = 0; turn < 5; turn += 1) await nextTick();
}

export const script = [
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

export async function start(context: TestContext, host: RewindHost) {
  await host.loadScriptStorage();
  host.prepare((recording) =>
    createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
  );
  host.activate();
  await settle(context);
}

// Chooses as the Player's interaction does: the session is readied for input first, and only then is input evaluated.
export async function choose(context: TestContext, host: RewindHost, label: string) {
  if (await host.prepareInput()) {
    const session = host.session.value!;
    const foreground = playerRuntimeForeground(session);
    assert.ok(foreground?.kind === "choose", label);
    const option = foreground.options.find((candidate) => candidate.label === label)!;
    host.update(selectPlayerRuntimeChoice(session, option.id)!.session);
  }
  await settle(context);
}

/** The shown session as the Player holds it: a published view, with its lineage and call view. */
export const shownView = (host: RewindHost): PlayerSession => published(host.session.value);

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
 * `player-adoption-settlement-source.test.ts` sees only how the read's settlement is wired, not what it says.
 */
export const EXIT_AXES = {
  read: ["back", "adopt"],
  hold: ["request", "reply"],
  lifecycle: ["none", "publication", "replaced", "debugOff", "stopped", "disposed", "lost"],
  settlement: ["reply", "rejection"],
} as const;
export type ExitCase = {
  readonly [Axis in keyof typeof EXIT_AXES]: (typeof EXIT_AXES)[Axis][number];
};

/**
 * Holds the first request of `op` on `bridge`: before it is posted (`request`), or after the host answered it (`reply`),
 * until `release()`; then it settles with the host's answer, or rejects (`rejects`).
 */
export function holdRead(
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

/** Saved data that cannot be read, so the session is session-local and an adoption replaces none. */
export function deniedStorage(): ScriptStorageProvider {
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
export function chooseAt(host: RewindHost, index: number): Promise<void> {
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
export async function heldInHost(bridge: PlayerBridge, id: string): Promise<boolean> {
  const reply = await bridge.client.request("captureKeep", { session: id, plan: null });
  // EVIDENCE: validation: `captureKeep` replies from the same build with a `KeepCapture`.
  return (reply.result as { readonly kind: string }).kind !== "gone";
}

/** The rewind owner's methods a caller mutant replaces: each is called through the owner (`session/useSessionRewind.ts`). */
export interface MutableOwner {
  adoptionBegun: () => boolean;
  adoptionSettled: (succeeded: boolean) => boolean;
  newSession: () => readonly LifecycleAction[];
}
