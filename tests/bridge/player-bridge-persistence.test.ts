import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { hatch } from "../helpers/bridge/in-process.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { CheckpointCapture, KeepCapture } from "../../player/engine-bridge/ops/persistence.js";
import { playerBridgeOps, type PrepareResult } from "../../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  createPlayerRuntimeRestorePoint,
  playerRuntimeSnapshotJson,
} from "../../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { formObligations, malformedArguments } from "../helpers/bridge/argument-forms.js";
import { cloneGraphDifference } from "../helpers/clone-graph.js";
import { inProcessBridge } from "../helpers/in-process-bridge.js";
import { NO_MARKS } from "../../player/debug/debug-history-marks.js";
import { asMalformed } from "../helpers/bridge/untyped.js";

/*
 * L5h.1's ops: what the Player keeps and exports of a session, read in the host after the session's earlier requests,
 * and a kept session restored there; the plan's canonical JSON written in the host. They give what the adapter gives
 * in the main realm today, in-process and over a Worker.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
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
const PLAN = compilePlayerProject(SCRIPT).plan!;
const PLAN_JSON = serializeValidatedRuntimeJson(PLAN);

async function prepared(bridge: PlayerBridge, text = PLAN_JSON): Promise<string> {
  const reply = await bridge.client.request("prepare", { source: { kind: "plan", text } });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

type Captured = Extract<KeepCapture, { readonly kind: "captured" }>;

/** A keep's capture of `session`, with the held plan `plan`'s JSON when given; it must capture the state. */
async function keepOf(
  bridge: PlayerBridge,
  session: PlayerSession,
  plan: string | null,
): Promise<Captured> {
  const keep = await bridge.read(session, "captureKeep", { plan });
  if (keep.kind !== "captured") assert.fail(`The capture gave ${keep.kind}.`);
  return keep;
}

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

/** A tape of captures along one session: each with the events its cursor covers. */
async function captureTape(bridge: PlayerBridge) {
  const plan = await prepared(bridge);
  let session: PlayerSession = await bridge.start(plan, START, false);
  const tape: { readonly keep: Captured; readonly checkpoint: CheckpointCapture }[] = [];
  const capture = async (withPlan: boolean) => {
    const keep = await keepOf(bridge, session, withPlan ? plan : null);
    const point = await bridge.read(session, "captureCheckpoint");
    session = bridge.latest(session)!;
    // The events a capture goes with are compared by their count: its cursor.
    tape.push({ keep, checkpoint: point });
  };
  await capture(true);
  await bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
  session = bridge.latest(session)!;
  await capture(false);
  await bridge.request(session, "stepTime", { targetMs: 2_500 });
  session = bridge.latest(session)!;
  await capture(true);
  return tape;
}

test("captures give the same revisions, cursors, bytes and events in-process and in a Worker", async () => {
  const [inProcess, remote] = await onBoth(captureTape);
  assert.equal(cloneGraphDifference(remote, inProcess), null);
  // The plan's JSON is the canonical text; a capture without it carries none.
  const [first, second] = inProcess;
  assert.equal(first!.keep.planJson, PLAN_JSON);
  assert.equal(second!.keep.planJson, null);
});

test("a capture's bytes are what the adapter writes of the host's session, and its events end at its cursor", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge);
  const session = await bridge.start(plan, START, false);
  await bridge.request(session, "observeTime", { atMs: 2_500, media: [] });
  const shown = bridge.latest(session)!;
  const keep = await keepOf(bridge, shown, null);
  const point = await bridge.read(shown, "captureCheckpoint");
  assert.equal(
    keep.snapshotJson,
    hatch(shown, (held) => playerRuntimeSnapshotJson(held)),
  );
  assert.equal(
    point.checkpointJson,
    hatch(shown, (held) => createPlayerRuntimeRestorePoint(held).checkpointJson),
  );
  assert.deepEqual([keep.revision, keep.eventsThrough], [shown.revision, shown.events.length]);
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
    const read = keepOf(bridge, session, null);
    await Promise.all([observed, edited]);
    const keep = await read;
    const shown = bridge.latest(session)!;
    assert.deepEqual([keep.revision, keep.eventsThrough], [shown.revision, shown.events.length]);
    assert.match(keep.snapshotJson, /"key":"edited"/u);
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
  const keep = await keepOf(bridge, shown, null);
  assert.deepEqual([keep.revision, keep.eventsThrough], [shown.revision, shown.events.length]);
  await assert.rejects(
    bridge.request(shown, "observeTime", { atMs: 2_000, media: [] }),
    (error: unknown) => error instanceof BridgeRequestError && error.code === "halted",
  );
});

test("a read of a released session finds none: a keep's capture says so, with the plan's JSON if it was written", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge);
  const session = await bridge.start(plan, START, false);
  // Not written yet: nothing comes back. Written by its reservation: the written JSON comes back, and stays.
  bridge.release(session);
  assert.deepEqual(await bridge.read(session, "captureKeep", { plan }), {
    kind: "gone",
    planJson: null,
  });
  await bridge.client.request("preparePlanText", { plan });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await bridge.read(session, "captureKeep", { plan }), {
    kind: "gone",
    planJson: PLAN_JSON,
  });
  const error = await bridge.read(session, "captureCheckpoint").catch((caught: unknown) => caught);
  assert.ok(error instanceof BridgeRequestError);
  assert.deepEqual([error.kind, error.name], ["engine", "SessionGoneError"]);
});

test("a kept session restores against the held plan; another plan, an ended session and a damaged state do not", async () => {
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const plan = await prepared(bridge);
    const session = await bridge.start(plan, START, false);
    await bridge.request(session, "observeTime", { atMs: 2_500, media: [] });
    const shown = bridge.latest(session)!;
    const keep = await keepOf(bridge, shown, plan);
    const events = shown.events.slice(0, keep.eventsThrough);
    const restored = await bridge.restoreKept(
      plan,
      keep.planJson!,
      keep.snapshotJson,
      events,
      NO_MARKS,
    );
    assert.ok(typeof restored === "object");
    const otherPlan = await bridge.restoreKept(
      plan,
      serializeValidatedRuntimeJson(compilePlayerProject('say "other"\nexit').plan!),
      keep.snapshotJson,
      events,
      NO_MARKS,
    );
    const damaged = await bridge
      .restoreKept(plan, keep.planJson!, '{"broken":true}', events, NO_MARKS)
      .catch((error: unknown) => error);
    assert.ok(damaged instanceof BridgeRequestError);
    // An ended session: the same script's state after it exits.
    const ending = await prepared(
      bridge,
      serializeValidatedRuntimeJson(compilePlayerProject('say "x", instant\nexit').plan!),
    );
    const ended = await bridge.start(ending, START, false);
    const endedKeep = await keepOf(bridge, ended, ending);
    const endedOutcome = await bridge.restoreKept(
      ending,
      endedKeep.planJson!,
      endedKeep.snapshotJson,
      ended.events,
      NO_MARKS,
    );
    return {
      restored: {
        revision: restored.revision,
        state: restored.state,
        events: [...restored.events],
      },
      restoredJson: await keepOf(bridge, restored, null),
      otherPlan,
      damaged: [damaged.name, damaged.code, damaged.info],
      endedOutcome,
      keptJson: keep.snapshotJson,
    };
  });
  assert.equal(cloneGraphDifference(remote, inProcess), null);
  assert.equal(inProcess.otherPlan, "otherPlan");
  assert.equal(inProcess.endedOutcome, "ended");
  assert.equal(inProcess.damaged[0], "CheckpointError");
  // Restored, nothing ran: the state is the one kept.
  assert.equal(inProcess.restoredJson.snapshotJson, inProcess.keptJson);
});

test("only a reservation keeps the plan's JSON: written once in its task, read by every reader, let go of by its release", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge);
  const session = await bridge.start(plan, START, false);
  const stringify = JSON.stringify;
  let writes = 0;
  JSON.stringify = new Proxy(stringify, {
    apply(target, _self, args) {
      if (typeof args[0] === "object" && args[0] !== null && "instructions" in args[0]) writes += 1;
      return target(args[0], args[1], args[2]);
    },
  });
  try {
    // No reservation: each reader writes it for itself, and nothing keeps it.
    await bridge.client.request("planText", { plan });
    await keepOf(bridge, session, plan);
    assert.equal(writes, 2);
    // Reserved: written in a task of its own, then read by the capture, the comparison and the import's save alike.
    await bridge.client.request("preparePlanText", { plan });
    assert.equal(writes, 2, "written in a task of its own, not in the op");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(writes, 3);
    await bridge.client.request("preparePlanText", { plan });
    const keep = await keepOf(bridge, session, plan);
    assert.equal(keep.planJson, PLAN_JSON);
    assert.equal(
      await bridge.restoreKept(plan, PLAN_JSON, keep.snapshotJson, [], NO_MARKS).then(() => "read"),
      "read",
    );
    assert.equal((await bridge.client.request("planText", { plan })).result, PLAN_JSON);
    assert.equal(writes, 3, "every reader read the one written JSON");
    // Released, it is gone; released before its task, it is never written.
    await bridge.client.request("releasePlanText", { plan });
    await bridge.client.request("planText", { plan });
    assert.equal(writes, 4);
    await bridge.client.request("preparePlanText", { plan });
    await bridge.client.request("releasePlanText", { plan });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(writes, 4);
  } finally {
    JSON.stringify = stringify;
  }
});

test("a session-free read names an op of ReadOps, with that op's arguments, and resolves to its result", () => {
  const typed = async (bridge: PlayerBridge, session: PlayerSession) => {
    const keep: KeepCapture = await bridge.read(session, "captureKeep", { plan: null });
    const checkpoint: CheckpointCapture = await bridge.read(session, "captureCheckpoint");
    // @ts-expect-error -- no read op of that name.
    await bridge.read(session, "planText", { plan: "p1" });
    // @ts-expect-error -- `captureKeep` takes its plan.
    await bridge.read(session, "captureKeep", {});
    return [keep, checkpoint];
  };
  assert.equal(typeof typed, "function");
});

test("captureStorage reads the shown state's saved values in the host, at its revision, in-process and in a Worker", async () => {
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const plan = await prepared(bridge);
    const session = await bridge.start(
      plan,
      { ...START, scriptStorage: [{ key: "score", value: 3 }], persistentScriptStorage: true },
      false,
    );
    await bridge.request(session, "observeTime", { atMs: 2_500, media: [] });
    const shown = bridge.latest(session)!;
    const capture = await bridge.read(shown, "captureStorage");
    assert.equal(capture.revision, shown.revision);
    // Malformed arguments, each form the op's one form gives, are refused before it runs.
    const refused: string[] = [];
    const forms = [{ required: { session: "string" } }] as const;
    const malformed = malformedArguments(forms);
    assert.deepEqual(
      malformed.map(({ id }) => id),
      formObligations(forms),
    );
    for (const { id, args } of malformed)
      // Malformed on purpose: the host refuses them.
      await bridge.client.request("captureStorage", asMalformed(args)).then(
        () => refused.push(`${id}: accepted`),
        (error: unknown) => {
          if (!(error instanceof BridgeRequestError) || error.code !== "arguments")
            refused.push(`${id}: ${String(error)}`);
        },
      );
    assert.deepEqual(refused, []);
    return { entries: capture.entries, persistent: capture.persistent };
  });
  assert.deepEqual(remote, inProcess);
  assert.deepEqual(inProcess, { entries: [{ key: "score", value: 3 }], persistent: true });
});

test("a kept session's events are checked at the op: an unknown kind, a malformed sequence or a reversed log is refused", async () => {
  await onBoth(async (bridge) => {
    const plan = await prepared(bridge);
    const session = await bridge.start(plan, START, false);
    await bridge.request(session, "observeTime", { atMs: 2_500, media: [] });
    const shown = bridge.latest(session)!;
    const keep = await keepOf(bridge, shown, plan);
    const events = shown.events.slice(0, keep.eventsThrough);
    for (const bad of [
      events.map((event, index) =>
        index === 0 ? { ...event, kind: "unrecognized-event" } : event,
      ),
      events.map((event, index) => (index === 0 ? { ...event, sequence: "x" } : event)),
      [...events].reverse(),
    ])
      await assert.rejects(
        bridge.client.request(
          "restoreKept",
          asMalformed({
            plan,
            planJson: keep.planJson,
            snapshotJson: keep.snapshotJson,
            events: bad,
            marks: NO_MARKS,
          }),
        ),
        /Malformed arguments/u,
      );
  });
});

test("every op that takes an event list checks it with one function at its boundary (`isEventLog`)", () => {
  const takers = Object.entries(playerBridgeOps())
    .filter(([, op]) => op.checkArguments.toString().includes("args.events"))
    .map(([name, op]) => [name, op.checkArguments.toString().includes("isEventLog(args.events)")]);
  assert.deepEqual(takers.sort(), [
    ["restoreKept", true],
    ["rewindBack", true],
    ["rewindForward", true],
  ]);
});
