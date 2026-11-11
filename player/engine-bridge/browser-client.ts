import { playerBuildIdentity } from "../build-identity.js";
import { PlayerBridge } from "../runtime/player-bridge.js";
import { BridgeStartupError, connectBridge, type ClientPort } from "./client.js";

// The engine's module Worker in a browser (#2321): the Player's one production backend, which the page starts
// (`player/vue/src/main.ts`). Its Node counterpart for tests is `node-client.ts`.

/** The parts of a browser's dedicated Worker this client uses. */
interface EngineWorker {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: { readonly data?: unknown; readonly message?: unknown }) => void,
  ): void;
  terminate(): void;
}

// The browser's `Worker`, typed here: the Player's TypeScript build has no DOM library. Only the type is declared; the
// call below is the browser's own constructor, written in the literal form Vite bundles as a module Worker.
declare const Worker: new (url: URL, options: { readonly type: "module" }) => EngineWorker;

/**
 * Starts the engine's module Worker and resolves with its bridge once it is ready and of this build. A Worker that
 * cannot start (its script blocked or not found, a policy that forbids it, a browser without module Workers, an opaque
 * origin) rejects with a `BridgeStartupError` carrying the browser's message: synchronously thrown by `new Worker`,
 * reported by its `error` event before `ready`, or its `ready` of another build. After `ready`, the same events are
 * the bridge's loss (`client.ts`).
 */
export function openEngineWorker(): Promise<PlayerBridge> {
  let worker: EngineWorker;
  try {
    worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.reject(new BridgeStartupError(`The engine Worker failed: ${message}`));
  }
  const port: ClientPort = {
    post: (message) => worker.postMessage(message),
    listen: (listener) => worker.addEventListener("message", (event) => listener(event.data)),
    onFailure: (listener) => {
      // An `error` event of a script that failed to load carries no message.
      worker.addEventListener("error", (event) =>
        listener(
          new Error(
            typeof event.message === "string" && event.message !== ""
              ? event.message
              : "its script could not be loaded or run",
          ),
        ),
      );
      worker.addEventListener("messageerror", () =>
        listener(new Error("it sent a message the page cannot receive")),
      );
    },
    terminate: () => worker.terminate(),
  };
  return connectBridge(port, playerBuildIdentity).then((client) => new PlayerBridge(client));
}
