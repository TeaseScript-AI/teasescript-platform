import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeForeground,
  playerRuntimeMedia,
  playerRuntimePacingGate,
  playerRuntimePermanentButtons,
  pressPlayerRuntimePermanentButton,
  skipPlayerRuntimePacing,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";

// The Player presents only what the runtime has shown (owner decisions of 2026-10-11, issue #829): output held back
// behind a reading time stays off the screen until that reading time ends or the player skips it.

const SOURCE = [
  'showPermanentButton "Hint" {',
  '    say "A hint.", instant',
  "}",
  'say "Read this first.", 5 s',
  'showImage "images/room.jpg"',
  'showButton "Go"',
  "exit",
].join("\n");

function texts(session: PlayerRuntimeSession): string[] {
  return session.transcriptEntries.map((entry) => entry.text);
}

test("the Player presents a held image and question only once the reading time before them ends", () => {
  let session = createPlayerRuntimeSession(SOURCE);
  assert.deepEqual(texts(session), ["Read this first."]);
  assert.equal(playerRuntimeMedia(session.state).stage.image, null);
  assert.equal(playerRuntimeForeground(session), null);
  // The permanent button shown before the message stays shown and usable.
  assert.deepEqual(
    playerRuntimePermanentButtons(session.state).map(({ label, busy }) => [label, busy]),
    [["Hint", false]],
  );
  assert.equal(playerRuntimePacingGate(session)?.deadlineMs, 5_000);

  const observed = observePlayerRuntimeTime(session, 5_000);
  assert.equal(observed.outcome.kind, "observed");
  session = observed.session;
  assert.equal(playerRuntimeMedia(session.state).stage.image, "images/room.jpg");
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
  assert.equal(playerRuntimePacingGate(session), null);
});

test("a skip in the Player shows the held image and question at once", () => {
  const skipped = skipPlayerRuntimePacing(createPlayerRuntimeSession(SOURCE));
  assert.equal(skipped?.outcome.kind, "completed");
  const session = skipped!.session;
  assert.equal(playerRuntimeMedia(session.state).stage.image, "images/room.jpg");
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
  assert.equal(session.state.currentSessionTimeMs, 0);
});

test("a permanent button pressed during a reading time is taken, and its block runs when the reading time ends", () => {
  const pressed = pressPlayerRuntimePermanentButton(createPlayerRuntimeSession(SOURCE), 1);
  assert.equal(pressed.outcome.kind, "pressed");
  let session = pressed.session;
  assert.deepEqual(
    playerRuntimePermanentButtons(session.state).map(({ label, busy }) => [label, busy]),
    [["Hint", true]],
  );
  assert.deepEqual(texts(session), ["Read this first."]);

  session = observePlayerRuntimeTime(session, 5_000).session;
  // The block's message comes first, then the question that waited.
  assert.deepEqual(texts(session), ["Read this first.", "A hint."]);
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
  assert.deepEqual(
    playerRuntimePermanentButtons(session.state).map(({ label, busy }) => [label, busy]),
    [["Hint", false]],
  );
});
