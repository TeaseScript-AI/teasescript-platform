import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/runtime/compile-project.js";
import { rebuildRecordedSession } from "../player/debug/debug-export.js";
import { DebugRecorder } from "../player/debug/debug-recorder.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { admissionOf, type HeldMedia } from "../player/engine-bridge/held-media.js";
import type * as InProcess from "../player/engine-bridge/in-process.js";
import { heldRecording, introduceNow } from "../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import type { Introduction } from "../player/engine-bridge/session-protocol.js";
import { PlayerBridge } from "../player/runtime/player-bridge.js";
import {
  adoptPlayerRuntimeCatchUp,
  answeredByPlayerInput,
  answerPlayerRuntimeCapture,
  beginPlayerRuntimeCatchUp,
  completePlayerRuntimeStorageWrite,
  continuePlayerRuntimeSession,
  dropPlayerRuntimeCatchUp,
  observePlayerRuntimeTime,
  playerRuntimeSnapshot,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSessionAt,
  stepPlayerRuntimeCatchUp,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeCatchUp,
  type PlayerRuntimeSession,
} from "../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeCapture,
  activePlayerRuntimeInteraction,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimeMedia,
  type PlayerSession,
  type PlayerSessionView,
} from "../player/runtime/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { hatch, inProcessBridge } from "./helpers/in-process-bridge.js";
import { plainRecording } from "./helpers/plain-recording.js";
import { loadPlayerModule } from "./helpers/player-modules.js";
import {
  adapterReplay,
  assertEngineInputs,
  assertTrace,
  quiesce,
  tapPublications,
  trackRequests,
  withLiveHost,
  type LiveComposable,
  type LiveHost,
  type LiveHostModules,
  type ShownSession,
  type LoggedRequest,
  type PublicationTap,
  type RequestTracker,
  type ReplayStep,
} from "./helpers/replay-harness.js";
import type { EffectSample } from "./helpers/live-host-effects.js";
import { compareStructures, renderPath } from "./helpers/runtime-state-comparison.js";
import type * as RuntimeAdapter from "../player/runtime/runtime-adapter.js";
import type { RuntimeSnapshot } from "../src/index.js";
import { NO_MARKS } from "../player/debug/debug-history-marks.js";

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

/**
 * What a step shows, comparable across the three runs: a publication's critical view (L5f), so the adapter's own
 * session is compared without its active calls.
 */
const shownOf = (session: Pick<PlayerSession, "state" | "events">) => {
  const { calls: _calls, ...state } = { calls: undefined, ...session.state };
  return { state, events: [...session.events] };
};

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
    return introduceNow(
      bridge,
      (host) => restorePlayerRuntimeSessionAt(host.plan(token), snapshotJson, []),
      NO_MARKS,
    );
  const reply = await bridge.client.request("restoreForTest", { plan: token, snapshotJson });
  // EVIDENCE: validation: the test op replies with the new session's introduction.
  return bridge.open(reply.session!, reply.view as Introduction);
}

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
  const remote = await worker({ RECORDER_ARGUMENT_CODE_UNITS: "50" });
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

/*
 * Replay, over a declared family: three replay kinds × three backends. The cut is a call that throws. Live recovery is
 * judged by the complete trace of the publications after the cut, by value, from the cut's cursor (`tapPublications`,
 * #1919), against one oracle: the adapter restored at the publication before the cut, given the live run's requests
 * after it (`adapterReplay`). The frozen tape matches no publication, so it keeps its own oracle, its recorded
 * successful prefix replayed, plus facts the publication before the cut fixes independently. Where the composable runs,
 * it observes every publication of the steps and settles before the next, and every session it shows through the last
 * sample must equal the oracle's. Its host effects are sampled at the cut, after every step and after the judgments,
 * and each must equal the control run's sample at the same point, which took the same steps without the cut, so the
 * steps' own effects (the script's end releasing its medium) are in both (`LiveHostEffects`). Every judgment runs while
 * the composable lives (`withLiveHost`).
 */
const KINDS = ["successful replay", "frozen failure replay", "live recovery"] as const;
const BACKENDS = ["in-process", "a Worker", "the composable"] as const;
type Kind = (typeof KINDS)[number];
type Backend = (typeof BACKENDS)[number];

/** A save, a medium, a capture, then a timer block that throws once its scope opens, and a choice to answer after. */
const REPLAYED = [
  'save 1 as "kept"',
  'let m = playAudio async "a.mp3"',
  "let photo = takePhoto()",
  "timer async 1 s {",
  '  say "before", instant',
  "  if true {",
  '    say "deep", instant',
  "  }",
  "}",
  'let pick = askChoice "Again"',
  'say "chose ${pick}", instant',
  "exit",
].join("\n");
const REPLAYED_START = { ...START };
/** The restored state the runs begin at: the next scope ID is the last, so the timer block's scope throws. */
const restoredJson = () =>
  JSON.stringify({
    ...playerRuntimeSnapshot(createPlayerRuntimeSession(REPLAYED, REPLAYED_START)),
    nextScopeId: Number.MAX_SAFE_INTEGER - 1,
  });

/** The first option of the choice `shown` presents. */
function firstOption(shown: PlayerSessionView): string {
  const foreground = playerRuntimeForeground(shown);
  assert.ok(foreground?.kind === "choose", "the choice is presented");
  return foreground.options[0]!.id;
}

/** The steps after the cut: recovery at 500 ms, then the choice's first option. */
const STEPS: readonly ReplayStep[] = [
  { name: "recover", request: () => ({ op: "observeTime", args: { atMs: 500, media: [] } }) },
  {
    name: "choose",
    request: (shown) => ({
      op: "selectChoice",
      args: {
        actionId: activePlayerRuntimeInteraction(shown.state)!.actionId,
        optionId: firstOption(shown),
        input: "button",
      },
    }),
  },
];

/**
 * The oracle: the adapter restored at `before`'s state, given the live run's requests after the cut, the test's steps
 * and the composable's own observations alike, as the host applied them.
 */
function afterCut(before: RuntimeSnapshot, requests: readonly LoggedRequest[]) {
  const plan = compilePlayerProject(REPLAYED).plan!;
  const oracle = adapterReplay(
    restorePlayerRuntimeSessionAt(plan, JSON.stringify(before), []),
    requests,
  );
  return { ...oracle, snapshot: playerRuntimeSnapshot(oracle.last) };
}

/** What a run gives each kind to judge. */
interface ReplayRun {
  /** The publication before the cut, as a snapshot (the live state there). */
  readonly before: RuntimeSnapshot;
  /** The recording read at the publication before the cut. */
  readonly atCut: PlainRecording;
  /** The recording read after the call that threw: frozen at it. */
  readonly frozen: PlainRecording;
  /** The final state after the steps, where the test can read it. */
  readonly suffix: { readonly snapshot: RuntimeSnapshot | null };
  /** The session's requests from the cut on, of every producer, as the host applied them. */
  readonly requests: readonly LoggedRequest[];
  /** The publications the session's store was given from the cut on. */
  readonly trace: PublicationTap;
  /** The composable's effects at the cut and after each step since; `null` without the composable. */
  readonly effects: readonly EffectSample[] | null;
  /**
   * What the composable has shown since the cut, read when it is judged, each by value: its revision relative to the
   * cut's, its state, and every event it held since the cut; `null` without the composable.
   */
  readonly observed: (() => readonly ShownSession[]) | null;
}

/**
 * The call that throws at the cut, then the steps through `bridge`, each from the shown session. On the composable,
 * `host` gets every publication in the tick its store applies it, and settles before the next step; its effects are
 * sampled after each. The tap is on from the publication before the cut, the call that threw included.
 */
async function cutAndRecover(
  bridge: PlayerBridge,
  session: PlayerSession,
  tracker: RequestTracker,
  host: LiveHost | null,
  throwing = true,
) {
  const before = bridge.latest(session)!;
  const trace = tapPublications(bridge, session);
  const mark = tracker.log.length;
  const since = () => tracker.log.slice(mark).filter((request) => request.session === session.id);
  const effects: EffectSample[] = host === null ? [] : [await host.effects()];
  // The control run takes the same steps from the same state, without the call that throws or the recovery.
  if (throwing)
    await assert.rejects(
      bridge.request(before, "observeTime", { atMs: 1_000, media: [] }),
      (error: unknown) => error instanceof Error && error.name === "RuntimeDataError",
    );
  assert.equal(
    bridge.latest(session),
    before,
    "no publication shows a part of the call that threw",
  );
  return {
    before,
    trace,
    effects,
    recover: async () => {
      for (const step of STEPS) {
        const shown = bridge.latest(session)!;
        const { op, args } = step.request(shown);
        await bridge.request(shown, op, args, host === null ? {} : { publish: host.show });
        if (host !== null) {
          await host.settle();
          effects.push(await host.effects());
        }
      }
      // The run ends quiescent too: every request after the cut, the host's own included, has its reply.
      await quiesce(
        bridge,
        session,
        tracker,
        host?.settle ?? (() => new Promise((resolve) => setTimeout(resolve, 0))),
      );
      trace.stop();
      return since();
    },
    /** The session's requests from the cut until now, of every producer. */
    since,
  };
}

/** A run on the bridge alone, in-process or in a Worker: the test answers the save, the medium and the capture. */
async function bridgeRun(inProcess: boolean): Promise<JudgedRun> {
  const bridge = inProcess ? await inProcessBridge() : await worker();
  const tracker = trackRequests(bridge);
  try {
    const token = await prepared(bridge, REPLAYED);
    const snapshotJson = restoredJson();
    let session = inProcess
      ? introduceNow(
          bridge,
          (host) => restorePlayerRuntimeSessionAt(host.plan(token), snapshotJson, []),
          NO_MARKS,
        )
      : await (async () => {
          const reply = await bridge.client.request("restoreForTest", {
            plan: token,
            snapshotJson,
          });
          // EVIDENCE: validation: the test op replies with the new session's introduction.
          return bridge.open(reply.session!, reply.view as Introduction);
        })();
    await bridge.request(session, "beginRecording", null);
    const send = async (op: string, args: unknown) => {
      await bridge.request(bridge.latest(session)!, op, args);
      session = bridge.latest(session)!;
    };
    await send("continue", { capture: { wallClockMs: 0, temporalContext: TEMPORAL } });
    await send("completeStorageWrite", {
      actionId: pendingPlayerRuntimeStorageWrite(session.state)!.actionId,
      stored: true,
    });
    await send("reportMediaLoad", {
      mediaId: playerRuntimeMedia(session.state).media[0]!.mediaId,
      report: { kind: "loaded", durationMs: 9_000 },
    });
    await send("answerCapture", {
      actionId: activePlayerRuntimeCapture(session.state)!.actionId,
      answer: { kind: "unavailable", reason: "unconfigured" },
      held: null,
    });
    // The cut is quiescent, as the oracle's restore at it assumes: nothing in flight, nothing more to publish.
    await quiesce(bridge, session, tracker, () => new Promise((resolve) => setTimeout(resolve, 0)));
    session = bridge.latest(session)!;
    const atCut = await recordingOf(bridge, inProcess);
    // The live state before the cut: the host's own, in-process; in a Worker, the adapter's run of the same calls.
    const before = inProcess ? hatch(session, playerRuntimeSnapshot) : adapterBefore();
    const cut = await cutAndRecover(bridge, session, tracker, null);
    const frozen = await recordingOf(bridge, inProcess);
    const requests = await cut.recover();
    return await judged(
      {
        before,
        atCut,
        frozen,
        suffix: {
          snapshot: inProcess ? hatch(bridge.latest(session)!, playerRuntimeSnapshot) : null,
        },
        requests,
        trace: cut.trace,
        effects: null,
        observed: null,
      },
      (judgment) => judgment(),
    );
  } finally {
    tracker.stop();
    bridge.client.terminate();
  }
}

/** The adapter's own run of `bridgeRun`'s calls up to the cut, for the Worker, whose live state the test cannot read. */
function adapterBefore(): RuntimeSnapshot {
  const plan = compilePlayerProject(REPLAYED).plan!;
  let session = restorePlayerRuntimeSessionAt(plan, restoredJson(), []);
  session = continuePlayerRuntimeSession(session, {
    wallClockMs: 0,
    temporalContext: TEMPORAL,
  }).session;
  session = completePlayerRuntimeStorageWrite(
    session,
    pendingPlayerRuntimeStorageWrite(session.state)!.actionId,
    true,
  ).session;
  session = reportPlayerRuntimeMediaLoad(
    session,
    playerRuntimeMedia(session.state).media[0]!.mediaId,
    { kind: "loaded", durationMs: 9_000 },
  ).session;
  session = answerPlayerRuntimeCapture(
    session,
    activePlayerRuntimeCapture(session.state)!.actionId,
    { kind: "unavailable", reason: "unconfigured" },
  ).session;
  return playerRuntimeSnapshot(session);
}

/** `snapshot` as its JSON reads back: what two runs' states compare by. */
const plainOf = (snapshot: RuntimeSnapshot): string => JSON.stringify(snapshot);

const JUDGE: Record<Kind, (run: ReplayRun) => void> = {
  "successful replay": (run) => {
    // The tape up to the cut replays to the live state there.
    const plan = compilePlayerProject(REPLAYED).plan!;
    const replayed = rebuildRecordedSession(
      plan,
      run.atCut.anchorSnapshot,
      run.atCut.operations,
    ).exportSnapshot();
    assert.deepEqual(plainOf(replayed), plainOf(run.before));
    assert.equal(run.atCut.complete, true);
  },
  "frozen failure replay": (run) => {
    const plan = compilePlayerProject(REPLAYED).plan!;
    const prefix = run.frozen.operations.filter((operation) => operation.thrown === null);
    assert.equal(run.frozen.operations.at(-1)?.thrown, "RuntimeDataError");
    // Its own oracle: the recorded successful prefix replayed is its end.
    assert.deepEqual(
      plainOf(rebuildRecordedSession(plan, run.frozen.anchorSnapshot, prefix).exportSnapshot()),
      plainOf(run.frozen.endSnapshot!),
    );
    // And what the publication before the cut fixes: the save is kept, and none waits.
    assert.deepEqual(run.frozen.endSnapshot!.scriptStorage, run.before.scriptStorage);
    assert.equal(
      JSON.stringify(run.frozen.endSnapshot).includes('"storageWrite"'),
      false,
      "no save waits again at the frozen end",
    );
  },
  "live recovery": (run) => {
    const oracle = afterCut(run.before, run.requests);
    // Every publication after the cut, complete and by value, from the cut's cursor: no state, event or cursor apart.
    assertTrace(run.trace, oracle.entries);
    if (run.suffix.snapshot !== null)
      assert.deepEqual(plainOf(run.suffix.snapshot), plainOf(oracle.snapshot));
    assertShown(run);
  },
};

/**
 * The live host showed every publication after the cut, in order, each once, as the oracle has it: its state and every
 * event since the cut, by value, as far as it has shown them when this runs.
 */
function assertShown(run: ReplayRun): void {
  if (run.observed === null) return;
  const oracle = afterCut(run.before, run.requests);
  const expected = oracle.entries.map((entry) => ({ revision: entry.revision, ...entry.held }));
  const comparison = compareStructures(expected, run.observed());
  const first = comparison.mismatches[0];
  assert.ok(
    comparison.equal,
    first === undefined
      ? "the composable showed otherwise than the oracle"
      : `the composable showed otherwise than the oracle at ${renderPath(first.path)}: oracle ${first.oracle}, shown ${first.candidate}`,
  );
}

/** A run with its kinds' verdicts, each judged while the run's host lived: `null` for a pass, else what failed. */
interface JudgedRun {
  readonly run: ReplayRun;
  readonly verdicts: Readonly<Record<Kind, unknown>>;
}

/**
 * Judges every kind on `run` through `judge`, which runs a judgment only while the host lives. A kind not judged, as
 * when the run failed first, stays failed. With `last`, the host's effects are sampled once more after the judgments,
 * their work settled, while it still lives: every sample, that one included, must equal the control run's at the same
 * point. Then what the composable showed is judged again, through that last sample.
 */
async function judged(
  run: ReplayRun,
  judge: (judgment: () => void) => void,
  last?: () => Promise<EffectSample>,
  control?: ControlRun,
): Promise<JudgedRun> {
  const verdicts: Record<Kind, unknown> = {
    "successful replay": new Error("successful replay was not judged"),
    "frozen failure replay": new Error("frozen failure replay was not judged"),
    "live recovery": new Error("live recovery was not judged"),
  };
  for (const kind of KINDS)
    try {
      judge(() => JUDGE[kind](run));
      verdicts[kind] = null;
    } catch (error) {
      verdicts[kind] = error;
    }
  if (run.effects !== null) {
    // Replay and recovery made no main-side effect: at every sample, the judgments' included, each recorded host
    // service's state and mutating calls (`LiveHostEffects`) equal the control run's, which took the same steps without the cut. What the steps
    // themselves do (the script's end releasing its medium) is in both; what recovery adds is a difference.
    let effects: unknown = null;
    try {
      assert.ok(control !== undefined, "the composable's run has its control run");
      if (control.verdict !== null) throw control.verdict;
      const samples = last === undefined ? run.effects : [...run.effects, await last()];
      assert.equal(
        samples.length,
        control.effects.length,
        "the recovery and control runs took as many samples",
      );
      samples.forEach((sample, index) => {
        const comparison = compareStructures(control.effects[index], sample);
        const first = comparison.mismatches[0];
        assert.ok(
          comparison.equal,
          first === undefined
            ? `the composable's effects differ from the control run's at sample ${index}`
            : `the composable's effects differ from the control run's at sample ${index}, ${renderPath(first.path)}: control ${first.oracle}, recovery ${first.candidate}`,
        );
      });
    } catch (error) {
      effects = error;
    }
    for (const kind of KINDS) verdicts[kind] ??= effects;
    // What the composable showed, judged again through the last sample: nothing it showed during the judgments goes
    // unseen.
    try {
      judge(() => assertShown(run));
    } catch (error) {
      verdicts["live recovery"] ??= error;
    }
  }
  return { run, verdicts };
}

const runs = new Map<Backend, Promise<JudgedRun>>();
const runOn = (backend: Backend, start: () => Promise<JudgedRun>) => {
  if (!runs.has(backend)) runs.set(backend, start());
  return runs.get(backend)!;
};
const RUNS: Record<Backend, () => Promise<JudgedRun>> = {
  "in-process": () => bridgeRun(true),
  "a Worker": () => bridgeRun(false),
  // The control run first, whose effect samples the recovery run's are judged against while its host lives.
  "the composable": async () => composableRun(await controlRun()),
};

const REPLAY_CASES = KINDS.flatMap((kind) =>
  BACKENDS.map((backend) => ({ kind, backend, name: `${kind}, ${backend}` })),
);

test("the replay family covers every kind on every backend", () => {
  for (const kind of KINDS)
    for (const backend of BACKENDS)
      assert.ok(REPLAY_CASES.some((each) => each.name === `${kind}, ${backend}`));
  assert.equal(new Set(REPLAY_CASES.map((each) => each.name)).size, KINDS.length * BACKENDS.length);
});

for (const { kind, backend, name } of REPLAY_CASES)
  test(`replay family: ${name}`, async () => {
    const { verdicts } = await runOn(backend, RUNS[backend]);
    // The verdict was reached inside the run, while its host lived.
    if (verdicts[kind] !== null) throw verdicts[kind];
  });

test("the publication tap names a field it does not declare, and the harness file that declares them", () => {
  const shown = { revision: 3, state: {}, events: [] };
  const store = { apply: (_view: unknown) => true };
  const tap = tapPublications({ store: () => store, latest: () => shown }, shown);
  // A publication with one field more and one less than declared, as a later package might send.
  store.apply({
    revision: 4,
    state: {},
    from: 0,
    eventsThrough: 0,
    events: [],
    callView: null,
    historyPoint: null,
  });
  tap.stop();
  assert.throws(
    () => assertTrace(tap, []),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("unexpected 'historyPoint'") &&
      error.message.includes("missing 'instructions'") &&
      error.message.includes("tests/helpers/replay-harness.ts (PUBLICATION_FIELDS)"),
  );
});

/** The bundle the composable runs in, loaded once. */
let bundled: Promise<{
  readonly modules: LiveHostModules;
  readonly facade: typeof InProcess;
  readonly adapter: typeof RuntimeAdapter;
}> | null = null;
/** The composable's test API this family reads beside the harness's. */
interface RecordingComposable extends LiveComposable {
  debugRecording(): Parameters<typeof plainRecording>[0];
}
const bundle = () =>
  (bundled ??= (async () => {
    const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
    // EVIDENCE: validation: Vite loaded the real source module; this is its host API.
    const usePlayerSession = module.usePlayerSession as LiveHostModules["usePlayerSession"];
    const captured = await loadPlayerModule("player/media/captured-media.ts");
    // EVIDENCE: validation: the bundle's captured-media module exports its store class.
    const capturedMediaStore = captured.CapturedMediaStore as LiveHostModules["capturedMediaStore"];
    return {
      modules: { usePlayerSession, capturedMediaStore },
      // EVIDENCE: validation: the bundle's in-process backend, whose sessions the composable's facade reaches.
      facade: (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof InProcess,
      // EVIDENCE: validation: the bundle's adapter, whose sessions the bundle's host holds.
      adapter: (await loadPlayerModule("player/runtime/runtime-adapter.ts")) as typeof RuntimeAdapter,
    };
  })());

/**
 * The session's requests through the last sample, after the judgments (`late`): each an engine input, as the trace's,
 * and none beyond those the trace judged (`judged`), so nothing the session sends after its trace closed goes unseen.
 */
function assertNothingSentLate(
  late: readonly LoggedRequest[],
  judged: readonly LoggedRequest[],
): void {
  assertEngineInputs(late);
  assert.equal(
    late.length,
    judged.length,
    `the session sent ${late
      .slice(judged.length)
      .map((request) => `'${request.op}'`)
      .join(", ")} after its trace was judged`,
  );
}

/** The control run's effect samples, and whether its own trace equals the adapter oracle (`null` when it does). */
interface ControlRun {
  readonly effects: readonly EffectSample[];
  readonly verdict: unknown;
}

/**
 * The real composable on its in-process engine, restored at the fixture's state: the composable itself writes and
 * acknowledges the save, plays the medium and answers the capture, up to a quiescent cut. `body` then runs while its
 * host lives. `run` names the run for the mutants, which arm only in the recovery run.
 */
async function liveRun<T>(
  run: "recovery" | "control",
  body: (live: {
    readonly host: LiveHost;
    readonly player: RecordingComposable;
    readonly bridge: PlayerBridge;
    readonly tracker: RequestTracker;
    readonly session: PlayerSession;
    readonly before: RuntimeSnapshot;
    readonly adapter: typeof RuntimeAdapter;
    readonly facade: typeof InProcess;
  }) => Promise<T>,
): Promise<T> {
  const { modules, facade, adapter } = await bundle();
  const bridge = facade.createInProcessBackend(BUILD);
  const tracker = trackRequests(bridge);
  Reflect.set(globalThis, "__replayRun", run);
  try {
    return await withLiveHost(modules, bridge, async (host) => {
      // EVIDENCE: validation: the bundle's composable has the recording test API beside the harness's.
      const player = host.player as RecordingComposable;
      await player.bridge;
      await player.loadScriptStorage();
      const plan = compilePlayerProject(REPLAYED).plan!;
      player.prepareRestore(adapter.restorePlayerRuntimeSessionAt(plan, restoredJson(), []));
      await player.activate();
      const until = async (done: () => boolean, what: string) => {
        for (let turn = 0; !done(); turn++) {
          assert.ok(turn < 400, what);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      // Start primes audio elements; the medium takes one of them.
      const medium = () => host.elements.find((element) => element.src.endsWith("a.mp3"));
      await until(() => medium() !== undefined, "the medium did not play");
      medium()!.dispatchEvent(new Event("loadedmetadata"));
      await until(
        () =>
          player.session.value !== null &&
          activePlayerRuntimeInteraction(player.session.value.state) !== null,
        "the choice was not presented",
      );
      // The cut is quiescent, as the oracle's restore at it assumes: no request of the composable's own work in flight,
      // every reply delivered, and nothing more published while it settles.
      await quiesce(bridge, player.session.value!, tracker, host.settle);
      const session = bridge.latest(player.session.value!)!;
      assert.equal(
        player.session.value?.revision,
        session.revision,
        "the composable shows the cut",
      );
      // Before the cut the composable itself saved, played the medium and answered the capture.
      const counted = (await host.effects()).calls;
      assert.ok(
        (counted["scriptStorage"]?.["write"] ?? 0) >= 1 &&
          (counted["Audio"]?.["play"] ?? 0) >= 1 &&
          tracker.log.some((request) => request.op === "answerCapture"),
        JSON.stringify(counted),
      );
      const before = facade.hatch(session, adapter.playerRuntimeSnapshot);
      return await body({ host, player, bridge, tracker, session, before, adapter, facade });
    });
  } finally {
    Reflect.deleteProperty(globalThis, "__replayRun");
    tracker.stop();
    bridge.client.terminate();
  }
}

/**
 * The control run: the same restore, cut and steps in the live composable, without the call that throws or the
 * recovery. Its effect samples, taken at the same points, are what the recovery run's must equal; its own trace must
 * equal the adapter oracle given its requests, judged while its host lives.
 */
async function controlRun(): Promise<ControlRun> {
  return liveRun("control", async ({ host, bridge, tracker, session, before }) => {
    const cut = await cutAndRecover(bridge, session, tracker, host, false);
    // Where the recovery run reads its frozen recording.
    cut.effects.push(await host.effects());
    const requests = await cut.recover();
    let verdict: unknown = null;
    try {
      host.judge(() => assertTrace(cut.trace, afterCut(before, requests).entries));
    } catch (error) {
      verdict = error;
    }
    await quiesce(bridge, session, tracker, host.settle);
    const last = await host.effects();
    try {
      host.judge(() => assertNothingSentLate(cut.since(), requests));
    } catch (error) {
      verdict ??= error;
    }
    host.judge(() => cut.effects.push(last));
    return { effects: cut.effects, verdict };
  });
}

/**
 * The recovery run in the real composable: the call that throws, then the steps, each publication handed to the
 * composable as its own work would show it; every kind is judged before the composable stops, its effects against the
 * control run's.
 */
async function composableRun(control: ControlRun): Promise<JudgedRun> {
  return liveRun(
    "recovery",
    async ({ host, player, bridge, tracker, session, before, adapter, facade }) => {
      const cutRevision = session.revision;
      const cutEvents = session.events.length;
      const atCut = plainRecording(player.debugRecording());
      assert.ok(atCut !== null);
      const cut = await cutAndRecover(bridge, session, tracker, host);
      const frozen = plainRecording(player.debugRecording());
      assert.ok(frozen !== null);
      cut.effects.push(await host.effects());
      const requests = await cut.recover();
      return await judged(
        {
          before,
          atCut,
          frozen,
          requests,
          suffix: {
            snapshot: facade.hatch(bridge.latest(session)!, adapter.playerRuntimeSnapshot),
          },
          trace: cut.trace,
          effects: cut.effects,
          observed: () =>
            host.observed
              .filter((shown) => shown.revision > cutRevision)
              .map((shown) => ({
                revision: shown.revision - cutRevision,
                state: shown.state,
                events: shown.events.slice(cutEvents),
              })),
        },
        host.judge,
        async () => {
          await quiesce(bridge, session, tracker, host.settle);
          const sample = await host.effects();
          return host.judge(() => {
            assertNothingSentLate(cut.since(), requests);
            return sample;
          });
        },
        control,
      );
    },
  );
}
