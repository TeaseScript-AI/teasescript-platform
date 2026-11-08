import { workerData } from "node:worker_threads";
import { exactly, isRecord } from "../../player/engine-bridge/argument-checks.js";
import { HeldSession, introduction } from "../../player/engine-bridge/ops/session.js";
import { isBuildIdentity } from "../../player/engine-bridge/protocol.js";
import { parentHostPort } from "../../player/engine-bridge/node-port.js";
import { playerBridgeOps, playerOpsContext } from "../../player/engine-bridge/player-ops.js";
import { startBridgeHost } from "../../player/engine-bridge/worker-host.js";
import { plainRecording } from "./plain-recording.js";
import { DebugRecorder } from "../../player/debug-recorder.js";
import { restorePlayerRuntimeSessionAt } from "../../player/runtime-adapter.js";
import { NO_MARKS } from "../../player/debug-history-marks.js";

/*
 * The Player's engine Worker, as `node-worker.ts` runs it, plus two test ops. `restoreForTest` restores a snapshot of a
 * held plan with the real adapter and introduces it as a session in this realm, as `introduceNow` does in-process. No
 * production op restores yet (that is L5h); tests that restore a pending state through the Worker use this entry.
 * `recordingForTest` gives the connection recorder's recording as plain data, without its plan, as no production op does
 * yet (L5h builds the capture).
 */
const unknownBuild = { commit: null, dirty: null, mode: null, appVersion: null };
// Test settings from the parent's environment, as it was when the Worker started: a recorder that keeps smaller calls,
// and a realm in which a snapshot holding a list longer than this cannot be exported (as V8 cannot enumerate the keys
// of a very long list, which a list of this size stands for).
const argumentCodeUnits = Number(process.env.RECORDER_ARGUMENT_CODE_UNITS ?? Number.NaN);
const unexportableOver = Number(process.env.UNEXPORTABLE_LIST_OVER ?? Number.NaN);
if (Number.isFinite(unexportableOver)) {
  const ownKeys = Reflect.ownKeys;
  Reflect.ownKeys = (target) => {
    if (Array.isArray(target) && target.length > unexportableOver)
      throw new RangeError("Too many properties to enumerate");
    return ownKeys(target);
  };
}
const context = {
  ...playerOpsContext(),
  ...(Number.isFinite(argumentCodeUnits)
    ? { recorder: new DebugRecorder({ argumentCodeUnits }) }
    : {}),
};
startBridgeHost(
  parentHostPort(),
  {
    ...playerBridgeOps(context),
    restoreForTest: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["plan", "snapshotJson"]) &&
        typeof args.plan === "string" &&
        typeof args.snapshotJson === "string",
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { plan, snapshotJson } = args as {
          readonly plan: string;
          readonly snapshotJson: string;
        };
        const instructions = context.plans.get(plan);
        if (instructions === undefined) throw new Error(`No plan '${plan}' is held.`);
        const held = new HeldSession(
          restorePlayerRuntimeSessionAt(instructions, snapshotJson, []),
          plan,
          context,
          NO_MARKS,
        );
        const id = sessions.add(held);
        const view = introduction(held, context, false);
        return { result: null, session: id, eventsThrough: view.eventsThrough, view };
      },
    },
    recordingForTest: {
      session: "none",
      checkArguments: (args) => args === null,
      run: () => ({ result: plainRecording(context.recorder.recording()) }),
    },
  },
  isBuildIdentity(workerData?.build) ? workerData.build : unknownBuild,
  context.delivery,
);
