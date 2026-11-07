import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, type Ref } from "vue";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import { rebuildRecordedSession } from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { admissionOf, type HeldMedia } from "../player/engine-bridge/held-media.js";
import type * as InProcess from "../player/engine-bridge/in-process.js";
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
  continuePlayerRuntimeSession,
  dropPlayerRuntimeCatchUp,
  observePlayerRuntimeTime,
  playerRuntimeSnapshot,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice,
  stepPlayerRuntimeCatchUp,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeCatchUp,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import {
  activePlayerRuntimeCapture,
  activePlayerRuntimeInteraction,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimeMedia,
  type PlayerSession,
  type PlayerSessionView,
} from "../player/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { hatch, inProcessBridge } from "./helpers/in-process-bridge.js";
import { plainRecording } from "./helpers/plain-recording.js";
import { loadPlayerModule } from "./helpers/player-modules.js";
import type * as RuntimeAdapter from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { RuntimeSnapshot } from "../src/index.js";

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
    return introduceNow(bridge, (host) =>
      restorePlayerRuntimeSessionAt(host.plan(token), snapshotJson, []),
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

/*
 * Replay, over a declared family: three replay kinds × three backends. The cut is a call that throws. Every kind but
 * the frozen one is judged by one oracle (`afterCut`): an adapter restored at the publication before the cut, given the
 * same suffix. The frozen tape matches no publication, so it keeps its own oracle, its recorded successful prefix
 * replayed, plus facts the publication before the cut fixes independently. Where the composable runs, its storage
 * writes, media and capture answers are counted from the publication before the cut, and must not grow.
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

/** The oracle: an adapter restored at `before`'s state, given the suffix after the cut. */
function afterCut(before: RuntimeSnapshot) {
  const plan = compilePlayerProject(REPLAYED).plan!;
  let session = restorePlayerRuntimeSessionAt(plan, JSON.stringify(before), []);
  const recovered = observePlayerRuntimeTime(session, 500, []);
  session = recovered.session;
  const atRecovery = session.state;
  const chosen = selectPlayerRuntimeChoice(session, firstOption(session));
  session = chosen!.session;
  return {
    outcomes: [recovered.outcome, chosen!.outcome],
    // Every publication of the suffix: the recovered one, then the choice's, as publications carry them (L5f).
    states: [atRecovery, session.state].map((state) => shownOf({ state, events: [] }).state),
    events: [...session.events],
    snapshot: playerRuntimeSnapshot(session),
  };
}

/** What a run gives each kind to judge. */
interface ReplayRun {
  /** The publication before the cut, as a snapshot (the live state there). */
  readonly before: RuntimeSnapshot;
  /** The recording read at the publication before the cut. */
  readonly atCut: PlainRecording;
  /** The recording read after the call that threw: frozen at it. */
  readonly frozen: PlainRecording;
  /** The suffix after the cut, run by the backend. */
  readonly suffix: {
    readonly outcomes: unknown[];
    readonly states: unknown[];
    readonly events: unknown[];
    readonly snapshot: RuntimeSnapshot | null;
  };
  /** The composable's effects, before the cut and after each kind's step; equal in a run whose replay has no effect. */
  readonly effects: readonly number[] | null;
}

/** The suffix after the cut through `bridge`: the call that throws, then recovery at 500 ms, then the choice. */
async function cutAndRecover(
  bridge: PlayerBridge,
  session: PlayerSession,
  show: (next: PlayerSession) => void,
) {
  const before = bridge.latest(session)!;
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
    recover: async () => {
      const recovered = await bridge.request(before, "observeTime", { atMs: 500, media: [] });
      show(bridge.latest(session)!);
      const shown = bridge.latest(session)!;
      const atRecovery = shown.state;
      const chosen = await bridge.request(shown, "selectChoice", {
        actionId: activePlayerRuntimeInteraction(shown.state)!.actionId,
        optionId: firstOption(shown),
        input: "button",
      });
      const last = bridge.latest(session)!;
      show(last);
      return {
        outcomes: [recovered, chosen],
        states: [atRecovery, last.state],
        events: [...last.events],
      };
    },
  };
}

/** A run on the bridge alone, in-process or in a Worker: the test answers the save, the medium and the capture. */
async function bridgeRun(inProcess: boolean): Promise<ReplayRun> {
  const bridge = inProcess ? await inProcessBridge() : await worker();
  try {
    const token = await prepared(bridge, REPLAYED);
    const snapshotJson = restoredJson();
    let session = inProcess
      ? introduceNow(bridge, (host) =>
          restorePlayerRuntimeSessionAt(host.plan(token), snapshotJson, []),
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
    const atCut = await recordingOf(bridge, inProcess);
    // The live state before the cut: the host's own, in-process; in a Worker, the adapter's run of the same calls.
    const before = inProcess ? hatch(session, playerRuntimeSnapshot) : adapterBefore();
    const cut = await cutAndRecover(bridge, session, () => {});
    const frozen = await recordingOf(bridge, inProcess);
    const suffix = await cut.recover();
    return {
      before,
      atCut,
      frozen,
      suffix: {
        ...suffix,
        snapshot: inProcess ? hatch(bridge.latest(session)!, playerRuntimeSnapshot) : null,
      },
      effects: null,
    };
  } finally {
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

const runs = new Map<Backend, Promise<ReplayRun>>();
const runOn = (backend: Backend, start: () => Promise<ReplayRun>) => {
  if (!runs.has(backend)) runs.set(backend, start());
  return runs.get(backend)!;
};
const RUNS: Record<Backend, () => Promise<ReplayRun>> = {
  "in-process": () => bridgeRun(true),
  "a Worker": () => bridgeRun(false),
  "the composable": () => composableRun(),
};

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
    const oracle = afterCut(run.before);
    assert.deepEqual(run.suffix.outcomes, oracle.outcomes);
    assert.deepEqual(run.suffix.states, oracle.states);
    // The events after the cut, in order: the recovered session showed nothing twice.
    assert.deepEqual(
      run.suffix.events.slice(-oracle.events.length),
      oracle.events.slice(-oracle.events.length),
    );
    if (run.suffix.snapshot !== null)
      assert.deepEqual(plainOf(run.suffix.snapshot), plainOf(oracle.snapshot));
  },
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
    const run = await runOn(backend, RUNS[backend]);
    JUDGE[kind](run);
    // Replay and recovery made no main-side effect: the composable's counts stayed at their value before the cut.
    if (run.effects !== null)
      assert.deepEqual(
        run.effects,
        run.effects.map(() => run.effects![0]),
      );
  });

/** The bundle the composable runs in, loaded once. */
let bundled: Promise<{
  readonly usePlayerSession: (options: ComposableOptions) => ComposableHost;
  readonly facade: typeof InProcess;
  readonly adapter: typeof RuntimeAdapter;
}> | null = null;
interface ComposableOptions {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly resolveAsset: (path: string) => string | null;
  readonly scriptStorage: ScriptStorageProvider;
}
interface ComposableHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  loadScriptStorage(): Promise<void>;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(next: PlayerSession): void;
  debugRecording(): Parameters<typeof plainRecording>[0];
}
const bundle = () =>
  (bundled ??= (async () => {
    const module = await loadPlayerModule("player/vue/src/usePlayerSession.ts");
    return {
      // EVIDENCE: validation: Vite loaded the real source module; this is its host API.
      usePlayerSession: module.usePlayerSession as (options: ComposableOptions) => ComposableHost,
      // EVIDENCE: validation: the bundle's in-process backend, whose sessions the composable's facade reaches.
      facade: (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof InProcess,
      // EVIDENCE: validation: the bundle's adapter, whose sessions the bundle's host holds.
      adapter: (await loadPlayerModule("player/runtime-adapter.ts")) as typeof RuntimeAdapter,
    };
  })());

/**
 * A run in the real composable on its in-process engine: the composable itself writes and acknowledges the save, plays
 * the medium and answers the capture; the test makes the call that throws, then recovers and answers the choice, and the
 * composable shows each publication as its own work would.
 */
async function composableRun(): Promise<ReplayRun> {
  const { usePlayerSession, facade, adapter } = await bundle();
  const effects = { writes: 0, elements: 0, plays: 0, captures: 0 };
  const total = () => effects.writes + effects.elements + effects.plays + effects.captures;
  const elements: (EventTarget & { src: string })[] = [];
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class extends EventTarget {
      src = "";
      preload = "";
      volume = 1;
      duration = 9;
      paused = true;
      ended = false;
      currentTime = 0;
      constructor() {
        super();
        effects.elements++;
        elements.push(this);
      }
      play = async () => {
        effects.plays++;
      };
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  const previous = Object.keys(surface).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(surface))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  const now = performance.now;
  // The scene clock stands still: only the test's calls move time.
  performance.now = () => 0;
  const bridge = facade.createInProcessBackend(BUILD);
  const section = bridge.client.section;
  bridge.client.section = (id, body) =>
    section(id, (send) =>
      body((op, ...rest) => {
        if (op === "answerCapture") effects.captures++;
        return send(op, ...rest);
      }),
    );
  const scope = effectScope();
  try {
    const player = scope.run(() =>
      usePlayerSession({
        bridge: Promise.resolve(bridge),
        debugHistorySpill: async () => null,
        resolveAsset: (path: string) => `https://fixture/${path}`,
        scriptStorage: {
          scope: "replay",
          load: async () => [],
          write: async () => void effects.writes++,
          replace: async () => {},
          clear: async () => {},
        },
      }),
    )!;
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
    const medium = () => elements.find((element) => element.src.endsWith("a.mp3"));
    await until(() => medium() !== undefined, "the medium did not play");
    medium()!.dispatchEvent(new Event("loadedmetadata"));
    await until(
      () =>
        player.session.value !== null &&
        activePlayerRuntimeInteraction(player.session.value.state) !== null,
      "the choice was not presented",
    );
    const session = player.session.value!;
    const atCount = [total()];
    const before = facade.hatch(session, adapter.playerRuntimeSnapshot);
    const atCut = plainRecording(player.debugRecording());
    assert.ok(atCut !== null);
    atCount.push(total());
    // The bundle's bridge is the same class as the test's, from the bundle's module graph.
    const host = bridge;
    const cut = await cutAndRecover(host, session, () => {});
    const frozen = plainRecording(player.debugRecording());
    assert.ok(frozen !== null);
    atCount.push(total());
    const suffix = await cut.recover();
    player.update(host.latest(session)!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    atCount.push(total());
    assert.ok(
      effects.writes >= 1 && effects.elements >= 1 && effects.captures >= 1,
      JSON.stringify(effects),
    );
    return {
      before,
      atCut,
      frozen,
      suffix: {
        ...suffix,
        snapshot: facade.hatch(host.latest(session)!, adapter.playerRuntimeSnapshot),
      },
      effects: atCount,
    };
  } finally {
    scope.stop();
    bridge.client.terminate();
    performance.now = now;
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
}
