import assert from "node:assert/strict";
import test from "node:test";

import {
  DebugHistory,
  rewindFutureTranscript,
  type DebugHistoryMarks,
  type DebugHistoryRestore,
  type DebugHistorySpill,
} from "../player/debug-history.js";
import {
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";

// Debug's rewind history keeps a point for each newly presented interaction and restores it exactly: its state, and its
// transcript rebuilt from the events that led to it (DEBUGGER.md "Rewind").

const twoChoices = [
  'let first = choose "One", "Two"',
  'say "first ${first}", instant',
  'let second = choose "Red", "Blue"',
  'say "second ${second}", instant',
  "exit",
].join("\n");

const unmarked: DebugHistoryMarks = { editedWhileDebugging: null, rewoundWhileDebugging: null };

function choose(session: PlayerRuntimeSession, label: string): PlayerRuntimeSession {
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  const option = foreground.options.find((candidate) => candidate.label === label);
  assert.ok(option, label);
  return selectPlayerRuntimeChoice(session, option.id)!.session;
}

function restored(history: DebugHistory, restore: DebugHistoryRestore): PlayerRuntimeSession {
  const { position, snapshotJson } = restore;
  return restorePlayerRuntimeSessionAt(
    history.plan,
    snapshotJson,
    position.events.slice(0, position.eventCount),
  );
}

function said(session: PlayerRuntimeSession): string[] {
  return session.transcriptEntries.map((entry) => entry.text);
}

function memorySpill(fail = false) {
  const rows = new Map<number, string>();
  const spill: DebugHistorySpill & { destroyed: boolean } = {
    destroyed: false,
    async put(id, json) {
      if (fail) throw new Error("quota");
      rows.set(id, json);
    },
    async get(id) {
      return rows.get(id);
    },
    async delete(ids) {
      for (const id of ids) rows.delete(id);
    },
    async destroy() {
      rows.clear();
      spill.destroyed = true;
    },
  };
  return { spill, rows };
}

async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("Back restores a point exactly, Forward the state it left, and the answer each point got is linked", async () => {
  const first = createPlayerRuntimeSession(twoChoices);
  // The adapter's transcript grows in place, so the first state's is copied while it is shown.
  const firstTranscript = [...first.transcriptEntries];
  const history = new DebugHistory(first.plan, Promise.resolve(null));
  history.follow(first, unmarked);
  const second = choose(first, "One");
  history.follow(second, unmarked);
  assert.deepEqual(
    history.points.map((point) => [point.foreground.kind, point.response?.text ?? null]),
    [
      ["choose", "One"],
      ["choose", null],
    ],
  );
  // The answer's row is the transcript row the session shows for it.
  assert.ok(
    second.transcriptEntries.some((entry) => entry.id === history.points[0]!.response?.rowId),
  );

  const back = await history.back(0, () => ({ session: second, marks: unmarked }));
  const atFirst = restored(history, back);
  assert.deepEqual(atFirst.snapshot, first.snapshot);
  assert.deepEqual(atFirst.transcriptEntries, firstTranscript);
  assert.deepEqual(back.marks.rewoundWhileDebugging, { restoredSceneTimeMs: 0, rewindCount: 1 });
  assert.deepEqual(history.inspection, { points: 1, canForward: true });
  // The state Back left is the future the restored state does not show yet.
  assert.equal(history.future?.eventCount, second.events.length);

  const atSecond = restored(history, await history.forward());
  assert.deepEqual(atSecond.snapshot, second.snapshot);
  assert.deepEqual(said(atSecond), ["One", "first One"]);
  assert.deepEqual(history.inspection, { points: 2, canForward: false });
});

test("new input adopts the restored state: later points go, and the point gets its new answer", async () => {
  const first = createPlayerRuntimeSession(twoChoices);
  const history = new DebugHistory(first.plan, Promise.resolve(null));
  history.follow(first, unmarked);
  const second = choose(first, "One");
  history.follow(second, unmarked);
  const atFirst = restored(
    history,
    await history.back(0, () => ({ session: second, marks: unmarked })),
  );
  history.adopt();
  assert.equal(history.inspection, null);
  assert.equal(history.points.length, 1);
  const branch = choose(atFirst, "Two");
  history.follow(branch, unmarked);
  assert.deepEqual(
    history.points.map((point) => point.response?.text ?? null),
    ["Two", null],
  );
  assert.deepEqual(said(branch), ["Two", "first Two"]);
  // Return has nothing to reinstate once the state is adopted.
  assert.throws(() => history.returnToSession(), RangeError);
});

test("Return reinstates the session Back first left, with its points", async () => {
  const first = createPlayerRuntimeSession(twoChoices);
  const history = new DebugHistory(first.plan, Promise.resolve(null));
  history.follow(first, unmarked);
  const second = choose(first, "One");
  history.follow(second, unmarked);
  await history.back(1, () => ({ session: second, marks: unmarked }));
  // A later Back checks the session shown, but parks nothing new.
  await history.back(0, () => ({ session: first, marks: unmarked }));
  const parked = history.returnToSession();
  assert.equal(parked.session, second);
  assert.equal(history.inspection, null);
  assert.equal(history.points.length, 2);
  // Back may go only to a point before the state shown.
  await assert.rejects(
    history.back(2, () => ({ session: second, marks: unmarked })),
    RangeError,
  );
});

test("a session that cannot be left now is not parked, and nothing changes", async () => {
  const first = createPlayerRuntimeSession(twoChoices);
  const history = new DebugHistory(first.plan, Promise.resolve(null));
  history.follow(first, unmarked);
  await assert.rejects(history.back(0, () => null));
  assert.equal(history.inspection, null);
});

test("points beyond the memory budget move to the spill store and are read back from it", async () => {
  const { spill, rows } = memorySpill();
  const first = createPlayerRuntimeSession(twoChoices);
  const history = new DebugHistory(first.plan, Promise.resolve(spill), 1);
  history.follow(first, unmarked);
  const second = choose(first, "One");
  history.follow(second, unmarked);
  await settle();
  assert.deepEqual([...rows.keys()], [1, 2]);
  assert.equal(history.memoryChars, 0);
  assert.equal(history.spilledCount, 2);
  const atFirst = restored(
    history,
    await history.back(0, () => ({ session: second, marks: unmarked })),
  );
  assert.deepEqual(atFirst.snapshot, first.snapshot);
  // Adopting the restored state deletes the rows of the states it discards.
  history.adopt();
  await settle();
  assert.deepEqual([...rows.keys()], [1]);
  await history.destroy();
  assert.equal(spill.destroyed, true);
});

test("without a spill store, or after it failed, points stop at the memory budget and earlier ones stay", async () => {
  const first = createPlayerRuntimeSession(twoChoices);
  const size = JSON.stringify(first.snapshot).length;
  // Without a spill store, the second point no longer fits; a failing one takes the first point, then fails.
  for (const [spill, budget] of [
    [Promise.resolve(null), 1.5 * size],
    [Promise.resolve(memorySpill(true).spill), 1],
  ] as const) {
    const history = new DebugHistory(first.plan, spill, budget);
    await settle();
    history.follow(first, unmarked);
    await settle();
    const second = choose(first, "One");
    history.follow(second, unmarked);
    assert.equal(history.points.length, 1);
    assert.equal(history.complete, false);
    // The point kept is still restorable.
    const atFirst = restored(
      history,
      await history.back(0, () => ({ session: second, marks: unmarked })),
    );
    assert.deepEqual(atFirst.snapshot, first.snapshot);
  }
});

test("a state that cannot be read back is reported, and the history stays as it was", async () => {
  const { spill, rows } = memorySpill();
  const first = createPlayerRuntimeSession(twoChoices);
  const history = new DebugHistory(first.plan, Promise.resolve(spill), 1);
  history.follow(first, unmarked);
  const second = choose(first, "One");
  history.follow(second, unmarked);
  await settle();
  rows.delete(1);
  await assert.rejects(
    history.back(0, () => ({ session: second, marks: unmarked })),
    /no longer available/u,
  );
  assert.equal(history.inspection, null);
  // A damaged snapshot fails validation when it is restored.
  rows.set(1, JSON.stringify({ status: "waiting" }));
  const damaged = await history.back(0, () => ({ session: second, marks: unmarked }));
  assert.throws(() => restored(history, damaged));
});

test("the grey future is the transcript of the state Forward restores after the shown state's own", async () => {
  const first = createPlayerRuntimeSession(twoChoices);
  const history = new DebugHistory(first.plan, Promise.resolve(null));
  history.follow(first, unmarked);
  const second = choose(first, "One");
  history.follow(second, unmarked);
  const shownTranscript = second.transcriptEntries.map((entry) => entry.id);
  await history.back(0, () => ({ session: second, marks: unmarked }));
  const future = rewindFutureTranscript(history.shown!, history.future!);
  assert.deepEqual(
    future.entries.map((entry) => [entry.id, entry.text, entry.kind === "message" && entry.future]),
    second.transcriptEntries.map((entry) => [`future-${entry.id}`, entry.text, true]),
  );
  // Its rows are keyed apart from the session's, whose sequences new input may reuse.
  assert.ok(future.entries.every((entry) => !shownTranscript.includes(entry.id)));
  // The answer keeps its mark as a choice.
  assert.equal(future.entries[0]?.kind === "message" && future.entries[0].responseKind, "choice");
});

test("Back and Forward show a changed message as each state had it, and the grey future does not repeat it", async () => {
  const first = createPlayerRuntimeSession(
    [
      'let strokes = say "Strokes: 0", instant',
      'let first = choose "One", "Two"',
      'strokes.text = "Strokes: 1"',
      'let second = choose "Red", "Blue"',
      'strokes.text = "Strokes: 50"',
      'say "done", instant',
      "exit",
    ].join("\n"),
  );
  const history = new DebugHistory(first.plan, Promise.resolve(null));
  history.follow(first, unmarked);
  const second = choose(first, "One");
  history.follow(second, unmarked);
  const ended = choose(second, "Red");
  history.follow(ended, unmarked);
  assert.deepEqual(said(ended), ["Strokes: 50", "One", "Red", "done"]);

  const back = restored(
    history,
    await history.back(1, () => ({ session: ended, marks: unmarked })),
  );
  // One row for the message, with the text it had then; the later text does not leak into it.
  assert.deepEqual(said(back), ["Strokes: 1", "One"]);
  assert.equal(back.transcriptEntries[0]?.id, ended.transcriptEntries[0]?.id);
  const future = rewindFutureTranscript(history.shown!, history.future!);
  assert.deepEqual(
    future.entries.map((entry) => entry.text),
    ["Red", "done"],
  );
  const earlier = restored(
    history,
    await history.back(0, () => ({ session: back, marks: unmarked })),
  );
  assert.deepEqual(said(earlier), ["Strokes: 0"]);
  const forward = restored(history, await history.forward());
  assert.deepEqual(said(forward), ["Strokes: 1", "One"]);
  assert.deepEqual(said(restored(history, await history.forward())), said(ended));
});
