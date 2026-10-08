import assert from "node:assert/strict";
import test from "node:test";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  capturedMediaReferencesInJson,
  keptSession,
  memoryKeptSessionStore,
  type StoredKeptSession,
} from "../player/kept-sessions.js";
import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeSession,
} from "../player/runtime-adapter.js";
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

test("a kept session read back from storage is used only when its events have the fields the Player reads", () => {
  // The events of a real session: a message, a button's answer with its settlement, and the end.
  let session = createPlayerRuntimeSession('say "Hello", instant\nshowButton "Next"\nexit');
  session = activatePlayerRuntimeButton(session)!.session;
  const real: Record<string, unknown>[] = JSON.parse(JSON.stringify(session.events));
  assert.deepEqual(
    real.map((event) => event["kind"]),
    ["say", "actionRequested", "playerTranscript", "actionCompleted", "exit"],
  );
  const kept = keptSession(stored({ events: real }));
  assert.equal(kept?.events.length, 5);

  const changed = (kind: string, change: (event: Record<string, unknown>) => void) => {
    const events: Record<string, unknown>[] = JSON.parse(JSON.stringify(real));
    change(events.find((event) => event["kind"] === kind)!);
    return stored({ events });
  };
  for (const malformed of [
    stored({ planJson: 1 }),
    stored({ snapshotJson: null }),
    stored({ marks: [] }),
    stored({ events: [null] }),
    stored({ events: [{ ...real[0], kind: "notAnEvent" }] }),
    stored({ events: [real[0], real[0]] }),
    changed("say", (event) => (event["content"] = { broken: true })),
    changed("say", (event) => (event["speaker"] = { identifier: "Mistress" })),
    changed("say", (event) => (event["presentation"] = null)),
    changed("say", (event) => delete event["span"]),
    changed(
      "actionCompleted",
      (event) =>
        (event["settlement"] = {
          ...JSON.parse(JSON.stringify(event["settlement"])),
          ui: { kind: "form" },
        }),
    ),
    changed("actionCompleted", (event) => (event["settlement"] = "settled")),
    changed("playerTranscript", (event) => (event["text"] = 1)),
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

test("a photo a kept session holds comes back as session media, which a save stores again", async () => {
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(repository, urls, "script");
  const shown = media.add("image", new Blob(["shown"], { type: "image/png" }));
  const record = await media.read(shown.reference);
  assert.deepEqual(
    [...capturedMediaReferencesInJson(JSON.stringify({ stage: shown.reference }))],
    [shown.reference],
  );

  const after = new CapturedMediaStore(repository, urls, "script");
  after.restoreSessionMedia(shown.reference, record);
  assert.equal((await after.read(shown.reference))?.size, 5);
  // Session media again: a save that references it stores it like a new capture.
  await after.promote([shown.reference]);
  assert.equal((await repository.get("script", shown.reference))?.size, 5);

  // Stored data that is not a valid record of this script's photo is ignored.
  const other = new CapturedMediaStore(null, urls, "script");
  other.restoreSessionMedia(shown.reference, { ...record!, namespace: "another" });
  other.restoreSessionMedia(shown.reference, { ...record!, size: "large" });
  assert.equal(await other.read(shown.reference), null);
});
