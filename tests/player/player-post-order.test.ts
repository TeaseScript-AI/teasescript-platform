import assert from "node:assert/strict";
import test, { before } from "node:test";
import { DRIVERS, loadDrivers, type PostEntry } from "../helpers/player/post-order-drivers.js";

/*
 * The production post order of a Start and a Continue (L5i.7, O1): every request the real composable posts, in order,
 * on the in-process host. Against the order before L5i.7, these drivers differed only by the lock preload's
 * `planMetadata`.
 */

before(loadDrivers);

const text = (posts: readonly PostEntry[]) =>
  posts.map(([op, session]) => (session === null ? op : `${op}@${session}`));

test("a hosted script's Start posts its preparation, its start, the lock preload's metadata read, then its keep", async (context) => {
  assert.deepEqual(text(await DRIVERS["hosted Start, Debug off"](context)), [
    "prepare",
    "preparePlanText",
    "start",
    "planMetadata",
    "captureKeep",
  ]);
});

test("with Debug on, a hosted script's Start also renews the history around it and reads the plan's metadata for Debug's random control first", async (context) => {
  assert.deepEqual(text(await DRIVERS["hosted Start, Debug on"](context)), [
    "debugTracing",
    "historyRenew",
    "prepare",
    "historyClose",
    "preparePlanText",
    "start",
    "historyRenew",
    "planMetadata",
    "planMetadata",
    "captureKeep",
  ]);
});

test("Continue of a kept session restores it, records it, continues it, then reads its plan's metadata and keeps it", async (context) => {
  assert.deepEqual(text(await DRIVERS["Continue of a kept session"](context)), [
    "prepare",
    "preparePlanText",
    "restoreKept",
    "beginRecording@s1",
    "continue@s1",
    "planMetadata",
    "captureKeep",
  ]);
});
