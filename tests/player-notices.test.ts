import assert from "node:assert/strict";
import test from "node:test";

import { PlayerNotices, playerNoticeKeys, playerNotices } from "../player/notices.js";

test("a repeated condition replaces its notice in place and dismissal removes it", () => {
  const notices = new PlayerNotices();
  const published: string[][] = [];
  const unsubscribe = notices.subscribe((current) =>
    published.push(current.map((notice) => notice.message)),
  );

  notices.publish(playerNotices.storageUnavailable());
  notices.publish({ key: "camera", level: "error", message: "Camera stopped." });
  notices.publish({ key: playerNoticeKeys.storageUnavailable, level: "info", message: "Again." });
  assert.deepEqual(
    notices.list.map(({ key, message }) => [key, message]),
    [
      [playerNoticeKeys.storageUnavailable, "Again."],
      ["camera", "Camera stopped."],
    ],
  );

  notices.dismiss("camera");
  notices.dismiss("camera");
  unsubscribe();
  notices.dismiss(playerNoticeKeys.storageUnavailable);
  assert.deepEqual(notices.list, []);
  // Dismissing an absent notice and changes after unsubscribing publish nothing.
  assert.deepEqual(published, [
    ["This browser does not keep saved progress, so the next run starts fresh."],
    ["This browser does not keep saved progress, so the next run starts fresh.", "Camera stopped."],
    ["Again.", "Camera stopped."],
    ["Again."],
  ]);
});

test("a notice action runs the producer's handler", () => {
  let retries = 0;
  const notices = new PlayerNotices();
  notices.publish(playerNotices.audioBlocked(() => (retries += 1)));
  const [notice] = notices.list;
  assert.equal(notice?.level, "warning");
  assert.equal(notice?.action?.label, "Enable audio");
  notice?.action?.run();
  assert.equal(retries, 1);
});

test("only a recovery notice the player must act on is not dismissible", () => {
  assert.equal(playerNotices.audioBlocked(() => {}).dismissible, false);
  assert.equal(playerNotices.storageUnavailable().dismissible, undefined);
  assert.equal(playerNotices.storageWriteFailed().dismissible, undefined);
});
