// The runtime adapter's transcript (split from `player-runtime-adapter.test.ts`): message updates and removals, the
// conversation's positions, and an answer whose run throws.
import { DebugRecorder } from "../../player/debug/debug-recorder.js";
import assert from "node:assert/strict";
import test from "node:test";
import { loadPlayerModule } from "../helpers/player-modules.js";
import {
  createPlayerRuntimeRestorePoint,
  observePlayerRuntimeTime,
  restorePlayerRuntimeSession,
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
  playerRuntimeSnapshot,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import {
  playerRuntimeForeground,
  playerRuntimeQuestionAgain,
  playerRuntimeTranscript,
} from "../../player/runtime/runtime-view.js";

test("a question a block's question interrupted shows its line again once the block is answered, until it is answered", () => {
  let session = createPlayerRuntimeSession(
    [
      "timer async 10 s {",
      '    say "Surprise?", instant',
      '    let surprise = askChoice "Yes", "No"',
      "}",
      'let animal = askText "Name an animal."',
      'say "You said ${animal}.", instant',
      'let done = askChoice "Done"',
      "exit",
    ].join("\n"),
  );
  assert.equal(playerRuntimeQuestionAgain(session), null, "its line is the latest");
  const asked = session.transcriptEntries.at(-1)!;
  session = observePlayerRuntimeTime(session, 11_000)!.session;
  assert.equal(
    playerRuntimeQuestionAgain(session),
    null,
    "the block's question: its line is the latest",
  );
  const yes = playerRuntimeForeground(session);
  assert.ok(yes?.kind === "choose");
  session = selectPlayerRuntimeChoice(session, yes.options[0]!.id)!.session;
  const again = playerRuntimeQuestionAgain(session);
  assert.ok(again !== null);
  assert.equal(again.text, "Name an animal.");
  assert.equal(again.speakerId, asked.kind === "message" ? asked.speakerId : undefined);
  assert.notEqual(again.id, asked.id, "a row of its own");
  session = submitPlayerRuntimeComposer(session, "Cat")!.session;
  assert.equal(
    playerRuntimeQuestionAgain(session),
    null,
    "answered: the next question's line is the latest",
  );
});

test("a question without its own line shows no other line again, asked after an answer or interrupted", () => {
  let session = createPlayerRuntimeSession(
    [
      'let rounds = askText "How many rounds?"',
      "timer async 10 s {",
      '    say "Surprise?", instant',
      '    let surprise = askChoice "Yes", "No"',
      "}",
      'let speed = askChoice "Slow", "Fast"',
      "exit",
    ].join("\n"),
  );
  session = submitPlayerRuntimeComposer(session, "3")!.session;
  assert.equal(playerRuntimeQuestionAgain(session), null, "the latest entry is an answer");
  session = observePlayerRuntimeTime(session, 11_000)!.session;
  const yes = playerRuntimeForeground(session);
  assert.ok(yes?.kind === "choose");
  session = selectPlayerRuntimeChoice(session, yes.options[0]!.id)!.session;
  assert.ok(playerRuntimeForeground(session)?.kind === "choose");
  assert.equal(
    playerRuntimeQuestionAgain(session),
    null,
    "interrupted, its latest entry is still an answer",
  );
});

test("a message update replaces its row in place, keeping its identity, speaker, and presentation", () => {
  let session = createPlayerRuntimeSession(
    [
      "speaker vera {",
      '    name: "Vera"',
      '    color: "#aa3366"',
      "}",
      "speaker coach {",
      '    name: "Coach"',
      "}",
      "speaker vera",
      'let line = say "Waiting.", instant',
      'say as coach "Meanwhile", instant',
      "wait 1 s",
      'line.text += "."',
      'line.text = "**Ready**"',
      "wait 1 s",
      "exit",
    ].join("\n"),
  );
  const [created, other] = session.transcriptEntries;
  assert.ok(created?.kind === "message" && other?.kind === "message");
  assert.equal(created.text, "Waiting.");
  const revision = session.transcriptRevision;
  const restorePoint = createPlayerRuntimeRestorePoint(session);

  session = observePlayerRuntimeTime(session, 1_000)!.session;
  const updated = session.transcriptEntries[0];
  assert.ok(updated?.kind === "message");
  // The same row, at the same place, with the new content; the update is the event Explain values explains.
  assert.deepEqual(
    session.transcriptEntries.map((entry) => [entry.id, entry.text]),
    [
      [created.id, "Ready"],
      [other.id, "Meanwhile"],
    ],
  );
  assert.equal(updated.speakerId, created.speakerId);
  assert.deepEqual(updated.presentation, created.presentation);
  assert.equal(updated.content?.blocks[0]?.kind, "paragraph");
  const lastUpdate = session.events.findLast((event) => event.kind === "messageUpdated");
  assert.equal(updated.contentSequence, lastUpdate?.sequence);
  assert.ok(session.transcriptRevision > revision);
  // Rows are replaced, never changed: the earlier row still shows the earlier text.
  assert.equal(created.text, "Waiting.");

  // A restore rebuilds the same rows; one from before the update shows the text it had then.
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
  assert.equal(restorePlayerRuntimeSession(restorePoint).transcriptEntries[0]?.text, "Waiting.");
});

test("a removed message keeps its row, marked removed, also through a restore and in a kept session's transcript", () => {
  let session = createPlayerRuntimeSession(
    [
      'let first = say "First", instant',
      'let second = say "Second", instant',
      'say "Third", instant',
      "wait 1 s",
      "second.remove()",
      "first.remove()",
      "wait 1 s",
      "exit",
    ].join("\n"),
  );
  const before = session.transcriptEntries.map((entry) => entry.id);
  const restorePoint = createPlayerRuntimeRestorePoint(session);
  assert.deepEqual(session.transcriptRemovedRows, []);

  session = observePlayerRuntimeTime(session, 1_000)!.session;
  // The rows keep their places, so the others keep theirs; the removal is the event Explain values explains.
  assert.deepEqual(
    session.transcriptEntries.map((entry) => [
      entry.id,
      entry.text,
      entry.kind === "message" && entry.removed === true,
    ]),
    [
      [before[0], "First", true],
      [before[1], "Second", true],
      [before[2], "Third", false],
    ],
  );
  assert.deepEqual(session.transcriptRemovedRows, [0, 1]);
  const removal = session.events.findLast((event) => event.kind === "messageRemoved");
  const first = session.transcriptEntries[0];
  assert.ok(first?.kind === "message");
  assert.equal(first.contentSequence, removal?.sequence);

  // A restore, and the transcript a kept session's events give, show the same rows.
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
  assert.deepEqual(restored.transcriptRemovedRows, [0, 1]);
  assert.deepEqual(playerRuntimeTranscript(session.events).entries, session.transcriptEntries);
  assert.deepEqual(restorePlayerRuntimeSession(restorePoint).transcriptRemovedRows, []);
});

test("the conversation leaves removed messages out of its positions and groups the messages around them", async () => {
  const presentation: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/transcript/transcriptPresentation.ts",
  );
  for (const name of ["adjoins", "shownEntryIndex", "shownPosition"])
    assert.equal(typeof presentation[name], "function", name);
  // EVIDENCE: validation: Vite loaded the real source module and each export is callable.
  const { adjoins, shownEntryIndex, shownPosition } = presentation as {
    adjoins: (entries: readonly unknown[], index: number, other: number) => boolean;
    shownEntryIndex: (removed: readonly number[], position: number) => number;
    shownPosition: (removed: readonly number[], index: number) => number;
  };
  const session = createPlayerRuntimeSession(
    [
      'say "First", instant',
      'let a = say "Gone A", instant',
      'let b = say "Gone B", instant',
      'say "Second", instant',
      'let c = say "Gone C", instant',
      "b.remove()",
      "c.remove()",
      "a.remove()",
      "wait 1 s",
      "exit",
    ].join("\n"),
  );
  const entries = session.transcriptEntries;
  const removed = session.transcriptRemovedRows;
  assert.deepEqual(removed, [1, 2, 4]);
  const shown = Array.from({ length: entries.length - removed.length }, (_, position) =>
    shownEntryIndex(removed, position),
  );
  assert.deepEqual(
    shown.map((index) => entries[index]?.text),
    ["First", "Second"],
  );
  // Past the last shown entry, a position names no entry.
  assert.equal(entries[shownEntryIndex(removed, shown.length)], undefined);
  // A removed message's place is that of the next message the conversation shows.
  assert.deepEqual(
    entries.map((_, index) => shownPosition(removed, index)),
    [0, 1, 1, 1, 2],
  );
  // First and Second adjoin, as if the removed messages between them had never been there.
  assert.equal(adjoins(entries, shown[1]!, shown[0]!), true);
});

test("an answer whose run throws leaves the transcript as the Player showed it, and the next answer follows on", () => {
  const source = [
    'let pick = askChoice again: "Again", long: "Long"',
    'if pick == "long" {',
    '  say "deep", instant',
    "}",
    'say "done ${pick}", instant',
    "exit",
  ].join("\n");
  // With the scope IDs used up, the run after "Long" throws (TSR101) as it enters the block, an error no script reaches
  // otherwise; the run after "Again" enters none.
  const started = createPlayerRuntimeSession(source);
  const usedUp = JSON.stringify({
    ...playerRuntimeSnapshot(started),
    nextScopeId: Number.MAX_SAFE_INTEGER,
  });
  const restored = (recorder: DebugRecorder | null) =>
    restorePlayerRuntimeSessionAt(started.plan, usedUp, started.events, recorder);
  const choose = (session: PlayerRuntimeSession, label: string) => {
    const foreground = playerRuntimeForeground(session);
    assert.ok(foreground?.kind === "choose");
    const option = foreground.options.find((candidate) => candidate.label === label)!;
    return selectPlayerRuntimeChoice(session, option.id)!.session;
  };
  const session = restored(new DebugRecorder());
  const events = [...session.events];
  const transcript = [...session.transcriptEntries];
  assert.throws(
    () => choose(session, "Long"),
    /nextScopeId is at its largest value, so it cannot advance/u,
  );
  assert.deepEqual(session.events, events);
  assert.deepEqual(session.transcriptEntries, transcript);

  const continued = choose(session, "Again");
  const expected = choose(restored(null), "Again");
  assert.equal(continued.state.status, "halted");
  assert.deepEqual(continued.events, expected.events);
  assert.deepEqual(continued.transcriptEntries, expected.transcriptEntries);
});
