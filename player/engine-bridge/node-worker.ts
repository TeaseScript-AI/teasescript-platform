import { workerData } from "node:worker_threads";
import { isBuildIdentity } from "./protocol.js";
import { parentHostPort } from "./node-port.js";
import { playerBridgeOps } from "./player-ops.js";
import { startBridgeHost } from "./worker-host.js";

// The engine Worker in a Node worker thread, as tests run it; its build identity comes from the parent.
const unknownBuild = { commit: null, dirty: null, mode: null, appVersion: null };
startBridgeHost(
  parentHostPort(),
  playerBridgeOps(),
  isBuildIdentity(workerData?.build) ? workerData.build : unknownBuild,
);
