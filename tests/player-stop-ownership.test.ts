import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, watch, type Ref } from "vue";

import type * as CompileProject from "../player/compile-project.js";
import type * as InProcess from "../player/engine-bridge/in-process.js";
import type { StartOptions } from "../player/engine-bridge/ops/session.js";
import { startBridgeHost, type HostSession } from "../player/engine-bridge/worker-host.js";
import { BRIDGE_VERSION } from "../player/engine-bridge/protocol.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import type {
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type * as RuntimeView from "../player/runtime-view.js";
import type { PlayerSession } from "../player/runtime-view.js";
import type { RuntimeDebugContext } from "../src/runtime/debug/debug-trace.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

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
  readonly debugTrace: Readonly<Ref<RuntimeDebugContext | null>>;
  prepare(
    create:
      | { readonly plan: string; readonly options: () => StartOptions }
      | ((recording: PlayerRuntimeSessionOptions) => PlayerRuntimeSession),
  ): void;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
  debugExportCandidate(shown: {
    readonly player: object;
    readonly host: object;
  }): Promise<{
    readonly session: { readonly transcriptEntries: readonly { readonly text: string }[] } | null;
  }>;
  setDebugTracing(on: boolean): void;
  reportHostError(error: unknown): void;
  observe(): { readonly id: string } | null;
  update(next: PlayerSession): void;
  publishJump(next: PlayerSession): void;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
}) => StopHost;
let facade: typeof InProcess;
let compiler: typeof CompileProject;
let view: typeof RuntimeView;

before(async () => {
  const module = await loadPlayerModule("player/vue/src/usePlayerSession.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: the bundle the composable runs in, whose facade reaches its sessions.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/compile-project.ts")) as typeof compiler;
  // EVIDENCE: validation: the bundle's session view module, from the same module graph.
  view = (await loadPlayerModule("player/runtime-view.ts")) as typeof view;
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** A Player on a host that replies after `delayMs`, in a browser surface with event targets and silent audio. */
async function mount(context: TestContext, delayMs = 50) {
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
    usePlayerSession({ bridge: Promise.resolve(bridge), debugHistorySpill: async () => null }),
  )!;
  context.after(() => {
    scope.stop();
    bridge.client.terminate();
  });
  await player.bridge;
  return { bridge, player, scope };
}

const factory =
  (script: string) =>
  (recording: PlayerRuntimeSessionOptions): PlayerRuntimeSession =>
    compiler.createPlayerRuntimeSession(script, { ...recording, wallClockMs: 0 });

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
  player.prepare(factory('wait 1 s\nsay "arrived", instant\nshowButton "Done"\nexit'));
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
  player.prepare(factory('wait 1 s\nsay "caught up", instant\nshowButton "Done"\nexit'));
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

test("a Start queued behind prepare that a factory Start replaced leaves the recorder to the replacement", async (context) => {
  const { bridge, player } = await mount(context);
  const obsolete = compiler.compilePlayerProject(
    'say "obsolete", instant\nshowButton "Old"\nexit',
  ).plan!;
  const token = facade.holdPlan(bridge, obsolete);
  player.prepare({ plan: token, options: () => ({ wallClockMs: 0 }) });
  const compiling = bridge.client.request("prepare", {
    source: { kind: "source", script: 'showButton "Compile"\nexit' },
  });
  const replaced = player.activate();
  player.prepare(factory('say "replacement", instant\nshowButton "New"\nexit'));
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
  const { player } = await mount(context);
  player.setDebugTracing(true);
  player.prepareRestore(compiler.createPlayerRuntimeSession('showButton "Old"\nexit'));
  const continuing = player.activate();
  player.prepare(factory('let fresh = 123\nsay "fresh ${fresh}", instant\nshowButton "New"\nexit'));
  await player.activate();
  const trace = player.debugTrace.value!;
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

test("a session op still awaited does not delay the halt fence: a request behind it is refused", async () => {
  const replies: unknown[] = [];
  let listen!: (data: unknown) => void;
  let settle!: () => void;
  let ran = 0;
  const session: HostSession = { revision: 0, accepts: () => true };
  const sessions = startBridgeHost(
    { post: (reply) => replies.push(reply), listen: (listener) => (listen = listener) },
    {
      waiting: {
        session: "existing",
        checkArguments: () => true,
        run: () => new Promise((resolve) => (settle = () => resolve({ result: "done" }))),
      },
      add: {
        session: "existing",
        checkArguments: () => true,
        run: () => {
          ran += 1;
          return { result: ran };
        },
      },
    },
    BUILD,
  );
  const id = sessions.add(session);
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
      player.prepare({ plan: facade.holdPlan(bridge, plan), options: () => ({ wallClockMs: 0 }) });
      if (kind === "start-queued")
        compiled = bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
    } else {
      player.setDebugTracing(true);
      if (kind === "continue-queued")
        compiled = bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
      player.prepareRestore(
        compiler.createPlayerRuntimeSession('say "restored", instant\nshowButton "Next"\nexit'),
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
    const traceAtStop = player.debugTrace.value?.status() ?? null;
    for (let index = 0; index < 10; index += 1) await turn();
    assert.deepEqual(afterStop, [], "nothing shows after the stop line");
    assert.equal(player.hostError.value, "TypeError");
    if (shown !== null) {
      assert.equal(bridge.frozen(shown), true, "the stopped session's store froze");
      assert.deepEqual(stopLine(bridge, player).export, shown.state.observedSessionTimeMs);
      const exported = await player.debugExportCandidate({ player: {}, host: {} });
      assert.deepEqual(
        exported.session?.transcriptEntries.map((entry) => entry.text),
        shown.transcriptEntries.map((entry) => entry.text),
      );
    }
    // Nothing of the activation runs after the stop: the recording and trace stay as they stood.
    assert.equal(facade.heldRecording(bridge)?.operations.length ?? null, recordingAtStop);
    assert.deepEqual(player.debugTrace.value?.status() ?? null, traceAtStop);
  });

test("a Start that replaces an error stop pending on a Start the host rejects runs unstopped", async (context) => {
  const { bridge, player } = await mount(context);
  // The host holds no such plan, so it rejects the Start.
  player.prepare({ plan: "missing-plan", options: () => ({ wallClockMs: 0 }) });
  const rejected = player.activate();
  player.reportHostError(new TypeError("a component failed while a Start began"));
  assert.equal(player.stopped.value, true, "input stops while the stop waits for the Start");
  player.prepare(factory('say "replacement", instant\nshowButton "Next"\nexit'));
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
  assert.notEqual(player.observe(), null, "the replacement's clock runs");
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
      player.setDebugTracing(true);
      player.prepare(
        factory('say "old paced"\nwait 10 s\nsay "old late", instant\nshowButton "Done"\nexit'),
      );
      await player.activate();
      const issuer = player.session.value!;
      later(context, 1_000);
      const done = issue(bridge, player, issuer).catch(() => {});
      const changes: (string | null)[] = [];
      let at: PlayerSession | null = null;
      if (interference === "a replacement") {
        player.prepare(factory('say "replacement", instant\nshowButton "New"\nexit'));
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
