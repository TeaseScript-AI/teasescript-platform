import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, watch, type Ref } from "vue";

import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
import type * as RuntimeAdapter from "../../player/runtime/runtime-adapter.js";
import { startBridgeHost, type HostSession } from "../../player/engine-bridge/worker-host.js";
import { BRIDGE_VERSION } from "../../player/engine-bridge/protocol.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { DebugView, DebugViewRequest } from "../../player/debug/debug-view.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { PlayerRuntimeSessionOptions } from "../../player/runtime/runtime-adapter.js";
import type * as RuntimeView from "../../player/runtime/runtime-view.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { DEFAULT_TEMPORAL_CONTEXT, type TemporalContext } from "../../src/temporal.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import {
  preparedPlan,
  preparedSource,
  sourceStart,
  type PlanStart,
} from "../helpers/prepared-plan.js";
import { deliveryOwner } from "../../player/engine-bridge/delivery.js";
import type { UntypedBridge } from "../helpers/bridge/untyped.js";
import { untypedBridge } from "../helpers/bridge/untyped.js";
import { hostIntroduced, loadHostFacade } from "../helpers/player/host-sessions.js";

/*
 * At a Player error stop, what is shown is what the host ran, which its export and recording hold, and nothing shows
 * after the stop line. An activation a later one replaced, whether queued in the host or with a reply in transit,
 * touches neither the replacement's recorder nor its trace.
 */

interface StopHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly bridge: Promise<PlayerBridge>;
  prepare(create: PlanStart): void;
  prepareRestore(restored: PlayerSession): void;
  activate(): Promise<void>;
  temporalCapture(): PlayerRuntimeSessionOptions;
  debugExportCandidate(
    details: () => { readonly player: object; readonly host: object },
    wanted: AbortSignal,
  ): Promise<{
    readonly session: { readonly transcriptEntries: readonly { readonly text: string }[] } | null;
  }>;
  setDebugTracing(on: boolean): void;
  setDebugMode(enabled: boolean): void;
  readonly traceId: Readonly<Ref<number | null>>;
  debugView(request: DebugViewRequest): Promise<DebugView | null>;
  reportHostError(error: unknown): void;
  observe(): Promise<{ readonly id: string } | null>;
  update(next: PlayerSession): void;
  publishJump(next: PlayerSession): void;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly resolveAsset?: (path: string) => string | null;
  readonly temporalContext?: () => TemporalContext;
  readonly scriptStorage?: ScriptStorageProvider;
  readonly capabilities?: { readonly camera: boolean };
}) => StopHost;
let facade: typeof InProcess;
let useDebugView: (
  player: StopHost,
  request: () => DebugViewRequest | null,
) => Readonly<Ref<DebugView | null>>;
let compiler: typeof CompileProject;
let adapter: typeof RuntimeAdapter;
let view: typeof RuntimeView;

before(async () => {
  await loadHostFacade();
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: the bundle the composable runs in, whose facade reaches its sessions.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
  // EVIDENCE: validation: the bundle's adapter, whose sessions the facade's host holds.
  adapter = (await loadPlayerModule("player/runtime/runtime-adapter.ts")) as typeof adapter;
  // EVIDENCE: validation: the bundle's session view module, from the same module graph.
  view = (await loadPlayerModule("player/runtime/runtime-view.ts")) as typeof view;
  const views = await loadPlayerModule("player/vue/src/debug/useDebugView.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its composable.
  useDebugView = views.useDebugView as typeof useDebugView;
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** A Player on a host that replies after `delayMs`, in a browser surface with event targets and silent audio. */
async function mount(
  context: TestContext,
  delayMs = 50,
  resolveAsset?: (path: string) => string | null,
  temporalContext?: () => TemporalContext,
) {
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
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const bridge = facade.createInProcessBackend(BUILD, { delayMs });
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(bridge),
      debugHistorySpill: async () => null,
      ...(resolveAsset === undefined ? {} : { resolveAsset }),
      ...(temporalContext === undefined ? {} : { temporalContext }),
    }),
  )!;
  context.after(() => {
    scope.stop();
    bridge.client.terminate();
  });
  await player.bridge;
  return { bridge, player, scope };
}

/** A Start of `script` with the clock at 0, compiled in `player`'s host. */
const startOf = (player: { readonly bridge: Promise<PlayerBridge> }, script: string) =>
  sourceStart(player.bridge, script, () => ({ wallClockMs: 0 }));

/** Moves the page's monotonic clock on by `milliseconds` for the rest of the test. */
function later(context: TestContext, milliseconds: number) {
  const now = performance.now() + milliseconds;
  context.mock.method(performance, "now", () => now);
}

/** The scene times the stop line agrees on: what shows, the store, the export and the recording. */
function stopLine(bridge: PlayerBridge, player: StopHost) {
  const shown = player.session.value!;
  return {
    ui: shown.state.observedSessionTimeMs,
    store: bridge.latest(shown)!.state.observedSessionTimeMs,
    export: facade.hatch(shown, (held) => held.state.observedSessionTimeMs),
    recording: facade.heldRecording(bridge)?.endSnapshot?.observedSessionTimeMs ?? null,
  };
}

test("an observation in transit at a stop shows before the stop line, and nothing after it", async (context) => {
  const { bridge, player } = await mount(context);
  player.setDebugTracing(true); // Debug observes in one go, not on a catch-up copy.
  player.prepare(
    await startOf(player, 'wait 1 s\nsay "arrived", instant\nshowButton "Done"\nexit'),
  );
  await player.activate();
  later(context, 1_000);
  const afterStop: number[] = [];
  const stopWatch = watch(
    player.session,
    (session) => {
      if (player.hostError.value !== null) afterStop.push(session!.state.observedSessionTimeMs);
    },
    { flush: "sync" },
  );
  document.dispatchEvent(new Event("visibilitychange"));
  player.reportHostError(
    new TypeError("a component failed while the observation's reply was in transit"),
  );
  const line = stopLine(bridge, player);
  assert.ok(line.ui >= 1_000, "the observation the host ran shows");
  assert.deepEqual([line.store, line.export], [line.ui, line.ui]);
  for (let index = 0; index < 10; index += 1) await turn();
  assert.deepEqual(afterStop, [], "nothing shows after the stop line");
  stopWatch();
});

test("an adoption in transit at a stop shows, as the store and recording hold it", async (context) => {
  const { bridge, player } = await mount(context);
  player.prepare(
    await startOf(player, 'wait 1 s\nsay "caught up", instant\nshowButton "Done"\nexit'),
  );
  await player.activate();
  later(context, 2_000);
  const request = bridge.client.request;
  let stopped!: () => void;
  const stop = new Promise<void>((resolve) => (stopped = resolve));
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const result = request(...args);
    if (args[0] === "adoptCatchUp")
      queueMicrotask(() => {
        player.reportHostError(
          new TypeError("a component failed while the adoption was in transit"),
        );
        stopped();
      });
    return result;
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await stop;
  for (let index = 0; index < 10; index += 1) await turn();
  const line = stopLine(bridge, player);
  assert.ok(line.ui >= 1_000);
  assert.deepEqual([line.store, line.export, line.recording], [line.ui, line.ui, line.ui]);
});

test("a Start queued behind prepare that a Start replaced leaves the recorder to the replacement", async (context) => {
  const { bridge, player } = await mount(context);
  const replacement = await startOf(player, 'say "replacement", instant\nshowButton "New"\nexit');
  const obsolete = compiler.compilePlayerProject(
    'say "obsolete", instant\nshowButton "Old"\nexit',
  ).plan!;
  const token = await preparedPlan(Promise.resolve(bridge), obsolete);
  player.prepare({ plan: token, options: () => ({ wallClockMs: 0 }) });
  const compiling = bridge.client.request("prepare", {
    source: { kind: "source", script: 'showButton "Compile"\nexit' },
  });
  const replaced = player.activate();
  player.prepare(replacement);
  const replacing = player.activate();
  await compiling;
  await replaced;
  await replacing;
  const shown = player.session.value!;
  assert.deepEqual(
    shown.transcriptEntries.map((entry) => entry.text),
    ["replacement"],
  );
  assert.equal(facade.heldRecording(bridge)?.plan, facade.heldPlan(bridge, shown.planToken));
});

test("a Continue a Start replaced while its reply was in transit leaves the replacement's trace as it is", async (context) => {
  const { player, bridge } = await mount(context);
  const fresh = await startOf(
    player,
    'let fresh = 123\nsay "fresh ${fresh}", instant\nshowButton "New"\nexit',
  );
  player.setDebugTracing(true);
  player.prepareRestore(
    hostIntroduced(bridge, compiler.createPlayerRuntimeSession('showButton "Old"\nexit')),
  );
  const continuing = player.activate();
  player.prepare(fresh);
  await player.activate();
  const trace = facade.heldTrace(bridge)!;
  const before = trace.status();
  assert.ok(before.records > 0);
  await continuing;
  for (let index = 0; index < 10; index += 1) await turn();
  const after = trace.status();
  assert.deepEqual(
    [after.epoch, after.origin, after.records],
    [before.epoch, before.origin, before.records],
  );
  assert.deepEqual(
    player.session.value!.transcriptEntries.map((entry) => entry.text),
    ["fresh 123"],
  );
});

/** Calls `then` once `bridge` posts `op`, as the host runs it at once in-process; its reply then is in transit. */
function onceAsked(bridge: PlayerBridge, op: string, then: () => void) {
  // The wrapper forwards each op as it is sent, whatever it is.
  const untyped = untypedBridge(bridge);
  const request = untyped.request.bind(bridge);
  let done = false;
  untyped.request = (...args: Parameters<UntypedBridge["request"]>) => {
    const reply = request(...args);
    if (args[1] === op && !done) {
      done = true;
      then();
    }
    return reply;
  };
}

// L5i.3 moved the trace into the host: a Continue's new epoch is asked for only once the Continue owns the UI, as it
// began before, so one whose recording began in the host but that a Start replaced or a stop ended leaves the trace.
for (const ending of ["replaced", "stopped"] as const)
  test(`a Continue ${ending} after its recording began in the host leaves the trace as it was`, async (context) => {
    const { player, bridge } = await mount(context);
    const fresh = await startOf(
      player,
      'let fresh = 2\nsay "fresh ${fresh}", instant\nshowButton "New"\nexit',
    );
    player.setDebugTracing(true);
    player.prepare(
      await startOf(player, 'let first = 1\nsay "first ${first}", instant\nshowButton "Go"\nexit'),
    );
    await player.activate();
    const trace = facade.heldTrace(bridge)!;
    const before = trace.status();
    assert.ok(before.records > 0);
    let ended = false;
    onceAsked(bridge, "beginRecording", () => {
      ended = true;
      if (ending === "stopped") player.reportHostError(new TypeError("A component failed."));
    });
    player.prepareRestore(
      hostIntroduced(bridge, compiler.createPlayerRuntimeSession('showButton "Old"\nexit')),
    );
    const continuing = player.activate();
    for (let index = 0; index < 5 && !ended; index += 1) await turn();
    assert.ok(ended, "the Continue's recording began in the host");
    if (ending === "replaced") {
      // A Start replaces it while that reply is in transit; it begins its own epoch.
      player.prepare(fresh);
      await player.activate();
    }
    await continuing.catch(() => {});
    for (let index = 0; index < 10; index += 1) await turn();
    const after = trace.status();
    if (ending === "stopped")
      assert.deepEqual(
        [after.epoch, after.origin, after.records],
        [before.epoch, before.origin, before.records],
        "the stopped session's history stays",
      );
    else {
      // Only the replacing Start's epoch: one more than before, from Start, as without the Continue.
      assert.deepEqual([after.epoch, after.origin], [before.epoch + 1, "start"]);
      assert.deepEqual(
        player.session.value!.transcriptEntries.map((entry) => entry.text),
        ["fresh 2"],
      );
    }
  });

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// L5i.3, Sol r1 R1: Debug mode turned on and off again while the first change waits for its reply ends off, as the
// script then reads it.
test("Debug mode turned on and off again before the host answered ends as last asked", async (context) => {
  const { player } = await mount(context, 80);
  player.prepare(
    await startOf(
      player,
      'let answer = askText "Ready?"\nsay "mode ${debugMode}", instant\nshowButton "Done"\nexit',
    ),
  );
  await player.activate();
  player.setDebugMode(true);
  player.setDebugMode(false);
  await pause(400);
  assert.equal(player.session.value!.state.debugMode, false);
  player.update(
    facade.hatch(player.session.value!, (held) => adapter.submitPlayerRuntimeComposer(held, "yes")!)
      .session,
  );
  assert.equal(player.session.value!.transcriptEntries.at(-1)?.text, "mode false");
});

// L5i.3, Sol r1 R3: a view of an older publication does not stay shown once a newer one shows.
test("a shown view of an older publication goes once a newer one shows, until its own view arrives", async (context) => {
  const { player } = await mount(context, 80);
  player.setDebugTracing(true);
  await pause(160);
  player.prepare(
    await startOf(
      player,
      'let mood = "calm"\nsay "${mood}", instant\nlet answer = askText "Ready?"\nsay "${answer}", instant\nshowButton "Done"\nexit',
    ),
  );
  await player.activate();
  const scope = effectScope();
  context.after(() => scope.stop());
  const shown = scope.run(() =>
    useDebugView(player, () => ({
      messages: { limit: 20, openNewest: true },
      selected: null,
      variables: null,
      image: false,
      trees: {},
    })),
  )!;
  await pause(240);
  const before = shown.value!.revision;
  player.update(
    facade.hatch(player.session.value!, (held) => adapter.submitPlayerRuntimeComposer(held, "yes")!)
      .session,
  );
  const newer = player.session.value!.revision;
  assert.ok(newer > before);
  await nextTick();
  assert.equal(shown.value, null, "nothing of the older publication shows");
  await pause(240);
  // Read through a call: the assertion above narrowed the property itself to null.
  const current = () => shown.value;
  assert.equal(current()?.revision, newer);
});

test("a session op still awaited does not delay the halt fence: a request behind it is refused", async () => {
  const replies: unknown[] = [];
  let listen!: (data: unknown) => void;
  let settle!: () => void;
  let ran = 0;
  const session: HostSession = { revision: 0, accepts: () => true };
  const owner = deliveryOwner();
  const sessions = startBridgeHost(
    { post: (reply) => replies.push(reply), listen: (listener) => (listen = listener) },
    {
      waiting: {
        session: "existing",
        checkArguments: (_args): _args is unknown => true,
        run: () => new Promise((resolve) => (settle = () => resolve({ result: "done" }))),
      },
      add: {
        session: "existing",
        checkArguments: (_args): _args is unknown => true,
        run: () => {
          ran += 1;
          return { result: ran };
        },
      },
    },
    BUILD,
    owner,
  );
  // A session the host holds is registered inside a delivery, as an op does.
  const delivery = owner.begin();
  const id = sessions.add(session);
  owner.commit(delivery);
  const send = (requestId: number, op: string) =>
    listen({
      v: BRIDGE_VERSION,
      kind: "request",
      id: requestId,
      session: id,
      basis: 0,
      op,
      args: null,
    });
  send(1, "waiting");
  send(2, "add");
  send(3, "halt");
  settle();
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  assert.equal(ran, 0, "the request behind the awaited op never ran");
  const answered = replies.flatMap((reply) =>
    typeof reply === "object" &&
    reply !== null &&
    "kind" in reply &&
    reply.kind === "reply" &&
    "id" in reply
      ? [[reply.id, "ok" in reply && reply.ok === true]]
      : [],
  );
  // The awaited op's reply, the refusal, then the acknowledgement.
  assert.deepEqual(answered, [
    [1, true],
    [2, false],
    [3, true],
  ]);
});

for (const kind of [
  "start-in-transit",
  "start-queued",
  "continue-queued",
  "continue-begin-in-transit",
  "continue-in-transit",
] as const)
  test(`an error stop while a session begins (${kind}) shows what the host ran, and nothing after the stop line`, async (context) => {
    const { bridge, player } = await mount(context);
    const afterStop: string[] = [];
    const stopWatch = watch(
      player.session,
      (shown) => {
        if (shown !== null && player.hostError.value !== null) afterStop.push(shown.id);
      },
      { flush: "sync" },
    );
    context.after(stopWatch);
    let compiled: Promise<unknown> = Promise.resolve();
    let continueSent!: () => void;
    const sent = new Promise<void>((resolve) => (continueSent = resolve));
    if (kind.startsWith("start")) {
      const plan = compiler.compilePlayerProject(
        'say "started", instant\nshowButton "Next"\nexit',
      ).plan!;
      const token = await preparedPlan(Promise.resolve(bridge), plan);
      player.prepare({ plan: token, options: () => ({ wallClockMs: 0 }) });
      if (kind === "start-queued")
        compiled = bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
    } else {
      player.setDebugTracing(true);
      if (kind === "continue-queued")
        compiled = bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
      player.prepareRestore(
        hostIntroduced(
          bridge,
          compiler.createPlayerRuntimeSession('say "restored", instant\nshowButton "Next"\nexit'),
        ),
      );
      if (kind === "continue-in-transit") {
        const request = bridge.client.request;
        context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
          const result = request(...args);
          if (args[0] === "continue") continueSent();
          return result;
        });
      }
    }
    const beginning = player.activate();
    if (kind === "continue-in-transit") await sent;
    player.reportHostError(new TypeError(`a component failed during ${kind}`));
    await compiled;
    await beginning;
    for (let index = 0; index < 10; index += 1) await turn();
    const shown = player.session.value;
    const recordingAtStop = facade.heldRecording(bridge)?.operations.length ?? null;
    const traceAtStop = facade.heldTrace(bridge)?.status() ?? null;
    for (let index = 0; index < 10; index += 1) await turn();
    assert.deepEqual(afterStop, [], "nothing shows after the stop line");
    assert.equal(player.hostError.value, "TypeError");
    if (shown !== null) {
      assert.equal(bridge.frozen(shown), true, "the stopped session's store froze");
      assert.deepEqual(stopLine(bridge, player).export, shown.state.observedSessionTimeMs);
      const exported = await player.debugExportCandidate(
        () => ({ player: {}, host: {} }),
        new AbortController().signal,
      );
      assert.deepEqual(
        exported.session?.transcriptEntries.map((entry) => entry.text),
        shown.transcriptEntries.map((entry) => entry.text),
      );
    }
    // Nothing of the activation runs after the stop: the recording and trace stay as they stood.
    assert.equal(facade.heldRecording(bridge)?.operations.length ?? null, recordingAtStop);
    assert.deepEqual(facade.heldTrace(bridge)?.status() ?? null, traceAtStop);
  });

test("a Start that replaces an error stop pending on a Start the host rejects runs unstopped", async (context) => {
  const { bridge, player } = await mount(context);
  const next = await startOf(player, 'say "replacement", instant\nshowButton "Next"\nexit');
  // The host holds no such plan, so it rejects the Start.
  player.prepare({ plan: "missing-plan", options: () => ({ wallClockMs: 0 }) });
  const rejected = player.activate();
  player.reportHostError(new TypeError("a component failed while a Start began"));
  assert.equal(player.stopped.value, true, "input stops while the stop waits for the Start");
  player.prepare(next);
  const replacement = player.activate();
  await rejected;
  await replacement;
  for (let index = 0; index < 10; index += 1) await turn();
  const shown = player.session.value;
  assert.deepEqual(
    shown?.transcriptEntries.map((entry) => entry.text),
    ["replacement"],
  );
  assert.equal(player.hostError.value, null);
  assert.equal(bridge.frozen(shown!), false);
  assert.equal(player.stopped.value, false, "the replacement's input runs");
  assert.notEqual(await player.observe(), null, "the replacement's clock runs");
});

/*
 * Work that completes after a bridge reply shows only while the session that issued it still owns the UI: each
 * completion as its issuer publishes it (the component's pacing skip through `update`, a development jump, the clock's
 * observation), against a replacement, a stop and an unmount while its reply is in transit on a 250 ms host.
 */
const completions = {
  "a pacing skip": (bridge: PlayerBridge, player: StopHost, issuer: PlayerSession) => {
    const gate = view.playerRuntimePacingGate(issuer);
    assert.ok(gate);
    const reply = bridge.request(issuer, "skipPacing", { actionId: gate.actionId });
    // As `RuntimeInteraction` emits it once the reply arrived.
    return reply.then(() => player.update(bridge.latest(issuer)!));
  },
  "a development jump": (bridge: PlayerBridge, player: StopHost, issuer: PlayerSession) => {
    const reply = bridge.request(issuer, "stepTime", { targetMs: 5_000 });
    return reply.then(() => player.publishJump(bridge.latest(issuer)!));
  },
  "the clock's observation": async (
    _bridge: PlayerBridge,
    _player: StopHost,
    _issuer: PlayerSession,
  ) => {
    // Debug's trace makes a late observation one observation over the bridge.
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 300));
  },
};
for (const [completion, issue] of Object.entries(completions))
  for (const interference of ["a replacement", "a stop", "an unmount"] as const)
    test(`${completion} in transit at ${interference} shows nothing of the session it was issued for`, async (context) => {
      const { bridge, player, scope } = await mount(context, 250);
      const replacement = await startOf(
        player,
        'say "replacement", instant\nshowButton "New"\nexit',
      );
      player.setDebugTracing(true);
      player.prepare(
        await startOf(
          player,
          'say "old paced"\nwait 10 s\nsay "old late", instant\nshowButton "Done"\nexit',
        ),
      );
      await player.activate();
      const issuer = player.session.value!;
      later(context, 1_000);
      const done = issue(bridge, player, issuer).catch(() => {});
      const changes: (string | null)[] = [];
      let at: PlayerSession | null = null;
      if (interference === "a replacement") {
        player.prepare(replacement);
        await player.activate();
      } else if (interference === "a stop")
        player.reportHostError(new TypeError("a component failed"));
      else scope.stop();
      const stopWatch = watch(
        player.session,
        (shown) => {
          if (
            interference !== "a replacement" &&
            (interference === "an unmount" || player.hostError.value !== null)
          )
            changes.push(shown?.id ?? null);
        },
        { flush: "sync" },
      );
      context.after(stopWatch);
      at = player.session.value;
      await done;
      for (let index = 0; index < 10; index += 1) await turn();
      if (interference === "a replacement") {
        const shown = player.session.value!;
        assert.deepEqual(
          shown.transcriptEntries.map((entry) => entry.text),
          ["replacement"],
        );
        assert.notEqual(shown.lineage, issuer.lineage);
        assert.equal(facade.heldRecording(bridge)?.plan, facade.heldPlan(bridge, shown.planToken));
        return;
      }
      if (interference === "a stop") {
        // The stop commits what the host ran, its in-transit reply included, and nothing shows after the stop line.
        assert.equal(player.hostError.value, "TypeError");
        assert.deepEqual(changes, []);
        assert.equal(bridge.frozen(player.session.value!), true);
        assert.equal(player.session.value, bridge.latest(issuer));
        return;
      }
      assert.deepEqual(changes, [], "an unmounted Player publishes nothing");
      assert.equal(player.session.value, at);
    });

test("a jump another publication overtook seeks media to what shows, not to the jump's older state", async (context) => {
  const elements: (EventTarget & { src: string; currentTime: number })[] = [];
  const { bridge, player } = await mount(context, 0, () => "https://fixture/voice.mp3");
  // Elements that load and seek, as the browser's do.
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: class extends EventTarget {
      src = "";
      preload = "";
      volume = 1;
      duration = 30;
      paused = true;
      ended = false;
      currentTime = 0;
      constructor() {
        super();
        elements.push(this);
      }
      play = async () => {
        this.paused = false;
      };
      pause() {
        this.paused = true;
      }
      load() {}
      removeAttribute() {
        this.src = "";
      }
    },
  });
  context.mock.method(performance, "now", () => 0);
  player.prepare(await startOf(player, 'playAudio async "voice.mp3"\nwait 10 s\nexit'));
  await player.activate();
  await turn();
  const audio = elements.find((element) => element.src === "https://fixture/voice.mp3");
  assert.ok(audio);
  audio.dispatchEvent(new Event("loadedmetadata"));
  // The load report goes over the bridge (L5d): wait until it shows, so the jump below acts on the loaded medium.
  const loaded = () =>
    view.playerRuntimeMedia(player.session.value!.state).media[0]?.loaded === true;
  for (let turns = 0; !loaded(); turns++) {
    assert.ok(turns < 100, "the load report did not show");
    // Its replies come on zero-delay timers, which immediate turns do not wait for.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const issuer = player.session.value!;
  // The jump and the observation that overtakes it share one section of the session, as the Player's own dependent
  // chains do: each request takes its basis when it is sent, and the Player's own observations, every 100 ms while
  // the audio plays, wait outside the section instead of moving the session between or under the two (#2066).
  const jumped = await bridge.section(issuer, clockTicket(), async (section) => {
    await section.send("stepTime", { targetMs: 1_100 });
    // The jump's reply arrived, but before the jump publishes, an observation of 2 s of playback overtakes it.
    const reply = section.session;
    const playing = view.playerRuntimeMedia(reply.state).media[0]!;
    audio.currentTime = 2;
    await section.send("observeTime", {
      atMs: 2_000,
      media: [{ mediaId: playing.mediaId, segment: playing.segment, progressMs: 2_000 }],
    });
    return reply;
  });
  player.update(bridge.latest(issuer)!);
  player.publishJump(jumped);
  const shown = player.session.value!;
  assert.equal(shown, bridge.latest(issuer), "the newer publication shows");
  assert.equal(
    audio.currentTime * 1_000,
    view.playerRuntimeMedia(shown.state).media[0]!.playheadMs,
  );
});

test("a Continue whose capture throws fails after its recording began, so the failure's recording is its own", async (context) => {
  // The zone and presentation are read at the click; this one throws only for the Continue.
  let failing = false;
  const { bridge, player } = await mount(context, 50, undefined, () => {
    if (failing) throw new TypeError("no time zone");
    return DEFAULT_TEMPORAL_CONTEXT;
  });
  // A session that played before, whose recording the host's recorder held.
  player.prepare(await startOf(player, 'say "earlier", instant\nshowButton "Next"\nexit'));
  await player.activate();
  const earlier = player.session.value!;
  assert.equal(facade.heldRecording(bridge)?.plan, facade.heldPlan(bridge, earlier.planToken));
  const restored = compiler.createPlayerRuntimeSession(
    'say "restored", instant\nshowButton "Next"\nexit',
  );
  player.prepareRestore(hostIntroduced(bridge, restored));
  failing = true;
  await player.activate();
  for (let index = 0; index < 10; index += 1) await turn();
  assert.equal(player.hostError.value, "TypeError");
  // The recording is the restored session's, which the failed Continue began; not the earlier session's.
  const recording = facade.heldRecording(bridge)!;
  assert.notEqual(recording.plan, facade.heldPlan(bridge, earlier.planToken));
  assert.equal(JSON.stringify(recording.plan).includes("restored"), true);
});

test("a Continue serialized behind one still beginning records its own click's zone and clock", async (context) => {
  let epoch = 1_793_966_400_000;
  context.mock.method(Date, "now", () => epoch);
  let captures = 0;
  const { bridge, player } = await mount(context, 0, undefined, () => {
    captures += 1;
    return DEFAULT_TEMPORAL_CONTEXT;
  });
  // The first Continue's `beginRecording` reply is held, so the second waits for it (`begunInFlight`).
  const request = bridge.client.request.bind(bridge.client);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const reply = request(...args);
    if (args[0] !== "beginRecording" || !first) return reply;
    first = false;
    return reply.then(async (result) => (await held, result));
  });
  player.prepareRestore(
    hostIntroduced(bridge, compiler.createPlayerRuntimeSession('showButton "Old"\nexit')),
  );
  const obsolete = player.activate();
  assert.equal(captures, 1);
  player.prepareRestore(
    hostIntroduced(
      bridge,
      compiler.createPlayerRuntimeSession('say "new", instant\nshowButton "New"\nexit'),
    ),
  );
  const replacing = player.activate();
  assert.equal(captures, 2, "the second Continue captured in its click");
  epoch += 20_000;
  release();
  await Promise.all([obsolete, replacing]);
  assert.equal(player.hostError.value, null);
  const capture = facade.hatch(player.session.value!, (session) =>
    adapter.playerRuntimeSnapshot(session).temporalCaptures.at(-1)!,
  );
  assert.equal(capture.epochMs, 1_793_966_400_000, "the clock of its own click");
});

for (const form of ["a source prepare", "a held plan"] as const)
  test(`a Start serialized behind a Continue still beginning records its click's zone and clock (${form})`, async (context) => {
    let epoch = 1_793_966_400_000;
    let temporal = DEFAULT_TEMPORAL_CONTEXT;
    context.mock.method(Date, "now", () => epoch);
    const { bridge, player } = await mount(context, 0, undefined, () => temporal);
    const script = 'showButton "Go"\nexit';
    // Held before anything is timed, as a host's `prepare` holds it: as published plan text, or compiled from source as
    // the development preview's scenarios are.
    const token =
      form === "a held plan"
        ? await preparedPlan(Promise.resolve(bridge), compiler.compilePlayerProject(script).plan!)
        : await preparedSource(Promise.resolve(bridge), script);
    // The Continue's `beginRecording` reply is held, so the Start waits for it (`begunInFlight`): its `start` posts only
    // once that reply is let go.
    const request = bridge.client.request.bind(bridge.client);
    const order: string[] = [];
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const release = () => {
      order.push("beginRecording let go");
      letGo();
    };
    let first = true;
    context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
      if (args[0] === "start") order.push("start");
      const reply = request(...args);
      if (args[0] !== "beginRecording" || !first) return reply;
      first = false;
      return reply.then(async (result) => (await held, result));
    });
    player.prepareRestore(
      hostIntroduced(bridge, compiler.createPlayerRuntimeSession('showButton "Old"\nexit')),
    );
    const obsolete = player.activate();
    player.prepare({
      plan: token,
      // As `hostedScript.ts` asks for it, or the development preview's scenarios.
      options:
        form === "a held plan"
          ? () => player.temporalCapture()
          : () => ({ ...player.temporalCapture() }),
    });
    const starting = player.activate();
    // After the click: the clock moves on, and the zone changes.
    epoch += 20_000;
    temporal = {
      ...DEFAULT_TEMPORAL_CONTEXT,
      zone: { ...DEFAULT_TEMPORAL_CONTEXT.zone, name: "Etc/UTC" },
    };
    release();
    await Promise.all([obsolete, starting]);
    for (let index = 0; index < 5; index += 1) await turn();
    assert.equal(player.hostError.value, null);
    assert.deepEqual(
      order,
      ["beginRecording let go", "start"],
      "the Start posts its start only once the Continue's begin settled",
    );
    const capture = facade.hatch(player.session.value!, (session) =>
      adapter.playerRuntimeSnapshot(session).temporalCaptures.at(-1)!,
    );
    assert.equal(capture.epochMs, 1_793_966_400_000, "the clock of the Start's click");
    assert.deepEqual(capture.context, DEFAULT_TEMPORAL_CONTEXT, "the zone of the Start's click");
  });

for (const camera of [false, true])
  for (const form of ["a source prepare", "a held plan"] as const)
    test(`a Start that reads the stored values records the click's capture, or the camera's answer's (${form}, camera ${camera ? "on" : "off"})`, async (context) => {
      const gate = () => {
        let open!: () => void;
        return { opened: new Promise<void>((resolve) => (open = resolve)), open: () => open() };
      };
      const cameraAnswer = gate();
      const storageRead = gate();
      const reading = gate();
      // The browser: event targets, silent audio, and a camera the player denies once `cameraAnswer` opens.
      const values = {
        document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
        window: new EventTarget(),
        navigator: {
          mediaDevices: Object.assign(new EventTarget(), {
            getUserMedia: async () => {
              await cameraAnswer.opened;
              throw new DOMException("denied", "NotAllowedError");
            },
          }),
        },
        Audio: class extends EventTarget {
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
      let epoch = 1_793_966_400_000;
      let temporal = DEFAULT_TEMPORAL_CONTEXT;
      context.mock.method(Date, "now", () => epoch);
      // The stored values are read until `storageRead` opens.
      const storage: ScriptStorageProvider = {
        scope: "stop-ownership",
        load: async () => {
          reading.open();
          await storageRead.opened;
          return [];
        },
        write: async () => {},
        replace: async () => {},
        clear: async () => {},
      };
      const bridge = facade.createInProcessBackend(BUILD, {});
      const scope = effectScope();
      const player = scope.run(() =>
        usePlayerSession({
          bridge: Promise.resolve(bridge),
          debugHistorySpill: async () => null,
          scriptStorage: storage,
          capabilities: { camera },
          temporalContext: () => temporal,
        }),
      )!;
      context.after(() => {
        scope.stop();
        bridge.client.terminate();
      });
      await player.bridge;
      const script = 'showButton "Ready"\nexit';
      const token =
        form === "a held plan"
          ? await preparedPlan(Promise.resolve(bridge), compiler.compilePlayerProject(script).plan!)
          : await preparedSource(Promise.resolve(bridge), script);
      player.prepare({
        plan: token,
        options:
          form === "a held plan"
            ? () => player.temporalCapture()
            : () => ({ ...player.temporalCapture() }),
      });
      const starting = player.activate();
      // The camera answers a second after the click; the read of the stored values then takes 20 seconds more, and the
      // zone changes meanwhile.
      epoch += 1_000;
      cameraAnswer.open();
      await reading.opened;
      epoch += 19_000;
      temporal = {
        ...DEFAULT_TEMPORAL_CONTEXT,
        zone: { ...DEFAULT_TEMPORAL_CONTEXT.zone, name: "Etc/UTC" },
      };
      storageRead.open();
      await starting;
      for (let index = 0; index < 5; index += 1) await turn();
      assert.equal(player.hostError.value, null);
      const capture = facade.hatch(player.session.value!, (session) =>
        adapter.playerRuntimeSnapshot(session).temporalCaptures.at(-1)!,
      );
      assert.equal(
        capture.epochMs,
        camera ? 1_793_966_401_000 : 1_793_966_400_000,
        camera ? "the clock of the camera's answer" : "the clock of the click",
      );
      assert.deepEqual(capture.context, DEFAULT_TEMPORAL_CONTEXT, "the zone before the read");
    });
