import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { before } from "node:test";
import { pathToFileURL } from "node:url";

/*
 * L5h.3b's static censuses, over the Player's code with the session-work census's reference walk
 * (`tools/session-work-census.mjs`'s `uses`):
 * - every begin of a recording converges on the recorder's one begin, from a route this file classifies;
 * - every host restart of the recorder is one of the routes the restart gate (`beforeRestart`) covers, and the gate's
 *   hook is read only by the rewind owner;
 * - the replies of the failure capture and of the export capture each reach one settle function, and nothing else;
 * - every route that publishes, stops or binds a session supplies the export observation, classified.
 * What they claim is the wiring. That a restart waits for the gate's settlement is the rewind lifecycle's runtime claim,
 * and that no stale capture shows is the export observation family's.
 */

interface Use {
  readonly target: string;
  readonly file: string;
  readonly path: string;
  readonly use: string;
}
interface Census {
  uses(targets: readonly { readonly file: string; readonly path: string }[]): readonly Use[];
}

let census: Census;
before(async () => {
  const tool = await import(
    pathToFileURL(resolve(process.cwd(), "tools/session-work-census.mjs")).href
  );
  // EVIDENCE: validation: the census module's documented API; its tests check `createSessionWorkCensus`.
  census = (tool.createSessionWorkCensus as (root: string) => Census)(process.cwd());
});

const ADAPTER = "player/runtime-adapter.ts";
const SESSION_OPS = "player/engine-bridge/ops/session.ts";

/** What reaches each target, as `target <- caller [use]`. */
function callers(targets: readonly { readonly file: string; readonly path: string }[]): string[] {
  return [
    ...new Set(census.uses(targets).map((each) => `${each.target} <- ${each.file} ${each.path}`)),
  ].sort();
}

/** Each place that begins a recording, by the begin route it serves (§21.2 "Recording provenance"). */
const BEGINS: Readonly<Record<string, string>> = {
  "player/debug-recorder.ts DebugRecorder > begin <- player/runtime-adapter.ts PlayerRuntimeEngine > beginRecording":
    "the one convergence: it records the engine and the begin's epoch",
  [`${ADAPTER} PlayerRuntimeEngine > beginRecording <- ${ADAPTER} createPlayerRuntimeSession`]:
    "a host Start, and `introduceNow` with an object or a factory",
  [`${ADAPTER} PlayerRuntimeEngine > beginRecording <- ${ADAPTER} restoredSession`]:
    "a raw restore and `restoreAt`, given a recorder",
  [`${ADAPTER} PlayerRuntimeEngine > beginRecording <- ${ADAPTER} beginPlayerRuntimeRecording`]:
    "the explicit begin, by `beginRecordingAt` only",
  [`${ADAPTER} beginPlayerRuntimeRecording <- ${SESSION_OPS} beginRecordingAt`]:
    "the host's begin at a held session",
  [`${SESSION_OPS} beginRecordingAt <- player/engine-bridge/in-process.ts beginRecordingNow`]:
    "`beginRecordingNow`, the in-process facade",
  [`${SESSION_OPS} beginRecordingAt <- player/engine-bridge/ops/history.ts historyOps > restartAt`]:
    "L5i.6's host restores: Back's and Forward's commit, Return, Debug-off's reinstatement",
  [`${SESSION_OPS} beginRecordingAt <- ${SESSION_OPS} sessionOps > beginRecording > sessionOp:callback#9.2`]:
    "the host `beginRecording` op: Continue",
};

test("every begin of a recording converges on the recorder's begin from a classified route", () => {
  const found = callers([
    { file: "player/debug-recorder.ts", path: "DebugRecorder > begin" },
    { file: ADAPTER, path: "PlayerRuntimeEngine > beginRecording" },
    { file: ADAPTER, path: "beginPlayerRuntimeRecording" },
    { file: SESSION_OPS, path: "beginRecordingAt" },
  ]);
  assert.deepEqual(found, Object.keys(BEGINS).sort(), "an unclassified or stale begin route");
});

test("the restart gate's hook is read only by the rewind owner, and the host restarts only on its routes", () => {
  assert.deepEqual(
    callers([
      {
        file: "player/vue/src/session/useFailureRecording.ts",
        path: "useFailureRecording > beforeRestart",
      },
      {
        file: "player/vue/src/usePlayerSession.ts",
        path: "usePlayerSession > beforeRewindRestart",
      },
    ]),
    [
      "player/vue/src/session/useFailureRecording.ts useFailureRecording > beforeRestart <- player/vue/src/usePlayerSession.ts usePlayerSession > beforeRewindRestart",
      // The rewind API's `beforeRestart`, which the rewind owner's gate reads before each host restart.
      "player/vue/src/usePlayerSession.ts usePlayerSession > beforeRewindRestart <- player/vue/src/usePlayerSession.ts usePlayerSession > beforeRestart",
    ],
  );
  const owner = readFileSync(resolve(process.cwd(), "player/vue/src/rewindOwner.ts"), "utf8");
  assert.equal(owner.match(/host\.beforeRestart\(\)/gu)?.length, 1, "one gate reads the hook");
  // The history ops that restart the recorder in the host (`restartAt`), each sent only by the lifecycle's actions
  // that follow its gate: the commit of Back or Forward, Return, and a reinstating close.
  const history = readFileSync(
    resolve(process.cwd(), "player/engine-bridge/ops/history.ts"),
    "utf8",
  );
  const restarting = [...history.matchAll(/^ {4}(\w+): \{[\s\S]*?^ {4}\},?$/gmu)]
    .filter(([body]) => body.includes("restartAt("))
    .map(([, op]) => op)
    .sort();
  assert.deepEqual(restarting, ["historyClose", "rewindCommit", "rewindReturn"]);
});

test("the failure capture's and the export capture's replies each reach one settle function only", () => {
  assert.deepEqual(
    callers([
      {
        file: "player/vue/src/session/useFailureRecording.ts",
        path: "useFailureRecording > settle",
      },
      { file: "player/player-bridge.ts", path: "PlayerBridge > captureExport" },
      {
        file: "player/vue/src/session/useExportCandidate.ts",
        path: "useExportCandidate > deliver",
      },
    ]),
    [
      "player/player-bridge.ts PlayerBridge > captureExport <- player/vue/src/session/useExportCandidate.ts useExportCandidate > debugExportCandidate > capture",
      "player/vue/src/session/useExportCandidate.ts useExportCandidate > deliver <- player/vue/src/session/useExportCandidate.ts useExportCandidate > debugExportCandidate > capture > captureExport:callback",
      "player/vue/src/session/useFailureRecording.ts useFailureRecording > settle <- player/vue/src/session/useFailureRecording.ts useFailureRecording > stopped > then:callback.1",
      "player/vue/src/session/useFailureRecording.ts useFailureRecording > settle <- player/vue/src/session/useFailureRecording.ts useFailureRecording > stopped > then:callback.2",
    ],
  );
  // Nothing is chained after the capture's settlement: its handlers only settle.
  const failure = readFileSync(
    resolve(process.cwd(), "player/vue/src/session/useFailureRecording.ts"),
    "utf8",
  );
  assert.match(
    failure,
    /\.read\(stopped, "captureRecording"\)\.then\(\s*\(reply\) => settle\(bridge, of, reply\),\s*\(\) => settle\(bridge, of, null\),\s*\);/u,
  );
});

const HELD = "player/engine-bridge/ops/session.ts";

/**
 * Each route that supplies the export observation its facts (§21.4 family 1), by the observation it supplies: every
 * publication passes `publish`, every Player error stop the host's halt, and every session binds its run as it is made
 * or handed over. An unclassified or stale route fails.
 */
const OBSERVATION_ROUTES: Readonly<Record<string, string>> = {
  [`${HELD} HeldSession > publish <- ${HELD} HeldSession > introduce`]:
    "an introduction's first publication",
  [`${HELD} HeldSession > publish <- ${HELD} HeldSession > adoptResult > view`]:
    "an op's new revision (`adoptResult`)",
  [`${HELD} HeldSession > publish <- ${HELD} sessionOps > adoptCatchUp > sessionOp:callback#5.2`]:
    "a catch-up's adoption",
  [`${HELD} HeldSession > publish <- player/engine-bridge/in-process.ts hatch > adopt`]:
    "the in-process facade's adoption",
  [`${HELD} HeldSession > stopRequested <- player/engine-bridge/worker-host.ts startBridgeHost > halt`]:
    "a halt with stop arguments, on receipt",
  [`${HELD} HeldSession > atStop <- player/engine-bridge/worker-host.ts startBridgeHost > stopPayload`]:
    "the halt's acknowledgement, once the work running at the stop settled",
  [`${HELD} HeldSession > bindRun <- ${HELD} HeldSession > constructor`]:
    "every route that makes a session, before it publishes",
  [`${HELD} HeldSession > bindRun <- ${HELD} sessionOps > beginRecording > sessionOp:callback#9.2`]:
    "Continue's handoff of a session the Player held already",
};

test("every publication, stop and binding route of the export observation is classified", () => {
  const found = callers([
    { file: HELD, path: "HeldSession > publish" },
    { file: HELD, path: "HeldSession > stopRequested" },
    { file: HELD, path: "HeldSession > atStop" },
    { file: HELD, path: "HeldSession > bindRun" },
  ]);
  assert.deepEqual(found, Object.keys(OBSERVATION_ROUTES).sort(), "an unclassified or stale route");
  // The routes that make a session, each binding inside the constructor: Start, an introduction, a kept restore, and a
  // history restore.
  const made = ["in-process.ts", "ops/persistence.ts", "ops/session.ts", "ops/history.ts"].map(
    (file) => {
      const text = readFileSync(resolve(process.cwd(), "player/engine-bridge", file), "utf8");
      return [file, text.match(/new HeldSession\(/gu)?.length ?? 0] as const;
    },
  );
  assert.deepEqual(made, [
    ["in-process.ts", 1],
    ["ops/persistence.ts", 1],
    ["ops/session.ts", 1],
    ["ops/history.ts", 1],
  ]);
});
