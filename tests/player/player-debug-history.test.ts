import assert from "node:assert/strict";
import test from "node:test";

import { DebugHistoryView, rewindFutureOf } from "../../player/debug/debug-history.js";
import { openDebugHistorySpill } from "../../player/debug/debug-history-indexeddb.js";
import { CANNOT_KEEP, type HistoryTimeline } from "../../player/engine-bridge/history/core.js";
import type { DebugHistorySpill } from "../../player/engine-bridge/history/snapshots.js";
import { createInProcessBackend } from "../../player/engine-bridge/in-process.js";
import {
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeForm,
  playerRuntimeSnapshot,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession as compiledSession } from "../../player/runtime/compile-project.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  playerRuntimeForeground,
  playerTemporalContext,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import { hatch, introduced } from "../helpers/in-process-bridge.js";
import type { PlayerTranscriptEntryPresentation } from "../../player/presentation/model.js";
import type { OpCall } from "../../player/engine-bridge/op-catalogue.js";

// Debug's rewind history keeps a point for each newly presented interaction and restores it exactly: its state, and its
// transcript rebuilt from the events that led to it (DEBUGGER.md "Rewind"). The history is the engine's host's
// (`ops/history.ts`), reached here as the Player reaches it, through its bridge.

const twoChoices = [
  'let first = askChoice "One", "Two"',
  'say "first ${first}", instant',
  'let second = askChoice "Red", "Blue"',
  'say "second ${second}", instant',
  "exit",
].join("\n");

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };

/** A connection with an open history; its sessions are the host's, and their publications pass the history. */
async function connection(
  options: Parameters<typeof createInProcessBackend>[1] = {},
): Promise<{ readonly bridge: PlayerBridge; readonly history: number }> {
  const bridge = createInProcessBackend(BUILD, options);
  const opened = await bridge.historyRenew(bridge.nextHistoryIntent(), null, []);
  assert.ok(opened.kind === "renewed");
  return { bridge, history: opened.timeline.history };
}

async function timeline(bridge: PlayerBridge, history: number): Promise<HistoryTimeline> {
  const read = await bridge.historyTimeline(history);
  assert.ok(read !== null);
  return read;
}

function choose(session: PlayerSession, label: string): PlayerSession {
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  const option = foreground.options.find((candidate) => candidate.label === label);
  assert.ok(option, label);
  return hatch(session, (held) => selectPlayerRuntimeChoice(held, option.id))!.session;
}

/** A step through `bridge` as the page takes it: a prepared step is committed; the commit's result, and its candidate. */
async function committed(
  bridge: PlayerBridge,
  ...call: OpCall<"rewindBack" | "rewindForward">
): Promise<Awaited<ReturnType<PlayerBridge["historyStep"]>>> {
  const prepared = await bridge.historyStep(...call);
  if (prepared.result.kind !== "prepared") return prepared;
  const { history, step } = prepared.result;
  const { result } = await bridge.historyStep("rewindCommit", { history, step });
  return { result, restored: prepared.restored };
}

/** Back to point `index`, leaving `live`: the restored session. */
async function back(
  bridge: PlayerBridge,
  history: number,
  index: number,
  live: PlayerSession,
): Promise<PlayerSession> {
  const point = (await timeline(bridge, history)).points[index]!;
  const { result, restored } = await committed(bridge, "rewindBack", {
    history,
    point: point.id,
    live: live.id,
    events: live.events.slice(0, point.eventCount),
  });
  assert.equal(result.kind, "done", result.kind === "refused" ? result.reason : "");
  return restored!;
}

/** Forward, with the events of the state it restores, from the log of `log`: the restored session. */
async function forward(
  bridge: PlayerBridge,
  history: number,
  log: PlayerSession,
): Promise<PlayerSession> {
  const future = (await timeline(bridge, history)).inspection!.future!;
  const { result, restored } = await committed(bridge, "rewindForward", {
    history,
    events: log.events.slice(0, future.eventCount),
  });
  assert.equal(result.kind, "done");
  return restored!;
}

/** The main side's view of `history` now, with the logs of `sessions`. */
async function viewOf(bridge: PlayerBridge, history: number, sessions: readonly PlayerSession[]) {
  return new DebugHistoryView(
    await timeline(bridge, history),
    (key) => sessions.find((session) => session.historyKey === key)?.events ?? null,
    () => Promise.resolve(null),
  );
}

function said(session: PlayerSession): string[] {
  return session.transcriptEntries.map((entry) => entry.text);
}

function memorySpill(fail = false) {
  const rows = new Map<number, string>();
  const state = { destroyed: false };
  const spill: DebugHistorySpill = {
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
      state.destroyed = true;
    },
  };
  return { spill, rows, state };
}

async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("Back restores a point exactly, Forward the state it left, and the answer each point got is linked", async () => {
  const { bridge, history } = await connection();
  const first = introduced(bridge, compiledSession(twoChoices));
  // The adapter's transcript grows in place, so the first state's is copied while it is shown.
  const firstTranscript = [...first.transcriptEntries];
  const firstSnapshot = hatch(first, playerRuntimeSnapshot);
  const second = choose(first, "One");
  const { points } = await timeline(bridge, history);
  assert.deepEqual(
    points.map((point) => [point.foreground.kind, point.response?.text ?? null]),
    [
      ["choose", "One"],
      ["choose", null],
    ],
  );
  // The answer's row is the transcript row the session shows for it.
  assert.ok(second.transcriptEntries.some((entry) => entry.id === points[0]!.response?.rowId));

  const atFirst = await back(bridge, history, 0, second);
  assert.deepEqual(hatch(atFirst, playerRuntimeSnapshot), firstSnapshot);
  assert.deepEqual(atFirst.transcriptEntries, firstTranscript);
  assert.deepEqual(atFirst.marks.rewoundWhileDebugging, { restoredSceneTimeMs: 0, rewindCount: 1 });
  const inspected = (await timeline(bridge, history)).inspection!;
  assert.deepEqual([inspected.points, inspected.canForward], [1, true]);
  // The state Back left is the future the restored state does not show yet.
  assert.equal(inspected.future?.eventCount, second.events.length);

  const secondSnapshot = hatch(second, playerRuntimeSnapshot);
  const atSecond = await forward(bridge, history, second);
  assert.deepEqual(hatch(atSecond, playerRuntimeSnapshot), secondSnapshot);
  assert.deepEqual(said(atSecond), ["One", "first One"]);
  const after = (await timeline(bridge, history)).inspection!;
  assert.deepEqual([after.points, after.canForward], [2, false]);
});

test("new input adopts the restored state: later points go, and the point gets its new answer", async () => {
  const { bridge, history } = await connection();
  const first = introduced(bridge, compiledSession(twoChoices));
  const second = choose(first, "One");
  const atFirst = await back(bridge, history, 0, second);
  await bridge.historyStep("rewindAdopt", { history, phase: "begin" });
  const adopted = await bridge.historyStep("rewindAdopt", {
    history,
    phase: "end",
    succeeded: true,
  });
  assert.ok(adopted.result.kind === "done");
  assert.equal(adopted.result.live, atFirst.id);
  assert.deepEqual(adopted.result.released, [second.id]);
  const kept = await timeline(bridge, history);
  assert.equal(kept.inspection, null);
  assert.equal(kept.points.length, 1);
  const branch = choose(atFirst, "Two");
  assert.deepEqual(
    (await timeline(bridge, history)).points.map((point) => point.response?.text ?? null),
    ["Two", null],
  );
  assert.deepEqual(said(branch), ["Two", "first Two"]);
  // Return has nothing to reinstate once the state is adopted.
  assert.equal((await bridge.historyStep("rewindReturn", { history })).result.kind, "refused");
});

test("Return reinstates the session Back first left, with its points", async () => {
  const { bridge, history } = await connection();
  const first = introduced(bridge, compiledSession(twoChoices));
  const second = choose(first, "One");
  const atSecond = await back(bridge, history, 1, second);
  // A later Back leaves the restored state; the session parked stays the first Back's.
  const atFirst = await back(bridge, history, 0, atSecond);
  const returned = await bridge.historyStep("rewindReturn", { history });
  assert.ok(returned.result.kind === "done");
  assert.equal(returned.result.live, second.id);
  assert.deepEqual(returned.result.released, [atFirst.id]);
  const after = await timeline(bridge, history);
  assert.equal(after.inspection, null);
  assert.equal(after.points.length, 2);
  // Back may go only to a point before the state shown.
  assert.equal(
    (
      await bridge.historyStep("rewindBack", {
        history,
        point: after.points[1]!.id + 1,
        live: second.id,
        events: second.events,
      })
    ).result.kind,
    "refused",
  );
});

test("each point is written to the spill store and read back from it; an adoption deletes the discarded ones", async () => {
  const { spill, rows, state } = memorySpill();
  const { bridge, history } = await connection({ historySpill: async () => spill });
  const first = introduced(bridge, compiledSession(twoChoices));
  const firstSnapshot = hatch(first, playerRuntimeSnapshot);
  const second = choose(first, "One");
  await settle();
  assert.deepEqual([...rows.keys()], [1, 2]);
  const written = await timeline(bridge, history);
  assert.equal(written.memoryChars, 0);
  assert.equal(written.spilledCount, 2);
  const atFirst = await back(bridge, history, 0, second);
  assert.deepEqual(hatch(atFirst, playerRuntimeSnapshot), firstSnapshot);
  await bridge.historyStep("rewindAdopt", { history, phase: "begin" });
  await bridge.historyStep("rewindAdopt", { history, phase: "end", succeeded: true });
  await settle();
  assert.deepEqual([...rows.keys()], [1]);
  const closed = bridge.historyClose({ history, by: "debugOff" });
  assert.ok(closed.posted);
  await closed.reply;
  await settle();
  assert.equal(state.destroyed, true);
});

test("without a spill store, or after it failed, points stop at the admission bound, earlier ones stay, and Back keeps the bound", async () => {
  const size = JSON.stringify(
    hatch(
      introduced(createInProcessBackend(BUILD), compiledSession(twoChoices)),
      playerRuntimeSnapshot,
    ),
  ).length;
  // Without a spill store, the second point no longer fits; a failing one takes the first point, then fails.
  for (const options of [
    { historySpill: async () => null, historyBudget: 1.5 * size },
    { historySpill: async () => memorySpill(true).spill, historyBudget: 1.5 * size },
  ]) {
    const { bridge, history } = await connection(options);
    await settle();
    const first = introduced(bridge, compiledSession(twoChoices));
    await settle();
    const second = choose(first, "One");
    await settle();
    const after = await timeline(bridge, history);
    assert.equal(after.points.length, 1);
    assert.equal(after.complete, false);
    // The state Back would leave is kept as a point is, and it does not fit beside the point: Back is refused.
    const [point] = after.points;
    const refused = await bridge.historyStep("rewindBack", {
      history,
      point: point!.id,
      live: second.id,
      events: second.events.slice(0, point!.eventCount),
    });
    assert.deepEqual(refused.result, { kind: "refused", reason: CANNOT_KEEP });
    assert.equal((await timeline(bridge, history)).inspection, null);
  }
});

test("a state too large to save ends the collection as a full store does, and earlier points stay", async (context) => {
  const { bridge, history } = await connection({ historySpill: async () => null });
  const first = introduced(bridge, compiledSession(twoChoices));
  // The second state's JSON is too long for V8 to build.
  const stringify = JSON.stringify;
  context.mock.method(JSON, "stringify", (value: unknown, ...rest: []) => {
    if (typeof value === "object" && value !== null && "format" in value)
      throw new RangeError("Invalid string length");
    return stringify(value, ...rest);
  });
  choose(first, "One");
  context.mock.restoreAll();
  const after = await timeline(bridge, history);
  assert.equal(after.points.length, 1);
  assert.equal(after.complete, false);
});

test("the spill store opens without crypto.randomUUID, which plain-HTTP pages lack", async () => {
  // Browsers offer crypto.randomUUID only in secure contexts; Debug over plain HTTP on a local network must still spill
  // its history.
  const names: string[] = [];
  const factory = {
    open(name: string) {
      names.push(name);
      const request: { result: unknown; onsuccess: ((event: Event) => void) | null } = {
        result: {},
        onsuccess: null,
      };
      queueMicrotask(() => request.onsuccess?.(new Event("success")));
      return request;
    },
  };
  const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    // EVIDENCE: opening a spill store only opens its database by name and waits for success, which this fake reports.
    assert.notEqual(await openDebugHistorySpill(factory as IDBFactory), null);
  } finally {
    if (original) Object.defineProperty(crypto, "randomUUID", original);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
  assert.equal(names.length, 1);
  assert.match(
    names[0]!,
    /^teasescript-debug-history-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test("a state that cannot be read back fails its step, and the history stays as it was", async () => {
  const { spill, rows } = memorySpill();
  const { bridge, history } = await connection({ historySpill: async () => spill });
  const first = introduced(bridge, compiledSession(twoChoices));
  const second = choose(first, "One");
  await settle();
  const [point] = (await timeline(bridge, history)).points;
  const step = () =>
    bridge.historyStep("rewindBack", {
      history,
      point: point!.id,
      live: second.id,
      events: second.events.slice(0, point!.eventCount),
    });
  rows.delete(point!.id);
  await assert.rejects(step(), /no longer available/u);
  assert.equal((await timeline(bridge, history)).inspection, null);
  // A damaged snapshot fails validation when it is restored.
  rows.set(point!.id, JSON.stringify({ status: "waiting" }));
  await assert.rejects(step());
  assert.equal((await timeline(bridge, history)).inspection, null);
});

test("the grey future is the transcript of the state Forward restores after the shown state's own", async () => {
  const { bridge, history } = await connection();
  const first = introduced(bridge, compiledSession(twoChoices));
  const second = choose(first, "One");
  const shownTranscript = second.transcriptEntries.map((entry) => entry.id);
  const atFirst = await back(bridge, history, 0, second);
  const future = rewindFutureOf(await viewOf(bridge, history, [second, atFirst]))!;
  assert.deepEqual(
    future.entries.map((entry) => [entry.id, entry.text, entry.kind === "message" && entry.future]),
    second.transcriptEntries.map((entry) => [`future-${entry.id}`, entry.text, true]),
  );
  // Its rows are keyed apart from the session's, whose sequences new input may reuse.
  assert.ok(future.entries.every((entry) => !shownTranscript.includes(entry.id)));
  // The answer keeps its mark as a choice.
  assert.equal(future.entries[0]?.kind === "message" && future.entries[0].responseKind, "choice");
});

test("the grey future shows a submitted form's answers as Forward does, in the session's date presentation", async () => {
  const formSummary = (entries: readonly PlayerTranscriptEntryPresentation[]) => {
    for (const entry of entries)
      if (entry.kind === "message" && entry.formSummary) return entry.formSummary;
    return undefined;
  };
  for (const locale of ["en-US", "nl-NL"]) {
    const { bridge, history } = await connection();
    const first = introduced(
      bridge,
      compiledSession(
        [
          'let when = askForm "When?", fields: { day: toDate("2026-10-04") }',
          'say "Noted"',
          "exit",
        ].join("\n"),
        { temporalContext: playerTemporalContext({ timeZone: "UTC", locale }) },
      ),
    );
    const submitted = hatch(first, submitPlayerRuntimeForm)!.session;
    const live = formSummary(submitted.transcriptEntries);
    assert.ok(live?.[0]?.kind === "value", locale);
    // The live transcript writes the date as the player's language does, not as the ISO date the script wrote.
    assert.notEqual(live[0].value, "2026-10-04", locale);
    const restored = await back(bridge, history, 0, submitted);
    assert.deepEqual(
      formSummary(rewindFutureOf(await viewOf(bridge, history, [submitted, restored]))!.entries),
      live,
      locale,
    );
    assert.deepEqual(
      formSummary((await forward(bridge, history, submitted)).transcriptEntries),
      live,
      locale,
    );
  }
});

test("Back and Forward show a changed message as each state had it, and the grey future does not repeat it", async () => {
  const { bridge, history } = await connection();
  const first = introduced(
    bridge,
    compiledSession(
      [
        'let strokes = say "Strokes: 0", instant',
        'let first = askChoice "One", "Two"',
        'strokes.text = "Strokes: 1"',
        'let second = askChoice "Red", "Blue"',
        'strokes.text = "Strokes: 50"',
        'say "done", instant',
        "exit",
      ].join("\n"),
    ),
  );
  const ended = choose(choose(first, "One"), "Red");
  assert.deepEqual(said(ended), ["Strokes: 50", "One", "Red", "done"]);

  const atSecond = await back(bridge, history, 1, ended);
  // One row for the message, with the text it had then; the later text does not leak into it.
  assert.deepEqual(said(atSecond), ["Strokes: 1", "One"]);
  assert.equal(atSecond.transcriptEntries[0]?.id, ended.transcriptEntries[0]?.id);
  const future = rewindFutureOf(await viewOf(bridge, history, [ended, atSecond]))!;
  assert.deepEqual(
    future.entries.map((entry) => entry.text),
    ["Red", "done"],
  );
  const atFirst = await back(bridge, history, 0, ended);
  assert.deepEqual(said(atFirst), ["Strokes: 0"]);
  const forwarded = await forward(bridge, history, atSecond);
  assert.deepEqual(said(forwarded), ["Strokes: 1", "One"]);
  assert.deepEqual(said(await forward(bridge, history, ended)), said(ended));
});
