import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  memoryKeptSessionStore,
  type KeptSessionStore,
  type KeptSessionUpdate,
} from "../player/kept-sessions.js";
import {
  playerRuntimeSnapshot,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { InstructionPlan } from "../src/index.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

// What Start leaves out of its own frame (#1707): the plan's JSON for a new session's first save is written in a task
// before Start, and the zone the browser names is captured early. Start and Continue still record the zone and clock
// as they are at the click, and the stored bytes and saves stay as they were.

interface KeepHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepareScript(
    plan: InstructionPlan,
    create: (options: PlayerRuntimeSessionOptions) => PlayerRuntimeSession,
  ): Promise<void>;
  activate(): Promise<void>;
  toStartPage(): Promise<void>;
  temporalCapture(): PlayerRuntimeSessionOptions;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  capturedMedia: { repository: FakeMediaRepository };
  keptSessions: KeptSessionStore;
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
      if (plans.includes(args[0])) counts.set(args[0], (counts.get(args[0]) ?? 0) + 1);
      return target(args[0], args[1], args[2]);
    },
  });
  context.after(() => (JSON.stringify = stringify));
  return (plan: InstructionPlan | undefined = plans[0]) => counts.get(plan) ?? 0;
}

/** A page of the Player in `at` that prepares `plan`'s Start, or Continue for the session `at` keeps. */
async function page(context: TestContext, at: ReturnType<typeof browser>, plan: InstructionPlan) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: at.provider,
      capturedMedia: { repository: at.repository },
      keptSessions: at.kept,
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  await host.prepareScript(plan, (options) =>
    createPlayerRuntimeSession(plan, {
      ...options,
      ...host.scriptStorageOptions(),
      ...host.temporalCapture(),
    }),
  );
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

test("a session that ended starts anew with the plan JSON its restore wrote, and a closed page prepares nothing", async (context) => {
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
  // The prepared JSON and the restore's comparison; the next Start's first save writes none.
  assert.equal(writes(), 2);
  await host.activate();
  await until(
    () => at.published.filter((update) => update.planJson !== null).length > 1,
    "the new session was not kept",
  );
  await tasks();
  assert.equal(writes(), 2);
  for (const update of at.published.filter((update) => update.planJson !== null))
    assert.equal(update.planJson, expected);

  const closing = browser();
  const { scope } = await page(context, closing, ENDS);
  scope.stop();
  await tasks();
  assert.equal(writes(), 2);
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
  const resumed = Date.now();
  await reloaded.activate();
  const go = recorded(reloaded.session.value);
  assert.equal(go.zone, "America/Sao_Paulo");
  assert.ok(go.epochMs! >= resumed && go.epochMs! <= Date.now());
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
  await host.prepareScript(plan, (options) =>
    createPlayerRuntimeSession(plan, {
      ...options,
      ...host.scriptStorageOptions(),
      ...host.temporalCapture(),
    }),
  );
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
