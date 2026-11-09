import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compilePlayerProject } from "../player/runtime/compile-project.js";
import { CANNOT_KEEP, type HistoryTimeline } from "../player/engine-bridge/history/core.js";
import type { HistoryOpened, HistoryOpResult } from "../player/engine-bridge/ops/history.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import type { Introduction } from "../player/engine-bridge/session-protocol.js";
import type { PlayerBridge } from "../player/runtime/player-bridge.js";
import { playerRuntimeForeground, type PlayerSession } from "../player/runtime/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";
import { createInProcessBackend, heldRecording } from "../player/engine-bridge/in-process.js";
import { HistoryCore } from "../player/engine-bridge/history/core.js";
import { connectBridge } from "../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import { PlayerBridge as Bridge } from "../player/runtime/player-bridge.js";
import { openBridge, type ClientPort } from "../player/engine-bridge/client.js";
import {
  closeConnection,
  playerBridgeOps,
  playerOpsContext,
} from "../player/engine-bridge/player-ops.js";
import { decodeMessage } from "../player/engine-bridge/transport.js";
import {
  startBridgeHost,
  type HostPort,
  type HostSessions,
} from "../player/engine-bridge/worker-host.js";
import { DebugHistoryView } from "../player/debug/debug-history.js";

/*
 * L5i.6: Debug's rewind ops in the host (`player/engine-bridge/ops/history.ts`), over the in-process bridge: a history
 * opens for the Player's newest serial and follows its session's publications; Back, Forward and Return restore and
 * reinstate host sessions; an adoption makes the restored one live; Debug off reinstates a parked session.
 */

const START = { wallClockMs: 0 };
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
  return bridge.start(prepared.kind === "prepared" ? prepared.plan : "", START, false);
}

/** Sends history op `name`; a prepared step is committed, as the page does once it shows the candidate. */
async function op(bridge: PlayerBridge, name: string, args: unknown) {
  const reply = await bridge.client.request(name, args);
  // EVIDENCE: validation: the history ops reply from the same build with a `HistoryOpResult`.
  const result = reply.result as HistoryOpResult;
  if (result.kind !== "prepared") return { result, reply };
  const committed = await bridge.client.request("rewindCommit", {
    history: result.history,
    step: result.step,
  });
  // EVIDENCE: validation: `rewindCommit` replies from the same build with a `HistoryOpResult`.
  const settled = committed.result as HistoryOpResult;
  return { result: settled, reply };
}

async function timeline(bridge: PlayerBridge, history: number): Promise<HistoryTimeline | null> {
  const reply = await bridge.client.request("historyTimeline", { history });
  // EVIDENCE: validation: `historyTimeline` replies from the same build with a timeline or `null`.
  return reply.result as HistoryTimeline | null;
}

/** Answers the shown choice with its first option, then observes `atMs`, as the Player would. */
async function answer(
  bridge: PlayerBridge,
  session: PlayerSession,
  atMs: number,
): Promise<PlayerSession> {
  const shown = bridge.latest(session)!;
  const foreground = playerRuntimeForeground(shown);
  assert.ok(foreground?.kind === "choose");
  await bridge.request(session, "selectChoice", {
    actionId: shown.state.foregroundAction!.actionId,
    optionId: foreground.options[0]!.id,
    input: null,
  });
  await bridge.request(session, "observeTime", { atMs, media: [] });
  return bridge.latest(session)!;
}

/** A step through `bridge` as the page takes it: a prepared step is committed; the commit's result, and its candidate. */
async function committed(
  bridge: PlayerBridge,
  op: "rewindBack" | "rewindForward",
  args: unknown,
): Promise<Awaited<ReturnType<PlayerBridge["historyStep"]>>> {
  const prepared = await bridge.historyStep(op, args);
  if (prepared.result.kind !== "prepared") return prepared;
  const { history, step } = prepared.result;
  const { result } = await bridge.historyStep("rewindCommit", { history, step });
  return { result, restored: prepared.restored };
}

/** A Player's history with three points on its started session, on `bridge` (the in-process one by default). */
async function withPoints(on?: PlayerBridge) {
  const bridge = on ?? (await inProcessBridge());
  const opened = await bridge.client.request("historyOpen", { intent: 1 });
  // EVIDENCE: validation: `historyOpen` replies from the same build with `HistoryOpened`.
  assert.equal((opened.result as HistoryOpened).kind, "opened");
  const session = await started(bridge);
  await answer(bridge, session, 1_000);
  await answer(bridge, session, 2_000);
  const shown = bridge.latest(session)!;
  const points = (await timeline(bridge, 1))!.points;
  assert.equal(points.length, 3);
  return { bridge, session, shown, points };
}

/** The session a step's reply introduces, opened on the main side. */
function restoredOf(
  bridge: PlayerBridge,
  reply: { readonly session?: string | null; readonly view?: unknown },
) {
  assert.ok(typeof reply.session === "string");
  // EVIDENCE: validation: a step that restored a session replies with its introduction.
  return bridge.open(reply.session, reply.view as Introduction);
}

test("a history opens for the newest serial only, and takes a point at each newly presented interaction", async () => {
  const { bridge, shown, points } = await withPoints();
  const stale = await bridge.client.request("historyOpen", { intent: 1 });
  assert.deepEqual(stale.result, { kind: "stale" });
  assert.deepEqual(
    points.map((point) => point.sceneTimeMs),
    [0, 1_000, 2_000],
  );
  assert.equal(points[0]!.response?.text, "A1");
  // Each publication of the history's session carries the deltas it made.
  assert.ok(shown.events.length > 0);
});

test("Back restores a point in a new host session and parks the live one; the events must be the point's", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const target = points[1]!;
  const wrong = await op(bridge, "rewindBack", {
    history: 1,
    point: target.id,
    live: session.id,
    events: shown.events.slice(0, target.eventCount - 1),
  });
  assert.equal(wrong.result.kind, "refused");
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: target.id,
    live: session.id,
    events: shown.events.slice(0, target.eventCount),
  });
  assert.equal(back.result.kind, "done");
  const restored = restoredOf(bridge, back.reply);
  assert.equal(restored.state.observedSessionTimeMs, 1_000);
  assert.equal(restored.marks.rewoundWhileDebugging?.rewindCount, 1);
  const inspected = (await timeline(bridge, 1))!.inspection;
  assert.equal(inspected?.points, 2);
  assert.equal(inspected?.canForward, true);
  // The parked session is still the host's: it can be read.
  assert.equal((await bridge.read(session, "captureStorage")).revision, shown.revision);
});

test("Forward restores the parked state, and Return reinstates the parked session and releases the restored ones", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  const firstRestored = restoredOf(bridge, back.reply);
  const forward = await op(bridge, "rewindForward", { history: 1, events: shown.events });
  assert.equal(forward.result.kind, "done");
  const forwarded = restoredOf(bridge, forward.reply);
  assert.equal(forwarded.state.observedSessionTimeMs, 2_000);
  assert.ok(forward.result.kind === "done" && forward.result.released.includes(firstRestored.id));
  // Forward with no future is refused.
  assert.equal(
    (await op(bridge, "rewindForward", { history: 1, events: shown.events })).result.kind,
    "refused",
  );
  const returned = await op(bridge, "rewindReturn", { history: 1 });
  assert.ok(returned.result.kind === "done");
  assert.equal(returned.result.live, session.id);
  assert.deepEqual(returned.result.released, [forwarded.id]);
  assert.equal((await timeline(bridge, 1))!.inspection, null);
});

test("an adoption makes the restored session live, releases the parked one, and keeps the points before it", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[1]!.id,
    live: session.id,
    events: shown.events.slice(0, points[1]!.eventCount),
  });
  const restored = restoredOf(bridge, back.reply);
  assert.equal(
    (await op(bridge, "rewindAdopt", { history: 1, phase: "end", succeeded: true })).result.kind,
    "refused",
  );
  assert.equal(
    (await op(bridge, "rewindAdopt", { history: 1, phase: "begin" })).result.kind,
    "done",
  );
  const adopted = await op(bridge, "rewindAdopt", { history: 1, phase: "end", succeeded: true });
  assert.ok(adopted.result.kind === "done");
  assert.equal(adopted.result.live, restored.id);
  assert.deepEqual(adopted.result.released, [session.id]);
  assert.deepEqual(
    (await timeline(bridge, 1))!.points.map((point) => point.id),
    [points[0]!.id, points[1]!.id],
  );
  // The adopted session is the history's now: its next interaction is a point.
  await answer(bridge, restored, 2_000);
  assert.equal((await timeline(bridge, 1))!.points.length, 3);
});

test("a failed adoption leaves the restored state inspected", async () => {
  const { bridge, session, shown, points } = await withPoints();
  await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  await op(bridge, "rewindAdopt", { history: 1, phase: "begin" });
  await op(bridge, "rewindAdopt", { history: 1, phase: "end", succeeded: false });
  assert.equal((await timeline(bridge, 1))!.inspection?.adopting, false);
});

test("Debug off while inspecting reinstates the parked session and ends the history; a clear is refused then", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  const restored = restoredOf(bridge, back.reply);
  assert.equal(
    (await op(bridge, "historyClose", { history: 1, by: "clear" })).result.kind,
    "refused",
  );
  const closed = await op(bridge, "historyClose", { history: 1, by: "debugOff" });
  assert.ok(closed.result.kind === "done");
  assert.equal(closed.result.live, session.id);
  assert.deepEqual(closed.result.released, [restored.id]);
  assert.equal(await timeline(bridge, 1), null);
});

test("enrolling takes the session's current interaction as a point once, and refuses another session", async () => {
  const bridge = await inProcessBridge();
  const session = await started(bridge);
  await bridge.client.request("historyOpen", { intent: 1 });
  const enrolled = await bridge.request<HistoryOpResult>(session, "historyEnroll", { history: 1 });
  assert.equal(enrolled.kind, "done");
  assert.equal((await timeline(bridge, 1))!.points.length, 1);
  const other = await started(bridge);
  assert.equal(
    (await bridge.request<HistoryOpResult>(other, "historyEnroll", { history: 1 })).kind,
    "refused",
  );
});

test("malformed history arguments are refused", async () => {
  const bridge = await inProcessBridge();
  for (const [name, args] of [
    ["historyOpen", { intent: 0 }],
    ["historyOpen", { intent: 1, more: true }],
    ["historyClose", { history: 1, by: "later" }],
    ["rewindAdopt", { history: 1, phase: "begin", succeeded: true }],
    ["rewindBack", { history: 1, point: 1, live: 3, events: [] }],
    [
      "rewindBack",
      {
        history: 1,
        point: 1,
        live: "s1",
        events: [{ kind: "unrecognized-event", sequence: "not-a-number" }],
      },
    ],
    ["rewindForward", { history: 1, events: [{ kind: "unrecognized-event", sequence: 1 }] }],
  ] as const)
    await assert.rejects(bridge.client.request(name, args), /Malformed arguments/u, name);
});

test("an interaction answered before the history enrolled has no point; the one shown then is the first (pre-arm)", async () => {
  const bridge = await inProcessBridge();
  const session = await started(bridge);
  await answer(bridge, session, 1_000);
  await bridge.client.request("historyOpen", { intent: 1 });
  await bridge.request<HistoryOpResult>(session, "historyEnroll", { history: 1 });
  await answer(bridge, session, 2_000);
  const { points } = (await timeline(bridge, 1))!;
  assert.deepEqual(
    points.map((point) => [point.sceneTimeMs, point.response?.text ?? null]),
    [
      [1_000, "B1"],
      [2_000, null],
    ],
  );
});

test("#1981: a point's state and position are its own publication's, also while the main side lags behind the host", async () => {
  // Replies arrive late, so the host has published more than the page shows when a point is taken.
  const bridge = createInProcessBackend(
    { commit: null, dirty: null, mode: null, appVersion: null },
    { delayMs: 5 },
  );
  await bridge.client.request("historyOpen", { intent: 1 });
  const session = await started(bridge);
  // The interaction's own publication, captured as the page received it.
  const presented = bridge.latest(session)!;
  // The store's event list grows in place, so its length is taken now.
  const presentedEvents = presented.events.length;
  const later = bridge.request(session, "observeTime", { atMs: 37, media: [] });
  const [point] = (await timeline(bridge, 1))!.points;
  await later;
  assert.equal(point!.sceneTimeMs, presented.state.observedSessionTimeMs);
  assert.equal(point!.eventCount, presentedEvents);
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: point!.id,
    live: session.id,
    events: bridge.latest(session)!.events.slice(0, point!.eventCount),
  });
  const restored = restoredOf(bridge, back.reply);
  assert.equal(restored.state.observedSessionTimeMs, presented.state.observedSessionTimeMs);
  assert.deepEqual(restored.state.foregroundAction, presented.state.foregroundAction);
});

test("#1981: a publication with no interaction takes no point; the next interaction is one, at its own time", async () => {
  const bridge = await inProcessBridge();
  await bridge.client.request("historyOpen", { intent: 1 });
  const reply = await bridge.client.request("prepare", {
    source: {
      kind: "plan",
      text: serializeValidatedRuntimeJson(
        compilePlayerProject('say "a", instant\nwait 1 s\nlet a = askChoice "A1", "A2"\nexit')
          .plan!,
      ),
    },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const prepared = reply.result as PrepareResult;
  assert.ok(prepared.kind === "prepared");
  const session = await bridge.start(prepared.plan, START, false);
  assert.equal((await timeline(bridge, 1))!.points.length, 0);
  await bridge.request(session, "observeTime", { atMs: 500, media: [] });
  assert.equal((await timeline(bridge, 1))!.points.length, 0);
  await bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
  const { points } = (await timeline(bridge, 1))!;
  assert.deepEqual(
    points.map((point) => point.sceneTimeMs),
    [1_000],
  );
});

test("a point keeps its ID: after an adoption truncates later points, the next is a new ID, and Back by an old one restores it", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[1]!.id,
    live: session.id,
    events: shown.events.slice(0, points[1]!.eventCount),
  });
  const restored = restoredOf(bridge, back.reply);
  await op(bridge, "rewindAdopt", { history: 1, phase: "begin" });
  await op(bridge, "rewindAdopt", { history: 1, phase: "end", succeeded: true });
  const branch = await answer(bridge, restored, 2_000);
  const after = (await timeline(bridge, 1))!.points;
  assert.deepEqual(
    after.slice(0, 2).map((point) => point.id),
    [points[0]!.id, points[1]!.id],
  );
  assert.ok(after[2]!.id > points[2]!.id, "a removed point's ID is not taken again");
  const removed = await op(bridge, "rewindBack", {
    history: 1,
    point: points[2]!.id,
    live: restored.id,
    events: branch.events.slice(0, points[2]!.eventCount),
  });
  assert.equal(removed.result.kind, "refused", "a removed ID names no point");
  const again = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: restored.id,
    events: branch.events.slice(0, points[0]!.eventCount),
  });
  assert.equal(again.result.kind, "done");
  assert.equal(restoredOf(bridge, again.reply).state.observedSessionTimeMs, points[0]!.sceneTimeMs);
});

test("a released lineage cannot show or write: the host refuses its ops, and the page holds no store of it", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  const restored = restoredOf(bridge, back.reply);
  await bridge.historyStep("rewindReturn", { history: 1 });
  assert.equal(bridge.latest(restored), null);
  await assert.rejects(
    bridge.client.request("observeTime", { atMs: 5_000, media: [] }, { session: restored.id }),
  );
});

test("over a Worker, the timeline the page builds from the publications' deltas is the host's, through Back, Forward and Return", async () => {
  const build = { commit: null, dirty: null, mode: null, appVersion: null };
  const bridge = new Bridge(
    await connectBridge(
      nodeWorkerPort(new URL("../player/engine-bridge/node-worker.js", import.meta.url), build),
      build,
    ),
  );
  try {
    const opened = await bridge.historyOpen(bridge.nextHistoryIntent());
    assert.ok(opened.kind === "opened");
    const session = await started(bridge);
    const view = new DebugHistoryView(
      opened.timeline,
      (key) => (key === session.historyKey ? bridge.latest(session)!.events : null),
      () => assert.fail("no resync"),
    );
    view.applyAll(session.history);
    for (const atMs of [1_000, 2_000]) {
      const shownBefore = bridge.latest(session)!;
      const foreground = playerRuntimeForeground(shownBefore);
      assert.ok(foreground?.kind === "choose");
      for (const [name, args] of [
        [
          "selectChoice",
          {
            actionId: shownBefore.state.foregroundAction!.actionId,
            optionId: foreground.options[0]!.id,
            input: null,
          },
        ],
        ["observeTime", { atMs, media: [] }],
      ] as const)
        await bridge.request(session, name, args, {
          publish: (next) => view.applyAll(next.history),
        });
    }
    const host = (await timeline(bridge, opened.timeline.history))!;
    assert.deepEqual(view.timeline, host);
    assert.equal(host.points.length, 3);
    const tip = bridge.latest(session)!;
    const back = await committed(bridge, "rewindBack", {
      history: host.history,
      point: host.points[0]!.id,
      live: session.id,
      events: view.eventsAt(host.points[0]!),
    });
    assert.ok(back.result.kind === "done" && back.restored !== null);
    view.apply(back.result.delta!);
    assert.equal(back.restored.state.observedSessionTimeMs, 0);
    const forward = await committed(bridge, "rewindForward", {
      history: host.history,
      events: view.eventsAt(view.timeline.inspection!.future!),
    });
    assert.ok(forward.result.kind === "done" && forward.restored !== null);
    view.apply(forward.result.delta!);
    assert.equal(forward.restored.state.observedSessionTimeMs, tip.state.observedSessionTimeMs);
    const returned = await bridge.historyStep("rewindReturn", { history: host.history });
    assert.ok(returned.result.kind === "done");
    assert.equal(returned.result.live, session.id);
    view.apply(returned.result.delta!);
    assert.deepEqual(view.timeline, await timeline(bridge, host.history));
  } finally {
    bridge.client.terminate();
  }
});

test("a history binds by one decision: `#binds` alone sets the lineage an enrollment or a publication binds", () => {
  const source = readFileSync(
    new URL("../../player/engine-bridge/history/registry.ts", import.meta.url),
    "utf8",
  );
  const writes = source.split("\n").filter((line) => /\.bound = /u.test(line));
  assert.deepEqual(
    writes.map((line) => line.trim()),
    [
      'if (entry.bound === null && entry.core.inspectionState === "not inspecting") entry.bound = key;',
      'if (undone.kind !== "refused") entry.bound = bound;',
      "if (effects.live !== null) entry.bound = effects.live;",
    ],
    "an enrollment and a publication bind through `#binds`; a transition of the core rebinds through `#applied`; a failed publication's undo restores the binding it made (`#ownPublication`)",
  );
});

test("Back and Forward refuse events that are no interpreter events, or out of order, and change nothing", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const events = shown.events.slice(0, points[1]!.eventCount);
  for (const bad of [
    events.map((event, index) => (index === 0 ? { ...event, kind: "unrecognized-event" } : event)),
    [...events].reverse(),
  ])
    await assert.rejects(
      bridge.client.request("rewindBack", {
        history: 1,
        point: points[1]!.id,
        live: session.id,
        events: bad,
      }),
      /Malformed arguments/u,
    );
  assert.equal((await timeline(bridge, 1))!.inspection, null);
  assert.equal((await bridge.read(session, "captureStorage")).revision, shown.revision);
});

test("a later Back takes the history's own plan, and refuses a session that is not the history's", async () => {
  const { bridge, session, shown, points } = await withPoints();
  await op(bridge, "rewindBack", {
    history: 1,
    point: points[1]!.id,
    live: session.id,
    events: shown.events.slice(0, points[1]!.eventCount),
  });
  const other = await started(bridge);
  const events = shown.events.slice(0, points[0]!.eventCount);
  const unrelated = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: other.id,
    events,
  });
  assert.equal(unrelated.result.kind, "refused");
  const parked = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events,
  });
  assert.equal(parked.result.kind, "done");
  assert.equal(restoredOf(bridge, parked.reply).planToken, session.planToken);
});

test("the state the first Back leaves is kept as a point is: one that does not fit the bound refuses Back, and nothing changes", async () => {
  const build = { commit: null, dirty: null, mode: null, appVersion: null };
  // Without a spill, a bound that the history's points fit and the state Back would leave does not.
  const probe = await withPoints();
  const { points: probed, memoryChars } = (await timeline(probe.bridge, 1))!;
  const bridge = createInProcessBackend(build, {
    historySpill: async () => null,
    historyBudget: memoryChars + 1,
  });
  await bridge.client.request("historyOpen", { intent: 1 });
  const session = await started(bridge);
  await answer(bridge, session, 1_000);
  await answer(bridge, session, 2_000);
  const shown = bridge.latest(session)!;
  const { points } = (await timeline(bridge, 1))!;
  assert.equal(points.length, probed.length, "the points fit");
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  assert.deepEqual(back.result, { kind: "refused", reason: CANNOT_KEEP });
  assert.equal((await timeline(bridge, 1))!.inspection, null);
  assert.equal((await bridge.read(session, "captureStorage")).revision, shown.revision);
  // With a spill, each point leaves memory once written, so the same bound keeps the parked state too.
  const rows = new Map<number, string>();
  const withSpill = createInProcessBackend(build, {
    historySpill: async () => ({
      put: async (id, json) => void rows.set(id, json),
      get: async (id) => rows.get(id),
      delete: async (ids) => ids.forEach((id) => rows.delete(id)),
      destroy: async () => rows.clear(),
    }),
    historyBudget: memoryChars + 1,
  });
  await withSpill.client.request("historyOpen", { intent: 1 });
  const spilled = await started(withSpill);
  await answer(withSpill, spilled, 1_000);
  await answer(withSpill, spilled, 2_000);
  const tip = withSpill.latest(spilled)!;
  const kept = (await timeline(withSpill, 1))!.points;
  const step = await op(withSpill, "rewindBack", {
    history: 1,
    point: kept[0]!.id,
    live: spilled.id,
    events: tip.events.slice(0, kept[0]!.eventCount),
  });
  assert.equal(step.result.kind, "done");
});

test("connection cleanup (`teardown`) releases every session the histories hold", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  const restored = restoredOf(bridge, back.reply);
  await bridge.client.request("teardown", null);
  for (const id of [session.id, restored.id]) {
    const reply = await bridge.client.request("captureKeep", { session: id, plan: null });
    // EVIDENCE: validation: `captureKeep` replies from the same build with a `KeepCapture`.
    assert.equal((reply.result as { readonly kind: string }).kind, "gone");
  }
});

/** The anchor of the connection's recording, as JSON: where it began. */
const anchorOf = (bridge: PlayerBridge) =>
  JSON.stringify(heldRecording(bridge)?.anchorSnapshot ?? null);

test("a prepared Back holds its candidate and changes nothing else; a drop releases only the candidate", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const recording = anchorOf(bridge);
  const reply = await bridge.client.request("rewindBack", {
    history: 1,
    point: points[1]!.id,
    live: session.id,
    events: shown.events.slice(0, points[1]!.eventCount),
  });
  // EVIDENCE: validation: the history ops reply from the same build with a `HistoryOpResult`.
  const prepared = reply.result as HistoryOpResult;
  assert.ok(prepared.kind === "prepared");
  const candidate = restoredOf(bridge, reply);
  // The prepared state carries its target's marks before anything commits.
  assert.equal(candidate.marks.rewoundWhileDebugging?.rewindCount, 1);
  assert.equal((await timeline(bridge, 1))!.inspection, null, "no inspection yet");
  assert.equal(anchorOf(bridge), recording, "the recording is the shown session's still");
  assert.equal((await bridge.read(session, "captureStorage")).revision, shown.revision);
  const dropped = await bridge.historyStep("rewindDrop", { history: 1, step: prepared.step });
  assert.ok(dropped.result.kind === "done");
  assert.deepEqual(dropped.result.released, [candidate.id]);
  assert.equal((await timeline(bridge, 1))!.inspection, null);
  assert.equal((await bridge.read(session, "captureStorage")).revision, shown.revision);
  // A repeated drop releases nothing; the consumed token commits nothing.
  const again = await bridge.historyStep("rewindDrop", { history: 1, step: prepared.step });
  assert.ok(again.result.kind === "done");
  assert.deepEqual(again.result.released, []);
  const late = await bridge.historyStep("rewindCommit", { history: 1, step: prepared.step });
  assert.equal(late.result.kind, "refused");
});

test("a commit makes the candidate the inspected state and begins the recording there, once", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const reply = await bridge.client.request("rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  // EVIDENCE: validation: the history ops reply from the same build with a `HistoryOpResult`.
  const prepared = reply.result as HistoryOpResult;
  assert.ok(prepared.kind === "prepared");
  const candidate = restoredOf(bridge, reply);
  const before = anchorOf(bridge);
  const commit = await bridge.historyStep("rewindCommit", { history: 1, step: prepared.step });
  assert.ok(commit.result.kind === "done");
  assert.notEqual(anchorOf(bridge), before, "the recording began anew at the committed state");
  assert.equal((await timeline(bridge, 1))!.inspection?.points, 1);
  // The candidate is the shown state, held and usable; the parked session too.
  assert.equal(
    (await bridge.read(candidate, "captureStorage")).revision,
    bridge.latest(candidate)!.revision,
  );
  assert.equal((await bridge.read(session, "captureStorage")).revision, shown.revision);
});

test("Sol r2 S2: Debug off of an adopting history with no known outcome is refused, and both sessions stay", async () => {
  const { bridge, session, shown, points } = await withPoints();
  const back = await op(bridge, "rewindBack", {
    history: 1,
    point: points[0]!.id,
    live: session.id,
    events: shown.events.slice(0, points[0]!.eventCount),
  });
  const restored = restoredOf(bridge, back.reply);
  await op(bridge, "rewindAdopt", { history: 1, phase: "begin" });
  const closed = await bridge.historyStep("historyClose", { history: 1, by: "debugOff" });
  assert.equal(closed.result.kind, "refused");
  for (const held of [session, restored])
    assert.equal(
      (await bridge.read(held, "captureStorage")).revision,
      bridge.latest(held)!.revision,
    );
  assert.equal((await timeline(bridge, 1))!.inspection?.adopting, true);
});

/**
 * A connection assembled from the production client, host and Player ops, as the delivery families build theirs
 * (`player-bridge-delivery.test.ts`), whose port can fail the next success post of one op: that op's delivery aborts.
 */
function failingConnection() {
  const context = playerOpsContext();
  const opOf = new Map<number, string>();
  let failing: string | null = null;
  let toHost: ((data: unknown) => void) | null = null;
  let toClient: ((data: unknown) => void) | null = null;
  const hostPort: HostPort = {
    post: (message) => {
      const data = decodeMessage(structuredClone(message));
      // EVIDENCE: fixture: this port carries only the messages the host posts, each with these fields where it has them.
      const reply = data as { kind?: string; id?: number; ok?: boolean };
      if (reply.kind === "reply" && reply.ok === true && opOf.get(reply.id!) === failing) {
        failing = null;
        throw new Error("injected: the success post fails");
      }
      queueMicrotask(() => toClient?.(data));
    },
    listen: (listener) => void (toHost = listener),
  };
  let sessions: HostSessions | null = null;
  const clientPort: ClientPort = {
    post: (message) => {
      // EVIDENCE: fixture: this port carries only the client's requests, each with its ID and op.
      const request = decodeMessage(structuredClone(message)) as { id: number; op: string };
      opOf.set(request.id, request.op);
      toHost?.(request);
    },
    listen: (listener) => void (toClient = listener),
    onFailure: () => {},
    terminate: () => closeConnection(context, sessions!),
  };
  const { client } = openBridge(clientPort, {
    commit: null,
    dirty: null,
    mode: null,
    appVersion: null,
  });
  sessions = startBridgeHost(
    hostPort,
    playerBridgeOps(context),
    { commit: null, dirty: null, mode: null, appVersion: null },
    context.delivery,
  );
  return {
    bridge: new Bridge(client),
    context,
    sessions,
    /** The host sessions it holds, by the IDs it gives in order. */
    held: () =>
      Array.from({ length: 30 }, (_, index) => `s${index + 1}`).filter(
        (id) => sessions!.get(id) !== undefined,
      ),
    failPost: (op: string) => void (failing = op),
  };
}

test("a failed prepare delivery retires its candidate and its reservation; the history, the shown session and the recording stay", async () => {
  const link = failingConnection();
  const { bridge, session, shown, points } = await withPoints(link.bridge);
  const before = {
    timeline: await timeline(bridge, 1),
    held: link.held(),
    recording: link.context.recorder.recording(),
  };
  link.failPost("rewindBack");
  const back = {
    history: 1,
    point: points[1]!.id,
    live: session.id,
    events: shown.events.slice(0, points[1]!.eventCount),
  };
  await assert.rejects(bridge.client.request("rewindBack", back));
  assert.equal(link.context.history.core(1)?.pendingStep, null, "the step was dropped");
  assert.equal(link.context.history.candidates.size, 0, "no candidate is left");
  assert.deepEqual(
    {
      timeline: await timeline(bridge, 1),
      held: link.held(),
      recording: link.context.recorder.recording(),
    },
    before,
    "the history, the host's sessions and the recording are as they were",
  );
  // The reservation went with it: the same Back is admitted again, and commits.
  const again = await op(bridge, "rewindBack", back);
  assert.equal(again.result.kind, "done");
});

test("a failed commit reply undoes nothing: the transfer stands, and the candidate stays the history's", async () => {
  const link = failingConnection();
  const { bridge, session, shown, points } = await withPoints(link.bridge);
  const prepared = await bridge.historyStep("rewindBack", {
    history: 1,
    point: points[1]!.id,
    live: session.id,
    events: shown.events.slice(0, points[1]!.eventCount),
  });
  assert.equal(prepared.result.kind, "prepared");
  assert.ok(prepared.restored !== null);
  const step = prepared.result.kind === "prepared" ? prepared.result.step : -1;
  link.failPost("rewindCommit");
  await assert.rejects(bridge.client.request("rewindCommit", { history: 1, step }));
  const inspected = (await timeline(bridge, 1))!.inspection;
  assert.equal(inspected?.shown.id, points[1]!.id, "the restored state is the one inspected");
  // The candidate and the parked session are both held: the candidate can be read, and Forward restores the parked state.
  assert.equal(
    (await bridge.read(prepared.restored, "captureStorage")).revision,
    prepared.restored.revision,
  );
  assert.equal((await bridge.read(session, "captureStorage")).revision, shown.revision);
  const forward = await committed(bridge, "rewindForward", { history: 1, events: shown.events });
  assert.equal(forward.result.kind, "done");
});

/** The publishing ops whose replies fail in the rows below, each as the Player sends it. */
const PUBLISHING = ["answer", "time skip", "followed start"] as const;
type Publishing = (typeof PUBLISHING)[number];

/** A history's points by ID and response, and the lineage it follows, as the host keeps them. */
async function historyOf(link: ReturnType<typeof failingConnection>) {
  const points = ((await timeline(link.bridge, 1))?.points ?? []).map((point) => ({
    id: point.id,
    response: point.response?.text ?? null,
  }));
  return { points, bound: link.context.history.bound(1) };
}

/**
 * One publishing op whose reply fails, after what precedes it shown: the history keeps no point, link or binding of
 * it; Back restores the last point the page was shown; and the session's next publication takes that point again.
 */
async function publicationRow(op: Publishing): Promise<void> {
  for (const then of ["Back", "next publication"] as const) {
    const link = failingConnection();
    const { bridge } = link;
    await bridge.client.request("historyOpen", { intent: 1 });
    const reply = await bridge.client.request("prepare", {
      source: {
        kind: "plan",
        text: serializeValidatedRuntimeJson(compilePlayerProject(SCRIPT).plan!),
      },
    });
    // EVIDENCE: validation: `prepare` replies from the same build with its result.
    const token = (reply.result as PrepareResult & { kind: "prepared" }).plan;
    let session: PlayerSession | null = null;
    if (op !== "followed start") {
      session = await bridge.start(token, START, false);
      // A time skip follows an answer the page was shown.
      if (op === "time skip") {
        const shown = bridge.latest(session)!;
        const foreground = playerRuntimeForeground(shown);
        assert.ok(foreground?.kind === "choose");
        await bridge.request(session, "selectChoice", {
          actionId: shown.state.foregroundAction!.actionId,
          optionId: foreground.options[0]!.id,
          input: null,
        });
      }
    }
    const before = await historyOf(link);
    const shown = session === null ? null : bridge.latest(session)!;
    // The op, whose success reply fails to post: its delivery aborts.
    const opName = op === "answer" ? "selectChoice" : op === "time skip" ? "observeTime" : "start";
    link.failPost(opName);
    if (op === "followed start") await assert.rejects(bridge.start(token, START, false));
    else if (op === "answer") {
      const foreground = playerRuntimeForeground(shown!);
      assert.ok(foreground?.kind === "choose");
      await assert.rejects(
        bridge.request(session!, "selectChoice", {
          actionId: shown!.state.foregroundAction!.actionId,
          optionId: foreground.options[0]!.id,
          input: null,
        }),
      );
    } else
      await assert.rejects(bridge.request(session!, "observeTime", { atMs: 1_000, media: [] }));
    assert.deepEqual(
      await historyOf(link),
      before,
      `${op}: no point, link or binding of it is kept`,
    );
    if (then === "Back") {
      if (shown === null) continue;
      // The last point the page was shown, which the history still leaves.
      const last = before.points.at(-1)!;
      const point = (await timeline(bridge, 1))!.points.find((each) => each.id === last.id)!;
      const stepped = await committed(bridge, "rewindBack", {
        history: 1,
        point: last.id,
        live: session!.id,
        events: shown.events.slice(0, point.eventCount),
      });
      assert.equal(stepped.result.kind, "done", `${op}: Back restores the last point shown`);
      continue;
    }
    // The session's next publication, or the Start again, takes the point the failed op's did not keep.
    if (op === "followed start") {
      const started = await bridge.start(token, START, false);
      const after = await historyOf(link);
      assert.equal(after.points.length, 1, `${op}: the Start again takes its point`);
      assert.equal(after.bound, started.historyKey, `${op}: and binds the history to its lineage`);
    } else {
      // Sent with no basis, as the page that never saw the failed reply has none for the host's revision.
      await bridge.client.request(
        "observeTime",
        { atMs: 1_000, media: [] },
        { session: session!.id },
      );
      const after = await historyOf(link);
      assert.equal(after.points.length, 2, `${op}: the next publication takes the next point`);
      assert.equal(
        after.points[0]!.response,
        "A1",
        `${op}: and links the answer to the point before`,
      );
      assert.equal(after.bound, before.bound, `${op}: on the lineage it followed`);
    }
  }
}

for (const op of PUBLISHING)
  test(`a ${op} whose reply fails keeps no point of it: Back restores the last point shown, and the next publication takes it`, () =>
    publicationRow(op));

test("a publishing op's undo is the history's: without it, its rows fail (negative control)", async () => {
  // Dropped: the core refuses every undo, as if none had been registered.
  const advance = Object.getOwnPropertyDescriptor(HistoryCore.prototype, "advance")!;
  const original = HistoryCore.prototype.advance;
  Object.defineProperty(HistoryCore.prototype, "advance", {
    ...advance,
    value(this: HistoryCore, observation: Parameters<HistoryCore["advance"]>[0]) {
      return observation.kind === "undoPublication"
        ? { kind: "refused", reason: "the undo is dropped" }
        : original.call(this, observation);
    },
  });
  try {
    for (const op of PUBLISHING)
      await assert.rejects(publicationRow(op), assert.AssertionError, op);
  } finally {
    Object.defineProperty(HistoryCore.prototype, "advance", advance);
  }
});
