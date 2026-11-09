// The runtime adapter's host actions (split from `player-runtime-adapter.test.ts`): media reports, the camera, image
// requests and storage writes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  activatePlayerRuntimeButton,
  answerPlayerRuntimeCapture,
  answerPlayerRuntimeImage,
  completePlayerRuntimeStorageWrite,
  createPlayerRuntimeRestorePoint,
  observePlayerRuntimeTime,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  skipPlayerRuntimeImage,
  submitPlayerRuntimeComposer,
  playerRuntimeSnapshot,
  type PlayerRuntimeSession,
} from "../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../player/runtime/compile-project.js";
import {
  activePlayerRuntimeCapture,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimeMedia,
} from "../player/runtime/runtime-view.js";

test("runtime adapter forwards media reports, projects a live seek, and restores pending samples", () => {
  let session = createPlayerRuntimeSession(
    [
      'showImage "images/room.jpg"',
      'let music = playAudio async "music.mp3" {',
      "  at 1 s {",
      "    music.position = 3 s",
      "  }",
      "}",
      "wait 10 s",
      'say "done ${music.position} ${music.elapsed}", instant',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(playerRuntimeMedia(session.state).stage, {
    image: "images/room.jpg",
    videoMediaId: null,
  });
  assert.equal(playerRuntimeMedia(session.state).media[0]?.loaded, false);
  const loaded = reportPlayerRuntimeMediaLoad(session, 1, { kind: "loaded", durationMs: 10_000 });
  assert.equal(loaded.outcome.kind, "accepted");
  session = observePlayerRuntimeTime(loaded.session, 1_500, [
    { mediaId: 1, segment: 1, progressMs: 1_500 },
  ]).session;
  // The cue at 1 s seeked to 3 s: a new segment starts there.
  let [media] = playerRuntimeMedia(session.state).media;
  assert.deepEqual(
    { segment: media?.segment, playheadMs: media?.playheadMs, reported: media?.reportedProgressMs },
    { segment: 2, playheadMs: 3_000, reported: 0 },
  );
  session = observePlayerRuntimeTime(session, 2_000, [
    { mediaId: 1, segment: 2, progressMs: 500 },
  ]).session;
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimeMedia(restored.state), playerRuntimeMedia(session.state));
  [media] = playerRuntimeMedia(restored.state).media;
  assert.deepEqual(
    { playheadMs: media?.playheadMs, reported: media?.reportedProgressMs },
    { playheadMs: 3_500, reported: 500 },
  );
  const finished = observePlayerRuntimeTime(restored, 10_000, [
    { mediaId: 1, segment: 2, progressMs: 8_500 },
  ]).session;
  assert.equal(finished.state.status, "halted");
  const last = finished.transcriptEntries.at(-1);
  assert.equal(last?.kind === "message" ? last.text : undefined, "done 10 seconds 8 seconds");
});

test("the Player answers takePhoto() with a vouched reference or an unavailable camera", () => {
  const session = createPlayerRuntimeSession(
    "let photo = takePhoto()\nshowImage photo\nlet second = takePhoto()\nexit",
  );
  const pending = activePlayerRuntimeCapture(session.state);
  assert.ok(pending !== null);
  const reference = "captured-media:session:1";
  const unvouched = answerPlayerRuntimeCapture(session, pending.actionId, {
    kind: "captured",
    reference,
  });
  assert.equal(unvouched.outcome.kind, "invalidPayload");
  const answered = answerPlayerRuntimeCapture(
    session,
    pending.actionId,
    { kind: "captured", reference },
    { holds: (candidate, kind) => candidate === reference && kind === "image" },
  );
  assert.equal(answered.outcome.kind, "completed");
  // The session continued to the next capture and shows the photo.
  assert.equal(playerRuntimeMedia(answered.session.state).stage.image, reference);
  const next = activePlayerRuntimeCapture(answered.session.state);
  assert.ok(next !== null && next.actionId !== pending.actionId);
  const unavailable = answerPlayerRuntimeCapture(answered.session, next.actionId, {
    kind: "unavailable",
    reason: "denied",
  });
  assert.equal(unavailable.outcome.kind, "completed");
  assert.equal(unavailable.session.state.status, "halted");
  assert.ok(
    unavailable.session.events.some(
      (event) => event.kind === "developerWarning" && event.code === "TSW015",
    ),
  );
});

test("an image request is presented, survives a restore while it waits, and shows the chosen image", () => {
  const session = createPlayerRuntimeSession(
    'let pick = askImage(message: "Show me.", hint: "Add an image", types: [".png"])\nshowImage pick\nexit',
  );
  const presented = playerRuntimeForeground(session);
  assert.deepEqual(presented, {
    kind: "ask-image",
    accessibleName: "Answer",
    hint: "Add an image",
    allowFile: true,
    allowCamera: true,
    skip: null,
    types: [".png"],
    mime: null,
  });
  // Typed text does not answer an image request, and without `allowSkip: true` there is no skip.
  assert.equal(submitPlayerRuntimeComposer(session, "me.png"), null);
  assert.equal(submitPlayerRuntimeComposer(session, "Skip"), null);
  assert.equal(skipPlayerRuntimeImage(session), null);
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimeForeground(restored), presented);
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
  const reference = "captured-media:session:1";
  const store = {
    holds: (candidate: string, kind: "image") => candidate === reference && kind === "image",
  };
  assert.equal(
    answerPlayerRuntimeImage(restored, "images/coast.svg", store)?.outcome.kind,
    "invalidPayload",
  );
  const answered = answerPlayerRuntimeImage(restored, reference, store);
  assert.equal(answered?.outcome.kind, "completed");
  assert.equal(answered.session.state.status, "halted");
  assert.equal(playerRuntimeMedia(answered.session.state).stage.image, reference);
  assert.deepEqual(
    answered.session.transcriptEntries.map((entry) => entry.text),
    ["Show me.", "Image"],
  );
  // Without a pending image request there is nothing to answer.
  assert.equal(answerPlayerRuntimeImage(answered.session, reference, store), null);
});

test("a skippable image request offers Skip, also after a restore, and a skip answers null", () => {
  const session = createPlayerRuntimeSession(
    'let pick = askImage("Show me.", allowSkip: true)\nif pick == null {\n  say "No photo, then.", instant\n}\nexit',
  );
  const presented = playerRuntimeForeground(session);
  assert.ok(presented?.kind === "ask-image");
  assert.equal(presented.skip, "Skip");
  const point = createPlayerRuntimeRestorePoint(session);
  // The skip control's exact text skips, as its button does; other text is not an answer.
  for (const skip of [
    skipPlayerRuntimeImage,
    (restored: PlayerRuntimeSession) => submitPlayerRuntimeComposer(restored, "Skip"),
  ]) {
    const restored = restorePlayerRuntimeSession(point);
    assert.deepEqual(playerRuntimeForeground(restored), presented);
    assert.equal(submitPlayerRuntimeComposer(restored, "skip"), null);
    const skipped = skip(restored);
    assert.equal(skipped?.outcome.kind, "completed");
    assert.equal(skipped.session.state.status, "halted");
    assert.deepEqual(
      skipped.session.transcriptEntries.map((entry) => entry.text),
      ["Show me.", "Skip", "No photo, then."],
    );
  }
});

test("an image request without a hint shows the default hint, and an explicitly empty one stays empty", () => {
  const hintOf = (source: string) => {
    const presented = playerRuntimeForeground(createPlayerRuntimeSession(source));
    return presented?.kind === "ask-image" ? presented.hint : null;
  };
  assert.equal(hintOf('let pick = askImage("Show me.")\nexit'), "Add an image…");
  assert.equal(hintOf('let pick = askImage("Show me.", hint: "")\nexit'), "");
});

test("runtime adapter leaves evaluated persistent writes pending until acknowledgement", () => {
  const initial = [{ key: "answer.2", value: "previous" }];
  const session = createPlayerRuntimeSession(
    `
let suffix = 2
let replacement = "new"
save "\${replacement} value" as "answer.\${suffix}"
let answer = load "answer.\${suffix}", default: null
say answer, instant
exit
`,
    { scriptStorage: initial, persistentScriptStorage: true },
  );
  const write = pendingPlayerRuntimeStorageWrite(session.state);
  assert.ok(write);
  assert.deepEqual({ key: write.key, value: write.value }, { key: "answer.2", value: "new value" });
  assert.equal(session.state.status, "waiting");
  assert.equal(playerRuntimeSnapshot(session).scriptStoragePersistent, true);
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, initial);
  assert.deepEqual(session.transcriptEntries, []);

  const completed = completePlayerRuntimeStorageWrite(session, write.actionId, true);
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(completed.session.state.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(completed.session.state), null);
  assert.deepEqual(playerRuntimeSnapshot(completed.session).scriptStorage, [
    { key: "answer.2", value: "new value" },
  ]);
  assert.deepEqual(
    completed.session.transcriptEntries.map((entry) => entry.text),
    ["new value"],
  );
});

test("runtime adapter retains the previous value and emits TSW014 after a failed write acknowledgement", () => {
  const session = createPlayerRuntimeSession(
    'save "replacement" as "answer"\nlet answer: string? = load "answer", default: null\nsay answer, instant\nexit',
    { scriptStorage: [{ key: "answer", value: "previous" }], persistentScriptStorage: true },
  );
  const write = pendingPlayerRuntimeStorageWrite(session.state);
  assert.ok(write);
  const completed = completePlayerRuntimeStorageWrite(session, write.actionId, false);
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(completed.session.state.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(completed.session.state), null);
  assert.deepEqual(playerRuntimeSnapshot(completed.session).scriptStorage, [
    { key: "answer", value: "previous" },
  ]);
  assert.deepEqual(
    completed.session.transcriptEntries.map((entry) => entry.text),
    ["previous"],
  );
  assert.deepEqual(
    completed.session.events
      .filter((event) => event.kind === "developerWarning")
      .map(({ code, message }) => ({ code, message })),
    [
      {
        code: "TSW014",
        message: 'save could not persist "answer", so the previous value is kept.',
      },
    ],
  );
});

test("runtime adapter keeps storage session-local by default without pending writes or warnings", () => {
  const session = createPlayerRuntimeSession(
    'save "local" as "answer"\nlet answer: string? = load "answer", default: null\nsay answer, instant\ndelete "old"\nexit',
    { scriptStorage: [{ key: "old", value: "initial" }] },
  );
  assert.equal(playerRuntimeSnapshot(session).scriptStoragePersistent, false);
  assert.equal(session.state.status, "halted");
  assert.equal(session.state.foregroundAction, null);
  assert.equal(pendingPlayerRuntimeStorageWrite(session.state), null);
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, [
    { key: "answer", value: "local" },
  ]);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["local"],
  );
  assert.deepEqual(
    session.events.filter(
      (event) =>
        event.kind === "developerWarning" ||
        (event.kind === "actionRequested" && event.action.kind === "storageWrite") ||
        (event.kind === "actionCompleted" && event.settlement.actionKind === "storageWrite"),
    ),
    [],
  );
});

test("runtime adapter ignores unknown and stale storage action IDs", () => {
  const original = createPlayerRuntimeSession('save 1 as "answer"\nsave 2 as "answer"\nexit', {
    persistentScriptStorage: true,
  });
  const first = pendingPlayerRuntimeStorageWrite(original.state);
  assert.ok(first);
  const unknown = completePlayerRuntimeStorageWrite(original, first.actionId + 100, true);
  assert.notEqual(unknown.outcome.kind, "completed");
  // A refusal publishes again, unchanged but for the revision.
  assert.deepEqual({ ...unknown.session, revision: original.revision }, original);

  const completed = completePlayerRuntimeStorageWrite(original, first.actionId, true);
  const second = pendingPlayerRuntimeStorageWrite(completed.session.state);
  assert.ok(second);
  assert.notEqual(second.actionId, first.actionId);
  const stale = completePlayerRuntimeStorageWrite(completed.session, first.actionId, false);
  assert.notEqual(stale.outcome.kind, "completed");
  assert.deepEqual({ ...stale.session, revision: completed.session.revision }, completed.session);
  assert.deepEqual(playerRuntimeSnapshot(stale.session).scriptStorage, [
    { key: "answer", value: 1 },
  ]);
});

test("runtime adapter leaves writes reached after interaction and time observation pending", () => {
  let session = createPlayerRuntimeSession(
    'showButton "Continue"\nsave 2 as "answered"\nwait 1 s\nsave 3 as "observed"\ndelete "answered"\nlet answer = load "answered", default: 0\nsay answer, instant\nexit',
    { persistentScriptStorage: true },
  );
  assert.equal(pendingPlayerRuntimeStorageWrite(session.state), null);
  const answered = activatePlayerRuntimeButton(session);
  assert.ok(answered);
  assert.equal(answered.outcome.kind, "completed");
  session = answered.session;
  const interactionWrite = pendingPlayerRuntimeStorageWrite(session.state);
  assert.ok(interactionWrite);
  assert.deepEqual(
    { key: interactionWrite.key, value: interactionWrite.value },
    { key: "answered", value: 2 },
  );
  assert.equal(session.state.status, "waiting");
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, []);
  session = completePlayerRuntimeStorageWrite(session, interactionWrite.actionId, true).session;
  assert.equal(session.state.foregroundAction?.kind, "delay");

  const observed = observePlayerRuntimeTime(session, 1_000);
  assert.equal(observed.outcome.kind, "observed");
  session = observed.session;
  const timeWrite = pendingPlayerRuntimeStorageWrite(session.state);
  assert.ok(timeWrite);
  assert.deepEqual({ key: timeWrite.key, value: timeWrite.value }, { key: "observed", value: 3 });
  assert.equal(session.state.status, "waiting");
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, [{ key: "answered", value: 2 }]);
  session = completePlayerRuntimeStorageWrite(session, timeWrite.actionId, true).session;

  const deletion = pendingPlayerRuntimeStorageWrite(session.state);
  assert.ok(deletion);
  assert.deepEqual({ key: deletion.key, value: deletion.value }, { key: "answered", value: null });
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, [
    { key: "answered", value: 2 },
    { key: "observed", value: 3 },
  ]);
  session = completePlayerRuntimeStorageWrite(session, deletion.actionId, true).session;
  assert.equal(session.state.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(session.state), null);
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, [{ key: "observed", value: 3 }]);
  assert.equal(session.transcriptEntries.at(-1)?.text, "0");
});
