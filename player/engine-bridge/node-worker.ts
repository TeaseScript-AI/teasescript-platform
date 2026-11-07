import { workerData } from "node:worker_threads";
import { isBuildIdentity } from "./protocol.js";
import { parentHostPort } from "./node-port.js";
import { playerBridgeOps, playerOpsContext } from "./player-ops.js";
import { startBridgeHost } from "./worker-host.js";

// The engine Worker in a Node worker thread, as tests run it; its build identity comes from the parent.
const unknownBuild = { commit: null, dirty: null, mode: null, appVersion: null };
// The ops' context and the host share the connection's deliveries (`delivery.ts`).
const context = playerOpsContext();
startBridgeHost(
  parentHostPort(),
  playerBridgeOps(context),
  isBuildIdentity(workerData?.build) ? workerData.build : unknownBuild,
  context.delivery,
);
