import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import { rebuildRecordedSession } from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { admissionOf, type HeldMedia } from "../player/engine-bridge/held-media.js";
import { heldRecording, introduceNow } from "../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import type { Introduction } from "../player/engine-bridge/session-protocol.js";
import { PlayerBridge } from "../player/player-bridge.js";
import {
  adoptPlayerRuntimeCatchUp,
  answeredByPlayerInput,
  answerPlayerRuntimeCapture,
  beginPlayerRuntimeCatchUp,
  completePlayerRuntimeStorageWrite,
  dropPlayerRuntimeCatchUp,
  observePlayerRuntimeTime,
  playerRuntimeSnapshot,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSessionAt,
  stepPlayerRuntimeCatchUp,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeCatchUp,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import {
  activePlayerRuntimeCapture,
  activePlayerRuntimeInteraction,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeMedia,
  type PlayerSession,
} from "../player/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { hatch, inProcessBridge } from "./helpers/in-process-bridge.js";
import { plainRecording } from "./helpers/plain-recording.js";

/*
 * L5g's B-record evidence: the recording of every engine call, made by the connection's recorder, is the same in-process
 * and in a Worker, and both equal the adapter's own run with its own recorder. Successful replay, the frozen replay of a
 * failure and live recovery after a throw are kept apart, and a new Start's recorder never stands in for another's.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const WORKER = new URL("./helpers/bridge-restore-worker.js", import.meta.url);
const TEMPORAL = DEFAULT_TEMPORAL_CONTEXT;
const START = {
  wallClockMs: 0,
  temporalContext: TEMPORAL,
  scriptStorage: [],
  persistentScriptStorage: true,
};
const HELD: HeldMedia = [{ reference: "photo-1", kind: "image" }];

/**
 * An input, a save and its acknowledgement, a medium with a cue (an async play waits for its load), a capture, a timer,
 * and long waits to catch up on.
 */
const SCRIPT = [
  'let name = askText "Name?"',
  'save name as "name"',
  'let m = playAudio async "loop.mp3" {',
  "  at 1 s {",
  '    say "cue ${name}", instant',
  "  }",
  "}",
  "let photo = takePhoto()",
  "timer async 2 s {",
  '  say "tick", instant',
  "}",
  "wait 4 s",
  "wait 4 s",
  "m.stop()",
  'say "done", instant',
  "exit",
].join("\n");

/** A Worker of the test entry, with test settings in its environment while it starts. */
async function worker(env: Readonly<Record<string, string>> = {}): Promise<PlayerBridge> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return new PlayerBridge(await connectBridge(nodeWorkerPort(WORKER, BUILD), BUILD));
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
  }
}

async function prepared(bridge: PlayerBridge, script: string): Promise<string> {
  const plan = compilePlayerProject(script).plan;
  assert.ok(plan);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  if (result.kind !== "prepared") throw new Error(`The script did not prepare: ${result.kind}`);
  return result.plan;
}

type PlainRecording = NonNullable<ReturnType<typeof plainRecording>>;

/** The connection's recording as plain data: through the facade in-process, through the test op in a Worker. */
async function recordingOf(bridge: PlayerBridge, inProcess: boolean): Promise<PlainRecording> {
  // EVIDENCE: validation: `recordingForTest` replies from the same build with `plainRecording`'s result.
  const remote = inProcess
    ? null
    : ((await bridge.client.request("recordingForTest", null)).result as PlainRecording | null);
  const recording = inProcess ? plainRecording(heldRecording(bridge)) : remote;
  assert.ok(recording !== null, "the connection records");
  return recording;
}

/** One step of the tape, as an op and its arguments, from what the session shows; `null` once the step is not due. */
type Step = (shown: Pick<PlayerSession, "state">) => { op: string; args: unknown } | null;

/** The medium's progress at `atMs`, from its start at 0 ms, as the Player samples it. */
const progress = (shown: Pick<PlayerSession, "state">, atMs: number) =>
  playerRuntimeMedia(shown.state).media.flatMap((medium) =>
    medium.loaded ? [{ mediaId: medium.mediaId, segment: medium.segment, progressMs: atMs }] : [],
  );

const TAPE: readonly (readonly [string, Step])[] = [
  [
    "answer",
    (shown) => ({
      op: "submitComposer",
      args: {
        actionId: activePlayerRuntimeInteraction(shown.state)!.actionId,
        text: "Ann",
        input: "enter",
      },
    }),
  ],
  [
    "acknowledge",
    (shown) => ({
      op: "completeStorageWrite",
      args: { actionId: pendingPlayerRuntimeStorageWrite(shown.state)!.actionId, stored: true },
    }),
  ],
  [
    "load",
    (shown) => ({
      op: "reportMediaLoad",
      args: {
        mediaId: playerRuntimeMedia(shown.state).media[0]!.mediaId,
        report: { kind: "loaded", durationMs: 20_000 },
      },
    }),
  ],
  [
    "photo",
    (shown) => ({
      op: "answerCapture",
      args: {
        actionId: activePlayerRuntimeCapture(shown.state)!.actionId,
        answer: { kind: "captured", reference: "photo-1" },
        held: HELD,
      },
    }),
  ],
  ["cue", (shown) => ({ op: "observeTime", args: { atMs: 1_500, media: progress(shown, 1_500) } })],
  ["catch up", () => ({ op: "beginCatchUp", args: { targetMs: 5_000 } })],
  ["step", () => ({ op: "stepCatchUp", args: { budgetMs: 0 } })],
  ["step", () => ({ op: "stepCatchUp", args: { budgetMs: 0 } })],
  ["adopt", () => ({ op: "adoptCatchUp", args: null })],
  ["catch up again", () => ({ op: "beginCatchUp", args: { targetMs: 9_000 } })],
  ["step", () => ({ op: "stepCatchUp", args: { budgetMs: 0 } })],
  ["drop", () => ({ op: "dropCatchUp", args: null })],
  ["end", (shown) => ({ op: "observeTime", args: { atMs: 9_500, media: progress(shown, 9_500) } })],
];

/** Every argument a step of the tape gives, by name. */
interface TapeArguments {
  readonly actionId: number;
  readonly text: string;
  readonly input: "enter";
  readonly stored: boolean;
  readonly answer: { readonly kind: "captured"; readonly reference: string };
  readonly held: HeldMedia;
  readonly mediaId: number;
  readonly report: { readonly kind: "loaded"; readonly durationMs: number };
  readonly atMs: number;
  readonly media: readonly { mediaId: number; segment: number; progressMs: number }[];
  readonly targetMs: number;
}

/** What a step shows, comparable across the three runs. */
const shownOf = (session: Pick<PlayerSession, "state" | "events">) => ({
  state: session.state,
  events: [...session.events],
});

/** The tape over the bridge: each step's result and what shows after it; envelope refusals in between record nothing. */
async function overBridge(bridge: PlayerBridge, inProcess: boolean) {
  let session = await bridge.start(await prepared(bridge, SCRIPT), START, true);
  const steps: unknown[] = [shownOf(session)];
  for (const [name, step] of TAPE) {
    const sent = step(session)!;
    const result = await bridge.request(session, sent.op, sent.args);
    session = bridge.latest(session)!;
    steps.push({ name, result, ...shownOf(session) });
    if (name === "answer") {
      // Refused before the engine: malformed arguments and a stale basis. Neither is an engine call to record.
      const before = (await recordingOf(bridge, inProcess))?.operations.length;
      await assert.rejects(
        bridge.request(session, "submitComposer", { actionId: 1, text: 1, input: null }),
        (error: unknown) => error instanceof BridgeRequestError && error.code === "arguments",
      );
      await assert.rejects(
        bridge.request(session, "observeTime", { atMs: 1, media: [] }, { basis: 0 }),
        (error: unknown) => error instanceof BridgeRequestError && error.code === "basis",
      );
      assert.equal((await recordingOf(bridge, inProcess))?.operations.length, before);
    }
  }
  return {
    steps,
    snapshot: inProcess ? hatch(session, playerRuntimeSnapshot) : null,
    recording: await recordingOf(bridge, inProcess),
  };
}

/** The same tape on the adapter itself, with a recorder of its own: the oracle. */
function onAdapter() {
  const recorder = new DebugRecorder();
  let session: PlayerRuntimeSession = createPlayerRuntimeSession(SCRIPT, { ...START, recorder });
  let catchUp: PlayerRuntimeCatchUp | null = null;
  const steps: unknown[] = [shownOf(session)];
  for (const [name, step] of TAPE) {
    const { op, args } = step(session)!;
    // EVIDENCE: fixture: the tape's arguments for each op, as written above.
    const a = args as TapeArguments;
    let result: object | string | null = null;
    const apply = (next: { readonly session: PlayerRuntimeSession; readonly outcome: object }) => {
      session = next.session;
      result = next.outcome;
    };
    if (op === "submitComposer")
      apply(
        answeredByPlayerInput(session, a.input, () =>
          submitPlayerRuntimeComposer(session, a.text)!,
        ),
      );
    else if (op === "completeStorageWrite")
      apply(completePlayerRuntimeStorageWrite(session, a.actionId, a.stored));
    else if (op === "answerCapture")
      apply(answerPlayerRuntimeCapture(session, a.actionId, a.answer, admissionOf(a.held)));
    else if (op === "reportMediaLoad")
      apply(reportPlayerRuntimeMediaLoad(session, a.mediaId, a.report));
    else if (op === "observeTime") {
      catchUp = null;
      apply(observePlayerRuntimeTime(session, a.atMs, a.media));
    } else if (op === "beginCatchUp") catchUp = beginPlayerRuntimeCatchUp(session, a.targetMs);
    else if (op === "stepCatchUp") result = stepPlayerRuntimeCatchUp(catchUp!, () => false);
    else if (op === "adoptCatchUp") {
      session = adoptPlayerRuntimeCatchUp(session, catchUp!) ?? session;
      catchUp = null;
      result = { adopted: true };
    } else if (op === "dropCatchUp") {
      dropPlayerRuntimeCatchUp(catchUp!);
      catchUp = null;
    }
    steps.push({ name, result, ...shownOf(session) });
  }
  return {
    steps,
    snapshot: playerRuntimeSnapshot(session),
    recording: plainRecording(recorder.recording()),
  };
}

for (const delayMs of [undefined, 0, 50, 250])
  test(`the recording of every engine call is the adapter's own, in-process${delayMs === undefined ? " and in a Worker" : ` with replies ${delayMs} ms late`}`, async () => {
    const oracle = onAdapter();
    const inProcess = await overBridge(await inProcessBridge(delayMs), true);
    assert.deepEqual(inProcess.steps, oracle.steps, "every step shows what the adapter shows");
    assert.deepEqual(inProcess.snapshot, oracle.snapshot);
    assert.deepEqual(
      inProcess.recording,
      oracle.recording,
      "the host's recorder records what the adapter's does",
    );
    assert.equal(oracle.recording?.complete, true);
    if (delayMs !== undefined) return;
    const remote = await worker();
    try {
      const inWorker = await overBridge(remote, false);
      assert.deepEqual(inWorker.steps, oracle.steps);
      assert.deepEqual(
        inWorker.recording,
        oracle.recording,
        "the Worker's recorder records the same",
      );
    } finally {
      remote.client.terminate();
    }
  });

test("a complete recording replays to the live state; its recovered and frozen ends are kept apart", async () => {
  const oracle = onAdapter();
  const recording = oracle.recording!;
  const plan = compilePlayerProject(SCRIPT).plan!;
  // Successful replay: the anchor plus every recorded call is the live state.
  assert.deepEqual(
    rebuildRecordedSession(plan, recording.anchorSnapshot, recording.operations).exportSnapshot(),
    oracle.snapshot,
  );
  assert.deepEqual(recording.endSnapshot, oracle.snapshot);
});

/** A timer block that throws in its middle once the scope IDs are used up, as in the recorder's own tests. */
const THROWING = [
  "timer async 1 s {",
  '  say "before", instant',
  "  if true {",
  '    say "deep", instant',
  "  }",
  "}",
  'let pick = askChoice "Again"',
  "exit",
].join("\n");

/**
 * A session of THROWING restored where the next scope ID is the last: in-process through the transitional factory, as
 * the Player restores, in a Worker through its test op.
 */
async function aboutToThrow(bridge: PlayerBridge, inProcess: boolean): Promise<PlayerSession> {
  const token = await prepared(bridge, THROWING);
  const snapshotJson = JSON.stringify({
    ...playerRuntimeSnapshot(createPlayerRuntimeSession(THROWING)),
    nextScopeId: Number.MAX_SAFE_INTEGER - 1,
  });
  if (inProcess)
    return introduceNow(bridge, (host) =>
      restorePlayerRuntimeSessionAt(host.plan(token), snapshotJson, []),
    );
  const reply = await bridge.client.request("restoreForTest", { plan: token, snapshotJson });
  // EVIDENCE: validation: the test op replies with the new session's introduction.
  return bridge.open(reply.session!, reply.view as Introduction);
}

for (const inProcess of [true, false])
  test(`after a throw the frozen tape replays to its own end, and live recovery goes on from the publication before (${inProcess ? "in-process" : "in a Worker"})`, async () => {
    const bridge = inProcess ? await inProcessBridge() : await worker();
    try {
      const restored = await aboutToThrow(bridge, inProcess);
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
      // No publication shows a part of the call that threw.
      assert.equal(bridge.latest(restored), before);
      const frozen = await recordingOf(bridge, inProcess);
      assert.ok(frozen !== null);
      assert.equal(frozen.complete, true);
      assert.equal(frozen.operations.at(-1)?.thrown, "RuntimeDataError");
      // The frozen tape's end is its successful prefix replayed, which is no publication of the session.
      const plan = compilePlayerProject(THROWING).plan!;
      const prefix = frozen.operations.filter((operation) => operation.thrown === null);
      assert.deepEqual(
        rebuildRecordedSession(plan, frozen.anchorSnapshot, prefix).exportSnapshot(),
        frozen.endSnapshot,
      );
      // Live recovery: the next op goes on from the publication before the throw, and another accepted call follows.
      const recovered = await bridge.request<{ readonly kind: string }>(before, "observeTime", {
        atMs: 500,
        media: [],
      });
      assert.equal(recovered.kind, "observed");
      const live = bridge.latest(restored)!;
      assert.equal(live.state.observedSessionTimeMs, 500);
      assert.notDeepEqual(
        frozen.endSnapshot?.observedSessionTimeMs,
        500,
        "the frozen end is not the live state",
      );
      // Nothing was shown twice: the store applied the recovery as one publication after the cursor.
      assert.deepEqual(
        live.events.map((event) => event.sequence),
        [...new Set(live.events.map((event) => event.sequence))],
      );
      // The frozen tape stays as it was.
      assert.deepEqual(await recordingOf(bridge, inProcess), frozen);
    } finally {
      bridge.client.terminate();
    }
  });

test("in a Worker, a failure freezes the recording at it, and an end it cannot export stays unavailable", async () => {
  const FAILING =
    "let xs = (1..=1500).toList()\nwait 1 s\nlet zero = dynamic(0)\nlet result = 1 / zero\nexit\nfunction dynamic(value) {\n    return value\n}";
  const remote = await worker({ UNEXPORTABLE_LIST_OVER: "1000" });
  try {
    const session = await remote.start(await prepared(remote, FAILING), START, true);
    // Running: the current state cannot be exported, and no earlier state stands in for it.
    const running = await recordingOf(remote, false);
    assert.deepEqual(
      [running.complete, running.reason, running.endSnapshot],
      [false, "The current state could not be exported.", null],
    );
    await remote.request(session, "observeTime", { atMs: 5_000, media: [] });
    assert.equal(remote.latest(session)!.state.status, "failed");
    const failed = await recordingOf(remote, false);
    assert.deepEqual(
      [failed.complete, failed.reason, failed.endSnapshot],
      [false, "The state at the error could not be exported.", null],
    );
    assert.equal(failed.endFailure?.code, "TSR036");
  } finally {
    remote.client.terminate();
  }
});

test("in a Worker, a call larger than the recorder keeps makes the recording incomplete", async () => {
  const remote = await worker({ RECORDER_ARGUMENT_BYTES: "50" });
  try {
    const session = await remote.start(
      await prepared(remote, 'let name = askText "Name"\nexit'),
      START,
      true,
    );
    await remote.request(session, "submitComposer", {
      actionId: activePlayerRuntimeInteraction(session.state)!.actionId,
      text: "x".repeat(100),
      input: "enter",
    });
    const recording = await recordingOf(remote, false);
    assert.deepEqual(
      [recording.complete, recording.reason],
      [false, "A recorded call was larger than the recording keeps."],
    );
  } finally {
    remote.client.terminate();
  }
});

for (const inProcess of [true, false])
  test(`a new Start's recording replaces the connection's, and a restored session's begins at its restore (${inProcess ? "in-process" : "in a Worker"})`, async () => {
    const bridge = inProcess ? await inProcessBridge() : await worker();
    try {
      const a = await bridge.start(
        await prepared(bridge, 'say "A", instant\nlet x = askChoice "A1"\nexit'),
        START,
        true,
      );
      await bridge.halt(a);
      const atStop = await recordingOf(bridge, inProcess);
      assert.ok(atStop.operations.length > 0);
      // The stopped session's recording, as its stop left it, is not the next Start's.
      await bridge.start(
        await prepared(bridge, 'say "B", instant\nlet y = askChoice "B1"\nexit'),
        START,
        true,
      );
      const next = await recordingOf(bridge, inProcess);
      // Each recording ends at its own session's state: A's offers "A1", B's "B1".
      assert.ok(JSON.stringify(atStop.endSnapshot).includes('"A1"'));
      assert.ok(JSON.stringify(next.endSnapshot).includes('"B1"'));
      assert.ok(!JSON.stringify(next.endSnapshot).includes('"A1"'));
      assert.equal(next.operations.length, 1, "B's recording begins at B's Start");
      // A restored session records from its restore: its recording's anchor is the restored state.
      const restored = await aboutToThrow(bridge, inProcess);
      await bridge.request(restored, "beginRecording", null);
      const fromRestore = await recordingOf(bridge, inProcess);
      assert.equal(fromRestore.operations.length, 0);
      assert.equal(fromRestore.anchorSnapshot.nextScopeId, Number.MAX_SAFE_INTEGER - 1);
    } finally {
      bridge.client.terminate();
    }
  });
