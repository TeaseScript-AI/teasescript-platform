import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { DebugHistoryView, rewindFutureOf } from "../../player/debug/debug-history.js";
import type { HistoryDelta, HistoryTimeline } from "../../player/engine-bridge/history/core.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { playerRuntimeForeground, type PlayerSession } from "../../player/runtime/runtime-view.js";
import type { InterpreterEvent } from "../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { inProcessBridge } from "../helpers/in-process-bridge.js";

/*
 * L5i.6: the main side's view of the host's rewind history (`DebugHistoryView`, `player/debug/debug-history.ts`): it follows
 * the deltas each publication carries, resyncs on any delta that does not continue it, and holds an event log while a
 * position names it.
 */

const SCRIPT =
  'let a = askChoice "A1", "A2"\nwait 1 s\nlet b = askChoice "B1", "B2"\nwait 1 s\nlet c = askChoice "C1", "C2"\nsay "done", instant\nexit';

async function started(bridge: PlayerBridge): Promise<PlayerSession> {
  const reply = await bridge.client.request("prepare", {
    source: {
      kind: "plan",
      text: serializeValidatedRuntimeJson(compilePlayerProject(SCRIPT).plan!),
    },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const prepared = reply.result as PrepareResult;
  assert.equal(prepared.kind, "prepared");
  return bridge.start(prepared.kind === "prepared" ? prepared.plan : "", { wallClockMs: 0 }, false);
}

async function hostTimeline(bridge: PlayerBridge): Promise<HistoryTimeline | null> {
  const reply = await bridge.client.request("historyTimeline", { history: 1 });
  // EVIDENCE: validation: `historyTimeline` replies from the same build with a timeline or `null`.
  return reply.result as HistoryTimeline | null;
}

/** Answers the shown choice with its first option, then observes `atMs`; returns each publication it made. */
async function answer(bridge: PlayerBridge, session: PlayerSession, atMs: number) {
  const made: PlayerSession[] = [];
  const shown = bridge.latest(session)!;
  const foreground = playerRuntimeForeground(shown);
  assert.ok(foreground?.kind === "choose");
  await bridge.request(session, "selectChoice", {
    actionId: shown.state.foregroundAction!.actionId,
    optionId: foreground.options[0]!.id,
    input: null,
  });
  made.push(bridge.latest(session)!);
  await bridge.request(session, "observeTime", { atMs, media: [] });
  made.push(bridge.latest(session)!);
  return made;
}

/** A history the host took three points in, with the publications that carried its deltas. */
async function hosted() {
  const bridge = await inProcessBridge();
  const result = await bridge.historyRenew(1, null, []);
  assert.ok(result.kind === "renewed");
  const session = await started(bridge);
  const publications = [
    bridge.latest(session)!,
    ...(await answer(bridge, session, 1_000)),
    ...(await answer(bridge, session, 2_000)),
  ];
  const whole = (await hostTimeline(bridge))!;
  return { bridge, session, opened: result.timeline, publications, whole };
}

/** A view with fake logs, counting its resyncs; each resync replies with `reply`. */
function viewOf(
  timeline: HistoryTimeline,
  logs: Readonly<Record<string, readonly InterpreterEvent[]>>,
  reply: HistoryTimeline | null = null,
) {
  const counts = { resyncs: 0 };
  const view = new DebugHistoryView(
    timeline,
    (key) => logs[key] ?? null,
    () => {
      counts.resyncs += 1;
      return Promise.resolve(reply);
    },
  );
  return { view, counts };
}

/** The timeline `whole` was at revision `revision` with its first `count` points. */
const at = (whole: HistoryTimeline, revision: number, count: number): HistoryTimeline => ({
  ...whole,
  revision,
  points: whole.points.slice(0, count),
});

/** The delta from `from` that appends `whole`'s point `index`. */
const appending = (whole: HistoryTimeline, from: number, index: number): HistoryDelta => ({
  history: whole.history,
  enrollment: whole.enrollment,
  from,
  to: from + 1,
  appended: [whole.points[index]!],
  responses: [],
  retained: null,
  inspection: null,
  complete: true,
  memoryChars: whole.memoryChars,
  spilledCount: whole.spilledCount,
});

test("the view follows the deltas the history's publications carry, to the timeline the host reads", async () => {
  const { session, opened, publications, whole } = await hosted();
  const shown = publications.at(-1)!;
  const { view, counts } = viewOf(opened, { [shown.historyKey]: shown.events });
  let revision = -1;
  for (const publication of publications) {
    if (publication.revision === revision) continue;
    revision = publication.revision;
    view.applyAll(publication.history);
  }
  assert.equal(counts.resyncs, 0);
  assert.deepEqual(view.timeline, whole);
  // Each delta appends at most one new point: a long session costs no more per step.
  for (const publication of publications)
    for (const delta of publication.history) assert.ok(delta.appended.length <= 1);
  assert.equal(whole.points.length, 3);
  assert.deepEqual(view.logKeys, [session.historyKey]);
  assert.equal(view.eventsAt(whole.points[1]!)!.length, whole.points[1]!.eventCount);
});

test("a gap, a duplicate, a reordered delta and another history's delta are discarded and resynced", async () => {
  const { whole } = await hosted();
  const logs = { [whole.points[0]!.log]: [] };
  const base = at(whole, 10, 1);
  const second = appending(whole, 10, 1);
  const third = appending(whole, 11, 2);
  const cases: [string, readonly HistoryDelta[]][] = [
    ["a gap", [third]],
    ["a duplicate", [second, second]],
    ["reordered", [third, second]],
    ["another history's", [{ ...second, history: whole.history + 1 }]],
    ["another enrollment's", [{ ...second, enrollment: whole.enrollment + 1 }]],
  ];
  for (const [name, deltas] of cases) {
    const resynced = { ...whole, revision: 20 };
    const { view, counts } = viewOf(base, logs, resynced);
    const applied = deltas.map((delta) => view.apply(delta));
    assert.ok(applied.includes(false), name);
    assert.ok(counts.resyncs >= 1, name);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(view.timeline, resynced, `${name}: the resync replaced the timeline`);
  }
});

test("a resync older than the view, or of another history, is discarded", async () => {
  const { whole } = await hosted();
  const { view } = viewOf(at(whole, 10, 2), { [whole.points[0]!.log]: [] });
  assert.equal(view.take(at(whole, 9, 3)), false);
  assert.equal(view.take({ ...whole, revision: 12, history: whole.history + 1 }), false);
  assert.equal(view.timeline.points.length, 2);
  assert.equal(view.take({ ...whole, revision: 10 }), true);
  assert.equal(view.timeline.points.length, 3);
  // A resync that finds no history leaves the view as it was, closed.
  assert.equal(view.take(null), false);
  assert.ok(view.closed);
  assert.equal(view.apply(appending(whole, 10, 2)), false);
  assert.equal(view.timeline.points.length, 3);
});

test("a log stays while a position names it and is retired with its last reference", async () => {
  const { whole } = await hosted();
  const [first, second] = whole.points;
  const parked = { ...first!, log: "parked" };
  const restored = { ...second!, log: "restored" };
  const logs = { parked: [], restored: [] };
  const inspection = {
    points: 1,
    shown: restored,
    future: null,
    canForward: false,
    adopting: false,
  };
  const { view } = viewOf({ ...whole, revision: 1, points: [parked], inspection }, logs);
  assert.deepEqual([...view.logKeys].sort(), ["parked", "restored"]);
  const step = (from: number, change: Partial<HistoryDelta>): HistoryDelta => ({
    ...appending(whole, from, 0),
    appended: [],
    ...change,
  });
  // Return: the restored lineage is released, and no position names its log.
  assert.ok(view.apply(step(1, { inspection: null })));
  assert.deepEqual(view.logKeys, ["parked"]);
  // The parked lineage's points still name its log; truncating them retires it.
  assert.ok(view.apply(step(2, { retained: 0 })));
  assert.deepEqual(view.logKeys, []);
});

test("the grey future reads the shown and future positions' logs", async () => {
  const { publications, whole } = await hosted();
  const shown = publications.at(-1)!;
  const [first, , third] = whole.points;
  const inspection = {
    points: 1,
    shown: first!,
    future: { ...third!, eventCount: shown.events.length },
    canForward: true,
    adopting: false,
  };
  const { view } = viewOf({ ...whole, inspection }, { [first!.log]: shown.events });
  const future = rewindFutureOf(view)!;
  assert.ok(future.entries.length > 0);
  assert.ok(future.entries.every((entry) => entry.id.startsWith("future-")));
  const { view: missing } = viewOf({ ...whole, inspection }, {});
  assert.equal(rewindFutureOf(missing), null);
});

test("a change discarded while a resync is out is read again after it, without another publication", async () => {
  const { whole } = await hosted();
  const logs = { [whole.points[0]!.log]: [] };
  let release!: () => void;
  const reads: number[] = [];
  const view = new DebugHistoryView(
    at(whole, 10, 1),
    (key) => logs[key] ?? null,
    () => {
      reads.push(reads.length);
      // The first read answers with an older host state, after the newer change was discarded.
      if (reads.length === 1)
        return new Promise((resolve) => (release = () => resolve(at(whole, 11, 2))));
      return Promise.resolve(at(whole, 12, 3));
    },
  );
  assert.equal(view.apply(appending(whole, 11, 2)), false, "a gap");
  assert.equal(
    view.apply(appending(whole, 12, 2)),
    false,
    "a newer change, discarded during the read",
  );
  release();
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2);
  assert.equal(view.timeline.revision, 12);
  assert.equal(view.timeline.points.length, 3);
});
