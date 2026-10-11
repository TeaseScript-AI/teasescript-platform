import assert from "node:assert/strict";
import test from "node:test";

import {
  DEBUG_EXPORT_VERSION,
  debugBuildRevisions,
  debugExportFile,
  parseDebugExport,
  rebuildRecordedSession,
  replayDebugExport,
  type DebugExport,
  type DebugReplayResult,
} from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import {
  activePlayerRuntimeCapture,
  advancePlayerRuntimeTime,
  answeredByPlayerInput,
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
  playerRuntimeDebugVariables,
  playerRuntimeForeground,
  restorePlayerRuntimeSession,
  restorePlayerRuntimeSessionAt,
  resumePlayerRuntimeRandomDraw,
  selectPlayerRuntimeChoice,
  setPlayerRuntimeRandomControl,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeSession,
  stepPlayerRuntimeFormField,
  submitPlayerRuntimeForm,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import {
  createCheckpoint,
  DEFAULT_TEMPORAL_CONTEXT,
  observeTime,
  type MediaProgressReport,
} from "../src/index.js";
import type { RandomDecision } from "../src/runtime/random-control.js";

const reference = "captured-media:11111111-1111-4111-8111-111111111111:1";
const store = { holds: (asked: string, kind: string) => asked === reference && kind === "image" };

/** Exports the recorder's recording with the session's current checkpoint, writes and reads it, and replays it. */
async function replay(recorder: DebugRecorder): Promise<DebugReplayResult> {
  const recording = recorder.recording();
  assert.ok(recording);
  const exported: DebugExport = {
    format: "teasescript-debug-export",
    version: DEBUG_EXPORT_VERSION,
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
    rewoundWhileDebugging: null,
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

/**
 * `script` started with its scope IDs used up but `spare`: the scope after them throws `TSR101`, an error that no script
 * reaches otherwise, so that an operation throws in the middle of its run.
 */
function startedWithScopesUsedUp(
  script: string,
  spare: number,
  recorder: DebugRecorder | null = null,
): PlayerRuntimeSession {
  const started = createPlayerRuntimeSession(script);
  const snapshot = {
    ...playerRuntimeSnapshot(started),
    nextScopeId: Number.MAX_SAFE_INTEGER - spare,
  };
  return restorePlayerRuntimeSessionAt(
    started.plan,
    JSON.stringify(snapshot),
    started.events,
    recorder,
  );
}

const SCOPES_USED_UP = /nextScopeId is at its largest value, so it cannot advance/u;

/** Plays a script through every engine seam of the Player: time, media, input, image, photo, button, and storage. */
function playEverySeam(recorder: DebugRecorder | undefined): PlayerRuntimeSession {
  let session = createPlayerRuntimeSession(
    [
      'let music = playAudio async "music.mp3"',
      'showPermanentButton "Count" {',
      '    save "pressed" as "button"',
      "}",
      'let name = askText "Name"',
      'let flags = askForm fields: { a: false, b: ["x", "y"] }',
      'let picture = askImage("Picture", allowCamera: false)',
      "let photo = takePhoto()",
      "let draw = random()",
      'save name as "name"',
      "wait 2 s",
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
    pendingPlayerRuntimeStorageWrite(session.state)!.actionId,
    true,
  ).session;
  // A refused and then an accepted answer.
  assert.equal(answerPlayerRuntimeImage(session, reference, store), null, "no image request yet");
  session = submitPlayerRuntimeComposer(session, "Ada")!.session;
  session = stepPlayerRuntimeFormField(session, "a")!.session;
  session = stepPlayerRuntimeFormField(session, "b")!.session;
  session = submitPlayerRuntimeForm(session)!.session;
  const refused = answerPlayerRuntimeImage(session, reference.replace(":1", ":2"), store)!;
  assert.equal(refused.outcome.kind, "invalidPayload");
  session = answerPlayerRuntimeImage(refused.session, reference, store)!.session;
  const capture = activePlayerRuntimeCapture(session.state)!;
  session = answerPlayerRuntimeCapture(
    session,
    capture.actionId,
    { kind: "captured", reference },
    store,
  ).session;
  session = completePlayerRuntimeStorageWrite(
    session,
    pendingPlayerRuntimeStorageWrite(session.state)!.actionId,
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
    "updateInteraction",
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
  assert.equal(session.state.status, "halted");
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
  assert.deepEqual(playerRuntimeSnapshot(recorded), playerRuntimeSnapshot(plain));
  assert.deepEqual(recorded.events, plain.events);
  assert.deepEqual(playerRuntimeSnapshot(recorded).rng, playerRuntimeSnapshot(plain).rng);
});

test("each call keeps its own copy of the arguments and the store's answers, also refusals", () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'let music = playAudio async "music.mp3"\nwait 5 s\nexit',
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
    randomChoices: [],
    pausedAt: null,
    input: null,
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

test("an answer keeps how the player gave it, which the export carries and checks", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'let name = askText "Name"\nlet pick = choose yes: "Yes", no: "No"\nwait 1 s\nexit',
    { recorder },
  );
  session = answeredByPlayerInput(session, "enter", () =>
    submitPlayerRuntimeComposer(session, "Ada"),
  )!.session;
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  session = answeredByPlayerInput(session, "button", () =>
    selectPlayerRuntimeChoice(session, foreground.options[1]!.id),
  )!.session;
  session = observePlayerRuntimeTime(session, 1_000).session;
  assert.equal(session.state.status, "halted");
  const recorded = (operations: readonly { kind: string; input: unknown }[]) =>
    operations.map(({ kind, input }) => [kind, input]);
  // Only the answers carry an input; the run that continues each one does not.
  const expected = [
    ["run", null],
    ["completeAction", "enter"],
    ["run", null],
    ["completeAction", "button"],
    ["run", null],
    ["observeTime", null],
    ["run", null],
  ];
  assert.deepEqual(recorded(recorder.recording()!.operations), expected);

  const exported = await exportedRecording(recorder);
  assert.deepEqual(recorded(exported.replay!.operations), expected);
  assert.equal((await replay(recorder)).kind, "reproduced");
  const json = JSON.parse(await (await debugExportFile(exported, false)).text());
  json.replay.operations[0].input = "enter";
  assert.throws(
    () => parseDebugExport(JSON.stringify(json)),
    /\$\.replay\.operations\[0\]\.input belongs only to completeAction/u,
  );
  json.replay.operations[0].input = null;
  json.replay.operations[1].input = "click";
  assert.throws(
    () => parseDebugExport(JSON.stringify(json)),
    /\$\.replay\.operations\[1\]\.input/u,
  );
});

test("a recording outgrowing its limits starts again before a Player call and still replays", async () => {
  const recorder = new DebugRecorder({ operations: 6 });
  let session = createPlayerRuntimeSession(
    "wait 1 s\nwait 1 s\nwait 1 s\nwait 1 s\nwait 1 s\nexit",
    { recorder },
  );
  for (let atMs = 1_000; atMs <= 5_000; atMs += 1_000) {
    session = observePlayerRuntimeTime(session, atMs).session;
    assert.ok(recorder.recording()!.operations.length <= 6);
  }
  assert.equal(session.state.status, "halted");
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
  assert.equal(failed.state.status, "failed");
  const failedSnapshot = playerRuntimeSnapshot(failed);
  // The Player still observes time after a failure, as on hiding the page; the published state moves on.
  const latest = observePlayerRuntimeTime(failed, 1_000).session;
  assert.equal(latest.state.observedSessionTimeMs, 1_000);
  assert.deepEqual(
    recorder.recording()!.operations.map((operation) => [operation.kind, operation.status]),
    [["run", "failed"]],
    "later calls do not replace the evidence",
  );
  assert.deepEqual(
    recorder.recording()!.endSnapshot,
    failedSnapshot,
    "the recording ends where it froze",
  );
  const result = await replay(recorder);
  assert.ok(result.kind === "reproduced" && result.failure?.code === failed.state.failure?.code);

  // A development time jump past a failure: the recording reaches the failure, not the later observed time.
  const jumped = new DebugRecorder();
  const waiting = createPlayerRuntimeSession(
    "wait 1 s\nlet zero = 0\nlet result = 1 / zero\nexit",
    { recorder: jumped },
  );
  const advanced = advancePlayerRuntimeTime(waiting, 5_000);
  assert.equal(advanced.state.status, "failed");
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
    'showPermanentButton "Count" {\n    wait 1 s\n}\nwait 10 s\nexit',
    { recorder },
  );
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: test: a value JSON cannot copy, which the engine refuses like any other invalid button.
  const unusual = 1n as unknown as number;
  const withRecorder = pressPlayerRuntimePermanentButton(session, unusual);
  const without = pressPlayerRuntimePermanentButton({ ...session, recorder: null }, unusual);
  assert.equal(withRecorder.outcome.kind, without.outcome.kind);
  assert.deepEqual(
    playerRuntimeSnapshot(withRecorder.session),
    playerRuntimeSnapshot(without.session),
  );
  assert.deepEqual(
    [recorder.recording()!.complete, recorder.recording()!.reason],
    [false, "A call's arguments could not be copied exactly."],
  );
});

test("a media store that throws during a recorded call leaves the recording incomplete", () => {
  const recorder = new DebugRecorder();
  const source = 'let picture = askImage("Picture", allowCamera: false)\nexit';
  // The recorder moves on to the second session; a call of the first no longer reaches the recording.
  const stale = createPlayerRuntimeSession(source, { recorder });
  const session = createPlayerRuntimeSession(source, { recorder });
  const failing = {
    holds: (): boolean => {
      throw new Error("store unavailable");
    },
  };
  assert.throws(() => answerPlayerRuntimeImage(stale, reference, failing), /store unavailable/);
  assert.deepEqual([recorder.recording()!.complete, recorder.recording()!.reason], [true, null]);
  assert.throws(() => answerPlayerRuntimeImage(session, reference, failing), /store unavailable/);
  assert.deepEqual(
    [recorder.recording()!.complete, recorder.recording()!.reason],
    [false, "The media store failed during a recorded call."],
  );
});

test("a random decision that throws during a recorded call leaves the recording incomplete", async () => {
  // A decision whose field throws is read inside the engine's guard too.
  const unreadable = (): RandomDecision =>
    Object.defineProperty({ kind: "natural" }, "kind", {
      get() {
        throw new Error("host decision failed");
      },
    });
  for (const decide of [
    () => {
      throw new Error("host decision failed");
    },
    unreadable,
  ]) {
    const recorder = new DebugRecorder();
    let session = createPlayerRuntimeSession(
      'wait 1 s\nlet x = [1, 2, 3].random\nsay "${x}", instant\nexit',
      { recorder },
    );
    session = observePlayerRuntimeTime(session, 500).session;
    setPlayerRuntimeRandomControl(session, { decide });
    assert.throws(() => observePlayerRuntimeTime(session, 1_000), { name: "RandomDecisionError" });
    const recording = recorder.recording()!;
    assert.deepEqual(
      [recording.complete, recording.reason],
      [false, "The random decision callback failed during a recorded call."],
    );
    // The replay has no decision callback, so it could not throw where the recorded call threw.
    assert.equal(recording.operations.at(-1)?.thrown, "RandomDecisionError");
    assert.equal((await replay(recorder)).kind, "incomplete");
  }
});

test("a random decision that calls its session is refused there, and the call it decides goes on", async () => {
  for (const rethrow of [false, true]) {
    const recorder = new DebugRecorder();
    let session = createPlayerRuntimeSession(
      'wait 1 s\nlet x = [1, 2, 3].random\nsay "${x}", instant\nexit',
      { recorder },
    );
    session = observePlayerRuntimeTime(session, 500).session;
    const shown = JSON.stringify(playerRuntimeSnapshot(session));
    let refused: unknown = null;
    setPlayerRuntimeRandomControl(session, {
      decide: () => {
        try {
          observePlayerRuntimeTime(session, 600);
        } catch (error) {
          refused = error;
          if (rethrow) throw error;
        }
        return { kind: "natural" };
      },
    });
    if (rethrow) {
      assert.throws(
        () => observePlayerRuntimeTime(session, 1_000),
        (error: unknown) =>
          error instanceof Error && error.name === "RandomDecisionError" && error.cause === refused,
      );
      // The Player goes on from the state it showed. The nested call left no record, so the failed decision marks the
      // recording incomplete.
      assert.equal(JSON.stringify(playerRuntimeSnapshot(session)), shown);
      assert.equal(
        recorder.recording()!.reason,
        "The random decision callback failed during a recorded call.",
      );
      assert.equal((await replay(recorder)).kind, "incomplete");
    } else {
      // The decided call finishes as it would without the nested call, which left no record.
      const observed = observePlayerRuntimeTime(session, 1_000).session;
      assert.equal(playerRuntimeSnapshot(observed).status, "halted");
      assert.deepEqual(
        recorder.recording()!.operations.map((operation) => operation.kind),
        ["run", "observeTime", "run", "observeTime", "run"],
      );
      assert.equal((await replay(recorder)).kind, "reproduced");
    }
    assert.ok(refused instanceof Error && refused.name === "RuntimeSessionError");
  }
});

test("a session a host callback starts with the same recorder keeps a recording of its own calls", async () => {
  for (const rethrow of [false, true]) {
    const recorder = new DebugRecorder();
    let session = createPlayerRuntimeSession(
      'wait 1 s\nlet x = [1, 2, 3].random\nsay "${x}", instant\nexit',
      { recorder },
    );
    session = observePlayerRuntimeTime(session, 500).session;
    let started: PlayerRuntimeSession | null = null;
    setPlayerRuntimeRandomControl(session, {
      decide: () => {
        if (started === null) {
          // Beginning its recording moves the recorder to the new session during the decided call.
          started = createPlayerRuntimeSession('say "Other", instant\nexit', { recorder });
          if (rethrow) throw new Error("host decision failed");
        }
        return { kind: "natural" };
      },
    });
    if (rethrow)
      assert.throws(() => observePlayerRuntimeTime(session, 1_000), {
        name: "RandomDecisionError",
      });
    else
      assert.equal(
        playerRuntimeSnapshot(observePlayerRuntimeTime(session, 1_000).session).status,
        "halted",
      );
    // The decided call, which may throw, stays out of the new session's recording.
    const recording = recorder.recording()!;
    assert.deepEqual(
      [recording.operations.map((operation) => operation.kind), recording.complete],
      [["run"], true],
    );
    assert.equal((await replay(recorder)).kind, "reproduced");
  }

  // So does a media store that starts one and then throws.
  const recorder = new DebugRecorder();
  const session = createPlayerRuntimeSession(
    'let picture = askImage("Picture", allowCamera: false)\nexit',
    { recorder },
  );
  const starting = {
    holds: (): boolean => {
      createPlayerRuntimeSession('say "Other", instant\nexit', { recorder });
      throw new Error("store unavailable");
    },
  };
  assert.throws(() => answerPlayerRuntimeImage(session, reference, starting), /store unavailable/);
  const recording = recorder.recording()!;
  assert.deepEqual(
    [recording.operations.map((operation) => operation.kind), recording.complete],
    [["run"], true],
  );
});

test("a media store or random decision that throws after the record froze leaves the frozen record as it was", () => {
  // With the scope IDs used up, a timer block throws in its middle, which freezes the record.
  const source = [
    "let go = true",
    "timer async 1 s {",
    '  say "before", instant',
    "  if go {",
    '    say "deep", instant',
    "  }",
    "}",
    'let picture = askImage("Picture", allowCamera: false)',
    "let x = random()",
    "exit",
  ].join("\n");
  const recorder = new DebugRecorder();
  const session = startedWithScopesUsedUp(source, 1, recorder);
  assert.throws(() => observePlayerRuntimeTime(session, 1_000), SCOPES_USED_UP);
  const frozen = recorder.recording()!;
  assert.equal(frozen.complete, true);
  // The Player continues from the state it showed, where the picture is still asked.
  const failing = {
    holds: (): boolean => {
      throw new Error("store unavailable");
    },
  };
  assert.throws(() => answerPlayerRuntimeImage(session, reference, failing), /store unavailable/);
  let recording = recorder.recording()!;
  assert.deepEqual([recording.complete, recording.reason], [true, null]);
  assert.deepEqual(recording.operations, frozen.operations);
  // So does a random decision that throws.
  setPlayerRuntimeRandomControl(session, {
    decide: () => {
      throw new Error("host decision failed");
    },
  });
  assert.throws(() => answerPlayerRuntimeImage(session, reference, store), {
    name: "RandomDecisionError",
  });
  recording = recorder.recording()!;
  assert.deepEqual([recording.complete, recording.reason], [true, null]);
  assert.deepEqual(recording.operations, frozen.operations);
});

test("after a call throws, the session continues from the state the Player showed, and the recording keeps the call", async () => {
  // With the scope IDs used up, a timer block throws in its middle, after it changed the state.
  const source = [
    "let go = true",
    "timer async 1 s {",
    '  say "before", instant',
    "  if go {",
    '    say "deep", instant',
    "  }",
    "}",
    'let pick = choose again: "Again"',
    'say "done", instant',
    "exit",
  ].join("\n");
  const again = (session: PlayerRuntimeSession) => {
    const foreground = playerRuntimeForeground(session);
    assert.ok(foreground?.kind === "choose");
    return selectPlayerRuntimeChoice(session, foreground.options[0]!.id)!.session;
  };
  const recorder = new DebugRecorder();
  const session = startedWithScopesUsedUp(source, 1, recorder);
  const before = playerRuntimeSnapshot(session);
  const shown = session.state;
  assert.throws(() => observePlayerRuntimeTime(session, 1_000), SCOPES_USED_UP);
  // What the Player shows and holds is the state before the call: the say before the error is undone.
  assert.equal(session.state, shown);
  assert.deepEqual(playerRuntimeSnapshot(session), before);
  // After a later publication, a second error recovers to that one.
  const later = observePlayerRuntimeTime(session, 500).session;
  const laterSnapshot = playerRuntimeSnapshot(later);
  assert.throws(() => observePlayerRuntimeTime(later, 1_000), SCOPES_USED_UP);
  assert.deepEqual(playerRuntimeSnapshot(later), laterSnapshot);
  const continued = again(later);
  const expected = again(observePlayerRuntimeTime(startedWithScopesUsedUp(source, 1), 500).session);
  assert.equal(continued.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(continued), playerRuntimeSnapshot(expected));
  assert.deepEqual(continued.transcriptEntries, expected.transcriptEntries);

  // The recording froze at the first error: the run after the observation threw, and the recording ends at the state
  // that run started from, where a replay throws again.
  const recording = recorder.recording()!;
  assert.deepEqual(
    recording.operations.map((operation) => [operation.kind, operation.thrown]),
    [
      ["observeTime", null],
      ["run", "RuntimeDataError"],
    ],
  );
  assert.deepEqual(recording.endSnapshot, observeTime(session.plan, before, 1_000, []).snapshot);
  assert.equal(recording.complete, true);
  assert.deepEqual(await replay(recorder), { kind: "reproduced", failure: null, operations: 2 });
});

test("after a call the recording could not keep, an error still continues from the state the Player showed", () => {
  // With the scope IDs used up, the timer block throws as it starts.
  const timer = [
    "let go = true",
    "timer async 1 s {",
    "  if go {",
    '    say "deep", instant',
    "  }",
    "}",
  ];
  const continues = (session: PlayerRuntimeSession, act: () => void) => {
    const before = playerRuntimeSnapshot(session);
    assert.throws(act, SCOPES_USED_UP);
    assert.deepEqual(playerRuntimeSnapshot(session), before);
  };

  // An answer larger than the recording keeps, then an error at the next observation.
  const asking = [
    ...timer,
    'let name = askText "Name"',
    'let pick = choose again: "Again"',
    "exit",
  ].join("\n");
  const small = new DebugRecorder({ argumentBytes: 50 });
  const answered = submitPlayerRuntimeComposer(
    startedWithScopesUsedUp(asking, 0, small),
    "x".repeat(100),
  )!.session;
  assert.equal(small.recording()!.complete, false);
  continues(answered, () => observePlayerRuntimeTime(answered, 1_000));
  assert.equal(observePlayerRuntimeTime(answered, 500).outcome.kind, "observed");

  // A storage edit larger than the default retention, whose call has no run after it.
  const edited = applyPlayerRuntimeStorageEdit(
    startedWithScopesUsedUp(asking, 0, new DebugRecorder()),
    { key: "big", value: "x".repeat(2 * 1024 * 1024) },
  );
  assert.equal(edited.outcome.kind, "applied");
  continues(edited.session, () => observePlayerRuntimeTime(edited.session, 1_000));
  const saved = playerRuntimeSnapshot(edited.session).scriptStorage;
  assert.deepEqual(
    saved.map((entry) => entry.key),
    ["big"],
  );

  // An answer larger than the recording keeps, whose own run throws: the state before the answer.
  const checked = [
    'let name = askText "Name"',
    'if name != "ok" {',
    '  say "deep", instant',
    "}",
    'say "${name}", instant',
    "exit",
  ].join("\n");
  const session = startedWithScopesUsedUp(checked, 0, new DebugRecorder({ argumentBytes: 50 }));
  continues(session, () => submitPlayerRuntimeComposer(session, "x".repeat(100)));
  const continued = submitPlayerRuntimeComposer(session, "ok")!.session;
  assert.equal(continued.state.status, "halted");
  assert.equal(continued.transcriptEntries.at(-1)?.text, "ok");

  // Two such answers in a row, the second one's run throwing: the state after the first.
  const twice = submitPlayerRuntimeComposer(
    startedWithScopesUsedUp(
      `let first = askText "First"\n${checked}`,
      0,
      new DebugRecorder({ argumentBytes: 50 }),
    ),
    "a".repeat(100),
  )!.session;
  continues(twice, () => submitPlayerRuntimeComposer(twice, "b".repeat(100)));
  assert.equal(submitPlayerRuntimeComposer(twice, "ok")!.session.state.status, "halted");
});

test("a refusal the host does not keep leaves the later publications recoverable", () => {
  // With the scope IDs used up but one, which the first timer block takes, the second one throws as it starts.
  const source = [
    "timer async 1 s {",
    '  say "late", instant',
    "}",
    "let seen = 0",
    "timer async 300 ms {",
    "  seen = 1",
    "}",
    'let pick = choose again: "Again"',
    "exit",
  ].join("\n");
  const shown = startedWithScopesUsedUp(source, 1, new DebugRecorder());
  // As the Player's media host does, the session shown stays when a report is refused.
  const refused = reportPlayerRuntimeMediaLoad(shown, 99, { kind: "loaded", durationMs: 1 });
  assert.equal(refused.outcome.kind, "unknownMedia");
  const later = observePlayerRuntimeTime(shown, 500).session;
  assert.ok(later.revision > refused.session.revision);
  const before = playerRuntimeSnapshot(later);
  const variables = playerRuntimeDebugVariables(later).variables;
  assert.throws(() => observePlayerRuntimeTime(later, 1_000), SCOPES_USED_UP);
  assert.deepEqual(playerRuntimeSnapshot(later), before);
  assert.deepEqual(playerRuntimeDebugVariables(later).variables, variables);
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
  assert.equal(session.state.status, "halted");
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
    pendingPlayerRuntimeStorageWrite(session.state)!.actionId,
    true,
  ).session;
  const saved = createCheckpoint(session.plan, playerRuntimeSnapshot(session)).snapshot
    .scriptStorage[0]!.value;
  const edited = applyPlayerRuntimeStorageEdit(session, { key: "b", value: saved });
  assert.equal(edited.outcome.kind, "applied");
  session = submitPlayerRuntimeComposer(edited.session, "Ada")!.session;
  assert.equal(session.state.status, "failed");
  assert.equal(recorder.recording()!.complete, true);
  const result = await replay(recorder);
  assert.ok(result.kind === "reproduced" && result.failure?.code === session.state.failure?.code);
});

/** Exports the recorder's recording, as `replay` does, and returns the parsed export. */
async function exportedRecording(recorder: DebugRecorder): Promise<DebugExport> {
  const recording = recorder.recording()!;
  const file = await debugExportFile(
    {
      format: "teasescript-debug-export",
      version: DEBUG_EXPORT_VERSION,
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
      rewoundWhileDebugging: null,
      selection: {
        savedValues: true,
        answers: true,
        replay: true,
        sessionText: true,
        photos: false,
        player: false,
      },
      omissions: [],
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
    },
    false,
  );
  return parseDebugExport(await file.text());
}

/**
 * Plays `draws` random draws of a script, pausing at each and resolving it: the third with a chosen 6, the others
 * naturally, and the last one only when `resolveLast`.
 */
function pausedDraws(
  draws: number,
  recorder: DebugRecorder,
  resolveLast = true,
): PlayerRuntimeSession {
  let session = createPlayerRuntimeSession(
    `wait 1 s\nlet total = 0\nrepeat ${draws} {\n  total += randomInteger(1..=6)\n}\nsay "\${total}"\nexit`,
    { recorder },
  );
  setPlayerRuntimeRandomControl(session, {});
  session = observePlayerRuntimeTime(session, 1000).session;
  for (let resolved = 0; session.state.randomDraw !== null; resolved += 1) {
    if (!resolveLast && resolved === draws - 1) break;
    const outcome = resolved === 2 ? ({ kind: "number", value: 6 } as const) : "natural";
    const resumed = resumePlayerRuntimeRandomDraw(session, {
      drawId: session.state.randomDraw.drawId,
      outcome,
    });
    assert.equal(resumed.outcome.kind, "resolved");
    session = resumed.session;
  }
  return session;
}

test("a call paused at random draws stays one record, with only its chosen outcomes", async () => {
  const recorder = new DebugRecorder();
  const session = pausedDraws(5, recorder);
  assert.equal(session.state.randomDraw, null);
  const operations = recorder.recording()!.operations;
  assert.ok(operations.every((operation) => operation.kind !== "resumeRandomDraw"));
  const chosen = operations.flatMap((operation) => operation.randomChoices);
  assert.equal(chosen.length, 1, "natural resolutions add nothing");
  assert.deepEqual(chosen[0]!.outcome, { kind: "number", value: 6 });
  // Many more natural resolutions add no record either.
  const longer = new DebugRecorder();
  pausedDraws(40, longer);
  assert.equal(longer.recording()!.operations.length, operations.length);
  assert.deepEqual(await replay(recorder), {
    kind: "reproduced",
    failure: null,
    operations: operations.length,
  });
  const recording = recorder.recording()!;
  assert.equal(
    JSON.stringify(
      rebuildRecordedSession(recording.plan, recording.anchorSnapshot, operations).exportSnapshot(),
    ),
    JSON.stringify(playerRuntimeSnapshot(session)),
  );
});

test("a recording that ends paused at a draw replays to the same paused draw", async () => {
  const recorder = new DebugRecorder();
  const session = pausedDraws(5, recorder, false);
  const paused = session.state.randomDraw!;
  assert.equal(recorder.recording()!.operations.at(-1)!.pausedAt, paused.drawId);
  assert.equal((await replay(recorder)).kind, "reproduced");
});

test("a recording that begins at a paused draw keeps its resolution as a call of its own", async () => {
  const first = pausedDraws(5, new DebugRecorder(), false);
  const recorder = new DebugRecorder();
  let session = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(first), recorder);
  setPlayerRuntimeRandomControl(session, {});
  const paused = session.state.randomDraw!;
  session = resumePlayerRuntimeRandomDraw(session, {
    drawId: paused.drawId,
    outcome: { kind: "number", value: 1 },
  }).session;
  const operations = recorder.recording()!.operations;
  assert.equal(operations[0]!.kind, "resumeRandomDraw");
  assert.equal(operations[0]!.randomChoices.length, 1);
  assert.equal((await replay(recorder)).kind, "reproduced");
});

test("a replay whose chosen outcome differs from the recorded one diverges", async () => {
  const recorder = new DebugRecorder();
  pausedDraws(5, recorder);
  const exported = await exportedRecording(recorder);
  const operations = exported.replay!.operations.map((operation) =>
    operation.randomChoices.length === 0
      ? operation
      : {
          ...operation,
          randomChoices: operation.randomChoices.map((receipt) => ({
            ...receipt,
            outcome: { kind: "number" as const, value: 5 },
          })),
        },
  );
  const result = replayDebugExport({ ...exported, replay: { ...exported.replay!, operations } });
  assert.equal(result.kind, "diverged");
});

test("a recording that begins paused keeps the resolution as its own call after refused calls", async () => {
  let session = createPlayerRuntimeSession(
    'wait 1 s\nlet x = randomInteger(1..=6)\nsay "${x}", instant\nexit',
  );
  setPlayerRuntimeRandomControl(session, {});
  session = observePlayerRuntimeTime(session, 1000).session;
  const recorder = new DebugRecorder();
  session = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session), recorder);
  // Refused while the draw is paused: it changes nothing and needs no record.
  const refused = continuePlayerRuntimeSession(session, {
    wallClockMs: 0,
    temporalContext: DEFAULT_TEMPORAL_CONTEXT,
  });
  assert.equal(refused.outcome.kind, "randomDrawPending");
  session = resumePlayerRuntimeRandomDraw(refused.session, {
    drawId: refused.session.state.randomDraw!.drawId,
    outcome: "natural",
  }).session;
  const recording = recorder.recording()!;
  assert.deepEqual(
    recording.operations.map((operation) => operation.kind),
    ["resumeRandomDraw", "run"],
  );
  assert.equal(
    JSON.stringify(
      rebuildRecordedSession(
        recording.plan,
        recording.anchorSnapshot,
        recording.operations,
      ).exportSnapshot(),
    ),
    JSON.stringify(playerRuntimeSnapshot(session)),
  );
  assert.equal((await replay(recorder)).kind, "reproduced");
});

test("a resolution whose continuation throws leaves the session at the paused state it showed", () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'let t = timer(duration: (1..=2) s, async: true, repeat: true) {\n  say "${random()}", instant\n}\nwait 10 s\nexit',
    { recorder },
  );
  setPlayerRuntimeRandomControl(session, { filter: { kinds: ["timerRepeat"] } });
  session = observePlayerRuntimeTime(session, 3000).session;
  const shown = JSON.stringify(playerRuntimeSnapshot(session));
  const drawId = session.state.randomDraw!.drawId;
  setPlayerRuntimeRandomControl(session, {
    filter: { kinds: ["random"] },
    decide: () => {
      throw new Error("host decision failed");
    },
  });
  assert.throws(() => resumePlayerRuntimeRandomDraw(session, { drawId, outcome: "natural" }), {
    name: "RandomDecisionError",
  });
  assert.equal(JSON.stringify(playerRuntimeSnapshot(session)), shown);
});

test("a call the recorder cannot keep while a draw is paused leaves recovery of the paused state intact", () => {
  const recorder = new DebugRecorder({ argumentBytes: 128 });
  let session = createPlayerRuntimeSession(
    'let t = timer(duration: (1..=2) s, async: true, repeat: true) {\n  say "${random()}", instant\n}\nwait 10 s\nexit',
    { recorder },
  );
  setPlayerRuntimeRandomControl(session, { filter: { kinds: ["timerRepeat"] } });
  session = observePlayerRuntimeTime(session, 3000).session;
  const shown = JSON.stringify(playerRuntimeSnapshot(session));
  // Larger than the recording keeps; refused while the draw is paused.
  const refused = applyPlayerRuntimeStorageEdit(session, { key: "k", value: "x".repeat(200) });
  assert.equal(refused.outcome.kind, "randomDrawPending");
  session = refused.session;
  assert.equal(recorder.recording()!.complete, true, "the refused call needed no record");
  setPlayerRuntimeRandomControl(session, {
    filter: { kinds: ["random"] },
    decide: () => {
      throw new Error("host decision failed");
    },
  });
  assert.throws(
    () =>
      resumePlayerRuntimeRandomDraw(session, {
        drawId: session.state.randomDraw!.drawId,
        outcome: "natural",
      }),
    { name: "RandomDecisionError" },
  );
  assert.equal(JSON.stringify(playerRuntimeSnapshot(session)), shown);
  assert.equal(
    recorder.recording()!.reason,
    "The random decision callback failed during a recorded call.",
  );
});

test("a log that starts again at a paused state keeps the resolution exact", async () => {
  // Two calls fit: the log starts again before the third, while the draw is paused.
  const recorder = new DebugRecorder({ operations: 3 });
  let session = createPlayerRuntimeSession(
    'wait 1 s\nlet x = randomInteger(1..=6) + randomInteger(1..=6)\nsay "${x}", instant\nexit',
    { recorder },
  );
  setPlayerRuntimeRandomControl(session, {});
  session = observePlayerRuntimeTime(session, 1000).session;
  for (const outcome of [{ kind: "number", value: 6 } as const, "natural" as const]) {
    session = resumePlayerRuntimeRandomDraw(session, {
      drawId: session.state.randomDraw!.drawId,
      outcome,
    }).session;
  }
  assert.equal(session.state.randomDraw, null);
  const recording = recorder.recording()!;
  assert.equal(recording.complete, true);
  assert.notEqual(
    recording.anchorSnapshot.randomControl?.pending ?? null,
    null,
    "the log began paused",
  );
  assert.equal(recording.operations[0]!.kind, "resumeRandomDraw");
  assert.equal(
    JSON.stringify(
      rebuildRecordedSession(
        recording.plan,
        recording.anchorSnapshot,
        recording.operations,
      ).exportSnapshot(),
    ),
    JSON.stringify(playerRuntimeSnapshot(session)),
  );
  assert.equal((await replay(recorder)).kind, "reproduced");
});
