import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDeadlines,
  playerRuntimeForeground,
  playerRuntimeMedia,
  playerRuntimePacingGate,
  playerRuntimePermanentButtons,
  pressPlayerRuntimePermanentButton,
  restorePlayerRuntimeSession,
  skipPlayerRuntimePacing,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";

/*
 * What the Player presents while a paced message is read (owner decision on #829, 2026-10-11): nothing new appears
 * until its reading time ends or the player skips it; permanent buttons already shown stay usable.
 */

function observe(session: PlayerRuntimeSession, atMs: number): PlayerRuntimeSession {
  const observed = observePlayerRuntimeTime(session, atMs);
  assert.equal(observed.outcome.kind, "observed");
  return observed.session;
}

const transcript = (session: PlayerRuntimeSession) =>
  session.transcriptEntries.map((entry) => entry.text);

test("during a reading time the Player shows no new controls or Stage image; then the question comes with its buttons", () => {
  let session = createPlayerRuntimeSession(
    [
      'say "Read this.", 2 s',
      'showImage "images/room.jpg"',
      'let ready = askBoolean "Ready?"',
      "exit",
    ].join("\n"),
  );
  assert.notEqual(playerRuntimePacingGate(session), null);
  assert.equal(playerRuntimeForeground(session), null);
  assert.equal(playerRuntimeMedia(session.state).stage.image, null);
  assert.deepEqual(transcript(session), ["Read this."]);
  // The Player observes time again when the reading time ends.
  assert.deepEqual(playerRuntimeDeadlines(session.state), [2_000]);

  session = observe(session, 1_999);
  assert.equal(playerRuntimeForeground(session), null);
  session = observe(session, 2_000);
  assert.equal(playerRuntimePacingGate(session), null);
  assert.equal(playerRuntimeMedia(session.state).stage.image, "images/room.jpg");
  assert.deepEqual(transcript(session), ["Read this.", "Ready?"]);
  assert.equal(playerRuntimeForeground(session)?.kind, "choose");
});

test("a skip in the Player ends the reading time and shows what follows at once", () => {
  const session = createPlayerRuntimeSession('say "Read this.", 5 s\nshowButton "Go"\nexit');
  assert.equal(playerRuntimeForeground(session), null);
  const skipped = skipPlayerRuntimePacing(observe(session, 500));
  assert.equal(skipped?.outcome.kind, "completed");
  assert.equal(playerRuntimePacingGate(skipped!.session), null);
  assert.equal(playerRuntimeForeground(skipped!.session)?.kind, "show-button");
});

test("a permanent button stays usable during a reading time, and its block's message follows the reading time", () => {
  let session = createPlayerRuntimeSession(
    [
      'showPermanentButton "Hint" {',
      '  say "Try the red one.", instant',
      "}",
      'say "A long message.", 5 s',
      'showButton "Done"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(playerRuntimePermanentButtons(session.state), [
    { buttonId: 1, label: "Hint", busy: false },
  ]);
  const pressed = pressPlayerRuntimePermanentButton(observe(session, 1_000), 1);
  assert.equal(pressed.outcome.kind, "pressed");
  session = pressed.session;
  assert.deepEqual(playerRuntimePermanentButtons(session.state), [
    { buttonId: 1, label: "Hint", busy: true },
  ]);
  assert.deepEqual(transcript(session), ["A long message."]);
  assert.notEqual(playerRuntimePacingGate(session), null);

  session = observe(session, 5_000);
  assert.deepEqual(transcript(session), ["A long message.", "Try the red one."]);
  assert.deepEqual(playerRuntimePermanentButtons(session.state), [
    { buttonId: 1, label: "Hint", busy: false },
  ]);
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
});

test("a Player restore point taken during a reading time restores it and continues the same way", () => {
  const session = observe(
    createPlayerRuntimeSession(
      'say "Read this.", 2 s\nshowImage "images/room.jpg"\nshowButton "Go"\nexit',
    ),
    1_000,
  );
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimePacingGate(restored), playerRuntimePacingGate(session));
  assert.deepEqual(transcript(restored), ["Read this."]);
  assert.equal(playerRuntimeForeground(restored), null);

  const continued = observe(session, 2_000);
  const restoredContinued = observe(restored, 2_000);
  assert.deepEqual(transcript(restoredContinued), transcript(continued));
  assert.deepEqual(playerRuntimeForeground(restoredContinued), playerRuntimeForeground(continued));
  assert.equal(playerRuntimeMedia(restoredContinued.state).stage.image, "images/room.jpg");
});
