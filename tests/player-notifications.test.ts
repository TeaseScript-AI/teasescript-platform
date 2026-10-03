import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, shallowRef, type ComputedRef, type Ref } from "vue";
import { createServer } from "vite";

import { PlayerNotices, playerNotices, type PlayerNotice } from "../player/notices.js";

interface Notifications {
  toasts: ComputedRef<readonly { readonly notice: PlayerNotice }[]>;
  attentionCount: ComputedRef<number>;
  holdToasts(hold: boolean): void;
  markSeen(): void;
}
let usePlayerNotifications: (notices: Readonly<Ref<readonly PlayerNotice[]>>) => Notifications;

// Load the real Vue composable through the existing build tool, like the Player session host tests.
before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    // No HMR websocket: parallel test runs must not compete for its default port.
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const module: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerNotifications.ts",
    );
    assert.equal(typeof module.usePlayerNotifications, "function");
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested API.
    usePlayerNotifications = module.usePlayerNotifications as typeof usePlayerNotifications;
  } finally {
    await server.close();
  }
});

function setup(context: TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const channel = new PlayerNotices();
  const list = shallowRef<readonly PlayerNotice[]>([]);
  channel.subscribe((current) => (list.value = current));
  const scope = effectScope();
  context.after(() => scope.stop());
  const notifications = scope.run(() => usePlayerNotifications(list))!;
  const toastKeys = () => notifications.toasts.value.map((entry) => entry.notice.key);
  return { channel, notifications, toastKeys };
}

test("a held toast does not expire, and a republished notice toasts again", async (context) => {
  const { channel, notifications, toastKeys } = setup(context);
  channel.publish(playerNotices.storageUnavailable());
  await nextTick();
  notifications.holdToasts(true);
  context.mock.timers.tick(60_000);
  assert.deepEqual(toastKeys(), ["storage-unavailable"]);

  // Releasing restarts the full duration.
  notifications.holdToasts(false);
  context.mock.timers.tick(4_999);
  assert.deepEqual(toastKeys(), ["storage-unavailable"]);
  context.mock.timers.tick(1);
  assert.deepEqual(toastKeys(), []);

  // The notice itself stays until withdrawn; publishing its condition again shows a new toast.
  channel.publish(playerNotices.storageUnavailable());
  await nextTick();
  assert.deepEqual(toastKeys(), ["storage-unavailable"]);
  channel.dismiss("storage-unavailable");
  await nextTick();
  assert.deepEqual(toastKeys(), []);
});

test("seeing the panel clears attention except for a notice the player must act on", async (context) => {
  const { channel, notifications } = setup(context);
  channel.publish(playerNotices.storageWriteFailed());
  channel.publish(playerNotices.audioBlocked(() => {}));
  await nextTick();
  assert.equal(notifications.attentionCount.value, 2);
  notifications.markSeen();
  assert.equal(notifications.attentionCount.value, 1);
  assert.deepEqual(notifications.toasts.value, []);
});

test("publications in one tick toast in publication order", (context) => {
  const { channel, toastKeys } = setup(context);
  for (const key of ["a", "b", "c", "d"]) channel.publish({ key, level: "info", message: key });
  // Replacing the oldest notice publishes it again, so it is the newest toast.
  channel.publish({ key: "a", level: "error", message: "a again" });
  assert.deepEqual(toastKeys(), ["a", "d", "c"]);
});
