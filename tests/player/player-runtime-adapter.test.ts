import { DebugRecorder } from "../../player/debug/debug-recorder.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  compileSource,
  createFreshRuntimeSnapshot,
  run,
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  recordContinueCapture,
  restoreCheckpoint,
  DEFAULT_TEMPORAL_CONTEXT,
} from "../../src/index.js";
import { withValidationTestStatistics } from "../../src/validation-testing.js";
import { utc } from "../helpers/temporal-fixtures.js";
import {
  adoptPlayerRuntimeCatchUp,
  beginPlayerRuntimeCatchUp,
  beginPlayerRuntimeRecording,
  continuePlayerRuntimeSession,
  createPlayerRuntimeRestorePoint,
  observePlayerRuntimeTime,
  restorePlayerRuntimeSession,
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimePacing,
  stepPlayerRuntimeCatchUp,
  playerRuntimeSnapshot,
  playerRuntimeSnapshotJson,
} from "../../player/runtime/runtime-adapter.js";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import {
  playerTemporalContext,
  playerRuntimeDeadlines,
  playerRuntimeForeground,
} from "../../player/runtime/runtime-view.js";

test("a Player session starts at main.tease of a project, or of a single source", () => {
  const files = [
    {
      path: "rooms/hall.tease",
      source: 'global function enter {\n  say "In the hall.", instant\n}',
    },
    {
      path: "main.tease",
      source: 'say "At the door.", instant\nenter()\nshowButton "Leave"\nexit',
    },
  ];
  const texts = (session: ReturnType<typeof createPlayerRuntimeSession>) =>
    session.transcriptEntries.map((entry) => entry.text);
  assert.deepEqual(texts(createPlayerRuntimeSession({ files })), ["At the door.", "In the hall."]);
  // The plan of a compiled project starts the same session without compiling again.
  const compilation = compilePlayerProject({ files });
  assert.deepEqual(compilation.diagnostics, []);
  assert.deepEqual(texts(createPlayerRuntimeSession(compilation.plan!)), [
    "At the door.",
    "In the hall.",
  ]);
  assert.deepEqual(
    texts(createPlayerRuntimeSession('say "Alone.", instant\nshowButton "Leave"\nexit')),
    ["Alone."],
  );
});

test("a project that does not compile names the file and position of its error", () => {
  const files = [
    { path: "main.tease", source: "exit" },
    { path: "rooms/hall.tease", source: "global function enter {\n  say missing\n}" },
  ];
  assert.throws(() => createPlayerRuntimeSession({ files }), {
    message: "rooms/hall.tease:2:7: Unknown variable 'missing'.",
  });
  assert.deepEqual(
    compilePlayerProject({ files: [] }).diagnostics.map(({ path, code }) => [path, code]),
    [["main.tease", "TSC009"]],
  );
});

test("runtime checkpoint restore reconstructs presentation without replay or completion", () => {
  let session = createPlayerRuntimeSession(
    'say "Question", instant\nlet answer = askChoice one: "One", two: "Two"\nsay answer, instant\nexit',
  );
  const before = playerRuntimeForeground(session);
  const restorePoint = createPlayerRuntimeRestorePoint(session);
  const roundTrippedCheckpoint = deserializeCheckpoint(restorePoint.checkpointJson);
  assert.deepEqual(roundTrippedCheckpoint.snapshot, playerRuntimeSnapshot(session));

  if (before?.kind !== "choose") throw new Error("Expected choice presentation.");
  session = selectPlayerRuntimeChoice(session, before.options[0]!.id)!.session;
  assert.equal(session.state.status, "halted");

  const restored = restorePlayerRuntimeSession(restorePoint);
  assert.deepEqual(playerRuntimeForeground(restored), before);
  assert.deepEqual(
    restored.transcriptEntries.map((entry) => entry.text),
    ["Question"],
  );
  assert.equal(restored.state.status, "waiting");
  assert.equal(restored.events.length, restorePoint.events.length);
});

test("runtime checkpoint restore preserves a paced history and its continuation", () => {
  let session = createPlayerRuntimeSession('repeat 4 { say "x" }\nexit');
  for (let index = 0; index < 2; index++) session = skipPlayerRuntimePacing(session)!.session;
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.events, session.events);
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
  const resumed = skipPlayerRuntimePacing(restored)!.session;
  const direct = skipPlayerRuntimePacing(session)!.session;
  assert.deepEqual(playerRuntimeSnapshot(resumed), playerRuntimeSnapshot(direct));
  assert.deepEqual(resumed.transcriptEntries, direct.transcriptEntries);
});

test("Continue runs a restored ready session at once, after recording its capture", () => {
  const { plan } = compileSource(
    'say "Resumed at ${getAbsoluteDateTime().toISO()}", instant\nwait 1 s\nsay "Later", instant\nexit',
  );
  assert.ok(plan);
  const checkpointJson = serializeCheckpoint(
    createCheckpoint(
      plan,
      createFreshRuntimeSnapshot(plan, { wallClockMs: utc("2026-10-04T16:00:00") }),
    ),
  );
  const capture = {
    wallClockMs: utc("2026-10-05T09:00:00"),
    temporalContext: DEFAULT_TEMPORAL_CONTEXT,
  };
  const restored = restorePlayerRuntimeSession({ checkpointJson, events: [] });
  assert.equal(restored.state.status, "ready");
  assert.deepEqual(playerRuntimeDeadlines(restored.state), []);

  // No time observation follows: Continue itself resumes, with its own wall clock already in force.
  const continued = continuePlayerRuntimeSession(restored, capture);
  assert.equal(continued.outcome.kind, "recorded");
  const resumedTranscript = ["Resumed at 2026-10-05T09:00:00Z"];
  assert.deepEqual(
    continued.session.transcriptEntries.map((entry) => entry.text),
    resumedTranscript,
  );
  // Continue consumes no scene time: the wait keeps its full duration.
  assert.deepEqual(playerRuntimeDeadlines(continued.session.state), [1_000]);

  // The same as recording the capture through the runtime and then running.
  const checkpoint = deserializeCheckpoint(checkpointJson);
  const recorded = recordContinueCapture(checkpoint.plan, checkpoint.snapshot, capture);
  const ran = run(checkpoint.plan, recorded.snapshot);
  assert.deepEqual(continued.session.events, [...recorded.events, ...ran.events]);
  assert.deepEqual(playerRuntimeSnapshot(continued.session), ran.snapshot);

  // Continuing the saved wait settles nothing early.
  const waiting = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(continued.session));
  const again = continuePlayerRuntimeSession(waiting, capture);
  assert.equal(again.outcome.kind, "recorded");
  assert.deepEqual(
    again.session.transcriptEntries.map((entry) => entry.text),
    resumedTranscript,
  );
  assert.deepEqual(playerRuntimeDeadlines(again.session.state), [1_000]);

  // A rejected capture runs nothing.
  const rejected = continuePlayerRuntimeSession(
    restorePlayerRuntimeSession({ checkpointJson, events: [] }),
    { ...capture, wallClockMs: 0.5 },
  );
  assert.equal(rejected.outcome.kind, "invalidCapture");
  assert.equal(rejected.session.state.status, "ready");
  assert.deepEqual(rejected.session.events, []);
});

test("runtime checkpoint restore handles retained event histories above the native spread limit", () => {
  // Size is the regression input: spreading this many arguments exceeded the supported Node stack.
  const count = 150_000;
  const { plan } = compileSource(`repeat ${count} { say "x", instant }\nexit`);
  assert.ok(plan);
  const result = run(plan, createFreshRuntimeSnapshot(plan), {}, { instructionBudget: count * 20 });
  assert.equal(result.snapshot.status, "halted");
  const restored = restorePlayerRuntimeSession({
    checkpointJson: serializeCheckpoint(createCheckpoint(plan, result.snapshot)),
    events: result.events,
  });
  assert.deepEqual(restored.events, result.events);
  assert.equal(restored.transcriptEntries.length, count);
  assert.equal(new Set(restored.transcriptEntries.map((entry) => entry.id)).size, count);
  assert.equal(restored.transcriptEntries[0]?.text, "x");
  assert.equal(restored.transcriptEntries.at(-1)?.text, "x");
  assert.deepEqual(playerRuntimeSnapshot(restored), result.snapshot);
});

test("the Player keeps its own state, for a save or a recording's anchor, as the checked JSON without capturing it", () => {
  const source =
    'let numbers = [1, 2.5]\nlet person = {name: "Kiara", tags: ["a"]}\nwait 1 s\nwait 1 s\nexit';
  const session = createPlayerRuntimeSession(source);
  const checked = JSON.stringify(playerRuntimeSnapshot(session));
  withValidationTestStatistics((statistics) => {
    // The JSON the kept session and Debug's rewind history keep, which a restore checks as external data.
    assert.equal(playerRuntimeSnapshotJson(session), checked);
    beginPlayerRuntimeRecording(session, new DebugRecorder());
    assert.equal(statistics().counts.externalCaptureVisits ?? 0, 0);
  });
  // A recording that starts again before a call takes its anchor without capturing the state either, also before a call
  // of a copy that catches up: the same calls capture only their arguments.
  const captureVisits = (recorder: DebugRecorder) => {
    let played = createPlayerRuntimeSession(source, { recorder });
    return withValidationTestStatistics((statistics) => {
      played = observePlayerRuntimeTime(played, 1_000).session;
      const catchUp = beginPlayerRuntimeCatchUp(played, 2_000);
      assert.equal(
        stepPlayerRuntimeCatchUp(catchUp, () => true),
        "done",
      );
      played = adoptPlayerRuntimeCatchUp(played, catchUp)!;
      assert.equal(played.state.status, "halted");
      return statistics().counts.externalCaptureVisits ?? 0;
    });
  };
  const restarting = new DebugRecorder({ operations: 2 });
  assert.equal(captureVisits(restarting), captureVisits(new DebugRecorder()));
  assert.notEqual(restarting.recording()!.anchorSnapshot.observedSessionTimeMs, 0, "no new anchor");
  const restored = restorePlayerRuntimeSessionAt(
    session.plan,
    playerRuntimeSnapshotJson(session),
    [],
  );
  assert.equal(JSON.stringify(playerRuntimeSnapshot(restored)), checked);
});

test("Continue, a rewind, and a restore point check the kept state once and refuse what the engine's restore refuses", () => {
  const session = createPlayerRuntimeSession(
    'let numbers = [1, 2.5]\nlet person = {name: "Kiara", tags: ["a"]}\nsay "Hello", instant\nwait 1 s\nexit',
  );
  const json = playerRuntimeSnapshotJson(session);
  const point = createPlayerRuntimeRestorePoint(session);
  const checkpointOf = (snapshotJson: string) => ({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: session.plan,
    snapshot: JSON.parse(snapshotJson),
  });
  const captured = <T>(restore: () => T) =>
    withValidationTestStatistics((statistics) => {
      const result = restore();
      return { result, visits: statistics().counts.externalCaptureVisits ?? 0 };
    });
  // Continue and a rewind capture the kept JSON as one checkpoint restore does; a restore point's JSON is validated as
  // parsed, as `deserializeCheckpoint` does, so nothing is captured.
  const once = captured(() => restoreCheckpoint(checkpointOf(json))).visits;
  assert.ok(once > 0);
  const continued = captured(() =>
    restorePlayerRuntimeSessionAt(session.plan, json, session.events, new DebugRecorder()),
  );
  assert.equal(continued.visits, once);
  assert.equal(captured(() => deserializeCheckpoint(point.checkpointJson)).visits, 0);
  assert.equal(captured(() => restorePlayerRuntimeSession(point, new DebugRecorder())).visits, 0);
  // The restored session runs the state it checked, and its own events follow the restored ones.
  assert.equal(playerRuntimeSnapshotJson(continued.result), json);
  assert.deepEqual(continued.result.events, session.events);
  assert.equal(continued.result.liveEventSequence, JSON.parse(json).nextEventSequence);

  // Each invalid state is refused with the error the engine's own restore gives for it.
  const changed = (change: (snapshot: Record<string, unknown>) => void) => {
    const snapshot = JSON.parse(json);
    change(snapshot);
    return JSON.stringify(snapshot);
  };
  const refusal = (restore: () => void) => {
    try {
      restore();
    } catch (error) {
      assert.ok(error instanceof CheckpointError, String(error));
      return error.info;
    }
    assert.fail("The restore accepted an invalid state.");
  };
  for (const invalid of [
    changed((snapshot) => (snapshot["nextEventSequence"] = 0)),
    changed((snapshot) => (snapshot["version"] = 0)),
    changed((snapshot) => (snapshot["nextInstruction"] = session.plan.instructions.length + 1)),
    changed((snapshot) => (snapshot["unknown"] = true)),
  ]) {
    const expected = refusal(() => restoreCheckpoint(checkpointOf(invalid)));
    assert.deepEqual(
      refusal(() => restorePlayerRuntimeSessionAt(session.plan, invalid, session.events)),
      expected,
    );
    const checkpointJson = JSON.stringify({
      ...JSON.parse(point.checkpointJson),
      snapshot: JSON.parse(invalid),
    });
    assert.deepEqual(
      refusal(() => restorePlayerRuntimeSession({ checkpointJson, events: point.events })),
      refusal(() => deserializeCheckpoint(checkpointJson)),
    );
  }
  assert.equal(
    refusal(() => restorePlayerRuntimeSession({ checkpointJson: "{", events: [] })).code,
    "TSK003",
  );
});

test("a session records the account's zone and presentation, falling back to the browser's", () => {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const account = playerTemporalContext({ timeZone: "Asia/Tokyo", locale: "en-US" });
  assert.equal(account.zone.name, "Asia/Tokyo");
  assert.equal(account.presentation.hourCycle, "h12");
  // A zone this browser does not know falls back to the browser's own zone and language.
  assert.equal(playerTemporalContext({ timeZone: "Mars/Olympus_Mons" }).zone.name, browserZone);

  const session = createPlayerRuntimeSession('say toDateTime("2026-10-04T18:30")\nexit', {
    temporalContext: account,
  });
  assert.deepEqual(playerRuntimeSnapshot(session).temporalCaptures[0]?.context, account);
  assert.equal(
    session.events.find((event) => event.kind === "say")?.text,
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      numberingSystem: "latn",
      calendar: "gregory",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
      .format(Date.UTC(2026, 9, 4, 18, 30))
      .replace(/[\u00a0\u202f]/gu, " "),
  );
});
