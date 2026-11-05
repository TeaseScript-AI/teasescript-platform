import { playerBuildIdentity } from "../build-identity.js";
import { playerBridgeOps } from "./player-ops.js";
import { startBridgeHost } from "./worker-host.js";

// The browser entry of the engine Worker. Its static imports are the playback entry's: the compiler loads only when a
// source is prepared.

/** The parts of a dedicated Worker's global scope the host uses. */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

function isWorkerScope(value: unknown): value is WorkerScope {
  return (
    typeof value === "object" &&
    value !== null &&
    "postMessage" in value &&
    typeof value.postMessage === "function" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}

const scope: unknown = globalThis;
if (!isWorkerScope(scope))
  throw new Error("The engine Worker entry runs only as a dedicated Worker.");
startBridgeHost(
  {
    post: (message) => scope.postMessage(message),
    listen: (listener) => scope.addEventListener("message", (event) => listener(event.data)),
  },
  playerBridgeOps(),
  playerBuildIdentity,
);
