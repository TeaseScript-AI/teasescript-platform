import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { beginRecordingNow, heldPlan, heldRecording } from "../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import { startBridgeHost, type HostPort } from "../player/engine-bridge/worker-host.js";
import { playerBridgeOps } from "../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../player/player-bridge.js";
import {
  observePlayerRuntimeTime,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSessionAt,
  stepPlayerRuntimeTime,
} from "../player/runtime-adapter.js";
import type { PlayerSession } from "../player/runtime-view.js";
import { PublicationGapError, SessionStore } from "../player/session-store.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { hatch, inProcessBridge, introduced } from "./helpers/in-process-bridge.js";

/*
 * L5b's bridge: the session ops (Start, Continue, time, catch-up, pacing), the reply contract (each publication's
 * revision and event cursor), the in-process backend's facade, the host's recorder, and the Player error stop's fence.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const TEMPORAL = DEFAULT_TEMPORAL_CONTEXT;

/** A script with timers, says, pacing and a random draw: everything L5b's ops drive. */
const SCRIPT = [
  "let n = randomInteger(1..=6)",
  'say "rolled ${n}"',
  "wait 2 s",
  'timer async 3 s { say "tick", instant }',
  "wait 5 s",
  'say "late", instant',
  'let go = askChoice "Go"',
  'say "done ${go}", instant',
  "exit",
].join("\n");

/** Holds `script`'s plan in the bridge's host through `prepare`, as a published plan; returns its token. */
async function prepared(bridge: PlayerBridge, script: string): Promise<string> {
  const plan = compilePlayerProject(script).plan;
  assert.ok(plan);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

/** What a session shows, comparable across backends. */
const shown = (session: PlayerSession) => ({
  revision: session.revision,
  state: session.state,
  events: [...session.events],
  transcript: session.transcriptEntries.map((entry) => entry.text),
});

/** A tape of L5b's ops on one session, each step's result and the session it shows after it. */
async function playTape(bridge: PlayerBridge): Promise<unknown[]> {
  const plan = await prepared(bridge, SCRIPT);
  let session = await bridge.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
  const steps: unknown[] = [shown(session)];
  const send = async (op: string, args: unknown) => {
    const result = await bridge.request(session, op, args);
    session = bridge.latest(session)!;
    steps.push({ op, result, session: shown(session) });
  };
  // A pacing skip for an action the session does not present changes nothing.
  await send("skipPacing", { actionId: -1 });
  await send("observeTime", { atMs: 1_000, media: [] });
  await send("stepTime", { targetMs: 2_500 });
  // A late observation caught up one step per request (`budgetMs: 0`), so both backends take the same steps.
  await send("beginCatchUp", { targetMs: 9_000 });
  for (let step = 0; step < 20; step += 1) {
    const result = await bridge.request(session, "stepCatchUp", { budgetMs: 0 });
    steps.push({ op: "stepCatchUp", result });
    if (result !== "more") break;
  }
  await send("adoptCatchUp", null);
  await send("observeTime", { atMs: 9_500, media: [] });
  // A stale basis is refused without effect, as `basis` names a revision an op since replaced.
  await assert.rejects(
    bridge.request(session, "observeTime", { atMs: 9_600, media: [] }, { basis: 1 }),
    (error: unknown) => error instanceof BridgeRequestError && error.code === "basis",
  );
  steps.push(shown(bridge.latest(session)!));
  return steps;
}

test("L5b's ops give the same replies, publications and events in-process and in a Worker", async () => {
  const inProcess = await inProcessBridge();
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    assert.deepEqual(await playTape(worker), await playTape(inProcess));
  } finally {
    worker.client.terminate();
  }
});

test("a synchronous op runs and replies before its post returns; an async one makes later requests wait", async () => {
  const posted: unknown[] = [];
  let deliver: (data: unknown) => void = () => {};
  const port: HostPort = {
    post: (message) => posted.push(message),
    listen: (listener) => void (deliver = listener),
  };
  startBridgeHost(port, playerBridgeOps(), BUILD);
  posted.length = 0;
  deliver({ v: 1, kind: "request", id: 1, session: null, basis: null, op: "teardown", args: null });
  assert.equal(posted.length, 1, "the synchronous op replied within its post");
  deliver({
    v: 1,
    kind: "request",
    id: 2,
    session: null,
    basis: null,
    op: "prepare",
    args: { source: { kind: "source", script: 'say "x"\nexit' } },
  });
  deliver({ v: 1, kind: "request", id: 3, session: null, basis: null, op: "teardown", args: null });
  // The source compiles after the compiler loads; the teardown behind it waits, in arrival order.
  assert.equal(posted.length, 1);
  for (let turn = 0; posted.length < 3 && turn < 200; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    posted.map((reply) =>
      typeof reply === "object" && reply !== null && "id" in reply ? reply.id : null,
    ),
    [1, 2, 3],
  );
});

test("a store applies publications by revision and requires their events to continue its cursor", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge, SCRIPT);
  const { state } = await bridge.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
  const store = new SessionStore("s1", bridge, {
    revision: 1,
    state,
    from: 0,
    eventsThrough: 0,
    events: [],
    planToken: plan,
    metadata: null,
    liveEventSequence: 0,
  });
  const publication = (revision: number, from: number, eventsThrough: number) => ({
    revision,
    state,
    from,
    eventsThrough,
    events: [],
  });
  // An eventless publication still applies: its revision is new.
  assert.equal(store.apply(publication(2, 0, 0)), true);
  // The same revision again, and an older one, are dropped.
  assert.equal(store.apply(publication(2, 0, 0)), false);
  assert.equal(store.apply(publication(1, 0, 0)), false);
  // A newer one whose events do not continue the cursor is a gap, never merged.
  assert.throws(() => store.apply(publication(3, 4, 5)), PublicationGapError);
  assert.equal(store.session.revision, 2);
  store.halt();
  assert.equal(store.apply(publication(3, 0, 0)), false);
});

test("a hatch call delivers its session's replies still in transit first, so no publication overtakes another", async () => {
  const bridge = await inProcessBridge(50);
  const plan = await prepared(bridge, SCRIPT);
  const session = await bridge.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
  // A: an eventless observation, whose reply is still in transit.
  const a = bridge.request(session, "observeTime", { atMs: 100, media: [] });
  // B: an eventless observation through the facade, which delivers A first.
  const b = hatch(session, (held) => observePlayerRuntimeTime(held, 200, []));
  assert.equal(b.outcome.kind, "observed");
  assert.equal(b.session.revision, session.revision + 2);
  assert.equal(b.session.state.observedSessionTimeMs, 200);
  await a;
  // C: a later reply continues from B.
  await bridge.request(b.session, "observeTime", { atMs: 300, media: [] });
  const c = bridge.latest(session)!;
  assert.equal(c.revision, session.revision + 3);
  assert.equal(c.state.observedSessionTimeMs, 300);
  assert.deepEqual(
    c.events.map((event) => event.sequence),
    [...new Set(c.events.map((event) => event.sequence))],
    "no event twice",
  );
});

test("a request queued behind prepare is refused only if a hatch call since changed the state", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge, SCRIPT);
  const session = await bridge.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
  const compile = () =>
    bridge.client.request("prepare", { source: { kind: "source", script: 'say "x"\nexit' } });
  // H changes nothing (time does not move): Q, queued behind P, stays accepted.
  const p1 = compile();
  const q1 = bridge.request(session, "observeTime", { atMs: 100, media: [] });
  const unchanged = hatch(session, (held) =>
    stepPlayerRuntimeTime(held, held.state.observedSessionTimeMs),
  );
  assert.equal(unchanged.revision, session.revision);
  await p1;
  const accepted = await q1;
  assert.ok(typeof accepted === "object" && accepted !== null && "kind" in accepted);
  assert.equal(accepted.kind, "observed");
  // H changes the state: Q, queued behind P with the basis before it, is refused without effect.
  const before = bridge.latest(session)!;
  const p2 = compile();
  const q2 = bridge.request(before, "observeTime", { atMs: 900, media: [] });
  const changed = hatch(before, (held) => observePlayerRuntimeTime(held, 500, []));
  await p2;
  await assert.rejects(
    q2,
    (error: unknown) => error instanceof BridgeRequestError && error.code === "basis",
  );
  assert.equal(bridge.latest(session)!.revision, changed.session.revision);
  assert.equal(bridge.latest(session)!.state.observedSessionTimeMs, 500);
});

test("a deadline observation that loses to an op has no effect: state, events, draws and revision as without it", async () => {
  const play = async (withLateObservation: boolean) => {
    const bridge = await inProcessBridge(50);
    const plan = await prepared(bridge, SCRIPT);
    const session = await bridge.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
    // The op's section holds the session; a deadline observation made from the same revision waits behind it.
    const section = bridge.section(session, (send) =>
      send.send("observeTime", { atMs: 1_000, media: [] }),
    );
    const late = withLateObservation
      ? bridge.request(session, "observeTime", { atMs: 700, media: [] }).then(
          () => "applied",
          (error: unknown) => (error instanceof BridgeRequestError ? error.code : "failed"),
        )
      : Promise.resolve("basis");
    await section;
    assert.equal(await late, "basis");
    const latest = bridge.latest(session)!;
    return { shown: shown(latest), snapshot: hatch(latest, playerRuntimeSnapshot) };
  };
  assert.deepEqual(await play(true), await play(false));
});

test("each transitional factory gets a new session, its plan's token, its history and the host's recorder", async () => {
  const bridge = await inProcessBridge();
  const started = introduced(bridge, createPlayerRuntimeSession(SCRIPT));
  // A restore brings a plan of its own and the events before it.
  const source = hatch(started, (held) => observePlayerRuntimeTime(held, 1_000, [])).session;
  const json = hatch(source, (held) => JSON.stringify(playerRuntimeSnapshot(held)));
  let recorderSeen: unknown = null;
  const plan = heldPlan(bridge, source.planToken);
  const adapterRestored = restorePlayerRuntimeSessionAt(plan, json, source.events);
  const restored = introduced(bridge, adapterRestored);
  assert.notEqual(restored.id, started.id);
  assert.equal(
    restored.planToken === started.planToken,
    adapterRestored.plan === plan,
    "a session keeps its plan's token only when it runs that plan object",
  );
  assert.deepEqual(restored.events, source.events);
  assert.deepEqual(restored.transcriptEntries, adapterRestored.transcriptEntries);
  assert.equal(restored.liveEventSequence, adapterRestored.liveEventSequence);
  // A factory receives the connection's recorder.
  const { introduceNow } = await import("../player/engine-bridge/in-process.js");
  introduceNow(bridge, (host) => {
    recorderSeen = host.recorder;
    return createPlayerRuntimeSession(SCRIPT, { recorder: host.recorder });
  });
  assert.ok(recorderSeen);
  assert.equal(heldRecording(bridge)?.complete, true);
});

test("restore, beginRecording, Continue, a throw: the session recovers from the host's recorder", async () => {
  const bridge = await inProcessBridge();
  // With the scope IDs used up, a timer block throws in its middle (as in the recorder's own tests).
  const script = [
    "timer async 1 s {",
    '  say "before", instant',
    "  if true {",
    '    say "deep", instant',
    "  }",
    "}",
    'let pick = askChoice "Again"',
    "exit",
  ].join("\n");
  const started = createPlayerRuntimeSession(script);
  const snapshot = { ...playerRuntimeSnapshot(started), nextScopeId: Number.MAX_SAFE_INTEGER - 1 };
  const restored = introduced(
    bridge,
    restorePlayerRuntimeSessionAt(started.plan, JSON.stringify(snapshot), started.events),
  );
  await bridge.request(restored, "beginRecording", null);
  await bridge.request(restored, "continue", {
    capture: { wallClockMs: 0, temporalContext: TEMPORAL },
  });
  const before = bridge.latest(restored)!;
  await assert.rejects(
    bridge.request(before, "observeTime", { atMs: 1_000, media: [] }),
    (error: unknown) =>
      error instanceof BridgeRequestError && error.kind === "engine" && error.ended,
  );
  // The host kept the session: its next use rebuilds the runner from the recorder, at the publication shown.
  const later = await bridge.request<{ readonly kind: string }>(before, "observeTime", {
    atMs: 500,
    media: [],
  });
  assert.equal(later.kind, "observed");
  // The recording began at the restored state, kept Continue, and froze at the call that threw.
  const recording = heldRecording(bridge)!;
  assert.equal(recording.operations[0]?.kind, "recordContinueCapture");
  assert.equal(recording.operations.at(-1)?.thrown, "RuntimeDataError");
  // The facade begins a recording the same way, synchronously.
  beginRecordingNow(bridge.latest(restored)!);
  assert.equal(heldRecording(bridge)?.operations.length, 0);
});

test("at a Player error stop, a request queued behind prepare is refused and a reply in transit never shows", async () => {
  const halted = (error: unknown) => error instanceof BridgeRequestError && error.code === "halted";
  // A request queued in the host behind an async prepare: the host takes `halt` ahead of its queue and refuses it.
  const host = await inProcessBridge();
  const plan = await prepared(host, SCRIPT);
  const stopping = await host.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
  const compiling = host.client.request("prepare", {
    source: { kind: "source", script: 'say "x"\nexit' },
  });
  const queued = host.request(stopping, "observeTime", { atMs: 200, media: [] });
  host.halt(stopping);
  await assert.rejects(queued, halted);
  await compiling;
  assert.equal(
    hatch(stopping, (held) => held.state.observedSessionTimeMs),
    0,
    "the queued observation never ran",
  );

  // A reply in transit: its publication is fenced at the store, and its request rejects as `halted`.
  const delayed = await inProcessBridge(50);
  const delayedPlan = await prepared(delayed, SCRIPT);
  const session = await delayed.start(
    delayedPlan,
    { wallClockMs: 0, temporalContext: TEMPORAL },
    false,
  );
  const inTransit = delayed.request(session, "observeTime", { atMs: 100, media: [] });
  delayed.halt(session);
  await assert.rejects(inTransit, halted);
  assert.equal(delayed.latest(session)!.revision, session.revision, "nothing shows after the stop");
});
