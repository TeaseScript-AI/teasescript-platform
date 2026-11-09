// The debug recorder's random resume (split from `player-debug-recorder.test.ts`): a call paused at random draws, its
// resolution, replay and recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { rebuildRecordedSession, replayDebugExport } from "../../player/debug/debug-export.js";
import { DebugRecorder } from "../../player/debug/debug-recorder.js";
import {
  applyPlayerRuntimeStorageEdit,
  continuePlayerRuntimeSession,
  createPlayerRuntimeRestorePoint,
  observePlayerRuntimeTime,
  restorePlayerRuntimeSession,
  resumePlayerRuntimeRandomDraw,
  setPlayerRuntimeRandomControl,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/index.js";
import { exportedRecording, replay } from "../helpers/player/debug-recorder-replay.js";

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
  const recorder = new DebugRecorder({ argumentCodeUnits: 128 });
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
