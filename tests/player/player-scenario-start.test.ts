import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { DEMO_PLAYER_PROFILE } from "../../player/demo-player-profile.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import type { PlanStart } from "../helpers/prepared-plan.js";

/*
 * The development preview's Start of a fixed scenario (`scenarioStart.ts`, L5i.7): its source compiled in the engine's
 * host at page setup, then a Start prepared with the options it reads at the click.
 */

interface ScenarioPlayer {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly bridge: Promise<PlayerBridge>;
  prepare(create: PlanStart): void;
  prepareScript(plan: string, create: PlanStart): Promise<void>;
  activate(): Promise<void>;
  loadScriptStorage(): Promise<void>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly scriptStorage?: ScriptStorageProvider;
}) => ScenarioPlayer;
let prepareScenario: (
  player: ScenarioPlayer,
  source: string,
  options?: { readonly storage?: boolean },
) => Promise<void>;
let createInProcessBackend: typeof InProcess.createInProcessBackend;
const restore: (() => void)[] = [];
before(async () => {
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  const scenario = await loadPlayerModule("player/vue/src/development/scenarioStart.ts");
  const facade = await loadPlayerModule("player/engine-bridge/in-process.ts");
  assert.equal(typeof session.usePlayerSession, "function");
  assert.equal(typeof scenario.prepareScenario, "function");
  assert.equal(typeof facade.createInProcessBackend, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; these are their APIs.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: checked as a function above, from the same bundle.
  prepareScenario = scenario.prepareScenario as typeof prepareScenario;
  // EVIDENCE: validation: checked as a function above, from the bundle the composable runs in.
  createInProcessBackend = facade.createInProcessBackend as typeof createInProcessBackend;
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
    restore.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
after(() => {
  for (const undo of restore) undo();
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const SCENARIO = 'let kept = load("kept", default: 0)\nsay "kept ${kept}", instant\nexit';

/** A Player on a new in-process host whose requests, Start preparations and storage reads are recorded in order. */
function scenarioPlayer(context: TestContext, entries: readonly [string, number][] = []) {
  const bridge = createInProcessBackend(BUILD);
  const order: string[] = [];
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    order.push(`request ${args[0]}`);
    return request(...args);
  });
  const storage: ScriptStorageProvider = {
    scope: "scenario",
    load: async () => {
      order.push("storage read");
      return entries.map(([key, value]) => ({ key, value }));
    },
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({ bridge: Promise.resolve(bridge), scriptStorage: storage }),
  )!;
  context.after(() => {
    scope.stop();
    bridge.client.terminate();
  });
  const prepared: PlanStart[] = [];
  const prepare = player.prepare.bind(player);
  context.mock.method(player, "prepare", (create: PlanStart) => {
    order.push("prepare Start");
    prepared.push(create);
    prepare(create);
  });
  context.mock.method(player, "prepareScript", () => {
    order.push("prepare script");
    return Promise.resolve();
  });
  return { bridge, player, order, prepared, scope };
}

test("a scenario compiles once in the engine's host, then prepares a Start, not a script, that starts it", async (context) => {
  const { player, order } = scenarioPlayer(context);
  await prepareScenario(player, SCENARIO);
  assert.deepEqual(order, ["request prepare", "prepare Start"]);
  await player.activate();
  assert.deepEqual(
    player.session.value?.transcriptEntries.map((entry) => entry.text),
    ["kept 0"],
  );
});

test("a scenario's Start reads the click's zone, presentation and clock and the demo profile; with storage, the stored values too", async (context) => {
  for (const storage of [false, true]) {
    await context.test(storage ? "with storage" : "without storage", async (subtest) => {
      const { player, prepared } = scenarioPlayer(subtest, [["kept", 4]]);
      if (storage) await player.loadScriptStorage();
      await prepareScenario(player, SCENARIO, { storage });
      let now = 1_000;
      subtest.mock.method(Date, "now", () => now);
      const options = prepared[0]!.options();
      now = 2_000;
      assert.equal(options.wallClockMs, 1_000, "the clock as the options are read");
      assert.ok(options.temporalContext, "the zone and presentation");
      assert.deepEqual(options.playerProfile, DEMO_PLAYER_PROFILE);
      assert.deepEqual(
        options.scriptStorage,
        storage ? [{ key: "kept", value: 4 }] : undefined,
        "the stored values exactly with storage",
      );
      await player.activate();
      assert.deepEqual(
        player.session.value?.transcriptEntries.map((entry) => entry.text),
        [storage ? "kept 4" : "kept 0"],
      );
    });
  }
});

test("a scenario with storage reads the stored values before it compiles", async (context) => {
  const { player, order } = scenarioPlayer(context);
  await prepareScenario(player, SCENARIO, { storage: true });
  assert.deepEqual(order, ["storage read", "request prepare", "prepare Start"]);
});

test("a scenario that does not compile is the Player's error stop, and prepares no Start", async (context) => {
  const { player, order } = scenarioPlayer(context);
  const logged = context.mock.method(console, "error", () => {});
  await prepareScenario(player, 'say "unclosed');
  assert.deepEqual(order, ["request prepare"]);
  assert.equal(player.hostError.value, "Error");
  assert.ok(
    logged.mock.calls.some((call) =>
      call.arguments.some((argument) => /The scenario does not compile/u.test(String(argument))),
    ),
    "the stop reports the compile failure",
  );
});

test("a page whose scope ended before the compile's reply prepares no Start and reports nothing", async (context) => {
  const { player, order } = scenarioPlayer(context);
  const page = effectScope();
  const preparing = page.run(() => prepareScenario(player, SCENARIO))!;
  page.stop();
  await preparing;
  assert.deepEqual(order, ["request prepare"]);
  assert.equal(player.hostError.value, null);
});
