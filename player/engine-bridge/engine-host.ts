import { playerBuildIdentity } from "../build-identity.js";
import { sweepDebugHistories } from "../debug/debug-history-indexeddb.js";
import { playerBridgeOps, playerOpsContext } from "./player-ops.js";
import { startBridgeHost } from "./worker-host.js";

// The engine Worker's host in a browser, which `engine.worker.ts` loads. Its static imports are the playback entry's:
// the compiler loads only when a source is prepared.

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
// The ops' context and the host share the connection's deliveries (`delivery.ts`).
const context = playerOpsContext();
startBridgeHost(
  {
    post: (message) => scope.postMessage(message),
    listen: (listener) => scope.addEventListener("message", (event) => listener(event.data)),
  },
  playerBridgeOps(context),
  playerBuildIdentity,
  context.delivery,
);
// Rewind histories that pages which ended without deleting theirs left behind go now. The sweep runs in this realm,
// whose histories it knows open and spares (`debug-history-indexeddb.ts`).
void sweepDebugHistories();
