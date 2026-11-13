import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { introduceNow } from "../helpers/bridge/in-process.js";
import { instructionFacts } from "../../player/engine-bridge/instruction-facts.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { PlanMetadata, PrepareResult } from "../../player/engine-bridge/player-ops.js";
import type { Introduction } from "../../player/engine-bridge/session-protocol.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  playerRuntimeSnapshot,
  playerRuntimeSnapshotJson,
  restorePlayerRuntimeSessionAt,
  type PlayerProject,
} from "../../player/runtime/runtime-adapter.js";
import {
  playerRuntimeCameraView,
  playerRuntimeMedia,
  playerRuntimeMediaOrigin,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import type { MediaLoadReport } from "../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { viewCalls, viewed, withoutViews } from "../helpers/debug-readers.js";
import { hatch, inProcessBridge } from "../helpers/in-process-bridge.js";
import { NO_MARKS } from "../../player/debug/debug-history-marks.js";
import { asMalformed, untypedClient } from "../helpers/bridge/untyped.js";

/*
 * L5d's bridge (B-media): media load reports as an op, the media origin in the view's instruction facts, and the plan
 * metadata a Player reads by token. Each case runs in-process and through a Node Worker, whose host restores through a
 * test op (`helpers/bridge-restore-worker.ts`).
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const RESTORE_WORKER = new URL("../helpers/bridge-restore-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };

/**
 * One small script with media of each kind of step: a Stage image and the camera view, an audio that repeats with cues
 * and is sought, paused by a timer block and resumed, a sound that fails to load, and a medium started in another file.
 */
const PROJECT: PlayerProject = {
  files: [
    { path: "rooms/hall.tease", source: 'global function bell {\n  playAudio async "bell.mp3"\n}' },
    {
      path: "main.tease",
      source: [
        'showImage "hall.jpg"',
        "showCamera",
        'let m = playAudio async repeat "loop.mp3" {',
        "  at 1 s {",
        '    say "one", instant',
        "  }",
        "}",
        'playAudio async "broken.mp3"',
        "bell()",
        "timer async 2 s {",
        "  m.pause()",
        "  wait 1 s",
        "  m.resume()",
        "}",
        "m.position = 500 ms",
        "wait 6 s",
        "m.stop()",
        'say "done", instant',
        "exit",
      ].join("\n"),
    },
  ],
};
/** Where each medium's `playAudio` is, read from the sources above. */
const ORIGINS: Readonly<Record<string, { readonly path: string; readonly line: number }>> = {
  "loop.mp3": { path: "main.tease", line: 3 },
  "broken.mp3": { path: "main.tease", line: 8 },
  "bell.mp3": { path: "rooms/hall.tease", line: 2 },
};

async function prepared(bridge: PlayerBridge): Promise<{ token: string; metadata: PlanMetadata }> {
  const plan = compilePlayerProject(PROJECT).plan;
  assert.ok(plan);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  if (result.kind !== "prepared") throw new Error(`The project did not prepare: ${result.kind}`);
  return { token: result.plan, metadata: result.metadata };
}

/** Whether the tape views the session's calls (L5f): what it shows then holds what Debug's readers give (`viewed`). */
let viewing = false;

/** What a session shows, comparable across backends, with the readers over it. */
const shown = (session: PlayerSession) => ({
  revision: session.revision,
  state: session.state,
  ...(viewing ? { viewed: viewed(session) } : { instructions: session.instructions }),
  events: [...session.events],
  media: playerRuntimeMedia(session.state),
  camera: playerRuntimeCameraView(session.state),
});

const refusedAs = (code: string) => (error: unknown) =>
  error instanceof BridgeRequestError && error.code === code;

/**
 * Plays `session` on: each unloaded medium is reported loaded (3 s) or, for `broken.mp3`, failed; then time moves
 * 500 ms with each running medium's progress. Every step's result and view is recorded, and every origin is checked.
 */
async function play(
  bridge: PlayerBridge,
  start: PlayerSession,
  steps: unknown[],
  limit = 40,
): Promise<PlayerSession> {
  let session = start;
  let atMs = session.state.observedSessionTimeMs;
  for (let step = 0; step < limit && session.state.status === "waiting"; step++) {
    const { media } = playerRuntimeMedia(session.state);
    for (const medium of media) {
      // Every medium the view shows names where it comes from.
      assert.deepEqual(
        playerRuntimeMediaOrigin(session, medium.mediaId)?.location,
        ORIGINS[medium.source],
        medium.source,
      );
      if (medium.loaded) continue;
      const report: MediaLoadReport =
        medium.source === "broken.mp3"
          ? { kind: "failed", message: "Not a sound." }
          : { kind: "loaded", durationMs: 3_000 };
      const result = await bridge.request(session, "reportMediaLoad", {
        mediaId: medium.mediaId,
        report,
      });
      session = bridge.latest(session)!;
      steps.push({ op: "reportMediaLoad", result, shown: shown(session) });
    }
    atMs += 500;
    const progress = playerRuntimeMedia(session.state).media.flatMap((medium) =>
      medium.loaded && medium.state === "running"
        ? [
            {
              mediaId: medium.mediaId,
              segment: medium.segment,
              progressMs: medium.reportedProgressMs + 500,
            },
          ]
        : [],
    );
    const result = await bridge.request(session, "observeTime", { atMs, media: progress });
    session = bridge.latest(session)!;
    steps.push({ op: "observeTime", result, shown: shown(session) });
  }
  return session;
}

/** A tape of L5d's ops: refusals without effect, then the script played to its end. */
async function tape(
  bridge: PlayerBridge,
  calls = false,
): Promise<{ steps: unknown[]; last: PlayerSession }> {
  const { token, metadata } = await prepared(bridge);
  let session = await bridge.start(token, START, false);
  viewing = calls;
  if (calls) session = await viewCalls(bridge, session, true);
  const steps: unknown[] = [shown(session), metadata];
  // `planMetadata` gives what `prepare` gave; a token the host does not hold gives null.
  steps.push((await bridge.client.request("planMetadata", { plan: token })).result);
  assert.equal((await bridge.client.request("planMetadata", { plan: "p999" })).result, null);
  // Malformed on purpose, as the rows below: the host refuses them.
  await assert.rejects(
    bridge.client.request("planMetadata", asMalformed({ plan: 1 })),
    refusedAs("arguments"),
  );
  const loaded: MediaLoadReport = { kind: "loaded", durationMs: 3_000 };
  for (const args of [
    { mediaId: -1, report: loaded },
    { mediaId: 1.5, report: loaded },
    { mediaId: "1", report: loaded },
    { mediaId: 1, report: "loaded" },
    { mediaId: 1, report: loaded, more: 1 },
  ])
    await assert.rejects(
      bridge.request(session, "reportMediaLoad", asMalformed(args)),
      refusedAs("arguments"),
    );
  // A medium the session does not have, and a report the engine refuses: refusals, which change nothing. The bogus
  // report is no `MediaLoadReport`, sent as it is on purpose.
  for (const args of [
    { mediaId: 99, report: loaded },
    { mediaId: playerRuntimeMedia(session.state).media[0]!.mediaId, report: { kind: "bogus" } },
  ]) {
    const result = await bridge.request(session, "reportMediaLoad", asMalformed(args));
    session = bridge.latest(session)!;
    steps.push({ op: "reportMediaLoad", result, shown: shown(session) });
  }
  session = await play(bridge, session, steps);
  // A late report of a medium that stopped long ago changes nothing.
  const result = await bridge.request(session, "reportMediaLoad", { mediaId: 1, report: loaded });
  steps.push({ op: "reportMediaLoad", result, shown: shown(bridge.latest(session)!) });
  viewing = false;
  return { steps, last: bridge.latest(session)! };
}

test("the media ops (#1913) give the same replies, views, origins and events in-process and in a Worker", async () => {
  const inProcess = await inProcessBridge();
  const worker = new PlayerBridge(
    await connectBridge(nodeWorkerPort(RESTORE_WORKER, BUILD), BUILD),
  );
  try {
    const played = await tape(inProcess);
    assert.deepEqual((await tape(worker)).steps, played.steps);
    // With the call view (L5f) the critical view is the same, and the full view equal across the backends.
    const full = await tape(await inProcessBridge(), true);
    assert.deepEqual((await tape(worker, true)).steps, full.steps);
    assert.deepEqual(withoutViews(full.steps), withoutViews(played.steps, ["instructions"]));
    // The refusals came first, then the media's own reports.
    const outcomes = played.steps.flatMap((step) => {
      const outcome =
        typeof step === "object" &&
        step !== null &&
        "op" in step &&
        step.op === "reportMediaLoad" &&
        "result" in step &&
        typeof step.result === "object" &&
        step.result !== null &&
        "kind" in step.result
          ? step.result.kind
          : null;
      return typeof outcome === "string" ? [outcome] : [];
    });
    assert.deepEqual(outcomes.slice(0, 2), ["unknownMedia", "invalidReport"]);
    assert.ok(outcomes.includes("accepted"));
    assert.equal(played.last.state.status, "halted");
    const said = played.last.transcriptEntries.map((entry) => entry.text);
    assert.ok(said.includes("one") && said.includes("done"), said.join(" | "));
  } finally {
    worker.client.terminate();
  }
});

/** The snapshot of the in-process run after `steps` of play, and its plan token there. */
async function checkpoint(playSteps: number): Promise<{ json: string; final: unknown }> {
  const bridge = await inProcessBridge();
  const { token } = await prepared(bridge);
  const started = await bridge.start(token, START, false);
  const paused = await play(bridge, started, [], playSteps);
  const json = hatch(paused, playerRuntimeSnapshotJson);
  const finished = await play(bridge, paused, []);
  return { json, final: hatch(finished, playerRuntimeSnapshot) };
}

for (const [when, playSteps] of [
  ["waits for its load", 0],
  ["plays", 3],
] as const)
  test(`a session restored while a medium ${when} plays on through the media ops, in-process and in a Worker`, async () => {
    const { json, final } = await checkpoint(playSteps);
    // In-process through the transitional factory, as the Player restores today.
    const inProcess = await inProcessBridge();
    const { token } = await prepared(inProcess);
    const local = introduceNow(
      inProcess,
      (host) => restorePlayerRuntimeSessionAt(host.plan(token), json, []),
      NO_MARKS,
    );
    if (playSteps === 0)
      assert.ok(
        playerRuntimeMedia(local.state).media.some((medium) => !medium.loaded),
        "a medium waits for its load",
      );
    const localSteps: unknown[] = [];
    const restored = await play(inProcess, local, localSteps);
    assert.deepEqual(
      hatch(restored, playerRuntimeSnapshot),
      final,
      "the uninterrupted run's state",
    );
    // In a Worker, restored in its realm by the test op, then played through the same ops: the same replies and views.
    const worker = new PlayerBridge(
      await connectBridge(nodeWorkerPort(RESTORE_WORKER, BUILD), BUILD),
    );
    try {
      const held = await prepared(worker);
      const reply = await untypedClient(worker.client).request("restoreForTest", {
        plan: held.token,
        snapshotJson: json,
      });
      // EVIDENCE: validation: the test op replies with the new session's introduction.
      const remote = worker.open(reply.session!, reply.view as Introduction);
      const steps: unknown[] = [];
      await play(worker, remote, steps);
      assert.deepEqual(steps, localSteps);
    } finally {
      worker.client.terminate();
    }
  });

test("instruction facts are made once per instruction of a plan, however often its sessions publish", async () => {
  const bridge = await inProcessBridge();
  const { token } = await prepared(bridge);
  const session = await bridge.start(token, START, false);
  // The facts of one publication are the same objects in the next: read from the plan's cache, not made again.
  const first = hatch(session, (held) => instructionFacts(held, false));
  const later = await play(bridge, session, [], 2);
  const again = hatch(later, (held) => instructionFacts(held, false));
  for (const index of Object.keys(first).map(Number))
    if (index in again) assert.equal(again[index], first[index]);
  assert.ok(Object.keys(first).length > 0);
});

test("a medium an observation in transit already stopped has no origin once the transit is delivered first", async () => {
  // As `reportFailedMedia` looks a failing medium up: the session's replies in transit apply first, as through the
  // facade, so a medium the host already stopped gives no unusable-media notice.
  const bridge = await inProcessBridge(250);
  const plan = compilePlayerProject(
    'let m = playAudio async "a.mp3"\nwait 1 s\nm.stop()\nshowButton "x"\nexit',
  ).plan;
  assert.ok(plan);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const token = (reply.result as { readonly plan: string }).plan;
  let session = await bridge.start(token, START, false);
  const { mediaId } = playerRuntimeMedia(session.state).media[0]!;
  await bridge.request(session, "reportMediaLoad", {
    mediaId,
    report: { kind: "loaded", durationMs: 9_000 },
  });
  session = bridge.latest(session)!;
  assert.ok(playerRuntimeMediaOrigin(session, mediaId), "the medium plays");
  // The observation that reaches `m.stop()`: once its reply applied, the medium has no origin.
  const stopping = bridge.request(session, "observeTime", { atMs: 1_500, media: [] });
  assert.ok(playerRuntimeMediaOrigin(bridge.latest(session)!, mediaId), "not yet applied");
  await stopping;
  assert.equal(playerRuntimeMediaOrigin(bridge.latest(session)!, mediaId), null);
});
