import { Worker } from "node:worker_threads";
import type { ClientPort } from "./client.js";
import type { BuildIdentity } from "./protocol.js";

/** A client port to a bridge host started in a Node worker thread from `entry`, as tests run the engine Worker. */
export function nodeWorkerPort(entry: URL, build: BuildIdentity): ClientPort {
  const worker = new Worker(entry, { workerData: { build } });
  return {
    post: (message) => worker.postMessage(message),
    listen: (listener) => worker.on("message", listener),
    onFailure: (listener) => {
      worker.on("error", listener);
      worker.on("messageerror", listener);
      worker.on("exit", (code) => listener(new Error(`The worker exited with code ${code}.`)));
    },
    terminate: () => void worker.terminate(),
  };
}
