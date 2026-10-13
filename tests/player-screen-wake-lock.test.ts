import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import type * as RuntimeAdapter from "../player/runtime-adapter.js";
import type { PlayerRuntimeSession } from "../player/runtime-adapter.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

// The Player keeps the screen on while a session plays (PLAYER-UI "Session start and user activation"): from the Start
// click until the script exits, ends with an error, or a Player error stops it. These tests fake the browser's screen
// wake lock, which releases every held lock when the page is hidden, as browsers do.
interface WakeLockHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  prepare(create: () => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  toStartPage(): Promise<void>;
  reportHostError(error: unknown): void;
}
let usePlayerSession: (options: { capabilities: { camera: boolean } }) => WakeLockHost;
let useDevelopmentTime: (
  player: WakeLockHost,
  initial: { readonly autoSkip: boolean },
  log: (text: string) => void,
) => { advanceBy(milliseconds: number): Promise<void> };
// The runtime adapter the composables load, so that the sessions the tests make come from the same module.
let runtime: typeof RuntimeAdapter;

before(async () => {
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerSession.ts",
  );
  const time: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/useDevelopmentTime.ts",
  );
  const adapter: Record<string, unknown> = await loadPlayerModule("player/runtime-adapter.ts");
  assert.equal(typeof session.usePlayerSession, "function");
  assert.equal(typeof time.useDevelopmentTime, "function");
  assert.equal(typeof adapter.createPlayerRuntimeSession, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and each export is callable; these are their host APIs.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: checked as a function above.
  useDevelopmentTime = time.useDevelopmentTime as typeof useDevelopmentTime;
  // EVIDENCE: validation: the source module the compiled one is built from; checked by one export above.
  runtime = adapter as typeof runtime;
});

class FakeSentinel extends EventTarget {
  readonly type = "screen";
  released = false;
  async release() {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

/**
 * The browser surface a session uses, with a screen wake lock that grants each request (`granting`), refuses it
 * (`refusing`), answers when the test says so (`answering`), or is missing. The camera answers when the test grants it.
 */
function stubBrowser(
  context: TestContext,
  wakeLock: "granting" | "refusing" | "answering" | "missing",
) {
  const page: { visibilityState: "visible" | "hidden" } = { visibilityState: "visible" };
  const document = Object.assign(new EventTarget(), page);
  const sentinels: FakeSentinel[] = [];
  const answers: ((granted: boolean) => void)[] = [];
  let requests = 0;
  const request = (type: string): Promise<FakeSentinel> => {
    assert.equal(type, "screen");
    requests++;
    const grant = () => {
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    };
    const refusal = () => new DOMException("The wake lock was not granted.", "NotAllowedError");
    if (wakeLock === "refusing") return Promise.reject(refusal());
    if (wakeLock === "granting") return Promise.resolve(grant());
    return new Promise((resolve, reject) =>
      answers.push((granted) => (granted ? resolve(grant()) : reject(refusal()))),
    );
  };
  let grantCamera!: () => void;
  const cameraGranted = new Promise<void>((resolve) => (grantCamera = resolve));
  const values = {
    document,
    window: new EventTarget(),
    navigator: {
      ...(wakeLock === "missing" ? {} : { wakeLock: { request } }),
      mediaDevices: {
        getUserMedia: async () => {
          await cameraGranted;
          const track = Object.assign(new EventTarget(), {
            kind: "video",
            label: "fake camera",
            readyState: "live",
            stop() {},
          });
          return { getTracks: () => [track] };
        },
      },
    },
    Audio: class {
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
  const setVisibility = (state: "visible" | "hidden") => {
    document.visibilityState = state;
    // The browser releases a held screen wake lock when the page is hidden.
    if (state === "hidden") for (const sentinel of sentinels) void sentinel.release();
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return {
    requests: () => requests,
    held: () => sentinels.filter((sentinel) => !sentinel.released).length,
    hide: () => setVisibility("hidden"),
    show: () => setVisibility("visible"),
    /** Answers the oldest request still waiting for an answer. */
    answer: (granted: boolean) => answers.shift()!(granted),
    grantCamera,
  };
}

function mount<T>(context: TestContext, create: () => T): T {
  const scope = effectScope();
  const made = scope.run(create);
  assert.ok(made);
  context.after(() => scope.stop());
  return made;
}

function mountPlayer(context: TestContext, camera = false) {
  return mount(context, () => {
    const host = usePlayerSession({ capabilities: { camera } });
    return { host, time: useDevelopmentTime(host, { autoSkip: false }, () => {}) };
  });
}

// Lets the requests and releases the Player started settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const status = (host: WakeLockHost) => host.session.value?.state.status;
const waitThenExit = 'say "Stare at the screen.", instant\nwait 10 s\nexit';

test("the screen stays on from Start until the script exits, and again once the hidden page is shown", async (context) => {
  const browser = stubBrowser(context, "granting");
  const { host, time } = mountPlayer(context);
  host.prepare(() => runtime.createPlayerRuntimeSession(waitThenExit));
  await settle();
  assert.equal(browser.requests(), 0, "the start page keeps no lock");

  await host.activate();
  await settle();
  assert.equal(status(host), "waiting");
  assert.deepEqual([browser.requests(), browser.held()], [1, 1]);

  // A hidden page loses the lock and asks for none; shown again while the session plays, it asks again.
  browser.hide();
  await settle();
  assert.deepEqual([browser.requests(), browser.held()], [1, 0]);
  browser.show();
  await settle();
  assert.deepEqual([browser.requests(), browser.held()], [2, 1]);

  // `exit` ends the session: the end dialog and the review run without the lock.
  await time.advanceBy(10_000);
  await settle();
  assert.equal(status(host), "halted");
  assert.equal(browser.held(), 0);
  browser.hide();
  browser.show();
  await settle();
  assert.equal(browser.requests(), 2, "an ended session asks for no lock");

  // Closing the end dialog returns to the start page without one; its Start asks again.
  await host.toStartPage();
  await settle();
  assert.equal(host.session.value, null);
  assert.deepEqual([browser.requests(), browser.held()], [2, 0]);
  await host.activate();
  await settle();
  assert.deepEqual([browser.requests(), browser.held()], [3, 1]);
});

test("a script error and a Player error release the lock", async (context) => {
  const browser = stubBrowser(context, "granting");
  const { host, time } = mountPlayer(context);
  host.prepare(() =>
    runtime.createPlayerRuntimeSession('let zero = 0\nwait 10 s\nsay "${1 / zero}"\nexit'),
  );
  await host.activate();
  await settle();
  assert.equal(browser.held(), 1);
  await time.advanceBy(10_000);
  await settle();
  assert.equal(status(host), "failed");
  assert.equal(browser.held(), 0);

  host.prepare(() => runtime.createPlayerRuntimeSession(waitThenExit));
  await host.activate();
  await settle();
  assert.deepEqual([browser.requests(), browser.held()], [2, 1]);
  // The Player logs the error, which the test does not show.
  context.mock.method(console, "error", () => {});
  host.reportHostError(new TypeError("A component failed."));
  await settle();
  assert.equal(host.stopped.value, true);
  assert.equal(status(host), "waiting", "the stopped session stands where it was");
  assert.equal(browser.held(), 0);
  browser.hide();
  browser.show();
  await settle();
  assert.equal(browser.requests(), 2, "a stopped session asks for no lock");
});

test("the lock is asked for at the Start click, before the camera opens", async (context) => {
  // Safari grants the first lock of a page only right after the player's click, which a camera prompt can outlast.
  const browser = stubBrowser(context, "granting");
  const { host } = mountPlayer(context, true);
  host.prepare(() => runtime.createPlayerRuntimeSession(waitThenExit));
  const activating = host.activate();
  await settle();
  assert.equal(host.session.value, null, "the camera has not answered yet");
  assert.deepEqual([browser.requests(), browser.held()], [1, 1]);
  browser.grantCamera();
  await activating;
  await settle();
  assert.equal(status(host), "waiting");
  assert.deepEqual([browser.requests(), browser.held()], [1, 1], "the session keeps that lock");
});

test("without a wake lock, or when the browser refuses it, the session plays as before", async (context) => {
  for (const wakeLock of ["missing", "refusing"] as const) {
    await context.test(wakeLock, async (context) => {
      const browser = stubBrowser(context, wakeLock);
      const { host, time } = mountPlayer(context);
      host.prepare(() => runtime.createPlayerRuntimeSession(waitThenExit));
      await host.activate();
      await settle();
      assert.equal(status(host), "waiting");
      assert.equal(host.session.value?.transcriptEntries[0]?.text, "Stare at the screen.");
      // A refused lock is asked for again only when the page is shown again, not in a loop.
      browser.hide();
      browser.show();
      await settle();
      assert.equal(browser.requests(), wakeLock === "missing" ? 0 : 2);
      await time.advanceBy(10_000);
      assert.equal(status(host), "halted");
      assert.equal(browser.held(), 0);
    });
  }
});

test("a request under way when the page was hidden and shown is made again, and one granted after the end is released", async (context) => {
  const browser = stubBrowser(context, "answering");
  const { host, time } = mountPlayer(context);
  host.prepare(() => runtime.createPlayerRuntimeSession(waitThenExit));
  await host.activate();
  await settle();
  assert.equal(browser.requests(), 1);
  // The page is hidden and shown while the first request waits; the browser refuses it, as the page was hidden.
  browser.hide();
  browser.show();
  await settle();
  assert.equal(browser.requests(), 1, "one request at a time");
  browser.answer(false);
  await settle();
  assert.equal(browser.requests(), 2, "asked again for the page shown meanwhile");

  // The session ends before the browser grants that request: the late lock is released at once.
  await time.advanceBy(10_000);
  assert.equal(status(host), "halted");
  browser.answer(true);
  await settle();
  assert.deepEqual([browser.requests(), browser.held()], [2, 0]);
});
