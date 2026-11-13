import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import {
  BridgeRequestError,
  connectBridge,
  type BridgeClient,
} from "../../player/engine-bridge/client.js";
import {
  beginRecordingNow,
  heldPlan,
  heldRecording,
  introduceNow,
} from "../helpers/bridge/in-process.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import { startBridgeHost, type HostPort } from "../../player/engine-bridge/worker-host.js";
import { playerBridgeOps, playerOpsContext } from "../../player/engine-bridge/player-ops.js";
import { ForeignSessionError, PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  observePlayerRuntimeTime,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSessionAt,
  stepPlayerRuntimeTime,
} from "../../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeForeground,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import { PublicationGapError, SessionStore } from "../../player/persistence/session-store.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { cloneGraphDifference } from "../helpers/clone-graph.js";
import { viewCalls, viewed, withoutViews } from "../helpers/debug-readers.js";
import { hatch, inProcessBridge, introduced } from "../helpers/in-process-bridge.js";
import { NO_MARKS } from "../../player/debug/debug-history-marks.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import type * as Clock from "../../player/vue/src/session/useRuntimeSceneClock.js";
import { asMalformed, untypedBridge } from "../helpers/bridge/untyped.js";

/*
 * L5b's bridge: the session ops (Start, Continue, time, catch-up, pacing), the reply contract (each publication's
 * revision and event cursor), the in-process backend's facade, the host's recorder, and the Player error stop's fence.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
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

/**
 * A tape of L5b's ops on one session, each step's result and the session it shows after it, with what Debug's readers
 * give for it (`viewed`), with the call view on (`calls`) or off.
 */
async function playTape(bridge: PlayerBridge, calls = false): Promise<unknown[]> {
  const plan = await prepared(bridge, SCRIPT);
  let session = await bridge.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
  if (calls) session = await viewCalls(bridge, session, true);
  const seen = (current: PlayerSession) => ({ ...shown(current), viewed: viewed(current) });
  const steps: unknown[] = [seen(session)];
  const send = async (op: string, args: unknown) => {
    const result = await untypedBridge(bridge).request(session, op, args);
    session = bridge.latest(session)!;
    steps.push({ op, result, session: seen(session) });
  };
  // A pacing skip for an action the session does not present changes nothing.
  await send("skipPacing", { actionId: -1 });
  await send("observeTime", { atMs: 1_000, media: [] });
  await send("stepTime", { targetMs: 2_500 });
  // A late observation caught up one step per request (`budgetMs: 0`), so every run takes the same steps.
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
  steps.push(seen(bridge.latest(session)!));
  return steps;
}

test("the driver and time ops (#1856) show the same critical view with and without the call view, in a Worker", async () => {
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    const critical = await playTape(worker);
    // With the call view (L5f) the critical view is the same.
    const full = await playTape(worker, true);
    assert.deepEqual(withoutViews(full), withoutViews(critical));
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
  const context = playerOpsContext();
  startBridgeHost(port, playerBridgeOps(context), BUILD, context.delivery);
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
  // The source prepared: the order held for a successful asynchronous op.
  assert.deepEqual(
    posted.map((reply) =>
      typeof reply === "object" && reply !== null && "ok" in reply ? reply.ok : null,
    ),
    [true, true, true],
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
    instructions: {},
    callView: null,
    marks: NO_MARKS,
    diagnostic: { run: null, stop: null },
    incident: null,
    history: [],
    planToken: plan,
    metadata: null,
    liveEventSequence: 0,
    historyKey: "l0",
  });
  const publication = (revision: number, from: number, eventsThrough: number) => ({
    revision,
    state,
    from,
    eventsThrough,
    events: [],
    instructions: {},
    callView: null,
    marks: NO_MARKS,
    diagnostic: { run: null, stop: null },
    incident: null,
    history: [],
  });
  // An eventless publication still applies: its revision is new.
  assert.equal(store.apply(publication(2, 0, 0)), true);
  // The same revision again, and an older one, are dropped.
  assert.equal(store.apply(publication(2, 0, 0)), false);
  assert.equal(store.apply(publication(1, 0, 0)), false);
  // A newer one whose events do not continue the cursor is a gap, never merged.
  assert.throws(() => store.apply(publication(3, 4, 5)), PublicationGapError);
  assert.equal(store.session.revision, 2);
  // Stopping still applies what the host ran; frozen, nothing more.
  store.stopping();
  assert.equal(store.apply(publication(3, 0, 0)), true);
  store.freeze();
  assert.equal(store.apply(publication(4, 0, 0)), false);
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
    const section = bridge.section(session, clockTicket(), (send) =>
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

/** Another module's key named as the ticket's is: a value keyed by it is no ticket. */
const foreignTicketKey: unique symbol = Symbol("ClockTicket");

test("a section without a clock ticket fails type-checking at both levels; a check-disabling construct or a ticket a client wrapper kept is not decided (#1983)", () => {
  // Typed, never called: what the type check decides. Where a ticket came from it does not decide (`ClockTicket`).
  const typed = (
    bridge: PlayerBridge,
    client: BridgeClient,
    session: PlayerSession,
    clock: typeof Clock,
  ) => {
    const body = async () => {};
    // @ts-expect-error -- no ticket.
    void bridge.section(session, body);
    // @ts-expect-error -- no ticket.
    void client.section(session.id, body);
    // @ts-expect-error -- an empty object is no ticket.
    void bridge.section(session, {}, body);
    // @ts-expect-error -- a value keyed by another symbol is no ticket.
    void bridge.section(session, { [foreignTicketKey]: true }, body);
    // @ts-expect-error -- as above, at the client.
    void client.section(session.id, { [foreignTicketKey]: true }, body);
    // @ts-expect-error -- the clock exports no mint, so no module forwards one.
    void clock.mintClockTicket;
  };
  assert.equal(typeof typed, "function");
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
  introduceNow(
    bridge,
    (host) => {
      recorderSeen = host.recorder;
      return createPlayerRuntimeSession(SCRIPT, { recorder: host.recorder });
    },
    NO_MARKS,
  );
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
  const later = await bridge.request(before, "observeTime", { atMs: 500, media: [] });
  assert.equal(later.kind, "observed");
  // The recording began at the restored state, kept Continue, and froze at the call that threw.
  const recording = heldRecording(bridge)!;
  assert.equal(recording.operations[0]?.kind, "recordContinueCapture");
  assert.equal(recording.operations.at(-1)?.thrown, "RuntimeDataError");
  // The facade begins a recording the same way, synchronously.
  beginRecordingNow(bridge.latest(restored)!);
  assert.equal(heldRecording(bridge)?.operations.length, 0);
});

/** What a stopped session shows, and what its host and recording hold: their scene times and revision. */
function stopLine(bridge: PlayerBridge, session: PlayerSession) {
  const shown = bridge.latest(session)!;
  const recording = heldRecording(bridge);
  return {
    shown: [shown.revision, shown.state.observedSessionTimeMs, shown.events.length],
    host: hatch(shown, (held) => [
      held.revision,
      held.state.observedSessionTimeMs,
      held.events.length,
    ]),
    export: hatch(shown, (held) => playerRuntimeSnapshot(held).observedSessionTimeMs),
    recording: recording?.endSnapshot?.observedSessionTimeMs ?? null,
  };
}

for (const delayMs of [0, 50, 250])
  test(`at a Player error stop, what shows is what the host ran, and nothing it had not run (${delayMs} ms)`, async () => {
    const halted = (error: unknown) =>
      error instanceof BridgeRequestError && error.code === "halted";
    // An observation the host ran, whose reply is in transit at the stop: it shows, as the export and recording hold.
    const bridge = await inProcessBridge(delayMs);
    const plan = await prepared(bridge, SCRIPT);
    const session = await bridge.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, true);
    const ran = bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
    await bridge.halt(session);
    await ran;
    const line = stopLine(bridge, session);
    assert.deepEqual(line.shown, line.host, "the UI shows what the host ran");
    assert.equal(line.shown[1], 1_000);
    assert.equal(line.export, 1_000);
    assert.equal(line.recording, 1_000);

    // A request queued behind an async prepare when `halt` arrives: refused, with no effect on the export.
    const other = await inProcessBridge(delayMs);
    const otherPlan = await prepared(other, SCRIPT);
    const stopping = await other.start(
      otherPlan,
      { wallClockMs: 0, temporalContext: TEMPORAL },
      true,
    );
    const compiling = other.client.request("prepare", {
      source: { kind: "source", script: 'say "x"\nexit' },
    });
    const queued = other.request(stopping, "observeTime", { atMs: 2_000, media: [] });
    await other.halt(stopping);
    await assert.rejects(queued, halted);
    await compiling;
    const untouched = stopLine(other, stopping);
    assert.deepEqual(untouched.shown, untouched.host);
    assert.equal(untouched.export, 0, "the queued observation never ran");
    assert.equal(untouched.recording, 0);
  });

test("over a Worker, a stop's acknowledgement follows the replies to what the host ran before it", async () => {
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    const plan = await prepared(worker, SCRIPT);
    const session = await worker.start(plan, { wallClockMs: 0, temporalContext: TEMPORAL }, false);
    const ran = worker.request(session, "observeTime", { atMs: 1_000, media: [] });
    const stop = worker.halt(session);
    // The stop is no faster than a round trip: the store freezes only at the acknowledgement.
    assert.equal(worker.frozen(session), false);
    await stop;
    await ran;
    assert.equal(worker.frozen(session), true);
    assert.equal(worker.latest(session)!.state.observedSessionTimeMs, 1_000);
    await assert.rejects(
      worker.request(session, "observeTime", { atMs: 2_000, media: [] }),
      (error: unknown) => error instanceof BridgeRequestError && error.code === "halted",
    );
  } finally {
    worker.client.terminate();
  }
});

test("Start and Continue take a wall clock's moment anywhere in years 0000–9999, also before 1970", async () => {
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    for (const bridge of [await inProcessBridge(), worker]) {
      const plan = await prepared(bridge, "say getAbsoluteDateTime().toISO(), instant\nexit");
      const before = await bridge.start(
        plan,
        { wallClockMs: -1, temporalContext: TEMPORAL },
        false,
      );
      assert.deepEqual(
        before.transcriptEntries.map((entry) => entry.text),
        ["1969-12-31T23:59:59.999Z"],
      );
      for (const wallClockMs of [Number.MIN_SAFE_INTEGER, 0.5])
        await assert.rejects(
          bridge.start(plan, { wallClockMs, temporalContext: TEMPORAL }, false),
          (error: unknown) => error instanceof BridgeRequestError && error.code === "arguments",
        );
    }
    const bridge = await inProcessBridge();
    const restored = introduced(bridge, createPlayerRuntimeSession('showButton "Next"\nexit'));
    await bridge.request(restored, "beginRecording", null);
    const outcome = await bridge.request(restored, "continue", {
      capture: { wallClockMs: -62_167_219_200_000, temporalContext: TEMPORAL },
    });
    assert.equal(outcome.kind, "recorded");
  } finally {
    worker.client.terminate();
  }
});

/** A value `levels` engine lists deep, as a stored value. */
function deepStored(levels: number): SerializableRuntimeValue {
  let value: SerializableRuntimeValue = 1;
  for (let level = 0; level < levels; level += 1) value = { kind: "list", items: [value] };
  return value;
}

/** How many levels `value` nests through own enumerable keys, iteratively. */
function nesting(value: unknown): number {
  let deepest = 0;
  const work: [unknown, number][] = [[value, 1]];
  while (work.length > 0) {
    const [item, depth] = work.pop()!;
    if (typeof item !== "object" || item === null) continue;
    deepest = Math.max(deepest, depth);
    for (const child of Object.values(item)) work.push([child, depth + 1]);
  }
  return deepest;
}

/**
 * Deep script values (#1877): 10,000 lists in state, in a pending save, in a stored value at Start, and in replies; and
 * a Debug storage edit 2,000 lists deep.
 */
const DEEP = 10_000;
const DEEP_SCRIPT = [
  'let open = ""',
  'let close = ""',
  `for i in 1..${DEEP} {`,
  '  open += "["',
  '  close += "]"',
  "}",
  'let deep = fromJson(open + "1" + close, default: null)',
  "wait 1 s",
  'save deep as "deep"',
  "wait 4 s",
  'let go = askChoice "Go"',
  "exit",
].join("\n");

/** L5b's ops on the deep script, each step's result and what the session shows after it. */
async function playDeepTape(bridge: PlayerBridge): Promise<unknown[]> {
  const plan = await prepared(bridge, DEEP_SCRIPT);
  let session = await bridge.start(
    plan,
    {
      wallClockMs: 0,
      temporalContext: TEMPORAL,
      scriptStorage: [{ key: "stored", value: deepStored(DEEP) }],
      persistentScriptStorage: true,
    },
    false,
  );
  const steps: unknown[] = [shown(session)];
  const send = async (op: string, args: unknown) => {
    const result = await untypedBridge(bridge).request(session, op, args);
    session = bridge.latest(session)!;
    steps.push({ op, result, session: shown(session) });
  };
  await send("observeTime", { atMs: 500, media: [] });
  // Debug's storage edit (L5c's op) with a value 2,000 lists deep, before the script's save is pending.
  await send("applyStorageEdit", { key: "edited", value: deepStored(2_000) });
  await send("observeTime", { atMs: 1_000, media: [] });
  await send("stepTime", { targetMs: 2_000 });
  await send("beginCatchUp", { targetMs: 6_000 });
  for (let step = 0; step < 20; step += 1) {
    const result = await bridge.request(session, "stepCatchUp", { budgetMs: 0 });
    steps.push({ op: "stepCatchUp", result });
    if (result !== "more") break;
  }
  await send("adoptCatchUp", null);
  return steps;
}

test("deep script values give the same replies, publications and events in-process and in a Worker", async () => {
  const inProcess = await inProcessBridge();
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    const tape = await playDeepTape(inProcess);
    assert.equal(cloneGraphDifference(await playDeepTape(worker), tape), null);
    // Start's request carried the deep stored value; the replies after the save carry the script's pending save.
    assert.ok(nesting(tape.slice(2)) > 2 * DEEP, "the replies carry the deep save");
    const edit = tape.find(
      (step) =>
        typeof step === "object" && step !== null && "op" in step && step.op === "applyStorageEdit",
    );
    const result =
      typeof edit === "object" && edit !== null && "result" in edit ? edit.result : null;
    assert.ok(typeof result === "object" && result !== null && "kind" in result);
    assert.equal(result.kind, "applied", "the deep edit applied");
  } finally {
    worker.client.terminate();
  }
});

for (const delayMs of [0, 50])
  test(`a deep reply in transit reaches the store before a stop freezes it (${delayMs} ms)`, async () => {
    const bridge = await inProcessBridge(delayMs);
    const plan = await prepared(bridge, DEEP_SCRIPT);
    const session = await bridge.start(
      plan,
      { wallClockMs: 0, temporalContext: TEMPORAL, persistentScriptStorage: true },
      false,
    );
    const ran = bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
    await bridge.halt(session);
    await ran;
    const line = stopLine(bridge, session);
    assert.deepEqual(line.shown, line.host, "the UI shows what the host ran");
    assert.equal(line.shown[1], 1_000);
  });

/**
 * The `PlayerBridge` methods in `text` that take a `PlayerSession` (`#own` aside), each with whether it checks that
 * parameter with `this.#own(...)`.
 */
function sessionMethods(text: string): Map<string, boolean> {
  const file = ts.createSourceFile("player-bridge.ts", text, ts.ScriptTarget.Latest, true);
  const mentionsSession = (node: ts.Node): boolean =>
    (ts.isTypeReferenceNode(node) && node.typeName.getText(file) === "PlayerSession") ||
    ts.forEachChild(node, mentionsSession) === true;
  const methods = new Map<string, boolean>();
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== "PlayerBridge") continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || member.body === undefined) continue;
      const name = member.name.getText(file);
      const parameter = member.parameters.find(
        (each) => each.type !== undefined && mentionsSession(each.type),
      );
      if (name === "#own" || parameter === undefined) continue;
      let checked = false;
      member.body.forEachChild(function visit(node) {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(file) === "this.#own" &&
          node.arguments[0]?.getText(file) === parameter.name.getText(file)
        )
          checked = true;
        node.forEachChild(visit);
      });
      methods.set(name, checked);
    }
  }
  return methods;
}

// Clarity audit part 2, item 1: session IDs restart per connection, so a handle of another bridge would select this
// bridge's session of the same ID. Each method that takes a `PlayerSession` refuses one (`ForeignSessionError`).
/** Each such method, called on bridge `a` with bridge `b`'s session, through an op that `a`'s own session would take. */
const FOREIGN_CALLS: Record<string, (a: PlayerBridge, foreign: PlayerSession) => Promise<void>> = {
  store: async (a, foreign) => void a.store(foreign),
  latest: async (a, foreign) => void a.latest(foreign),
  read: async (a, foreign) => void (await a.read(foreign, "captureCheckpoint")),
  request: async (a, foreign) =>
    void (await a.request(foreign, "observeTime", { atMs: 0, media: [] })),
  viewCalls: async (a, foreign) => void (await a.viewCalls(foreign, true)),
  section: async (a, foreign) => void (await a.section(foreign, clockTicket(), async () => {})),
  halt: async (a, foreign) => void (await a.halt(foreign)),
  captureExport: async (a, foreign) => void (await a.captureExport(foreign, "current", () => null)),
  frozen: async (a, foreign) => void a.frozen(foreign),
  release: async (a, foreign) => void a.release(foreign),
  historyRenew: async (a, foreign) => void a.historyRenew(1, foreign, []),
};

test("every PlayerBridge method that takes a PlayerSession checks it is the bridge's own", () => {
  const text = readFileSync(
    new URL("../../../player/runtime/player-bridge.ts", import.meta.url),
    "utf8",
  );
  const methods = sessionMethods(text);
  assert.deepEqual(
    [...methods].filter(([, checked]) => !checked).map(([name]) => name),
    [],
    "a method takes a PlayerSession without `this.#own`",
  );
  // The family below calls each of them.
  assert.deepEqual([...methods.keys()].sort(), Object.keys(FOREIGN_CALLS).sort());
  // The inventory fails a method that lacks the check, and finds a new method.
  const unchecked = sessionMethods(
    text.replace("    this.#own(session);\n    const reply", "    const reply"),
  );
  assert.equal(unchecked.get("read"), false);
  const added = sessionMethods(
    text.replace(
      "  #own(session: PlayerSession)",
      "  added(other: PlayerSession | null): void {}\n  #own(session: PlayerSession)",
    ),
  );
  assert.equal(added.get("added"), false);
});

for (const [method, call] of Object.entries(FOREIGN_CALLS))
  test(`a session of another bridge with the same ID is refused: ${method}`, async () => {
    const [a, b] = [await inProcessBridge(), await inProcessBridge()];
    const started = async (bridge: PlayerBridge, label: string) =>
      bridge.start(
        await prepared(bridge, `say "${label}", instant\nwait 10 s\nexit`),
        { wallClockMs: 0, temporalContext: TEMPORAL },
        false,
      );
    const [own, foreign] = [await started(a, "A"), await started(b, "B")];
    assert.equal(own.id, foreign.id, "both hosts allocate the same ID");
    const [ownBefore, foreignBefore] = [a.latest(own), b.latest(foreign)];
    await assert.rejects(call(a, foreign), ForeignSessionError);
    // Neither session changed: the refusal selected nothing.
    assert.equal(a.latest(own), ownBefore);
    assert.equal(b.latest(foreign), foreignBefore);
    assert.equal(a.frozen(own), false);
    assert.equal(b.frozen(foreign), false);
  });

test("start's options are a plain record: a Date or a Map is refused, in-process and in a Worker", async () => {
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    for (const bridge of [await inProcessBridge(), worker]) {
      const plan = await prepared(bridge, SCRIPT);
      // Malformed options on purpose: the host refuses them.
      const start = (options: unknown) =>
        bridge.client.request("start", asMalformed({ plan, options, recording: false }));
      // A Date or a Map has no option of its own, but it is no options record: before, each passed as empty options.
      for (const options of [new Date(0), new Map()])
        await assert.rejects(
          start(options),
          (error: unknown) =>
            error instanceof BridgeRequestError &&
            error.message === "Malformed arguments for 'start'.",
          String(options),
        );
      // A plain record, also one with no prototype, starts the session.
      for (const options of [{ wallClockMs: 0, temporalContext: TEMPORAL }, Object.create(null)])
        assert.equal(typeof (await start(options)).result, "object");
    }
  } finally {
    worker.client.terminate();
  }
});

/*
 * F3 (L5i.7): a Start's two routes give the same session. (a) is the transitional factory as the activation ran it, in
 * the host before its first run (`introduceNow`), with the Player's tracing and random intents as its only carriers;
 * (b) is the plan form: the tracing intent posted when Debug changed it, a source `prepare`, then `start`.
 */
const F3_OPTIONS = { wallClockMs: 0, temporalContext: TEMPORAL };
const F3_RUN = { run: 1, retires: null };

/** The Player's development scenarios as written (`runtimeScenario.ts`, which only the Player's build compiles). */
function developmentScenarios(): Record<string, string> {
  const file = ts.createSourceFile(
    "runtimeScenario.ts",
    readFileSync(
      new URL("../../../player/vue/src/development/runtimeScenario.ts", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
  );
  const sources: Record<string, string> = {};
  for (const statement of file.statements)
    if (ts.isVariableStatement(statement))
      for (const { name, initializer } of statement.declarationList.declarations)
        if (ts.isIdentifier(name) && initializer && ts.isNoSubstitutionTemplateLiteral(initializer))
          sources[name.text] = initializer.text;
  assert.deepEqual(Object.keys(sources), [
    "openingScenario",
    "cameraScenarioSource",
    "viewfinderScenarioSource",
    "permanentButtonsScenarioSource",
  ]);
  return sources;
}

/** What Debug's trace view reads: recent chat, the newest message selected, all variables, and the Stage image. */
const traceRequest = (epoch: number, sequence: number | null) => ({
  messages: { limit: 20, openNewest: true },
  selected: sequence === null ? null : { sequence, epoch },
  variables: { filter: "", pages: {} },
  image: true,
  trees: {},
});

/** The trace's view of `session` at its newest message, through the host's `debugView` read. */
async function traceView(bridge: PlayerBridge, session: PlayerSession) {
  const head = await bridge.read(session, "debugView", { request: traceRequest(0, null) });
  if (head.status === null) return head;
  const newest = session.events.findLast((event) => event.kind === "say")?.sequence ?? null;
  return bridge.read(session, "debugView", { request: traceRequest(head.status.epoch, newest) });
}

/**
 * Plays `session` on as a player would: time on, then the presented choice's or button's first answer. It answers no
 * media load, camera capture or permanent button: a scenario that waits for one stays there, so F3 compares what comes
 * before (the opening and camera scenarios stay at their media load, the viewfinder at its capture).
 */
async function playedOn(bridge: PlayerBridge, start: PlayerSession): Promise<PlayerSession> {
  let session = start;
  for (let step = 1; step <= 8 && session.state.status !== "halted"; step += 1) {
    await bridge.request(session, "observeTime", { atMs: step * 2_000, media: [] });
    session = bridge.latest(session)!;
    const action = activePlayerRuntimeInteraction(session.state);
    const foreground = playerRuntimeForeground(session);
    if (action === null) continue;
    if (foreground?.kind === "choose")
      await untypedBridge(bridge).request(session, "selectChoice", {
        actionId: action.actionId,
        optionId: foreground.options[0]!.id,
        input: "button",
      });
    else if (foreground?.kind === "show-button")
      await untypedBridge(bridge).request(session, "activateButton", {
        actionId: action.actionId,
        input: "button",
      });
    session = bridge.latest(session)!;
  }
  return session;
}

/** A Start of `source` by `route` on a new connection, and what it shows, records and traces. */
async function startedBy(
  route: "factory" | "plan",
  source: string,
  debug: boolean,
  random: boolean,
) {
  const bridge = await inProcessBridge();
  const tracing = debug ? { on: true, intent: 1 } : undefined;
  // An owned random control with no site settings asks at each draw, so the session pauses there; without the control
  // the draw goes on by itself.
  const owned = random
    ? { owner: 1, intent: { owner: 1, control: { sites: [] }, resetAt: 0, intent: 1 } }
    : undefined;
  let session: PlayerSession;
  if (route === "factory")
    session = introduceNow(
      bridge,
      (made) =>
        createPlayerRuntimeSession(source, {
          ...F3_OPTIONS,
          debugMode: debug,
          recorder: made.recorder,
          ...(made.debugTrace === null ? {} : { debugTrace: made.debugTrace }),
          ...(made.randomControl === null ? {} : { randomControl: made.randomControl }),
        }),
      NO_MARKS,
      tracing,
      owned,
      F3_RUN,
    );
  else {
    if (tracing !== undefined) await bridge.client.request("debugTracing", tracing);
    const reply = await bridge.client.request("prepare", {
      source: { kind: "source", script: source },
    });
    // EVIDENCE: validation: `prepare` replies from the same build with its result.
    const result = reply.result as PrepareResult;
    assert.equal(result.kind, "prepared");
    session = await bridge.start(
      result.kind === "prepared" ? result.plan : "",
      { ...F3_OPTIONS, debugMode: debug },
      true,
      owned,
      F3_RUN,
    );
  }
  const first = {
    ...shown(session),
    marks: session.marks,
    diagnostic: session.diagnostic,
    history: session.history,
  };
  const atStart = await traceView(bridge, session);
  const played = await playedOn(bridge, session);
  return {
    first,
    atStart,
    snapshot: hatch(played, (held) => JSON.stringify(playerRuntimeSnapshot(held))),
    recording: heldRecording(bridge),
    played: await traceView(bridge, played),
  };
}

// Each axis's effect has a mutant of the `start` op that the comparison kills: the trace not attached (Debug on rows),
// `debugMode` dropped (Debug on), the random intent ignored (the random source, random owned), the recorder not attached
// (every row). The sources are its inputs, not an effect.
test("a Start of the factory route and of a held plan give the same session, recording and trace", async () => {
  // The random source says something first: with Debug on, the trace has a record before an owned control pauses it.
  const sources = { ...developmentScenarios(), random: `say "before", instant\n${SCRIPT}` };
  for (const [name, source] of Object.entries(sources))
    for (const debug of [false, true])
      for (const random of [false, true]) {
        const plan = await startedBy("plan", source, debug, random);
        assert.deepEqual(
          plan,
          await startedBy("factory", source, debug, random),
          `${name}, Debug ${debug ? "on" : "off"}, random ${random ? "owned" : "none"}`,
        );
        // A traced row compared records, not two empty views; an untraced one has no trace.
        assert.equal(
          (plan.atStart.status?.records ?? 0) > 0,
          debug,
          `${name}: a trace with records exactly when Debug is on`,
        );
      }
});
