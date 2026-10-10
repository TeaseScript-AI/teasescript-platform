import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, shallowRef, type ComputedRef, type Ref } from "vue";

import { PlayerNotices, playerNotices, type PlayerNotice } from "../player/notices.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

interface Notification {
  readonly notice: PlayerNotice;
  readonly sequence: number;
}
interface Notifications {
  notifications: ComputedRef<readonly Notification[]>;
  seenSequence: ComputedRef<number>;
  attentionCount: ComputedRef<number>;
  markSeen(): void;
}
interface ToastSink {
  show(id: string, notice: PlayerNotice): void;
  dismiss(id: string): void;
}
let usePlayerNotifications: (notices: Readonly<Ref<readonly PlayerNotice[]>>) => Notifications;
let usePlayerToasts: (
  notifications: Readonly<Ref<readonly Notification[]>>,
  seenSequence: Readonly<Ref<number>>,
  sink: ToastSink,
) => void;

// Load the real Vue composables through the existing build tool, like the Player session host tests.
before(async () => {
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerNotifications.ts",
  );
  const toasts: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerToasts.ts",
  );
  assert.equal(typeof module.usePlayerNotifications, "function");
  assert.equal(typeof toasts.usePlayerToasts, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
  usePlayerNotifications = module.usePlayerNotifications as typeof usePlayerNotifications;
  // EVIDENCE: validation: the toast export was checked callable just above, from the same real source build.
  usePlayerToasts = toasts.usePlayerToasts as typeof usePlayerToasts;
});

function setup(context: TestContext) {
  const channel = new PlayerNotices();
  const list = shallowRef<readonly PlayerNotice[]>([]);
  channel.subscribe((current) => (list.value = current));
  const scope = effectScope();
  context.after(() => scope.stop());
  // The toasts a player sees, in stack order with the newest in front, by toast id.
  const toasts: { id: string; notice: PlayerNotice }[] = [];
  const notifications = scope.run(() => {
    const result = usePlayerNotifications(list);
    usePlayerToasts(result.notifications, result.seenSequence, {
      show: (id, notice) => toasts.unshift({ id, notice }),
      dismiss: (id) =>
        toasts.splice(0, toasts.length, ...toasts.filter((toast) => toast.id !== id)),
    });
    return result;
  })!;
  const keys = () => notifications.notifications.value.map((entry) => entry.notice.key);
  return { channel, notifications, keys, toasts };
}

// Lets watchers and the one-render-apart toast queue run.
async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await nextTick();
}

test("seeing the panel clears attention except for a notice the player must act on", async (context) => {
  const { channel, notifications } = setup(context);
  channel.publish(playerNotices.storageWriteFailed());
  channel.publish(playerNotices.audioBlocked(() => {}));
  await nextTick();
  assert.equal(notifications.attentionCount.value, 2);
  notifications.markSeen();
  assert.equal(notifications.attentionCount.value, 1);
});

test("publications in one tick are listed newest first", async (context) => {
  const { channel, keys } = setup(context);
  for (const key of ["a", "b", "c", "d"]) channel.publish({ key, level: "info", message: key });
  // Replacing the oldest notice publishes it again, so it is the newest, as is its toast.
  channel.publish({ key: "a", level: "error", message: "a again" });
  await nextTick();
  assert.deepEqual(keys(), ["a", "d", "c", "b"]);
});

test("a replaced notice shows in front with its current level and action", async (context) => {
  const { channel, toasts } = setup(context);
  channel.publish({
    key: "a",
    level: "info",
    message: "A",
    action: { label: "Act", run: () => {} },
  });
  channel.publish({ key: "b", level: "info", message: "B" });
  channel.publish({ key: "c", level: "info", message: "C" });
  channel.publish({ key: "d", level: "info", message: "D" });
  await settle();
  channel.publish({ key: "a", level: "error", message: "A failed" });
  await settle();
  assert.deepEqual(
    toasts.map(({ notice }) => [notice.key, notice.level, notice.action?.label]),
    [
      ["a", "error", undefined],
      ["d", "info", undefined],
      ["c", "info", undefined],
      ["b", "info", undefined],
    ],
  );
});

test("retiring an old toast never removes a newer publication of its notice", async (context) => {
  const { channel, notifications, toasts } = setup(context);
  channel.publish({ key: "a", level: "info", message: "A" });
  await settle();
  channel.dismiss("a");
  await nextTick();
  channel.publish({ key: "a", level: "info", message: "A again" });
  await settle();
  assert.deepEqual(
    toasts.map(({ notice }) => notice.message),
    ["A again"],
  );
  // Seeing the panel retires the toasts; a replacement published right after still shows.
  notifications.markSeen();
  channel.publish({ key: "a", level: "warning", message: "A replaced" });
  await settle();
  assert.deepEqual(
    toasts.map(({ notice }) => notice.message),
    ["A replaced"],
  );
});

test("a publication withdrawn or seen before its toast mounts never shows", async (context) => {
  const { channel, notifications, toasts } = setup(context);
  channel.publish({ key: "a", level: "info", message: "A" });
  channel.publish({ key: "b", level: "info", message: "B" });
  await nextTick();
  channel.dismiss("a");
  notifications.markSeen();
  await settle();
  assert.deepEqual(toasts, []);
});
