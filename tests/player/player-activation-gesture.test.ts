import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import type * as InProcess from "../helpers/bridge/in-process.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { sourceStart, type PlanStart } from "../helpers/prepared-plan.js";
import { hostIntroduced, loadHostFacade } from "../helpers/player/host-sessions.js";
import { inProcessBackend } from "../helpers/player/worker-topology.js";

/*
 * What the browser allows only within the player's click runs within it, also when the session shows only once the
 * engine's host replied (a Start of a held plan, a Continue) or the camera answered: the audio unlock's `play()`, the
 * camera's `getUserMedia`, and the screen wake lock's request. Each runs synchronously in the click, before the
 * activation's first bridge request; the host here also replies only after 250 ms.
 */

interface GestureHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  prepare(create: PlanStart): void;
  prepareRestore(restored: PlayerSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  readonly bridge?: Promise<PlayerBridge>;
  readonly capabilities?: { readonly camera: boolean };
}) => GestureHost;
let createInProcessBackend: typeof InProcess.createInProcessBackend;
let heldRecording: typeof InProcess.heldRecording;

before(async () => {
  await loadHostFacade();
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  const facade = await loadPlayerModule("tests/helpers/bridge/in-process.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  assert.equal(typeof facade.createInProcessBackend, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: checked as a function above, from the bundle the composable runs in.
  createInProcessBackend = facade.createInProcessBackend as typeof createInProcessBackend;
  assert.equal(typeof facade.heldRecording, "function");
  // EVIDENCE: validation: checked as a function above, from the bundle the composable runs in.
  heldRecording = facade.heldRecording as typeof heldRecording;
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const SCRIPT = 'say "Stare at the screen.", instant\nwait 10 s\nexit';

/** The browser surface of a Start: audio elements, a screen wake lock and a camera, each counting its calls. */
function stubBrowser(context: TestContext) {
  const order: string[] = [];
  const calls = { play: 0, wakeLock: 0, getUserMedia: 0, order };
  const values = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    navigator: {
      wakeLock: {
        request: () => {
          calls.wakeLock += 1;
          calls.order.push("wakeLock");
          return new Promise(() => {});
        },
      },
      mediaDevices: Object.assign(new EventTarget(), {
        getUserMedia: () => {
          calls.getUserMedia += 1;
          calls.order.push("getUserMedia");
          return new Promise(() => {});
        },
      }),
    },
    Audio: class {
      src = "";
      play = () => {
        calls.play += 1;
        calls.order.push("play");
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

/** A Player whose engine host replies only after 250 ms; each bridge request it posts goes into `order`. */
async function mountSlow(context: TestContext, order: string[], camera = false) {
  const bridge = createInProcessBackend(BUILD, { delayMs: 250 });
  const request = bridge.client.request;
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    order.push(args[0]);
    return request(...args);
  });
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ bridge: Promise.resolve(bridge), capabilities: { camera } }),
  )!;
  context.after(() => scope.stop());
  // The injected bridge is the host's after a turn.
  await new Promise((resolve) => setImmediate(resolve));
  return { host, bridge };
}

/** The session `host` shows now, read afresh (an assertion before does not narrow it). */
const shown = (host: GestureHost) => host.session.value;

/** The microtasks of the click's own task, before any reply of the host can arrive. */
async function clickMicrotasks() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

test("a Start of a held plan unlocks audio and keeps the screen on within the click, before the host replies", async (context) => {
  const calls = stubBrowser(context);
  const { host, bridge } = await mountSlow(context, calls.order);
  const plan = compilePlayerProject(SCRIPT).plan!;
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const prepared = reply.result as PrepareResult;
  assert.equal(prepared.kind, "prepared");
  host.prepare({ plan: prepared.kind === "prepared" ? prepared.plan : "", options: () => ({}) });
  calls.order.length = 0;
  const activating = host.activate();
  assert.deepEqual(
    calls.order.filter((call, index, all) => call !== all[index - 1]),
    ["play", "wakeLock", "start"],
    "the audio unlock, then the wake lock, then the Start's request, all within the click",
  );
  await clickMicrotasks();
  assert.equal(host.session.value, null, "the host has not replied yet");
  await activating;
  assert.equal(shown(host)?.state.status, "waiting");
});

test("a Continue unlocks audio and keeps the screen on within the click, before the host replies", async (context) => {
  const calls = stubBrowser(context);
  const { host, bridge } = await mountSlow(context, calls.order);
  host.prepareRestore(hostIntroduced(bridge, createPlayerRuntimeSession(SCRIPT)));
  const activating = host.activate();
  assert.deepEqual(
    calls.order.filter((call, index, all) => call !== all[index - 1]),
    ["play", "wakeLock", "beginRecording"],
    "the audio unlock, then the wake lock, then the Continue's first request, all within the click",
  );
  await clickMicrotasks();
  assert.equal(host.session.value, null, "the host has not replied yet");
  await activating;
  assert.notEqual(shown(host), null);
});

test("a Start with the camera asks for it within the click, before any reply", async (context) => {
  const calls = stubBrowser(context);
  const { host } = await mountSlow(context, calls.order, true);
  host.prepare({ plan: "unused", options: () => ({}) });
  void host.activate();
  assert.equal(calls.getUserMedia, 1, "the camera was asked for within the click");
  assert.ok(calls.play > 0, "the audio unlock played within the click");
});

test("a Continue a new Start replaced cannot take over the recording, even from behind an async prepare", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({ bridge: inProcessBackend() }))!;
  context.after(() => scope.stop());
  const bridge = await host.bridge;
  host.prepareRestore(
    hostIntroduced(bridge, createPlayerRuntimeSession('say "restored", instant\nwait 10 s\nexit')),
  );
  // The replacement's plan, prepared first: preparing it inside the window would let the Continue's request run.
  const replacement = await sourceStart(host.bridge, 'say "new", instant\nwait 10 s\nexit');
  // The host awaits a source prepare, so the Continue's first request waits behind it.
  const compiling = bridge.client.request("prepare", {
    source: { kind: "source", script: 'say "x"\nexit' },
  });
  const continuing = host.activate();
  // A new Start replaces the Continue while its request still waits: its recording has not begun.
  assert.equal(heldRecording(bridge), null, "the Continue's recording waits behind the prepare");
  host.prepare(replacement);
  await host.activate();
  await compiling;
  await continuing;
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    shown(host)?.transcriptEntries.map((entry) => entry.text),
    ["new"],
    "the new session shows",
  );
  // The recording is the new session's: its plan is the new script's, not the restored one's.
  const recording = heldRecording(bridge);
  assert.ok(recording);
  const plan = JSON.stringify(recording.plan);
  assert.equal(plan.includes("restored"), false, "the obsolete Continue took over the recording");
  assert.equal(plan.includes("new"), true);
});
