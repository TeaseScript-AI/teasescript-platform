import assert from "node:assert/strict";
import test from "node:test";

import {
  debugBuildRevisions,
  debugExportFile,
  parseDebugExport,
  replayDebugExport,
  type DebugExport,
  type DebugReplayResult,
} from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import {
  activePlayerRuntimeCapture,
  advancePlayerRuntimeTime,
  answerPlayerRuntimeCapture,
  answerPlayerRuntimeImage,
  applyPlayerRuntimeStorageEdit,
  completePlayerRuntimeStorageWrite,
  continuePlayerRuntimeSession,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  pendingPlayerRuntimeStorageWrite,
  pressPlayerRuntimePermanentButton,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import {
  createCheckpoint,
  DEFAULT_TEMPORAL_CONTEXT,
  type MediaProgressReport,
} from "../src/index.js";

const reference = "captured-media:11111111-1111-4111-8111-111111111111:1";
const store = { holds: (asked: string, kind: string) => asked === reference && kind === "image" };

/** Exports the recorder's recording with the session's current checkpoint, writes and reads it, and replays it. */
async function replay(recorder: DebugRecorder): Promise<DebugReplayResult> {
  const recording = recorder.recording();
  assert.ok(recording);
  const exported: DebugExport = {
    format: "teasescript-debug-export",
    version: 2,
    build: { commit: null, dirty: null, mode: null, appVersion: null, ...debugBuildRevisions() },
    package: { id: null, version: null, contentHash: null },
    incident: {
      kind: "requested",
      code: null,
      path: null,
      line: null,
      column: null,
      hostError: null,
    },
    editedWhileDebugging: null,
    selection: {
      savedValues: true,
      answers: true,
      replay: true,
      sessionText: true,
      photos: false,
      player: false,
    },
    omissions: [],
    // The export checkpoints the state the recorded calls reach.
    checkpoint: createCheckpoint(recording.plan, recording.endSnapshot),
    checkpointRole: "current",
    replay: {
      anchorSnapshot: recording.anchorSnapshot,
      operations: recording.operations,
      complete: recording.complete,
      reason: recording.reason,
    },
    photos: [],
    sections: {},
  };
  const file = await debugExportFile(exported, false);
  return replayDebugExport(parseDebugExport(await file.text()));
}

/** Plays a script through every engine seam of the Player: time, media, input, image, photo, button, and storage. */
function playEverySeam(recorder: DebugRecorder | undefined): PlayerRuntimeSession {
  let session = createPlayerRuntimeSession(
    [
      'let music = playAudio async "music.mp3"',
      'showPermanentButton "Count" {',
      '    save "pressed" as "button"',
      "}",
      'let name = askText "Name"',
      'let picture = askImage("Picture", allowCamera: false)',
      "let photo = takePhoto()",
      "let draw = random()",
      'save name as "name"',
      "wait 2",
      "exit",
    ].join("\n"),
    {
      persistentScriptStorage: true,
      scriptStorage: [],
      ...(recorder === undefined ? {} : { recorder }),
    },
  );
  const reports = (atMs: number): MediaProgressReport[] => [
    { mediaId: 1, segment: 1, progressMs: atMs },
  ];
  session = reportPlayerRuntimeMediaLoad(session, 1, {
    kind: "loaded",
    durationMs: 10_000,
  }).session;
  session = observePlayerRuntimeTime(session, 500, reports(500)).session;
  session = pressPlayerRuntimePermanentButton(session, 1).session;
  session = completePlayerRuntimeStorageWrite(
    session,
    pendingPlayerRuntimeStorageWrite(session.snapshot)!.actionId,
    true,
  ).session;
  // A refused and then an accepted answer.
  assert.equal(answerPlayerRuntimeImage(session, reference, store), null, "no image request yet");
  session = submitPlayerRuntimeComposer(session, "Ada")!.session;
  const refused = answerPlayerRuntimeImage(session, reference.replace(":1", ":2"), store)!;
  assert.equal(refused.outcome.kind, "invalidPayload");
  session = answerPlayerRuntimeImage(refused.session, reference, store)!.session;
  const capture = activePlayerRuntimeCapture(session.snapshot)!;
  session = answerPlayerRuntimeCapture(
    session,
    capture.actionId,
    { kind: "captured", reference },
    store,
  ).session;
  session = completePlayerRuntimeStorageWrite(
    session,
    pendingPlayerRuntimeStorageWrite(session.snapshot)!.actionId,
    false,
  ).session;
  return session;
}

test("the recorder records every Player engine seam so that a replay reproduces the session exactly", async () => {
  const recorder = new DebugRecorder();
  let session = playEverySeam(recorder);
  // Continue a restored session and finish it on time.
  const restorePoint = createPlayerRuntimeRestorePoint(session);
  const before = recorder.recording()!.operations.map((operation) => operation.kind);
  assert.deepEqual([...new Set(before)].sort(), [
    "completeAction",
    "observeTime",
    "pressPermanentButton",
    "reportMediaLoad",
    "run",
  ]);
  assert.equal(await replay(recorder).then((result) => result.kind), "reproduced");

  session = restorePlayerRuntimeSession(restorePoint, recorder);
  session = continuePlayerRuntimeSession(session, {
    wallClockMs: 1_800_000_000_000,
    temporalContext: DEFAULT_TEMPORAL_CONTEXT,
  }).session;
  session = observePlayerRuntimeTime(session, 3_000, [
    { mediaId: 1, segment: 1, progressMs: 3_000 },
  ]).session;
  assert.equal(session.snapshot.status, "halted");
  const continued = recorder.recording()!;
  assert.equal(
    continued.operations[0]?.kind,
    "recordContinueCapture",
    "a restored session records from its Continue",
  );
  assert.deepEqual(await replay(recorder), {
    kind: "reproduced",
    failure: null,
    operations: continued.operations.length,
  });
});

test("recording changes nothing about the session", () => {
  const recorded = playEverySeam(new DebugRecorder());
  const plain = playEverySeam(undefined);
  assert.deepEqual(recorded.snapshot, plain.snapshot);
  assert.deepEqual(recorded.events, plain.events);
  assert.deepEqual(recorded.snapshot.rng, plain.snapshot.rng);
});

test("each call keeps its own copy of the arguments and the store's answers, also refusals", () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'let music = playAudio async "music.mp3"\nwait 5\nexit',
    { recorder },
  );
  session = reportPlayerRuntimeMediaLoad(session, 1, {
    kind: "loaded",
    durationMs: 10_000,
  }).session;
  const reports: MediaProgressReport[] = [{ mediaId: 1, segment: 1, progressMs: 100 }];
  session = observePlayerRuntimeTime(session, 100, reports).session;
  reports.length = 0;
  const invalid = observePlayerRuntimeTime(session, -1);
  assert.equal(invalid.outcome.kind, "invalidObservation");
  const operations = recorder.recording()!.operations;
  const observation = operations.find((operation) => operation.kind === "observeTime")!;
  assert.deepEqual(observation.args, [100, [{ mediaId: 1, segment: 1, progressMs: 100 }]]);
  assert.deepEqual(operations.at(-1), {
    seq: operations.length,
    kind: "observeTime",
    args: [-1, []],
    admissionQueries: [],
    outcome: "invalidObservation",
    events: { first: null, count: 0 },
    status: "waiting",
    thrown: null,
  });

  const image = new DebugRecorder();
  const asked = createPlayerRuntimeSession(
    'let picture = askImage("Picture", allowCamera: false)\nexit',
    { recorder: image },
  );
  answerPlayerRuntimeImage(asked, reference, store);
  const answer = image.recording()!.operations.at(-2)!;
  assert.equal(answer.kind, "completeAction");
  assert.deepEqual(answer.admissionQueries, [{ reference, kind: "image", result: true }]);
});

test("a recording outgrowing its limits starts again before a Player call and still replays", async () => {
  const recorder = new DebugRecorder({ operations: 6 });
  let session = createPlayerRuntimeSession("wait 1\nwait 1\nwait 1\nwait 1\nwait 1\nexit", {
    recorder,
  });
  for (let atMs = 1_000; atMs <= 5_000; atMs += 1_000) {
    session = observePlayerRuntimeTime(session, atMs).session;
    assert.ok(recorder.recording()!.operations.length <= 6);
  }
  assert.equal(session.snapshot.status, "halted");
  const recording = recorder.recording()!;
  assert.equal(recording.complete, true);
  assert.notEqual(recording.anchorSnapshot.observedSessionTimeMs, 0, "the anchor moved forward");
  assert.equal((await replay(recorder)).kind, "reproduced");
});

test("a failure freezes the recording, from the first run on, and a too large call makes it incomplete", async () => {
  const recorder = new DebugRecorder();
  const failed = createPlayerRuntimeSession("let zero = 0\nlet result = 1 / zero\nexit", {
    recorder,
  });
  assert.equal(failed.snapshot.status, "failed");
  // The Player still observes time after a failure, as on hiding the page; the published state moves on.
  const latest = observePlayerRuntimeTime(failed, 1_000).session;
  assert.equal(latest.snapshot.observedSessionTimeMs, 1_000);
  assert.deepEqual(
    recorder.recording()!.operations.map((operation) => [operation.kind, operation.status]),
    [["run", "failed"]],
    "later calls do not replace the evidence",
  );
  assert.equal(
    recorder.recording()!.endSnapshot,
    failed.snapshot,
    "the recording ends where it froze",
  );
  const result = await replay(recorder);
  assert.ok(result.kind === "reproduced" && result.failure?.code === failed.snapshot.failure?.code);

  // A development time jump past a failure: the recording reaches the failure, not the later observed time.
  const jumped = new DebugRecorder();
  const waiting = createPlayerRuntimeSession("wait 1\nlet zero = 0\nlet result = 1 / zero\nexit", {
    recorder: jumped,
  });
  const advanced = advancePlayerRuntimeTime(waiting, 5_000);
  assert.equal(advanced.snapshot.status, "failed");
  const jumpedResult = await replay(jumped);
  assert.ok(
    jumpedResult.kind === "reproduced" && jumpedResult.failure !== null,
    JSON.stringify(jumpedResult),
  );

  const small = new DebugRecorder({ argumentBytes: 50 });
  const asking = createPlayerRuntimeSession('let name = askText "Name"\nexit', { recorder: small });
  submitPlayerRuntimeComposer(asking, "x".repeat(100));
  assert.deepEqual(
    [small.recording()!.complete, small.recording()!.reason],
    [false, "A recorded call was larger than the recording keeps."],
  );
  assert.equal((await replay(small)).kind, "incomplete");
});

test("a call the recorder cannot copy still runs exactly as without it", () => {
  const recorder = new DebugRecorder();
  const session = createPlayerRuntimeSession(
    'showPermanentButton "Count" {\n    wait 1\n}\nwait 10\nexit',
    { recorder },
  );
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: test: a value JSON cannot copy, which the engine refuses like any other invalid button.
  const unusual = 1n as unknown as number;
  const withRecorder = pressPlayerRuntimePermanentButton(session, unusual);
  const without = pressPlayerRuntimePermanentButton({ ...session, recorder: null }, unusual);
  assert.equal(withRecorder.outcome.kind, without.outcome.kind);
  assert.deepEqual(withRecorder.session.snapshot, without.session.snapshot);
  assert.deepEqual(
    [recorder.recording()!.complete, recorder.recording()!.reason],
    [false, "A call's arguments could not be copied exactly."],
  );
});

test("a media store that throws during a recorded call leaves the recording incomplete", () => {
  const recorder = new DebugRecorder();
  const session = createPlayerRuntimeSession(
    'let picture = askImage("Picture", allowCamera: false)\nexit',
    { recorder },
  );
  const failing = {
    holds: (): boolean => {
      throw new Error("store unavailable");
    },
  };
  assert.throws(() => answerPlayerRuntimeImage(session, reference, failing), /store unavailable/);
  assert.deepEqual(
    [recorder.recording()!.complete, recorder.recording()!.reason],
    [false, "The media store failed during a recorded call."],
  );
});

test("a debugging tool's storage edit is recorded, so a replay applies it again", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'let name = askText "Name"\nlet visits = load("visits", default: 1)\nsay "Visit ${visits}"\nexit',
    { recorder },
  );
  const edited = applyPlayerRuntimeStorageEdit(session, { key: "visits", value: 5 });
  assert.equal(edited.outcome.kind, "applied");
  session = submitPlayerRuntimeComposer(edited.session, "Ada")!.session;
  assert.equal(session.snapshot.status, "halted");
  const last = session.transcriptEntries.at(-1);
  assert.equal(last?.kind === "message" ? last.text : undefined, "Visit 5");
  assert.deepEqual(
    recorder.recording()!.operations.map((operation) => operation.kind),
    ["run", "applyExternalStorageEdit", "completeAction", "run"],
  );
  assert.equal((await replay(recorder)).kind, "reproduced");
});

test("an argument JSON cannot copy exactly leaves the recording incomplete instead of recording another call", async () => {
  const cyclic: { readonly name: string; self: unknown } = { name: "loop", self: null };
  cyclic.self = cyclic;
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: test: values JSON cannot copy, which the engine refuses as invalid edits.
  const values = [Number.NaN, cyclic as unknown as number];
  for (const value of values) {
    const recorder = new DebugRecorder();
    const session = createPlayerRuntimeSession('let name = askText "Name"\nexit', { recorder });
    const refused = applyPlayerRuntimeStorageEdit(session, { key: "k", value });
    assert.equal(refused.outcome.kind, "invalidEdit");
    assert.deepEqual(
      [recorder.recording()!.complete, recorder.recording()!.reason],
      [false, "A call's arguments could not be copied exactly."],
    );
    assert.equal((await replay(recorder)).kind, "incomplete");
  }
});

test("a value the engine produced, such as a saved list, is recorded as an argument and replays", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'save [1, null] as "a"\nlet name = askText "Name"\nlet copy = load("b", default: [])\nlet zero = 0\nlet result = 1 / zero\nexit',
    { recorder, persistentScriptStorage: true, scriptStorage: [] },
  );
  session = completePlayerRuntimeStorageWrite(
    session,
    pendingPlayerRuntimeStorageWrite(session.snapshot)!.actionId,
    true,
  ).session;
  const saved = createCheckpoint(session.plan, session.snapshot).snapshot.scriptStorage[0]!.value;
  const edited = applyPlayerRuntimeStorageEdit(session, { key: "b", value: saved });
  assert.equal(edited.outcome.kind, "applied");
  session = submitPlayerRuntimeComposer(edited.session, "Ada")!.session;
  assert.equal(session.snapshot.status, "failed");
  assert.equal(recorder.recording()!.complete, true);
  const result = await replay(recorder);
  assert.ok(
    result.kind === "reproduced" && result.failure?.code === session.snapshot.failure?.code,
  );
});
