import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import test, { after, before, type TestContext } from "node:test";
import { effectScope, watch, type EffectScope, type Ref } from "vue";

import {
  keptSession,
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
  type KeptSessionUpdate,
} from "../player/kept-sessions.js";
import {
  playerRuntimeSnapshot as rawPlayerRuntimeSnapshot,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import { compilePlayerProject } from "../player/compile-project.js";
import { StaleOperation, persistenceOwnership } from "../player/persistence-ownership.js";
import { preparedPlan } from "./helpers/prepared-plan.js";
import { answerWith, type Intent } from "./helpers/player-input.js";
import {
  MOVES,
  POSTED,
  PRODUCERS,
  SUSPENSIONS,
  UNHELD_AWAITS,
  caseName,
  stale,
  type Move,
  familyCases,
  type FamilyCase,
  type Producer,
} from "./helpers/plan-json-family.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { InstructionPlan } from "../src/index.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";
import { loadPlayerModule } from "./helpers/player-modules.js";
import { loadHostFacade, onHost } from "./helpers/host-sessions.js";

// The adapter's functions, also on the sessions the composables' host holds (`helpers/host-sessions.ts`).
const playerRuntimeSnapshot = onHost(rawPlayerRuntimeSnapshot);

// What Start leaves out of its own frame (#1707): the plan's JSON for a new session's first save is written in a task
// before Start, and the zone the browser names is captured early. Start and Continue still record the zone and clock
// as they are at the click, and the stored bytes and saves stay as they were.

interface KeepHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepareScript(
    plan: string,
    create: { readonly plan: string; readonly options: () => PlayerRuntimeSessionOptions },
  ): Promise<void>;
  activate(): Promise<void>;
  toStartPage(): Promise<void>;
  temporalCapture(): PlayerRuntimeSessionOptions;
  readonly bridge: Promise<PlayerBridge>;
  exportSession(): Promise<{ readonly transfer: ExportedSession }>;
  setDebugMode(enabled: boolean): void;
  readonly rooms: { readonly current: Readonly<Ref<"normal" | "debug">> };
  reviewSessionImport(transfer: ExportedSession): Promise<ImportReview>;
  importSession(review: ImportReview): Promise<void>;
  readonly savedDataRevision: Readonly<Ref<number>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string }[]>>;
  readonly canImportSavedData: Readonly<Ref<boolean>>;
  readonly images: {
    store(
      file: File,
      filters: { types: readonly string[] | null; mime: readonly string[] | null },
    ): Promise<{ readonly reference: string } | { readonly message: string }>;
  };
  readonly imageCapture: { choose(reference: string): boolean; answer(input: "button"): Intent };
  readonly inputSection: unknown;
}
/** An exported session, as this file passes it from an export to an import's review. */
interface ExportedSession {
  readonly scope: string;
}
/** An import's review, as this file passes it to the import. */
interface ImportReview {
  readonly snapshotJson: string;
}
let usePlayerSession: (options: {
  bridge?: Promise<PlayerBridge>;
  scriptStorage: ScriptStorageProvider;
  capturedMedia: { repository: FakeMediaRepository };
  keptSessions: KeptSessionStore;
  debugRooms?: KeptRoomStore;
  decodeImage: (data: Blob) => Promise<{ width: number; height: number }>;
}) => KeepHost;

// Every page captures the zone `TZ` names into one module cache, so the file starts from a known zone, which no test
// below treats as one not seen before.
const inheritedZone = process.env["TZ"];
process.env["TZ"] = "UTC";
after(() => {
  if (inheritedZone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = inheritedZone;
});

before(async () => {
  await loadHostFacade();
  const facade: Record<string, unknown> = await loadPlayerModule(
    "player/engine-bridge/in-process.ts",
  );
  assert.equal(typeof facade.heldPlan, "function");
  // EVIDENCE: validation: the bundle facade's `heldPlan`, checked as a function above.
  heldPlan = facade.heldPlan as typeof heldPlan;
  assert.equal(typeof facade.createInProcessBackend, "function");
  // EVIDENCE: validation: the bundle's backend factory, checked as a function above.
  createInProcessBackend = facade.createInProcessBackend as typeof createInProcessBackend;
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
});

/** The browser surface the Player host touches without a camera; `hide()` hides the page, which keeps the session. */
function stubBrowser(context: TestContext) {
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const values = {
    document,
    window: new EventTarget(),
    navigator: {},
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
  return {
    hide() {
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      document.visibilityState = "visible";
    },
  };
}

const SCOPE = "development-package:keep";

/** One browser's kept sessions, recording every publication of a session, of which the first `failing` are refused. */
function browser() {
  const provider: ScriptStorageProvider = {
    scope: SCOPE,
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const inner = memoryKeptSessionStore();
  const published: KeptSessionUpdate[] = [];
  const state = { failing: 0 };
  const kept: KeptSessionStore = {
    ...inner,
    async publish(scope, update) {
      published.push(update);
      if (state.failing > 0) {
        state.failing -= 1;
        throw new DOMException("The storage is full.", "QuotaExceededError");
      }
      return inner.publish(scope, update);
    },
  };
  return { provider, repository: new FakeMediaRepository(), kept, published, state };
}

/**
 * Counts how often each of `plans` is written as JSON (the engine's writer gives a plan to `JSON.stringify`): the
 * result gives the count of a plan, by default the first.
 */
function planWrites(context: TestContext, ...plans: InstructionPlan[]) {
  const stringify = JSON.stringify;
  const counts = new Map<unknown, number>();
  JSON.stringify = new Proxy(stringify, {
    apply(target, _self, args) {
      const value: unknown = args[0];
      if (
        failNextSnapshot &&
        typeof value === "object" &&
        value !== null &&
        "format" in value &&
        value.format === "teasescript-runtime-snapshot"
      ) {
        failNextSnapshot = false;
        throw new RangeError("Invalid string length");
      }
      // The host holds its own plan, prepared from this plan's text: its writes count as this plan's.
      const plan = heldAs.get(args[0]) ?? args[0];
      if (failPlanWrite !== null && plan === failPlanWrite && heldAs.has(args[0])) {
        failPlanWrite = null;
        throw new RangeError("Invalid string length");
      }
      if (heldAs.has(args[0])) graphWrites.set(args[0], (graphWrites.get(args[0]) ?? 0) + 1);
      if (plans.includes(plan)) counts.set(plan, (counts.get(plan) ?? 0) + 1);
      return target(args[0], args[1], args[2]);
    },
  });
  context.after(() => (JSON.stringify = stringify));
  return (plan: InstructionPlan | undefined = plans[0]) => counts.get(plan) ?? 0;
}

/** The plans the hosts hold, each as the test's plan it was prepared from (`planWrites`). */
const heldAs = new Map<unknown, InstructionPlan>();
/** Whether `planWrites`'s writer fails the next snapshot, as a state too long to save does (`TSK004`). */
let failNextSnapshot = false;
/** The plan whose next write in a host `planWrites`'s writer fails, as one too large for the browser does. */
let failPlanWrite: InstructionPlan | null = null;
/** How often each host's own plan was written while `planWrites` counted. */
const graphWrites = new Map<unknown, number>();
/** How often `host`'s host wrote its plan of `plan` while `planWrites` counted. */
async function writesOn(host: KeepHost, plan: InstructionPlan): Promise<number> {
  return graphWrites.get(heldPlan(await host.bridge, await held(host, plan))) ?? 0;
}
/** Each page's host token of a test plan: preparing a plan again on a page reuses it, as the plan is the same. */
const tokens = new WeakMap<KeepHost, Map<InstructionPlan, string>>();
let heldPlan: (bridge: PlayerBridge, token: string) => object;
let createInProcessBackend: (
  build: { commit: null; dirty: null; mode: null; appVersion: null },
  options: { readonly delayMs?: number },
) => PlayerBridge;

/** The token under which `host`'s bridge holds `plan`, prepared there from the plan's text the first time. */
async function held(host: KeepHost, plan: InstructionPlan): Promise<string> {
  const known = tokens.get(host) ?? new Map<InstructionPlan, string>();
  tokens.set(host, known);
  const token = known.get(plan) ?? (await preparedPlan(host.bridge, plan));
  known.set(plan, token);
  heldAs.set(heldPlan(await host.bridge, token), plan);
  return token;
}

/** `plan`'s Start on `host`, as a host prepares it: the held plan, with the page's storage and the click's capture. */
async function prepareOn(host: KeepHost, plan: InstructionPlan) {
  const token = await held(host, plan);
  await host.prepareScript(token, {
    plan: token,
    options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
  });
}

/** A page of the Player in `at` that prepares `plan`'s Start, or Continue for the session `at` keeps. */
async function page(
  context: TestContext,
  at: ReturnType<typeof browser>,
  plan: InstructionPlan,
  delayMs?: number,
) {
  const opened = await mount(context, at, delayMs);
  await prepareOn(opened.host, plan);
  return opened;
}

/** A page of the Player in `at` with its saved values loaded, before it prepares a plan. */
async function mount(
  context: TestContext,
  at: ReturnType<typeof browser> & { readonly rooms?: KeptRoomStore },
  delayMs?: number,
) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      ...(delayMs === undefined
        ? {}
        : {
            bridge: Promise.resolve(
              createInProcessBackend(
                { commit: null, dirty: null, mode: null, appVersion: null },
                { delayMs },
              ),
            ),
          }),
      scriptStorage: at.provider,
      capturedMedia: { repository: at.repository },
      keptSessions: at.kept,
      ...(at.rooms === undefined ? {} : { debugRooms: at.rooms }),
      decodeImage: async () => ({ width: 2, height: 2 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  return { host, scope };
}

/** Lets the tasks queued so far run, such as what an activation prepares. */
const tasks = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await tasks();
  }
}

const ASKS = compilePlayerProject(
  'let a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;
const ENDS = compilePlayerProject('say "Hi.", instant\nexit').plan!;
// The plan's JSON as the engine writes it, taken before `planWrites` counts.
const planJson = (plan: InstructionPlan) => serializeValidatedRuntimeJson(plan);

/** Each kept event as the engine writes it, which a store keeping text stores. */
function assertEventsJson(update: KeptSessionUpdate) {
  assert.deepEqual(update.eventsJson, update.events.map(serializeValidatedRuntimeJson));
}

test("the first save stores the plan's JSON written before Start, and the events as the engine writes them", async (context) => {
  const shown = stubBrowser(context);
  const expected = planJson(ASKS);
  const writes = planWrites(context, ASKS);
  const at = browser();
  const { host } = await page(context, at, ASKS);
  await tasks();
  assert.equal(writes(), 1, "prepared before Start");
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  assert.equal(writes(), 1, "Start wrote the plan again");
  const [first] = at.published;
  assert.equal(first!.planJson, expected);
  assert.equal(first!.eventsFrom, 0);
  assertEventsJson(first!);
  // A later save keeps the stored plan.
  const count = at.published.length;
  shown.hide();
  await until(() => at.published.length > count, "the session was not kept again");
  assert.equal(at.published.at(-1)!.planJson, null);
  assertEventsJson(at.published.at(-1)!);
  assert.equal(writes(), 1);
});

test("a Start before the preparation ran writes the plan's JSON itself, once, with the same bytes", async (context) => {
  stubBrowser(context);
  const expected = planJson(ASKS);
  const writes = planWrites(context, ASKS);
  const at = browser();
  const { host } = await page(context, at, ASKS);
  // No task has run since the Start control was offered.
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  assert.equal(at.published[0]!.planJson, expected);
  await tasks();
  assert.equal(writes(), 1);
});

test("a save the store refused is kept again with the same plan JSON, written only once", async (context) => {
  const shown = stubBrowser(context);
  const writes = planWrites(context, ASKS);
  const at = browser();
  at.state.failing = 1;
  const { host } = await page(context, at, ASKS);
  await tasks();
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  await tasks();
  shown.hide();
  await until(() => at.published.length > 1, "the session was not kept again");
  const [refused, retried] = at.published;
  assert.ok(refused!.planJson !== null);
  assert.equal(retried!.planJson, refused!.planJson);
  assert.equal(retried!.eventsFrom, 0);
  assertEventsJson(retried!);
  assert.equal(writes(), 1);
  // Kept now: the next save keeps the stored plan.
  shown.hide();
  await until(() => at.published.length > 2, "the session was not kept a third time");
  assert.equal(at.published[2]!.planJson, null);
});

test("a session that ended starts anew with the plan JSON its restore read, and a closed page prepares nothing", async (context) => {
  stubBrowser(context);
  const expected = planJson(ENDS);
  const writes = planWrites(context, ENDS);
  const at = browser();
  const { host } = await page(context, at, ENDS);
  await tasks();
  await host.activate();
  assert.equal(host.session.value?.state.status, "halted");
  await host.toStartPage();
  assert.equal(host.activation.value, "start");
  // The prepared JSON, which the restore's comparison read; the next Start's first save writes none.
  assert.equal(writes(), 1);
  await host.activate();
  await until(
    () => at.published.filter((update) => update.planJson !== null).length > 1,
    "the new session was not kept",
  );
  await tasks();
  assert.equal(writes(), 1);
  for (const update of at.published.filter((update) => update.planJson !== null))
    assert.equal(update.planJson, expected);

  const closing = browser();
  const { scope } = await page(context, closing, ENDS);
  scope.stop();
  await tasks();
  assert.equal(writes(), 1);
});

test("Start and Continue record the zone and clock at the click, not those prepared before it", async (context) => {
  stubBrowser(context);
  const zone = process.env["TZ"];
  context.after(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });
  const recorded = (session: PlayerRuntimeSession | null) => {
    const capture = playerRuntimeSnapshot(session!).temporalCaptures.at(-1)!;
    return { zone: capture.context.zone.name, epochMs: capture.epochMs };
  };
  const at = browser();
  process.env["TZ"] = "Europe/Amsterdam";
  const { host } = await page(context, at, ASKS);
  await tasks();
  process.env["TZ"] = "Asia/Tokyo";
  const started = Date.now();
  await host.activate();
  const start = recorded(host.session.value);
  assert.equal(start.zone, "Asia/Tokyo");
  assert.ok(start.epochMs! >= started && start.epochMs! <= Date.now());
  await until(() => at.published.length > 0, "the session was not kept");

  // A reload continues the kept session.
  process.env["TZ"] = "Europe/Amsterdam";
  const reloaded = (await page(context, at, ASKS)).host;
  assert.equal(reloaded.activation.value, "continue");
  await tasks();
  process.env["TZ"] = "America/Sao_Paulo";
  // The host's first reply of the Continue (`beginRecording`) is held; meanwhile the zone and the clock change. The
  // Continue records them as they were at the click (#1886).
  const bridge = await reloaded.bridge;
  const request = bridge.client.request.bind(bridge.client);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const sent = request(...args);
    return args[0] === "beginRecording" ? sent.then(async (reply) => (await held, reply)) : sent;
  });
  const resumed = Date.now();
  const continuing = reloaded.activate();
  const clicked = Date.now();
  process.env["TZ"] = "Asia/Kolkata";
  context.mock.method(Date, "now", () => clicked + 20_000);
  release();
  await continuing;
  const go = recorded(reloaded.session.value);
  assert.equal(go.zone, "America/Sao_Paulo");
  assert.ok(go.epochMs! >= resumed && go.epochMs! <= clicked, "the clock of the click");
});

/** Holds `at`'s next publication until `release()`; `entered` gives its update once it is issued. */
function holdNext(at: ReturnType<typeof browser>) {
  let issue: (update: KeptSessionUpdate) => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<KeptSessionUpdate>((resolve) => (issue = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const publish = at.kept.publish;
  let held = false;
  at.kept.publish = async (scope, update) => {
    if (!held) {
      held = true;
      issue(update);
      await released;
    }
    return publish(scope, update);
  };
  return { entered, release };
}

/** Prepares `plan`'s Start again on `host`'s page, as a host does for another script or the same one. */
async function prepareAgain(host: KeepHost, plan: InstructionPlan) {
  await prepareOn(host, plan);
}

test("a save still being stored leaves the plan JSON prepared for the next Start, of the same plan or another", async (context) => {
  stubBrowser(context);
  const [ends, asks] = [planJson(ENDS), planJson(ASKS)];
  const writes = planWrites(context, ENDS, ASKS);
  for (const next of [ENDS, ASKS]) {
    const at = browser();
    const pending = holdNext(at);
    const { host } = await page(context, at, ENDS);
    await tasks();
    await host.activate();
    const first = await pending.entered;
    await prepareAgain(host, next);
    assert.equal(host.activation.value, "start");
    await tasks();
    pending.release();
    await until(() => at.published.length > 0, "the first session was not kept");
    await host.activate();
    await until(() => at.published.length > 1, "the next session was not kept");
    assert.equal(first.planJson, ends);
    assert.equal(at.published.at(-1)!.planJson, next === ENDS ? ends : asks);
  }
  // One write each for ENDS's two pages and ASKS's, all before a Start.
  assert.deepEqual([writes(ENDS), writes(ASKS)], [2, 1]);
});

test("keep requests during a write become one more save, which appends the events after it", async (context) => {
  const shown = stubBrowser(context);
  const at = browser();
  const pending = holdNext(at);
  const { host } = await page(context, at, ASKS);
  await tasks();
  await host.activate();
  await pending.entered;
  shown.hide();
  shown.hide();
  pending.release();
  await until(() => at.published.length > 1, "the requests were not kept");
  await tasks();
  assert.equal(at.published.length, 2);
  const [first, second] = at.published;
  assert.equal(second!.eventsFrom, first!.events.length);
  assert.equal(second!.planJson, null);
  assertEventsJson(second!);
});

test("Start and Continue capture a zone not seen before ahead of the click, and the click reuses it", async (context) => {
  stubBrowser(context);
  const zone = process.env["TZ"];
  context.after(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });
  // A zone's rules are captured with a `longOffset` formatter, once per zone and page.
  const captured: string[] = [];
  const RealFormat = Intl.DateTimeFormat;
  const note = (options: Intl.DateTimeFormatOptions | undefined) => {
    if (options?.timeZoneName === "longOffset") captured.push(String(options.timeZone));
  };
  Intl.DateTimeFormat = new Proxy(RealFormat, {
    construct(target, args) {
      note(args[1]);
      return new target(args[0], args[1]);
    },
    apply(target, _self, args) {
      note(args[1]);
      return target(args[0], args[1]);
    },
  });
  context.after(() => (Intl.DateTimeFormat = RealFormat));
  const at = browser();
  process.env["TZ"] = "Pacific/Marquesas";
  const { host } = await page(context, at, ASKS);
  assert.deepEqual(captured, [], "not within the preparation itself");
  await tasks();
  assert.deepEqual(captured, ["Pacific/Marquesas"]);
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  assert.deepEqual(captured, ["Pacific/Marquesas"], "Start captured the zone again");

  process.env["TZ"] = "Pacific/Chatham";
  const reloaded = (await page(context, at, ASKS)).host;
  assert.equal(reloaded.activation.value, "continue");
  await tasks();
  assert.deepEqual(captured, ["Pacific/Marquesas", "Pacific/Chatham"]);
  await reloaded.activate();
  assert.deepEqual(
    captured,
    ["Pacific/Marquesas", "Pacific/Chatham"],
    "Continue captured it again",
  );
});

test("a Start prepared while the first save's capture is out takes that save's plan JSON", async (context) => {
  stubBrowser(context);
  const expected = planJson(ASKS);
  const writes = planWrites(context, ASKS);
  const at = browser();
  // Replies take 50 ms, so the capture's reply, with the plan's JSON, is out while the next Start is prepared.
  const { host } = await page(context, at, ASKS, 50);
  await until(() => writes() === 1, "the plan's JSON was not prepared");
  const bridge = await host.bridge;
  let captured!: () => void;
  const capturing = new Promise<void>((resolve) => (captured = resolve));
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const sent = request(...args);
    if (args[0] === "captureKeep") captured();
    return sent;
  });
  await host.activate();
  await capturing;
  await prepareAgain(host, ASKS);
  await until(() => at.published.length > 0, "the first session was not kept");
  await host.activate();
  await until(
    () => at.published.filter((update) => update.planJson !== null).length > 1,
    "the next session was not kept",
  );
  for (const update of at.published.filter((update) => update.planJson !== null))
    assert.equal(update.planJson, expected);
  assert.equal(writes(), 1, "the next Start took the first save's JSON");
});

test("a plan another preparation replaced, and the page's last one when it closes, let go of their JSON", async (context) => {
  stubBrowser(context);
  const writes = planWrites(context, ASKS, ENDS);
  const at = browser();
  const { host, scope } = await page(context, at, ASKS);
  await tasks();
  await prepareAgain(host, ENDS);
  await tasks();
  assert.deepEqual([writes(ASKS), writes(ENDS)], [1, 1]);
  const bridge = await host.bridge;
  const [asks, ends] = [await held(host, ASKS), await held(host, ENDS)];
  scope.stop();
  await tasks();
  // Each JSON is written anew when asked for: the host let go of both.
  await bridge.client.request("planText", { plan: asks });
  await bridge.client.request("planText", { plan: ends });
  assert.deepEqual([writes(ASKS), writes(ENDS)], [2, 2]);
});

/*
 * The plan JSON's lifetime through the real composable and its in-process host: the family of
 * `helpers/plan-json-family.ts`, each producer driven on its real path, its reply held while the page's plan retires
 * (or does not). At the end, the host holds the plan's JSON while it is the live page's current plan and lets go of it
 * otherwise, and it was written at most once while the page held the plan.
 */
const ASKS_OTHER = compilePlayerProject(
  'let b = askText(hint: "Other")\nsay "Got ${b}.", instant\nexit',
).plan!;

/** Holds `op`'s reply on `bridge` until `release`; `sent` resolves once it was posted, `before` sees its arguments. */
function holdReply(
  context: TestContext,
  bridge: PlayerBridge,
  op: string,
  before?: (args: unknown, request: PlayerBridge["client"]["request"]) => void,
) {
  let posted!: () => void;
  const sent = new Promise<void>((resolve) => (posted = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const request = bridge.client.request.bind(bridge.client);
  let first = true;
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    if (args[0] !== op || !first) return request(...args);
    first = false;
    before?.(args[1], request);
    const reply = request(...args).then(async (result) => {
      await gate;
      return result;
    });
    posted();
    return reply;
  });
  return { sent, release: () => release() };
}

/** A kept session in `at` of `plan`: at its first question, or at its end. */
async function seedKept(
  context: TestContext,
  at: ReturnType<typeof browser>,
  plan: InstructionPlan,
  ended: boolean,
) {
  const { host, scope } = await page(context, at, plan);
  await host.activate();
  if (ended)
    await until(
      () => at.published.some((update) => update.events.some((event) => event.kind === "exit")),
      "the seed's end was not kept",
    );
  else await until(() => at.published.length > 0, "the seed was not kept");
  scope.stop();
  await tasks();
}

interface Driven {
  readonly host: KeepHost;
  readonly scope: EffectScope;
  /** The plan under test, which the page holds until it retires. */
  readonly plan: InstructionPlan;
  /** Lets the producer's reply arrive, and resolves once its caller is done with it. */
  readonly finish: () => Promise<void>;
  /** Writes of the plan that are not the lease's: an import's review compares the plans on the main side (L5h.2). */
  readonly reviewWrites?: number;
}

/** Each producer on its real path, its reply held; a new producer needs its driver here (the type requires it). */
const DRIVERS: Record<
  Producer,
  (context: TestContext, at: ReturnType<typeof browser>, c: FamilyCase) => Promise<Driven>
> = {
  async preparePlanText(context, at, c) {
    const { host, scope } = await mount(context, at);
    const token = await held(host, ASKS);
    if (c.outcome === "writeFailed") failPlanWrite = ASKS;
    context.after(() => (failPlanWrite = null));
    // Prepared without waiting: a retirement right after cancels the reservation before its task runs.
    const preparing = host.prepareScript(token, {
      plan: token,
      options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
    });
    if (c.outcome === "writeFailed") {
      await preparing;
      await until(() => failPlanWrite === null, "the reservation's task did not try to write");
    } else if (c.outcome === "materialized") {
      await preparing;
      for (let turn = 0; (await writesOn(host, ASKS)) === 0; turn++) {
        assert.ok(turn < 200, "the reservation was not written");
        await tasks();
      }
    }
    return { host, scope, plan: ASKS, finish: async () => void (await preparing) };
  },
  async restoreKept(context, at, c) {
    const seeded = c.outcome === "otherPlan" ? ASKS_OTHER : c.outcome === "ended" ? ENDS : ASKS;
    await seedKept(context, at, seeded, c.outcome === "ended");
    if (c.outcome === "rejected") {
      const stored = await at.kept.session(SCOPE);
      assert.ok(stored !== null);
      const entry = keptSession(stored);
      assert.ok(entry !== null);
      await at.kept.publish(SCOPE, {
        planJson: entry.planJson,
        snapshotJson: '{"damaged":true}',
        eventsFrom: 0,
        events: entry.events,
        eventsJson: entry.events.map(serializeValidatedRuntimeJson),
        marks: { editedWhileDebugging: null, rewoundWhileDebugging: null },
      });
    }
    const plan = c.outcome === "ended" ? ENDS : ASKS;
    const { host, scope } = await mount(context, at);
    const reply = holdReply(context, await host.bridge, "restoreKept");
    const preparing = prepareOn(host, plan);
    await reply.sent;
    return {
      host,
      scope,
      plan,
      finish: async () => {
        reply.release();
        await preparing;
      },
    };
  },
  async planText(context, at, c) {
    const exporting = await page(context, at, ASKS);
    await exporting.host.activate();
    await until(() => exporting.host.session.value !== null, "no session to export");
    const { transfer } = await exporting.host.exportSession();
    exporting.scope.stop();
    const { host, scope } = await page(context, at, ASKS);
    const beforeReview = await writesOn(host, ASKS);
    const review = await host.reviewSessionImport(transfer);
    const reviewWrites = (await writesOn(host, ASKS)) - beforeReview;
    const reply = holdReply(context, await host.bridge, "planText");
    if (c.outcome === "failed") at.state.failing = 1;
    const importing = host.importSession(review).catch(() => {});
    await reply.sent;
    return {
      host,
      scope,
      plan: ASKS,
      reviewWrites,
      finish: async () => {
        reply.release();
        await importing;
      },
    };
  },
  async captureKeep(context, at, c) {
    const { host, scope } = await page(context, at, ASKS);
    const reply = holdReply(context, await host.bridge, "captureKeep", (args, request) => {
      if (c.outcome === "unkeepable") failNextSnapshot = true;
      const session =
        typeof args === "object" && args !== null && "session" in args ? args.session : null;
      // A session the host no longer holds: released just before the capture runs.
      if (c.outcome === "gone" && typeof session === "string")
        void request("release", null, { session });
    });
    const activating = host.activate();
    await reply.sent;
    return {
      host,
      scope,
      plan: ASKS,
      finish: async () => {
        reply.release();
        await activating;
        await tasks();
      },
    };
  },
};

for (const c of familyCases()) {
  if (c.producer === "preparePlanText" && c.outcome === "cancelled" && c.retirement === "current")
    continue;
  test(`the composable's plan JSON: ${caseName(c)}`, async (context) => {
    stubBrowser(context);
    const at = browser();
    planWrites(context, ASKS, ENDS, ASKS_OTHER);
    const driven = await DRIVERS[c.producer](context, at, c);
    const bridge = await driven.host.bridge;
    const token = await held(driven.host, driven.plan);
    // The page's plan retires while the producer's reply is held, or stays.
    if (c.retirement === "replaced")
      await prepareAgain(driven.host, driven.plan === ASKS_OTHER ? ASKS : ASKS_OTHER);
    else if (c.retirement === "disposed") driven.scope.stop();
    await driven.finish();
    for (let turn = 0; turn < 4; turn++) await tasks();
    const written = await writesOn(driven.host, driven.plan);
    assert.ok(
      written - (driven.reviewWrites ?? 0) <= 1,
      `${caseName(c)}: written ${written} times`,
    );
    // Asked for it twice now: held, it is not written again, or once after its task failed; let go of, each read writes
    // it and keeps nothing.
    await bridge.client.request("planText", { plan: token });
    await bridge.client.request("planText", { plan: token });
    assert.equal(
      (await writesOn(driven.host, driven.plan)) - written,
      c.retirement !== "current" ? 2 : c.outcome === "writeFailed" ? 1 : 0,
      `${caseName(c)}: the host's plan JSON after the case`,
    );
  });
}

test("the composable's family drives every producer of the shared family", () => {
  assert.deepEqual(Object.keys(DRIVERS).sort(), Object.keys(PRODUCERS).sort());
});

/*
 * Continuation ownership (`player/persistence-ownership.ts`), closed over a generated family: each producer's operation
 * held at each point of `SUSPENSIONS` while its page moves on (`MOVES`). One recorder takes every call of the kept
 * store, its photos, the saved values' provider, the media store, the debug rooms and the host; it tells the
 * operation's own calls by their async context, holds the point's first call, and fails a call the descriptor lists
 * neither as a suspension nor as posted. Every row asserts both obligations: a stale operation writes to no store after
 * the move, and changes nothing of the page (activation, the loaded saved values, `savedDataRevision`, the notices, the
 * importing mark) but releasing its own importing mark. Its failure is neither shown nor thrown, and no rejection goes
 * unhandled. An operation the move left current goes on. The sessions use a photo, and each read of the saved values
 * gives values of its own, so a stale read's values are seen if shown.
 */
test("an operation's commit applies synchronously while it is current, and ends it once stale", () => {
  let current = true;
  const ownership = persistenceOwnership(() => current);
  assert.equal(
    ownership.commit(() => 1),
    1,
  );
  // An apply that awaits would go on after the commit's check.
  const later = Promise.resolve();
  assert.throws(() => ownership.commit(() => later), TypeError);
  current = false;
  let applied = false;
  assert.throws(() => ownership.commit(() => (applied = true)), StaleOperation);
  assert.equal(applied, false);
  assert.throws(() => ownership.check(), StaleOperation);
});

const OPERATION = "operation";
const MOVE = "move";
const contexts = new AsyncLocalStorage<string>();

const PHOTO_PLAN = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image")\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** The methods of the recorded stores that write. */
const WRITING = new Set(["publish", "discard", "discardSession", "replace", "write", "clear"]);
const WRITING_MEDIA = new Set(["add", "delete"]);

interface RecordedCall {
  readonly name: string;
  /** The async context the call was made in: the operation's, the move's, or none. */
  readonly by: string | undefined;
  readonly write: boolean;
}

/**
 * Every store of `at` behind one recorder, installed before its pages mount; `hold(name)` holds the operation's first
 * call of `name` (a host request once it is posted, a store call before it runs) until `release()`.
 */
function recorder(context: TestContext, at: ReturnType<typeof familyBrowser>) {
  const calls: RecordedCall[] = [];
  let armed: string | null = null;
  let reached = () => {};
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  let introduced: string | null = null;
  const take = (name: string): Promise<void> | null => {
    if (armed !== name || contexts.getStore() !== OPERATION) return null;
    armed = null;
    reached();
    return gate;
  };
  const record = (name: string, write: boolean) =>
    calls.push({ name, by: contexts.getStore(), write });
  const instrument = <T extends object>(target: T, surface: string): T => {
    const nested = new Map<string, unknown>();
    return new Proxy(target, {
      get(object, key) {
        // EVIDENCE: invariant: the recorded stores are plain objects, read by their methods' and fields' names.
        const value: unknown = (object as Record<PropertyKey, unknown>)[key];
        if (typeof key !== "string") return value;
        if (key === "media" && typeof value === "object" && value !== null) {
          if (!nested.has(key)) nested.set(key, instrument(value, `${surface}.media`));
          return nested.get(key);
        }
        if (typeof value !== "function") return value;
        const name = `${surface}.${key}`;
        return (...args: unknown[]) => {
          const media = surface.endsWith(".media") || surface === "repository";
          record(name, media ? WRITING_MEDIA.has(key) : WRITING.has(key));
          const run = () => {
            const result: unknown = value.apply(object, args);
            // A debug room's saved values are a provider of their own.
            return key === "values" && typeof result === "object" && result !== null
              ? instrument(result, `${surface}.values`)
              : result;
          };
          const held = take(name);
          return held === null ? run() : held.then(run);
        };
      },
    });
  };
  at.kept = instrument(at.kept, "kept");
  at.provider = instrument(at.provider, "provider");
  at.repository = instrument(at.repository, "repository");
  at.rooms = instrument(at.rooms, "rooms");
  return {
    calls,
    /** The host's requests of `bridge`'s page, recorded from now on. */
    watchHost(bridge: PlayerBridge) {
      const request = bridge.client.request.bind(bridge.client);
      context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
        const name = `host.${args[0]}`;
        record(name, false);
        const by = contexts.getStore();
        const reply = request(...args);
        if (args[0] === "restoreKept" && by === OPERATION)
          reply.then(
            (result) => {
              if (typeof result.session === "string") introduced = result.session;
            },
            () => {},
          );
        const held = take(name);
        return held === null ? reply : reply.then(async (result) => (await held, result));
      });
    },
    hold(name: string) {
      armed = name;
      gate = new Promise<void>((resolve) => (open = resolve));
      return new Promise<void>((resolve) => (reached = resolve));
    },
    release: () => open(),
    /** The session the operation's restore introduced in the host, if any. */
    introduced: () => introduced,
  };
}

/** One browser for the family: `browser()`'s, whose saved values give each read a value of its own. */
function familyBrowser() {
  const rooms: KeptRoomStore = memoryKeptRoomStore();
  const at = { ...browser(), rooms };
  type Entries = Parameters<ScriptStorageProvider["replace"]>[0];
  let stored: Entries = [];
  let reads = 0;
  at.provider = {
    scope: SCOPE,
    load: async () => [...stored, { key: "read", value: ++reads }],
    write: async (key, value) => {
      stored = [...stored.filter((entry) => entry.key !== key), { key, value }];
    },
    replace: async (entries) => {
      stored = entries.filter((entry) => entry.key !== "read");
    },
    clear: async () => {
      stored = [];
    },
  };
  return at;
}

/** The page as its player sees it, and each change of it with the async context that made it. */
function pageLog(host: KeepHost) {
  const snapshot = () => ({
    activation: host.activation.value,
    savedValues: host.scriptStorageOptions().scriptStorage ?? null,
    savedDataRevision: host.savedDataRevision.value,
    notices: host.notices.value.map((notice) => notice.key),
    importing: !host.canImportSavedData.value,
  });
  type Snapshot = ReturnType<typeof snapshot>;
  const changes: {
    readonly by: string | undefined;
    readonly from: Snapshot;
    readonly to: Snapshot;
  }[] = [];
  let last = snapshot();
  // Its own scope: the log goes on after the page closes.
  const scope = effectScope(true);
  scope.run(() =>
    watch(
      () => JSON.stringify(snapshot()),
      () => {
        const next = snapshot();
        changes.push({ by: contexts.getStore(), from: last, to: next });
        last = next;
      },
      { flush: "sync" },
    ),
  );
  return { snapshot, changes, stop: () => scope.stop() };
}

/** Lets `host`'s session take the fixture photo at its first question, then waits for its next question. */
async function answerPhoto(host: KeepHost): Promise<string> {
  await until(() => host.session.value?.state.status === "waiting", "the session did not ask");
  const stored = await host.images.store(new File([PNG], "photo.png"), { types: null, mime: null });
  assert.ok("reference" in stored, "the photo was not stored");
  assert.equal(host.imageCapture.choose(stored.reference), true);
  const used = await answerWith(host, host.imageCapture.answer("button"));
  assert.equal(used.outcome?.kind, "completed");
  return stored.reference;
}

/** A page of `at` whose session took the photo and asks its next question, kept with the photo. */
async function photoSession(context: TestContext, at: ReturnType<typeof familyBrowser>) {
  const opened = await page(context, at, PHOTO_PLAN);
  await opened.host.activate();
  const reference = await answerPhoto(opened.host);
  await until(
    () => at.published.some((update) => update.snapshotJson.includes(reference)),
    "the session was not kept with its photo",
  );
  for (let turn = 0; turn < 4; turn++) await tasks();
  return opened;
}

/** An operation of a producer, prepared on its page; `start` begins it, in the operation's context. */
interface Operation {
  readonly host: KeepHost;
  readonly scope: EffectScope;
  readonly plan: InstructionPlan;
  start(): Promise<void>;
}
/** What a driver is given: the host's recorder, the page's hiding, and the row's point and variant. */
interface OperationRow {
  readonly watchHost: (bridge: PlayerBridge) => void;
  readonly hide: () => void;
  readonly point: string;
  readonly publishFails: boolean;
}
type OperationDriver = (
  context: TestContext,
  at: ReturnType<typeof familyBrowser>,
  row: OperationRow,
) => Promise<Operation>;

/** Each operation on its real path, up to its start. */
const OPERATIONS: Record<Exclude<Producer, "preparePlanText">, OperationDriver> = {
  // A Continue's restore of a session kept with its photo.
  async restoreKept(context, at, { watchHost }) {
    const seed = await photoSession(context, at);
    seed.scope.stop();
    await tasks();
    const { host, scope } = await mount(context, at);
    watchHost(await host.bridge);
    const token = await held(host, PHOTO_PLAN);
    return {
      host,
      scope,
      plan: PHOTO_PLAN,
      start: () =>
        host.prepareScript(token, {
          plan: token,
          options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
        }),
    };
  },
  // An import of an exported session that uses the photo, over the session it replaces.
  async planText(context, at, { watchHost, publishFails }) {
    const exporting = await photoSession(context, at);
    const { transfer } = await exporting.host.exportSession();
    exporting.scope.stop();
    await tasks();
    const { host, scope } = await page(context, at, PHOTO_PLAN);
    const review = await host.reviewSessionImport(transfer);
    watchHost(await host.bridge);
    return {
      host,
      scope,
      plan: PHOTO_PLAN,
      start: () => {
        if (publishFails) at.state.failing = 1;
        return host.importSession(review);
      },
    };
  },
  // A first save of a session with its photo, after the earlier saves were refused; `forget` captures a state this
  // browser cannot write.
  async captureKeep(context, at, { watchHost, hide, point }) {
    const { host, scope } = await page(context, at, PHOTO_PLAN);
    watchHost(await host.bridge);
    at.state.failing = Number.MAX_SAFE_INTEGER;
    await host.activate();
    const reference = await answerPhoto(host);
    await until(
      () => at.published.some((update) => update.snapshotJson.includes(reference)),
      "the session's save was not tried",
    );
    for (let turn = 0; turn < 4; turn++) await tasks();
    at.state.failing = 0;
    return {
      host,
      scope,
      plan: PHOTO_PLAN,
      start: async () => {
        if (point === "forget") failNextSnapshot = true;
        hide();
      },
    };
  },
};

/** The page of `operation` moves on as `move` says. */
async function moveOn(operation: Operation, move: Move) {
  if (move === "otherPlan") await prepareAgain(operation.host, ASKS_OTHER);
  else if (move === "samePlan") await prepareAgain(operation.host, operation.plan);
  else if (move === "room") {
    operation.host.setDebugMode(true);
    await until(
      () => operation.host.rooms.current.value === "debug",
      "the page did not open the debug room",
    );
  } else operation.scope.stop();
}

/** The calls each producer's operation reached across its rows. */
const reachedCalls = new Map<Producer, Set<string>>();

/** One row: `producer`'s operation held at `point` while its page moves as `move` says. */
async function ownershipRow(
  context: TestContext,
  producer: Exclude<Producer, "preparePlanText">,
  point: string,
  move: Move | null,
  publishFails = false,
) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  context.after(() => process.off("unhandledRejection", onUnhandled));
  const shown = stubBrowser(context);
  planWrites(context, PHOTO_PLAN, ASKS_OTHER);
  context.after(() => (failNextSnapshot = false));
  const at = familyBrowser();
  const recorded = recorder(context, at);
  const operation = await OPERATIONS[producer](context, at, {
    watchHost: recorded.watchHost,
    hide: shown.hide,
    point,
    publishFails,
  });
  const log = pageLog(operation.host);
  context.after(log.stop);
  const bridge = await operation.host.bridge;
  // EVIDENCE: invariant: `point` is a key of the producer's suspensions, which the caller iterates.
  const call = (SUSPENSIONS[producer] as Record<string, string>)[point]!;
  const reached = recorded.hold(call);
  const done = contexts
    .run(OPERATION, () => operation.start())
    .then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"missed">(
    (resolve) => (timer = setTimeout(resolve, 2_000, "missed")),
  );
  const arrived = await Promise.race([reached, deadline]);
  clearTimeout(timer);
  assert.notEqual(arrived, "missed", `${call} was not reached`);
  const retires = move === null ? false : stale(producer, move) === true;
  // The page goes on with what the move prepared, where it can: its Start runs. An import under way holds Start back
  // until a room change takes the page over; a room change waits for the saved values' calls issued before it, so an
  // import held at one of them holds the room change too.
  const moveWaits = producer === "planText" && move === "room" && call.startsWith("provider.");
  const startsAnew =
    move !== null &&
    move !== "disposed" &&
    (producer === "restoreKept" || (producer === "planText" && move === "room" && !moveWaits));
  if (move !== null)
    await contexts.run(MOVE, async () => {
      await moveOn(operation, move);
      if (startsAnew) {
        await operation.host.activate();
        await until(
          () => operation.host.session.value !== null && operation.host.activation.value === null,
          "the moved-on page did not start",
        );
      }
      for (let turn = 0; turn < 4; turn++) await tasks();
    });
  const callsAtMark = recorded.calls.length;
  const changesAtMark = log.changes.length;
  const publishedAtMark = at.published.length;
  const before = log.snapshot();
  recorded.release();
  const outcome = await done;
  for (let turn = 0; turn < 6; turn++) await tasks();
  const after = log.snapshot();
  const own = recorded.calls.filter((made) => made.by === OPERATION);
  const reachedHere = reachedCalls.get(producer) ?? new Set<string>();
  reachedCalls.set(producer, reachedHere);
  for (const made of own) reachedHere.add(made.name);
  // Every call the operation made is a suspension or a posted call of the descriptor.
  const listed = new Set<string>([...Object.values(SUSPENSIONS[producer]), ...Object.keys(POSTED)]);
  assert.deepEqual(
    own.filter((made) => !listed.has(made.name)).map((made) => made.name),
    [],
    "the operation made a call the descriptor does not list",
  );
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
  if (move === null || !retires) return { outcome, at, log, publishedAtMark, changesAtMark };
  // Stale: no store write after the move, by destination.
  assert.deepEqual(
    recorded.calls
      .slice(callsAtMark)
      .filter((made) => made.by === OPERATION && made.write)
      .map((made) => made.name),
    [],
    `the stale ${producer} wrote after the move`,
  );
  // No page effect after the move but releasing its own importing mark, which shows what the mark held back.
  for (const change of log.changes.slice(changesAtMark).filter((made) => made.by === OPERATION)) {
    const { importing: markFrom, activation: _from, ...restFrom } = change.from;
    const { importing: markTo, activation: _to, ...restTo } = change.to;
    assert.ok(
      markFrom && !markTo && JSON.stringify(restFrom) === JSON.stringify(restTo),
      `the stale ${producer} changed the page: ${JSON.stringify(change)}`,
    );
  }
  // The page stays as the move left it, where the move did not wait for the operation.
  if (!moveWaits)
    assert.deepEqual(
      after,
      {
        ...before,
        importing: false,
        activation: before.importing ? after.activation : before.activation,
      },
      `the page after the stale ${producer}`,
    );
  // Its failure is neither shown nor thrown.
  assert.equal(outcome.rejected, false, `the stale ${producer} rejected`);
  const introduced = recorded.introduced();
  if (introduced !== null && move !== "disposed")
    assert.equal(bridge.store(introduced), null, "the stale restore's session was released");
  return { outcome, at, log, publishedAtMark, changesAtMark };
}

// EVIDENCE: invariant: the keys of `SUSPENSIONS`, which are the producers.
for (const producer of Object.keys(SUSPENSIONS) as Producer[]) {
  if (producer === "preparePlanText") continue;
  for (const point of Object.keys(SUSPENSIONS[producer]))
    for (const move of MOVES) {
      const retires = stale(producer, move);
      if (retires === "unreachable") continue;
      test(`continuation ownership: ${producer} at ${point}, ${move}`, async (context) => {
        const row = await ownershipRow(context, producer, point, move);
        if (retires) return;
        // A keep the move left current goes on: it saves, or after a state it cannot write, says so.
        if (point === "forget")
          assert.ok(
            row.log.changes
              .slice(row.changesAtMark)
              .some((change) => change.to.notices.includes("session-not-kept")),
            "the current keep did not say that the session is not kept",
          );
        else
          assert.ok(row.at.published.length > row.publishedAtMark, "the current keep did not save");
      });
    }
}

// The import's kept-session write fails: retired at its final read or its Continue's store read, it neither shows nor
// throws that failure; current, it rejects with it.
for (const point of ["reload", "restoreRead"] as const)
  for (const move of MOVES)
    test(`continuation ownership: planText failing its publish, at ${point}, ${move}`, async (context) => {
      await ownershipRow(context, "planText", point, move, true);
    });
test("continuation ownership: a current import whose publish fails rejects with what was imported", async (context) => {
  const { outcome } = await ownershipRow(context, "planText", "reload", null, true);
  assert.equal(outcome.rejected, true);
  assert.match(String(outcome.rejected && outcome.error), /could not keep the session/);
});

/** A reservation whose task has not run, while its page moves on. */
for (const move of MOVES)
  test(`continuation ownership: preparePlanText at task, ${move}`, async (context) => {
    stubBrowser(context);
    const at = browser();
    planWrites(context, ASKS, ASKS_OTHER);
    const { host, scope } = await mount(context, at);
    const token = await held(host, ASKS);
    const preparing = host.prepareScript(token, {
      plan: token,
      options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
    });
    // The page reserves once its host is ready; the move comes before the reservation's task.
    await host.bridge;
    await held(host, ASKS);
    await moveOn({ host, scope, plan: ASKS, start: async () => {} }, move);
    await preparing;
    for (let turn = 0; turn < 4; turn++) await tasks();
    // Let go of where the move retired the plan, kept where it did not.
    const bridge = await host.bridge;
    const before = await writesOn(host, ASKS);
    await bridge.client.request("planText", { plan: token });
    assert.equal((await writesOn(host, ASKS)) - before, stale("preparePlanText", move) ? 1 : 0);
  });

test("continuation ownership covers its descriptor: each point a row, each call it reached listed and held", (context) => {
  for (const unheld of Object.keys(UNHELD_AWAITS))
    assert.ok(!(unheld in POSTED), `${unheld} is both posted and named unheld`);
  let points = 0;
  // EVIDENCE: invariant: the keys of `SUSPENSIONS`, which are the producers.
  for (const producer of Object.keys(SUSPENSIONS) as Producer[]) {
    if (producer === "preparePlanText") continue;
    const reached = reachedCalls.get(producer) ?? new Set<string>();
    for (const call of Object.values(SUSPENSIONS[producer])) {
      points += 1;
      assert.ok(reached.has(call), `${producer}'s ${call} was never reached`);
    }
    context.diagnostic(`${producer} reached ${[...reached].sort().join(", ")}`);
  }
  context.diagnostic(`${points} held points`);
});
