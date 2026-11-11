import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, ref, watch, type Ref } from "vue";

import type { RuntimeDebugContext } from "../../src/index.js";
import type * as Adapter from "../../player/runtime/runtime-adapter.js";
import type * as CompileProject from "../../player/runtime/compile-project.js";
import type { PlayerRuntimeSession } from "../../player/runtime/runtime-adapter.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { DebugView, DebugViewRequest } from "../../player/debug/debug-view.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
import {
  hostTrace,
  loadHostFacade,
  onHost,
  onHostAll,
  hostIntroduced,
} from "../helpers/player/host-sessions.js";
import { sourceStart, type PlanStart } from "../helpers/prepared-plan.js";
import { reportsInto } from "../helpers/player/rewind-host.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";

/** The value trace the host's session runs with, as the host holds it. */
const sessionTrace = (session: PlayerRuntimeSession | null | undefined) =>
  session === null || session === undefined
    ? null
    : onHost((held: PlayerRuntimeSession) => held.debugTrace)(session);

/*
 * The Player host runs Debug's value trace (DEBUGGER.md "Player Debug") while Debug is on: Start traces a new session
 * from its first statement, Continue of a restored session begins a new epoch, and off drops the trace and its history.
 */

interface TraceHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  setDebugTracing(on: boolean): void;
  prepare(create: PlanStart): void;
  prepareRestore(restored: PlayerSession): void;
  activate(): void;
  update(session: PlayerRuntimeSession): void;
  reportHostError(error: unknown): void;
  readonly traceId: Readonly<Ref<number | null>>;
  debugView(request: DebugViewRequest): Promise<DebugView | null>;
}
let usePlayerSession: (options: { readonly bridge?: Promise<PlayerBridge> }) => TraceHost;
let useDebugView: (
  player: TraceHost,
  request: () => DebugViewRequest | null,
) => Readonly<Ref<DebugView | null>>;
let createInProcessBackend: typeof InProcess.createInProcessBackend;
// The adapter from the same module graph as the host, whose trace and recorder it must recognize.
let adapter: {
  createPlayerRuntimeSession: typeof CompileProject.createPlayerRuntimeSession;
} & Pick<
  typeof Adapter,
  | "createPlayerRuntimeRestorePoint"
  | "restorePlayerRuntimeSession"
  | "submitPlayerRuntimeComposer"
  | "playerRuntimeSnapshot"
>;

before(async () => {
  await loadHostFacade();
  // Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  const views = await loadPlayerModule("player/vue/src/debug/useDebugView.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its composable.
  useDebugView = views.useDebugView as typeof useDebugView;
  const facade = await loadPlayerModule("player/engine-bridge/in-process.ts");
  // EVIDENCE: validation: the bundle's backend factory, whose host the composable then uses.
  createInProcessBackend = facade.createInProcessBackend as typeof createInProcessBackend;
  const loaded = {
    ...(await loadPlayerModule("player/runtime/runtime-adapter.ts")),
    ...(await loadPlayerModule("player/runtime/compile-project.ts")),
  };
  for (const name of [
    "createPlayerRuntimeSession",
    "createPlayerRuntimeRestorePoint",
    "restorePlayerRuntimeSession",
    "submitPlayerRuntimeComposer",
    "playerRuntimeSnapshot",
  ])
    assert.equal(typeof loaded[name], "function");
  adapter = onHostAll({
    // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
    createPlayerRuntimeSession:
      loaded.createPlayerRuntimeSession as typeof CompileProject.createPlayerRuntimeSession,
    // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
    createPlayerRuntimeRestorePoint:
      loaded.createPlayerRuntimeRestorePoint as typeof Adapter.createPlayerRuntimeRestorePoint,
    // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
    restorePlayerRuntimeSession:
      loaded.restorePlayerRuntimeSession as typeof Adapter.restorePlayerRuntimeSession,
    // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
    submitPlayerRuntimeComposer:
      loaded.submitPlayerRuntimeComposer as typeof Adapter.submitPlayerRuntimeComposer,
    // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
    playerRuntimeSnapshot: loaded.playerRuntimeSnapshot as typeof Adapter.playerRuntimeSnapshot,
  });
});

/** The value trace the host holds now (L5i.3: the connection's, in the engine's host). */
async function traceOf(host: TraceHost): Promise<RuntimeDebugContext | null> {
  return hostTrace(await host.bridge);
}

function createHost(context: TestContext, makeBridge?: () => PlayerBridge): TraceHost {
  // Event targets are the only browser surface these scripts use, with the silent audio elements Start primes.
  const surface = {
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
  for (const [name, value] of Object.entries(surface)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = effectScope();
  // A bridge made after the mock timers, so that its replies wait for them.
  const bridge = makeBridge?.();
  if (bridge !== undefined) context.after(() => bridge.client.terminate());
  const host = scope.run(() =>
    usePlayerSession(bridge === undefined ? {} : { bridge: Promise.resolve(bridge) }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  return host;
}

const SOURCE = [
  'let mood = "calm"',
  'let answer = askText "Ready?"',
  'say "${mood} ${answer}"',
  "exit",
].join("\n");

test("Start traces from the first statement, off drops the trace, and on again attaches", async (context) => {
  const host = createHost(context);
  host.setDebugTracing(true);
  const trace = await traceOf(host);
  assert.ok(trace);
  host.prepare(await sourceStart(host.bridge, SOURCE));
  await host.activate();
  assert.equal(sessionTrace(host.session.value), trace);
  assert.deepEqual([trace.status().origin, trace.status().epoch], ["start", 1]);
  assert.notEqual(
    trace.variableRecord(adapter.playerRuntimeSnapshot(host.session.value!).frames[0]!.id, "mood"),
    null,
  );

  host.setDebugTracing(false);
  assert.equal(await traceOf(host), null);
  assert.equal(sessionTrace(host.session.value), null);

  host.setDebugTracing(true);
  const again = await traceOf(host);
  assert.ok(again && again !== trace);
  host.update(adapter.submitPlayerRuntimeComposer(host.session.value!, "yes")!.session);
  assert.equal(again.status().origin, "attach");
  assert.equal(trace.status().records > 0, true, "the dropped trace is no longer written");
  assert.equal(again.outputs().length, 1);
});

test("Continue of a restored session begins a new trace epoch", async (context) => {
  const host = createHost(context);
  host.setDebugTracing(true);
  const trace = (await traceOf(host))!;
  host.prepare(await sourceStart(host.bridge, SOURCE));
  await host.activate();
  const epoch = trace.status().epoch;
  host.prepareRestore(
    hostIntroduced(
      await host.bridge,
      adapter.restorePlayerRuntimeSession(
        adapter.createPlayerRuntimeRestorePoint(host.session.value!),
      ),
    ),
  );
  await host.activate();
  assert.equal(sessionTrace(host.session.value), trace);
  assert.deepEqual([trace.status().origin, trace.status().epoch], ["restore", epoch + 1]);
  host.update(adapter.submitPlayerRuntimeComposer(host.session.value!, "yes")!.session);
  const [output] = trace.outputs();
  // The restored value's earlier history is not part of the checkpoint.
  const message = trace.record(output!)!;
  const reasons = message.dependencies
    .flatMap((dependency) => trace.record(dependency.id)?.dependencies ?? [])
    .map((dependency) => trace.record(dependency.id)?.detail);
  assert.ok(
    reasons.some((detail) => detail?.kind === "unrecorded" && detail.reason === "restored"),
  );
});

const VIEWED = [
  'let mood = "calm"',
  'say "${mood} now", instant',
  'let answer = askText "Ready?"',
  'say "${mood} ${answer}", instant',
  'let again = askText "More?"',
  "exit",
].join("\n");

/** Recent chat, with the newest message closed and the tree state `trees`. */
const recent = (trees: DebugViewRequest["trees"] = {}): DebugViewRequest => ({
  messages: { limit: 20, openNewest: false },
  selected: null,
  variables: null,
  image: false,
  trees,
});

/** `pending`, settled while the mock clock moves on 50 ms a turn, as replies of a backend on mock time need. */
async function ticking<T>(context: TestContext, pending: Promise<T>): Promise<T> {
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(50);
  }
  return pending;
}

/**
 * A host on a backend whose replies wait 50 ms of mock time, traced, with a view of recent chat that records every view
 * it shows.
 */
async function viewed(context: TestContext) {
  const host = createHost(context, () =>
    createInProcessBackend(
      { commit: null, dirty: null, mode: null, appVersion: null },
      { delayMs: 50 },
    ),
  );
  const settle = async () => {
    for (let round = 0; round < 4; round += 1) {
      for (let turn = 0; turn < 5; turn += 1) await nextTick();
      context.mock.timers.tick(50);
    }
    for (let turn = 0; turn < 5; turn += 1) await nextTick();
  };
  host.setDebugTracing(true);
  host.prepare(await ticking(context, sourceStart(host.bridge, VIEWED)));
  host.activate();
  await settle();
  const request = ref(recent());
  const scope = effectScope();
  const view = scope.run(() => useDebugView(host, () => request.value))!;
  context.after(() => scope.stop());
  const shown: DebugView[] = [];
  watch(view, (next) => next !== null && shown.push(next), { flush: "sync" });
  await settle();
  assert.ok(view.value !== null, "the first view arrived");
  return { host, view, request, shown, settle };
}

test("a view's reply that a newer publication overtook never shows", async (context) => {
  const { host, view, request, shown, settle } = await viewed(context);
  const before = view.value!;
  const root = before.messages!.rows.find((row) => row.kind === "record" && row.expandable)!;
  // The player opens a message: its view is asked for, and its reply is in transit.
  request.value = recent({ recent: { choices: { [root.key]: true }, pages: {} } });
  await nextTick();
  const asked = shown.length;
  // A newer publication shows first, through the transition facade, which delivers the replies in transit before it.
  host.update(adapter.submitPlayerRuntimeComposer(host.session.value!, "yes")!.session);
  const newer = host.session.value!.revision;
  assert.ok(newer > before.revision);
  await settle();
  // The opened view of the older publication never showed; the newer publication's did, opened.
  const later = shown.slice(asked);
  assert.ok(
    later.every((made) => made.revision === newer),
    JSON.stringify(later.map((made) => made.revision)),
  );
  assert.equal(view.value?.revision, newer);
  const opened = view.value!.messages!.rows.find((row) => row.key === root.key);
  assert.ok(opened?.kind === "record" && opened.expanded);
});

test("a view's reply of a trace turned off and on again never shows", async (context) => {
  const { host, view, request, shown, settle } = await viewed(context);
  const first = view.value!.traceId;
  assert.notEqual(first, null);
  request.value = recent({ recent: { choices: {}, pages: {} } });
  await nextTick();
  host.setDebugTracing(false);
  host.setDebugTracing(true);
  const asked = shown.length;
  await settle();
  assert.ok(shown.slice(asked).every((made) => made.traceId !== first));
  assert.notEqual(view.value?.traceId, first);
  assert.equal(view.value?.traceId, host.traceId.value);
});

test("a session a Player error stopped is still viewed as it stopped", async (context) => {
  const { host, view, request, settle } = await viewed(context);
  const before = view.value!;
  const reported: unknown[] = [];
  reportsInto(context, reported);
  const failure = new TypeError("A component failed.");
  host.reportHostError(failure);
  assert.deepEqual(reported, [failure]);
  await settle();
  // Its view is asked for again, from the stopped session, and shows what it showed.
  request.value = recent({ recent: { choices: {}, pages: { none: 2 } } });
  await settle();
  assert.deepEqual(view.value?.messages, before.messages);
  const direct = host.debugView(recent());
  await settle();
  assert.deepEqual(await direct, { ...before, revision: view.value!.revision });
});
