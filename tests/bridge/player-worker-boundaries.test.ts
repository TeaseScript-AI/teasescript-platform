import assert from "node:assert/strict";
import { before, type TestContext } from "node:test";
import { effectScope, watch, type Ref } from "vue";

import type { PlayerBridge, SessionRequestOptions } from "../../player/runtime/player-bridge.js";
import type { OpResult, SessionOp } from "../../player/engine-bridge/op-catalogue.js";
import type { PlayerRuntimeSessionOptions } from "../../player/runtime/runtime-adapter.js";
import {
  playerRuntimeForeground,
  playerRuntimePacingGate,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import {
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { DebugView, DebugViewRequest } from "../../player/debug/debug-view.js";
import type { SessionTransfer } from "../../player/persistence/session-transfer.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { DEMO_PLAYER_PROFILE } from "../../player/demo-player-profile.js";
import { playerProfileFromInput } from "../../src/runtime/host-data/player-profile.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { presentedAction, runtimeInput, type Intent } from "../helpers/player/player-input.js";
import { sourceStart, preparedSource, type PlanStart } from "../helpers/prepared-plan.js";
import { readForImport, type SessionRead } from "../helpers/player/transfer-read.js";
import {
  checkpointSnapshot,
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyBridge,
  until,
  type Posted,
  type Topology,
  type TopologyBridge,
  withinHostTime,
} from "../helpers/player/worker-topology.js";

/*
 * The composable's boundaries on the engine's Worker (#2321, the L5 activation's Worker rows): one representative case
 * per boundary that #2308's final review found with in-process rows only, each run on both topologies through the real
 * composable. A row asserts only what the public path shows (the shown session and its transcript, the requests that
 * reached the port, the stores), never the in-process facade, so it means the same on either topology. The in-process
 * families keep their full axes; these rows show that a real realm boundary (a structured clone, a reply a real turn
 * later, a stop acknowledged a round trip later) keeps each boundary's behaviour.
 */

/** A session import's review, which a row passes back to the import as it got it. */
interface ImportReview {
  readonly [field: string]: unknown;
}

interface Host {
  readonly bridge: Promise<PlayerBridge>;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly inputSection: unknown;
  prepare(create: PlanStart): void;
  prepareScript(plan: string, create: PlanStart): Promise<void>;
  activate(): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  temporalCapture(): PlayerRuntimeSessionOptions;
  pressPermanentButton(buttonId: number): Promise<void>;
  exportSession(): Promise<{ readonly transfer: SessionTransfer }>;
  readTransfer(input: {
    readonly bytes: Uint8Array<ArrayBuffer>;
  }): Promise<{ readonly kind: string }>;
  reviewSessionImport(transfer: SessionRead): Promise<ImportReview>;
  importSession(review: ImportReview): Promise<void>;
  debugRecording(): Promise<{
    readonly operations: readonly { readonly kind: string; readonly input?: string | null }[];
  } | null>;
  readonly images: {
    store(
      file: File,
      request: { readonly types: null; readonly mime: null },
    ): Promise<{ readonly reference: string } | { readonly message: string }>;
  };
  readonly imageCapture: { choose(reference: string): boolean; answer(input: "button"): Intent };
  readonly traceId: Readonly<Ref<number | null>>;
  setDebugTracing(on: boolean): void;
  setDebugMode(enabled: boolean): void;
  readonly rooms: { readonly current: Readonly<Ref<"normal" | "debug">> };
  editSavedData(edit: {
    readonly key: string;
    readonly value: SerializableRuntimeValue;
    readonly expected: SerializableRuntimeValue | undefined;
  }): Promise<{ readonly kind: string; readonly live?: boolean }>;
  debugView(request: DebugViewRequest): Promise<DebugView | null>;
  debugExportCandidate(
    details: () => Record<string, never>,
    wanted: AbortSignal,
  ): Promise<{
    readonly session: unknown;
    readonly recording: {
      readonly complete: boolean;
      readonly operations: readonly { readonly thrown: string | null }[];
    } | null;
  }>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill?: () => Promise<null>;
  readonly scriptStorage?: ScriptStorageProvider;
  readonly keptSessions?: KeptSessionStore;
  readonly capabilities?: { readonly camera: boolean };
  readonly debugRooms?: KeptRoomStore;
  readonly room?: "normal" | "debug";
  readonly decodeImage?: () => Promise<{ readonly width: number; readonly height: number }>;
}) => Host;

before(async () => {
  await loadTopology();
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** The browser surface a Player uses here, each call of audio, wake lock and camera noted in `calls` in order. */
function stubBrowser(context: TestContext) {
  const calls: string[] = [];
  const values = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    navigator: {
      wakeLock: {
        request: () => {
          calls.push("wakeLock");
          return new Promise(() => {});
        },
      },
      mediaDevices: Object.assign(new EventTarget(), {
        getUserMedia: () => {
          calls.push("getUserMedia");
          return new Promise(() => {});
        },
      }),
    },
    Audio: class extends EventTarget {
      src = "";
      play = () => {
        calls.push("play");
        return Promise.resolve();
      };
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
  return calls;
}

/** The real composable on `transport`'s bridge, in its own scope, stopped after the test or by `stop()`. */
async function mount(
  context: TestContext,
  transport: TopologyBridge,
  options: Omit<Parameters<typeof usePlayerSession>[0], "bridge"> = {},
) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      debugHistorySpill: async () => null,
      decodeImage: async () => ({ width: 1, height: 1 }),
      ...options,
      bridge: Promise.resolve(transport.bridge),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.bridge;
  if (options.scriptStorage !== undefined) await host.loadScriptStorage();
  return { host, stop: () => scope.stop() };
}

/** A Start of `script` compiled in `host`'s host, its clock at 0 and `extra` read at the click. */
async function start(
  host: Host,
  script: string,
  extra: () => PlayerRuntimeSessionOptions = () => ({}),
): Promise<PlayerSession> {
  host.prepare(await sourceStart(host.bridge, script, () => ({ ...extra(), wallClockMs: 0 })));
  await host.activate();
  assert.ok(host.session.value, "the Start shows its session");
  return host.session.value;
}

/** The options of the choice `host` shows. */
function choiceOptions(host: Host): readonly { readonly id: string; readonly label: string }[] {
  const foreground = playerRuntimeForeground(host.session.value!);
  assert.ok(foreground?.kind === "choose", "a choice is shown");
  return foreground.options;
}

/** A call of `PlayerBridge.request` with its overloads erased. */
type Call = readonly [PlayerSession, SessionOp, unknown, SessionRequestOptions?];

/** The label of the button `host` shows, if it shows one. */
function buttonLabel(host: Host): string | undefined {
  const foreground = host.session.value && playerRuntimeForeground(host.session.value);
  return foreground?.kind === "show-button" ? foreground.label : undefined;
}

/** Whether `host` shows a session that asks for an answer. */
const asks = (host: Host) =>
  host.session.value !== null && presentedAction(host.session.value) !== undefined;

/** The status of the session `host` shows now, read afresh. */
const status = (host: Host) => host.session.value?.state.status;

const said = (host: Host) => host.session.value?.transcriptEntries.map((entry) => entry.text) ?? [];

/** Answers the presented interaction with `intent` through the input chain, as a control does. */
async function answer(host: Host, intent: Intent) {
  const input = await runtimeInput();
  return input.runInput(
    host.inputSection,
    presentedAction(host.session.value!),
    presentedAction,
    intent,
  );
}

const RERUN = rerunRegistry({
  "W1 stop with a reply in transit": TOPOLOGIES,
  "W2 claim reused": TOPOLOGIES,
  "W3 click activation and Start options": TOPOLOGIES,
  "W4 input kinds": TOPOLOGIES,
  "W5 trace intents": TOPOLOGIES,
  "W6 paused draw": TOPOLOGIES,
  "W7 rewind": TOPOLOGIES,
  "W8 transfer": TOPOLOGIES,
  "W9 keep and Continue": TOPOLOGIES,
  "W10 catch-up": TOPOLOGIES,
  "W10b catch-up behind an answer": TOPOLOGIES,
  "W11 failure export": TOPOLOGIES,
  "W12 going back": TOPOLOGIES,
});

RERUN.rows(
  "W1 stop with a reply in transit",
  "W1: a replacement while an answer's reply is in transit shows nothing of the old session, and the next Start runs",
  async (context, topology, end) => {
    stubBrowser(context);
    const transport = await topologyBridge(context, topology);
    const { host } = await mount(context, transport);
    const replacement = await sourceStart(
      host.bridge,
      'say "replacement", instant\nshowButton "New"\nexit',
    );
    await start(
      host,
      'let pick = askChoice "A", "B"\nsay "picked ${pick}", instant\nshowButton "End"\nexit',
    );
    const input = await runtimeInput();
    const option = choiceOptions(host)[0]!;
    // The answer's observation is posted; its reply, and every later one, wait at the port while the replacement
    // begins, which clears the shown session. Released, the old answer's section resumes: only the checks that its
    // session is still the shown one (the section's `owned` and `publishOwned`) keep it from posting its op and showing.
    transport.hold("observeInput");
    const answering = answer(host, input.intents.choice(option.id, "button"));
    await transport.held();
    host.prepare(replacement);
    const replacing = host.activate();
    for (let index = 0; index < 5; index += 1) await turn();
    transport.release();
    await Promise.all([answering, replacing]);
    await until(() => said(host).includes("replacement"), "the replacement shows", "step");
    for (let index = 0; index < 10; index += 1) await turn();
    assert.deepEqual(said(host), ["replacement"], "nothing of the old session shows");
    // An input op is posted only while its session owns the UI (`inputSection`).
    const ops = transport.posts.map((post) => post.op);
    assert.equal(ops.indexOf("selectChoice"), -1, ops.join(", "));
    assert.equal(host.hostError.value, null);
    return end();
  },
);

RERUN.rows(
  "W2 claim reused",
  "W2: a bridge a disposed Player traced on is claimed by the next Player, which sends its own tracing setting before it starts",
  async (context, topology, end) => {
    stubBrowser(context);
    const transport = await topologyBridge(context, topology);
    const first = await mount(context, transport);
    first.host.setDebugTracing(true);
    await start(first.host, 'say "first", instant\nshowButton "End"\nexit');
    await until(() => first.host.traceId.value !== null, "the first Player's trace", "step");
    first.stop();
    for (let index = 0; index < 5; index += 1) await turn();
    const from = transport.posts.length;
    const second = await mount(context, transport);
    await start(second.host, 'say "second", instant\nshowButton "End"\nexit');
    assert.deepEqual(said(second.host), ["second"]);
    assert.equal(second.host.hostError.value, null);
    // The first Player's serials may still mark work in the bridge's queue: the second sends its own setting, off,
    // with a newer serial, ahead of its Start.
    const tracing = (post: Posted) => {
      const args = post.args;
      return post.op === "debugTracing" &&
        typeof args === "object" &&
        args !== null &&
        "on" in args &&
        "intent" in args &&
        typeof args.intent === "number"
        ? { on: args.on, intent: args.intent }
        : null;
    };
    const earlier = transport.posts.slice(0, from).flatMap((post) => tracing(post) ?? []);
    const later = transport.posts.slice(from);
    const ops = later.map((post) => post.op).join(", ");
    const sent = later.findIndex((post) => tracing(post) !== null);
    assert.ok(sent >= 0 && sent < later.findIndex((post) => post.op === "start"), ops);
    const intent = tracing(later[sent]!)!;
    assert.equal(intent.on, false);
    assert.ok(earlier.length > 0 && earlier.every((each) => each.intent < intent.intent), ops);
    assert.equal(second.host.traceId.value, null);
    return end();
  },
);

RERUN.rows(
  "W3 click activation and Start options",
  "W3: a Start, a Continue and a camera Start do their browser work within the click, and the Start's options reach the host as sampled",
  async (context, topology, end) => {
    const calls = stubBrowser(context);
    const at = keptBrowser();
    await at.provider.write("seen", "before");
    const extra = {
      wallClockMs: Date.UTC(2026, 10, 11, 9, 30),
      playerProfile: DEMO_PLAYER_PROFILE,
    };
    const first = await page(context, topology, at, KEPT, { extra });
    const within = () => calls.filter((call, index, all) => call !== all[index - 1]);
    first.transport.hold("start");
    const starting = first.host.activate();
    assert.deepEqual(within(), ["play", "wakeLock"], "the Start's audio unlock and wake lock");
    await first.transport.held();
    assert.equal(first.host.session.value, null, "the host has not replied yet");
    first.transport.release();
    await starting;
    await until(() => asks(first.host), "the first question is asked", "host");
    // The options as the host holds them: its checkpoint of the started session.
    const sampled = first.sampled();
    assert.ok(sampled?.temporalContext, "the click sampled a temporal context");
    const snapshot = await checkpointSnapshot(first.transport.bridge, first.host.session.value!);
    assert.equal(snapshot.temporalCaptures[0]?.epochMs, extra.wallClockMs);
    assert.deepEqual(snapshot.temporalCaptures[0]?.context, sampled.temporalContext);
    assert.deepEqual(snapshot.playerProfile, playerProfileFromInput(DEMO_PLAYER_PROFILE));
    assert.deepEqual(snapshot.scriptStorage.map(({ key, value }) => [key, value]).sort(), [
      ["seen", "before"],
      ["visits", 1],
    ]);
    const input = await runtimeInput();
    assert.equal(
      (await answer(first.host, input.intents.composer("one", "enter"))).kind,
      "answered",
    );
    await keptWith(at, "Got one.");
    first.stop();
    // A Continue on the next page: the same browser work, within its click.
    const second = await page(context, topology, at);
    await until(
      () => second.host.activation.value === "continue",
      "the next page offers Continue",
      "step",
    );
    calls.length = 0;
    const continuing = second.host.activate();
    assert.deepEqual(within(), ["play", "wakeLock"], "the Continue's audio unlock and wake lock");
    assert.equal(second.host.session.value, null, "the host has not replied yet");
    await continuing;
    assert.ok(said(second.host).includes("Got one."), said(second.host).join(" | "));
    second.stop();
    // A Start with the camera asks for it within the click; the stub's camera never answers.
    const transport = await topologyBridge(context, topology);
    const camera = await mount(context, transport, { capabilities: { camera: true } });
    camera.host.prepare(await sourceStart(camera.host.bridge, 'say "Look.", instant\nexit'));
    calls.length = 0;
    void camera.host.activate();
    assert.deepEqual(
      [...new Set(calls)].sort(),
      ["getUserMedia", "play", "wakeLock"],
      calls.join(", "),
    );
    camera.stop();
    return end();
  },
);

const CONTROLS = [
  'let name = askText "Name?"',
  'say "hi ${name}", instant',
  'let pick = askChoice "A", "B"',
  'say "picked ${pick}", instant',
  'let answers = askForm fields: { first: { type: "text", text: "First" } }',
  'say "first ${answers.first}", instant',
  'let image = askImage("Your image")',
  'let skipped = askImage("Skip", allowSkip: true)',
  'showPermanentButton "Tick" {\n    say "tick", instant\n}',
  'say "paced"',
  'say "end", instant',
  'showButton "End"',
  "exit",
].join("\n");

RERUN.rows(
  "W4 input kinds",
  "W4: each kind of input crosses as the control gave it, and an answer to an action no longer presented changes nothing",
  async (context, topology, end) => {
    stubBrowser(context);
    const transport = await topologyBridge(context, topology);
    const { host } = await mount(context, transport);
    const input = await runtimeInput();
    await start(host, CONTROLS);
    const presented = presentedAction(host.session.value!);
    assert.equal((await answer(host, input.intents.composer("Ann", "enter"))).kind, "answered");
    // The composer's action ended: an answer to it is refused by its action ID, without effect.
    const stale = await input.runInput(
      host.inputSection,
      presented,
      presentedAction,
      input.intents.composer("Bo", "enter"),
    );
    assert.notEqual(stale.kind, "answered");
    const options = choiceOptions(host);
    assert.equal(
      (await answer(host, input.intents.choice(options[1]!.id, "button"))).kind,
      "answered",
    );
    assert.equal((await answer(host, input.intents.formStep("first", undefined))).kind, "answered");
    const drafted = await input.draftInput(
      host.inputSection,
      { actionId: presentedAction(host.session.value!)!, fieldId: "first" },
      "Cy",
    );
    assert.ok(drafted, "the draft crossed");
    assert.equal((await answer(host, input.intents.formSubmit("Cy", "button"))).kind, "answered");
    // A chosen file: the image's bytes stay in the page, its reference crosses.
    const stored = await host.images.store(new File([PNG], "a.png"), { types: null, mime: null });
    assert.ok("reference" in stored);
    assert.equal(host.imageCapture.choose(stored.reference), true);
    const image = await answer(host, host.imageCapture.answer("button"));
    assert.equal(image.outcome?.kind, "completed");
    assert.equal((await answer(host, input.intents.imageSkip("button"))).kind, "answered");
    await until(
      () => playerRuntimePacingGate(host.session.value!) != null,
      "the paced message holds the session",
      "step",
    );
    const skipped = await input.runInput(
      host.inputSection,
      playerRuntimePacingGate(host.session.value!)?.actionId,
      (session) => playerRuntimePacingGate(session)?.actionId,
      input.intents.pacing,
    );
    assert.equal(skipped.kind, "answered", "the pacing skip");
    await host.pressPermanentButton(1);
    await until(() => said(host).includes("tick"), "the permanent button's block ran", "step");
    await until(() => said(host).includes("end"), "the script reached its end", "step");
    for (const text of ["hi Ann", "picked B", "first Cy"])
      assert.ok(said(host).includes(text), said(host).join(" | "));
    assert.equal(
      said(host).filter((text) => text === "hi Ann").length,
      1,
      "one answer, applied once",
    );
    const recording = await host.debugRecording();
    assert.deepEqual(
      recording?.operations.flatMap((operation) =>
        operation.input == null ? [] : [operation.input],
      ),
      ["enter", "button", "button", "button", "button"],
      "the recording keeps how each answer was given",
    );
    assert.equal(host.hostError.value, null);
    return end();
  },
);

/** A browser's kept sessions and script storage, shared by the pages a row opens in it. */
function keptBrowser() {
  const entries = new Map<string, SerializableRuntimeValue>();
  const provider: ScriptStorageProvider = {
    scope: "development-package:worker-rows",
    load: async () => [...entries].map(([key, value]) => ({ key, value })),
    write: async (key, value) => {
      if (value === null) entries.delete(key);
      else entries.set(key, value);
    },
    replace: async (next) => {
      entries.clear();
      for (const { key, value } of next) entries.set(key, value);
    },
    clear: async () => entries.clear(),
  };
  return { provider, kept: memoryKeptSessionStore(), entries };
}

const KEPT = [
  'save 1 as "visits"',
  'let a = askText(hint: "One")',
  'say "Got ${a}.", instant',
  'let b = askText(hint: "Two")',
  'say "Then ${b}.", instant',
  "exit",
].join("\n");

/** A page of `at` on `topology` that prepares `script`'s Start, or Continue for the session `at` keeps. */
async function page(
  context: TestContext,
  topology: Topology,
  at: ReturnType<typeof keptBrowser>,
  script = KEPT,
  {
    extra = {},
    rooms,
  }: { readonly extra?: PlayerRuntimeSessionOptions; readonly rooms?: KeptRoomStore } = {},
) {
  const transport = await topologyBridge(context, topology);
  const opened = await mount(context, transport, {
    scriptStorage: at.provider,
    keptSessions: at.kept,
    ...(rooms === undefined ? {} : { debugRooms: rooms }),
  });
  const token = await preparedSource(opened.host.bridge, script);
  // What the Start's click sampled last.
  let sampled: PlayerRuntimeSessionOptions | null = null;
  await opened.host.prepareScript(token, {
    plan: token,
    options: () =>
      (sampled = {
        ...opened.host.scriptStorageOptions(),
        ...opened.host.temporalCapture(),
        ...extra,
      }),
  });
  return { ...opened, transport, sampled: () => sampled };
}

/**
 * Waits until `at`'s normal room, or `store`, keeps a session whose events hold `text`: a keep that follows the host's
 * reply, for as long as a wait on the host may take.
 */
async function keptWith(
  at: ReturnType<typeof keptBrowser>,
  text: string,
  store: Pick<KeptSessionStore, "session"> = at.kept,
) {
  for (const within = withinHostTime(); within();) {
    const stored = await store.session(at.provider.scope);
    if (stored !== null && JSON.stringify(stored.events).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`never kept: ${text}`);
}

/** Imports `transfer` on `host`'s page and continues it, as the player's Continue after an import does. */
async function importAndContinue(host: Host, transfer: SessionTransfer) {
  const review = await host.reviewSessionImport(await readForImport(host, transfer));
  await host.importSession(review);
  await until(() => host.activation.value === "continue", "the import offers Continue", "step");
  await host.activate();
  await until(() => said(host).length > 0, "the import shows its session", "step");
}

/** Plays `KEPT` on `host` to its second question and lets its keep commit. */
async function playToSecondQuestion(host: Host) {
  const input = await runtimeInput();
  await host.activate();
  await until(() => asks(host), "the first question is asked", "host");
  assert.equal((await answer(host, input.intents.composer("one", "enter"))).kind, "answered");
  await until(() => said(host).includes("Got one."), "the first answer shows", "step");
  await until(() => asks(host), "the second question is asked", "step");
}

RERUN.rows(
  "W9 keep and Continue",
  "W9: a session kept on a page continues on the next page at the kept point, takes a Debug edit while it waits, and goes on in the debug room",
  async (context, topology, end) => {
    stubBrowser(context);
    const at = keptBrowser();
    const first = await page(context, topology, at);
    assert.equal(first.host.activation.value, "start");
    await playToSecondQuestion(first.host);
    await keptWith(at, "Got one.");
    const shown = said(first.host);
    first.stop();
    const rooms = memoryKeptRoomStore();
    const second = await page(context, topology, at, KEPT, { rooms });
    await until(
      () => second.host.activation.value === "continue",
      "the next page offers Continue",
      "step",
    );
    await second.host.activate();
    assert.deepEqual(said(second.host), shown, "the transcript up to the kept point");
    assert.equal(at.entries.get("visits"), 1);
    // A Debug edit while the session waits at its question is stored and reaches the host's session.
    const edit = await second.host.editSavedData({ key: "visits", value: 5, expected: 1 });
    assert.deepEqual([edit.kind, edit.live], ["saved", true]);
    assert.equal(at.entries.get("visits"), 5);
    const edited = await checkpointSnapshot(second.transport.bridge, second.host.session.value!);
    assert.equal(edited.scriptStorage.find((entry) => entry.key === "visits")?.value, 5);
    // Debug on carries the session into the debug room, where it goes on; the normal room keeps it where it was.
    second.host.setDebugMode(true);
    await until(() => second.host.rooms.current.value === "debug", "the debug room", "host");
    assert.deepEqual(said(second.host), shown, "the debug room's copy of the session");
    const copied = await checkpointSnapshot(second.transport.bridge, second.host.session.value!);
    assert.equal(copied.debugMode, true);
    const input = await runtimeInput();
    assert.equal(
      (await answer(second.host, input.intents.composer("two", "enter"))).kind,
      "answered",
    );
    await until(
      () => said(second.host).includes("Then two."),
      "the copy runs on in the debug room",
      "step",
    );
    // Its keep commits in the debug room; only then does the normal room's session show it stayed.
    await keptWith(at, "Then two.", rooms);
    const normal = await at.kept.session(at.provider.scope);
    assert.ok(normal !== null && JSON.stringify(normal.events).includes("Got one."));
    assert.ok(
      !JSON.stringify(normal.events).includes("Then two."),
      "the normal room's session stays",
    );
    return end();
  },
);

RERUN.rows(
  "W12 going back",
  "W12: a session kept and a session exported on one topology continue and import, with its saved values, on the other",
  async (context, topology, end) => {
    stubBrowser(context);
    const other: Topology = topology === "worker" ? "in-process" : "worker";
    // Kept on `topology`, continued on the other.
    const at = keptBrowser();
    const first = await page(context, topology, at);
    await playToSecondQuestion(first.host);
    await keptWith(at, "Got one.");
    const shown = said(first.host);
    const { transfer } = await first.host.exportSession();
    first.stop();
    const second = await page(context, other, at);
    await until(
      () => second.host.activation.value === "continue",
      "the other topology offers Continue",
      "step",
    );
    await second.host.activate();
    assert.deepEqual(said(second.host), shown, "Continue on the other topology");
    second.stop();
    // Exported on `topology`, imported on the other, in a fresh browser.
    const elsewhere = keptBrowser();
    const third = await page(context, other, elsewhere);
    await importAndContinue(third.host, transfer);
    // What the importing side received: the script's saved values, and the session.
    assert.equal(
      elsewhere.entries.get("visits"),
      1,
      "the import's saved values on the other topology",
    );
    assert.deepEqual(said(third.host), shown, "the import on the other topology");
    return end();
  },
);

const TRACED = [
  'let mood = "calm"',
  'let answer = askText "Ready?"',
  'say "${mood} ${answer}"',
  "exit",
].join("\n");
const VARIABLES = {
  messages: null,
  selected: null,
  variables: { filter: "mood", pages: {} },
  image: false,
  trees: {},
} as const;

RERUN.rows(
  "W5 trace intents",
  "W5: the value trace follows the newest intent, and a view never shows a dropped trace's variables",
  async (context, topology, end) => {
    stubBrowser(context);
    const transport = await topologyBridge(context, topology);
    const { host } = await mount(context, transport);
    host.setDebugTracing(true);
    await start(host, TRACED);
    await until(() => host.traceId.value !== null, "the Start's trace", "step");
    const first = host.traceId.value;
    const view = await host.debugView(VARIABLES);
    assert.equal(view?.traceId, first);
    assert.ok(
      view?.variables?.some((group) =>
        group.variables.some((variable) => variable.name === "mood"),
      ),
      "the trace's variable crossed",
    );
    // Off, on, off and on again while the first intent's reply is held: once the replies arrive, in order, only the
    // newest intent's reply names the trace; the older ones name nothing, not even for a moment.
    transport.hold("debugTracing");
    host.setDebugTracing(false);
    host.setDebugTracing(true);
    host.setDebugTracing(false);
    host.setDebugTracing(true);
    await transport.held();
    const named: (number | null)[] = [];
    context.after(watch(host.traceId, (id) => void named.push(id), { flush: "sync" }));
    transport.release();
    await until(
      () => host.traceId.value !== null && host.traceId.value !== first,
      "a new trace",
      "host",
    );
    assert.deepEqual(named, [host.traceId.value], "only the newest intent's reply named a trace");
    const again = await host.debugView(VARIABLES);
    assert.equal(again?.traceId, host.traceId.value, "the view is of the newest trace");
    assert.notEqual(again?.traceId, first);
    return end();
  },
);

interface RandomDebug {
  readonly enabled: Ref<boolean>;
  readonly draw: Readonly<Ref<{ readonly site: string; readonly drawId: number } | null>>;
  tried(site: string): { readonly history: readonly string[] };
  resolve(
    outcome: { readonly kind: "number"; readonly value: number } | "natural",
  ): Promise<boolean>;
}
interface RewindDebug {
  readonly state: Readonly<
    Ref<{ readonly points: readonly { readonly id: number }[]; readonly inspection: unknown }>
  >;
  back(point: number): Promise<boolean>;
  forward(): Promise<boolean>;
  resume(): Promise<boolean>;
  returnToSession(): Promise<boolean>;
}
let useDebugRandom: (player: Host) => RandomDebug;
let useDebugRewind: (player: Host) => RewindDebug;

before(async () => {
  const random = await loadPlayerModule("player/vue/src/debug/random/useDebugRandom.ts");
  const rewind = await loadPlayerModule("player/vue/src/debug/history/useDebugRewind.ts");
  assert.equal(typeof random.useDebugRandom, "function");
  assert.equal(typeof rewind.useDebugRewind, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and each export is callable; these are Debug's features.
  useDebugRandom = random.useDebugRandom as typeof useDebugRandom;
  // EVIDENCE: validation: as above.
  useDebugRewind = rewind.useDebugRewind as typeof useDebugRewind;
});

/** A debug room's Player on `transport` with Debug's random draws and rewind, `script` prepared. */
async function mountDebug(context: TestContext, transport: TopologyBridge, script: string) {
  const at = keptBrowser();
  const scope = effectScope();
  const mounted = scope.run(() => {
    const host = usePlayerSession({
      bridge: Promise.resolve(transport.bridge),
      debugHistorySpill: async () => null,
      scriptStorage: at.provider,
      keptSessions: at.kept,
      debugRooms: memoryKeptRoomStore(),
      room: "debug",
    });
    return { host, random: useDebugRandom(host), rewind: useDebugRewind(host) };
  });
  assert.ok(mounted);
  context.after(() => scope.stop());
  await mounted.host.loadScriptStorage();
  const token = await preparedSource(mounted.host.bridge, script);
  await mounted.host.prepareScript(token, {
    plan: token,
    options: () => mounted.host.scriptStorageOptions(),
  });
  return mounted;
}

const DRAWS =
  'let initial = askText "Begin"\nfor turn in 1..=3 {\n  let roll = randomInteger(1..=6)\n  say "Roll: ${roll}", instant\n}\nshowButton "End"\nexit';

/** The rolls `host` shows. */
const rolls = (host: Host) => said(host).filter((text) => text.startsWith("Roll: "));

RERUN.rows(
  "W6 paused draw",
  "W6: with Choose outcomes on, a session pauses at its draws and goes on with the outcomes the picker chose; a read of a draw that no longer shows is ignored",
  async (context, topology, end) => {
    stubBrowser(context);
    const transport = await topologyBridge(context, topology);
    const { host, random, rewind } = await mountDebug(context, transport, DRAWS);
    random.enabled.value = true;
    await host.activate();
    const input = await runtimeInput();
    assert.equal((await answer(host, input.intents.composer("begin", "enter"))).kind, "answered");
    await until(() => random.draw.value !== null, "the session pauses at its first draw", "step");
    assert.deepEqual(rolls(host), [], "nothing after the draw runs while it waits");
    const first = random.draw.value!;
    // The first draw's own read of what its site took has its reply before the next request does.
    await transport.bridge.read(host.session.value!, "randomTried", { site: first.site });
    // The second draw's read is held, and Back to the first input point is posted behind it; both replies arrive
    // together, so the read's answer comes once the draw it was for no longer shows.
    transport.hold("randomTried");
    assert.equal(await random.resolve({ kind: "number", value: 6 }), true);
    await until(
      () => random.draw.value !== null && random.draw.value.drawId !== first.drawId,
      "the second draw",
      "step",
    );
    assert.deepEqual(rolls(host), ["Roll: 6"], "the chosen outcome, once");
    await transport.held();
    const site = random.draw.value!.site;
    const point = rewind.state.value.points[0];
    assert.ok(point, "the answer is a point");
    const back = rewind.back(point.id);
    await transport.held("rewindBack");
    transport.release();
    assert.equal(await back, true, "Back");
    for (let index = 0; index < 5; index += 1) await turn();
    assert.equal(random.draw.value, null, "the inspected point shows no draw");
    assert.deepEqual(
      random.tried(site).history,
      [],
      "the read of the draw that no longer shows is ignored",
    );
    assert.deepEqual(rolls(host), []);
    // Resumed from the first point, the session draws again, each draw with the outcome chosen for it.
    assert.equal(await rewind.resume(), true, "Resume");
    assert.equal((await answer(host, input.intents.composer("again", "enter"))).kind, "answered");
    for (const value of [5, 4, 3]) {
      await until(() => random.draw.value !== null, `the draw for ${value}`, "step");
      assert.equal(await random.resolve({ kind: "number", value }), true);
      await until(() => rolls(host).includes(`Roll: ${value}`), `Roll: ${value}`, "step");
    }
    assert.deepEqual(rolls(host), ["Roll: 5", "Roll: 4", "Roll: 3"]);
    assert.equal(host.hostError.value, null);
    return end();
  },
);

const CHOICES = [
  'let a = askChoice "A1", "A2"',
  'say "first ${a}", instant',
  'let b = askChoice "B1", "B2"',
  'say "second ${b}", instant',
  'let c = askChoice "C1", "C2"',
  "exit",
].join("\n");

/** Chooses `label` in the shown choice through the input chain, which adopts an inspected state first. */
async function choose(host: Host, label: string) {
  const input = await runtimeInput();
  const options = choiceOptions(host);
  const option = options.find((each) => each.label === label);
  assert.ok(option, label);
  assert.equal((await answer(host, input.intents.choice(option.id, "button"))).kind, "answered");
}

RERUN.rows(
  "W7 rewind",
  "W7: Back, Forward, Return and Resume restore through the host, and the resumed session goes on from the earlier point",
  async (context, topology, end) => {
    stubBrowser(context);
    const transport = await topologyBridge(context, topology);
    const { host, rewind } = await mountDebug(context, transport, CHOICES);
    await host.activate();
    await choose(host, "A1");
    await choose(host, "B1");
    await until(() => said(host).includes("second B1"), "two answers", "step");
    const tip = said(host);
    const first = rewind.state.value.points[0];
    assert.ok(first, "the first interaction is a point");
    assert.equal(await rewind.back(first.id), true, "Back");
    assert.deepEqual(said(host), [], "the first point's state");
    assert.equal(await rewind.forward(), true, "Forward");
    const forward = said(host);
    assert.ok(forward.length > 0 && forward.length <= tip.length, forward.join(" | "));
    assert.deepEqual(forward, tip.slice(0, forward.length), "a later state of the same session");
    assert.equal(await rewind.returnToSession(), true, "Return");
    assert.deepEqual(said(host), tip);
    assert.equal(await rewind.back(first.id), true, "Back again");
    assert.equal(await rewind.resume(), true, "Resume");
    await choose(host, "A2");
    await until(() => said(host).includes("first A2"), "the resumed session goes on", "step");
    assert.ok(!said(host).includes("second B1"), said(host).join(" | "));
    assert.equal(host.hostError.value, null);
    return end();
  },
);

RERUN.rows(
  "W8 transfer",
  "W8: a session exported and imported goes on, its storage writes after the import's",
  async (context, topology, end) => {
    stubBrowser(context);
    const at = keptBrowser();
    const first = await page(
      context,
      topology,
      at,
      `${KEPT}\n`.replace("exit", 'save b as "second"\nexit'),
    );
    await playToSecondQuestion(first.host);
    const shown = said(first.host);
    const { transfer } = await first.host.exportSession();
    const elsewhere = keptBrowser();
    const writes: string[] = [];
    const write = elsewhere.provider.write;
    elsewhere.provider.write = async (key, value) => {
      writes.push(key);
      return write(key, value);
    };
    const second = await page(
      context,
      topology,
      elsewhere,
      `${KEPT}\n`.replace("exit", 'save b as "second"\nexit'),
    );
    await importAndContinue(second.host, transfer);
    assert.deepEqual(said(second.host), shown);
    const input = await runtimeInput();
    assert.equal(
      (await answer(second.host, input.intents.composer("two", "enter"))).kind,
      "answered",
    );
    await until(
      () => elsewhere.entries.get("second") === "two",
      "the imported session's save",
      "step",
    );
    assert.equal(writes.at(-1), "second", writes.join(", "));
    assert.equal(elsewhere.entries.get("visits"), 1, "the export's saved values came with it");
    return end();
  },
);

const ROUNDS =
  'let rounds = 0\ntimer(duration: 10 ms, async: true, repeat: true, display: "hidden") {\n  rounds += 1\n}\nshowButton "Done"\nsay "${rounds} rounds", instant\nexit';

RERUN.rows(
  "W10 catch-up",
  "W10: a page hidden while time passes catches up in steps, once shown, to the scene time one late observation gives",
  async (context, topology, end) => {
    stubBrowser(context);
    let nowMs = 0;
    context.mock.method(performance, "now", () => (nowMs += 1));
    const transport = await topologyBridge(context, topology);
    const { host } = await mount(context, transport);
    await start(host, ROUNDS);
    // Hidden, then a second passes, then shown: the page's visibility, as the browser reports it.
    const show = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    show("hidden");
    await turn();
    nowMs += 1_000;
    const shownAt = transport.posts.length;
    show("visible");
    await until(
      () => host.session.value!.state.observedSessionTimeMs >= 1_000,
      "the catch-up ends",
      "host",
    );
    const input = await runtimeInput();
    assert.equal((await answer(host, input.intents.choice(null, "button"))).kind, "answered");
    await until(
      () => said(host).some((text) => text.endsWith(" rounds")),
      "the button's answer",
      "step",
    );
    const observed = host.session.value!.state.observedSessionTimeMs;
    assert.ok(observed >= 1_000);
    assert.deepEqual(said(host), ["Done", `${Math.floor(observed / 10)} rounds`]);
    // Once shown, the late observation ran as a catch-up over the bridge: begun, stepped in tasks with a budget, and
    // adopted.
    const ops = transport.posts.map((post) => post.op);
    const begun = ops.indexOf("beginCatchUp", shownAt);
    assert.ok(begun >= shownAt, ops.join(", "));
    const steps = transport.posts.filter(
      (post, index) => index > begun && post.op === "stepCatchUp",
    );
    const budgets = steps.map((post) =>
      typeof post.args === "object" && post.args !== null && "budgetMs" in post.args
        ? post.args.budgetMs
        : undefined,
    );
    assert.ok(
      budgets.length > 0 && budgets.every((budget) => typeof budget === "number"),
      String(budgets),
    );
    assert.ok(ops.indexOf("adoptCatchUp", begun) > begun, ops.join(", "));
    return end();
  },
);

RERUN.rows(
  "W10b catch-up behind an answer",
  "a late catch-up queued behind a button answer is refused for the revision it was sampled from; the clock observes afresh, the answer stands, and nothing is reported",
  async (context, topology, end) => {
    stubBrowser(context);
    let nowMs = 0;
    context.mock.method(performance, "now", () => (nowMs += 1));
    const transport = await topologyBridge(context, topology);
    const { host } = await mount(context, transport);
    const refusals: unknown[] = [];
    let catchUps = 0;
    // EVIDENCE: test: the bridge's erased overload; the row forwards each call unchanged, reading its op and refusal.
    const request = transport.bridge.request.bind(transport.bridge) as (
      ...call: Call
    ) => Promise<OpResult<SessionOp>>;
    context.mock.method(transport.bridge, "request", async (...call: Call) => {
      if (call[1] === "beginCatchUp") catchUps += 1;
      try {
        return await request(...call);
      } catch (error) {
        if (call[1] === "beginCatchUp")
          refusals.push(error instanceof Error && "code" in error ? error.code : error);
        throw error;
      }
    });
    // The timer's first deadline is a scene second away: the clock's own wake-up for it (a real timer, armed from the
    // mocked scene time) is then about a second of real time away, a wide margin for the setup and the held reply. Were
    // it still to run before the page is shown again, it would take the catch-up's place with an observation of its own,
    // and the assertion after the dispatch fails at once (#2494).
    await start(
      host,
      'let n = 0\ntimer(duration: 1000 ms, async: true, repeat: true, display: "hidden") {\n  n += 1\n}\nshowButton "Next"\nshowButton "After"\nexit',
    );
    const input = await runtimeInput();
    // The answer's section holds the session's queue while its observation's reply waits at the port. Five seconds later
    // the page is shown again: the late observation's catch-up, sampled from the revision before the answer, queues behind
    // it.
    transport.hold("observeInput");
    const answering = answer(host, input.intents.choice(null, "button"));
    await transport.held();
    const heldAt = transport.posts.length;
    nowMs += 5_000;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(catchUps, 1, "the page asks for the catch-up as it is shown again");
    for (let index = 0; index < 5; index += 1) await turn();
    const queued = transport.posts.slice(heldAt).map((post) => post.op);
    assert.equal(queued.indexOf("beginCatchUp"), -1, queued.join(", "));
    transport.release();
    assert.equal((await answering).kind, "answered");
    await until(() => refusals.length > 0, "the catch-up's refusal", "host");
    assert.deepEqual(refusals, ["basis"]);
    await until(() => buttonLabel(host) === "After", "the answer's next button", "step");
    await until(
      () => host.session.value!.state.observedSessionTimeMs >= 5_000,
      "the fresh observation",
      "host",
    );
    // Refused, the catch-up adopted nothing (a step already queued finds no copy); the clock observed the late seconds in
    // one go instead. Read once that observation is in, so a later adoption is in the log.
    const ops = transport.posts.slice(heldAt).map((post) => post.op);
    const begun = ops.indexOf("beginCatchUp");
    assert.ok(begun >= 0, ops.join(", "));
    assert.equal(ops.indexOf("adoptCatchUp", begun), -1, ops.join(", "));
    assert.ok(ops.indexOf("observeTime", begun) > begun, ops.join(", "));
    assert.equal(host.hostError.value, null);
    assert.equal(buttonLabel(host), "After", "the next button still asks");
    return end();
  },
);

RERUN.rows(
  "W11 failure export",
  "W11: a script error stops the session, and its debug export candidate holds the complete recording to the error",
  async (context, topology, end) => {
    stubBrowser(context);
    const transport = await topologyBridge(context, topology);
    const { host } = await mount(context, transport);
    await start(
      host,
      'say "Counting", instant\nlet zero = dynamic(0)\nlet result = 1 / zero\nexit\nfunction dynamic(value) {\n    return value\n}',
    );
    await until(() => host.session.value?.state.status === "failed", "the script error", "step");
    const candidate = await host.debugExportCandidate(() => ({}), new AbortController().signal);
    assert.equal(candidate.recording?.complete, true);
    assert.ok((candidate.recording?.operations.length ?? 0) > 0, "the recording up to the error");
    assert.ok(candidate.session, "the session's state at the error");
    assert.equal(status(host), "failed");
    return end();
  },
);
