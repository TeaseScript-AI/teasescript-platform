import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import type * as InProcess from "../player/engine-bridge/in-process.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import type { PlayerRuntimeSession } from "../player/runtime-adapter.js";
import type { PlayerSession } from "../player/runtime-view.js";
import type { StartOptions } from "../player/engine-bridge/ops/session.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

/*
 * What the browser allows only within the player's click runs within it, also when the session shows only once the
 * engine's host replied (a Start of a held plan, a Continue) or the camera answered: the audio unlock's `play()`, the
 * camera's `getUserMedia`, and the screen wake lock's request. The host here replies only after 250 ms, so each check
 * fails if that work waits for a reply.
 */

interface GestureHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  prepare(create: { readonly plan: string; readonly options: () => StartOptions }): void;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly capabilities?: { readonly camera: boolean };
}) => GestureHost;
let createInProcessBackend: typeof InProcess.createInProcessBackend;

before(async () => {
  const module = await loadPlayerModule("player/vue/src/usePlayerSession.ts");
  const facade = await loadPlayerModule("player/engine-bridge/in-process.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  assert.equal(typeof facade.createInProcessBackend, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: checked as a function above, from the bundle the composable runs in.
  createInProcessBackend = facade.createInProcessBackend as typeof createInProcessBackend;
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const SCRIPT = 'say "Stare at the screen.", instant\nwait 10 s\nexit';

/** The browser surface of a Start: audio elements, a screen wake lock and a camera, each counting its calls. */
function stubBrowser(context: TestContext) {
  const calls = { play: 0, wakeLock: 0, getUserMedia: 0 };
  const values = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    navigator: {
      wakeLock: {
        request: () => {
          calls.wakeLock += 1;
          return new Promise(() => {});
        },
      },
      mediaDevices: Object.assign(new EventTarget(), {
        getUserMedia: () => {
          calls.getUserMedia += 1;
          return new Promise(() => {});
        },
      }),
    },
    Audio: class {
      src = "";
      play = () => {
        calls.play += 1;
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

/** A Player whose engine host replies only after 250 ms. */
async function mountSlow(context: TestContext, camera = false) {
  const bridge = createInProcessBackend(BUILD, { delayMs: 250 });
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
  const { host, bridge } = await mountSlow(context);
  const plan = compilePlayerProject(SCRIPT).plan!;
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const prepared = reply.result as PrepareResult;
  assert.equal(prepared.kind, "prepared");
  host.prepare({ plan: prepared.kind === "prepared" ? prepared.plan : "", options: () => ({}) });
  const activating = host.activate();
  assert.ok(calls.play > 0, "the audio unlock played within the click");
  await clickMicrotasks();
  assert.equal(host.session.value, null, "the host has not replied yet");
  assert.equal(calls.wakeLock, 1, "the wake lock was asked for within the click");
  await activating;
  assert.equal(shown(host)?.state.status, "waiting");
});

test("a Continue unlocks audio and keeps the screen on within the click, before the host replies", async (context) => {
  const calls = stubBrowser(context);
  const { host } = await mountSlow(context);
  host.prepareRestore(createPlayerRuntimeSession(SCRIPT));
  const activating = host.activate();
  assert.ok(calls.play > 0, "the audio unlock played within the click");
  await clickMicrotasks();
  assert.equal(host.session.value, null, "the host has not replied yet");
  assert.equal(calls.wakeLock, 1, "the wake lock was asked for within the click");
  await activating;
  assert.notEqual(shown(host), null);
});

test("a Start with the camera asks for it within the click, before any reply", async (context) => {
  const calls = stubBrowser(context);
  const { host } = await mountSlow(context, true);
  host.prepare({ plan: "unused", options: () => ({}) });
  void host.activate();
  assert.equal(calls.getUserMedia, 1, "the camera was asked for within the click");
  assert.ok(calls.play > 0, "the audio unlock played within the click");
});
