import { workerData } from "node:worker_threads";
import { exactly, isRecord } from "../../player/engine-bridge/argument-checks.js";
import { HeldSession, introduction } from "../../player/engine-bridge/ops/session.js";
import { isBuildIdentity } from "../../player/engine-bridge/protocol.js";
import { parentHostPort } from "../../player/engine-bridge/node-port.js";
import { playerBridgeOps, playerOpsContext } from "../../player/engine-bridge/player-ops.js";
import { startBridgeHost } from "../../player/engine-bridge/worker-host.js";
import { restorePlayerRuntimeSessionAt } from "../../player/runtime-adapter.js";

/*
 * The Player's engine Worker, as `node-worker.ts` runs it, plus one test op: `restoreForTest` restores a snapshot of a
 * held plan with the real adapter and introduces it as a session in this realm, as `introduceNow` does in-process. No
 * production op restores yet (that is L5h); tests that restore a pending state through the Worker use this entry.
 */
const unknownBuild = { commit: null, dirty: null, mode: null, appVersion: null };
const context = playerOpsContext();
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
        );
        const id = sessions.add(held);
        const view = introduction(held, context, false);
        return { result: null, session: id, eventsThrough: view.eventsThrough, view };
      },
    },
  },
  isBuildIdentity(workerData?.build) ? workerData.build : unknownBuild,
);
