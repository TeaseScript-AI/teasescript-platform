import assert from "node:assert/strict";
import test from "node:test";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  capturedMediaReferencesInJson,
  keptSession,
  memoryKeptSessionStore,
  type StoredKeptSession,
} from "../player/kept-sessions.js";
import type { InterpreterEvent } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

// The session the Player keeps for a script (PLAYER-UI "Session start and user activation"): what is read back from
// browser storage is checked before a session is restored from it, the store keeps one session per scope with its
// photos, and the photos only a session holds go with it and come back as session media.
const urls = { create: (data: Blob) => `blob:${data.size}`, revoke: () => {} };
const events = (...kinds: string[]): InterpreterEvent[] =>
  JSON.parse(JSON.stringify(kinds.map((kind, index) => ({ kind, sequence: index + 1 }))));
const marks = { editedWhileDebugging: null, rewoundWhileDebugging: null };
const stored = (overrides: Partial<StoredKeptSession> = {}): StoredKeptSession => ({
  planJson: "{}",
  snapshotJson: "{}",
  events: events("say", "actionRequested"),
  marks,
  ...overrides,
});

test("a kept session read back from storage is used only when its fields and events have their shape", () => {
  assert.deepEqual(keptSession(stored()), {
    planJson: "{}",
    snapshotJson: "{}",
    events: events("say", "actionRequested"),
    marks,
  });
  for (const malformed of [
    stored({ planJson: 1 }),
    stored({ snapshotJson: null }),
    stored({ marks: [] }),
    stored({ events: [null] }),
    stored({ events: events("notAnEvent") }),
    stored({
      events: [
        { kind: "say", sequence: 2 },
        { kind: "say", sequence: 2 },
      ],
    }),
    stored({ events: [{ kind: "say", sequence: 1.5 }] }),
  ])
    assert.equal(keptSession(malformed), null, JSON.stringify(malformed));
});

test("the store keeps one session per scope, extends it from a position, and discards it with its photos", async () => {
  const store = memoryKeptSessionStore();
  assert.equal(await store.session("script"), null);
  await assert.rejects(
    store.publish("script", {
      planJson: null,
      snapshotJson: "1",
      eventsFrom: 0,
      events: [],
      marks,
    }),
    /no plan/,
  );
  await store.publish("script", {
    planJson: "plan",
    snapshotJson: "1",
    eventsFrom: 0,
    events: events("say", "actionRequested"),
    marks,
  });
  // A later state keeps the plan and the events before its position.
  await store.publish("script", {
    planJson: null,
    snapshotJson: "2",
    eventsFrom: 1,
    events: events("say", "say"),
    marks,
  });
  const kept = await store.session("script");
  assert.equal(kept?.planJson, "plan");
  assert.equal(kept?.snapshotJson, "2");
  assert.deepEqual(
    kept?.events.map((event) => JSON.stringify(event)),
    [...events("say"), ...events("say", "say")].map((event) => JSON.stringify(event)),
  );
  await assert.rejects(
    store.publish("script", {
      planJson: null,
      snapshotJson: "3",
      eventsFrom: 9,
      events: [],
      marks,
    }),
    /gap/,
  );

  const photo = new CapturedMediaStore(null, urls, "script").add(
    "image",
    new Blob(["png"], { type: "image/png" }),
  );
  await store.media.add({
    ...photo,
    namespace: "script",
    data: new Blob(["png"], { type: "image/png" }),
  });
  assert.deepEqual(await store.media.listReferences("script"), [photo.reference]);
  await store.discard("script");
  assert.equal(await store.session("script"), null);
  assert.deepEqual(await store.media.listReferences("script"), []);
});

test("a photo only the session holds goes with it, and comes back as session media a save stores again", async () => {
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(repository, urls, "script");
  const shown = media.add("image", new Blob(["shown"], { type: "image/png" }));
  const saved = media.add("image", new Blob(["saved"], { type: "image/png" }));
  await media.promote([saved.reference]);
  const state = JSON.stringify({ stage: shown.reference, variables: { photo: saved.reference } });
  const references = capturedMediaReferencesInJson(state);
  assert.deepEqual([...references], [shown.reference, saved.reference]);
  // The photo a save stored stays where it is; only the other one is kept with the session.
  const kept = media.sessionRecords(references);
  assert.deepEqual(
    kept.map((record) => record.reference),
    [shown.reference],
  );

  const after = new CapturedMediaStore(repository, urls, "script");
  after.restoreSessionMedia(shown.reference, kept[0]!);
  assert.equal((await after.read(shown.reference))?.size, 5);
  // Session media again: a save that references it stores it like a new capture.
  await after.promote([shown.reference]);
  assert.equal((await repository.get("script", shown.reference))?.size, 5);

  // Stored data that is not a valid record of this script's photo is ignored.
  const other = new CapturedMediaStore(null, urls, "script");
  other.restoreSessionMedia(shown.reference, { ...kept[0]!, namespace: "another" });
  other.restoreSessionMedia(saved.reference, { ...kept[0]!, size: "large" });
  assert.equal(await other.read(shown.reference), null);
  assert.equal(await other.read(saved.reference), null);
});
