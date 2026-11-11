import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { Worker } from "node:worker_threads";
import { effectScope, type Ref } from "vue";

import { CapturedMediaStore } from "../../player/media/captured-media.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { BridgeLostError } from "../../player/engine-bridge/client.js";
import { loadAge, loadTlock } from "../../player/encryption/content-lock.js";
import type * as Client from "../../player/engine-bridge/client.js";
import { LockService } from "../../player/encryption/lock-service.js";
import type { PlayerBridge, ServiceSection } from "../../player/runtime/player-bridge.js";
import type { PlayerRuntimeSessionOptions } from "../../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { CaptureService } from "../../player/media/session-camera.js";
import { FileStoreService } from "../../player/media/stored-files.js";
import { inProcessBridge, introduced } from "../helpers/in-process-bridge.js";
import {
  memoryKeptSessionStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import { preparedPlan, sourceStart, type PlanStart } from "../helpers/prepared-plan.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { serviceSection } from "../helpers/service-section.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import type { InputSection } from "../../player/vue/src/session/runtime-input.js";
import {
  inProcessLoss,
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyBridge,
  until,
  type Topology,
} from "../helpers/player/worker-topology.js";

/*
 * When the engine's Worker is lost, every request still waiting for its reply ends its caller quietly: the loss is the
 * Player error stop, which `bridgeLost` reports once, and no caller reports it again or leaves its rejection unhandled
 * (L5g). The cases come from the Player's consumers of bridge requests: those whose handling L5g changed must fail with
 * that handling reverted; the ones that were already safe are controls. The service rows run on a section host, where
 * a loss is injected as the client meets a real one: the client rejects everything pending and posts nothing more
 * (`terminate`), and its loss listeners run in the same tick. The composable's rows run on both topologies
 * (`worker-topology.ts`): in-process with that injected loss, and on a Node Worker whose thread is ended, where the loss
 * arrives with its exit.
 */

/** The changed consumers, each with a request in flight at the loss. */
const CHANGED = [
  "a capture answer",
  "an uncertain answer's media",
  "a file store answer",
  "a lock answer",
  "an input section's observation",
  "an input section's op",
  "the Worker's readiness",
  "the hosted script's preparation",
  "the start page's preparation",
  "a call view request",
  "a keep's capture",
  "Continue's restore",
] as const;
/** Consumers that were already safe, as controls. */
const CONTROLS = [
  "an observation still queued in the client",
  "an op still queued in the client",
  "a media load report",
  "a Stage photo preload",
] as const;
const covered = new Set<string>();

test.after(() => {
  // Every consumer of the inventory has its case.
  assert.deepEqual([...covered].sort(), [...CHANGED, ...CONTROLS].sort());
});

/** Rejections no one handled while `body` ran and its continuations settled. */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    await body();
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    process.off("unhandledRejection", record);
  }
  return unhandled;
}

const turns = async (count: number) => {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
};

// The services, through the same section host as their own tests, on a host whose replies take 50 ms.

/** A service's host around `session`: its section, and the op it sends, with a loss at the post of `lossAt`. */
function serviceHost(bridge: PlayerBridge, session: PlayerSession, lossAt: string) {
  const lose = inProcessLoss(bridge, BridgeLostError);
  const state: { session: PlayerSession | null; sent: string[]; diagnostics: number } = {
    session,
    sent: [],
    diagnostics: 0,
  };
  const section: <T>(
    body: (section: ServiceSection, observed: PlayerSession | null) => Promise<T>,
  ) => Promise<T | null> = serviceSection(
    bridge,
    () => state.session,
    (next) => (state.session = next),
    (op) => {
      state.sent.push(op);
      if (op !== lossAt) return;
      queueMicrotask(() => {
        lose();
        // The Player withholds a stopped session from its services.
        state.session = null;
      });
    },
  );
  return {
    state,
    host: {
      session: () => state.session,
      generation: () => 1,
      section,
      diagnostic: () => void state.diagnostics++,
      later: (task: () => void) => setTimeout(task, 0),
    },
  };
}
/** Services `service` until it posted `op`, the post the loss follows. */
async function posted(
  service: { request(): void },
  state: { readonly sent: readonly string[] },
  op: string,
): Promise<void> {
  service.request();
  for (let turn = 0; !state.sent.includes(op); turn++) {
    assert.ok(turn < 400, `${op} was not posted`);
    await turns(1);
  }
}
const media = () =>
  new CapturedMediaStore(null, { create: () => "blob:", revoke: () => {} }, "loss");

test("a capture answer in flight when the Worker is lost ends quietly", async () => {
  covered.add("a capture answer");
  const bridge = await inProcessBridge(50);
  const session = introduced(bridge, createPlayerRuntimeSession("let photo = takePhoto()\nexit"));
  const { state, host } = serviceHost(bridge, session, "answerCapture");
  const service = new CaptureService(async () => ({ kind: "unavailable", reason: "denied" }), {
    ...host,
    capturedMedia: { holds: () => false, discard: () => {} },
  });
  assert.deepEqual(await unhandledDuring(() => posted(service, state, "answerCapture")), []);
  service.stop();
  assert.deepEqual(state.sent, ["observeTime", "answerCapture"]);
  assert.equal(state.diagnostics, 0);
});

test("a photo whose answer was in flight when the Worker was lost is kept, and no second photo is taken", async () => {
  // `sendAnswer` (answer-media.ts) owns this: an answer the runtime may have taken keeps its media, also once the
  // Player stops and resets its services.
  covered.add("an uncertain answer's media");
  const bridge = await inProcessBridge(50);
  const session = introduced(bridge, createPlayerRuntimeSession("let photo = takePhoto()\nexit"));
  const { state, host } = serviceHost(bridge, session, "answerCapture");
  let photos = 0;
  const discarded: string[] = [];
  const service = new CaptureService(
    async () => {
      photos++;
      return { kind: "captured", reference: "photo-1" };
    },
    {
      ...host,
      capturedMedia: {
        holds: (reference, kind) => reference === "photo-1" && kind === "image",
        discard: (reference) => void discarded.push(reference),
      },
    },
  );
  assert.deepEqual(
    await unhandledDuring(async () => {
      await posted(service, state, "answerCapture");
      // The Player error stop the loss is resets the services, as `usePlayerSession` does.
      service.reset();
    }),
    [],
  );
  service.stop();
  assert.deepEqual([photos, discarded], [1, []]);
});

test("a file store answer in flight when the Worker is lost ends quietly", async () => {
  covered.add("a file store answer");
  const bridge = await inProcessBridge(50);
  const session = introduced(
    bridge,
    createPlayerRuntimeSession('let picture = fileFromBase64("aGk=", default: "")\nexit'),
  );
  const { state, host } = serviceHost(bridge, session, "answerFileStore");
  const service = new FileStoreService({ ...host, media: media() });
  assert.deepEqual(await unhandledDuring(() => posted(service, state, "answerFileStore")), []);
  service.stop();
  assert.deepEqual(state.sent, ["observeTime", "answerFileStore"]);
});

test("a lock answer in flight when the Worker is lost ends quietly", async () => {
  covered.add("a lock answer");
  const bridge = await inProcessBridge(50);
  const session = introduced(
    bridge,
    createPlayerRuntimeSession(
      'let locked = encryptText("x", password: "p", publicKey: false, timeLock: false)\nexit',
      { wallClockMs: 0 },
    ),
  );
  const { state, host } = serviceHost(bridge, session, "answerLock");
  const service = new LockService({
    ...host,
    media: media(),
    dialog: () => {},
    after: () => () => {},
    subtle: crypto.subtle,
    crypto: { tlock: loadTlock, age: loadAge, fetch, nowMs: () => 0 },
  });
  assert.deepEqual(await unhandledDuring(() => posted(service, state, "answerLock")), []);
  service.stop();
  assert.deepEqual(state.sent, ["observeTime", "answerLock"]);
});

// The composable and its consumers, from the bundle it runs in.

interface LossHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly bridge: Promise<PlayerBridge>;
  loadScriptStorage(): Promise<void>;
  prepareScript(
    plan: string,
    create: { readonly plan: string; readonly options: () => PlayerRuntimeSessionOptions },
  ): Promise<void>;
  prepare(create: PlanStart): void;
  activate(): Promise<void>;
  demandCallView(): { release(): void };
  inputSection<T>(
    work: "inputAnswer" | "inputDraft",
    body: (section: Pick<InputSection, "send">, observed: PlayerSession | null) => Promise<T>,
  ): Promise<T | null>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly resolveAsset?: (path: string) => string | null;
  readonly scriptStorage?: ScriptStorageProvider;
  readonly keptSessions?: KeptSessionStore;
}) => LossHost;
let client: typeof Client;
let bridgeModule: typeof import("../../player/runtime/player-bridge.js");
let compiler: typeof import("../../player/runtime/compile-project.js");
/** What `prepareHostedScript` reads of the Player, as `startPage` gives it, or the real composable. */
type StartPagePlayer = ReturnType<typeof startPage>["player"];
let prepareHostedScript: (
  player: StartPagePlayer | LossHost,
  host: { load(): Promise<{ readonly project: string }> },
) => { readonly failure: Readonly<Ref<object | null>> };
/** A connection as the Stage preload reads it. */
interface PreloadConnection {
  readonly client: {
    request(
      op: string,
      args: { readonly plan: string },
    ): Promise<{ readonly result: object | null }>;
  };
}
let usePlanPhotoPreload: (
  shown: () => { readonly connection: PreloadConnection; readonly planToken: string } | null,
  resolveAsset: (path: string) => string | null,
  preload: (sources: readonly string[]) => () => void,
) => void;

before(async () => {
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  await loadTopology();
  // EVIDENCE: validation: the bundle's bridge module, whose `PlayerBridge` the composable runs with.
  bridgeModule = (await loadPlayerModule("player/runtime/player-bridge.ts")) as typeof bridgeModule;
  // EVIDENCE: validation: the bundle's client module, whose error classes the bundle's code tests for.
  client = (await loadPlayerModule("player/engine-bridge/client.ts")) as typeof client;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
  const hosted = await loadPlayerModule("player/vue/src/hostedScript.ts");
  // EVIDENCE: validation: the real module's export.
  prepareHostedScript = hosted.prepareHostedScript as typeof prepareHostedScript;
  const photos = await loadPlayerModule("player/vue/src/stage/stagePhotos.ts");
  // EVIDENCE: validation: the real module's export.
  usePlanPhotoPreload = photos.usePlanPhotoPreload as typeof usePlanPhotoPreload;
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };

/** Fake audio elements the composable makes, which a test makes load. */
type FakeAudio = EventTarget & { src: string };

/*
 * The composable's rows run on both topologies (L5i.7): the in-process host, and the engine's Worker entry in a Node
 * Worker thread, whose loss is the thread's real exit. Each is registered here; the file's end checks every registered
 * row ran on each of its topologies. An in-flight row holds the request's own reply, loses the Worker while it is held,
 * then lets the held replies go.
 */
const RERUN = rerunRegistry({
  "input-section observation in flight": TOPOLOGIES,
  "input-section op in flight": TOPOLOGIES,
  "observation queued in the client": TOPOLOGIES,
  "op queued in the client": TOPOLOGIES,
  "media load report in flight": TOPOLOGIES,
  "call view in flight": TOPOLOGIES,
  "keep's capture in flight": TOPOLOGIES,
  "Continue's restore in flight": TOPOLOGIES,
  "hosted script's preparation in flight": TOPOLOGIES,
  // Only a Worker thread can exit before it is ready; the in-process host is ready at once.
  "Worker lost before ready": ["worker"],
  // The same schedules without a loss, each its own case, so a control never stands in for its loss row.
  "control: input-section observation in flight": TOPOLOGIES,
  "control: input-section op in flight": TOPOLOGIES,
  "control: media load report in flight": TOPOLOGIES,
  "control: call view in flight": TOPOLOGIES,
  "control: keep's capture in flight": TOPOLOGIES,
  "control: Continue's restore in flight": TOPOLOGIES,
  "control: hosted script's preparation in flight": TOPOLOGIES,
});

/** The browser surface the composable uses, with fake audio elements a test makes load. */
function browser(context: TestContext): FakeAudio[] {
  const elements: FakeAudio[] = [];
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
      constructor() {
        super();
        elements.push(this);
      }
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
  return elements;
}

/** The host errors the Player logs, as the loss's error stop logs one. */
function hostErrorLog(context: TestContext) {
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void errors.push(String(args[0]));
  context.after(() => void (console.error = log));
  return () => errors.filter((line) => line.includes("host error")).length;
}

/** A choice, with an audio cue started before it. */
const AT_A_CHOICE = 'playAudio async "bell.mp3"\nlet pick = askChoice "Go"\nexit';
/** A script that waits for its medium's load before it goes on: its load report is sent. */
const AWAITS_ITS_MEDIUM =
  'playAudio async "bell.mp3"\nsay "after", instant\nshowButton "Done"\nexit';

/** The real composable on `topology`, in-process with replies after `delayMs`, started on `script` with its audio. */
async function mount(
  context: TestContext,
  topology: Topology,
  delayMs: number,
  script: string = AT_A_CHOICE,
) {
  const elements = browser(context);
  const hostErrors = hostErrorLog(context);
  const transport = await topologyBridge(context, topology, { delayMs });
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(transport.bridge),
      debugHistorySpill: async () => null,
      resolveAsset: (path) => `https://fixture/${path}`,
    }),
  )!;
  context.after(() => scope.stop());
  await player.bridge;
  transport.assertTopology();
  player.prepare(await sourceStart(player.bridge, script, () => ({ wallClockMs: 0 })));
  await player.activate();
  if (script === AT_A_CHOICE)
    await until(() => player.session.value?.state.foregroundAction != null, "the choice shows");
  await until(() => elements.some((element) => element.src.endsWith("bell.mp3")), "the audio");
  return { transport, player, elements, hostErrors };
}

for (const [consumer, id, run] of [
  [
    "an input section's observation",
    "input-section observation in flight",
    (player: LossHost) => player.inputSection("inputAnswer", async (_s, observed) => observed),
  ],
  [
    "an input section's op",
    "input-section op in flight",
    (player: LossHost) =>
      // A row that observes nothing, so the op is the section's first post.
      player.inputSection("inputDraft", (s) => s.send("observeInput", { atMs: 0, media: [] })),
  ],
] as const) {
  RERUN.rows(
    id,
    `${consumer} in flight when the Worker is lost ends quietly, and the loss is the error stop once`,
    async (context, topology) => {
      covered.add(consumer);
      const { transport, player, hostErrors } = await mount(context, topology, 50);
      let result: Awaited<ReturnType<typeof run>> | "pending" = "pending";
      const unhandled = await unhandledDuring(async () => {
        transport.hold("observeInput");
        const pending = run(player);
        // Posted; its own reply is held until after the loss, so it is in flight then.
        await transport.held();
        await transport.lose();
        transport.release();
        result = await pending;
      });
      assert.deepEqual(unhandled, []);
      // A lost observation gives no session; a lost op is retired, as one the stop refused.
      assert.ok(
        result === null || (typeof result === "symbol" && String(result).includes("retired")),
        String(result),
      );
      assert.equal(player.hostError.value, "BridgeLostError");
      assert.equal(hostErrors(), 1);
    },
  );
  RERUN.rows(
    `control: ${id}`,
    `control: ${consumer} on the same schedule without a loss succeeds`,
    async (context, topology) => {
      const { transport, player, hostErrors } = await mount(context, topology, 50);
      transport.hold("observeInput");
      const pending = run(player);
      await transport.held();
      transport.release();
      const result = await pending;
      assert.ok(result !== null && typeof result !== "symbol", String(result));
      assert.equal(player.hostError.value, null);
      assert.equal(hostErrors(), 0);
    },
  );
}

for (const [consumer, id, run] of [
  [
    "an observation still queued in the client",
    "observation queued in the client",
    (player: LossHost) => player.inputSection("inputAnswer", async (_s, observed) => observed),
  ],
  [
    "an op still queued in the client",
    "op queued in the client",
    (player: LossHost) =>
      player.inputSection("inputDraft", (s) => s.send("observeInput", { atMs: 0, media: [] })),
  ],
] as const)
  RERUN.rows(
    id,
    `control: ${consumer} at the loss never posts, as the stop ends it first`,
    async (context, topology) => {
      covered.add(consumer);
      const { transport, player, hostErrors } = await mount(context, topology, 0);
      // Another section of the session holds it, so this one waits in the client.
      let release = () => {};
      void transport.bridge.section(
        player.session.value!,
        clockTicket(),
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const before = transport.posts.length;
      const unhandled = await unhandledDuring(async () => {
        const pending = run(player);
        await transport.lose();
        release();
        await pending;
      });
      assert.deepEqual(unhandled, []);
      assert.deepEqual(transport.posts.slice(before), [], "nothing reached the port");
      assert.equal(hostErrors(), 1);
    },
  );

RERUN.rows(
  "media load report in flight",
  "control: a media load report in flight when the Worker is lost ends quietly",
  async (context, topology) => {
    covered.add("a media load report");
    const { transport, player, elements, hostErrors } = await mount(
      context,
      topology,
      50,
      AWAITS_ITS_MEDIUM,
    );
    const unhandled = await unhandledDuring(async () => {
      transport.hold("reportMediaLoad");
      elements
        .find((element) => element.src.endsWith("bell.mp3"))!
        .dispatchEvent(new Event("loadedmetadata"));
      await transport.held();
      await transport.lose();
      transport.release();
    });
    assert.deepEqual(unhandled, []);
    assert.equal(player.hostError.value, "BridgeLostError");
    assert.equal(hostErrors(), 1);
  },
);

RERUN.rows(
  "call view in flight",
  "a call view request in flight when the Worker is lost ends quietly, and the loss is the error stop once",
  async (context, topology) => {
    covered.add("a call view request");
    const { transport, player, hostErrors } = await mount(context, topology, 50);
    const unhandled = await unhandledDuring(async () => {
      // Debug's Now view opens: its call view request is posted, its reply held.
      transport.hold("viewCalls");
      player.demandCallView();
      await transport.held();
      await transport.lose();
      transport.release();
    });
    assert.deepEqual(unhandled, []);
    assert.equal(player.hostError.value, "BridgeLostError");
    assert.equal(hostErrors(), 1);
  },
);

/** A page whose script keeps its session, on `topology` (in-process, replies after `delayMs`). */
async function keepingPage(
  context: TestContext,
  kept: KeptSessionStore,
  topology: Topology,
  delayMs: number,
  script = 'let pick = askChoice "Go"\nsay "x", instant\nexit',
) {
  browser(context);
  const scriptStorage: ScriptStorageProvider = {
    scope: "loss",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const transport = await topologyBridge(context, topology, { delayMs });
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(transport.bridge),
      debugHistorySpill: async () => null,
      scriptStorage,
      keptSessions: kept,
    }),
  )!;
  context.after(() => scope.stop());
  await player.loadScriptStorage();
  transport.assertTopology();
  const plan = compiler.compilePlayerProject(script).plan!;
  const token = await preparedPlan(player.bridge, plan);
  return { transport, player, token };
}

RERUN.rows(
  "keep's capture in flight",
  "a keep's capture in flight when the Worker is lost keeps the session kept before, and ends quietly",
  async (context, topology) => {
    covered.add("a keep's capture");
    const kept = memoryKeptSessionStore();
    // A button that times out, then a question: the session is kept at each, the second without input.
    const { transport, player, token } = await keepingPage(
      context,
      kept,
      topology,
      50,
      'showButton "One", timeout: 300 ms\nlet pick = askChoice "Go"\nsay "x", instant\nexit',
    );
    await player.prepareScript(token, { plan: token, options: () => ({ wallClockMs: 0 }) });
    await player.activate();
    // The session is kept at the button it presents.
    for (let turn = 0; (await kept.session("loss")) === null; turn++) {
      assert.ok(turn < 100, "the session was not kept");
      await turns(1);
    }
    const before = await kept.session("loss");
    assert.ok(before, "a session is kept");
    const unhandled = await unhandledDuring(async () => {
      // The button times out and the question shows: its keep's capture is posted, its reply held.
      transport.hold("captureKeep");
      await transport.held();
      await transport.lose();
      transport.release();
    });
    assert.deepEqual(unhandled, []);
    assert.deepEqual(await kept.session("loss"), before, "the session kept before stays");
    assert.equal(player.hostError.value, "BridgeLostError");
  },
);

RERUN.rows(
  "Continue's restore in flight",
  "Continue's restore in flight when the Worker is lost ends quietly, and offers no Continue",
  async (context, topology) => {
    covered.add("Continue's restore");
    const kept = memoryKeptSessionStore();
    {
      const first = await keepingPage(context, kept, "in-process", 0);
      await first.player.prepareScript(first.token, {
        plan: first.token,
        options: () => ({ wallClockMs: 0 }),
      });
      await first.player.activate();
      for (let turn = 0; (await kept.session("loss")) === null; turn++) {
        assert.ok(turn < 100, "the session was not kept");
        await turns(1);
      }
    }
    const { transport, player, token } = await keepingPage(context, kept, topology, 50);
    const unhandled = await unhandledDuring(async () => {
      transport.hold("restoreKept");
      const preparing = player.prepareScript(token, {
        plan: token,
        options: () => ({ wallClockMs: 0 }),
      });
      // The restore is posted, its reply held.
      await transport.held();
      await transport.lose();
      transport.release();
      await preparing;
    });
    assert.deepEqual(unhandled, []);
    assert.notEqual(player.activation.value, "continue");
  },
);

RERUN.rows(
  "hosted script's preparation in flight",
  "the hosted script's preparation in flight when the Worker is lost ends quietly, and shows no failure",
  async (context, topology) => {
    browser(context);
    const hostErrors = hostErrorLog(context);
    const transport = await topologyBridge(context, topology, { delayMs: 50 });
    const scope = effectScope();
    const player = scope.run(() =>
      usePlayerSession({
        bridge: Promise.resolve(transport.bridge),
        debugHistorySpill: async () => null,
      }),
    )!;
    context.after(() => scope.stop());
    await player.bridge;
    transport.assertTopology();
    let failure: object | null | "unset" = "unset";
    const unhandled = await unhandledDuring(async () => {
      transport.hold("prepare");
      const prepared = prepareHostedScript(player, {
        load: async () => ({ project: 'say "x"\nexit' }),
      });
      await transport.held();
      await transport.lose();
      transport.release();
      await turns(4);
      failure = prepared.failure.value;
    });
    assert.deepEqual(unhandled, []);
    assert.equal(failure, null, "a lost preparation is no failure to show");
    assert.equal(player.hostError.value, "BridgeLostError");
    assert.equal(hostErrors(), 1);
  },
);

RERUN.rows(
  "Worker lost before ready",
  "a Worker lost before it is ready leaves no rejection unhandled",
  async (context) => {
    browser(context);
    // A thread that exits before it sends `ready`.
    const worker = new Worker("process.exit(3)", { eval: true });
    const connecting = client
      .connectBridge(
        {
          post: (message) => worker.postMessage(message),
          listen: (listener) => worker.on("message", listener),
          onFailure: (listener) => {
            worker.on("error", listener);
            worker.on("exit", (code) =>
              listener(new Error(`The worker exited with code ${code}.`)),
            );
          },
          terminate: () => void worker.terminate(),
        },
        BUILD,
      )
      .then((connected) => new bridgeModule.PlayerBridge(connected));
    const scope = effectScope();
    const unhandled = await unhandledDuring(async () => {
      const player = scope.run(() =>
        usePlayerSession({ bridge: connecting, debugHistorySpill: async () => null }),
      )!;
      // The host's own callers see the failure; nothing else leaves it unhandled.
      await assert.rejects(player.bridge);
    });
    scope.stop();
    assert.deepEqual(unhandled, []);
  },
);

test("the Worker's readiness that fails leaves no rejection unhandled", async () => {
  covered.add("the Worker's readiness");
  const surface = { document: new EventTarget(), window: new EventTarget() };
  for (const [name, value] of Object.entries(surface))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  const scope = effectScope();
  const unhandled = await unhandledDuring(async () => {
    const failed = Promise.reject(
      new client.BridgeStartupError("The engine Worker could not start."),
    );
    const player = scope.run(() =>
      usePlayerSession({ bridge: failed, debugHistorySpill: async () => null }),
    )!;
    // The host's own callers see the failure; nothing else leaves it unhandled.
    await assert.rejects(player.bridge, client.BridgeStartupError);
  });
  scope.stop();
  for (const name of Object.keys(surface)) Reflect.deleteProperty(globalThis, name);
  assert.deepEqual(unhandled, []);
});

/** A start page's host as `prepareHostedScript` uses it, whose bridge answers `prepare` with `prepare`. */
function startPage(
  prepare: () => Promise<{ readonly result: object }>,
  prepareScript: () => Promise<void>,
) {
  const reported: unknown[] = [];
  const player = {
    bridge: Promise.resolve({ client: { request: prepare } }),
    loadScriptStorage: async () => {},
    rememberScriptName: () => {},
    scriptStorageOptions: () => ({}),
    temporalCapture: () => ({}),
    prepareScript,
    reportHostError: (error: unknown) => void reported.push(error),
  };
  const host = { load: async () => ({ project: 'say "x"\nexit' }) };
  return { player, host, reported };
}
const preparedReply = async () => ({
  result: {
    kind: "prepared",
    plan: "p1",
    diagnostics: [],
    identity: null,
    metadata: { files: [], stageImages: [], randomSites: [], locks: false, encrypts: false },
  },
});

test("the hosted script's preparation lost with the Worker ends quietly, and another failure says it cannot be opened", async () => {
  covered.add("the hosted script's preparation");
  for (const [error, shows] of [
    [new client.BridgeLostError("lost"), false],
    [new Error("The host failed."), true],
  ] as const) {
    let failure: object | null | "unset" = "unset";
    const unhandled = await unhandledDuring(async () => {
      const page = startPage(
        () => Promise.reject(error),
        async () => {},
      );
      const prepared = prepareHostedScript(page.player, page.host);
      await turns(4);
      failure = prepared.failure.value;
    });
    assert.deepEqual(unhandled, []);
    assert.equal(failure !== null, shows, String(error));
  }
});

test("the start page's preparation lost with the Worker ends quietly, and its other failure is the Player error stop", async () => {
  covered.add("the start page's preparation");
  for (const [error, reports] of [
    [new client.BridgeLostError("lost"), 0],
    [new Error("The kept session could not be read."), 1],
  ] as const) {
    const page = startPage(preparedReply, () => Promise.reject(error));
    const unhandled = await unhandledDuring(async () => {
      prepareHostedScript(page.player, page.host);
      await turns(4);
    });
    assert.deepEqual(unhandled, []);
    assert.equal(page.reported.length, reports, String(error));
  }
});

test("control: a Stage photo preload whose metadata the Worker's loss ends preloads nothing", async () => {
  covered.add("a Stage photo preload");
  const preloaded: string[] = [];
  const connection: PreloadConnection = {
    client: { request: () => Promise.reject(new client.BridgeLostError("lost")) },
  };
  const scope = effectScope();
  const unhandled = await unhandledDuring(async () => {
    scope.run(() =>
      usePlanPhotoPreload(
        () => ({ connection, planToken: "p1" }),
        (path) => path,
        (sources) => {
          preloaded.push(...sources);
          return () => {};
        },
      ),
    );
  });
  scope.stop();
  assert.deepEqual([unhandled, preloaded], [[], []]);
});

// The no-loss controls: each row above on the same schedule, its reply held and let go without a loss, completes.

RERUN.rows(
  "control: media load report in flight",
  "control: a media load report held and let go without a loss lets the script go on",
  async (context, topology) => {
    const { transport, player, elements, hostErrors } = await mount(
      context,
      topology,
      50,
      AWAITS_ITS_MEDIUM,
    );
    transport.hold("reportMediaLoad");
    elements
      .find((element) => element.src.endsWith("bell.mp3"))!
      .dispatchEvent(new Event("loadedmetadata"));
    await transport.held();
    transport.release();
    await until(
      () =>
        player.session.value?.transcriptEntries.some((entry) => entry.text === "after") ?? false,
      "the script goes on",
    );
    assert.equal(player.hostError.value, null);
    assert.equal(hostErrors(), 0);
  },
);

RERUN.rows(
  "control: call view in flight",
  "control: a call view request held and let go without a loss shows the call view",
  async (context, topology) => {
    const { transport, player, hostErrors } = await mount(context, topology, 50);
    transport.hold("viewCalls");
    player.demandCallView();
    await transport.held();
    transport.release();
    await until(() => player.session.value?.callView != null, "the call view shows");
    assert.equal(hostErrors(), 0);
  },
);

RERUN.rows(
  "control: keep's capture in flight",
  "control: a keep's capture held and let go without a loss keeps the new point",
  async (context, topology) => {
    const kept = memoryKeptSessionStore();
    const { transport, player, token } = await keepingPage(
      context,
      kept,
      topology,
      50,
      'showButton "One", timeout: 300 ms\nlet pick = askChoice "Go"\nsay "x", instant\nexit',
    );
    await player.prepareScript(token, { plan: token, options: () => ({ wallClockMs: 0 }) });
    await player.activate();
    for (let turn = 0; (await kept.session("loss")) === null; turn++) {
      assert.ok(turn < 100, "the session was not kept");
      await turns(1);
    }
    const before = await kept.session("loss");
    transport.hold("captureKeep");
    await transport.held();
    transport.release();
    for (let turn = 0; isDeepStrictEqual(await kept.session("loss"), before); turn++) {
      assert.ok(turn < 100, "the new point was not kept");
      await turns(1);
    }
    assert.equal(player.hostError.value, null);
  },
);

RERUN.rows(
  "control: Continue's restore in flight",
  "control: Continue's restore held and let go without a loss offers Continue",
  async (context, topology) => {
    const kept = memoryKeptSessionStore();
    {
      const first = await keepingPage(context, kept, "in-process", 0);
      await first.player.prepareScript(first.token, {
        plan: first.token,
        options: () => ({ wallClockMs: 0 }),
      });
      await first.player.activate();
      for (let turn = 0; (await kept.session("loss")) === null; turn++) {
        assert.ok(turn < 100, "the session was not kept");
        await turns(1);
      }
    }
    const { transport, player, token } = await keepingPage(context, kept, topology, 50);
    transport.hold("restoreKept");
    const preparing = player.prepareScript(token, {
      plan: token,
      options: () => ({ wallClockMs: 0 }),
    });
    await transport.held();
    transport.release();
    await preparing;
    assert.equal(player.activation.value, "continue");
  },
);

RERUN.rows(
  "control: hosted script's preparation in flight",
  "control: the hosted script's preparation held and let go without a loss offers Start",
  async (context, topology) => {
    browser(context);
    const hostErrors = hostErrorLog(context);
    const transport = await topologyBridge(context, topology, { delayMs: 50 });
    const scope = effectScope();
    const player = scope.run(() =>
      usePlayerSession({
        bridge: Promise.resolve(transport.bridge),
        debugHistorySpill: async () => null,
      }),
    )!;
    context.after(() => scope.stop());
    await player.bridge;
    transport.hold("prepare");
    const prepared = prepareHostedScript(player, {
      load: async () => ({ project: 'say "x"\nexit' }),
    });
    await transport.held();
    transport.release();
    await until(() => player.activation.value === "start", "Start is offered");
    assert.equal(prepared.failure.value, null);
    assert.equal(hostErrors(), 0);
  },
);

test("each connection's post log and reply gate see its own requests alone, with two connections live", async (context) => {
  for (const topology of TOPOLOGIES) {
    const held = await topologyBridge(context, topology, { delayMs: 5 });
    // Let go also when an assertion below fails, so the gate holds nothing of a later test.
    context.after(() => held.release());
    const other = await topologyBridge(context, topology, { delayMs: 5 });
    const before = held.posts.length;
    held.hold("prepare");
    const reply = other.bridge.client.request("prepare", {
      source: { kind: "source", script: "exit" },
    });
    const late = new Promise((resolve) => setTimeout(() => resolve("held"), 2_000));
    const settled = await Promise.race([reply.then((answer) => answer.result.kind), late]);
    assert.equal(settled, "prepared", "the other connection's reply is not held");
    assert.deepEqual(held.posts.slice(before), [], "the held connection logged nothing");
    assert.ok(other.posts.some((post) => post.op === "prepare"));
  }
});

test("the rows' Worker loss is the thread's real exit, and each topology is the one asked for", async (context) => {
  for (const topology of TOPOLOGIES) {
    const transport = await topologyBridge(context, topology, { delayMs: 50 });
    transport.assertTopology();
    let reported = "";
    transport.bridge.client.onLoss((error) => (reported = error.message));
    await transport.lose();
    if (topology === "worker") {
      // The client ends the thread on any loss, so the exit alone would not tell an injected loss from the thread's own.
      assert.match(
        reported,
        /exited with code/u,
        "the loss the client reports is the thread's exit",
      );
      assert.equal(typeof (await transport.exited), "number");
    } else assert.equal(transport.exited, null);
  }
});
