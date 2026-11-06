import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, watch, type Ref } from "vue";

import type * as CompileProject from "../player/compile-project.js";
import type * as InProcess from "../player/engine-bridge/in-process.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import type * as RuntimeAdapter from "../player/runtime-adapter.js";
import type {
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import {
  playerRuntimeForeground,
  playerRuntimePacingGate,
  type PlayerSession,
  type PlayerSessionView,
} from "../player/runtime-view.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import {
  presentedAction,
  runtimeInput,
  type Intent,
  type RuntimeInput,
} from "./helpers/player-input.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

/*
 * The Player's input over the engine's bridge (L5c), through the production intents, the input chain
 * (`runtime-input.ts`) and the composable's input section, on a host that replies after 250 ms. Each input is posted
 * only while its session owns the UI: a replacement, a stop or an unmount while the observation's reply or the op's
 * reply is in transit opens no tab and answers nothing of the old session. None of L5c's requests reads a basis, so a
 * change of the session between their post and their dispatch refuses none of them. A storage write is acknowledged
 * once, and a Debug edit reaches the live session once no script write waits.
 */

interface InputHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly inputSection: unknown;
  prepare(create: (recording: PlayerRuntimeSessionOptions) => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  reportHostError(error: unknown): void;
  update(next: PlayerSession): void;
  pressPermanentButton(buttonId: number): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  editSavedData(edit: {
    readonly key: string;
    readonly value: SerializableRuntimeValue;
    readonly expected: SerializableRuntimeValue | undefined;
  }): Promise<{ readonly kind: string; readonly live?: boolean }>;
  readonly images: {
    store(
      file: File,
      request: { readonly types: null; readonly mime: null },
    ): Promise<{ readonly reference: string } | { readonly message: string }>;
    discard(reference: string): void;
  };
  resolveAsset(path: string): string | null;
  readonly imageCapture: {
    readonly view: Readonly<Ref<{ readonly ready: boolean } | null>>;
    choose(reference: string): boolean;
    answer(input: "button"): Intent;
  };
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly scriptStorage?: ScriptStorageProvider;
  readonly decodeImage?: () => Promise<{ readonly width: number; readonly height: number }>;
}) => InputHost;
let facade: typeof InProcess;
let compiler: typeof CompileProject;
let adapter: typeof RuntimeAdapter;
let input: RuntimeInput;

before(async () => {
  const module = await loadPlayerModule("player/vue/src/usePlayerSession.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: the bundle the composable runs in, whose facade reaches its sessions.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/compile-project.ts")) as typeof compiler;
  // EVIDENCE: validation: the bundle's adapter, whose sessions the facade's host holds.
  adapter = (await loadPlayerModule("player/runtime-adapter.ts")) as typeof adapter;
  input = await runtimeInput();
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function settle(turns = 10) {
  for (let index = 0; index < turns; index += 1) await turn();
}
/** Waits `ms` of real time: a storage write is reported in a later task (`setTimeout`), then acknowledged. */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Player on a host that replies after `delayMs`, in a browser surface with event targets and silent audio. */
async function mount(
  context: TestContext,
  {
    delayMs = 250,
    scriptStorage,
  }: { delayMs?: number; scriptStorage?: ScriptStorageProvider } = {},
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
  const host = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(bridge),
      debugHistorySpill: async () => null,
      decodeImage: async () => ({ width: 1, height: 1 }),
      ...(scriptStorage === undefined ? {} : { scriptStorage }),
    }),
  )!;
  context.after(() => {
    scope.stop();
    bridge.client.terminate();
  });
  await host.bridge;
  if (scriptStorage !== undefined) await host.loadScriptStorage();
  return { bridge, host, scope, posted: track(context, bridge) };
}

/**
 * The ops each section of `bridge` posts, in order, with their arguments; `on(op, …)` runs once when `op` is posted, and
 * `replied` lists the replies' ops as they arrive.
 */
function track(context: TestContext, bridge: PlayerBridge) {
  const posts: { readonly op: string; readonly args: Record<string, unknown> }[] = [];
  const replied: string[] = [];
  const hooks = new Map<string, () => void>();
  const section = bridge.client.section.bind(bridge.client);
  context.mock.method(
    bridge.client,
    "section",
    (session: string, body: Parameters<typeof section>[1]) =>
      section(session, (send) =>
        body((op, args, basis, onReply) => {
          // EVIDENCE: fixture: the ops of this file's tests post record arguments.
          const record = args as Record<string, unknown>;
          posts.push({ op, args: record });
          const sent = send(op, args, basis, onReply);
          const hook = hooks.get(op);
          hooks.delete(op);
          hook?.();
          return sent.then((reply) => {
            replied.push(op);
            return reply;
          });
        }),
      ),
  );
  return {
    posts,
    replied,
    ops: () => posts.map((post) => post.op),
    on: (op: string, hook: () => void) => void hooks.set(op, hook),
  };
}

const factory =
  (script: string, extra: () => PlayerRuntimeSessionOptions = () => ({})) =>
  (recording: PlayerRuntimeSessionOptions): PlayerRuntimeSession =>
    compiler.createPlayerRuntimeSession(script, { ...recording, ...extra(), wallClockMs: 0 });

async function start(host: InputHost, script: string, storage = false) {
  host.prepare(factory(script, () => (storage ? host.scriptStorageOptions() : {})));
  await host.activate();
  assert.ok(host.session.value);
  return host.session.value;
}

/** Answers the presented interaction with `intent` through the input chain, as a control does. */
function answer(host: InputHost, intent: Intent, presented = presentedAction(host.session.value!)) {
  return input.runInput(host.inputSection, presented, presentedAction, intent);
}

const options = (session: PlayerSessionView) => {
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  return foreground.options;
};
const said = (host: InputHost) =>
  host.session.value?.transcriptEntries.map((entry) => entry.text) ?? [];

const CONTROLS = [
  'let name = askText "Name?"',
  'say "hi ${name}", instant',
  'let pick = askChoice "A", "B"',
  'showButton "Go"',
  'let answers = askForm fields: { first: { type: "text", text: "First" } }',
  'let skipped = askImage("Skip", allowSkip: true)',
  'showPopup "Done"',
  'exportText("Plain")',
  'openUrl("https://example.com")',
  'say "end", instant',
  "exit",
].join("\n");

test("every control answers with its op and how the player answered, which the recording keeps", async (context) => {
  const { bridge, host, posted } = await mount(context);
  await start(host, CONTROLS);
  const steps: readonly (readonly [string, () => Intent])[] = [
    ["composer", () => input.intents.composer(() => "Ann", "enter")],
    ["choice", () => input.intents.choice(options(host.session.value!)[1]!.id, "button")],
    ["button", () => input.intents.choice(null, "preselectedKey")],
    ["step", () => input.intents.formStep("first", () => undefined)],
    ["clear", () => input.intents.formClear],
    ["dismiss", () => input.intents.formDismiss],
    ["step again", () => input.intents.formStep("first", () => undefined)],
  ];
  for (const [name, intent] of steps)
    assert.equal((await answer(host, intent())).kind, "answered", name);
  const drafted = await input.draftInput(
    host.inputSection,
    { actionId: presentedAction(host.session.value!)!, fieldId: "first" },
    "Bo",
  );
  assert.ok(drafted, "the draft updated the form");
  for (const [name, intent] of [
    ["submit", input.intents.formSubmit(() => "Bo", "button")],
    ["skip", input.intents.imageSkip("button")],
    ["popup", input.intents.popupClose("button")],
    ["export", input.intents.exportClose("button")],
    ["url", input.intents.url(() => true, "button")],
  ] as const)
    assert.equal((await answer(host, intent)).kind, "answered", name);
  assert.deepEqual(
    posted.posts
      .filter((post) => post.op !== "observeInput")
      .map((post) => [post.op, post.args.input ?? null]),
    [
      ["submitComposer", "enter"],
      ["selectChoice", "button"],
      ["activateButton", "preselectedKey"],
      ["stepFormField", null],
      ["clearFormField", null],
      ["dismissFormField", null],
      ["stepFormField", null],
      ["draftForm", null],
      ["submitForm", "button"],
      ["skipImage", "button"],
      ["closePopup", "button"],
      ["closeExport", "button"],
      ["openUrl", "button"],
    ],
  );
  assert.equal(host.session.value?.state.status, "halted");
  assert.ok(said(host).includes("hi Ann") && said(host).includes("end"), said(host).join(" | "));
  // The recording keeps how each answer was given, as the Player gave it before L5c.
  assert.deepEqual(
    facade
      .heldRecording(bridge)!
      .operations.flatMap((operation) => (operation.input == null ? [] : [operation.input])),
    ["enter", "button", "preselectedKey", "button", "button", "button", "button", "button"],
  );
});

test("an input to an action no longer presented posts no op", async (context) => {
  const { host, posted } = await mount(context);
  await start(host, 'let pick = askChoice "A", "B"\nexit');
  const presented = presentedAction(host.session.value!)!;
  const result = await answer(host, input.intents.choice(null, "button"), presented + 1);
  assert.equal(result.kind, "unavailable");
  assert.deepEqual(posted.ops(), ["observeInput"]);
});

for (const interference of ["a replacement", "a stop", "an unmount"] as const)
  test(`${interference} while the observation's reply is in transit opens no tab and posts no answer`, async (context) => {
    const { host, scope, posted } = await mount(context);
    await start(host, 'openUrl("https://example.com")\nsay "after", instant\nexit');
    let opened = 0;
    const answering = answer(
      host,
      input.intents.url(() => {
        opened += 1;
        return true;
      }, "button"),
    );
    if (interference === "a replacement") {
      host.prepare(factory('say "replacement", instant\nshowButton "New"\nexit'));
      await host.activate();
    } else if (interference === "a stop") host.reportHostError(new TypeError("a component failed"));
    else scope.stop();
    const result = await answering;
    await settle();
    assert.equal(result.kind, "retired");
    assert.equal(opened, 0, "no tab opened");
    assert.equal(posted.ops().includes("openUrl"), false, "no answer posted");
  });

test("a request still queued in the host at a stop is refused without effect, and the chain retires", async (context) => {
  const { bridge, host, posted } = await mount(context);
  await start(host, 'let pick = askChoice "A", "B"\nexit');
  // The host awaits a source `prepare`, so the observation waits behind it in the host.
  const compiling = bridge.client.request("prepare", {
    source: { kind: "source", script: "exit" },
  });
  const answering = answer(host, input.intents.choice(null, "button"));
  host.reportHostError(new TypeError("a component failed"));
  await compiling;
  const result = await answering;
  assert.equal(result.kind, "retired");
  assert.deepEqual(posted.ops(), ["observeInput"]);
  assert.equal(host.hostError.value, "TypeError");
  assert.equal(host.session.value?.state.status, "waiting");
});

test("an answer dispatched before a stop shows through the stop's commit, and nothing after the stop line", async (context) => {
  const { bridge, host, posted } = await mount(context);
  await start(
    host,
    'let pick = askChoice "A", "B"\nsay "picked ${pick}", instant\nshowButton "End"\nexit',
  );
  const afterStop: unknown[] = [];
  const stopWatch = watch(
    host.session,
    (shown) => {
      if (host.hostError.value !== null) afterStop.push(shown?.revision);
    },
    { flush: "sync" },
  );
  context.after(stopWatch);
  posted.on("selectChoice", () =>
    queueMicrotask(() => host.reportHostError(new TypeError("a component failed"))),
  );
  const result = await answer(
    host,
    input.intents.choice(options(host.session.value!)[1]!.id, "button"),
  );
  await settle();
  assert.equal(result.kind, "retired", "no feedback after the stop");
  assert.equal(host.hostError.value, "TypeError");
  assert.ok(said(host).includes("picked B"), "the dispatched answer shows");
  assert.equal(bridge.frozen(host.session.value!), true);
  assert.equal(host.session.value, bridge.latest(host.session.value!));
  assert.deepEqual(afterStop, []);
});

for (const interference of ["a replacement", "an unmount"] as const)
  test(`${interference} while an answer's reply is in transit shows nothing of the old session`, async (context) => {
    const { host, scope, posted } = await mount(context);
    await start(
      host,
      'let pick = askChoice "A", "B"\nsay "picked ${pick}", instant\nshowButton "End"\nexit',
    );
    let replaced: Promise<void> = Promise.resolve();
    let atStart: PlayerSession | null = null;
    posted.on("selectChoice", () => {
      atStart = host.session.value;
      if (interference === "an unmount") scope.stop();
      else {
        host.prepare(factory('say "replacement", instant\nshowButton "New"\nexit'));
        replaced = host.activate();
      }
    });
    const result = await answer(
      host,
      input.intents.choice(options(host.session.value!)[1]!.id, "button"),
    );
    await replaced;
    await settle();
    assert.equal(result.kind, "retired");
    if (interference === "an unmount") assert.equal(host.session.value, atStart);
    else assert.deepEqual(said(host), ["replacement"]);
  });

test("a blocked tab posts no answer, so its button stays; a tab opens only after the observation's reply", async (context) => {
  const { host, posted } = await mount(context);
  await start(host, 'openUrl("https://example.com")\nsay "after", instant\nexit');
  const blocked = await answer(
    host,
    input.intents.url(() => false, "button"),
  );
  assert.equal(blocked.kind, "unanswered");
  assert.equal(posted.ops().includes("openUrl"), false);
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "open-url");
  const order: string[] = [];
  const opened = await answer(
    host,
    input.intents.url(() => {
      order.push(`effect after ${posted.replied.join(",")}; posted ${posted.ops().join(",")}`);
      return true;
    }, "button"),
  );
  assert.equal(opened.kind, "answered");
  assert.deepEqual(order, [
    "effect after observeInput,observeInput; posted observeInput,observeInput",
  ]);
  assert.deepEqual(posted.ops(), ["observeInput", "observeInput", "openUrl"]);
});

for (const target of ["an answer", "the pacing skip"] as const)
  test(`${target} is not refused when the session changed while its requests waited in the host`, async (context) => {
    const { bridge, host, posted } = await mount(context, { delayMs: 50 });
    await start(
      host,
      target === "an answer"
        ? 'timer async 10 ms {\n    say "tick", instant\n}\nlet pick = askChoice "A", "B"\nsay "picked ${pick}", instant\nshowButton "End"\nexit'
        : 'timer async 10 ms {\n    say "tick", instant\n}\nsay "paced"\nsay "next", instant\nshowButton "End"\nexit',
    );
    // The host awaits a source `prepare`; the input's requests wait behind it while a facade call changes the session.
    const compiling = bridge.client.request("prepare", {
      source: { kind: "source", script: "exit" },
    });
    const shown = host.session.value!;
    const answering =
      target === "an answer"
        ? answer(host, input.intents.choice(options(shown)[1]!.id, "button"))
        : input.runInput(
            host.inputSection,
            playerRuntimePacingGate(shown)?.actionId,
            (session) => playerRuntimePacingGate(session)?.actionId,
            input.intents.pacing,
          );
    const changed = facade.observeNow(shown, 20, []);
    assert.notEqual(
      changed.session.revision,
      shown.revision,
      "the facade call changed the session",
    );
    await compiling;
    const result = await answering;
    await settle();
    assert.equal(result.kind, "answered");
    assert.equal(host.hostError.value, null);
    assert.equal(posted.ops().filter((op) => op !== "observeInput").length, 1);
  });

/** A provider that keeps what it stored, records each write, and settles each as `settle` decides. */
function provider(settle: (key: string) => Promise<void> = async () => {}) {
  const stored = new Map<string, SerializableRuntimeValue>();
  const writes: string[] = [];
  const storage: ScriptStorageProvider = {
    scope: "test",
    load: async () => [...stored].map(([key, value]) => ({ key, value })),
    write: async (key, value) => {
      writes.push(key);
      await settle(key);
      stored.set(key, value);
    },
    replace: async () => {},
    clear: async () => {},
  };
  return { storage, writes, stored };
}

test("a storage write is acknowledged once, also when its session was changed or shown again before the acknowledgement applied", async (context) => {
  const store = provider();
  const { bridge, host, posted } = await mount(context, {
    delayMs: 50,
    scriptStorage: store.storage,
  });
  await start(
    host,
    'showButton "Go"\nsave 1 as "kept"\nsay "saved", instant\nshowButton "End"\nexit',
    true,
  );
  // The host awaits a source `prepare` when the acknowledgement is posted, and a facade call changes the session.
  let compiling: Promise<unknown> = Promise.resolve();
  posted.on("completeStorageWrite", () => {
    compiling = bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
    // The pending write shows again meanwhile, which issues no second provider write.
    host.update({ ...host.session.value! });
  });
  assert.equal((await answer(host, input.intents.choice(null, "button"))).kind, "answered");
  await wait(200);
  await compiling;
  await wait(200);
  assert.deepEqual(store.writes, ["kept"]);
  assert.equal(posted.ops().filter((op) => op === "completeStorageWrite").length, 1);
  assert.ok(said(host).includes("saved"));
  assert.equal(host.hostError.value, null);
});

for (const interference of ["a replacement", "a stop", "an unmount"] as const)
  test(`${interference} while a storage write's acknowledgement is in transit shows nothing more of the old session`, async (context) => {
    const store = provider();
    const { bridge, host, scope, posted } = await mount(context, {
      delayMs: 50,
      scriptStorage: store.storage,
    });
    await start(
      host,
      'showButton "Go"\nsave 1 as "kept"\nsay "saved", instant\nshowButton "End"\nexit',
      true,
    );
    let replaced: Promise<void> = Promise.resolve();
    posted.on("completeStorageWrite", () => {
      if (interference === "a replacement") {
        host.prepare(factory('say "replacement", instant\nshowButton "New"\nexit'));
        replaced = host.activate();
      } else if (interference === "a stop")
        host.reportHostError(new TypeError("a component failed"));
      else scope.stop();
    });
    await answer(host, input.intents.choice(null, "button"));
    await replaced;
    const atInterference = host.session.value;
    await wait(200);
    assert.deepEqual(store.writes, ["kept"]);
    if (interference === "a replacement") assert.deepEqual(said(host), ["replacement"]);
    else if (interference === "an unmount") assert.equal(host.session.value, atInterference);
    else {
      // A dispatched acknowledgement shows through the stop's commit, as any reply before the stop line.
      assert.equal(host.hostError.value, "TypeError");
      assert.equal(host.session.value, bridge.latest(host.session.value!));
    }
  });

const EDITED = [
  'showButton "Go"',
  'save 2 as "kept"',
  'let edited: integer? = load "edited", default: null',
  'let kept: integer? = load "kept", default: null',
  'say "edited ${edited} kept ${kept}", instant',
  'showButton "End"',
  "exit",
].join("\n");

for (const when of ["while it waits for its section", "after it was posted"] as const)
  for (const [key, failing] of [
    ["edited", false],
    ["kept", false],
    ["kept", true],
  ] as const)
    test(`a Debug edit of "${key}" meets a script write${failing ? " that fails" : ""} that became pending ${when}, and is stored once`, async (context) => {
      const store = provider(async (written) => {
        if (failing && written === "kept" && store.writes.filter((k) => k === "kept").length > 1)
          throw new Error("denied");
      });
      const { bridge, host, posted } = await mount(context, {
        delayMs: 50,
        scriptStorage: store.storage,
      });
      await start(host, EDITED, true);
      let edit!: Promise<{ readonly kind: string; readonly live?: boolean }>;
      if (when === "while it waits for its section") {
        // The edit's section waits behind an input whose answer reaches the save.
        posted.on("activateButton", () => {
          edit = host.editSavedData({ key, value: 7, expected: undefined });
        });
        await answer(host, input.intents.choice(null, "button"));
      } else {
        // The edit is posted while the host awaits a source `prepare`; a facade call then reaches the save.
        const compiling = bridge.client.request("prepare", {
          source: { kind: "source", script: "exit" },
        });
        posted.on("applyStorageEdit", () => {
          const shown = host.session.value!;
          host.update(
            facade.hatch(shown, (session) => adapter.activatePlayerRuntimeButton(session))!.session,
          );
        });
        edit = host.editSavedData({ key, value: 7, expected: undefined });
        await compiling;
      }
      const result = await edit;
      await wait(200);
      assert.equal(
        store.writes.filter((written) => written === key).length,
        key === "kept" ? 2 : 1,
      );
      if (key === "kept" && !failing) assert.deepEqual(result, { kind: "overtaken" });
      else assert.deepEqual(result, { kind: "saved", live: true });
      assert.equal(host.hostError.value, null);
    });

test("an image answer keeps its image held, also when the request ended before the answer settled", async (context) => {
  const { host } = await mount(context);
  await start(host, 'let first = askImage("First")\nlet second = askImage("Second")\nexit');
  const choose = async (name: string) => {
    const stored = await host.images.store(new File([PNG], name), { types: null, mime: null });
    assert.ok("reference" in stored);
    assert.equal(host.imageCapture.choose(stored.reference), true);
    return stored.reference;
  };
  // The answer's publication ends the request before the answer settles in the chain: the image stays.
  const first = await choose("first.png");
  assert.equal((await answer(host, host.imageCapture.answer("button"))).kind, "answered");
  assert.notEqual(host.resolveAsset(first), null, "the answered image stays held");
  // An image the store no longer holds is refused, as the held table says, and the preview returns.
  const second = await choose("second.png");
  host.images.discard(second);
  const refused = await answer(host, host.imageCapture.answer("button"));
  assert.equal(refused.kind, "answered");
  assert.equal(refused.outcome?.kind, "invalidPayload");
  assert.equal(host.imageCapture.view.value?.ready, true, "the preview returns");
});

test("a permanent button is pressed at the observed time, and a replaced session's press posts nothing", async (context) => {
  const { host, posted } = await mount(context);
  await start(
    host,
    'showPermanentButton "Tick" {\n    say "tick", instant\n}\nshowButton "End"\nexit',
  );
  await host.pressPermanentButton(1);
  await settle();
  assert.ok(said(host).includes("tick"));
  // A replacement while the press's observation is in transit: the press goes to neither session.
  let replaced: Promise<void> = Promise.resolve();
  posted.on("observeInput", () => {
    host.prepare(factory('say "replacement", instant\nshowButton "New"\nexit'));
    replaced = host.activate();
  });
  await host.pressPermanentButton(1);
  await replaced;
  await settle();
  assert.deepEqual(said(host), ["replacement"]);
  assert.equal(posted.ops().filter((op) => op === "pressPermanentButton").length, 1);
});
