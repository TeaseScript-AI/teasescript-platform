import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";
import { createServer } from "vite";

import type { DebugHistoryPoint, DebugHistorySpill } from "../player/debug-history.js";
import type { DebugRecorder } from "../player/debug-recorder.js";
import {
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  selectPlayerRuntimeChoice,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { RuntimeSnapshot, SerializableRuntimeValue } from "../src/index.js";

// Debug's rewind through the Player's real session host (DEBUGGER.md "Rewind"): Back shows an earlier state for
// inspection without running it or touching saved data; new input adopts it as the session, with its saved data.

interface RewindHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string }[]>>;
  readonly rewind: {
    readonly inspecting: Readonly<Ref<boolean>>;
    readonly canRewind: Readonly<Ref<boolean>>;
  };
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: (recording: { readonly recorder: DebugRecorder }) => PlayerRuntimeSession): void;
  activate(): void;
  update(session: PlayerRuntimeSession): void;
  prepareInput(): true | Promise<boolean>;
  editSavedData(edit: {
    key: string;
    value: SerializableRuntimeValue;
    expected: SerializableRuntimeValue | undefined;
  }): Promise<{ readonly kind: string }>;
  observe(): PlayerRuntimeSession | null;
  debugRecording(): {
    readonly anchorSnapshot: RuntimeSnapshot;
    readonly endSnapshot: RuntimeSnapshot;
  } | null;
  debugExportCandidate(
    player: Record<string, never>,
  ): Promise<{
    readonly rewoundWhileDebugging: { restoredSceneTimeMs: number; rewindCount: number } | null;
  }>;
}
interface Rewind {
  readonly state: Readonly<
    Ref<{
      readonly points: readonly DebugHistoryPoint[];
      readonly inspection: { readonly points: number; readonly canForward: boolean } | null;
    }>
  >;
  back(index: number): Promise<boolean>;
  forward(): Promise<boolean>;
  resume(): Promise<boolean>;
  returnToSession(): boolean;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  debugHistorySpill: () => Promise<DebugHistorySpill | null>;
}) => RewindHost;
let useDebugRewind: (player: RewindHost) => Rewind;

before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    // No HMR websocket: parallel test runs must not compete for its default port.
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const session: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerSession.ts",
    );
    const rewind: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/useDebugRewind.ts",
    );
    assert.equal(typeof session.usePlayerSession, "function");
    assert.equal(typeof rewind.useDebugRewind, "function");
    // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
    usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
    // EVIDENCE: validation: as above.
    useDebugRewind = rewind.useDebugRewind as typeof useDebugRewind;
  } finally {
    await server.close();
  }
});

/** Saved data in memory, recording each provider call; `replace` can be made to fail. */
function memoryStorage() {
  const entries = new Map<string, SerializableRuntimeValue>();
  const calls: string[] = [];
  let failReplace = false;
  let replaceHeld: Promise<void> | null = null;
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
      await replaceHeld;
      if (failReplace) throw new Error("quota");
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
    /** Holds every write until `release` is called. */
    holdWrites() {
      let release!: () => void;
      writeHeld = new Promise((resolve) => (release = resolve));
      return () => release();
    },
    /** Holds every replacement until `release` is called. */
    holdReplaces() {
      let release!: () => void;
      replaceHeld = new Promise((resolve) => (release = resolve));
      return () => release();
    },
  };
}

function memorySpill() {
  const state = { destroyed: 0 };
  const rows = new Map<number, string>();
  const spill: DebugHistorySpill = {
    put: async (id, json) => void rows.set(id, json),
    get: async (id) => rows.get(id),
    delete: async (ids) => ids.forEach((id) => rows.delete(id)),
    destroy: async () => {
      rows.clear();
      state.destroyed += 1;
    },
  };
  return { spill, state };
}

function createHost(context: TestContext, provider: ScriptStorageProvider) {
  // Event targets are the only browser surface these scripts use; no media elements are created.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const spill = memorySpill();
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ scriptStorage: provider, debugHistorySpill: async () => spill.spill }),
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
  return { host, rewind, debug, scope, spill: spill.state };
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
  'let first = choose "One", "Two"',
  'save first as "pick"',
  'say "first ${first}", instant',
  'let second = choose "Red", "Blue"',
  'say "second ${second}", instant',
  "exit",
].join("\n");

async function start(context: TestContext, host: RewindHost) {
  await host.loadScriptStorage();
  host.prepare(({ recorder }) =>
    createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), recorder }),
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

  assert.equal(await rewind.back(0), true);
  assert.equal(host.rewind.inspecting.value, true);
  assert.deepEqual(said(host), []);
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "choose");
  // Nothing runs on its own while inspecting: no time is observed, and saved data stay as they were.
  const inspected = host.session.value;
  assert.equal(host.observe(), inspected);
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  // The restored state is a diagnostic fork, and its recording begins at it.
  assert.deepEqual((await host.debugExportCandidate({})).rewoundWhileDebugging, {
    restoredSceneTimeMs: inspected!.snapshot.observedSessionTimeMs,
    rewindCount: 1,
  });
  assert.equal(host.debugRecording()?.anchorSnapshot, inspected!.snapshot);

  assert.equal(await rewind.forward(), true);
  assert.deepEqual(host.session.value?.snapshot, tip.snapshot);
  assert.deepEqual(said(host), ["One", "first One"]);
  assert.equal(host.rewind.inspecting.value, true);

  assert.equal(await rewind.back(0), true);
  assert.equal(rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
  assert.equal(host.rewind.inspecting.value, false);
  assert.equal((await host.debugExportCandidate({})).rewoundWhileDebugging, null);
  assert.deepEqual(storage.calls, ["write k", "write pick"]);
});

test("a different choice adopts the restored state: its saved data, then the new writes, and no way back", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await rewind.back(0), true);

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
  assert.equal(rewind.returnToSession(), false);
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
  assert.equal(await rewind.back(0), true);
  assert.equal(await rewind.resume(), true);
  assert.equal(host.rewind.inspecting.value, false);
  assert.deepEqual(storage.saved(), { k: 1 });
  assert.equal(rewind.returnToSession(), false);
});

test("when the saved data cannot be restored, the state stays inspected and Return still reinstates the session", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value;
  assert.equal(await rewind.back(0), true);
  const inspected = host.session.value;
  storage.failReplaces();
  await choose(context, host, "Two");
  assert.equal(host.rewind.inspecting.value, true);
  assert.equal(host.session.value, inspected);
  assert.ok(host.notices.value.some((notice) => notice.key === "rewind-not-adopted"));
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  assert.equal(rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
});

test("turning Debug off while inspecting reinstates the session and deletes the history", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug, spill } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value;
  assert.equal(await rewind.back(0), true);
  debug.stop();
  assert.equal(host.session.value, tip);
  assert.equal(host.rewind.inspecting.value, false);
  await settle(context);
  assert.equal(spill.destroyed, 1);
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
  assert.equal(await rewind.back(0), false);
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
      assert.equal(await rewind.back(0), true);
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
  assert.equal(await rewind.back(0), true);
  const inspected = host.session.value!;
  const events = inspected.events.length;
  storage.failReplaces();
  await choose(context, host, "Two");
  assert.equal(host.session.value, inspected);
  assert.deepEqual(said(host), []);
  assert.equal(inspected.events.length, events);
  assert.equal(host.debugRecording()?.endSnapshot, inspected.snapshot);
});

test("a second input while the state is being adopted is refused, and the first applies once", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await rewind.back(0), true);
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
  assert.equal(await rewind.back(0), false);
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
  assert.equal(await rewind.back(0), true);
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
