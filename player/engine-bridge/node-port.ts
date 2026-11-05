import { parentPort } from "node:worker_threads";
import type { HostPort } from "./worker-host.js";

/** A Node `worker_threads` worker's channel to its parent, as a bridge host port. */
export function parentHostPort(): HostPort {
  const port = parentPort;
  if (port === null) throw new Error("A bridge host in Node runs only inside a worker thread.");
  return {
    post: (message) => port.postMessage(message),
    listen: (listener) => port.on("message", listener),
  };
}
