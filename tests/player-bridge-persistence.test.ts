import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../player/compile-project.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { hatch } from "../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { CheckpointCapture } from "../player/engine-bridge/ops/persistence.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../player/player-bridge.js";
import { createPlayerRuntimeRestorePoint } from "../player/runtime-adapter.js";
import type { PlayerSession } from "../player/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { cloneGraphDifference } from "./helpers/clone-graph.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * The session-free read (L5h.1a): a session's checkpoint, read in the host after the session's earlier requests, as an
 * export of the session carries it. It gives what the adapter gives in the main realm, in-process and over a Worker.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };

/** Timers, a save, a deep value and a question: a state with something of everything a kept session holds. */
const SCRIPT = [
  'let open = ""',
  'let close = ""',
  "for i in 1..300 {",
  '  open += "["',
  '  close += "]"',
  "}",
  'let deep = fromJson(open + "1" + close, default: null)',
  'timer async 30 s { say "late", instant }',
  'say "One"',
  "wait 2 s",
  "let n = randomInteger(1..=6)",
  'say "rolled ${n}", instant',
  'let go = askChoice "Go"',
  "exit",
].join("\n");
const PLAN_JSON = serializeValidatedRuntimeJson(compilePlayerProject(SCRIPT).plan!);

async function prepared(bridge: PlayerBridge): Promise<string> {
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: PLAN_JSON },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

const checkpointOf = (bridge: PlayerBridge, session: PlayerSession) =>
  bridge.read<CheckpointCapture>(session, "captureCheckpoint");

const worker = async () =>
  new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));

/** Runs `body` on the in-process backend and on a Node Worker; terminates the Worker after. */
async function onBoth<T>(body: (bridge: PlayerBridge) => Promise<T>): Promise<[T, T]> {
  const inProcess = await body(await inProcessBridge());
  const remote = await worker();
  try {
    return [inProcess, await body(remote)];
  } finally {
    remote.client.terminate();
  }
}

/** Captures along one session, each with the count of events its cursor covers. */
async function captureTape(bridge: PlayerBridge) {
  const plan = await prepared(bridge);
  let session: PlayerSession = await bridge.start(plan, START, false);
  const tape: CheckpointCapture[] = [];
  const capture = async () => {
    tape.push(await checkpointOf(bridge, session));
    session = bridge.latest(session)!;
  };
  await capture();
  await bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
  session = bridge.latest(session)!;
  await capture();
  await bridge.request(session, "stepTime", { targetMs: 2_500 });
  session = bridge.latest(session)!;
  await capture();
  return tape;
}

test("captures give the same revisions, cursors and bytes in-process and in a Worker", async () => {
  const [inProcess, remote] = await onBoth(captureTape);
  assert.equal(cloneGraphDifference(remote, inProcess), null);
});

test("a capture's bytes are what the adapter writes of the host's session, and its events end at its cursor", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge);
  const session = await bridge.start(plan, START, false);
  await bridge.request(session, "observeTime", { atMs: 2_500, media: [] });
  const shown = bridge.latest(session)!;
  const point = await checkpointOf(bridge, shown);
  assert.equal(
    point.checkpointJson,
    hatch(shown, (held) => createPlayerRuntimeRestorePoint(held).checkpointJson),
  );
  assert.deepEqual([point.revision, point.eventsThrough], [shown.revision, shown.events.length]);
});

test("a read waits for the session's earlier requests, so it shows what was posted before it", async () => {
  const bridge = await worker();
  try {
    const plan = await prepared(bridge);
    const session = await bridge.start(
      plan,
      { ...START, scriptStorage: [], persistentScriptStorage: true },
      false,
    );
    // Posted together: an observation, Debug's storage edit waiting for its reply, then the read, which follows both.
    const observed = bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
    const edited = bridge.request(session, "applyStorageEdit", { key: "edited", value: 7 });
    const read = checkpointOf(bridge, session);
    await Promise.all([observed, edited]);
    const point = await read;
    const shown = bridge.latest(session)!;
    assert.deepEqual([point.revision, point.eventsThrough], [shown.revision, shown.events.length]);
    assert.match(point.checkpointJson, /"key":"edited"/u);
  } finally {
    bridge.client.terminate();
  }
});

test("a read works after a Player error stop, at the stop line, which the session's own ops cannot pass", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge);
  const session = await bridge.start(plan, START, false);
  await bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
  await bridge.halt(session);
  const shown = bridge.latest(session)!;
  const point = await checkpointOf(bridge, shown);
  assert.deepEqual([point.revision, point.eventsThrough], [shown.revision, shown.events.length]);
  await assert.rejects(
    bridge.request(shown, "observeTime", { atMs: 2_000, media: [] }),
    (error: unknown) => error instanceof BridgeRequestError && error.code === "halted",
  );
});

test("a read of a released session finds none", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge);
  const session = await bridge.start(plan, START, false);
  bridge.release(session);
  const error = await checkpointOf(bridge, session).catch((caught: unknown) => caught);
  assert.ok(error instanceof BridgeRequestError);
  assert.deepEqual([error.kind, error.name], ["engine", "SessionGoneError"]);
});
