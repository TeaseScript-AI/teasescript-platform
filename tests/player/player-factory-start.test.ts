import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
import type { DebugRecorder } from "../../player/debug/debug-recorder.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerRuntimeSession } from "../../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import type { RandomControlOptions } from "../../src/playback.js";
import type { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import type { PlanStart } from "../helpers/prepared-plan.js";

/*
 * Held until PR B (L5i.7): a transitional factory Start through the real composable, as the development preview still
 * starts its scenarios. Each test is one value the activation forwards from the Player to the factory
 * (`useSessionActivation.ts`, `startedSession`), and fails with that forwarding removed. B removes the factory form, and
 * this file with it.
 */

/** What the activation passes a factory: `PlayerSessionStart`'s factory form. */
type FactoryRecording = {
  readonly recorder: DebugRecorder;
  readonly debugTrace?: RuntimeDebugContext;
  readonly debugMode: boolean;
  readonly randomControl?: RandomControlOptions;
};
interface FactoryHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  /**
   * The production `PlayerSessionStart`, both forms: unlike every other loader's, this one admits a factory. (`player/vue`
   * is outside the TypeScript program, so the union is written out here.)
   */
  prepare(create: PlanStart | ((recording: FactoryRecording) => PlayerRuntimeSession)): void;
  activate(): Promise<void>;
  setDebugTracing(on: boolean): void;
  setDebugMode(on: boolean): void;
  setRandomControl(control: { readonly sites: readonly [] } | null): void;
  temporalCapture(): { readonly wallClockMs: number };
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
}) => FactoryHost;
let facade: typeof InProcess;
let compiler: typeof CompileProject;
const restore: (() => void)[] = [];
before(async () => {
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: the bundle the composable runs in, whose facade reaches its host.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
  // A browser surface with event targets and silent audio.
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
const SCRIPT =
  'let mood = "calm"\nsay "${mood} now", instant\nlet roll = randomInteger(1..=6)\nexit';

/** A Player on a new in-process host, and the factory Start it prepared, which keeps what it received. */
async function factoryPlayer(context: TestContext) {
  const bridge = facade.createInProcessBackend(BUILD);
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({ bridge: Promise.resolve(bridge), debugHistorySpill: async () => null }),
  )!;
  context.after(() => {
    scope.stop();
    bridge.client.terminate();
  });
  await player.bridge;
  const received: { recording: FactoryRecording | null; wallClockMs: number | null } = {
    recording: null,
    wallClockMs: null,
  };
  const prepare = (clockInFactory?: () => void) =>
    player.prepare((recording) => {
      received.recording = recording;
      clockInFactory?.();
      received.wallClockMs = player.temporalCapture().wallClockMs;
      return compiler.createPlayerRuntimeSession(SCRIPT, { ...recording, wallClockMs: 0 });
    });
  return { bridge, player, received, prepare };
}

test("a factory Start receives the host's value trace while Debug traces, which records from its first statement (held until PR B)", async (context) => {
  // Its mutant: the factory callback no longer passes `debugTrace` on.
  const { bridge, player, received, prepare } = await factoryPlayer(context);
  player.setDebugTracing(true);
  prepare();
  await player.activate();
  const trace = facade.heldTrace(bridge);
  assert.ok(trace, "Debug's trace runs in the host");
  assert.equal(received.recording?.debugTrace, trace, "the factory got the host's trace");
  assert.ok(trace.status().records > 0, "the trace recorded the first statements");
});

test("a factory Start receives the host's recorder, which records its session from the Start (held until PR B)", async (context) => {
  // Its mutant: the factory callback no longer passes `recorder` on.
  const { bridge, player, received, prepare } = await factoryPlayer(context);
  prepare();
  await player.activate();
  assert.ok(received.recording?.recorder, "the factory got a recorder");
  const recording = facade.heldRecording(bridge);
  assert.equal(recording?.complete, true, "the host's recorder records the factory's session");
  assert.equal(JSON.stringify(recording.plan).includes("now"), true, "of the Start's script");
});

test("a factory Start receives whether Debug mode is on (held until PR B)", async (context) => {
  // Its mutant: the factory callback no longer spreads the activation's `recording` (its `debugMode`).
  const { player, received, prepare } = await factoryPlayer(context);
  player.setDebugMode(true);
  prepare();
  await player.activate();
  assert.equal(received.recording?.debugMode, true);
});

test("a factory Start receives the Player's random control while it owns it (held until PR B)", async (context) => {
  // Its mutant: the factory callback no longer passes `randomControl` on.
  const { bridge, player, received, prepare } = await factoryPlayer(context);
  player.setRandomControl({ sites: [] });
  prepare();
  await player.activate();
  const control = facade.heldRandom(bridge).control;
  assert.ok(control, "the connection holds the Player's control");
  assert.equal(received.recording?.randomControl, control, "the factory got that control");
});

test("a factory Start reads the click's clock, not a later one, while it runs (held until PR B)", async (context) => {
  // Its mutant: the activation no longer binds the click's sample while `begin` runs (`clicked`).
  const { player, received, prepare } = await factoryPlayer(context);
  let now = 1_000;
  context.mock.method(Date, "now", () => now);
  // The clock moves on while the factory runs; it still reads the click's.
  prepare(() => void (now = 5_000));
  await player.activate();
  assert.equal(received.wallClockMs, 1_000);
});
