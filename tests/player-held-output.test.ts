import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeForeground,
  playerRuntimeMedia,
  playerRuntimePacingGate,
  playerRuntimePermanentButtons,
  playerRuntimeTimers,
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

test("the Player shows a question with its field after a block that was queued during the reading time", () => {
  let session = createPlayerRuntimeSession(
    [
      "timer async 1 s {",
      '    say "Interrupt", 3 s',
      "}",
      'say "A", 2 s',
      'let answer = askText "Name?"',
      "exit",
    ].join("\n"),
  );
  session = observePlayerRuntimeTime(session, 1_000).session;
  session = observePlayerRuntimeTime(session, 2_000).session;
  assert.deepEqual(texts(session), ["A", "Interrupt"]);
  assert.equal(playerRuntimeForeground(session), null);
  session = observePlayerRuntimeTime(session, 5_000).session;
  assert.deepEqual(texts(session), ["A", "Interrupt", "Name?"]);
  assert.equal(playerRuntimeForeground(session)?.kind, "ask-text");
});

test("the Player shows a countdown only once the reading time before it ends, with its full length", () => {
  let session = createPlayerRuntimeSession(
    'say "Ten seconds.", 2 s\nlet t = timer async 10 s "Left"\nshowButton "Go"\nexit',
  );
  assert.deepEqual(playerRuntimeTimers(session.state, 0), []);
  session = observePlayerRuntimeTime(session, 2_000).session;
  assert.deepEqual(
    playerRuntimeTimers(session.state, 2_000).map(({ kind, name, remainingSeconds }) => [
      kind,
      name,
      remainingSeconds,
    ]),
    [["visible", "Left", 10]],
  );
});

test("the Player reveals a hidden countdown only once the reading time before the change ends", () => {
  let session = createPlayerRuntimeSession(
    'let t = timer async hidden 10 s "Left"\nsay "Watch the timer.", 5 s\nt.display = "visible"\nshowButton "Go"\nexit',
  );
  assert.deepEqual(playerRuntimeTimers(session.state, 0), []);
  session = observePlayerRuntimeTime(session, 5_000).session;
  assert.deepEqual(
    playerRuntimeTimers(session.state, 5_000).map(({ kind, remainingSeconds }) => [
      kind,
      remainingSeconds,
    ]),
    [["visible", 5]],
  );
});

test("the Player keeps a permanent button that an expression removes until the reading time before it ends", () => {
  let session = createPlayerRuntimeSession(
    [
      'let hint = showPermanentButton "Hint" {',
      '    say "A hint.", instant',
      "}",
      'say "Read this first.", 5 s',
      "let removed = removePermanentButton(hint)",
      'showButton "Go"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(
    playerRuntimePermanentButtons(session.state).map(({ label }) => label),
    ["Hint"],
  );
  session = observePlayerRuntimeTime(session, 5_000).session;
  assert.deepEqual(playerRuntimePermanentButtons(session.state), []);
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
});
