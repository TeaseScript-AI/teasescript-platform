import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import { CapturedMediaStore } from "../../player/media/captured-media.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { BridgeLostError } from "../../player/engine-bridge/client.js";
import { loadAge, loadTlock } from "../../player/encryption/content-lock.js";
import type * as Client from "../../player/engine-bridge/client.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
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

/*
 * When the engine's Worker is lost, every request still waiting for its reply ends its caller quietly: the loss is the
 * Player error stop, which `bridgeLost` reports once, and no caller reports it again or leaves its rejection unhandled
 * (L5g). The cases come from the Player's consumers of bridge requests: those whose handling L5g changed must fail with
 * that handling reverted; the ones that were already safe are controls. A loss is injected as the client meets a real
 * one, so the composable runs on its own in-process engine (the topology the L5 series keeps it on): the client
 * rejects everything pending and posts nothing more (`terminate`), and its loss listeners run in the same tick.
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

/** Makes `bridge`'s client lose its Worker on `lose()`, as a real loss: `Lost` is the client module's error class. */
function injectLoss(bridge: PlayerBridge, Lost: typeof BridgeLostError) {
  const listeners: ((error: BridgeLostError) => void)[] = [];
  const client = bridge.client;
  client.onLoss = (listener) => void listeners.push(listener);
  return () => {
    client.terminate();
    const lost = new Lost("The engine Worker failed: injected.");
    for (const listener of listeners) listener(lost);
  };
}

const turns = async (count: number) => {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
};

/**
 * Holds the replies the in-process host schedules `delayMs` after a request, until the returned release: what is posted
 * meanwhile is in flight however long the test's own turns take, as on a loaded machine they may take longer.
 */
function holdReplies(context: TestContext, delayMs: number): () => void {
  const timeout = globalThis.setTimeout;
  const held: (() => void)[] = [];
  const hold = (callback: () => void, ms?: number) => {
    if (ms !== delayMs) return timeout(callback, ms);
    held.push(callback);
    return timeout(() => {}, 0);
  };
  // EVIDENCE: invariant: `hold` keeps `setTimeout`'s call shape for the callbacks these tests and the host schedule.
  const scheduled = context.mock.method(globalThis, "setTimeout", hold as typeof setTimeout);
  return () => {
    scheduled.mock.restore();
    for (const callback of held.splice(0)) timeout(callback, 0);
  };
}

// The services, through the same section host as their own tests, on a host whose replies take 50 ms.

/** A service's host around `session`: its section, and the op it sends, with a loss at the post of `lossAt`. */
function serviceHost(bridge: PlayerBridge, session: PlayerSession, lossAt: string) {
  const lose = injectLoss(bridge, BridgeLostError);
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
let facade: typeof InProcess;
let client: typeof Client;
let compiler: typeof import("../../player/runtime/compile-project.js");
/** What `prepareHostedScript` reads of the Player, as `startPage` gives it. */
type StartPagePlayer = ReturnType<typeof startPage>["player"];
let prepareHostedScript: (
  player: StartPagePlayer,
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
  // EVIDENCE: validation: the bundle's in-process backend, whose sessions the composable's facade reaches.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
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

/** The real composable on its in-process engine, with replies after `delayMs`, and a loss to inject. */
async function mount(context: TestContext, delayMs: number) {
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
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void errors.push(String(args[0]));
  context.after(() => void (console.error = log));
  const bridge = facade.createInProcessBackend(BUILD, { delayMs });
  const lose = injectLoss(bridge, client.BridgeLostError);
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(bridge),
      debugHistorySpill: async () => null,
      resolveAsset: (path) => `https://fixture/${path}`,
    }),
  )!;
  context.after(() => scope.stop());
  await player.bridge;
  player.prepare(
    await sourceStart(
      player.bridge,
      'playAudio async "bell.mp3"\nlet pick = askChoice "Go"\nexit',
      () => ({ wallClockMs: 0 }),
    ),
  );
  await player.activate();
  const hostErrors = () => errors.filter((line) => line.includes("host error")).length;
  return { bridge, player, lose, elements, hostErrors };
}

for (const [consumer, run] of [
  [
    "an input section's observation",
    (player: LossHost) => player.inputSection("inputAnswer", async (_s, observed) => observed),
  ],
  [
    "an input section's op",
    (player: LossHost) =>
      // A row that observes nothing, so the op is the section's first post.
      player.inputSection("inputDraft", (s) => s.send("observeInput", { atMs: 0, media: [] })),
  ],
] as const)
  test(`${consumer} in flight when the Worker is lost ends quietly, and the loss is the error stop once`, async (context) => {
    covered.add(consumer);
    const { player, lose, hostErrors } = await mount(context, 50);
    let result: Awaited<ReturnType<typeof run>> | "pending" = "pending";
    const unhandled = await unhandledDuring(async () => {
      const release = holdReplies(context, 50);
      const pending = run(player);
      // Posted; its reply is held until after the loss, so it is in flight then.
      await turns(2);
      lose();
      release();
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
  });

for (const [consumer, run] of [
  [
    "an observation still queued in the client",
    (player: LossHost) => player.inputSection("inputAnswer", async (_s, observed) => observed),
  ],
  [
    "an op still queued in the client",
    (player: LossHost) =>
      player.inputSection("inputDraft", (s) => s.send("observeInput", { atMs: 0, media: [] })),
  ],
] as const)
  test(`control: ${consumer} at the loss never posts, as the stop ends it first`, async (context) => {
    covered.add(consumer);
    const { bridge, player, lose, hostErrors } = await mount(context, 0);
    // Another section of the session holds it, so this one waits in the client.
    let release = () => {};
    void bridge.section(
      player.session.value!,
      clockTicket(),
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const unhandled = await unhandledDuring(async () => {
      const pending = run(player);
      lose();
      release();
      await pending;
    });
    assert.deepEqual(unhandled, []);
    assert.equal(hostErrors(), 1);
  });

test("control: a media load report in flight when the Worker is lost ends quietly", async (context) => {
  covered.add("a media load report");
  const { player, lose, elements, hostErrors } = await mount(context, 50);
  const unhandled = await unhandledDuring(async () => {
    elements
      .find((element) => element.src.endsWith("bell.mp3"))!
      .dispatchEvent(new Event("loadedmetadata"));
    await turns(2);
    lose();
  });
  assert.deepEqual(unhandled, []);
  assert.equal(player.hostError.value, "BridgeLostError");
  assert.equal(hostErrors(), 1);
});

test("a call view request in flight when the Worker is lost ends quietly, and the loss is the error stop once", async (context) => {
  covered.add("a call view request");
  const { player, lose, hostErrors } = await mount(context, 50);
  const unhandled = await unhandledDuring(async () => {
    // Debug's Now view opens: its call view request is posted, its reply 50 ms away.
    player.demandCallView();
    await turns(2);
    lose();
  });
  assert.deepEqual(unhandled, []);
  assert.equal(player.hostError.value, "BridgeLostError");
  assert.equal(hostErrors(), 1);
});

/** A page whose script keeps its session, on its in-process engine with replies after `delayMs`, and a loss to inject. */
async function keepingPage(context: TestContext, kept: KeptSessionStore, delayMs: number) {
  for (const [name, value] of Object.entries({
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    // A Start primes the audio elements it may need.
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const scriptStorage: ScriptStorageProvider = {
    scope: "loss",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const bridge = facade.createInProcessBackend(BUILD, { delayMs });
  const lose = injectLoss(bridge, client.BridgeLostError);
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(bridge),
      debugHistorySpill: async () => null,
      scriptStorage,
      keptSessions: kept,
    }),
  )!;
  context.after(() => scope.stop());
  await player.loadScriptStorage();
  const plan = compiler.compilePlayerProject(
    'let pick = askChoice "Go"\nsay "x", instant\nexit',
  ).plan!;
  const token = await preparedPlan(player.bridge, plan);
  return { bridge, player, lose, token };
}

test("a keep's capture in flight when the Worker is lost keeps the session kept before, and ends quietly", async (context) => {
  covered.add("a keep's capture");
  const kept = memoryKeptSessionStore();
  const { player, lose, token } = await keepingPage(context, kept, 50);
  await player.prepareScript(token, { plan: token, options: () => ({ wallClockMs: 0 }) });
  await player.activate();
  // The session is kept at the question it presents.
  for (let turn = 0; (await kept.session("loss")) === null; turn++) {
    assert.ok(turn < 100, "the session was not kept");
    await turns(1);
  }
  const before = await kept.session("loss");
  const unhandled = await unhandledDuring(async () => {
    // Hiding the page keeps the session again; its capture is posted, its reply 50 ms away.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await turns(2);
    lose();
  });
  assert.deepEqual(unhandled, []);
  assert.deepEqual(await kept.session("loss"), before, "the session kept before stays");
  assert.equal(player.hostError.value, "BridgeLostError");
});

test("Continue's restore in flight when the Worker is lost ends quietly, and offers no Continue", async (context) => {
  covered.add("Continue's restore");
  const kept = memoryKeptSessionStore();
  {
    const first = await keepingPage(context, kept, 0);
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
  const { player, lose, token } = await keepingPage(context, kept, 50);
  const unhandled = await unhandledDuring(async () => {
    const preparing = player.prepareScript(token, {
      plan: token,
      options: () => ({ wallClockMs: 0 }),
    });
    // The restore is posted, its reply 50 ms away.
    await turns(2);
    lose();
    await preparing;
  });
  assert.deepEqual(unhandled, []);
  assert.notEqual(player.activation.value, "continue");
});

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
