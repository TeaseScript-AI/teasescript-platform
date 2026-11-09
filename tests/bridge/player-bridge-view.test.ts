import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import type { PlayerProject } from "../../player/runtime/runtime-adapter.js";
import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  playerRuntimeCalls,
  playerRuntimeDebugNow,
  playerRuntimeMedia,
  playerRuntimePermanentButtons,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { viewCalls, viewed } from "../helpers/debug-readers.js";
import { hatch, inProcessBridge } from "../helpers/in-process-bridge.js";

/*
 * L5f's projection (witness B-view): every publication carries the critical view, the state without its active calls;
 * the call view comes with publications only while the main side views the session's calls (`viewCalls`), and with
 * the stop's acknowledgement. Debug's readers read the published view alone.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };

/** A wait inside two nested function calls, a blocking timer behind a background one, and a lock after them. */
const SCRIPT = [
  "function inner {",
  "  wait 2 s",
  "}",
  "function outer {",
  "  inner()",
  "}",
  'timer async 10 s { say "tick", instant }',
  "outer()",
  'say "after", instant',
  'let locked = encryptText("payload", password: askPassword("Choose"), publicKey: false, timeLock: false)',
  'say "done", instant',
  "exit",
].join("\n");

async function prepared(
  bridge: PlayerBridge,
  script: string | PlayerProject = SCRIPT,
): Promise<string> {
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

async function worker(): Promise<PlayerBridge> {
  return new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
}

/** Both backends, the Worker's ended after `body`. */
async function onBoth(body: (bridge: PlayerBridge, name: string) => Promise<void>) {
  await body(await inProcessBridge(), "in-process");
  const remote = await worker();
  try {
    await body(remote, "worker");
  } finally {
    remote.client.terminate();
  }
}

test("without a demand no publication carries the calls; with one each does; after it ends none does", async () => {
  await onBoth(async (bridge, name) => {
    let session = await bridge.start(await prepared(bridge), START, false);
    const minimal = (current: PlayerSession) => {
      assert.equal("calls" in current.state, false, name);
      assert.equal(current.callView, null, name);
      viewed(current);
    };
    minimal(session);
    await bridge.request(session, "observeTime", { atMs: 500, media: [] });
    session = bridge.latest(session)!;
    minimal(session);

    session = await viewCalls(bridge, session, true);
    // The merged session is the same publication, with its calls: two frames, `outer` and `inner`.
    assert.deepEqual(
      playerRuntimeCalls(session)?.map((call) => call.name),
      ["inner", "outer"],
      name,
    );
    await bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
    session = bridge.latest(session)!;
    assert.equal(session.callView?.calls.length, 2, name);
    assert.equal("calls" in session.state, false, name);
    viewed(session);

    session = await viewCalls(bridge, session, false);
    minimal(session);
    await bridge.request(session, "observeTime", { atMs: 1_500, media: [] });
    minimal(bridge.latest(session)!);
  });
});

test("a call view reply of another revision than the store's is dropped", async () => {
  const bridge = await inProcessBridge();
  const session = await bridge.start(await prepared(bridge), START, false);
  const store = bridge.store(session)!;
  const reply = { revision: session.revision - 1, instructions: {}, callView: { calls: [] } };
  assert.equal(store.mergeCallView(reply), null);
  assert.equal(store.session, session);
  assert.equal(store.mergeCallView({ ...reply, revision: session.revision + 1 }), null);
  assert.equal(store.session, session);
});

test("a call view request behind an op whose reply is in transit: the op's publication shows first, without calls", async () => {
  await onBoth(async (bridge, name) => {
    const remote = name === "worker";
    const local = remote ? bridge : await inProcessBridge(50);
    const session = await local.start(await prepared(local), START, false);
    const applied: { readonly revision: number; readonly calls: boolean }[] = [];
    const record = () => {
      const latest = local.latest(session)!;
      applied.push({ revision: latest.revision, calls: latest.callView !== null });
    };
    const observed = local.request(session, "observeTime", { atMs: 500, media: [] }).then(record);
    const merged = local.viewCalls(session, true).then((next) => {
      record();
      return next;
    });
    await observed;
    const after = await merged;
    // FIFO: the observation's publication, then the call view merged into that same revision.
    assert.deepEqual(applied, [
      { revision: session.revision + 1, calls: false },
      { revision: session.revision + 1, calls: true },
    ]);
    assert.equal(after, local.latest(session));
    if (!remote) local.client.terminate();
  });
});

test("a facade call flushes a call view reply in transit and keeps it across a same-revision keep", async () => {
  const bridge = await inProcessBridge(50);
  const session = await bridge.start(await prepared(bridge), START, true);
  const pending = bridge.viewCalls(session, true);
  const events = bridge.latest(session)!.events.length;
  // The facade delivers the session's replies in transit first: the call view is merged before it runs.
  const seen = hatch(session, () => bridge.latest(session)!);
  assert.notEqual(seen.callView, null);
  assert.equal(seen.events.length, events, "no event is replayed");
  assert.equal(await pending, seen);
  // `beginRecording` keeps the session at its revision without publishing; the call view stays.
  await bridge.request(seen, "beginRecording", null);
  assert.equal(bridge.latest(session)!.callView?.calls.length, 2);
  assert.equal(bridge.latest(session)!.revision, seen.revision);
});

test("a Player error stop freezes the session with its call view, unasked, and changes nothing it shows", async () => {
  await onBoth(async (bridge, name) => {
    const session = await bridge.start(await prepared(bridge), START, false);
    await bridge.request(session, "observeTime", { atMs: 500, media: [] });
    const before = bridge.latest(session)!;
    assert.equal(before.callView, null);
    await bridge.halt(session);
    const frozen = bridge.latest(session)!;
    assert.equal(bridge.frozen(session), true, name);
    assert.deepEqual(
      [frozen.revision, frozen.state, frozen.events.length],
      [before.revision, before.state, before.events.length],
      name,
    );
    assert.deepEqual(
      playerRuntimeCalls(frozen)?.map((call) => call.name),
      ["inner", "outer"],
      name,
    );
    assert.equal(playerRuntimeDebugNow(frozen, 0)?.waitingAt?.kind, "wait", name);
    // Nothing reaches the stopped session: a call view request is refused.
    await assert.rejects(
      bridge.viewCalls(frozen, true),
      (error: unknown) => error instanceof BridgeRequestError && error.code === "halted",
    );
  });
});

test("a call view request crossing the stop: the frozen session has its call view, its state unchanged", async () => {
  for (const delayMs of [0, 50]) {
    const bridge = await inProcessBridge(delayMs);
    const session = await bridge.start(await prepared(bridge), START, false);
    const before = bridge.latest(session)!;
    const requested = bridge.viewCalls(session, true).then(
      () => "merged",
      (error: unknown) =>
        error instanceof BridgeRequestError && error.code === "halted" ? "refused" : "failed",
    );
    await bridge.halt(session);
    assert.notEqual(await requested, "failed", `${delayMs} ms`);
    const frozen = bridge.latest(session)!;
    assert.deepEqual([frozen.revision, frozen.state], [before.revision, before.state]);
    assert.equal(frozen.callView?.calls.length, 2, `${delayMs} ms`);
  }
});

test("Debug's readers give results that share nothing with the view they read", async () => {
  const bridge = await inProcessBridge();
  let session = await bridge.start(await prepared(bridge), START, false);
  // To the lock: through the wait, the call returns and the next say.
  await bridge.request(session, "observeTime", { atMs: 3_000, media: [] });
  session = await viewCalls(bridge, bridge.latest(session)!, true);
  const foreground = session.state.foregroundAction;
  assert.equal(foreground?.kind, "lock");
  const now = playerRuntimeDebugNow(session, 0)!;
  const choices = now.waitingAt?.lock?.choices;
  assert.ok(choices !== undefined && foreground.kind === "lock");
  assert.notEqual(choices, foreground.choices);
  assert.equal(Object.isFrozen(choices), true);
  assert.deepEqual(choices, foreground.choices);
  // No array of the result is an array of the view.
  const viewArrays = new Set<unknown>();
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null || viewArrays.has(value)) return;
    if (Array.isArray(value)) viewArrays.add(value);
    for (const item of Object.values(value)) collect(item);
  };
  collect(session.state);
  collect(session.callView);
  const shared: unknown[] = [];
  const check = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    if (viewArrays.has(value)) shared.push(value);
    for (const item of Object.values(value)) check(item);
  };
  check(now);
  check(playerRuntimeCalls(session));
  assert.deepEqual(shared, []);
});

/**
 * The debug facts no tape of L5b–L5e reaches, each from a script of its own: a called file's frame, a blocking timer
 * and one that a block suspended, a timed button's countdown, and the frames of a permanent button's and a media cue's
 * blocks. Each runs through publications with its calls viewed, on both backends, where `viewed` checks every reader
 * against the readers before L5f; the facts seen must cover each kind.
 */
const KINDS: readonly {
  readonly name: string;
  readonly project: string | PlayerProject;
  /** What to do next with the session, or `null` when done. */
  readonly next: (session: PlayerSession, step: number) => readonly [string, unknown] | null;
}[] = [
  {
    name: "called file",
    project: {
      files: [
        { path: "main.tease", source: 'call "rooms/hall.tease"\nsay "back", instant\nexit\n' },
        { path: "rooms/hall.tease", source: "wait 2 s\nend\n" },
      ],
    },
    next: () => null,
  },
  {
    name: "blocking and suspended timers",
    project: [
      "timer async 1 s {",
      "  wait 5 s",
      "}",
      'timer(duration: 10 s, display: "visible", label: "Blocking")',
      "exit",
    ].join("\n"),
    next: (_session, step) => (step === 0 ? ["observeTime", { atMs: 1_000, media: [] }] : null),
  },
  { name: "timed button", project: 'showButton "Go", timeout: 5 s\nexit', next: () => null },
  {
    name: "permanent button block",
    project: 'showPermanentButton "Tick" {\n    wait 3 s\n}\nshowButton "End"\nexit',
    next: (session, step) =>
      step === 0
        ? [
            "pressPermanentButton",
            { buttonId: playerRuntimePermanentButtons(session.state)[0]!.buttonId },
          ]
        : null,
  },
  {
    name: "media cue block",
    project:
      'let m = playAudio async "a.mp3" {\n    at 1 s {\n        wait 4 s\n    }\n}\nwait 10 s\nexit',
    next: (session, step) => {
      const medium = playerRuntimeMedia(session.state).media[0];
      if (medium === undefined) return null;
      if (step === 0)
        return [
          "reportMediaLoad",
          { mediaId: medium.mediaId, report: { kind: "loaded", durationMs: 3_000 } },
        ];
      if (step === 1)
        return [
          "observeTime",
          {
            atMs: 1_500,
            media: [{ mediaId: medium.mediaId, segment: medium.segment, progressMs: 1_500 }],
          },
        ];
      return null;
    },
  },
];

test("every kind of call, timer and countdown Debug names comes through publications as the readers before L5f gave it", async () => {
  await onBoth(async (bridge, backend) => {
    const seen = {
      calls: new Set<string>(),
      timers: new Set<string>(),
      countdowns: new Set<string>(),
    };
    for (const kind of KINDS) {
      let session = await bridge.start(await prepared(bridge, kind.project), START, false);
      session = await viewCalls(bridge, session, true);
      for (let step = 0; ; step += 1) {
        const result = viewed(session);
        for (const call of result.calls ?? []) seen.calls.add(call.kind);
        for (const timer of result.now?.timers ?? [])
          seen.timers.add(`${timer.blocking ? "blocking" : "background"} ${timer.state}`);
        if (result.countdown !== null) seen.countdowns.add(result.countdown.kind);
        const next = kind.next(session, step);
        if (next === null) break;
        await bridge.request(session, next[0], next[1]);
        session = bridge.latest(session)!;
      }
    }
    // Every kind of call; blocking timers running and suspended, and a background one; the timed button's countdown.
    assert.deepEqual([...seen.calls].sort(), ["button", "file", "media", "timer"], backend);
    for (const timer of ["blocking running", "blocking suspended", "background running"])
      assert.ok(seen.timers.has(timer), `${backend}: ${timer}`);
    assert.ok(seen.countdowns.has("button"), backend);
  });
});
